import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionArchiveService,
  getDelayUntilNextBeijingHour,
} from "../../src/archive/index.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

describe("SessionArchiveService", () => {
  let testDir: string;
  let dataDir: string;
  let sessionDir: string;
  let service: SessionArchiveService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `yep-archive-test-${randomUUID()}`);
    dataDir = join(testDir, "data");
    sessionDir = join(testDir, "claude", "projects", "-tmp-project");
    await mkdir(sessionDir, { recursive: true });
    service = new SessionArchiveService({ dataDir });
    await service.initialize();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function createProject(): Project {
    return {
      id: "proj-1" as UrlProjectId,
      path: "/tmp/project",
      name: "project",
      sessionCount: 1,
      sessionDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
  }

  function createSummary(sessionId: string): SessionSummary {
    return {
      id: sessionId,
      projectId: "proj-1" as UrlProjectId,
      title: "Archived session",
      fullTitle: "Archived session",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T01:00:00.000Z",
      messageCount: 2,
      ownership: { owner: "none" },
      provider: "claude",
    };
  }

  it("archives and restores a Claude session with related agent files", async () => {
    const sessionId = "sess-1";
    const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
    const subagentsDir = join(sessionDir, "subagents");
    const agentPath = join(subagentsDir, "agent-agent123.jsonl");
    const agentMetaPath = join(subagentsDir, "agent-agent123.meta.json");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      sessionPath,
      '{"type":"assistant","agentId":"agent123","message":{"content":"hi"}}\n',
    );
    await writeFile(agentPath, '{"type":"assistant","agentId":"agent123"}\n');
    await writeFile(agentMetaPath, '{"agentType":"Explore"}');

    const record = await service.archiveSession({
      sessionId,
      provider: "claude",
      project: createProject(),
      summary: createSummary(sessionId),
      sessionFilePath: sessionPath,
      reason: "manual",
    });

    await expect(stat(sessionPath)).rejects.toThrow();
    await expect(stat(agentPath)).rejects.toThrow();
    expect(record.files.map((file) => file.kind).sort()).toEqual([
      "agent-meta",
      "agent-session",
      "session",
    ]);
    expect(service.getArchivedSession(sessionId)?.title).toBe(
      "Archived session",
    );

    const restored = await service.restoreSession(sessionId);
    expect(restored.record.sessionId).toBe(sessionId);
    expect(await readFile(sessionPath, "utf-8")).toContain("agent123");
    expect(await readFile(agentPath, "utf-8")).toContain("agent123");
    expect(await readFile(agentMetaPath, "utf-8")).toContain("Explore");
    expect(service.getArchivedSession(sessionId)).toBeUndefined();
  });

  it("archives and restores a Codex rollout file", async () => {
    const sessionId = "codex-1";
    const codexDir = join(testDir, "codex", "sessions", "2026", "06", "01");
    const sessionPath = join(codexDir, "rollout-test.jsonl");
    await mkdir(codexDir, { recursive: true });
    await writeFile(sessionPath, '{"type":"session_meta","payload":{}}\n');

    const project: Project = {
      ...createProject(),
      provider: "codex",
      sessionDir: join(testDir, "codex", "sessions"),
    };
    const summary = { ...createSummary(sessionId), provider: "codex" as const };

    const record = await service.archiveSession({
      sessionId,
      provider: "codex",
      project,
      summary,
      sessionFilePath: sessionPath,
      reason: "auto",
    });

    await expect(stat(sessionPath)).rejects.toThrow();
    expect(record.files).toHaveLength(1);

    await service.restoreSession(sessionId);
    expect(await readFile(sessionPath, "utf-8")).toContain("session_meta");
  });

  it("archives one ZCode row without moving its shared SQLite database", async () => {
    const sqlite = process.getBuiltinModule?.("node:sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const { DatabaseSync } = sqlite;
    const dbPath = join(testDir, "zcode", "db.sqlite");
    await mkdir(join(testDir, "zcode"), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        time_archived INTEGER
      );
      INSERT INTO session (id, directory) VALUES
        ('zcode-1', '/tmp/project'),
        ('zcode-2', '/tmp/project');
    `);
    db.close();

    const project: Project = {
      ...createProject(),
      provider: "zcode",
      sessionDir: dbPath,
    };
    const summary = {
      ...createSummary("zcode-1"),
      provider: "zcode" as const,
    };

    const record = await service.archiveSession({
      sessionId: "zcode-1",
      provider: "zcode",
      project,
      summary,
      sessionFilePath: dbPath,
      reason: "manual",
    });

    expect((await stat(dbPath)).isFile()).toBe(true);
    expect(record.files).toEqual([]);
    expect(record.storagePath).toBe(dbPath);
    const archivedDb = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      archivedDb
        .prepare("SELECT time_archived FROM session WHERE id = 'zcode-1'")
        .get()?.time_archived,
    ).toEqual(expect.any(Number));
    expect(
      archivedDb
        .prepare("SELECT time_archived FROM session WHERE id = 'zcode-2'")
        .get()?.time_archived,
    ).toBeNull();
    archivedDb.close();

    await service.restoreSession("zcode-1");
    const restoredDb = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      restoredDb
        .prepare("SELECT time_archived FROM session WHERE id = 'zcode-1'")
        .get()?.time_archived,
    ).toBeNull();
    restoredDb.close();
  });

  it("schedules the next run for 04:00 Beijing time", () => {
    expect(
      getDelayUntilNextBeijingHour(4, new Date("2026-06-24T19:30:00.000Z")),
    ).toBe(30 * 60 * 1000);

    expect(
      getDelayUntilNextBeijingHour(4, new Date("2026-06-24T20:00:00.000Z")),
    ).toBe(24 * 60 * 60 * 1000);

    expect(
      getDelayUntilNextBeijingHour(4, new Date("2026-06-25T04:00:00.000Z")),
    ).toBe(16 * 60 * 60 * 1000);
  });
});

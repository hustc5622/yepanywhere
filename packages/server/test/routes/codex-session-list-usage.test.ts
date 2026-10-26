import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionCatalog } from "../../src/codex-history/CodexSessionCatalog.js";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGlobalSessionsRoutes } from "../../src/routes/global-sessions.js";
import { createProjectsRoutes } from "../../src/routes/projects.js";
import type { Thread } from "../../src/sdk/providers/codex-protocol/generated/v2/Thread.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

const roots: string[] = [];
const indexes: SessionIndexService[] = [];

afterEach(async () => {
  for (const index of indexes.splice(0)) index.dispose();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const timestamp = "2026-10-26T06:45:06.000Z";

function record(type: string, payload: unknown): string {
  return `${JSON.stringify({ type, timestamp, payload })}\n`;
}

function usage(input: number, cached: number, output: number): string {
  return record("event_msg", {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        total_tokens: input + output,
      },
      last_token_usage: {
        input_tokens: 139_008,
        cached_input_tokens: 138_624,
        output_tokens: 128,
        total_tokens: 139_136,
      },
      model_context_window: 760_000,
    },
    rate_limits: null,
  });
}

async function setup(source: "app-server" | "fallback" = "app-server") {
  const root = await mkdtemp(join(tmpdir(), "codex-list-usage-"));
  roots.push(root);
  const project: Project = {
    id: encodeProjectId(root),
    name: "usage-test",
    path: root,
    sessionDir: root,
    provider: "codex",
    sessionCount: 2,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
  };
  const ids = [
    "01a176ee-f162-7990-b431-71e531013c7b",
    "01a176ee-f162-7990-b431-71e531013c7c",
  ];
  const threads: Thread[] = [];
  for (const [index, id] of ids.entries()) {
    const path = join(root, `rollout-${id}.jsonl`);
    await writeFile(
      path,
      record("session_meta", { id, cwd: root, timestamp }) +
        record("event_msg", {
          type: "user_message",
          message: "Original prompt",
        }) +
        usage(2_806_680, 2_682_496, 7_871),
    );
    threads.push({
      id,
      sessionId: id,
      extra: null,
      forkedFromId: null,
      parentThreadId: null,
      preview: "Catalog title",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 1_792_996_000,
      updatedAt: 1_793_000_000 - index,
      recencyAt: 1_793_000_000 - index,
      status: { type: "notLoaded" },
      path,
      cwd: root,
      cliVersion: "0.161.0",
      source: "vscode",
      canAcceptDirectInput: null,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    });
  }
  const catalog = new CodexSessionCatalog({
    client: {
      listThreads: vi.fn(async () => ({
        data: source === "app-server" ? threads : [],
        nextCursor: null,
        backwardsCursor: null,
      })),
    },
    ...(source === "fallback" ? { sessionsDir: root } : {}),
    ttlMs: 60_000,
  });
  const reader = new CodexSessionReader({
    sessionsDir: root,
    projectPath: root,
  });
  const readSummary = vi.spyOn(reader, "getSessionSummary");
  const listSessions = vi.spyOn(reader, "listSessions");
  const index = new SessionIndexService({ dataDir: join(root, "indexes") });
  indexes.push(index);
  const deps = {
    scanner: {
      listProjects: async () => [project],
      getOrCreateProject: async () => project,
    } as unknown as ProjectScanner,
    readerFactory: () => reader as ISessionReader,
    codexReaderFactory: () => reader,
    codexSessionsDir: root,
    codexSessionCatalog: catalog,
    sessionIndexService: index,
  };
  return { root, project, threads, catalog, readSummary, listSessions, deps };
}

describe("Codex catalog list usage", () => {
  it("hydrates only the returned page, preserves catalog metadata, and refreshes cached usage after append", async () => {
    const { threads, catalog, readSummary, listSessions, deps } = await setup();
    // Project discovery and catalog snapshots must stay metadata-only.
    await catalog.getSnapshot();
    expect(readSummary).not.toHaveBeenCalled();
    const routes = createGlobalSessionsRoutes(deps);
    const response = await routes.request("/?limit=1");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0]).toMatchObject({
      id: threads[0]?.id,
      title: "Catalog title",
      contextUsage: { inputTokens: 139_008, contextWindow: 760_000 },
      cumulativeUsage: {
        totalTokens: 2_814_551,
        inputTokens: 124_184,
        outputTokens: 7_871,
        cacheReadTokens: 2_682_496,
        turnCount: 1,
      },
    });
    expect(json.sessions[0]).not.toHaveProperty("messageCount");
    expect(readSummary).toHaveBeenCalledTimes(1);
    expect(listSessions).not.toHaveBeenCalled();
    await routes.request("/?limit=1");
    expect(readSummary).toHaveBeenCalledTimes(1);

    await appendFile(
      threads[0]?.path as string,
      usage(2_900_000, 2_700_000, 8_000),
    );
    const refreshed = await (await routes.request("/?limit=1")).json();
    expect(refreshed.sessions[0].cumulativeUsage).toMatchObject({
      totalTokens: 2_908_000,
      inputTokens: 200_000,
      outputTokens: 8_000,
      cacheReadTokens: 2_700_000,
      turnCount: 2,
    });
    expect(readSummary).toHaveBeenCalledTimes(2);
  });

  it.each(["app-server", "fallback"] as const)(
    "restores project-list usage from the %s catalog, including totals across compaction",
    async (source) => {
      const { project, threads, deps } = await setup(source);
      await appendFile(
        threads[0]?.path as string,
        record("compacted", { message: "Summary", replacement_history: [] }) +
          usage(20_000, 10_000, 500),
      );
      const routes = createProjectsRoutes(deps);
      const response = await routes.request(`/${project.id}/sessions`);
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.sessions).toHaveLength(2);
      expect(
        json.sessions.find((row: { id: string }) => row.id === threads[0]?.id),
      ).toMatchObject({
        cumulativeUsage: {
          totalTokens: 2_835_051,
          inputTokens: 134_184,
          outputTokens: 8_371,
          cacheReadTokens: 2_692_496,
          turnCount: 2,
        },
      });
    },
  );
});

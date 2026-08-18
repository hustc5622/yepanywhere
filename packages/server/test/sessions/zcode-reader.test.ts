/**
 * ZCode session reader tests.
 *
 * Uses synthetic SQLite fixtures to test `ZCodeSessionReader.listSessions`,
 * `getSessionSummary`,
 * `getSession`, `getSessionSummaryIfChanged`, and `listSessionFiles`.
 *
 * Privacy: the fixture only uses synthetic titles and content. No real
 * ZCode session data is loaded. Fixture hash is verified unchanged after
 * read operations to prove no writes occurred.
 */

import { createHash } from "node:crypto";
import fsp from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZCodeSessionReader } from "../../src/sessions/zcode-reader.js";
import { shutdownSqliteWorker } from "../../src/sqlite/query-worker.js";

// =============================================================================
// SQLite fixture helper
// =============================================================================

async function loadSqlite(): Promise<{
  DatabaseSync: typeof import("node:sqlite").DatabaseSync;
} | null> {
  try {
    const mod = process.getBuiltinModule?.("node:sqlite");
    if (mod) return mod;
  } catch {
    // fall through
  }
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

const T = Date.UTC(2026, 7, 12, 12, 0, 0);

async function makeDb(dbPath: string): Promise<void> {
  const sqlite = await loadSqlite();
  if (!sqlite) return;
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      permission TEXT,
      task_type TEXT NOT NULL DEFAULT 'interactive',
      title_source TEXT NOT NULL DEFAULT 'first_input',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
  `);

  // Insert a session
  const sessStmt = db.prepare(
    `INSERT INTO session (id, project_id, directory, slug, title, version, permission, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sessStmt.run(
    "ses1",
    "proj1",
    "/test/project",
    "slug1",
    "Test Session",
    "1",
    `{"mode":"build"}`,
    T,
    T + 1000,
  );
  sessStmt.run(
    "ses2",
    "proj1",
    "/test/project",
    "slug2",
    "Another",
    "1",
    null,
    T,
    T + 2000,
  );
  sessStmt.run(
    "ses_other_project",
    "proj2",
    "/other/project",
    "slug-other",
    "Other Project",
    "1",
    null,
    T,
    T + 2500,
  );
  // Archived session (insert with time_archived using a separate statement)
  const archivedStmt = db.prepare(
    `INSERT INTO session (id, project_id, directory, slug, title, version, permission, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  archivedStmt.run(
    "ses_archived",
    "proj1",
    "/test/project",
    "slug3",
    "Archived",
    "1",
    null,
    T,
    T + 500,
    T + 600,
  );

  // Edit-fork child: parent_id set but task_type stays 'interactive'.
  const forkStmt = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, slug, title, version, permission, task_type, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  forkStmt.run(
    "ses_fork",
    "proj1",
    "ses1",
    "/test/project",
    "slug-fork",
    "Forked Edit",
    "1",
    null,
    "interactive",
    T,
    T + 3000,
  );

  // Subagent child: parent_id set with task_type 'subagent_child' (hidden).
  forkStmt.run(
    "ses_subagent",
    "proj1",
    "ses1",
    "/test/project",
    "slug-subagent",
    "Subagent",
    "1",
    null,
    "subagent_child",
    T,
    T + 4000,
  );

  // Insert messages for ses1
  const msgStmt = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  msgStmt.run(
    "msg1",
    "ses1",
    T,
    T,
    JSON.stringify({ role: "user", time: { created: T } }),
    0,
  );
  msgStmt.run(
    "msg2",
    "ses1",
    T + 100,
    T + 100,
    JSON.stringify({
      role: "assistant",
      time: { created: T + 100, completed: T + 200 },
      modelID: "zai/glm-4.6",
      parentID: "msg1",
    }),
    1,
  );

  // Insert parts for msg1 (user text)
  const partStmt = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  partStmt.run(
    "p1",
    "msg1",
    "ses1",
    T,
    T,
    JSON.stringify({ type: "text", text: "What is 2+2?" }),
    0,
  );

  // Insert parts for msg2 (assistant: reasoning + text + tool)
  partStmt.run(
    "p2",
    "msg2",
    "ses1",
    T + 100,
    T + 100,
    JSON.stringify({ type: "reasoning", text: "Let me think..." }),
    0,
  );
  partStmt.run(
    "p3",
    "msg2",
    "ses1",
    T + 110,
    T + 110,
    JSON.stringify({ type: "text", text: "The answer is 4" }),
    1,
  );
  partStmt.run(
    "p4",
    "msg2",
    "ses1",
    T + 120,
    T + 120,
    JSON.stringify({
      type: "tool",
      callID: "tool1",
      tool: "Bash",
      state: { status: "completed", input: { command: "echo 4" }, output: "4" },
    }),
    2,
  );

  db.close();
}

async function getFileHash(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

// =============================================================================
// Tests
// =============================================================================

describe("ZCodeSessionReader", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-reader-test-"));
    dbPath = join(tempDir, "db.sqlite");
    await makeDb(dbPath);
  });

  afterEach(async () => {
    await shutdownSqliteWorker();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("listSessions", () => {
    it("returns non-archived sessions for a project directory", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const sessions = await reader.listSessions("test-project-id" as never);
      // ses1, ses2 and the interactive edit-fork child are active;
      // ses_archived and the subagent child are excluded.
      expect(sessions).toHaveLength(3);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("ses1");
      expect(ids).toContain("ses2");
      expect(ids).toContain("ses_fork");
      expect(ids).not.toContain("ses_archived");
      expect(ids).not.toContain("ses_subagent");
    });

    it("surfaces native edit-fork lineage on interactive child sessions", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const sessions = await reader.listSessions("test-project-id" as never);
      const fork = sessions.find((s) => s.id === "ses_fork");
      expect(fork?.forkParentSessionId).toBe("ses1");
      const root = sessions.find((s) => s.id === "ses1");
      expect(root?.forkParentSessionId).toBeUndefined();
    });

    it("sets provider to zcode", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const sessions = await reader.listSessions("test-project-id" as never);
      for (const s of sessions) {
        expect(s.provider).toBe("zcode");
      }
    });

    it("returns empty for non-existent project", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/nonexistent",
      });
      const sessions = await reader.listSessions("test-project-id" as never);
      expect(sessions).toEqual([]);
    });

    it("returns empty for missing DB", async () => {
      const reader = new ZCodeSessionReader({
        dbPath: "/nonexistent/db.sqlite",
        projectPath: "/test/project",
      });
      const sessions = await reader.listSessions("test-project-id" as never);
      expect(sessions).toEqual([]);
    });
  });

  describe("getSessionSummary", () => {
    it("returns summary for an existing session", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const summary = await reader.getSessionSummary(
        "ses1",
        "test-project-id" as never,
      );
      expect(summary).not.toBeNull();
      expect(summary?.id).toBe("ses1");
      expect(summary?.provider).toBe("zcode");
    });

    it("returns null for non-existent session", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const summary = await reader.getSessionSummary(
        "nonexistent",
        "test-project-id" as never,
      );
      expect(summary).toBeNull();
    });

    it("does not resolve a session belonging to another project directory", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const summary = await reader.getSessionSummary(
        "ses_other_project",
        "test-project-id" as never,
      );
      expect(summary).toBeNull();
    });

    it("includes forkParentSessionId for an edit-fork child", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const summary = await reader.getSessionSummary(
        "ses_fork",
        "test-project-id" as never,
      );
      expect(summary?.forkParentSessionId).toBe("ses1");
    });

    it("omits forkParentSessionId for a subagent child", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const summary = await reader.getSessionSummary(
        "ses_subagent",
        "test-project-id" as never,
      );
      // Subagent children are addressable directly but never masquerade as
      // edit forks.
      expect(summary).not.toBeNull();
      expect(summary?.forkParentSessionId).toBeUndefined();
    });
  });

  describe("getSession", () => {
    it("returns full session with messages and parts", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const loaded = await reader.getSession(
        "ses1",
        "test-project-id" as never,
      );
      expect(loaded).not.toBeNull();
      expect(loaded?.data.provider).toBe("zcode");
      const session = loaded?.data.session as { messages: unknown[] };
      expect(session.messages).toHaveLength(2);
    });

    it("returns null for non-existent session", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const loaded = await reader.getSession(
        "nonexistent",
        "test-project-id" as never,
      );
      expect(loaded).toBeNull();
    });

    it("does not load content or stats across project directories", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      await expect(
        reader.getSession("ses_other_project", "test-project-id" as never),
      ).resolves.toBeNull();
      await expect(
        reader.getSessionFileStats("ses_other_project"),
      ).resolves.toBeNull();
    });

    it("returns parts in correct order", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const loaded = await reader.getSession(
        "ses1",
        "test-project-id" as never,
      );
      const session = loaded?.data.session as {
        messages: Array<{ parts: Array<{ type: string }> }>;
      };
      const msg2 = session.messages[1];
      // msg2 should have: reasoning, text, tool (in order)
      const partTypes = msg2?.parts.map((p) => p.type);
      expect(partTypes).toEqual(["reasoning", "text", "tool"]);
    });
  });

  describe("getSessionSummaryIfChanged", () => {
    it("returns null when mtime and size match cached values", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      // First get the current stats
      const stats = await reader.getSessionFileStats("ses1");
      expect(stats).not.toBeNull();
      if (!stats) return;

      const result = await reader.getSessionSummaryIfChanged(
        "ses1",
        "test-project-id" as never,
        stats.mtime,
        stats.size,
      );
      expect(result).toBeNull();
    });

    it("returns summary when mtime differs", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const result = await reader.getSessionSummaryIfChanged(
        "ses1",
        "test-project-id" as never,
        0, // wrong mtime → should report changed
        0, // wrong size
      );
      expect(result).not.toBeNull();
      expect(result?.summary.id).toBe("ses1");
    });
  });

  describe("listSessionFiles", () => {
    it("returns session IDs for the project", async () => {
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      const files = await reader.listSessionFiles(dbPath);
      expect(files).toHaveLength(3);
      const ids = files.map((f) => f.sessionId);
      expect(ids).toContain("ses1");
      expect(ids).toContain("ses2");
      expect(ids).toContain("ses_fork");
      expect(ids).not.toContain("ses_subagent");
      expect(files[0]?.filePath).toBe(dbPath);
    });
  });

  describe("getIndexScopeKey", () => {
    it("returns a stable key including dbPath and projectPath", () => {
      const reader = new ZCodeSessionReader({
        dbPath: "/path/to/db.sqlite",
        projectPath: "/my/project",
      });
      const key = reader.getIndexScopeKey("unused");
      expect(key).toBe("zcode::/path/to/db.sqlite::/my/project");
    });
  });

  describe("read-only safety", () => {
    it("does not modify the DB file during reads", async () => {
      const hashBefore = await getFileHash(dbPath);
      const reader = new ZCodeSessionReader({
        dbPath,
        projectPath: "/test/project",
      });
      await reader.listSessions("pid" as never);
      await reader.getSession("ses1", "pid" as never);
      await reader.getSessionSummary("ses1", "pid" as never);
      await reader.listSessionFiles(dbPath);
      const hashAfter = await getFileHash(dbPath);
      expect(hashAfter).toBe(hashBefore);
    });
  });
});

// =============================================================================
// Edit-fork branch state (separate synthetic family)
// =============================================================================

async function makeForkDb(dbPath: string): Promise<void> {
  const sqlite = await loadSqlite();
  if (!sqlite) return;
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      permission TEXT,
      task_type TEXT NOT NULL DEFAULT 'interactive',
      title_source TEXT NOT NULL DEFAULT 'first_input',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
  `);

  const insertSession = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, slug, title, version, permission, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertPart = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const addTextMessage = (
    id: string,
    sessionId: string,
    role: "user" | "assistant",
    text: string,
    createdAt: number,
    sequence: number,
  ) => {
    insertMessage.run(
      id,
      sessionId,
      createdAt,
      createdAt,
      JSON.stringify({ role, time: { created: createdAt } }),
      sequence,
    );
    insertPart.run(
      `${id}-p0`,
      id,
      sessionId,
      createdAt,
      createdAt,
      JSON.stringify({ type: "text", text }),
      0,
    );
  };

  // Root family session: two user prompts; the second is the edited original.
  insertSession.run(
    "par",
    "proj1",
    null,
    "/fork/project",
    "par-slug",
    "Parent",
    "1",
    null,
    T,
    T,
  );
  addTextMessage("u1", "par", "user", "first prompt", T, 0);
  addTextMessage("a1", "par", "assistant", "first answer", T + 100, 1);
  addTextMessage("u2", "par", "user", "original prompt", T + 200, 2);
  addTextMessage("a2", "par", "assistant", "original answer", T + 300, 3);

  // Fork child: copied prefix (fresh ids, identical text) + edited prompt.
  insertSession.run(
    "kid",
    "proj1",
    "par",
    "/fork/project",
    "kid-slug",
    "Fork",
    "1",
    null,
    T + 1000,
    T + 1000,
  );
  addTextMessage("u1c", "kid", "user", "first prompt", T, 0);
  addTextMessage("a1c", "kid", "assistant", "first answer", T + 100, 1);
  addTextMessage("u2c", "kid", "user", "edited prompt", T + 400, 2);

  // Unrelated singleton session in the same project.
  insertSession.run(
    "solo",
    "proj1",
    null,
    "/fork/project",
    "solo-slug",
    "Solo",
    "1",
    null,
    T,
    T,
  );
  addTextMessage("u_solo", "solo", "user", "unrelated", T, 0);

  db.close();
}

describe("ZCodeSessionReader branchState (edit-fork family)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-reader-fork-test-"));
    dbPath = join(tempDir, "db.sqlite");
    await makeForkDb(dbPath);
  });

  afterEach(async () => {
    await shutdownSqliteWorker();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("attaches a branch view with the edited prompt siblinged to the original", async () => {
    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/fork/project",
    });
    const loaded = await reader.getSession("kid", "pid" as never);
    const branches = loaded?.branchState?.branches ?? [];
    const byId = new Map(branches.map((b) => [b.id, b]));

    // Copied prefix never produces options; the edited prompt inherits the
    // original's slot below u1.
    expect(byId.has("u1c")).toBe(false);
    expect(byId.get("u2")).toMatchObject({
      sessionId: "par",
      parentId: "u1",
      siblingCount: 2,
      siblingIndex: 1,
    });
    expect(byId.get("u2c")).toMatchObject({
      sessionId: "kid",
      parentId: "u1",
      siblingCount: 2,
      siblingIndex: 2,
      isActive: true,
    });
    expect(loaded?.branchState?.provider).toBe("zcode");
    expect(loaded?.branchState?.activeBranchId).toBe("u2c");
  });

  it("also exposes the family when viewing the parent session", async () => {
    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/fork/project",
    });
    const loaded = await reader.getSession("par", "pid" as never);
    expect(loaded?.branchState?.sessionId).toBe("par");
    expect(loaded?.branchState?.activeBranchId).toBe("u2");
    expect(
      loaded?.branchState?.branches.find((b) => b.id === "u2")?.siblingCount,
    ).toBe(2);
  });

  it("honours an explicit branchId selection from the route", async () => {
    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/fork/project",
    });
    const loaded = await reader.getSession("kid", "pid" as never, undefined, {
      branchId: "u1",
    });
    expect(loaded?.branchState?.selectedBranchId).toBe("u1");
  });

  it("unions the Yep sidecar lineage when the native parent_id is absent", async () => {
    // Rebuild the family via metadata alone: strip the native parent edge.
    const sqlite = await loadSqlite();
    if (!sqlite) return;
    const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
    db.prepare("UPDATE session SET parent_id = NULL WHERE id = ?").run("kid");
    db.close();

    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/fork/project",
      getForkParentSessionId: (sessionId) =>
        sessionId === "kid" ? "par" : undefined,
    });
    const loaded = await reader.getSession("kid", "pid" as never);
    expect(loaded?.branchState).toBeDefined();
    expect(
      loaded?.branchState?.branches.find((b) => b.id === "u2c"),
    ).toMatchObject({ parentId: "u1", siblingCount: 2 });
  });

  it("returns no branchState for sessions outside any fork family", async () => {
    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/fork/project",
    });
    const loaded = await reader.getSession("solo", "pid" as never);
    expect(loaded?.branchState).toBeUndefined();
  });
});

// =============================================================================
// Subagent mapping + transcript (agent metadata + sqlite child sessions)
// =============================================================================

async function makeSubagentDb(
  dbPath: string,
  agentsDir: string,
): Promise<void> {
  const sqlite = await loadSqlite();
  if (!sqlite) return;
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      permission TEXT,
      task_type TEXT NOT NULL DEFAULT 'interactive',
      title_source TEXT NOT NULL DEFAULT 'first_input',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
  `);

  const insertSession = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, slug, title, version, permission, task_type, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertPart = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // Parent session with the spawning Agent tool call.
  insertSession.run(
    "parent",
    "proj1",
    null,
    "/agent/project",
    "parent-slug",
    "Parent",
    "1",
    null,
    "interactive",
    T,
    T,
  );
  insertMessage.run(
    "m1",
    "parent",
    T,
    T,
    JSON.stringify({ role: "assistant", time: { created: T } }),
    0,
  );
  insertPart.run(
    "p1",
    "m1",
    "parent",
    T,
    T,
    JSON.stringify({
      type: "tool",
      callID: "toolu_call_1",
      tool: "Agent",
      state: {
        status: "completed",
        input: {
          description: "scout files",
          prompt: "look around",
          subagent_type: "Explore",
        },
        output: "done",
      },
    }),
    0,
  );

  // Subagent child session with its own transcript.
  insertSession.run(
    "child-1",
    "proj1",
    "parent",
    "/agent/project",
    "child-slug",
    "Subagent",
    "1",
    null,
    "subagent_child",
    T,
    T,
  );
  const addMsg = (
    id: string,
    role: string,
    text: string,
    at: number,
    seq: number,
  ) => {
    insertMessage.run(
      id,
      "child-1",
      at,
      at,
      JSON.stringify({ role, time: { created: at } }),
      seq,
    );
    insertPart.run(
      `${id}-p0`,
      id,
      "child-1",
      at,
      at,
      JSON.stringify({ type: "text", text }),
      0,
    );
  };
  addMsg("cu1", "user", "look around", T + 10, 0);
  addMsg("ca1", "assistant", "found the files", T + 20, 1);

  db.close();

  // Agent metadata directory mirroring ~/.zcode/cli/agents/<parent>/agent_*/metadata.json
  const mkdir = (p: string) => fsp.mkdirSync(p, { recursive: true });
  const agentDir = join(agentsDir, "parent", "agent_child-1");
  mkdir(agentDir);
  fsp.writeFileSync(
    join(agentDir, "metadata.json"),
    JSON.stringify({
      agentId: "agent_child-1",
      childSessionId: "child-1",
      parentSessionId: "parent",
      parentToolUseId: "toolu_call_1",
      description: "scout files",
      prompt: "look around",
      profileId: "explore",
      profileSnapshot: { name: "Explore" },
      status: "completed",
      createdAt: new Date(T + 5).toISOString(),
      completedAt: new Date(T + 30).toISOString(),
      totalToolUseCount: 2,
      totalDurationMs: 25,
      totalTokens: 1234,
    }),
  );
}

describe("ZCodeSessionReader subagents", () => {
  let tempDir: string;
  let dbPath: string;
  let agentsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-reader-agents-test-"));
    dbPath = join(tempDir, "db.sqlite");
    agentsDir = join(tempDir, "agents");
    await makeSubagentDb(dbPath, agentsDir);
  });

  afterEach(async () => {
    await shutdownSqliteWorker();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("maps the spawning Agent tool call to the child session id", async () => {
    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/agent/project",
      agentsDir,
    });
    const mappings = await reader.getAgentMappings("parent");
    expect(mappings).toEqual([
      {
        toolUseId: "toolu_call_1",
        agentId: "child-1",
        agentType: "Explore",
        status: "completed",
      },
    ]);
  });

  it("returns no mappings for sessions without agent metadata", async () => {
    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/agent/project",
      agentsDir,
    });
    expect(await reader.getAgentMappings("unknown")).toEqual([]);
    expect(await reader.getAgentMappings()).toEqual([]);
  });

  it("loads the subagent transcript with descriptor and metrics", async () => {
    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/agent/project",
      agentsDir,
    });
    const session = await reader.getAgentSession("child-1", "parent");
    expect(session).not.toBeNull();
    expect(session?.status).toBe("completed");
    expect(session?.agentType).toBe("Explore");
    expect(session?.metrics).toMatchObject({
      toolUseCount: 2,
      durationMs: 25,
      usage: { totalTokens: 1234 },
    });
    expect(session?.descriptor).toMatchObject({
      agentId: "child-1",
      parentAgentId: "main",
      parentToolUseId: "toolu_call_1",
      type: "Explore",
      description: "scout files",
      status: "completed",
    });
    const texts = (session?.messages ?? []).flatMap((m) =>
      Array.isArray(m.message?.content)
        ? m.message.content.flatMap((b: { type?: string; text?: string }) =>
            b.type === "text" ? [b.text] : [],
          )
        : [],
    );
    expect(texts).toContain("look around");
    expect(texts).toContain("found the files");
  });

  it("scopes the agent lookup to the parent session", async () => {
    const reader = new ZCodeSessionReader({
      dbPath,
      projectPath: "/agent/project",
      agentsDir,
    });
    // Same agentId, wrong parent scope → nothing.
    expect(await reader.getAgentSession("child-1", "other-parent")).toBeNull();
    expect(await reader.getAgentSession("nope", "parent")).toBeNull();
    expect(await reader.getAgentSession("../escape", "parent")).toBeNull();
  });
});

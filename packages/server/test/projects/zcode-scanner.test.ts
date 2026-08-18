/**
 * ZCode session scanner tests.
 *
 * Uses synthetic SQLite fixtures to test `ZCodeSessionScanner.listProjects`
 * and `getSessionsForProject`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZCodeSessionScanner } from "../../src/projects/zcode-scanner.js";
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
  const db = new sqlite.DatabaseSync(dbPath);
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

  // Insert two sessions in different directories
  const stmt = db.prepare(
    `INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    "ses_a",
    "proj_a",
    "/project/a",
    "slug_a",
    "Session A",
    "1",
    T,
    T + 1000,
  );
  stmt.run(
    "ses_b",
    "proj_b",
    "/project/b",
    "slug_b",
    "Session B",
    "1",
    T,
    T + 2000,
  );
  // An archived session (should not appear)
  const archivedStmt = db.prepare(
    `INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  archivedStmt.run(
    "ses_c",
    "proj_a",
    "/project/a",
    "slug_c",
    "Archived",
    "1",
    T,
    T + 500,
    T + 600,
  );
  // An edit-fork child keeps task_type=interactive and remains user-visible.
  const childStmt = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, slug, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  childStmt.run(
    "ses_child",
    "proj_a",
    "parent_a",
    "/project/a",
    "slug_child",
    "Child",
    "1",
    T,
    T + 300,
  );
  // A subagent child is internal and must not be returned or notified.
  const subagentStmt = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, slug, title, version, task_type, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  subagentStmt.run(
    "ses_subagent",
    "proj_a",
    "ses_a",
    "/project/a",
    "slug_subagent",
    "Subagent",
    "1",
    "subagent_child",
    T,
    T + 400,
  );

  db.close();
}

// =============================================================================
// Tests
// =============================================================================

describe("ZCodeSessionScanner", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-scanner-test-"));
    dbPath = join(tempDir, "db.sqlite");
    await makeDb(dbPath);
  });

  afterEach(async () => {
    await shutdownSqliteWorker();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("listProjects", () => {
    it("returns projects grouped by directory", async () => {
      const scanner = new ZCodeSessionScanner({ dbPath });
      const projects = await scanner.listProjects();
      // Two directories: /project/a and /project/b
      expect(projects).toHaveLength(2);
      const paths = projects.map((p) => p.path);
      expect(paths).toContain("/project/a");
      expect(paths).toContain("/project/b");
    });

    it("excludes archived sessions from count", async () => {
      const scanner = new ZCodeSessionScanner({ dbPath });
      const projects = await scanner.listProjects();
      const projA = projects.find((p) => p.path === "/project/a");
      // Fork children collapse into their root and subagent children are
      // internal, so only ses_a contributes to the project count.
      expect(projA?.sessionCount).toBe(1);
    });

    it("sets provider to zcode", async () => {
      const scanner = new ZCodeSessionScanner({ dbPath });
      const projects = await scanner.listProjects();
      for (const p of projects) {
        expect(p.provider).toBe("zcode");
      }
    });

    it("sets sessionDir to dbPath", async () => {
      const scanner = new ZCodeSessionScanner({ dbPath });
      const projects = await scanner.listProjects();
      for (const p of projects) {
        expect(p.sessionDir).toBe(dbPath);
      }
    });

    it("returns empty array when DB is missing", async () => {
      const scanner = new ZCodeSessionScanner({
        dbPath: "/nonexistent/path/db.sqlite",
      });
      const projects = await scanner.listProjects();
      expect(projects).toEqual([]);
    });
  });

  describe("getSessionsForProject", () => {
    it("returns sessions for a specific project", async () => {
      const scanner = new ZCodeSessionScanner({ dbPath });
      const sessions = await scanner.getSessionsForProject("/project/a");
      // ses_a (root) + ses_child (edit fork) — archived and subagent rows
      // are excluded.
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("ses_a");
      expect(ids).toContain("ses_child");
      expect(ids).not.toContain("ses_subagent");
    });

    it("returns empty for non-existent project", async () => {
      const scanner = new ZCodeSessionScanner({ dbPath });
      const sessions = await scanner.getSessionsForProject("/nonexistent");
      expect(sessions).toEqual([]);
    });
  });

  describe("scanSessionChanges", () => {
    it("emits edit-fork changes but filters subagent children", async () => {
      const scanner = new ZCodeSessionScanner({ dbPath });
      const result = await scanner.scanSessionChanges(
        { updatedAt: 0, sessionId: "" },
        20,
      );

      const ids = result.changes.map((change) => change.sessionId);
      expect(ids).toContain("ses_a");
      expect(ids).toContain("ses_child");
      expect(ids).not.toContain("ses_subagent");
      expect(ids).not.toContain("ses_c");
      expect(result.skipped.child).toBe(1);
      expect(result.skipped.archived).toBe(1);
    });
  });

  describe("invalidateCache", () => {
    it("clears the project cache", async () => {
      const scanner = new ZCodeSessionScanner({ dbPath });
      await scanner.listProjects();
      scanner.invalidateCache();
      // Next call should re-scan (not return cached)
      const projects = await scanner.listProjects();
      expect(projects).toHaveLength(2);
    });
  });

  describe("databasePath", () => {
    it("returns the configured dbPath", () => {
      const scanner = new ZCodeSessionScanner({ dbPath: "/custom/path.db" });
      expect(scanner.databasePath).toBe("/custom/path.db");
    });
  });
});

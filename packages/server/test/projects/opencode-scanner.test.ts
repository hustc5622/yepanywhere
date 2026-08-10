import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeSessionScanner } from "../../src/projects/opencode-scanner.js";
import { shutdownOpenCodeDbWorker } from "../../src/sessions/opencode-db-worker.js";

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

interface TestSqlite {
  DatabaseSync: new (path: string) => TestDatabase;
}

function loadSqlite(): TestSqlite | null {
  const getBuiltinModule = (
    process as unknown as { getBuiltinModule?: (name: string) => unknown }
  ).getBuiltinModule;
  const builtin = getBuiltinModule?.call(process, "node:sqlite") as
    | { DatabaseSync?: TestSqlite["DatabaseSync"] }
    | undefined;
  return builtin?.DatabaseSync ? { DatabaseSync: builtin.DatabaseSync } : null;
}

/** Both sessions share this timestamp so the composite cursor has to break the tie. */
const T = Date.UTC(2026, 6, 8, 12, 0, 0);
const PROJECT_DIR = "/proj/scanner";

let workDir: string;
let dbPath: string;
let sqlite: TestSqlite | null;

function withDb<T>(callback: (db: TestDatabase) => T): T {
  if (!sqlite) throw new Error("node:sqlite unavailable");
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  sqlite = loadSqlite();
  workDir = await mkdtemp(join(tmpdir(), `opencode-scan-${randomUUID()}-`));
  dbPath = join(workDir, "opencode.db");
  if (!sqlite) return;

  withDb((db) => {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_archived integer
      );
      CREATE TABLE message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `);
    for (const id of ["ses_a", "ses_b"]) {
      db.prepare(
        `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
         VALUES (?, 'p', NULL, 's', ?, 't', '1', ?, ?, NULL)`,
      ).run(id, PROJECT_DIR, T, T);
      db.prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, '{"role":"user"}')`,
      ).run(`msg_${id}`, id, T, T);
      db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, '{"type":"text","text":"original"}')`,
      ).run(`prt_${id}`, `msg_${id}`, id, T, T);
    }
  });
});

afterEach(async () => {
  await shutdownOpenCodeDbWorker();
  await rm(workDir, { recursive: true, force: true });
});

describe("OpenCodeSessionScanner replay suppression", () => {
  it("suppresses an unchanged session on the drained replay pass", async () => {
    if (!sqlite) return;
    const scanner = new OpenCodeSessionScanner({ dbPath });

    const first = await scanner.scanSessionChanges(
      { updatedAt: 0, sessionId: "" },
      1,
    );
    expect(first.hasMore).toBe(true);
    expect(first.changes.map((change) => change.sessionId)).toEqual(["ses_a"]);

    const second = await scanner.scanSessionChanges(first.nextCursor, 1);
    expect(second.hasMore).toBe(false);
    // `ses_a` falls inside the replay overlap but is byte-for-byte unchanged,
    // so only the newly paginated `ses_b` is delivered.
    expect(second.changes.map((change) => change.sessionId)).toEqual(["ses_b"]);
  });

  it("still delivers a same-millisecond edit that the digest can see", async () => {
    if (!sqlite) return;
    const scanner = new OpenCodeSessionScanner({ dbPath });

    const first = await scanner.scanSessionChanges(
      { updatedAt: 0, sessionId: "" },
      1,
    );
    expect(first.changes.map((change) => change.sessionId)).toEqual(["ses_a"]);

    // Rewrite `ses_a`'s part in place, keeping `time_updated` at the very same
    // millisecond. The old full-row fingerprint caught this; the aggregate
    // digest must too, otherwise the update would be silently swallowed.
    withDb((db) => {
      db.prepare("UPDATE part SET data = ? WHERE id = ?").run(
        '{"type":"text","text":"edited in the same millisecond"}',
        "prt_ses_a",
      );
    });

    const second = await scanner.scanSessionChanges(first.nextCursor, 1);
    expect(second.changes.map((change) => change.sessionId)).toEqual([
      "ses_a",
      "ses_b",
    ]);
  });

  it("delivers an appended part even when the timestamp does not move", async () => {
    if (!sqlite) return;
    const scanner = new OpenCodeSessionScanner({ dbPath });

    const first = await scanner.scanSessionChanges(
      { updatedAt: 0, sessionId: "" },
      1,
    );
    expect(first.changes.map((change) => change.sessionId)).toEqual(["ses_a"]);

    withDb((db) => {
      db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES ('prt_ses_a_2', 'msg_ses_a', 'ses_a', ?, ?, '{"type":"text","text":"original"}')`,
      ).run(T, T);
    });

    const second = await scanner.scanSessionChanges(first.nextCursor, 1);
    expect(second.changes.map((change) => change.sessionId)).toContain("ses_a");
  });
});

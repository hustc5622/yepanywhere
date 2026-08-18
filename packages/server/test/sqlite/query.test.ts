import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shutdownSqliteWorker } from "../../src/sqlite/query-worker.js";
import {
  querySqliteRow,
  querySqliteRows,
  runSqliteStatements,
} from "../../src/sqlite/query.js";

interface TestDatabase {
  exec(sql: string): void;
  close(): void;
}

interface TestSqlite {
  DatabaseSync: new (path: string) => TestDatabase;
}

async function loadSqlite(): Promise<TestSqlite | null> {
  const specifier: string = "node:sqlite";
  // Vitest routes a bare dynamic `import("node:sqlite")` through Vite's
  // resolver, which fails and would silently disable this whole file.
  const getBuiltinModule = (
    process as unknown as { getBuiltinModule?: (name: string) => unknown }
  ).getBuiltinModule;
  const builtin = getBuiltinModule?.call(process, specifier) as
    | { DatabaseSync?: TestSqlite["DatabaseSync"] }
    | undefined;
  if (builtin?.DatabaseSync) return { DatabaseSync: builtin.DatabaseSync };
  return import(specifier)
    .then((mod) => {
      const candidate = mod as { DatabaseSync?: TestSqlite["DatabaseSync"] };
      return candidate.DatabaseSync
        ? { DatabaseSync: candidate.DatabaseSync }
        : null;
    })
    .catch(() => null);
}

/** Burns CPU inside SQLite long enough to observe main-thread behaviour. */
const SLOW_SQL = `
  WITH RECURSIVE counter(i) AS (
    SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < 4000000
  )
  SELECT COUNT(*) AS n FROM counter
`;

let workDir: string;
let dbPath: string;
let sqlite: TestSqlite | null;

beforeEach(async () => {
  sqlite = await loadSqlite();
  workDir = await mkdtemp(join(tmpdir(), `sqlite-query-${randomUUID()}-`));
  dbPath = join(workDir, "provider.db");
  if (!sqlite) return;
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL);
      INSERT INTO session VALUES ('ses_a', '/proj'), ('ses_b', '/proj');
    `);
  } finally {
    db.close();
  }
});

afterEach(async () => {
  await shutdownSqliteWorker();
  await rm(workDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("provider-neutral SQLite worker", () => {
  it("returns rows for a batch of statements", async () => {
    if (!sqlite) return;
    const result = await runSqliteStatements(
      dbPath,
      [
        { sql: "SELECT id FROM session ORDER BY id" },
        {
          sql: "SELECT id FROM session WHERE id = ?",
          params: ["ses_b"],
          mode: "get",
        },
      ],
      { label: "test.batch" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toEqual([{ id: "ses_a" }, { id: "ses_b" }]);
    expect(result.value[1]).toEqual({ id: "ses_b" });
  });

  it("keeps the event loop responsive while a slow query runs", async () => {
    if (!sqlite) return;

    let maxGapMs = 0;
    let last = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
    }, 5);

    const startedAt = Date.now();
    try {
      const result = await querySqliteRows(dbPath, SLOW_SQL, [], {
        label: "test.slow",
        // Budget warnings are noise here; only responsiveness matters.
        budgetMs: 60_000,
      });
      expect(result.ok).toBe(true);
    } finally {
      clearInterval(heartbeat);
    }
    const elapsedMs = Date.now() - startedAt;

    // The query has to be slow enough for the assertion to mean something.
    expect(elapsedMs).toBeGreaterThan(150);
    // A synchronous DatabaseSync call on this thread would have stalled the
    // timer for the whole query. Allow generous slack for CI scheduling.
    expect(maxGapMs).toBeLessThan(elapsedMs / 2);
  });

  it("cancels on timeout and stays usable afterwards", async () => {
    if (!sqlite) return;

    const timedOut = await querySqliteRows(dbPath, SLOW_SQL, [], {
      label: "test.timeout",
      timeoutMs: 1,
    });
    expect(timedOut.ok).toBe(false);
    if (timedOut.ok) return;
    expect(timedOut.reason).toBe("query-timeout");

    // The pool terminated the stuck worker; the next call must respawn it.
    const recovered = await querySqliteRow(
      dbPath,
      "SELECT id FROM session WHERE id = ?",
      ["ses_a"],
      { label: "test.after-timeout" },
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toEqual({ id: "ses_a" });
  });

  it("distinguishes a missing database from an empty result", async () => {
    const result = await querySqliteRows(
      join(workDir, "absent.db"),
      "SELECT 1",
      [],
      { label: "test.missing" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("database-unavailable");
  });

  it("reports invalid SQL as query-failed", async () => {
    if (!sqlite) return;
    const result = await querySqliteRows(
      dbPath,
      "SELECT * FROM table_that_does_not_exist",
      [],
      { label: "test.bad-sql" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("query-failed");
  });

  it("falls back to inline execution when the worker is disabled", async () => {
    if (!sqlite) return;
    vi.stubEnv("YEP_SQLITE_QUERY_WORKER", "false");
    const result = await querySqliteRows(
      dbPath,
      "SELECT id FROM session ORDER BY id",
      [],
      { label: "test.inline" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ id: "ses_a" }, { id: "ses_b" }]);
  });
});

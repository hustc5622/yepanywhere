import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_CHANGE_PAGE_SQL,
  SESSION_CHANGE_REPLAY_SQL,
} from "../../src/projects/opencode-scanner.js";
import {
  ensureOpenCodeDbIndexes,
  resetOpenCodeDbIndexStateForTests,
} from "../../src/sessions/opencode-db-indexes.js";
import { shutdownOpenCodeDbWorker } from "../../src/sessions/opencode-db-worker.js";
import {
  SESSION_STATS_SQL,
  SINGLE_SESSION_STATS_SQL,
} from "../../src/sessions/opencode-reader.js";

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
  };
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

const OPENCODE_SCHEMA = `
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
    time_archived integer,
    model text,
    metadata text,
    tokens_input integer DEFAULT 0 NOT NULL,
    tokens_output integer DEFAULT 0 NOT NULL,
    tokens_reasoning integer DEFAULT 0 NOT NULL,
    tokens_cache_read integer DEFAULT 0 NOT NULL,
    tokens_cache_write integer DEFAULT 0 NOT NULL
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
  CREATE INDEX message_session_time_created_id_idx
    ON message (session_id, time_created, id);
  CREATE INDEX part_session_idx ON part (session_id);
  CREATE INDEX part_message_id_id_idx ON part (message_id, id);
`;

let workDir: string;
let dbPath: string;
let sqlite: TestSqlite | null;

/** `EXPLAIN QUERY PLAN` rows, joined into one searchable string. */
function explain(sql: string, params: unknown[]): string {
  if (!sqlite) return "";
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    return db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => String(row.detail ?? ""))
      .join("\n");
  } finally {
    db.close();
  }
}

function listIndexes(): string[] {
  if (!sqlite) return [];
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => String(row.name ?? ""));
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  sqlite = await loadSqlite();
  workDir = await mkdtemp(join(tmpdir(), `opencode-idx-${randomUUID()}-`));
  dbPath = join(workDir, "opencode.db");
  resetOpenCodeDbIndexStateForTests();
  // Index DDL is disabled by default under NODE_ENV=test so the suite can never
  // write into a developer's real OpenCode database. Opt in explicitly here.
  vi.stubEnv("OPENCODE_DB_ENSURE_INDEXES", "true");
  if (!sqlite) return;

  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(OPENCODE_SCHEMA);
    // Enough rows that SQLite prefers an index over a scan.
    db.exec(`
      WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 400)
      INSERT INTO session
      SELECT 'ses_' || i, 'p', NULL, 's', '/proj', 't', '1',
             1700000000000 + i, 1700000000000 + i, NULL, NULL, '{}', 0, 0, 0, 0, 0
      FROM c;
    `);
    db.exec(`
      WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 4000)
      INSERT INTO message
      SELECT 'msg_' || i, 'ses_' || (i % 400 + 1),
             1700000000000 + i, 1700000000000 + i, '{"role":"user"}'
      FROM c;
    `);
    db.exec(`
      WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 8000)
      INSERT INTO part
      SELECT 'prt_' || i, 'msg_' || (i % 4000 + 1), 'ses_' || (i % 400 + 1),
             1700000000000 + i, 1700000000000 + i, '{"type":"text","text":"x"}'
      FROM c;
    `);
    db.exec("ANALYZE;");
  } finally {
    db.close();
  }
});

afterEach(async () => {
  await shutdownOpenCodeDbWorker();
  resetOpenCodeDbIndexStateForTests();
  await rm(workDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("ensureOpenCodeDbIndexes", () => {
  it("creates every helper index and is idempotent", async () => {
    if (!sqlite) return;

    const first = await ensureOpenCodeDbIndexes(dbPath);
    expect(first.status).toBe("created");
    expect(first.created).toEqual([
      "yep_session_time_updated_id_idx",
      "yep_message_time_updated_session_idx",
      "yep_part_time_updated_session_idx",
      "yep_message_session_time_updated_idx",
      "yep_part_session_time_updated_idx",
    ]);
    expect(listIndexes()).toEqual(expect.arrayContaining(first.created));

    // Memoized within the process.
    expect((await ensureOpenCodeDbIndexes(dbPath)).status).toBe("created");

    resetOpenCodeDbIndexStateForTests();
    const second = await ensureOpenCodeDbIndexes(dbPath);
    expect(second.status).toBe("already-present");
    expect(second.created).toEqual([]);
  });

  it("honours OPENCODE_DB_ENSURE_INDEXES=false", async () => {
    vi.stubEnv("OPENCODE_DB_ENSURE_INDEXES", "false");
    const result = await ensureOpenCodeDbIndexes(dbPath);
    expect(result.status).toBe("skipped-disabled");
    expect(listIndexes()).not.toContain("yep_session_time_updated_id_idx");
  });

  it("writes no DDL under NODE_ENV=test unless explicitly enabled", async () => {
    // Regression guard: the server startup path runs inside the test suite, so
    // an unset flag must never touch a real OpenCode database.
    vi.stubEnv("OPENCODE_DB_ENSURE_INDEXES", "");
    expect(process.env.NODE_ENV).toBe("test");

    const result = await ensureOpenCodeDbIndexes(dbPath);
    expect(result.status).toBe("skipped-disabled");
    expect(listIndexes()).not.toContain("yep_session_time_updated_id_idx");
  });

  it("skips instead of writing DDL when the OpenCode schema changed", async () => {
    if (!sqlite) return;
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      // Simulate an upstream rename of the column we index on.
      db.exec("ALTER TABLE part RENAME COLUMN time_updated TO updated_at;");
    } finally {
      db.close();
    }

    const result = await ensureOpenCodeDbIndexes(dbPath);
    expect(result.status).toBe("skipped-schema-mismatch");
    expect(listIndexes()).not.toContain("yep_part_time_updated_session_idx");
  });

  it("reports unavailable for a missing database instead of throwing", async () => {
    const result = await ensureOpenCodeDbIndexes(join(workDir, "absent.db"));
    expect(result.status).toBe("unavailable");
  });
});

describe("OpenCode query plans", () => {
  const pageParams = [
    1700000200000,
    1700000200000,
    "",
    1700000200000,
    1700000200000,
    "",
    1700000200000,
    1700000200000,
    "",
    101,
  ];
  const replayParams = [
    1700000200000,
    1700000200000,
    1700000200000,
    1700000200000,
    1700000300000,
    1700000300000,
    "ses_1",
  ];

  it("uses full scans before the helper indexes exist", async () => {
    if (!sqlite) return;
    // Guards the premise of the next test: without the indexes these really do
    // degrade to table scans, which is the behaviour being fixed.
    const plan = explain(SESSION_CHANGE_PAGE_SQL, pageParams);
    expect(plan).toContain("SCAN message");
    expect(plan).toContain("SCAN part");
  });

  it("never scans message/part once the helper indexes exist", async () => {
    if (!sqlite) return;
    await ensureOpenCodeDbIndexes(dbPath);

    for (const [sql, params] of [
      [SESSION_CHANGE_PAGE_SQL, pageParams],
      [SESSION_CHANGE_REPLAY_SQL, replayParams],
      [`${SESSION_STATS_SQL} WHERE s.time_archived IS NULL`, []],
    ] as const) {
      const plan = explain(sql, [...params]);
      expect(plan).not.toContain("SCAN message\n");
      expect(plan).not.toMatch(/SCAN message$/m);
      expect(plan).not.toMatch(/SCAN part$/m);
      expect(plan).not.toMatch(/SCAN message USING INDEX message_session/);
      expect(plan).not.toMatch(/SCAN part USING INDEX part_session_idx/);
    }
  });

  it("resolves single-session stats without aggregating the whole database", async () => {
    if (!sqlite) return;
    await ensureOpenCodeDbIndexes(dbPath);

    const plan = explain(SINGLE_SESSION_STATS_SQL, ["ses_7", "/proj"]);
    // Every message/part access must be a keyed SEARCH on that one session.
    expect(plan).not.toMatch(/SCAN message/);
    expect(plan).not.toMatch(/SCAN part/);
    expect(plan).toMatch(/SEARCH (message|part)/);
  });

  it("bounds the replay window inside each UNION branch", () => {
    // The pre-fix replay CTE selected from session/message/part with no WHERE
    // at all, so every drained poll aggregated the entire database.
    const branches = SESSION_CHANGE_REPLAY_SQL.split("UNION ALL");
    expect(branches).toHaveLength(3);
    for (const branch of branches) {
      expect(branch).toContain("time_updated >= ?");
    }
  });
});

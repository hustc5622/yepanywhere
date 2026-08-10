/**
 * Yep-owned helper indexes on OpenCode's shared `opencode.db`.
 *
 * OpenCode ships indexes keyed by `session_id`/`parent_id` but none that start
 * with `time_updated`. Every incremental "what changed since my cursor?" scan
 * therefore degrades into a full scan of `session`, `message` and `part` plus
 * temporary B-trees for the GROUP BY/ORDER BY, which is what makes a poll on a
 * multi-gigabyte database take tens of seconds.
 *
 * These indexes are a version-controlled fallback, not an ownership claim on
 * upstream's schema:
 *
 * - every name is `yep_`-prefixed so it is trivially attributable and
 *   droppable;
 * - the schema is verified before any DDL, so a future OpenCode release that
 *   renames or retypes these columns makes us skip instead of corrupting a
 *   migration;
 * - failures are logged and swallowed. A database Yep cannot index is still a
 *   database Yep must be able to read.
 */
import { access } from "node:fs/promises";
import { getLogger } from "../logging/logger.js";
import {
  type OpenCodeDbStatement,
  runIsolatedOpenCodeDbStatements,
} from "./opencode-db-worker.js";

interface RequiredIndex {
  name: string;
  table: string;
  columns: string[];
}

const REQUIRED_INDEXES: RequiredIndex[] = [
  // Incremental "what changed since my cursor?" scans. Leading `time_updated`
  // turns three full table scans into covering-index range searches.
  {
    name: "yep_session_time_updated_id_idx",
    table: "session",
    columns: ["time_updated", "id"],
  },
  {
    name: "yep_message_time_updated_session_idx",
    table: "message",
    columns: ["time_updated", "session_id"],
  },
  {
    name: "yep_part_time_updated_session_idx",
    table: "part",
    columns: ["time_updated", "session_id"],
  },
  // Per-session `COUNT(*)`/`MAX(time_updated)` for the session index. OpenCode's
  // own `message(session_id, time_created, id)` and `part(session_id)` do not
  // carry `time_updated`, so these aggregates otherwise have to read every full
  // row. Adding `time_updated` makes them covering scans.
  {
    name: "yep_message_session_time_updated_idx",
    table: "message",
    columns: ["session_id", "time_updated"],
  },
  {
    name: "yep_part_session_time_updated_idx",
    table: "part",
    columns: ["session_id", "time_updated"],
  },
];

/** Index builds hold the write lock; allow far longer than a normal query. */
const INDEX_BUILD_TIMEOUT_MS = 10 * 60_000;
const BUSY_TIMEOUT_MS = 30_000;

export type OpenCodeIndexEnsureStatus =
  | "created"
  | "already-present"
  | "skipped-disabled"
  | "skipped-schema-mismatch"
  | "unavailable"
  | "failed";

export interface OpenCodeIndexEnsureResult {
  status: OpenCodeIndexEnsureStatus;
  created: string[];
  durationMs: number;
}

/**
 * Index creation writes DDL into a database owned by OpenCode, so it must only
 * ever happen because a real server started.
 *
 * `OPENCODE_DB_ENSURE_INDEXES` is honoured verbatim when set. When it is unset
 * the default is "on", *except* under `NODE_ENV=test`: the server startup path
 * is exercised by the test suite, and without this guard a plain `pnpm test`
 * would silently write indexes into the developer's own `~/.local/share/
 * opencode/opencode.db`.
 */
function isEnabled(): boolean {
  const raw = (process.env.OPENCODE_DB_ENSURE_INDEXES ?? "")
    .trim()
    .toLowerCase();
  if (raw.length > 0) {
    return raw !== "false" && raw !== "0" && raw !== "off";
  }
  return process.env.NODE_ENV !== "test";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

const inFlight = new Map<string, Promise<OpenCodeIndexEnsureResult>>();
const completed = new Map<string, OpenCodeIndexEnsureResult>();

/**
 * Create the missing `yep_*` indexes once per process and database.
 *
 * Safe to call from several places; the work is de-duplicated and the result
 * memoized. Never throws.
 */
export async function ensureOpenCodeDbIndexes(
  dbPath: string,
): Promise<OpenCodeIndexEnsureResult> {
  const memoized = completed.get(dbPath);
  if (memoized) return memoized;
  const pending = inFlight.get(dbPath);
  if (pending) return pending;

  const promise = ensureOnce(dbPath).then((result) => {
    // A transient failure must not be memoized as the final answer: a later
    // caller (or the next restart of a busy OpenCode) should get another try.
    if (result.status !== "failed" && result.status !== "unavailable") {
      completed.set(dbPath, result);
    }
    return result;
  });
  inFlight.set(dbPath, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(dbPath);
  }
}

async function ensureOnce(dbPath: string): Promise<OpenCodeIndexEnsureResult> {
  const startedAt = Date.now();
  if (!isEnabled()) {
    return { status: "skipped-disabled", created: [], durationMs: 0 };
  }

  try {
    await access(dbPath);
  } catch {
    // No OpenCode database on this machine yet. Not an error, and not
    // something to warn about on every check.
    return {
      status: "unavailable",
      created: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const inspection = await runIsolatedOpenCodeDbStatements({
    dbPath,
    label: "opencode.indexes.inspect",
    timeoutMs: 30_000,
    budgetMs: 5_000,
    statements: [
      { sql: "SELECT name FROM sqlite_master WHERE type = 'index'" },
      ...REQUIRED_INDEXES.map((index) => ({
        sql: `PRAGMA table_info(${index.table})`,
      })),
    ],
  });

  if (!inspection.ok) {
    const status: OpenCodeIndexEnsureStatus =
      inspection.reason === "query-failed" ? "failed" : "unavailable";
    getLogger().warn(
      {
        event: "opencode_db_index_inspect_failed",
        reason: inspection.reason,
        err: inspection.error,
        dbPath,
      },
      "[opencode-db] Unable to inspect OpenCode schema for helper indexes",
    );
    return { status, created: [], durationMs: Date.now() - startedAt };
  }

  const existingIndexes = new Set(
    asRows(inspection.results[0])
      .map((row) => asString(row.name))
      .filter((name): name is string => name !== undefined),
  );

  const missing: RequiredIndex[] = [];
  for (const [offset, index] of REQUIRED_INDEXES.entries()) {
    const columns = new Set(
      asRows(inspection.results[offset + 1])
        .map((row) => asString(row.name))
        .filter((name): name is string => name !== undefined),
    );
    // An empty column list means the table is gone entirely.
    const schemaMatches =
      columns.size > 0 && index.columns.every((column) => columns.has(column));
    if (!schemaMatches) {
      getLogger().warn(
        {
          event: "opencode_db_index_schema_mismatch",
          index: index.name,
          table: index.table,
          expectedColumns: index.columns,
        },
        "[opencode-db] OpenCode schema changed; skipping helper index",
      );
      return {
        status: "skipped-schema-mismatch",
        created: [],
        durationMs: Date.now() - startedAt,
      };
    }
    if (!existingIndexes.has(index.name)) missing.push(index);
  }

  if (missing.length === 0) {
    return {
      status: "already-present",
      created: [],
      durationMs: Date.now() - startedAt,
    };
  }

  getLogger().info(
    {
      event: "opencode_db_index_build_started",
      indexes: missing.map((index) => index.name),
      dbPath,
    },
    "[opencode-db] Creating OpenCode helper indexes; first run can take a while on a large database",
  );

  const statements: OpenCodeDbStatement[] = [
    // OpenCode may be mid-write. Wait for the lock instead of failing fast.
    { sql: `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`, mode: "run" },
    ...missing.map((index) => ({
      sql: `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table} (${index.columns.join(", ")})`,
      mode: "run" as const,
    })),
  ];

  const build = await runIsolatedOpenCodeDbStatements({
    dbPath,
    writable: true,
    label: "opencode.indexes.create",
    timeoutMs: INDEX_BUILD_TIMEOUT_MS,
    budgetMs: INDEX_BUILD_TIMEOUT_MS,
    statements,
  });

  const durationMs = Date.now() - startedAt;
  if (!build.ok) {
    getLogger().warn(
      {
        event: "opencode_db_index_build_failed",
        reason: build.reason,
        err: build.error,
        indexes: missing.map((index) => index.name),
        durationMs,
      },
      "[opencode-db] Helper index creation failed; scans stay on the slow path",
    );
    return {
      status: build.reason === "query-failed" ? "failed" : "unavailable",
      created: [],
      durationMs,
    };
  }

  const created = missing.map((index) => index.name);
  getLogger().info(
    {
      event: "opencode_db_index_build_completed",
      indexes: created,
      durationMs,
    },
    "[opencode-db] Helper indexes created",
  );
  return { status: "created", created, durationMs };
}

/** Test hook: forget memoized per-database results. */
export function resetOpenCodeDbIndexStateForTests(): void {
  completed.clear();
  inFlight.clear();
}

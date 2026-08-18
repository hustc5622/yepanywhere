import { access } from "node:fs/promises";
import { type SqliteStatement, getSqliteWorkerPool } from "./query-worker.js";

export type { SqliteStatement } from "./query-worker.js";

interface SqlitePreparedStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => SqliteDatabase;
}

export type SqliteFailureReason =
  | "database-unavailable"
  | "sqlite-unavailable"
  | "query-failed"
  /** Cancelled by the query deadline; the query itself may still be valid. */
  | "query-timeout";

export type SqliteResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: SqliteFailureReason;
      error?: unknown;
    };

let sqliteModulePromise: Promise<SqliteModule | null> | null = null;

async function loadSqliteModule(): Promise<SqliteModule | null> {
  if (!sqliteModulePromise) {
    const specifier: string = "node:sqlite";
    const getBuiltinModule = (
      process as unknown as {
        getBuiltinModule?: (name: string) => unknown;
      }
    ).getBuiltinModule;
    const builtin = getBuiltinModule?.call(process, specifier) as
      | { DatabaseSync?: SqliteModule["DatabaseSync"] }
      | undefined;
    sqliteModulePromise = builtin?.DatabaseSync
      ? Promise.resolve({ DatabaseSync: builtin.DatabaseSync })
      : import(specifier)
          .then((mod) => {
            const maybeModule = mod as {
              DatabaseSync?: SqliteModule["DatabaseSync"];
            };
            return maybeModule.DatabaseSync
              ? { DatabaseSync: maybeModule.DatabaseSync }
              : null;
          })
          .catch(() => null);
  }

  return sqliteModulePromise;
}

export async function withSqliteDatabase<T>(
  dbPath: string,
  fallback: T,
  callback: (db: SqliteDatabase) => T,
): Promise<T> {
  const result = await withSqliteDatabaseResult(dbPath, callback);
  return result.ok ? result.value : fallback;
}

/**
 * Open a SQLite database read-only while preserving the failure category.
 *
 * Most readers intentionally treat a missing/busy provider database as an
 * empty result. Long-running reconciliation jobs need to distinguish that
 * case from a successful scan with no rows, so they can leave their cursor in
 * place and retry on the next poll.
 */
export async function withSqliteDatabaseResult<T>(
  dbPath: string,
  callback: (db: SqliteDatabase) => T,
): Promise<SqliteResult<T>> {
  try {
    await access(dbPath);
  } catch (error) {
    return { ok: false, reason: "database-unavailable", error };
  }

  const sqlite = await loadSqliteModule();
  if (!sqlite) return { ok: false, reason: "sqlite-unavailable" };

  let db: SqliteDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return { ok: true, value: callback(db) };
  } catch (error) {
    return { ok: false, reason: "query-failed", error };
  } finally {
    try {
      db?.close();
    } catch {
      // The query/open failure above is the actionable diagnostic. Closing a
      // read-only handle must not turn reconciliation into an unhandled error.
    }
  }
}

export async function withWritableSqliteDatabase<T>(
  dbPath: string,
  fallback: T,
  callback: (db: SqliteDatabase) => T,
): Promise<T> {
  try {
    await access(dbPath);
  } catch {
    return fallback;
  }

  const sqlite = await loadSqliteModule();
  if (!sqlite) return fallback;

  let db: SqliteDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    return callback(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Hard cancellation deadline for a single SQLite statement batch. Exceeding
 * it restarts the query worker; the caller keeps its cursor and retries.
 */
export function getSqliteQueryTimeoutMs(): number {
  return parsePositiveInt(process.env.YEP_SQLITE_QUERY_TIMEOUT_MS, 30_000);
}

/** Soft budget. Exceeding it only emits `sqlite_db_query_budget_exceeded`. */
export function getSqliteQueryBudgetMs(): number {
  return parsePositiveInt(process.env.YEP_SQLITE_QUERY_BUDGET_MS, 500);
}

function isWorkerEnabled(): boolean {
  const raw = (process.env.YEP_SQLITE_QUERY_WORKER ?? "").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

export interface SqliteQueryOptions {
  /** Diagnostic label used for slow-query and timeout logging. */
  label: string;
  writable?: boolean;
  timeoutMs?: number;
  budgetMs?: number;
}

/**
 * Execute a batch of statements against a SQLite database off the API
 * thread.
 *
 * Callers pass whole batches rather than issuing one round trip per row so a
 * read that used to be an N+1 sync loop stays a small, bounded number of
 * messages. When the worker is unavailable (disabled by env, or thread
 * creation is forbidden) this transparently falls back to the previous inline
 * `DatabaseSync` behaviour so no read path hard-fails.
 */
export async function runSqliteStatements(
  dbPath: string,
  statements: readonly SqliteStatement[],
  options: SqliteQueryOptions,
): Promise<SqliteResult<unknown[]>> {
  try {
    await access(dbPath);
  } catch (error) {
    return { ok: false, reason: "database-unavailable", error };
  }
  if (statements.length === 0) return { ok: true, value: [] };

  const timeoutMs = options.timeoutMs ?? getSqliteQueryTimeoutMs();
  const budgetMs = options.budgetMs ?? getSqliteQueryBudgetMs();

  if (isWorkerEnabled()) {
    const pool = getSqliteWorkerPool();
    if (!pool.isDisabled()) {
      const result = await pool.run({
        dbPath,
        statements,
        label: options.label,
        timeoutMs,
        budgetMs,
        ...(options.writable === true ? { writable: true } : {}),
      });
      if (result.ok) return { ok: true, value: result.results };
      if (result.reason !== "worker-unavailable") {
        return {
          ok: false,
          reason:
            result.reason === "sqlite-unavailable"
              ? "sqlite-unavailable"
              : result.reason === "timeout"
                ? "query-timeout"
                : "query-failed",
          error: result.error,
        };
      }
      // `worker-unavailable` means the thread died or was never usable, not
      // that the query is invalid. Retry inline so a transient worker loss
      // degrades throughput instead of returning a spurious empty scan.
    }
  }

  return runSqliteStatementsInline(dbPath, statements, options);
}

async function runSqliteStatementsInline(
  dbPath: string,
  statements: readonly SqliteStatement[],
  options: SqliteQueryOptions,
): Promise<SqliteResult<unknown[]>> {
  const executor = (db: SqliteDatabase): unknown[] =>
    statements.map((statement) => {
      const prepared = db.prepare(statement.sql);
      const params = statement.params ? [...statement.params] : [];
      if (statement.mode === "get") return prepared.get(...params) ?? null;
      if (statement.mode === "run") {
        prepared.run(...params);
        return null;
      }
      return prepared.all(...params);
    });

  if (options.writable === true) {
    const sqlite = await loadSqliteModule();
    if (!sqlite) return { ok: false, reason: "sqlite-unavailable" };
    let db: SqliteDatabase | null = null;
    try {
      db = new sqlite.DatabaseSync(dbPath);
      return { ok: true, value: executor(db) };
    } catch (error) {
      return { ok: false, reason: "query-failed", error };
    } finally {
      try {
        db?.close();
      } catch {
        // Closing a handle must not mask the query outcome above.
      }
    }
  }

  return withSqliteDatabaseResult(dbPath, executor);
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Convenience wrapper for a single `all()` statement. */
export async function querySqliteRows(
  dbPath: string,
  sql: string,
  params: readonly unknown[],
  options: SqliteQueryOptions,
): Promise<SqliteResult<Record<string, unknown>[]>> {
  const result = await runSqliteStatements(dbPath, [{ sql, params }], options);
  return result.ok ? { ok: true, value: asRows(result.value[0]) } : result;
}

/** Convenience wrapper for a single `get()` statement. */
export async function querySqliteRow(
  dbPath: string,
  sql: string,
  params: readonly unknown[],
  options: SqliteQueryOptions,
): Promise<SqliteResult<Record<string, unknown> | null>> {
  const result = await runSqliteStatements(
    dbPath,
    [{ sql, params, mode: "get" }],
    options,
  );
  if (!result.ok) return result;
  const row = result.value[0];
  return {
    ok: true,
    value:
      row && typeof row === "object" ? (row as Record<string, unknown>) : null,
  };
}

/** Read rows, treating an unavailable/busy database as an empty result. */
export async function querySqliteRowsOrEmpty(
  dbPath: string,
  sql: string,
  params: readonly unknown[],
  options: SqliteQueryOptions,
): Promise<Record<string, unknown>[]> {
  const result = await querySqliteRows(dbPath, sql, params, options);
  return result.ok ? result.value : [];
}

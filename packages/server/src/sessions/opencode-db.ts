import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type OpenCodeDbStatement,
  getOpenCodeDbWorkerPool,
} from "./opencode-db-worker.js";

export type { OpenCodeDbStatement } from "./opencode-db-worker.js";

export const OPENCODE_DATA_DIR =
  process.env.OPENCODE_DATA_DIR ??
  join(homedir(), ".local", "share", "opencode");

export const OPENCODE_DB_PATH =
  process.env.OPENCODE_DB_PATH ?? join(OPENCODE_DATA_DIR, "opencode.db");

interface OpenCodeStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

export interface OpenCodeDatabase {
  prepare(sql: string): OpenCodeStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => OpenCodeDatabase;
}

export type OpenCodeDbFailureReason =
  | "database-unavailable"
  | "sqlite-unavailable"
  | "query-failed"
  /** Cancelled by the query deadline; the query itself may still be valid. */
  | "query-timeout";

export type OpenCodeDbResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: OpenCodeDbFailureReason;
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

export async function withOpenCodeDb<T>(
  dbPath: string,
  fallback: T,
  callback: (db: OpenCodeDatabase) => T,
): Promise<T> {
  const result = await withOpenCodeDbResult(dbPath, callback);
  return result.ok ? result.value : fallback;
}

/**
 * Open an OpenCode database read-only while preserving the failure category.
 *
 * Most readers intentionally treat a missing/busy OpenCode database as an
 * empty result. Long-running reconciliation jobs need to distinguish that
 * case from a successful scan with no rows, so they can leave their cursor in
 * place and retry on the next poll.
 */
export async function withOpenCodeDbResult<T>(
  dbPath: string,
  callback: (db: OpenCodeDatabase) => T,
): Promise<OpenCodeDbResult<T>> {
  try {
    await access(dbPath);
  } catch (error) {
    return { ok: false, reason: "database-unavailable", error };
  }

  const sqlite = await loadSqliteModule();
  if (!sqlite) return { ok: false, reason: "sqlite-unavailable" };

  let db: OpenCodeDatabase | null = null;
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

export async function withWritableOpenCodeDb<T>(
  dbPath: string,
  fallback: T,
  callback: (db: OpenCodeDatabase) => T,
): Promise<T> {
  try {
    await access(dbPath);
  } catch {
    return fallback;
  }

  const sqlite = await loadSqliteModule();
  if (!sqlite) return fallback;

  let db: OpenCodeDatabase | null = null;
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
 * Hard cancellation deadline for a single OpenCode statement batch. Exceeding
 * it restarts the query worker; the caller keeps its cursor and retries.
 */
export function getOpenCodeQueryTimeoutMs(): number {
  return parsePositiveInt(process.env.OPENCODE_DB_QUERY_TIMEOUT_MS, 30_000);
}

/** Soft budget. Exceeding it only emits `opencode_db_query_budget_exceeded`. */
export function getOpenCodeQueryBudgetMs(): number {
  return parsePositiveInt(process.env.OPENCODE_DB_QUERY_BUDGET_MS, 500);
}

function isWorkerEnabled(): boolean {
  const raw = (process.env.OPENCODE_DB_WORKER ?? "").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

export interface OpenCodeQueryOptions {
  /** Diagnostic label used for slow-query and timeout logging. */
  label: string;
  writable?: boolean;
  timeoutMs?: number;
  budgetMs?: number;
}

/**
 * Execute a batch of statements against an OpenCode database off the API
 * thread.
 *
 * Callers pass whole batches rather than issuing one round trip per row so a
 * read that used to be an N+1 sync loop stays a small, bounded number of
 * messages. When the worker is unavailable (disabled by env, or thread
 * creation is forbidden) this transparently falls back to the previous inline
 * `DatabaseSync` behaviour so no read path hard-fails.
 */
export async function runOpenCodeDbStatements(
  dbPath: string,
  statements: readonly OpenCodeDbStatement[],
  options: OpenCodeQueryOptions,
): Promise<OpenCodeDbResult<unknown[]>> {
  try {
    await access(dbPath);
  } catch (error) {
    return { ok: false, reason: "database-unavailable", error };
  }
  if (statements.length === 0) return { ok: true, value: [] };

  const timeoutMs = options.timeoutMs ?? getOpenCodeQueryTimeoutMs();
  const budgetMs = options.budgetMs ?? getOpenCodeQueryBudgetMs();

  if (isWorkerEnabled()) {
    const pool = getOpenCodeDbWorkerPool();
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

  return runOpenCodeDbStatementsInline(dbPath, statements, options);
}

async function runOpenCodeDbStatementsInline(
  dbPath: string,
  statements: readonly OpenCodeDbStatement[],
  options: OpenCodeQueryOptions,
): Promise<OpenCodeDbResult<unknown[]>> {
  const executor = (db: OpenCodeDatabase): unknown[] =>
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
    let db: OpenCodeDatabase | null = null;
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

  return withOpenCodeDbResult(dbPath, executor);
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Convenience wrapper for a single `all()` statement. */
export async function queryOpenCodeRows(
  dbPath: string,
  sql: string,
  params: readonly unknown[],
  options: OpenCodeQueryOptions,
): Promise<OpenCodeDbResult<Record<string, unknown>[]>> {
  const result = await runOpenCodeDbStatements(
    dbPath,
    [{ sql, params }],
    options,
  );
  return result.ok ? { ok: true, value: asRows(result.value[0]) } : result;
}

/** Convenience wrapper for a single `get()` statement. */
export async function queryOpenCodeRow(
  dbPath: string,
  sql: string,
  params: readonly unknown[],
  options: OpenCodeQueryOptions,
): Promise<OpenCodeDbResult<Record<string, unknown> | null>> {
  const result = await runOpenCodeDbStatements(
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
export async function queryOpenCodeRowsOrEmpty(
  dbPath: string,
  sql: string,
  params: readonly unknown[],
  options: OpenCodeQueryOptions,
): Promise<Record<string, unknown>[]> {
  const result = await queryOpenCodeRows(dbPath, sql, params, options);
  return result.ok ? result.value : [];
}

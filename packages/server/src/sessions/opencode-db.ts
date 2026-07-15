import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  | "query-failed";

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

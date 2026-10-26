/**
 * Read-only access to provider-owned SQLite databases (Cursor, MiniMax Code)
 * through Node's built-in `node:sqlite`.
 */
import { access } from "node:fs/promises";

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

type SqliteFailureReason =
  | "database-unavailable"
  | "sqlite-unavailable"
  | "query-failed";

type SqliteResult<T> =
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

/** Open a SQLite database read-only while preserving the failure category. */
async function withSqliteDatabaseResult<T>(
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
      // read-only handle must not turn a read into an unhandled error.
    }
  }
}

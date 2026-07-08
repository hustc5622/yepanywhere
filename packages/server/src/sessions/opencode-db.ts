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

let sqliteModulePromise: Promise<SqliteModule | null> | null = null;

async function loadSqliteModule(): Promise<SqliteModule | null> {
  if (!sqliteModulePromise) {
    const specifier: string = "node:sqlite";
    sqliteModulePromise = import(specifier)
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
  try {
    await access(dbPath);
  } catch {
    return fallback;
  }

  const sqlite = await loadSqliteModule();
  if (!sqlite) return fallback;

  let db: OpenCodeDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return callback(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

/**
 * Dedicated worker thread for provider SQLite queries.
 *
 * `node:sqlite`'s `DatabaseSync` is synchronous, so running large queries on
 * the API thread lets a single slow scan stall REST, WebSocket and heartbeat
 * timers. This module keeps the SQL text in normal TypeScript and ships only a
 * generic "execute these prepared statements" executor into the worker.
 *
 * The worker body is an eval'd source string rather than a separate entry file
 * on purpose: the server is compiled with plain `tsc`, but runs under `tsx` in
 * dev and under Vitest in tests. A file-based worker would need a different
 * specifier (and loader flags) in each of those three environments, while an
 * eval'd worker has no build coupling at all.
 */
import { Worker } from "node:worker_threads";
import { getLogger } from "../logging/logger.js";

export type SqliteStatementMode = "all" | "get" | "run";

export interface SqliteStatement {
  sql: string;
  params?: readonly unknown[];
  /** Defaults to `all`. */
  mode?: SqliteStatementMode;
}

export interface SqliteWorkerRequest {
  dbPath: string;
  statements: readonly SqliteStatement[];
  writable?: boolean;
  /** Diagnostic label used for slow-query logging. */
  label: string;
  /** Hard cancellation deadline. Exceeding it terminates the worker. */
  timeoutMs: number;
  /** Soft budget: exceeding it only emits a structured warning. */
  budgetMs: number;
}

export type SqliteWorkerFailure =
  | "sqlite-unavailable"
  | "query-failed"
  | "timeout"
  | "worker-unavailable";

export type SqliteWorkerResult =
  | { ok: true; results: unknown[]; durationMs: number }
  | {
      ok: false;
      reason: SqliteWorkerFailure;
      error?: unknown;
      durationMs: number;
    };

/**
 * Worker body. Written as an async IIFE using dynamic `import()` so it behaves
 * identically whether Node evaluates the eval'd source as ESM or CommonJS.
 *
 * Read-only handles are cached per database and closed after an idle period so
 * a multi-gigabyte database is not pinned open between polls.
 */
const WORKER_SOURCE = String.raw`
(async () => {
  const { parentPort } = await import("node:worker_threads");
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    DatabaseSync = null;
  }

  const IDLE_CLOSE_MS = 60000;
  const handles = new Map();
  let idleTimer = null;

  function closeAll() {
    for (const [key, handle] of handles) {
      try {
        handle.db.close();
      } catch {}
      handles.delete(key);
    }
  }

  function scheduleIdleClose() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeAll, IDLE_CLOSE_MS);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  }

  function getHandle(dbPath, writable) {
    const key = (writable ? "rw:" : "ro:") + dbPath;
    const existing = handles.get(key);
    if (existing) return existing.db;
    const db = writable
      ? new DatabaseSync(dbPath)
      : new DatabaseSync(dbPath, { readOnly: true });
    handles.set(key, { db });
    return db;
  }

  function dropHandle(dbPath, writable) {
    const key = (writable ? "rw:" : "ro:") + dbPath;
    const existing = handles.get(key);
    if (!existing) return;
    try {
      existing.db.close();
    } catch {}
    handles.delete(key);
  }

  parentPort.on("message", (request) => {
    const startedAt = Date.now();
    if (!DatabaseSync) {
      parentPort.postMessage({
        id: request.id,
        ok: false,
        reason: "sqlite-unavailable",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const writable = request.writable === true;
    try {
      const db = getHandle(request.dbPath, writable);
      const results = [];
      for (const statement of request.statements) {
        const prepared = db.prepare(statement.sql);
        const params = statement.params ?? [];
        if (statement.mode === "get") {
          const row = prepared.get(...params);
          results.push(row === undefined ? null : row);
        } else if (statement.mode === "run") {
          prepared.run(...params);
          results.push(null);
        } else {
          results.push(prepared.all(...params));
        }
      }
      parentPort.postMessage({
        id: request.id,
        ok: true,
        results,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      // A failed open or a schema change must not pin a broken handle for
      // every later request.
      dropHandle(request.dbPath, writable);
      parentPort.postMessage({
        id: request.id,
        ok: false,
        reason: "query-failed",
        message: String((error && error.message) || error),
        durationMs: Date.now() - startedAt,
      });
    } finally {
      scheduleIdleClose();
    }
  });
})();
`;

interface PendingRequest {
  resolve(result: SqliteWorkerResult): void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  label: string;
  budgetMs: number;
}

interface WorkerMessage {
  id: number;
  ok: boolean;
  results?: unknown[];
  reason?: SqliteWorkerFailure;
  message?: string;
  durationMs: number;
}

/**
 * Serialized single-worker pool.
 *
 * Provider reads are often dominated by one large shared database, so extra
 * workers would mostly contend on the same pages while multiplying memory.
 * Serializing also gives the timeout path a simple, correct cancellation
 * story: terminate the worker and respawn it.
 */
class SqliteWorkerPool {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private disabled = false;

  isDisabled(): boolean {
    return this.disabled;
  }

  private spawn(): Worker | null {
    if (this.worker) return this.worker;
    if (this.disabled) return null;
    try {
      const worker = new Worker(WORKER_SOURCE, { eval: true });
      worker.on("message", (message: WorkerMessage) => {
        this.settle(message);
      });
      worker.on("error", (error) => {
        this.failAll("query-failed", error);
        this.discardWorker(worker);
      });
      worker.on("exit", () => {
        this.failAll("worker-unavailable");
        this.discardWorker(worker);
      });
      // Idle query workers must never hold the process open. `syncRefState`
      // re-refs the worker while a request is in flight so a pending query
      // cannot be silently dropped by an otherwise-empty event loop.
      worker.unref();
      this.worker = worker;
      return worker;
    } catch (error) {
      // Some sandboxes forbid spawning threads. Fall back permanently rather
      // than retrying a spawn that cannot succeed.
      this.disabled = true;
      getLogger().warn(
        { err: error, event: "sqlite_db_worker_unavailable" },
        "[sqlite-db] Worker thread unavailable; falling back to inline queries",
      );
      return null;
    }
  }

  private discardWorker(worker: Worker): void {
    if (this.worker === worker) this.worker = null;
  }

  /**
   * Hold a process-keeping reference only while work is outstanding. Without
   * this an unref'd worker lets Node drain the event loop mid-query, leaving
   * the caller's promise permanently unsettled.
   */
  private syncRefState(): void {
    const worker = this.worker;
    if (!worker) return;
    if (this.pending.size > 0) worker.ref();
    else worker.unref();
  }

  private settle(message: WorkerMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    this.syncRefState();

    if (message.ok) {
      if (message.durationMs > pending.budgetMs) {
        getLogger().warn(
          {
            event: "sqlite_db_query_budget_exceeded",
            label: pending.label,
            durationMs: message.durationMs,
            budgetMs: pending.budgetMs,
          },
          "[sqlite-db] Query exceeded its budget",
        );
      }
      pending.resolve({
        ok: true,
        results: message.results ?? [],
        durationMs: message.durationMs,
      });
      return;
    }

    pending.resolve({
      ok: false,
      reason: message.reason ?? "query-failed",
      error: message.message,
      durationMs: message.durationMs,
    });
  }

  private failAll(reason: SqliteWorkerFailure, error?: unknown): void {
    if (this.pending.size === 0) return;
    const failures = [...this.pending.values()];
    this.pending.clear();
    this.syncRefState();
    for (const pending of failures) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        reason,
        error,
        durationMs: Date.now() - pending.startedAt,
      });
    }
  }

  async run(request: SqliteWorkerRequest): Promise<SqliteWorkerResult> {
    const worker = this.spawn();
    if (!worker) {
      return {
        ok: false,
        reason: "worker-unavailable",
        durationMs: 0,
      };
    }

    const id = this.nextRequestId++;
    const startedAt = Date.now();
    return new Promise<SqliteWorkerResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // DatabaseSync cannot be interrupted from another thread, so the only
        // real cancellation is to drop the worker running the statement. The
        // caller keeps its cursor and retries on the next poll.
        getLogger().warn(
          {
            event: "sqlite_db_query_timeout",
            label: request.label,
            timeoutMs: request.timeoutMs,
          },
          "[sqlite-db] Query timed out; restarting query worker",
        );
        this.failAll("worker-unavailable");
        const stale = this.worker;
        this.worker = null;
        void stale?.terminate().catch(() => {});
        resolve({
          ok: false,
          reason: "timeout",
          durationMs: Date.now() - startedAt,
        });
      }, request.timeoutMs);

      this.pending.set(id, {
        resolve,
        timer,
        startedAt,
        label: request.label,
        budgetMs: request.budgetMs,
      });
      this.syncRefState();
      worker.postMessage({
        id,
        dbPath: request.dbPath,
        writable: request.writable === true,
        statements: request.statements.map((statement) => ({
          sql: statement.sql,
          params: statement.params ? [...statement.params] : [],
          mode: statement.mode ?? "all",
        })),
      });
    });
  }

  async shutdown(): Promise<void> {
    this.failAll("worker-unavailable");
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => {});
  }
}

/**
 * Run a statement batch on a throwaway worker instead of the shared pool.
 *
 * Index DDL holds SQLite's write lock for as long as the build takes. Routing
 * it through the shared, serialized pool would stall every ordinary read for
 * that whole window, so long maintenance statements get their own thread.
 */
export async function runIsolatedSqliteStatements(
  request: SqliteWorkerRequest,
): Promise<SqliteWorkerResult> {
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true });
  } catch (error) {
    return { ok: false, reason: "worker-unavailable", error, durationMs: 0 };
  }

  const startedAt = Date.now();
  try {
    return await new Promise<SqliteWorkerResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          reason: "timeout",
          durationMs: Date.now() - startedAt,
        });
      }, request.timeoutMs);

      const finish = (result: SqliteWorkerResult) => {
        clearTimeout(timer);
        resolve(result);
      };

      worker.on("message", (message: WorkerMessage) => {
        finish(
          message.ok
            ? {
                ok: true,
                results: message.results ?? [],
                durationMs: message.durationMs,
              }
            : {
                ok: false,
                reason: message.reason ?? "query-failed",
                error: message.message,
                durationMs: message.durationMs,
              },
        );
      });
      worker.on("error", (error) => {
        finish({
          ok: false,
          reason: "query-failed",
          error,
          durationMs: Date.now() - startedAt,
        });
      });
      worker.on("exit", () => {
        finish({
          ok: false,
          reason: "worker-unavailable",
          durationMs: Date.now() - startedAt,
        });
      });

      worker.postMessage({
        id: 1,
        dbPath: request.dbPath,
        writable: request.writable === true,
        statements: request.statements.map((statement) => ({
          sql: statement.sql,
          params: statement.params ? [...statement.params] : [],
          mode: statement.mode ?? "all",
        })),
      });
    });
  } finally {
    await worker.terminate().catch(() => {});
  }
}

let pool: SqliteWorkerPool | null = null;

export function getSqliteWorkerPool(): SqliteWorkerPool {
  pool ??= new SqliteWorkerPool();
  return pool;
}

/** Terminate the shared worker. Primarily a test/shutdown hook. */
export async function shutdownSqliteWorker(): Promise<void> {
  const active = pool;
  pool = null;
  if (active) await active.shutdown();
}

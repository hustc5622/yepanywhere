import * as fs from "node:fs";
import { basename, dirname } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { canonicalizeProjectPath, encodeProjectId } from "../projects/paths.js";
import type {
  ZCodeSessionChange,
  ZCodeSessionChangeCursor,
  ZCodeSessionChangeScanResult,
} from "../projects/zcode-scanner.js";
import { ZCodeSessionScanError } from "../projects/zcode-scanner.js";
import type { EventBus, SessionUpdatedEvent } from "../watcher/EventBus.js";

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_PROCESSING_CONCURRENCY = 4;
const DEFAULT_MAX_BATCHES_PER_SCAN = 4;
const DEFAULT_FAILURE_LOG_INTERVAL_MS = 60_000;
const DEFAULT_STARTUP_OVERLAP_MS = 1_000;
const RECONCILE_TRIGGER = "zcode-db-reconcile";

export type ZCodeSessionChangeSource = "startup" | "fs-watch" | "poll";

export interface ZCodeSessionChangeScanner {
  scanSessionChanges(
    cursor: ZCodeSessionChangeCursor,
    limit: number,
  ): Promise<ZCodeSessionChangeScanResult>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ZCodeSessionChangeMonitorClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, delayMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export interface ZCodeSessionChangeFsWatcher {
  close(): void;
  on(event: "error", listener: (error: Error) => void): this;
  unref?(): void;
}

export type ZCodeSessionChangeWatchFactory = (
  directory: string,
  onChange: (filename: string | Buffer | null) => void,
) => ZCodeSessionChangeFsWatcher;

export interface ZCodeSessionChangeMonitorOptions {
  dbPath: string;
  scanner: ZCodeSessionChangeScanner;
  eventBus: Pick<EventBus, "emit">;
  debounceMs?: number;
  pollMs?: number;
  batchLimit?: number;
  processingConcurrency?: number;
  maxBatchesPerScan?: number;
  failureLogIntervalMs?: number;
  /** Small bounded overlap with startup backfill to close its snapshot race. */
  startupOverlapMs?: number;
  clock?: ZCodeSessionChangeMonitorClock;
  watchFactory?: ZCodeSessionChangeWatchFactory;
  /** Test/custom integration seam. Defaults to EventBus.emit. */
  emitEvent?: (event: SessionUpdatedEvent) => void | Promise<void>;
}

const SYSTEM_CLOCK: ZCodeSessionChangeMonitorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

const SYSTEM_WATCH_FACTORY: ZCodeSessionChangeWatchFactory = (
  directory,
  onChange,
) =>
  fs.watch(directory, { persistent: false }, (_eventType, filename) => {
    onChange(filename);
  });

function unrefTimer(timer: TimerHandle): void {
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}

function cursorEquals(
  left: ZCodeSessionChangeCursor,
  right: ZCodeSessionChangeCursor,
): boolean {
  return (
    left.updatedAt === right.updatedAt && left.sessionId === right.sessionId
  );
}

/**
 * Reconciles changes from ZCode's shared SQLite database into Yep's
 * provider-agnostic session event stream.
 *
 * Mirrors `OpenCodeSessionChangeMonitor`. The ZCode SQLite schema (session /
 * message / part tables with identical column names) allows the same hybrid
 * fs.watch + poll change-detection model.
 *
 * This monitor deliberately does not read messages or call a title model.
 * SessionTitleService remains the sole readiness check and AI title writer.
 */
export class ZCodeSessionChangeMonitor {
  private readonly dbPath: string;
  private readonly scanner: ZCodeSessionChangeScanner;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly batchLimit: number;
  private readonly processingConcurrency: number;
  private readonly maxBatchesPerScan: number;
  private readonly failureLogIntervalMs: number;
  private readonly startupOverlapMs: number;
  private readonly clock: ZCodeSessionChangeMonitorClock;
  private readonly watchFactory: ZCodeSessionChangeWatchFactory;
  private readonly emitEvent: (
    event: SessionUpdatedEvent,
  ) => void | Promise<void>;
  private readonly watchedFileNames: Set<string>;

  private cursor: ZCodeSessionChangeCursor = {
    updatedAt: 0,
    sessionId: "",
  };
  private watcher: ZCodeSessionChangeFsWatcher | null = null;
  private debounceTimer: TimerHandle | null = null;
  private pollTimer: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private pendingSource: ZCodeSessionChangeSource | null = null;
  private started = false;
  private lifecycleId = 0;
  private lastFailureKey: string | null = null;
  private lastFailureLogAt = 0;

  constructor(options: ZCodeSessionChangeMonitorOptions) {
    this.dbPath = options.dbPath;
    this.scanner = options.scanner;
    this.debounceMs = Math.max(10, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
    this.batchLimit = Math.max(
      1,
      Math.floor(options.batchLimit ?? DEFAULT_BATCH_LIMIT),
    );
    this.processingConcurrency = Math.min(
      32,
      Math.max(
        1,
        Math.floor(
          options.processingConcurrency ?? DEFAULT_PROCESSING_CONCURRENCY,
        ),
      ),
    );
    this.maxBatchesPerScan = Math.min(
      32,
      Math.max(
        1,
        Math.floor(options.maxBatchesPerScan ?? DEFAULT_MAX_BATCHES_PER_SCAN),
      ),
    );
    this.failureLogIntervalMs = Math.max(
      0,
      options.failureLogIntervalMs ?? DEFAULT_FAILURE_LOG_INTERVAL_MS,
    );
    this.startupOverlapMs = Math.min(
      60_000,
      Math.max(0, options.startupOverlapMs ?? DEFAULT_STARTUP_OVERLAP_MS),
    );
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.watchFactory = options.watchFactory ?? SYSTEM_WATCH_FACTORY;
    this.emitEvent =
      options.emitEvent ?? ((event) => options.eventBus.emit(event));

    const dbFileName = basename(this.dbPath);
    this.watchedFileNames = new Set([
      dbFileName,
      `${dbFileName}-wal`,
      `${dbFileName}-shm`,
    ]);
  }

  get isStarted(): boolean {
    return this.started;
  }

  get currentCursor(): ZCodeSessionChangeCursor {
    return { ...this.cursor };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const lifecycleId = ++this.lifecycleId;

    // Startup backfill owns older sessions. A small bounded overlap closes the
    // race between its snapshot and this subscription without turning monitor
    // startup into a historical table scan.
    this.cursor = {
      updatedAt: this.clock.now() - this.startupOverlapMs,
      sessionId: "",
    };
    this.attachWatcher();

    this.pollTimer = this.clock.setInterval(() => {
      this.requestScan("poll");
    }, this.pollMs);
    unrefTimer(this.pollTimer);

    getLogger().info(
      {
        trigger: RECONCILE_TRIGGER,
        source: "startup",
        dbPath: this.dbPath,
        cursor: this.cursor,
        batchLimit: this.batchLimit,
        processingConcurrency: this.processingConcurrency,
        maxBatchesPerScan: this.maxBatchesPerScan,
        pollMs: this.pollMs,
        debounceMs: this.debounceMs,
        startupOverlapMs: this.startupOverlapMs,
        lifecycleId,
      },
      "[ZCodeSessionChangeMonitor] Started",
    );
    this.requestScan("startup");
  }

  async stop(): Promise<void> {
    if (!this.started && !this.inFlight) return;
    this.started = false;
    this.lifecycleId += 1;
    this.pendingSource = null;

    if (this.debounceTimer) {
      this.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      this.clock.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (error) {
        getLogger().debug(
          { err: error, trigger: RECONCILE_TRIGGER },
          "[ZCodeSessionChangeMonitor] Failed to close fs watcher",
        );
      }
      this.watcher = null;
    }

    const activeScan = this.inFlight;
    if (activeScan) await activeScan;
    getLogger().info(
      { trigger: RECONCILE_TRIGGER },
      "[ZCodeSessionChangeMonitor] Stopped",
    );
  }

  /** Wait for all currently queued reconciliation work (primarily for tests). */
  async waitForIdle(): Promise<void> {
    while (this.inFlight || this.pendingSource) {
      const active = this.inFlight;
      if (active) await active;
      await Promise.resolve();
    }
  }

  private attachWatcher(): void {
    try {
      this.watcher = this.watchFactory(dirname(this.dbPath), (filename) => {
        if (filename !== null) {
          const changedFile = filename.toString();
          if (!this.watchedFileNames.has(changedFile)) return;
        }
        this.scheduleDebouncedScan();
      });
      this.watcher.on("error", (error) => {
        getLogger().warn(
          { err: error, trigger: RECONCILE_TRIGGER, dbPath: this.dbPath },
          "[ZCodeSessionChangeMonitor] fs watcher error; polling remains active",
        );
        this.scheduleDebouncedScan();
      });
      this.watcher.unref?.();
    } catch (error) {
      this.watcher = null;
      getLogger().warn(
        { err: error, trigger: RECONCILE_TRIGGER, dbPath: this.dbPath },
        "[ZCodeSessionChangeMonitor] Unable to start fs watcher; polling remains active",
      );
    }
  }

  private scheduleDebouncedScan(): void {
    if (!this.started) return;
    if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      this.requestScan("fs-watch");
    }, this.debounceMs);
    unrefTimer(this.debounceTimer);
  }

  private requestScan(source: ZCodeSessionChangeSource): void {
    if (!this.started) return;
    if (this.inFlight) {
      // A single queued follow-up is enough: the stable cursor reconciles all
      // rows committed before that follow-up begins.
      if (this.pendingSource !== "fs-watch") this.pendingSource = source;
      return;
    }

    const lifecycleId = this.lifecycleId;
    const scan = this.runScan(source, lifecycleId);
    this.inFlight = scan;
    const finalize = () => {
      if (this.inFlight === scan) this.inFlight = null;
      if (!this.started || lifecycleId !== this.lifecycleId) {
        this.pendingSource = null;
        return;
      }
      const pending = this.pendingSource;
      this.pendingSource = null;
      if (pending) this.requestScan(pending);
    };
    void scan.then(finalize, (error) => {
      // runScan handles expected database/emitter failures. Keep this terminal
      // rejection handler so an unexpected bug cannot surface as an unhandled
      // rejection from a background watcher callback.
      try {
        this.logScanFailure(
          error,
          source,
          { ...this.cursor },
          this.clock.now(),
        );
      } finally {
        finalize();
      }
    });
  }

  private async runScan(
    source: ZCodeSessionChangeSource,
    lifecycleId: number,
  ): Promise<void> {
    for (let batch = 1; batch <= this.maxBatchesPerScan; batch += 1) {
      const startedAt = this.clock.now();
      const cursorBefore = { ...this.cursor };
      let result: ZCodeSessionChangeScanResult;
      try {
        result = await this.scanner.scanSessionChanges(
          cursorBefore,
          this.batchLimit,
        );
      } catch (error) {
        this.logScanFailure(error, source, cursorBefore, startedAt);
        return;
      }

      if (!this.started || lifecycleId !== this.lifecycleId) return;

      try {
        await this.processChanges(result.changes, lifecycleId);
      } catch (error) {
        this.logScanFailure(error, source, cursorBefore, startedAt);
        return;
      }
      if (!this.started || lifecycleId !== this.lifecycleId) return;

      this.cursor = result.nextCursor;
      this.lastFailureKey = null;
      const logData = {
        trigger: RECONCILE_TRIGGER,
        source,
        cursor: cursorBefore,
        nextCursor: result.nextCursor,
        scannedRows: result.scannedRows,
        selectedSessions: result.changes.length,
        skipped: result.skipped,
        batch,
        batchLimit: this.batchLimit,
        processingConcurrency: this.processingConcurrency,
        hasMore: result.hasMore,
        durationMs: this.clock.now() - startedAt,
      };
      const log = getLogger();
      if (source === "startup" || result.scannedRows > 0 || result.hasMore) {
        log.info(logData, "[ZCodeSessionChangeMonitor] Scan completed");
      } else {
        log.debug(logData, "[ZCodeSessionChangeMonitor] Scan completed");
      }

      if (!result.hasMore) return;
      if (cursorEquals(cursorBefore, result.nextCursor)) {
        getLogger().warn(
          logData,
          "[ZCodeSessionChangeMonitor] Scan made no cursor progress; waiting for next poll",
        );
        return;
      }
      if (batch === this.maxBatchesPerScan) {
        this.pendingSource = source;
      }
    }
  }

  private async processChanges(
    changes: ZCodeSessionChange[],
    lifecycleId: number,
  ): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(this.processingConcurrency, changes.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (this.started && lifecycleId === this.lifecycleId) {
          const index = nextIndex;
          nextIndex += 1;
          const change = changes[index];
          if (!change) return;
          const projectPath = canonicalizeProjectPath(change.directory);
          const projectId = encodeProjectId(projectPath) as UrlProjectId;
          await this.emitEvent({
            type: "session-updated",
            trigger: RECONCILE_TRIGGER,
            sessionId: change.sessionId,
            projectId,
            updatedAt: new Date(change.updatedAt).toISOString(),
            timestamp: new Date(this.clock.now()).toISOString(),
          });
        }
      }),
    );
  }

  private logScanFailure(
    error: unknown,
    source: ZCodeSessionChangeSource,
    cursor: ZCodeSessionChangeCursor,
    startedAt: number,
  ): void {
    const reason =
      error instanceof ZCodeSessionScanError
        ? error.reason
        : "reconcile-failed";
    const logError =
      error instanceof ZCodeSessionScanError ? error.detail : error;
    const failureKey = String(reason);
    const now = this.clock.now();
    const shouldWarn =
      failureKey !== this.lastFailureKey ||
      now - this.lastFailureLogAt >= this.failureLogIntervalMs;
    const data = {
      err: logError,
      trigger: RECONCILE_TRIGGER,
      source,
      reason,
      cursor,
      batchLimit: this.batchLimit,
      durationMs: now - startedAt,
    };
    if (shouldWarn) {
      getLogger().warn(
        data,
        "[ZCodeSessionChangeMonitor] Scan failed; cursor retained for a later poll",
      );
      this.lastFailureKey = failureKey;
      this.lastFailureLogAt = now;
    } else {
      getLogger().debug(
        data,
        "[ZCodeSessionChangeMonitor] Repeated scan failure; cursor retained",
      );
    }
  }
}

/**
 * SessionIndexService caches session summaries to avoid re-parsing session files.
 * Uses mtime/size for cache invalidation - only re-parses when files change.
 *
 * State is persisted to JSON files for durability across server restarts.
 * Each project's session directory gets its own index file.
 *
 * Supports any provider whose reader implements ISessionReader. For providers
 * where session IDs can't be derived from filenames (e.g., Gemini), the reader
 * must implement the optional `listSessionFiles()` method.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type ContextCompactEvent,
  type ContextCumulativeUsage,
  DEFAULT_PROVIDER,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { ISessionReader, SessionFileEntry } from "../sessions/types.js";
import type { SessionSummary } from "../supervisor/types.js";
import type { EventBus, FileChangeEvent } from "../watcher/index.js";
import type {
  GetSessionsWithCacheOptions,
  ISessionIndexService,
} from "./types.js";

const logger = getLogger();
const LOG_CACHE_PERF = process.env.SESSION_INDEX_LOG_PERF === "true";
const FULL_VALIDATION_STAT_CONCURRENCY = 512;

export interface CachedSessionSummary {
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userQuestions?: SessionSummary["userQuestions"];
  contextUsage?: { inputTokens: number; percentage: number };
  cumulativeUsage?: ContextCumulativeUsage;
  compactCount?: number;
  compactEvents?: ContextCompactEvent[];
  /** File size in bytes at time of indexing */
  indexedBytes: number;
  /** File mtime in milliseconds since epoch at time of indexing */
  fileMtime: number;
  /** True if session has no user/assistant messages (metadata-only file) */
  isEmpty?: boolean;
  /** AI provider for this session */
  provider: ProviderName;
  /** Model used for this session (e.g. "gemini-2.5-pro") */
  model?: string;
  /** Provider-specific reasoning effort (e.g. Claude "max", Codex "xhigh") */
  reasoningEffort?: string;
  /** Provider-specific service tier / speed label (e.g. "fast") */
  serviceTier?: string;
  /** Launcher identifier from provider metadata (e.g. "Codex Desktop") */
  originator?: string;
  /** Session source from provider metadata (e.g. "appServer", "exec") */
  source?: string;
  /** Explicit creation owner recorded in summary metadata when available. */
  createdBy?: SessionSummary["createdBy"];
  /**
   * For OpenCode edit-fork children, the id of the session this one was forked
   * from. Cached so the session list can collapse an edit-fork family into a
   * single entry without re-reading provider metadata.
   */
  forkParentSessionId?: string;
  /**
   * True when the active branch ends on an unanswered user message or a
   * mid-stream assistant message — the last turn was interrupted (e.g. by a
   * server restart) and the session can be resumed.
   */
  interrupted?: boolean;
}

export interface SessionIndexState {
  // v11 anchors Codex message/question ids to entry byte offsets instead of a
  // running counter, so cached `userQuestions[].id` values from v10 no longer
  // match the ids the reader now produces. The strict equality check below
  // discards the old index and rebuilds it.
  version: 11;
  projectId: string;
  sessions: Record<string, CachedSessionSummary>;
}

const CURRENT_VERSION = 11;

interface SessionFileStat {
  mtimeMs: number;
  size: number;
}

export interface SessionIndexServiceOptions {
  /** Directory to store index files (defaults to ~/.yep-anywhere/indexes) */
  dataDir?: string;
  /** Claude projects directory (defaults to ~/.claude/projects) */
  projectsDir?: string;
  /** Max number of projects to keep in memory cache (default: 100) */
  maxCacheSize?: number;
  /**
   * Interval in ms between full directory validations.
   * 0 disables fast-path and validates every request.
   */
  fullValidationIntervalMs?: number;
  /**
   * Floor on how often one scope may run a full validation, applied even when a
   * dirty-directory signal is pending.
   *
   * Watcher events for every provider except Claude cannot say which project
   * scope owns the changed file, so they mark *all* of that provider's scopes
   * dirty (see `handleFileChange`). With a shared backing store — OpenCode's
   * single sqlite file across 43 projects, for example — one write therefore
   * queued one full validation per scope, each a full store scan. Measured on a
   * live server that reached 29 full validations per second at 250–800 ms each,
   * which saturated the event loop and pushed unrelated 15 ms session reads to
   * 3–11 s. A dirty directory still forces a full pass; it just cannot do so
   * more often than this.
   */
  fullValidationMinIntervalMs?: number;
  /** Max number of full validations allowed to run at once, across all scopes. */
  maxConcurrentFullValidations?: number;
  /**
   * A scope whose last full validation took at most this long skips the
   * concurrency queue entirely.
   *
   * Serializing full validations removed the concurrency storm but replaced it
   * with head-of-line blocking, and the measured cost distribution makes that a
   * bad trade: on a live server the actual scan work has a p50 of 20 ms while
   * queue waits reached 8291 ms, including a scope that waited 8.3 s to perform
   * 40 ms of work behind one 5 s Kimi scan. The queue exists to keep several
   * heavy scans off the event loop at once; cheap scans never needed it. A scope
   * with no history still queues, because its cost is unknown.
   *
   * 0 disables the bypass and makes every full validation queue.
   */
  fullValidationFastPathMs?: number;
  /**
   * Upper bound on how long a full validation waits for a slot before running
   * anyway.
   *
   * Full validation happens on the request path, so an unbounded wait is an
   * unbounded user-visible delay. This keeps the concurrency cap as a shaping
   * mechanism rather than a hard gate: a stampede is still spread out, but no
   * single request is starved behind it.
   *
   * 0 disables the cap and waits indefinitely.
   */
  fullValidationMaxQueueWaitMs?: number;
  /** Optional event bus for watcher-driven invalidation. */
  eventBus?: EventBus;
  /** Max time to wait for cross-process write lock (ms). */
  writeLockTimeoutMs?: number;
  /** Age at which lock directories are treated as stale and removed (ms). */
  writeLockStaleMs?: number;
}

/**
 * Claude-specific session index service.
 *
 * Caches session summaries for Claude Code JSONL files to avoid
 * re-parsing on every request. Currently works with Claude's
 * ~/.claude/projects/ directory structure.
 */
export class SessionIndexService implements ISessionIndexService {
  private dataDir: string;
  private projectsDir: string;
  private indexCache: Map<string, SessionIndexState> = new Map();
  private savePromises: Map<string, Promise<void>> = new Map();
  private pendingSaves: Set<string> = new Set();
  private maxCacheSize: number;
  private fullValidationIntervalMs: number;
  private fullValidationMinIntervalMs: number;
  private maxConcurrentFullValidations: number;
  private fullValidationFastPathMs: number;
  private fullValidationMaxQueueWaitMs: number;
  private activeFullValidations = 0;
  private fullValidationWaiters: Array<() => void> = [];
  /** Last observed scan cost per scope, used for queue-bypass admission. */
  private lastFullValidationDurationMs: Map<string, number> = new Map();
  private writeLockTimeoutMs: number;
  private writeLockStaleMs: number;
  private lastFullValidationAt: Map<string, number> = new Map();
  private dirtyDirs: Set<string> = new Set();
  private dirtySessionsByDir: Map<string, Set<string>> = new Map();
  private inFlightSessionLoads: Map<string, Promise<SessionSummary[]>> =
    new Map();
  private inFlightTitleLoads: Map<string, Promise<string | null>> = new Map();
  private inFlightSummaryLoads: Map<string, Promise<SessionSummary | null>> =
    new Map();
  private cacheStats = {
    requests: 0,
    fastHits: 0,
    incrementalRuns: 0,
    fullScans: 0,
    statCalls: 0,
    parseCalls: 0,
    totalDurationMs: 0,
    /**
     * Time full validations spent queued for a concurrency slot.
     *
     * Tracked apart from `totalDurationMs` because serializing full validations
     * moved wall time out of the work and into the queue: without the split, the
     * fix for the pile-up reads as a regression in per-call duration.
     */
    fullValidationQueueWaitMs: 0,
    /**
     * Full validations that skipped the queue: either a historically cheap scope
     * or a wait that hit its cap. A high share against `fullScans` means the cap
     * is shaping little and can be revisited.
     */
    fullValidationQueueBypasses: 0,
  };
  private unsubscribeEventBus: (() => void) | null = null;

  constructor(options: SessionIndexServiceOptions = {}) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    this.dataDir =
      options.dataDir ?? path.join(home, ".yep-anywhere", "indexes");
    this.projectsDir =
      options.projectsDir ?? path.join(home, ".claude", "projects");
    this.maxCacheSize = options.maxCacheSize ?? 10000;
    this.fullValidationIntervalMs = Math.max(
      0,
      options.fullValidationIntervalMs ?? 0,
    );
    this.fullValidationMinIntervalMs = Math.max(
      0,
      options.fullValidationMinIntervalMs ?? 0,
    );
    this.maxConcurrentFullValidations = Math.max(
      1,
      options.maxConcurrentFullValidations ?? 1,
    );
    this.fullValidationFastPathMs = Math.max(
      0,
      options.fullValidationFastPathMs ?? 50,
    );
    this.fullValidationMaxQueueWaitMs = Math.max(
      0,
      options.fullValidationMaxQueueWaitMs ?? 1_000,
    );
    this.writeLockTimeoutMs = Math.max(0, options.writeLockTimeoutMs ?? 2000);
    this.writeLockStaleMs = Math.max(1000, options.writeLockStaleMs ?? 10000);

    if (options.eventBus) {
      this.unsubscribeEventBus = options.eventBus.subscribe((event) => {
        if (event.type !== "file-change") return;
        this.handleFileChange(event);
      });
    }
  }

  private getScopeKey(sessionDir: string, reader?: ISessionReader): string {
    return reader?.getIndexScopeKey?.(sessionDir) ?? sessionDir;
  }

  private async getSessionFileStats(
    reader: ISessionReader,
    sessionId: string,
    filePath: string,
  ): Promise<SessionFileStat> {
    const readerStats = await reader.getSessionFileStats?.(sessionId);
    if (readerStats) {
      return { mtimeMs: readerStats.mtime, size: readerStats.size };
    }

    const stats = await fs.stat(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  }

  /**
   * Evict oldest entries if cache exceeds max size.
   * Simple FIFO eviction since Map maintains insertion order.
   */
  private evictIfNeeded(): void {
    while (this.indexCache.size > this.maxCacheSize) {
      const firstKey = this.indexCache.keys().next().value;
      if (firstKey) {
        this.indexCache.delete(firstKey);
        logger.debug(
          `[SessionIndexService] Evicted cache entry for ${firstKey} (cache size: ${this.indexCache.size})`,
        );
      } else {
        break;
      }
    }
  }

  /**
   * Initialize the service by ensuring the data directory exists.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  /**
   * Get the index file path for a session directory.
   * For paths inside projectsDir, encodes the relative path with %2F for slashes.
   * For external paths (e.g., Gemini's ~/.gemini/tmp/), uses a hash-based name.
   */
  getIndexPath(sessionDir: string, reader?: ISessionReader): string {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    if (scopeKey !== sessionDir || !path.isAbsolute(scopeKey)) {
      const hash = createHash("sha256")
        .update(scopeKey)
        .digest("hex")
        .slice(0, 16);
      return path.join(this.dataDir, `ext-${hash}.json`);
    }

    const relative = path.relative(this.projectsDir, scopeKey);
    if (relative.startsWith("..")) {
      // Path is outside projectsDir or a logical reader scope — hash it
      const hash = createHash("sha256")
        .update(scopeKey)
        .digest("hex")
        .slice(0, 16);
      return path.join(this.dataDir, `ext-${hash}.json`);
    }
    const encoded = relative.replace(/[/\\]/g, "%2F");
    return path.join(this.dataDir, `${encoded}.json`);
  }

  /**
   * Load index from disk or create a new one.
   */
  private async loadIndex(
    sessionDir: string,
    projectId: UrlProjectId,
    reader?: ISessionReader,
  ): Promise<SessionIndexState> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const indexPath = this.getIndexPath(sessionDir, reader);
    const cacheKey = scopeKey;

    // Check memory cache first
    const cached = this.indexCache.get(cacheKey);
    if (cached) {
      /*
      logger.debug(
        `[SessionIndexService] Memory cache hit for project (${Object.keys(cached.sessions).length} sessions)`,
      );
      */
      return cached;
    }
    /*
    logger.debug(
      `[SessionIndexService] Memory cache miss, loading from disk: ${indexPath}`,
    );
    */

    try {
      const content = await fs.readFile(indexPath, "utf-8");
      const parsed = JSON.parse(content) as SessionIndexState;

      // Validate version and projectId
      if (
        parsed.version === CURRENT_VERSION &&
        parsed.projectId === projectId
      ) {
        this.indexCache.set(cacheKey, parsed);
        this.evictIfNeeded();
        return parsed;
      }

      // Version mismatch or different project - start fresh
      const fresh: SessionIndexState = {
        version: CURRENT_VERSION,
        projectId,
        sessions: {},
      };
      this.indexCache.set(cacheKey, fresh);
      this.evictIfNeeded();
      return fresh;
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          { err: error },
          `[SessionIndexService] Failed to load index for ${scopeKey}, starting fresh`,
        );
      }
      const fresh: SessionIndexState = {
        version: CURRENT_VERSION,
        projectId,
        sessions: {},
      };
      this.indexCache.set(cacheKey, fresh);
      this.evictIfNeeded();
      return fresh;
    }
  }

  /**
   * Save index to disk with debouncing to prevent excessive writes.
   */
  private async saveIndex(
    sessionDir: string,
    reader?: ISessionReader,
  ): Promise<void> {
    const cacheKey = this.getScopeKey(sessionDir, reader);

    // If a save is in progress, mark that we need another save
    if (this.savePromises.has(cacheKey)) {
      this.pendingSaves.add(cacheKey);
      return;
    }

    const promise = this.doSaveIndex(sessionDir, reader);
    this.savePromises.set(cacheKey, promise);

    try {
      await promise;
    } finally {
      this.savePromises.delete(cacheKey);
    }

    // If another save was requested while we were saving, do it now
    if (this.pendingSaves.has(cacheKey)) {
      this.pendingSaves.delete(cacheKey);
      await this.saveIndex(sessionDir, reader);
    }
  }

  private async doSaveIndex(
    sessionDir: string,
    reader?: ISessionReader,
  ): Promise<void> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const index = this.indexCache.get(scopeKey);
    if (!index) return;

    const indexPath = this.getIndexPath(sessionDir, reader);
    const lockPath = `${indexPath}.lock`;
    const tempPath = `${indexPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await this.withWriteLock(lockPath, async () => {
        const content = JSON.stringify(index);
        await fs.writeFile(tempPath, content, "utf-8");
        await fs.rename(tempPath, indexPath);
      });
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {
        // Best-effort cleanup for failed atomic writes.
      });
      logger.error(
        { err: error },
        `[SessionIndexService] Failed to save index for ${scopeKey}`,
      );
      throw error;
    }
  }

  private async withWriteLock<T>(
    lockPath: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    await this.acquireWriteLock(lockPath);
    try {
      return await callback();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {
        // Best-effort lock cleanup.
      });
    }
  }

  private async acquireWriteLock(lockPath: string): Promise<void> {
    const start = Date.now();
    while (true) {
      try {
        await fs.mkdir(lockPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }

        const stale = await this.isLockStale(lockPath);
        if (stale) {
          await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {
            // Best-effort stale lock cleanup.
          });
          continue;
        }

        if (Date.now() - start >= this.writeLockTimeoutMs) {
          throw new Error(
            `Timed out acquiring session index write lock: ${lockPath}`,
          );
        }

        await this.sleep(25);
      }
    }
  }

  private async isLockStale(lockPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(lockPath);
      return Date.now() - stats.mtimeMs > this.writeLockStaleMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getScopedLoadKey(
    sessionDir: string,
    projectId: UrlProjectId,
    reader?: ISessionReader,
  ): string {
    return `${this.getScopeKey(sessionDir, reader)}::${projectId}`;
  }

  private getTitleLoadKey(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader?: ISessionReader,
  ): string {
    return `${this.getScopeKey(sessionDir, reader)}::${projectId}::${sessionId}`;
  }

  private markSessionDirty(
    sessionDir: string,
    sessionId: string,
    reader?: ISessionReader,
  ): void {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const current = this.dirtySessionsByDir.get(scopeKey) ?? new Set();
    current.add(sessionId);
    this.dirtySessionsByDir.set(scopeKey, current);
  }

  private markDirDirty(sessionDir: string, reader?: ISessionReader): void {
    this.dirtyDirs.add(this.getScopeKey(sessionDir, reader));
  }

  private clearDirDirtyState(
    sessionDir: string,
    reader?: ISessionReader,
  ): void {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    this.dirtyDirs.delete(scopeKey);
    this.dirtySessionsByDir.delete(scopeKey);
  }

  private markMatchingScopesDirty(prefix: string): void {
    const knownScopeKeys = new Set<string>([
      ...this.indexCache.keys(),
      ...this.lastFullValidationAt.keys(),
      ...this.dirtyDirs.values(),
      ...this.dirtySessionsByDir.keys(),
    ]);

    for (const scopeKey of knownScopeKeys) {
      if (scopeKey.startsWith(prefix)) {
        this.dirtyDirs.add(scopeKey);
      }
    }
  }

  private buildSummariesFromIndex(
    index: SessionIndexState,
    projectId: UrlProjectId,
  ): SessionSummary[] {
    const summaries: SessionSummary[] = [];

    for (const [sessionId, cached] of Object.entries(index.sessions)) {
      if (cached.isEmpty) continue;
      summaries.push(this.cachedToSummary(sessionId, cached, projectId));
    }

    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  /** Reconstruct a full SessionSummary from a single cached index entry. */
  private cachedToSummary(
    sessionId: string,
    cached: CachedSessionSummary,
    projectId: UrlProjectId,
  ): SessionSummary {
    return {
      id: sessionId,
      projectId,
      title: cached.title,
      fullTitle: cached.fullTitle,
      createdAt: cached.createdAt,
      updatedAt: cached.updatedAt,
      messageCount: cached.messageCount,
      userQuestions: cached.userQuestions,
      ownership: { owner: "none" },
      contextUsage: cached.contextUsage,
      cumulativeUsage: cached.cumulativeUsage,
      compactCount: cached.compactCount,
      compactEvents: cached.compactEvents,
      provider: cached.provider ?? DEFAULT_PROVIDER,
      model: cached.model,
      reasoningEffort: cached.reasoningEffort,
      serviceTier: cached.serviceTier,
      originator: cached.originator,
      source: cached.source,
      createdBy: cached.createdBy,
      interrupted: cached.interrupted,
      ...(cached.forkParentSessionId
        ? { forkParentSessionId: cached.forkParentSessionId }
        : {}),
    };
  }

  private toCachedSummary(
    summary: SessionSummary,
    mtime: number,
    size: number,
  ): CachedSessionSummary {
    return {
      title: summary.title,
      fullTitle: summary.fullTitle,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      messageCount: summary.messageCount,
      userQuestions: summary.userQuestions,
      contextUsage: summary.contextUsage,
      cumulativeUsage: summary.cumulativeUsage,
      compactCount: summary.compactCount,
      compactEvents: summary.compactEvents,
      indexedBytes: size,
      fileMtime: mtime,
      provider: summary.provider,
      model: summary.model,
      reasoningEffort: summary.reasoningEffort,
      serviceTier: summary.serviceTier,
      originator: summary.originator,
      source: summary.source,
      createdBy: summary.createdBy,
      interrupted: summary.interrupted,
      forkParentSessionId: summary.forkParentSessionId,
    };
  }

  private toEmptyCachedSummary(
    mtime: number,
    size: number,
  ): CachedSessionSummary {
    const now = new Date().toISOString();
    return {
      title: null,
      fullTitle: null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      indexedBytes: size,
      fileMtime: mtime,
      isEmpty: true,
      provider: DEFAULT_PROVIDER,
    };
  }

  /**
   * Record one cache-path outcome.
   *
   * `durationMs` is the request's own work. `queueWaitMs` is time spent waiting
   * for a full-validation slot and is deliberately excluded from it, because
   * conflating the two makes serialization look like slowness: a scope that
   * waited 20 s for another scope's scan and then worked for 380 ms is not a
   * 20.4 s scan, and reading it as one hides both the real per-scan cost and the
   * real contention.
   *
   * `scopeKey` is logged next to `dir` because throttling and slot admission are
   * keyed by scope, while many scopes share one directory. Without it, log lines
   * for the same directory look like a broken throttle when they are simply
   * different scopes.
   */
  private recordCallStats(
    mode: "fast" | "incremental" | "full",
    durationMs: number,
    statCalls: number,
    parseCalls: number,
    sessionDir: string,
    scopeKey: string,
    queueWaitMs = 0,
    bypassedQueue = false,
  ): void {
    this.cacheStats.requests += 1;
    this.cacheStats.statCalls += statCalls;
    this.cacheStats.parseCalls += parseCalls;
    this.cacheStats.totalDurationMs += durationMs;
    this.cacheStats.fullValidationQueueWaitMs += queueWaitMs;

    if (mode === "fast") this.cacheStats.fastHits += 1;
    if (mode === "incremental") this.cacheStats.incrementalRuns += 1;
    if (mode === "full") this.cacheStats.fullScans += 1;
    if (bypassedQueue) this.cacheStats.fullValidationQueueBypasses += 1;

    if (LOG_CACHE_PERF || durationMs >= 250 || queueWaitMs >= 250) {
      logger.info(
        `[SessionIndexService] mode=${mode} dir=${sessionDir} scope=${scopeKey} durationMs=${durationMs} queueWaitMs=${queueWaitMs}${bypassedQueue ? " queueBypassed=1" : ""} statCalls=${statCalls} parseCalls=${parseCalls}`,
      );
    }
  }

  /**
   * Handle watcher events so requests can avoid unnecessary full rescans while
   * still invalidating provider-specific indexes correctly.
   */
  private handleFileChange(event: FileChangeEvent): void {
    if (event.fileType !== "session") {
      return;
    }

    if (event.provider === "claude") {
      const fileName = path.basename(event.path);
      if (!fileName.endsWith(".jsonl")) return;
      const sessionId = fileName.slice(0, -6);
      const sessionDir = path.dirname(event.path);

      this.markSessionDirty(sessionDir, sessionId);

      // Directory creates/deletes require full readdir reconciliation.
      if (event.changeType === "create" || event.changeType === "delete") {
        this.markDirDirty(sessionDir);
      }
      return;
    }

    if (event.provider === "codex") {
      // Codex indexes are project-scoped over a shared sessions tree
      // (codex::<sessionsDir>::<projectPath>), so a raw file event does not
      // tell us which project scope owns the changed session. Mark all loaded
      // Codex scopes dirty and let the next request reconcile via listSessionFiles.
      this.markMatchingScopesDirty("codex::");
      return;
    }

    if (event.provider === "gemini") {
      // Gemini uses the same shared-tree + project-scoped index pattern.
      this.markMatchingScopesDirty("gemini::");
      return;
    }

    if (event.provider === "pi") {
      // Pi sessions share one native tree and are filtered by header cwd.
      this.markMatchingScopesDirty("pi::");
      return;
    }

    if (event.provider === "kimi") {
      // Kimi sessions also share one tree and are filtered by state.json cwd.
      this.markMatchingScopesDirty("kimi::");
      return;
    }

    if (event.provider === "opencode") {
      // OpenCode sqlite indexes are also project-scoped over one shared DB.
      this.markMatchingScopesDirty("opencode::");
    }
  }

  private async applyIncrementalDirtyUpdates(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    index: SessionIndexState,
  ): Promise<{ indexChanged: boolean; statCalls: number; parseCalls: number }> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const dirty = this.dirtySessionsByDir.get(scopeKey);
    if (!dirty || dirty.size === 0) {
      return { indexChanged: false, statCalls: 0, parseCalls: 0 };
    }

    let indexChanged = false;
    let statCalls = 0;
    let parseCalls = 0;

    for (const sessionId of Array.from(dirty)) {
      const cached = index.sessions[sessionId];

      if (cached) {
        statCalls += 1;
        const changed = await reader.getSessionSummaryIfChanged(
          sessionId,
          projectId,
          cached.fileMtime,
          cached.indexedBytes,
        );
        if (!changed) continue;
        parseCalls += 1;
        index.sessions[sessionId] = this.toCachedSummary(
          changed.summary,
          changed.mtime,
          changed.size,
        );
        indexChanged = true;
        continue;
      }

      parseCalls += 1;
      const summary = await reader.getSessionSummary(sessionId, projectId);
      const filePath =
        (await reader.getSessionFilePath?.(sessionId)) ??
        path.join(sessionDir, `${sessionId}.jsonl`);

      if (summary) {
        try {
          const stats = await this.getSessionFileStats(
            reader,
            sessionId,
            filePath,
          );
          statCalls += 1;
          index.sessions[sessionId] = this.toCachedSummary(
            summary,
            stats.mtimeMs,
            stats.size,
          );
          indexChanged = true;
        } catch {
          // Ignore race where file disappeared after read.
        }
        continue;
      }

      try {
        const stats = await this.getSessionFileStats(
          reader,
          sessionId,
          filePath,
        );
        statCalls += 1;
        index.sessions[sessionId] = this.toEmptyCachedSummary(
          stats.mtimeMs,
          stats.size,
        );
        indexChanged = true;
      } catch {
        if (index.sessions[sessionId]) {
          delete index.sessions[sessionId];
          indexChanged = true;
        }
      }
    }

    this.dirtySessionsByDir.delete(scopeKey);
    return { indexChanged, statCalls, parseCalls };
  }

  private async runFullValidation(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    index: SessionIndexState,
  ): Promise<{
    summaries: SessionSummary[];
    statCalls: number;
    parseCalls: number;
  }> {
    const summaries: SessionSummary[] = [];
    const seenSessionIds = new Set<string>();
    let indexChanged = false;
    let statCalls = 0;
    let parseCalls = 0;

    try {
      // Enumerate session files — delegate to reader if it supports custom
      // enumeration (e.g., Gemini JSON where session ID is inside the file),
      // otherwise use default JSONL filename-based discovery.
      let sessionFiles: SessionFileEntry[];
      if (reader.listSessionFiles) {
        sessionFiles = await reader.listSessionFiles(sessionDir);
      } else {
        const files = await fs.readdir(sessionDir);
        sessionFiles = files
          .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
          .map((f) => ({
            sessionId: f.replace(".jsonl", ""),
            filePath: path.join(sessionDir, f),
          }));
      }

      const validationStats =
        await this.statSessionFilesForValidation(sessionFiles);
      const allStats = validationStats.allStats;
      statCalls += validationStats.statCalls;

      const cacheMisses: {
        sessionId: string;
        mtime: number;
        size: number;
      }[] = [];

      for (let i = 0; i < sessionFiles.length; i++) {
        const entry = sessionFiles[i];
        if (!entry) continue;
        const sessionId = entry.sessionId;
        seenSessionIds.add(sessionId);

        const stats = allStats[i];
        if (!stats) continue;

        const cached = index.sessions[sessionId];
        const mtime = stats.mtimeMs;
        const size = stats.size;

        if (
          cached &&
          cached.fileMtime === mtime &&
          cached.indexedBytes === size
        ) {
          if (cached.isEmpty) continue;
          summaries.push({
            id: sessionId,
            projectId,
            title: cached.title,
            fullTitle: cached.fullTitle,
            createdAt: cached.createdAt,
            updatedAt: cached.updatedAt,
            messageCount: cached.messageCount,
            userQuestions: cached.userQuestions,
            ownership: { owner: "none" },
            contextUsage: cached.contextUsage,
            cumulativeUsage: cached.cumulativeUsage,
            compactCount: cached.compactCount,
            compactEvents: cached.compactEvents,
            provider: cached.provider ?? DEFAULT_PROVIDER,
            model: cached.model,
            reasoningEffort: cached.reasoningEffort,
            serviceTier: cached.serviceTier,
            originator: cached.originator,
            source: cached.source,
            createdBy: cached.createdBy,
          });
        } else {
          cacheMisses.push({ sessionId, mtime, size });
        }
      }

      for (const { sessionId, mtime, size } of cacheMisses) {
        parseCalls += 1;
        const summary = await reader.getSessionSummary(sessionId, projectId);
        if (summary) {
          summaries.push(summary);
          index.sessions[sessionId] = this.toCachedSummary(
            summary,
            mtime,
            size,
          );
          indexChanged = true;
        } else {
          index.sessions[sessionId] = this.toEmptyCachedSummary(mtime, size);
          indexChanged = true;
        }
      }

      for (const sessionId of Object.keys(index.sessions)) {
        if (!seenSessionIds.has(sessionId)) {
          delete index.sessions[sessionId];
          indexChanged = true;
        }
      }

      if (indexChanged) {
        await this.saveIndex(sessionDir, reader);
      }

      summaries.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      this.lastFullValidationAt.set(
        this.getScopeKey(sessionDir, reader),
        Date.now(),
      );
      this.clearDirDirtyState(sessionDir, reader);

      return { summaries, statCalls, parseCalls };
    } catch {
      return { summaries: [], statCalls, parseCalls };
    }
  }

  private async statSessionFilesForValidation(
    sessionFiles: SessionFileEntry[],
  ): Promise<{ allStats: (SessionFileStat | null)[]; statCalls: number }> {
    const allStats: (SessionFileStat | null)[] = new Array(
      sessionFiles.length,
    ).fill(null);
    let statCalls = 0;
    let nextIndex = 0;
    const workerCount = Math.min(
      FULL_VALIDATION_STAT_CONCURRENCY,
      sessionFiles.length,
    );

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= sessionFiles.length) return;

          const entry = sessionFiles[index];
          if (!entry) continue;
          if (entry.mtime !== undefined && entry.size !== undefined) {
            allStats[index] = { mtimeMs: entry.mtime, size: entry.size };
            continue;
          }
          statCalls += 1;
          allStats[index] = await fs.stat(entry.filePath).catch(() => null);
        }
      }),
    );

    return { allStats, statCalls };
  }

  getDebugStats(): {
    requests: number;
    fastHits: number;
    incrementalRuns: number;
    fullScans: number;
    statCalls: number;
    parseCalls: number;
    avgDurationMs: number;
    /** Mean full-validation queue wait, excluded from avgDurationMs. */
    avgFullValidationQueueWaitMs: number;
    fullValidationQueueWaitMs: number;
    fullValidationQueueBypasses: number;
    dirtyDirCount: number;
    dirtySessionCount: number;
  } {
    const dirtySessionCount = Array.from(
      this.dirtySessionsByDir.values(),
    ).reduce((sum, set) => sum + set.size, 0);

    return {
      ...this.cacheStats,
      avgDurationMs:
        this.cacheStats.requests > 0
          ? this.cacheStats.totalDurationMs / this.cacheStats.requests
          : 0,
      avgFullValidationQueueWaitMs:
        this.cacheStats.fullScans > 0
          ? this.cacheStats.fullValidationQueueWaitMs /
            this.cacheStats.fullScans
          : 0,
      dirtyDirCount: this.dirtyDirs.size,
      dirtySessionCount,
    };
  }

  /**
   * Get sessions using the cache, only re-parsing files that have changed.
   * This is the main entry point for listing sessions with caching.
   */
  async getSessionsWithCache(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    options: GetSessionsWithCacheOptions = {},
  ): Promise<SessionSummary[]> {
    if (options.allowStale) {
      return this.getSessionsWithStaleCache(sessionDir, projectId, reader);
    }

    const loadKey = this.getScopedLoadKey(sessionDir, projectId, reader);
    const inFlight = this.inFlightSessionLoads.get(loadKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.getSessionsWithCacheInternal(
      sessionDir,
      projectId,
      reader,
    );
    this.inFlightSessionLoads.set(loadKey, promise);

    try {
      return await promise;
    } finally {
      if (this.inFlightSessionLoads.get(loadKey) === promise) {
        this.inFlightSessionLoads.delete(loadKey);
      }
    }
  }

  private refreshSessionsInBackground(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
  ): void {
    const loadKey = this.getScopedLoadKey(sessionDir, projectId, reader);
    if (this.inFlightSessionLoads.has(loadKey)) {
      return;
    }

    const promise = this.getSessionsWithCacheInternal(
      sessionDir,
      projectId,
      reader,
    );
    this.inFlightSessionLoads.set(loadKey, promise);

    promise
      .catch((error) => {
        logger.warn(
          { err: error },
          `[SessionIndexService] Background validation failed for ${sessionDir}`,
        );
      })
      .finally(() => {
        if (this.inFlightSessionLoads.get(loadKey) === promise) {
          this.inFlightSessionLoads.delete(loadKey);
        }
      });
  }

  /**
   * Whether a pending dirty-directory signal may force a full validation now.
   *
   * Returns false while the scope is inside its minimum spacing window, which
   * collapses a burst of watcher events into one pass instead of one per event.
   * The signal itself is left in place, so the next request after the window
   * still reconciles.
   */
  private isDirDirtyFullValidationDue(scopeKey: string, now: number): boolean {
    if (this.fullValidationMinIntervalMs <= 0) return true;
    const last = this.lastFullValidationAt.get(scopeKey) ?? 0;
    // Never validated: reconcile immediately, there is nothing to serve from.
    if (last === 0) return true;
    return now - last >= this.fullValidationMinIntervalMs;
  }

  /**
   * Run a full validation under the concurrency cap, with two escapes.
   *
   * Without any cap, every scope sharing a backing store scans concurrently and
   * they contend for the same file handles and CPU while the event loop stalls
   * (measured: 709% occupancy, unrelated 15 ms reads taking 3-11 s). With a hard
   * cap of one, the opposite failure appeared: head-of-line blocking, where a
   * single 5 s Kimi scan made twenty cheap scopes wait behind it -- one of them
   * 8291 ms to do 40 ms of work -- on the request path, so those waits were
   * user-visible.
   *
   * So the cap now shapes rather than gates:
   *
   *   - a scope whose previous scan was cheap skips the queue, because the queue
   *     exists to keep heavy scans from piling up and a 20 ms scan is not one;
   *   - anyone who does queue gives up waiting after a bounded time and runs.
   *
   * Both escapes admit extra concurrency on purpose. That is strictly better
   * than the pre-cap behaviour, which admitted unlimited concurrency, and it
   * keeps the worst case bounded by wait cap rather than by the slowest scan in
   * the system.
   */
  private async withFullValidationSlot<T>(
    scopeKey: string,
    run: () => Promise<T>,
  ): Promise<{ value: T; queueWaitMs: number; bypassedQueue: boolean }> {
    const lastDurationMs = this.lastFullValidationDurationMs.get(scopeKey);
    const cheapScope =
      this.fullValidationFastPathMs > 0 &&
      lastDurationMs !== undefined &&
      lastDurationMs <= this.fullValidationFastPathMs;

    const queueStartedMs = Date.now();
    let bypassedQueue = cheapScope;
    if (
      !cheapScope &&
      this.activeFullValidations >= this.maxConcurrentFullValidations
    ) {
      bypassedQueue = !(await this.awaitFullValidationSlot());
    }
    const queueWaitMs = Date.now() - queueStartedMs;

    this.activeFullValidations += 1;
    try {
      const startedMs = Date.now();
      const value = await run();
      this.lastFullValidationDurationMs.set(scopeKey, Date.now() - startedMs);
      return { value, queueWaitMs, bypassedQueue };
    } finally {
      this.activeFullValidations -= 1;
      this.fullValidationWaiters.shift()?.();
    }
  }

  /**
   * Wait for a slot. Resolves true when a slot was granted, false when the wait
   * cap expired first and the caller should proceed regardless.
   */
  private async awaitFullValidationSlot(): Promise<boolean> {
    if (this.fullValidationMaxQueueWaitMs <= 0) {
      await new Promise<void>((resolve) => {
        this.fullValidationWaiters.push(resolve);
      });
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Leave the waiter in place: removing it would mean the slot released
        // next wakes nobody. It resolves into a no-op instead.
        resolve(false);
      }, this.fullValidationMaxQueueWaitMs);
      // Node keeps the process alive for pending timers; this one must never do
      // that on an otherwise idle server.
      timer.unref?.();
      this.fullValidationWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async getSessionsWithStaleCache(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
  ): Promise<SessionSummary[]> {
    const start = Date.now();
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const index = await this.loadIndex(sessionDir, projectId, reader);

    if (Object.keys(index.sessions).length === 0) {
      return this.getSessionsWithCache(sessionDir, projectId, reader);
    }

    const now = Date.now();
    const lastFullValidation = this.lastFullValidationAt.get(scopeKey) ?? 0;
    const hasDirDirty = this.dirtyDirs.has(scopeKey);
    const dirtySessions = this.dirtySessionsByDir.get(scopeKey);
    const hasDirtySessions = Boolean(dirtySessions && dirtySessions.size > 0);
    const fullValidationDue =
      this.fullValidationIntervalMs <= 0 ||
      lastFullValidation === 0 ||
      now - lastFullValidation >= this.fullValidationIntervalMs;

    let statCalls = 0;
    let parseCalls = 0;

    if (!hasDirDirty && hasDirtySessions) {
      const incremental = await this.applyIncrementalDirtyUpdates(
        sessionDir,
        projectId,
        reader,
        index,
      );
      statCalls += incremental.statCalls;
      parseCalls += incremental.parseCalls;
      if (incremental.indexChanged) {
        await this.saveIndex(sessionDir, reader);
      }
    }

    if (
      fullValidationDue ||
      (hasDirDirty && this.isDirDirtyFullValidationDue(scopeKey, now))
    ) {
      this.refreshSessionsInBackground(sessionDir, projectId, reader);
    }

    const summaries = this.buildSummariesFromIndex(index, projectId);
    this.recordCallStats(
      hasDirtySessions && !hasDirDirty ? "incremental" : "fast",
      Date.now() - start,
      statCalls,
      parseCalls,
      sessionDir,
      scopeKey,
    );
    return summaries;
  }

  private async getSessionsWithCacheInternal(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
  ): Promise<SessionSummary[]> {
    const start = Date.now();
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const index = await this.loadIndex(sessionDir, projectId, reader);
    const now = Date.now();
    const lastFullValidation = this.lastFullValidationAt.get(scopeKey) ?? 0;
    const hasDirDirty = this.dirtyDirs.has(scopeKey);
    const dirtySessions = this.dirtySessionsByDir.get(scopeKey);
    const hasDirtySessions = Boolean(dirtySessions && dirtySessions.size > 0);

    const fullValidationDue =
      this.fullValidationIntervalMs <= 0 ||
      lastFullValidation === 0 ||
      now - lastFullValidation >= this.fullValidationIntervalMs;

    // A dirty directory only forces a full pass once per minimum interval; in
    // between it behaves like "not dirty yet" so bursts collapse.
    const dirDirtyDue =
      hasDirDirty && this.isDirDirtyFullValidationDue(scopeKey, now);

    // Fast path: no actionable dirty signals and recent full validation.
    if (!fullValidationDue && !dirDirtyDue && !hasDirtySessions) {
      const summaries = this.buildSummariesFromIndex(index, projectId);
      this.recordCallStats(
        "fast",
        Date.now() - start,
        0,
        0,
        sessionDir,
        scopeKey,
      );
      return summaries;
    }

    // Incremental path: only specific sessions are dirty.
    if (!fullValidationDue && !dirDirtyDue && hasDirtySessions) {
      const incremental = await this.applyIncrementalDirtyUpdates(
        sessionDir,
        projectId,
        reader,
        index,
      );
      if (incremental.indexChanged) {
        await this.saveIndex(sessionDir, reader);
      }
      const summaries = this.buildSummariesFromIndex(index, projectId);
      this.recordCallStats(
        "incremental",
        Date.now() - start,
        incremental.statCalls,
        incremental.parseCalls,
        sessionDir,
        scopeKey,
      );
      return summaries;
    }

    const {
      value: full,
      queueWaitMs,
      bypassedQueue,
    } = await this.withFullValidationSlot(scopeKey, () =>
      this.runFullValidation(sessionDir, projectId, reader, index),
    );
    this.recordCallStats(
      "full",
      // The queue wait is subtracted so this stays the cost of scanning, not the
      // cost of waiting for a turn to scan.
      Date.now() - start - queueWaitMs,
      full.statCalls,
      full.parseCalls,
      sessionDir,
      scopeKey,
      queueWaitMs,
      bypassedQueue,
    );
    return full.summaries;
  }

  /**
   * Invalidate the cache for a specific session.
   * Call this when you know a session file has been modified.
   */
  invalidateSession(sessionDir: string, sessionId: string): void {
    this.markSessionDirty(sessionDir, sessionId);
    const index = this.indexCache.get(sessionDir);
    if (index) {
      delete index.sessions[sessionId];
    }
  }

  /**
   * Clear all cached data for a session directory.
   */
  clearCache(sessionDir: string): void {
    this.indexCache.delete(sessionDir);
    this.clearDirDirtyState(sessionDir);
    this.lastFullValidationAt.delete(sessionDir);
  }

  /**
   * Get the data directory for testing purposes.
   */
  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Get just the title for a single session, using cache when possible.
   * More efficient than getSessionsWithCache when you only need one session.
   */
  async getSessionTitle(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<string | null> {
    const loadKey = this.getTitleLoadKey(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    const inFlight = this.inFlightTitleLoads.get(loadKey);
    if (inFlight) return inFlight;

    const promise = this.getSessionTitleInternal(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    this.inFlightTitleLoads.set(loadKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightTitleLoads.get(loadKey) === promise) {
        this.inFlightTitleLoads.delete(loadKey);
      }
    }
  }

  private async getSessionTitleInternal(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<string | null> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const index = await this.loadIndex(sessionDir, projectId, reader);
    const cached = index.sessions[sessionId];
    const filePath =
      (await reader.getSessionFilePath?.(sessionId)) ??
      path.join(sessionDir, `${sessionId}.jsonl`);

    try {
      const stats = await this.getSessionFileStats(reader, sessionId, filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      if (
        cached &&
        cached.fileMtime === mtime &&
        cached.indexedBytes === size
      ) {
        if (cached.isEmpty) return null;
        return cached.title;
      }

      const summary = await reader.getSessionSummary(sessionId, projectId);
      if (summary) {
        index.sessions[sessionId] = this.toCachedSummary(summary, mtime, size);
        await this.saveIndex(sessionDir, reader);
        return summary.title;
      }

      index.sessions[sessionId] = this.toEmptyCachedSummary(mtime, size);
      await this.saveIndex(sessionDir, reader);
    } catch {
      // File error - return null
    }

    return null;
  }

  /**
   * Get the full summary for a single session, using cache when possible.
   *
   * More efficient than getSessionsWithCache when you only need one session
   * (e.g. the recents panel resolving up to 100 individual entries): on a cold
   * cache it parses only the requested session instead of the whole directory,
   * and it shares/writes back the same persisted index the project list uses,
   * so a session already indexed there costs just a stat + cache hit.
   */
  async getSessionSummaryWithCache(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<SessionSummary | null> {
    const loadKey = this.getTitleLoadKey(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    const inFlight = this.inFlightSummaryLoads.get(loadKey);
    if (inFlight) return inFlight;

    const promise = this.getSessionSummaryWithCacheInternal(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    this.inFlightSummaryLoads.set(loadKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightSummaryLoads.get(loadKey) === promise) {
        this.inFlightSummaryLoads.delete(loadKey);
      }
    }
  }

  private async getSessionSummaryWithCacheInternal(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<SessionSummary | null> {
    const index = await this.loadIndex(sessionDir, projectId, reader);
    const cached = index.sessions[sessionId];
    const filePath =
      (await reader.getSessionFilePath?.(sessionId)) ??
      path.join(sessionDir, `${sessionId}.jsonl`);

    let stats: SessionFileStat;
    try {
      stats = await this.getSessionFileStats(reader, sessionId, filePath);
    } catch {
      // The file is not at the expected path under this sessionDir. Readers
      // like ClaudeSessionReader can still resolve it across merged/additional
      // dirs, so fall back to a direct (uncached) read rather than dropping the
      // session entirely.
      return reader.getSessionSummary(sessionId, projectId);
    }

    const mtime = stats.mtimeMs;
    const size = stats.size;

    if (cached && cached.fileMtime === mtime && cached.indexedBytes === size) {
      if (cached.isEmpty) return null;
      return this.cachedToSummary(sessionId, cached, projectId);
    }

    const summary = await reader.getSessionSummary(sessionId, projectId);
    if (summary) {
      index.sessions[sessionId] = this.toCachedSummary(summary, mtime, size);
      await this.saveIndex(sessionDir, reader);
      return summary;
    }

    index.sessions[sessionId] = this.toEmptyCachedSummary(mtime, size);
    await this.saveIndex(sessionDir, reader);
    return null;
  }

  dispose(): void {
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
  }
}

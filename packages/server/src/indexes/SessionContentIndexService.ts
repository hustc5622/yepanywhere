/**
 * SessionContentIndexService caches per-message searchable text for full-text
 * search across sessions. It mirrors SessionIndexService's caching strategy
 * (mtime/size invalidation, EventBus dirty-tracking, FIFO in-memory cache,
 * atomic disk persistence with a cross-process lock) but stores message text
 * instead of lightweight summaries.
 *
 * Content indexes are larger than summary indexes, so they live in a separate
 * `{dataDir}/indexes/content/` subdirectory, use a smaller in-memory cache, and
 * are built lazily on the first search rather than on every session list.
 *
 * Text extraction reuses each reader's normalized `Message[]` (via getSession +
 * normalizeSession passed in as `loadMessages`) so the emitted message ids match
 * what the client renders, enabling deep-linking to a matched message.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_PROVIDER,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { ISessionReader, SessionFileEntry } from "../sessions/types.js";
import type { Message } from "../supervisor/types.js";
import type { EventBus, FileChangeEvent } from "../watcher/index.js";
import {
  type IndexedMessage,
  buildSnippet,
  extractSearchableMessages,
} from "./extractSearchableText.js";

const logger = getLogger();

interface SessionFileStat {
  mtimeMs: number;
  size: number;
}

/** Cached searchable content for a single session. */
export interface CachedSessionContent {
  /** File mtime (ms since epoch) at time of indexing. */
  fileMtime: number;
  /** File size (bytes) at time of indexing. */
  indexedBytes: number;
  /** Session display title (cached for result rendering). */
  title: string | null;
  /** ISO timestamp of the session's last update (for ranking). */
  updatedAt: string;
  /** AI provider for this session. */
  provider: ProviderName;
  /** Indexed user/assistant messages (text only). */
  messages: IndexedMessage[];
  /** True if the session has no searchable messages (avoids re-parsing). */
  isEmpty?: boolean;
}

export interface SessionContentIndexState {
  version: 1;
  projectId: string;
  sessions: Record<string, CachedSessionContent>;
}

const CURRENT_VERSION = 1;

/**
 * Loads a session's normalized messages on cache miss. Provided by the caller
 * so this service stays decoupled from the reader/normalization wiring.
 * Returns null if the session can't be loaded.
 */
export type LoadSessionMessages = (
  sessionId: string,
  projectId: UrlProjectId,
  reader: ISessionReader,
) => Promise<{
  messages: Message[];
  title: string | null;
  updatedAt: string;
  provider: ProviderName;
} | null>;

/** A single session's search results within a scope. */
export interface ScopeSearchResult {
  sessionId: string;
  title: string | null;
  updatedAt: string;
  provider: ProviderName;
  matchCount: number;
  /** Whether the query matched the session title (used for ranking). */
  titleMatch: boolean;
  matches: Array<{
    messageId: string;
    role: string;
    snippet: string;
    matchStart: number;
    matchLength: number;
  }>;
}

export interface SessionContentIndexServiceOptions {
  /** Directory to store content index files (defaults to ~/.yep-anywhere/indexes/content). */
  dataDir?: string;
  /** Claude projects directory (defaults to ~/.claude/projects). */
  projectsDir?: string;
  /** Max number of scopes to keep in memory cache (default: 50). */
  maxCacheSize?: number;
  /** Optional event bus for watcher-driven invalidation. */
  eventBus?: EventBus;
  /** Max time to wait for cross-process write lock (ms). */
  writeLockTimeoutMs?: number;
  /** Age at which lock directories are treated as stale and removed (ms). */
  writeLockStaleMs?: number;
}

export class SessionContentIndexService {
  private dataDir: string;
  private projectsDir: string;
  private indexCache: Map<string, SessionContentIndexState> = new Map();
  private savePromises: Map<string, Promise<void>> = new Map();
  private pendingSaves: Set<string> = new Set();
  private maxCacheSize: number;
  private writeLockTimeoutMs: number;
  private writeLockStaleMs: number;
  private dirtyDirs: Set<string> = new Set();
  private dirtySessionsByDir: Map<string, Set<string>> = new Map();
  private inFlightEnsures: Map<string, Promise<SessionContentIndexState>> =
    new Map();
  private unsubscribeEventBus: (() => void) | null = null;

  constructor(options: SessionContentIndexServiceOptions = {}) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    this.dataDir =
      options.dataDir ?? path.join(home, ".yep-anywhere", "indexes", "content");
    this.projectsDir =
      options.projectsDir ?? path.join(home, ".claude", "projects");
    this.maxCacheSize = options.maxCacheSize ?? 50;
    this.writeLockTimeoutMs = Math.max(0, options.writeLockTimeoutMs ?? 2000);
    this.writeLockStaleMs = Math.max(1000, options.writeLockStaleMs ?? 10000);

    if (options.eventBus) {
      this.unsubscribeEventBus = options.eventBus.subscribe((event) => {
        if (event.type !== "file-change") return;
        this.handleFileChange(event);
      });
    }
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  private getScopeKey(sessionDir: string, reader?: ISessionReader): string {
    return reader?.getIndexScopeKey?.(sessionDir) ?? sessionDir;
  }

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
      const hash = createHash("sha256")
        .update(scopeKey)
        .digest("hex")
        .slice(0, 16);
      return path.join(this.dataDir, `ext-${hash}.json`);
    }
    const encoded = relative.replace(/[/\\]/g, "%2F");
    return path.join(this.dataDir, `${encoded}.json`);
  }

  private evictIfNeeded(): void {
    while (this.indexCache.size > this.maxCacheSize) {
      const firstKey = this.indexCache.keys().next().value;
      if (firstKey) {
        this.indexCache.delete(firstKey);
      } else {
        break;
      }
    }
  }

  private async loadIndex(
    sessionDir: string,
    projectId: UrlProjectId,
    reader?: ISessionReader,
  ): Promise<SessionContentIndexState> {
    const cacheKey = this.getScopeKey(sessionDir, reader);
    const indexPath = this.getIndexPath(sessionDir, reader);

    const cached = this.indexCache.get(cacheKey);
    if (cached) return cached;

    const fresh: SessionContentIndexState = {
      version: CURRENT_VERSION,
      projectId,
      sessions: {},
    };

    try {
      const content = await fs.readFile(indexPath, "utf-8");
      const parsed = JSON.parse(content) as SessionContentIndexState;
      if (
        parsed.version === CURRENT_VERSION &&
        parsed.projectId === projectId
      ) {
        this.indexCache.set(cacheKey, parsed);
        this.evictIfNeeded();
        return parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          { err: error },
          `[SessionContentIndexService] Failed to load index for ${cacheKey}, starting fresh`,
        );
      }
    }

    this.indexCache.set(cacheKey, fresh);
    this.evictIfNeeded();
    return fresh;
  }

  private async saveIndex(
    sessionDir: string,
    reader?: ISessionReader,
  ): Promise<void> {
    const cacheKey = this.getScopeKey(sessionDir, reader);

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
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await this.withWriteLock(lockPath, async () => {
        const content = JSON.stringify(index);
        await fs.writeFile(tempPath, content, "utf-8");
        await fs.rename(tempPath, indexPath);
      });
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      logger.error(
        { err: error },
        `[SessionContentIndexService] Failed to save index for ${scopeKey}`,
      );
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
      await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
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
        if (code !== "EEXIST") throw error;

        if (await this.isLockStale(lockPath)) {
          await fs
            .rm(lockPath, { recursive: true, force: true })
            .catch(() => {});
          continue;
        }

        if (Date.now() - start >= this.writeLockTimeoutMs) {
          throw new Error(
            `Timed out acquiring content index write lock: ${lockPath}`,
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  private markMatchingScopesDirty(prefix: string): void {
    const knownScopeKeys = new Set<string>([
      ...this.indexCache.keys(),
      ...this.dirtyDirs.values(),
      ...this.dirtySessionsByDir.keys(),
    ]);
    for (const scopeKey of knownScopeKeys) {
      if (scopeKey.startsWith(prefix)) {
        this.dirtyDirs.add(scopeKey);
      }
    }
  }

  /**
   * Map watcher events to dirty scopes. Mirrors SessionIndexService so both
   * indexes stay coherent with the same invalidation signals.
   */
  private handleFileChange(event: FileChangeEvent): void {
    if (event.fileType !== "session") return;

    if (event.provider === "claude") {
      const fileName = path.basename(event.path);
      if (!fileName.endsWith(".jsonl")) return;
      const sessionId = fileName.slice(0, -6);
      const sessionDir = path.dirname(event.path);

      this.markSessionDirty(sessionDir, sessionId);
      if (event.changeType === "create" || event.changeType === "delete") {
        this.markDirDirty(sessionDir);
      }
      return;
    }

    if (event.provider === "codex") {
      this.markMatchingScopesDirty("codex::");
      return;
    }

    if (event.provider === "gemini") {
      this.markMatchingScopesDirty("gemini::");
      return;
    }

    if (event.provider === "kimi") {
      this.markMatchingScopesDirty("kimi::");
    }
  }

  private async indexSession(
    sessionId: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    loadMessages: LoadSessionMessages,
    mtime: number,
    size: number,
  ): Promise<CachedSessionContent> {
    const loaded = await loadMessages(sessionId, projectId, reader);
    if (!loaded) {
      return {
        fileMtime: mtime,
        indexedBytes: size,
        title: null,
        updatedAt: new Date().toISOString(),
        provider: DEFAULT_PROVIDER,
        messages: [],
        isEmpty: true,
      };
    }

    const messages = extractSearchableMessages(loaded.messages);
    return {
      fileMtime: mtime,
      indexedBytes: size,
      title: loaded.title,
      updatedAt: loaded.updatedAt,
      provider: loaded.provider,
      messages,
      isEmpty: messages.length === 0,
    };
  }

  /**
   * Ensure the content index for a scope is up-to-date, then return it.
   * Re-indexes only sessions whose files changed (mtime/size) or were flagged
   * dirty by the watcher. Builds lazily — call this right before searching.
   */
  async ensureIndexed(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    loadMessages: LoadSessionMessages,
  ): Promise<SessionContentIndexState> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const loadKey = `${scopeKey}::${projectId}`;
    const inFlight = this.inFlightEnsures.get(loadKey);
    if (inFlight) return inFlight;

    const promise = this.ensureIndexedInternal(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );
    this.inFlightEnsures.set(loadKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightEnsures.get(loadKey) === promise) {
        this.inFlightEnsures.delete(loadKey);
      }
    }
  }

  private async ensureIndexedInternal(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    loadMessages: LoadSessionMessages,
  ): Promise<SessionContentIndexState> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const index = await this.loadIndex(sessionDir, projectId, reader);
    let indexChanged = false;

    // Enumerate session files (reader override for Codex/Gemini shared trees).
    let sessionFiles: SessionFileEntry[];
    try {
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
    } catch {
      // Directory missing/unreadable — return whatever we have.
      return index;
    }

    const seen = new Set<string>();
    const STAT_BATCH = 100;
    const allStats: (SessionFileStat | null)[] = new Array(sessionFiles.length);
    for (let b = 0; b < sessionFiles.length; b += STAT_BATCH) {
      const end = Math.min(b + STAT_BATCH, sessionFiles.length);
      const batch = await Promise.all(
        sessionFiles.slice(b, end).map((file) => {
          if (file.mtime !== undefined && file.size !== undefined) {
            return Promise.resolve({
              mtimeMs: file.mtime,
              size: file.size,
            });
          }
          return fs.stat(file.filePath).catch(() => null);
        }),
      );
      for (let j = 0; j < batch.length; j++) {
        allStats[b + j] = batch[j] ?? null;
      }
    }

    for (let i = 0; i < sessionFiles.length; i++) {
      const entry = sessionFiles[i];
      if (!entry) continue;
      const { sessionId } = entry;
      seen.add(sessionId);

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
        continue;
      }

      index.sessions[sessionId] = await this.indexSession(
        sessionId,
        projectId,
        reader,
        loadMessages,
        mtime,
        size,
      );
      indexChanged = true;
    }

    // Drop sessions whose files disappeared.
    for (const sessionId of Object.keys(index.sessions)) {
      if (!seen.has(sessionId)) {
        delete index.sessions[sessionId];
        indexChanged = true;
      }
    }

    // Clear dirty flags for this scope now that we've reconciled.
    this.dirtyDirs.delete(scopeKey);
    this.dirtySessionsByDir.delete(scopeKey);

    if (indexChanged) {
      await this.saveIndex(sessionDir, reader);
    }

    return index;
  }

  /**
   * Search sessions within an index for `queryLower` (must be lowercased).
   * When `filterSessionId` is provided, only that exact session is inspected.
   * Returns one result per matching session with up to
   * `perSessionMatchLimit` snippets.
   */
  searchScope(
    index: SessionContentIndexState,
    queryLower: string,
    perSessionMatchLimit: number,
    filterSessionId?: string,
  ): ScopeSearchResult[] {
    const results: ScopeSearchResult[] = [];
    if (!queryLower) return results;

    for (const [sessionId, session] of Object.entries(index.sessions)) {
      if (filterSessionId && sessionId !== filterSessionId) continue;

      if (session.isEmpty) {
        // Still allow title-only matches for empty sessions.
        const titleMatch =
          session.title?.toLowerCase().includes(queryLower) ?? false;
        if (titleMatch) {
          results.push({
            sessionId,
            title: session.title,
            updatedAt: session.updatedAt,
            provider: session.provider,
            matchCount: 0,
            titleMatch: true,
            matches: [],
          });
        }
        continue;
      }

      const matches: ScopeSearchResult["matches"] = [];
      let matchCount = 0;

      for (const message of session.messages) {
        if (!message.text.includes(queryLower)) continue;
        matchCount++;
        if (matches.length < perSessionMatchLimit) {
          const snippet = buildSnippet(message.originalText, queryLower);
          if (snippet) {
            matches.push({
              messageId: message.id,
              role: message.role,
              snippet: snippet.snippet,
              matchStart: snippet.matchStart,
              matchLength: snippet.matchLength,
            });
          }
        }
      }

      const titleMatch =
        session.title?.toLowerCase().includes(queryLower) ?? false;

      if (matchCount > 0 || titleMatch) {
        results.push({
          sessionId,
          title: session.title,
          updatedAt: session.updatedAt,
          provider: session.provider,
          matchCount,
          titleMatch,
          matches,
        });
      }
    }

    return results;
  }

  invalidateSession(sessionDir: string, sessionId: string): void {
    this.markSessionDirty(sessionDir, sessionId);
    const index = this.indexCache.get(sessionDir);
    if (index) {
      delete index.sessions[sessionId];
    }
  }

  clearCache(sessionDir: string): void {
    this.indexCache.delete(sessionDir);
    this.dirtyDirs.delete(sessionDir);
    this.dirtySessionsByDir.delete(sessionDir);
  }

  getDataDir(): string {
    return this.dataDir;
  }

  dispose(): void {
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
  }
}

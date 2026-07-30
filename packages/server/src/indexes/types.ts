/**
 * Session index service interface for provider-agnostic session caching.
 *
 * Each provider may have different file formats and directory structures,
 * but all index services implement this interface to provide consistent caching.
 */

import type { UrlProjectId } from "@yep-anywhere/shared";
import type { ISessionReader } from "../sessions/types.js";
import type { SessionSummary } from "../supervisor/types.js";

export interface GetSessionsWithCacheOptions {
  /**
   * Return the last persisted index immediately when a full validation is due,
   * and refresh the index in the background. If no index exists yet, the call
   * still falls back to a blocking validation.
   */
  allowStale?: boolean;
}

/**
 * Common interface for session index services across providers.
 *
 * Index services cache session summaries to avoid re-parsing files on every request.
 * They use file mtime/size for cache invalidation.
 */
export interface ISessionIndexService {
  /**
   * Initialize the service (create directories, load state, etc.).
   */
  initialize(): Promise<void>;

  /**
   * Get sessions using the cache, only re-parsing files that have changed.
   * This is the main entry point for listing sessions with caching.
   *
   * @param sessionDir - Directory containing session files
   * @param projectId - The project ID
   * @param reader - Session reader for parsing files on cache miss
   */
  getSessionsWithCache(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    options?: GetSessionsWithCacheOptions,
  ): Promise<SessionSummary[]>;

  /**
   * Get just the title for a single session, using cache when possible.
   * More efficient than getSessionsWithCache when you only need one session.
   *
   * @param sessionDir - Directory containing session files
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @param reader - Session reader for parsing files on cache miss
   */
  getSessionTitle(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<string | null>;

  /**
   * Get the full summary for a single session, using cache when possible.
   * More efficient than getSessionsWithCache when you only need one session:
   * on a cold cache it parses only the requested session rather than the whole
   * directory, while still sharing the persisted index with the project list.
   *
   * @param sessionDir - Directory containing session files
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @param reader - Session reader for parsing files on cache miss
   */
  getSessionSummaryWithCache(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<SessionSummary | null>;

  /**
   * Invalidate the cache for a specific session.
   * Call this when you know a session file has been modified.
   *
   * @param sessionDir - Directory containing session files
   * @param sessionId - The session ID to invalidate
   */
  invalidateSession(sessionDir: string, sessionId: string): void;

  /**
   * Clear all cached data for a session directory.
   *
   * @param sessionDir - Directory to clear cache for
   */
  clearCache(sessionDir: string): void;
}

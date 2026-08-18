/**
 * ZCode session scanner.
 *
 * Aggregates ZCode sessions from the SQLite `session` table by project
 * directory through the provider-neutral query layer.
 */

import { basename } from "node:path";
import { ZCODE_DB_PATH } from "../sessions/zcode-db.js";
import {
  type SqliteFailureReason,
  type SqliteStatement,
  querySqliteRows,
  querySqliteRowsOrEmpty,
  runSqliteStatements,
} from "../sqlite/query.js";
import {
  SESSION_DIGEST_SQL,
  sessionDigestFromRow,
} from "../sqlite/session-change-sql.js";
import type { Project } from "../supervisor/types.js";
import { canonicalizeProjectPath, encodeProjectId } from "./paths.js";

// =============================================================================
// Options
// =============================================================================

export interface ZCodeScannerOptions {
  dbPath?: string;
}

// =============================================================================
// Types
// =============================================================================

interface ZCodeProjectInfo {
  path: string;
  sessionCount: number;
  lastActivity: string | null;
}

export interface ZCodeSessionInfo {
  id: string;
  directory: string;
  /** ZCode stores every session in one SQLite DB file; use this row version
   * to distinguish an update to the selected session from another session's
   * database write. */
  filePath: string;
  timestamp: string;
  mtime: number;
}

export interface ZCodeSessionChangeCursor {
  updatedAt: number;
  sessionId: string;
}

export interface ZCodeSessionChange {
  sessionId: string;
  directory: string;
  /** Max update time observed across the session, message, and part rows. */
  updatedAt: number;
}

export interface ZCodeSessionChangeScanResult {
  changes: ZCodeSessionChange[];
  /** Number of cursor rows consumed, including filtered rows. */
  scannedRows: number;
  skipped: {
    archived: number;
    child: number;
    invalidDirectory: number;
  };
  nextCursor: ZCodeSessionChangeCursor;
  hasMore: boolean;
}

export class ZCodeSessionScanError extends Error {
  readonly reason: SqliteFailureReason;
  readonly detail: unknown;

  constructor(reason: SqliteFailureReason, detail?: unknown) {
    super(`ZCode session scan failed: ${reason}`);
    this.name = "ZCodeSessionScanError";
    this.reason = reason;
    this.detail = detail;
  }
}

// =============================================================================
// SQL
// =============================================================================

const SCAN_PROJECTS_SQL = `
  SELECT
    directory,
    COUNT(CASE WHEN parent_id IS NULL THEN 1 END) AS session_count,
    MAX(time_updated) AS last_updated
  FROM session
  WHERE directory IS NOT NULL
    AND directory != ''
    AND time_archived IS NULL
  GROUP BY directory
`;

const GET_SESSIONS_FOR_PROJECT_SQL = `
  SELECT id, directory, time_updated
  FROM session
  WHERE directory = ?
    AND time_archived IS NULL
    AND COALESCE(task_type, 'interactive') <> 'subagent_child'
  ORDER BY time_updated DESC
`;

/**
 * ZCode uses `parent_id` for both edit forks and subagents, so `task_type` must travel
 * with each row; filtering every parent would incorrectly suppress edit-fork
 * updates from the provider-agnostic event stream.
 */
const ZCODE_SESSION_CHANGE_PAGE_SQL = `
  WITH changed_versions AS (
    SELECT id AS session_id, time_updated
    FROM session
    WHERE time_updated > ?
      OR (time_updated = ? AND id > ?)

    UNION ALL

    SELECT session_id, time_updated
    FROM message
    WHERE time_updated > ?
      OR (time_updated = ? AND session_id > ?)

    UNION ALL

    SELECT session_id, time_updated
    FROM part
    WHERE time_updated > ?
      OR (time_updated = ? AND session_id > ?)
  ),
  changed_sessions AS (
    SELECT session_id, MAX(time_updated) AS effective_updated_at
    FROM changed_versions
    WHERE session_id IS NOT NULL AND time_updated IS NOT NULL
    GROUP BY session_id
  ),
  page AS (
    SELECT session_id, effective_updated_at
    FROM changed_sessions
    ORDER BY effective_updated_at ASC, session_id ASC
    LIMIT ?
  )
  SELECT
    page.session_id AS id,
    page.effective_updated_at AS time_updated,
    session.directory,
    session.parent_id,
    session.task_type,
    session.time_archived
  FROM page
  LEFT JOIN session ON session.id = page.session_id
  ORDER BY page.effective_updated_at ASC, page.session_id ASC
`;

const ZCODE_SESSION_CHANGE_REPLAY_SQL = `
  WITH changed_versions AS (
    SELECT id AS session_id, time_updated
    FROM session
    WHERE time_updated >= ?

    UNION ALL

    SELECT session_id, time_updated
    FROM message
    WHERE time_updated >= ?

    UNION ALL

    SELECT session_id, time_updated
    FROM part
    WHERE time_updated >= ?
  ),
  changed_sessions AS (
    SELECT session_id, MAX(time_updated) AS effective_updated_at
    FROM changed_versions
    WHERE session_id IS NOT NULL AND time_updated IS NOT NULL
    GROUP BY session_id
  )
  SELECT
    changed_sessions.session_id AS id,
    changed_sessions.effective_updated_at AS time_updated,
    session.directory,
    session.parent_id,
    session.task_type,
    session.time_archived
  FROM changed_sessions
  LEFT JOIN session ON session.id = changed_sessions.session_id
  WHERE changed_sessions.effective_updated_at >= ?
    AND (
      changed_sessions.effective_updated_at < ?
      OR (
        changed_sessions.effective_updated_at = ?
        AND changed_sessions.session_id <= ?
      )
    )
  ORDER BY
    changed_sessions.effective_updated_at ASC,
    changed_sessions.session_id ASC
`;

// =============================================================================
// Scanner
// =============================================================================

const SCAN_CACHE_TTL = 5_000;
const MAX_INCREMENTAL_SCAN_LIMIT = 1_000;
const INCREMENTAL_REPLAY_OVERLAP_MS = 1_000;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Cheap per-session change digest used to suppress duplicate replay deliveries.
 *
 * The aggregate keeps the property that actually matters — a second write
 * inside the same millisecond still changes the digest — because such a write
 * alters at least one of the row count, the maximum row id, the maximum
 * `time_updated`, or the total payload length.
 */
export class ZCodeSessionScanner {
  private readonly dbPath: string;
  private cachedProjects: {
    result: ZCodeProjectInfo[];
    timestamp: number;
  } | null = null;
  private incrementalReplayState: {
    expectedCursorKey: string;
    fingerprints: Map<string, { updatedAt: number; value: string }>;
  } | null = null;

  constructor(options: ZCodeScannerOptions = {}) {
    this.dbPath = options.dbPath ?? ZCODE_DB_PATH;
  }

  get databasePath(): string {
    return this.dbPath;
  }

  invalidateCache(): void {
    this.cachedProjects = null;
  }

  /**
   * List all projects that have ZCode sessions, aggregated by directory.
   */
  async listProjects(): Promise<Project[]> {
    const projectInfos = await this.scanProjects();
    return projectInfos.map((info) => {
      const path = canonicalizeProjectPath(info.path);
      return {
        id: encodeProjectId(path),
        path,
        name: basename(path),
        sessionCount: info.sessionCount,
        sessionDir: this.dbPath,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: info.lastActivity,
        provider: "zcode" as const,
      } satisfies Project;
    });
  }

  /**
   * Get sessions for a specific project directory.
   */
  async getSessionsForProject(
    projectPath: string,
  ): Promise<ZCodeSessionInfo[]> {
    const canonical = canonicalizeProjectPath(projectPath);
    const rows = await querySqliteRowsOrEmpty(
      this.dbPath,
      GET_SESSIONS_FOR_PROJECT_SQL,
      [canonical],
      { label: "zcode.getSessionsForProject" },
    );
    return rows
      .map((row) => {
        const id = asString(row.id);
        const directory = asString(row.directory);
        const mtime = asNumber(row.time_updated);
        if (!id || !directory || mtime === undefined) return null;
        return {
          id,
          directory,
          filePath: this.dbPath,
          timestamp: new Date(mtime).toISOString(),
          mtime,
        };
      })
      .filter((item): item is ZCodeSessionInfo => item !== null);
  }

  /**
   * Consume changed ZCode session rows in stable `(time_updated, id)` order.
   *
   * The session/message/part schema uses the shared digest while preserving
   * ZCode-specific child filtering.
   *
   * The cursor advances across filtered archived/child rows too. Otherwise a
   * busy child session at the head of the result set could be revisited on
   * every poll and starve later user-visible sessions.
   */
  async scanSessionChanges(
    cursor: ZCodeSessionChangeCursor,
    limit: number,
  ): Promise<ZCodeSessionChangeScanResult> {
    const scanStartedAt = Date.now();
    const boundedLimit = Math.min(
      MAX_INCREMENTAL_SCAN_LIMIT,
      Math.max(1, Math.floor(limit)),
    );
    const cursorKey = JSON.stringify([cursor.updatedAt, cursor.sessionId]);
    const replayFingerprints =
      this.incrementalReplayState?.expectedCursorKey === cursorKey
        ? this.incrementalReplayState.fingerprints
        : new Map<string, { updatedAt: number; value: string }>();

    const pageResult = await querySqliteRows(
      this.dbPath,
      ZCODE_SESSION_CHANGE_PAGE_SQL,
      [
        cursor.updatedAt,
        cursor.updatedAt,
        cursor.sessionId,
        cursor.updatedAt,
        cursor.updatedAt,
        cursor.sessionId,
        cursor.updatedAt,
        cursor.updatedAt,
        cursor.sessionId,
        boundedLimit + 1,
      ],
      { label: "zcode.scanSessionChanges.page" },
    );
    if (!pageResult.ok) {
      throw new ZCodeSessionScanError(pageResult.reason, pageResult.error);
    }

    const rows = pageResult.value;
    const pageRows = rows.slice(0, boundedLimit);
    const hasMore = rows.length > boundedLimit;
    const lastRow = pageRows.at(-1);
    const lastUpdatedAt = asNumber(lastRow?.time_updated);
    const lastSessionId = asString(lastRow?.id);
    const pageCursor =
      lastUpdatedAt !== undefined && lastSessionId
        ? { updatedAt: lastUpdatedAt, sessionId: lastSessionId }
        : cursor;

    const strictPageFingerprints = new Map<
      string,
      { updatedAt: number; value: string }
    >();
    if (hasMore) {
      const pageEntries = pageRows.flatMap((row) => {
        const sessionId = asString(row.id);
        const updatedAt = asNumber(row.time_updated);
        return sessionId && updatedAt !== undefined
          ? [{ sessionId, updatedAt }]
          : [];
      });
      const digests = await this.loadSessionDigests(
        pageEntries.map((entry) => entry.sessionId),
      );
      for (const entry of pageEntries) {
        const value = digests.get(entry.sessionId);
        if (value === undefined) continue;
        strictPageFingerprints.set(entry.sessionId, {
          updatedAt: entry.updatedAt,
          value,
        });
      }
    }

    // A strict `(timestamp, id)` cursor can permanently skip a transaction
    // stamped at the cursor time but committed after the scan, including a
    // second write to the same session in the same millisecond. Replay a
    // short window only after strict pagination is drained. Session updates
    // are idempotent, so at-least-once delivery is safer than deduping state
    // that could lose a retry when downstream event emission fails.
    const replayFloor = Math.max(
      0,
      pageCursor.updatedAt - INCREMENTAL_REPLAY_OVERLAP_MS,
    );
    const replayRows = hasMore
      ? []
      : await querySqliteRowsOrEmpty(
          this.dbPath,
          ZCODE_SESSION_CHANGE_REPLAY_SQL,
          [
            replayFloor,
            replayFloor,
            replayFloor,
            replayFloor,
            pageCursor.updatedAt,
            pageCursor.updatedAt,
            pageCursor.sessionId,
          ],
          { label: "zcode.scanSessionChanges.replay" },
        );

    // Only sessions with a recorded fingerprint can be suppressed, so the
    // digest read is scoped to those instead of every replayed row.
    const comparableSessionIds = replayRows.flatMap((row) => {
      const sessionId = asString(row.id);
      return sessionId && replayFingerprints.has(sessionId) ? [sessionId] : [];
    });
    const currentDigests = await this.loadSessionDigests(comparableSessionIds);

    const changesBySession = new Map<string, ZCodeSessionChange>();
    const skipped = { archived: 0, child: 0, invalidDirectory: 0 };

    const collectChange = (
      row: Record<string, unknown>,
      countSkipped: boolean,
    ) => {
      const sessionId = asString(row.id);
      const updatedAt = asNumber(row.time_updated);
      // The SQL constraints make these fields non-null. Keep the guard so a
      // malformed legacy database cannot leak an invalid EventBus event.
      if (!sessionId || updatedAt === undefined) return;

      if (row.time_archived !== null && row.time_archived !== undefined) {
        if (countSkipped) skipped.archived += 1;
        return;
      }
      if (asString(row.task_type) === "subagent_child") {
        if (countSkipped) skipped.child += 1;
        return;
      }

      const directory = asString(row.directory)?.trim();
      if (!directory) {
        if (countSkipped) skipped.invalidDirectory += 1;
        return;
      }
      changesBySession.set(sessionId, { sessionId, directory, updatedAt });
    };

    for (const row of replayRows) {
      const sessionId = asString(row.id);
      // Earlier strict pages in this same pagination chain were already
      // delivered before their cursor became the input cursor. Suppress an
      // unchanged replay; the digest still moves when a second write lands in
      // the same millisecond, so that case is delivered.
      const priorFingerprint = sessionId
        ? replayFingerprints.get(sessionId)
        : undefined;
      if (
        sessionId &&
        priorFingerprint !== undefined &&
        priorFingerprint.value === currentDigests.get(sessionId)
      ) {
        continue;
      }
      collectChange(row, false);
    }
    for (const row of pageRows) collectChange(row, true);

    const changes = [...changesBySession.values()].sort(
      (a, b) =>
        a.updatedAt - b.updatedAt || a.sessionId.localeCompare(b.sessionId),
    );
    // Move a fully-drained watermark to this scan's start time. The monitor
    // only adopts it after successful event processing, so a failed emit
    // still retries the same overlap. Advancing it also ages idle rows out
    // of the overlap instead of replaying them forever.
    const nextCursor =
      !hasMore && scanStartedAt > pageCursor.updatedAt
        ? { updatedAt: scanStartedAt, sessionId: "" }
        : pageCursor;

    const value: ZCodeSessionChangeScanResult = {
      changes,
      scannedRows: pageRows.length,
      skipped,
      nextCursor,
      hasMore,
    };

    if (value.hasMore) {
      const fingerprints = new Map([
        ...replayFingerprints,
        ...strictPageFingerprints,
      ]);
      const fingerprintFloor =
        value.nextCursor.updatedAt - INCREMENTAL_REPLAY_OVERLAP_MS;
      for (const [sessionId, fingerprint] of fingerprints) {
        if (fingerprint.updatedAt < fingerprintFloor) {
          fingerprints.delete(sessionId);
        }
      }
      this.incrementalReplayState = {
        expectedCursorKey: JSON.stringify([
          value.nextCursor.updatedAt,
          value.nextCursor.sessionId,
        ]),
        fingerprints,
      };
    } else {
      this.incrementalReplayState = null;
    }
    return value;
  }

  /**
   * Read change digests for a bounded set of sessions in one worker round trip.
   *
   * These digests are computed in their own snapshot rather than alongside the
   * page/replay query. That can only make a digest *newer* than the row that
   * triggered it, which at worst suppresses a replay for a change the consumer
   * will already observe when it re-reads the session — the monitor delivers
   * notifications, not payloads.
   */
  private async loadSessionDigests(
    sessionIds: readonly string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(sessionIds)];
    if (uniqueIds.length === 0) return new Map();

    const statements: SqliteStatement[] = uniqueIds.map((sessionId) => ({
      sql: SESSION_DIGEST_SQL,
      params: [sessionId],
      mode: "get" as const,
    }));
    const result = await runSqliteStatements(this.dbPath, statements, {
      label: "zcode.scanSessionChanges.digest",
    });
    if (!result.ok) return new Map();

    const digests = new Map<string, string>();
    for (const [index, sessionId] of uniqueIds.entries()) {
      const row = result.value[index];
      if (!row || typeof row !== "object") continue;
      digests.set(
        sessionId,
        sessionDigestFromRow(row as Record<string, unknown>),
      );
    }
    return digests;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async scanProjects(): Promise<ZCodeProjectInfo[]> {
    const now = Date.now();
    if (
      this.cachedProjects &&
      now - this.cachedProjects.timestamp < SCAN_CACHE_TTL
    ) {
      return this.cachedProjects.result;
    }

    const rows = await querySqliteRowsOrEmpty(
      this.dbPath,
      SCAN_PROJECTS_SQL,
      [],
      { label: "zcode.scanProjects" },
    );

    const result: ZCodeProjectInfo[] = rows.map((row) => {
      const directory = String(row.directory ?? "");
      const sessionCount =
        typeof row.session_count === "number" ? row.session_count : 0;
      const lastUpdated =
        typeof row.last_updated === "number" &&
        Number.isFinite(row.last_updated)
          ? row.last_updated
          : null;
      return {
        path: directory,
        sessionCount,
        lastActivity: lastUpdated ? new Date(lastUpdated).toISOString() : null,
      };
    });

    this.cachedProjects = { result, timestamp: now };
    return result;
  }
}

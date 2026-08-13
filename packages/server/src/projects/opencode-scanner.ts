import { basename } from "node:path";
import {
  OPENCODE_DB_PATH,
  type OpenCodeDbFailureReason,
  type OpenCodeDbStatement,
  queryOpenCodeRows,
  queryOpenCodeRowsOrEmpty,
  runOpenCodeDbStatements,
} from "../sessions/opencode-db.js";
import { invalidateOpenCodeSessionStatsCache } from "../sessions/opencode-reader.js";
import { isGenericProviderTitle } from "../sessions/provider-title-quality.js";
import type { Project } from "../supervisor/types.js";
import { canonicalizeProjectPath, encodeProjectId } from "./paths.js";

export { OPENCODE_DB_PATH };

interface OpenCodeProjectInfo {
  path: string;
  sessionCount: number;
  lastActivity: string | null;
}

export interface OpenCodeSessionInfo {
  id: string;
  directory: string;
  filePath: string;
  timestamp: string;
  mtime: number;
}

export interface OpenCodeScannerOptions {
  dbPath?: string;
}

export interface OpenCodeSessionChangeCursor {
  updatedAt: number;
  sessionId: string;
}

export interface OpenCodeSessionChange {
  sessionId: string;
  directory: string;
  /** Max update time observed across the session, message, and part rows. */
  updatedAt: number;
}

export interface OpenCodeSessionChangeScanResult {
  changes: OpenCodeSessionChange[];
  /** Number of cursor rows consumed, including filtered rows. */
  scannedRows: number;
  skipped: {
    archived: number;
    child: number;
    invalidDirectory: number;
  };
  nextCursor: OpenCodeSessionChangeCursor;
  hasMore: boolean;
}

export interface OpenCodeInvalidTitleSessionInfo {
  sessionId: string;
  directory: string;
  title: string;
  updatedAt: number;
}

export class OpenCodeSessionScanError extends Error {
  readonly reason: OpenCodeDbFailureReason;
  readonly detail: unknown;

  constructor(reason: OpenCodeDbFailureReason, detail?: unknown) {
    super(`OpenCode session scan failed: ${reason}`);
    this.name = "OpenCodeSessionScanError";
    this.reason = reason;
    this.detail = detail;
  }
}

const SCAN_CACHE_TTL = 5_000;
const MAX_INCREMENTAL_SCAN_LIMIT = 1_000;
const INCREMENTAL_REPLAY_OVERLAP_MS = 1_000;
const MAX_RECENT_INVALID_TITLE_CANDIDATES = 100;
const MAX_RECENT_INVALID_TITLE_SCAN_ROWS = 2_000;

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
 * This used to `SELECT *` every message and part of the session and
 * `JSON.stringify` the lot, i.e. it read (and serialized) the session's entire
 * payload just to answer "did anything change?". The aggregate below keeps the
 * property that actually matters — a second write inside the same millisecond
 * still changes the digest — because such a write alters at least one of the
 * row count, the maximum row id, the maximum `time_updated`, or the total
 * payload length.
 *
 * A same-millisecond, same-row, byte-length-preserving edit is the one case
 * the old full-row comparison caught and this does not. That trades an
 * extremely unlikely missed suppression-bypass for not reading megabytes of
 * JSON on every drained page.
 */
export const SESSION_DIGEST_SQL = `
  SELECT
    s.id AS id,
    s.time_updated AS session_updated,
    (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count,
    (SELECT MAX(m.id) FROM message m WHERE m.session_id = s.id) AS message_max_id,
    (SELECT MAX(m.time_updated) FROM message m WHERE m.session_id = s.id) AS message_updated,
    (SELECT SUM(LENGTH(m.data)) FROM message m WHERE m.session_id = s.id) AS message_bytes,
    (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id) AS part_count,
    (SELECT MAX(p.id) FROM part p WHERE p.session_id = s.id) AS part_max_id,
    (SELECT MAX(p.time_updated) FROM part p WHERE p.session_id = s.id) AS part_updated,
    (SELECT SUM(LENGTH(p.data)) FROM part p WHERE p.session_id = s.id) AS part_bytes
  FROM session s
  WHERE s.id = ?
`;

function digestFromRow(row: Record<string, unknown> | null): string {
  if (!row) return "";
  return JSON.stringify([
    row.session_updated ?? null,
    row.message_count ?? 0,
    row.message_max_id ?? null,
    row.message_updated ?? null,
    row.message_bytes ?? 0,
    row.part_count ?? 0,
    row.part_max_id ?? null,
    row.part_updated ?? null,
    row.part_bytes ?? 0,
  ]);
}

/**
 * Strict `(time_updated, id)` page of changed sessions.
 *
 * Exported so tests can pin its `EXPLAIN QUERY PLAN` and fail if the plan ever
 * regresses to `SCAN message` / `SCAN part`.
 */
export const SESSION_CHANGE_PAGE_SQL = `
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
    session.time_archived
  FROM page
  LEFT JOIN session ON session.id = page.session_id
  ORDER BY page.effective_updated_at ASC, page.session_id ASC
`;

/**
 * Bounded replay window used once strict pagination is drained.
 *
 * The `time_updated >= ?` floor is repeated inside every UNION branch, not only
 * on the aggregate. Without it this CTE aggregated `session`, `message` and
 * `part` in full on every drained poll. Pushing the floor down is
 * result-preserving: a session whose MAX(time_updated) clears the floor
 * necessarily owns at least one row that also clears it, and that row carries
 * the same maximum.
 */
export const SESSION_CHANGE_REPLAY_SQL = `
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

export class OpenCodeSessionScanner {
  private dbPath: string;
  private cachedProjects: {
    result: OpenCodeProjectInfo[];
    timestamp: number;
  } | null = null;
  private incrementalReplayState: {
    expectedCursorKey: string;
    fingerprints: Map<string, { updatedAt: number; value: string }>;
  } | null = null;

  constructor(options: OpenCodeScannerOptions = {}) {
    this.dbPath = options.dbPath ?? OPENCODE_DB_PATH;
  }

  get databasePath(): string {
    return this.dbPath;
  }

  invalidateCache(): void {
    this.cachedProjects = null;
    // The per-project session-stats snapshot reads the same shared DB, so a
    // change that invalidates the project list must also drop the snapshot.
    invalidateOpenCodeSessionStatsCache(this.dbPath);
  }

  async listProjects(): Promise<Project[]> {
    const projectInfos = await this.scanProjects();
    return projectInfos
      .map((info) => {
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
          provider: "opencode" as const,
        };
      })
      .sort((a, b) => {
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return (
          new Date(b.lastActivity).getTime() -
          new Date(a.lastActivity).getTime()
        );
      });
  }

  async getSessionsForProject(
    projectPath: string,
  ): Promise<OpenCodeSessionInfo[]> {
    const canonicalProjectPath = canonicalizeProjectPath(projectPath);
    const rows = await queryOpenCodeRowsOrEmpty(
      this.dbPath,
      `
        SELECT id, directory, time_updated
        FROM session
        WHERE directory = ? AND time_archived IS NULL
        ORDER BY time_updated DESC
      `,
      [canonicalProjectPath],
      { label: "opencode.getSessionsForProject" },
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
      .filter((item): item is OpenCodeSessionInfo => item !== null);
  }

  /**
   * Consume changed OpenCode session rows in stable `(time_updated, id)` order.
   *
   * The cursor advances across filtered archived/child rows too. Otherwise a
   * busy child session at the head of the result set could be revisited on
   * every poll and starve later user-visible sessions.
   */
  async scanSessionChanges(
    cursor: OpenCodeSessionChangeCursor,
    limit: number,
  ): Promise<OpenCodeSessionChangeScanResult> {
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

    const pageResult = await queryOpenCodeRows(
      this.dbPath,
      SESSION_CHANGE_PAGE_SQL,
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
      { label: "opencode.scanSessionChanges.page" },
    );
    if (!pageResult.ok) {
      throw new OpenCodeSessionScanError(pageResult.reason, pageResult.error);
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
      : await queryOpenCodeRowsOrEmpty(
          this.dbPath,
          SESSION_CHANGE_REPLAY_SQL,
          [
            replayFloor,
            replayFloor,
            replayFloor,
            replayFloor,
            pageCursor.updatedAt,
            pageCursor.updatedAt,
            pageCursor.sessionId,
          ],
          { label: "opencode.scanSessionChanges.replay" },
        );

    // Only sessions with a recorded fingerprint can be suppressed, so the
    // digest read is scoped to those instead of every replayed row.
    const comparableSessionIds = replayRows.flatMap((row) => {
      const sessionId = asString(row.id);
      return sessionId && replayFingerprints.has(sessionId) ? [sessionId] : [];
    });
    const currentDigests = await this.loadSessionDigests(comparableSessionIds);

    const changesBySession = new Map<string, OpenCodeSessionChange>();
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
      if (row.parent_id !== null && row.parent_id !== undefined) {
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

    const value: OpenCodeSessionChangeScanResult = {
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

    const statements: OpenCodeDbStatement[] = uniqueIds.map((sessionId) => ({
      sql: SESSION_DIGEST_SQL,
      params: [sessionId],
      mode: "get" as const,
    }));
    const result = await runOpenCodeDbStatements(this.dbPath, statements, {
      label: "opencode.scanSessionChanges.digest",
    });
    if (!result.ok) return new Map();

    const digests = new Map<string, string>();
    for (const [index, sessionId] of uniqueIds.entries()) {
      const row = result.value[index];
      if (!row || typeof row !== "object") continue;
      digests.set(sessionId, digestFromRow(row as Record<string, unknown>));
    }
    return digests;
  }

  /**
   * Find a bounded set of recent top-level sessions whose provider title is
   * generic/invalid. This only prioritizes normal startup backfill and never
   * mutates the OpenCode database. Sessions already titled in Yep are excluded
   * before filling the bounded candidate list.
   */
  async listRecentInvalidTitleSessions(
    updatedAfterMs: number,
    limit: number,
    excludedSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<OpenCodeInvalidTitleSessionInfo[]> {
    const boundedLimit = Math.min(
      MAX_RECENT_INVALID_TITLE_CANDIDATES,
      Math.max(0, Math.floor(limit)),
    );
    if (boundedLimit === 0) return [];

    // SQLite cannot reuse the conservative TypeScript quality matcher. Read a
    // capped recent window, then apply the shared helper in process. The cap
    // prevents an unbounded historical migration while still looking beyond
    // the final candidate count for sparse invalid titles.
    const scanLimit = Math.min(
      MAX_RECENT_INVALID_TITLE_SCAN_ROWS,
      Math.max(boundedLimit, boundedLimit * 20),
    );
    const result = await queryOpenCodeRows(
      this.dbPath,
      `
        SELECT id, directory, title, time_updated
        FROM session
        WHERE time_updated >= ?
          AND time_archived IS NULL
          AND parent_id IS NULL
          AND directory IS NOT NULL
          AND directory != ''
        ORDER BY time_updated DESC, id DESC
        LIMIT ?
      `,
      [updatedAfterMs, scanLimit],
      { label: "opencode.listRecentInvalidTitleSessions" },
    );
    if (!result.ok) {
      throw new OpenCodeSessionScanError(result.reason, result.error);
    }

    const invalid: OpenCodeInvalidTitleSessionInfo[] = [];
    for (const row of result.value) {
      const sessionId = asString(row.id);
      const directory = asString(row.directory)?.trim();
      const title = asString(row.title)?.trim();
      const updatedAt = asNumber(row.time_updated);
      if (!sessionId || !directory || !title || updatedAt === undefined) {
        continue;
      }
      if (excludedSessionIds.has(sessionId)) continue;
      if (!isGenericProviderTitle(title)) continue;
      invalid.push({ sessionId, directory, title, updatedAt });
      if (invalid.length >= boundedLimit) break;
    }
    return invalid;
  }

  private async scanProjects(): Promise<OpenCodeProjectInfo[]> {
    if (
      this.cachedProjects &&
      Date.now() - this.cachedProjects.timestamp < SCAN_CACHE_TTL
    ) {
      return this.cachedProjects.result;
    }

    const rows = await queryOpenCodeRowsOrEmpty(
      this.dbPath,
      `
        SELECT
          directory,
          COUNT(CASE WHEN parent_id IS NULL THEN 1 END) AS session_count,
          MAX(time_updated) AS last_updated
        FROM session
        WHERE directory IS NOT NULL
          AND directory != ''
          AND time_archived IS NULL
        GROUP BY directory
      `,
      [],
      { label: "opencode.scanProjects" },
    );

    const result = rows
      .map((row) => {
        const rawPath = asString(row.directory);
        const sessionCount = asNumber(row.session_count) ?? 0;
        const lastUpdated = asNumber(row.last_updated);
        if (!rawPath || sessionCount <= 0) return null;

        return {
          path: canonicalizeProjectPath(rawPath),
          sessionCount,
          lastActivity:
            lastUpdated !== undefined
              ? new Date(lastUpdated).toISOString()
              : null,
        };
      })
      .filter((item): item is OpenCodeProjectInfo => item !== null);

    this.cachedProjects = { result, timestamp: Date.now() };
    return result;
  }
}

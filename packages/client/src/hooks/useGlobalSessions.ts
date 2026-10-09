import {
  type SessionKind,
  collapseEditForkFamilies,
  getSessionArchiveBlock,
  sessionMatchesKind,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GlobalSessionItem,
  type GlobalSessionStats,
  type ProjectOption,
  api,
} from "../api/client";
import {
  type ProcessStateEvent,
  type SessionCreatedEvent,
  type SessionMetadataChangedEvent,
  type SessionSeenEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
  useFileActivity,
} from "./useFileActivity";

const REFETCH_DEBOUNCE_MS = 500;
const PENDING_TITLE_REFETCH_DELAYS_MS = [1500, 4000, 8000] as const;

function hasResolvedTitle(session: {
  customTitle?: string | null;
  aiTitle?: string | null;
  title?: string | null;
}): boolean {
  return Boolean(
    (session.customTitle ?? session.aiTitle ?? session.title)?.trim(),
  );
}

function needsPendingTitleRefetch(session: {
  customTitle?: string | null;
  aiTitle?: string | null;
  title?: string | null;
  messageCount?: number;
}): boolean {
  return !hasResolvedTitle(session) || session.messageCount === 0;
}

function matchesSessionKindFilters(
  session: { customTitle?: string | null; title?: string | null },
  options: {
    sessionKind?: SessionKind | null;
    excludeSessionKind?: SessionKind | null;
  },
): boolean {
  if (
    options.sessionKind &&
    !sessionMatchesKind(session, options.sessionKind)
  ) {
    return false;
  }

  if (
    options.excludeSessionKind &&
    sessionMatchesKind(session, options.excludeSessionKind)
  ) {
    return false;
  }

  return true;
}

function mergeFetchedSession(
  existing: GlobalSessionItem,
  incoming: GlobalSessionItem,
): GlobalSessionItem {
  if (hasResolvedTitle(existing) && !hasResolvedTitle(incoming)) {
    return {
      ...incoming,
      title: existing.title,
      customTitle: existing.customTitle ?? incoming.customTitle,
      aiTitle: existing.aiTitle ?? incoming.aiTitle,
    };
  }

  return incoming;
}

function isBusyActivity(activity: GlobalSessionItem["activity"]): boolean {
  return (
    activity === "in-turn" ||
    activity === "waiting-input" ||
    activity === "hold"
  );
}

function updateRuntimeSnapshot(
  session: GlobalSessionItem,
  ownership: GlobalSessionItem["ownership"],
  activity: GlobalSessionItem["activity"],
): GlobalSessionItem["runtime"] {
  const isBusy = isBusyActivity(activity) || ownership.owner === "external";
  const block = isBusy ? getSessionArchiveBlock(ownership, activity) : {};
  return {
    ...session.runtime,
    ownership,
    activity,
    isBusy,
    hasResidentWorker: ownership.owner === "self" && activity === "idle",
    canArchive: !isBusy,
    archiveBlockCode: block.archiveBlockCode,
    archiveBlockReason: block.archiveBlockReason,
  };
}

export interface UseGlobalSessionsOptions {
  projectId?: string | null;
  searchQuery?: string;
  limit?: number;
  includeArchived?: boolean;
  sessionKind?: SessionKind | null;
  excludeSessionKind?: SessionKind | null;
  includeStats?: boolean;
  /** Append pinned sessions that fall outside the ordinary page limit. */
  includePinned?: boolean;
  /**
   * Ask the server to keep at least one session per project that was active
   * within the last N days, even when the global `limit` would drop it.
   */
  projectCoverageDays?: number;
  /** Skip initial fetch and live refetches while the consuming UI is hidden. */
  enabled?: boolean;
  /** Subscribe to live session activity and reconnect refreshes. */
  liveUpdates?: boolean;
  /** Subscribe to session metadata changes for single-session updates. */
  metadataLiveUpdates?: boolean;
}

/** Default stats when no data loaded */
const DEFAULT_STATS: GlobalSessionStats = {
  totalCount: 0,
  unreadCount: 0,
  starredCount: 0,
  archivedCount: 0,
  providerCounts: {},
  executorCounts: {},
};

export function useGlobalSessions(options: UseGlobalSessionsOptions = {}) {
  const {
    projectId,
    searchQuery,
    limit,
    includeArchived,
    sessionKind,
    excludeSessionKind,
    includeStats = false,
    includePinned = false,
    projectCoverageDays,
    enabled = true,
    liveUpdates = true,
    metadataLiveUpdates = liveUpdates,
  } = options;
  const [sessions, setSessions] = useState<GlobalSessionItem[]>([]);
  const [stats, setStats] = useState<GlobalSessionStats>(DEFAULT_STATS);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const nextCursorRef = useRef<string | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTitleRefetchTimersRef = useRef<
    Map<string, Set<ReturnType<typeof setTimeout>>>
  >(new Map());
  const latestFetchRef = useRef<(() => Promise<void>) | null>(null);
  const latestRefreshSessionRef = useRef<
    ((sessionId: string, projectId: string) => Promise<void>) | null
  >(null);
  const sessionRefreshTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const sessionRefreshesRef = useRef(new Map<string, { dirty: boolean }>());
  const latestRefreshStatsRef = useRef<(() => Promise<void>) | null>(null);
  const hasInitialLoadRef = useRef(false);
  const sessionsRef = useRef<GlobalSessionItem[]>([]);
  sessionsRef.current = sessions;
  const projectsRef = useRef<ProjectOption[]>([]);
  projectsRef.current = projects;

  // Track the options used for the last fetch (for loadMore pagination)
  const lastFetchOptionsRef = useRef<{
    projectId?: string | null;
    searchQuery?: string;
    limit?: number;
    includeArchived?: boolean;
    sessionKind?: SessionKind | null;
    excludeSessionKind?: SessionKind | null;
    includeStats?: boolean;
    includePinned?: boolean;
    projectCoverageDays?: number;
    enabled?: boolean;
  }>({});

  const clearPendingTitleRefetch = useCallback((sessionId: string) => {
    const timers = pendingTitleRefetchTimersRef.current.get(sessionId);
    if (!timers) return;

    for (const timer of timers) {
      clearTimeout(timer);
    }
    pendingTitleRefetchTimersRef.current.delete(sessionId);
  }, []);

  const refreshStats = useCallback(async () => {
    if (!enabled || !includeStats || projectId) {
      setStats(DEFAULT_STATS);
      return;
    }

    try {
      const data = await api.getGlobalSessionStats();
      setStats(data.stats ?? DEFAULT_STATS);
    } catch {
      // Keep the sessions list usable if the non-critical counts request fails.
      setStats(DEFAULT_STATS);
    }
  }, [enabled, includeStats, projectId]);
  latestRefreshStatsRef.current = refreshStats;

  const fetch = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }

    // Reset initial load flag when options change
    const optionsChanged =
      lastFetchOptionsRef.current.projectId !== projectId ||
      lastFetchOptionsRef.current.searchQuery !== searchQuery ||
      lastFetchOptionsRef.current.includeArchived !== includeArchived ||
      lastFetchOptionsRef.current.sessionKind !== sessionKind ||
      lastFetchOptionsRef.current.excludeSessionKind !== excludeSessionKind ||
      lastFetchOptionsRef.current.includeStats !== includeStats ||
      lastFetchOptionsRef.current.includePinned !== includePinned ||
      lastFetchOptionsRef.current.projectCoverageDays !== projectCoverageDays ||
      lastFetchOptionsRef.current.enabled !== enabled;

    if (optionsChanged) {
      hasInitialLoadRef.current = false;
    }

    lastFetchOptionsRef.current = {
      projectId,
      searchQuery,
      limit,
      includeArchived,
      sessionKind,
      excludeSessionKind,
      includeStats,
      includePinned,
      projectCoverageDays,
      enabled,
    };

    // Only show loading state on initial load
    if (sessionsRef.current.length === 0 || optionsChanged) {
      setLoading(true);
    }
    setError(null);

    try {
      const data = await api.getGlobalSessions({
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        includeArchived,
        includeStats: false,
        kind: sessionKind ?? undefined,
        excludeKind: excludeSessionKind ?? undefined,
        includePinned,
        projectCoverageDays,
      });

      for (const session of data.sessions) {
        if (hasResolvedTitle(session)) {
          clearPendingTitleRefetch(session.id);
        }
      }

      if (!hasInitialLoadRef.current || optionsChanged) {
        setSessions(data.sessions);
        hasInitialLoadRef.current = true;
      } else {
        // On refetch, preserve order and update in-place
        setSessions((prev) => {
          const newDataMap = new Map(data.sessions.map((s) => [s.id, s]));

          // Update existing sessions in their current order
          const updated = prev.map((existing) => {
            const newData = newDataMap.get(existing.id);
            return newData ? mergeFetchedSession(existing, newData) : existing;
          });

          // Filter out sessions that no longer exist
          const filtered = updated.filter((s) => newDataMap.has(s.id));

          // Add any new sessions at the top
          const existingIds = new Set(prev.map((s) => s.id));
          const newSessions = data.sessions.filter(
            (s) => !existingIds.has(s.id),
          );

          return [...newSessions, ...filtered];
        });
      }

      setHasMore(data.hasMore);
      nextCursorRef.current = data.hasMore
        ? (data.nextCursor ?? data.sessions.at(-1)?.updatedAt ?? null)
        : null;
      if (!includeStats || projectId) {
        setStats(DEFAULT_STATS);
      }
      setProjects(data.projects);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [
    projectId,
    searchQuery,
    limit,
    includeArchived,
    sessionKind,
    excludeSessionKind,
    includeStats,
    includePinned,
    projectCoverageDays,
    enabled,
    clearPendingTitleRefetch,
  ]);
  latestFetchRef.current = fetch;

  // Fixed windows coalesce bursts without postponing updates indefinitely.
  // An in-flight request gets at most one follow-up when newer events arrive.
  const queueSessionRefresh = useCallback(
    (sessionId: string, refreshProjectId: string) => {
      const pending = sessionRefreshesRef.current.get(sessionId);
      if (pending) {
        pending.dirty = true;
        return;
      }
      if (sessionRefreshTimersRef.current.has(sessionId)) return;
      const timer = setTimeout(() => {
        sessionRefreshTimersRef.current.delete(sessionId);
        void latestRefreshSessionRef.current?.(sessionId, refreshProjectId);
      }, REFETCH_DEBOUNCE_MS);
      sessionRefreshTimersRef.current.set(sessionId, timer);
    },
    [],
  );

  const invalidateSessionRefresh = useCallback((sessionId: string) => {
    const pending = sessionRefreshesRef.current.get(sessionId);
    if (pending) pending.dirty = true;
  }, []);

  const schedulePendingTitleRefetch = useCallback(
    (sessionId: string, refreshProjectId: string) => {
      if (pendingTitleRefetchTimersRef.current.has(sessionId)) return;

      const timers = new Set<ReturnType<typeof setTimeout>>();
      pendingTitleRefetchTimersRef.current.set(sessionId, timers);

      for (const delayMs of PENDING_TITLE_REFETCH_DELAYS_MS) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (timers.size === 0) {
            pendingTitleRefetchTimersRef.current.delete(sessionId);
          }
          void latestRefreshSessionRef.current?.(sessionId, refreshProjectId);
        }, delayMs);
        timers.add(timer);
      }
    },
    [],
  );

  const refreshSessionMetadata = useCallback(
    async (sessionId: string, refreshProjectId: string) => {
      if (!enabled || (projectId && projectId !== refreshProjectId)) return;
      if (searchQuery) {
        await latestFetchRef.current?.();
        return;
      }
      const pending = sessionRefreshesRef.current.get(sessionId);
      if (pending) {
        pending.dirty = true;
        return;
      }
      const request = { dirty: false };
      sessionRefreshesRef.current.set(sessionId, request);

      try {
        const data = await api.getSessionMetadata(refreshProjectId, sessionId);
        // Hidden/unmounted lists and changed filters invalidate outstanding work.
        // Never let a snapshot requested before a live event undo that event.
        if (
          sessionRefreshesRef.current.get(sessionId) !== request ||
          request.dirty
        )
          return;

        if (hasResolvedTitle(data.session)) {
          clearPendingTitleRefetch(sessionId);
        }

        setSessions((prev) => {
          const existing = prev.find((session) => session.id === sessionId);
          const project = projectsRef.current.find(
            (p) => p.id === data.session.projectId,
          );
          const refreshed: GlobalSessionItem = {
            ...existing,
            ...data.session,
            projectName:
              existing?.projectName ?? project?.name ?? data.session.projectId,
            ownership: data.ownership,
            customTitle: data.session.customTitle,
            aiTitle: data.session.aiTitle,
            runtime: data.runtime ?? data.session.runtime,
            activity:
              data.runtime?.activity ??
              data.session.runtime?.activity ??
              data.session.activity,
            pendingInputType: data.session.pendingInputType,
            hasUnread: data.session.hasUnread ?? existing?.hasUnread,
            isArchived: data.session.isArchived ?? false,
            isStarred: data.session.isStarred ?? false,
            lastTurnStatus: data.session.lastTurnStatus,
            lastErrorMessage: data.session.lastErrorMessage,
            retryStatus: data.session.retryStatus,
          };
          const next = existing
            ? mergeFetchedSession(existing, refreshed)
            : refreshed;
          const matches =
            (includeArchived || !next.isArchived) &&
            matchesSessionKindFilters(next, {
              sessionKind,
              excludeSessionKind,
            });
          if (!matches)
            return existing
              ? prev.filter((session) => session.id !== sessionId)
              : prev;
          if (!existing) return collapseEditForkFamilies([next, ...prev]);
          return collapseEditForkFamilies(
            prev.map((session) => (session.id === sessionId ? next : session)),
          );
        });
      } catch {
        // Keep the last usable card. A later event/title retry or explicit
        // refresh can recover; a failed single lookup must not fan out globally.
      } finally {
        if (sessionRefreshesRef.current.get(sessionId) === request) {
          sessionRefreshesRef.current.delete(sessionId);
          if (request.dirty) queueSessionRefresh(sessionId, refreshProjectId);
        }
      }
    },
    [
      clearPendingTitleRefetch,
      enabled,
      projectId,
      searchQuery,
      includeArchived,
      excludeSessionKind,
      sessionKind,
      queueSessionRefresh,
    ],
  );
  latestRefreshSessionRef.current = refreshSessionMetadata;

  // Load more sessions (pagination)
  const loadMore = useCallback(async () => {
    if (!enabled || !hasMore || sessions.length === 0) return;

    const nextCursor = nextCursorRef.current;
    if (!nextCursor) return;

    try {
      const data = await api.getGlobalSessions({
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        after: nextCursor,
        includeArchived,
        includeStats: false,
        kind: sessionKind ?? undefined,
        excludeKind: excludeSessionKind ?? undefined,
      });

      setSessions((prev) => {
        // Deduplicate when appending
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = data.sessions.filter((s) => !existingIds.has(s.id));
        return collapseEditForkFamilies([...prev, ...newSessions]);
      });

      setHasMore(data.hasMore);
      nextCursorRef.current = data.hasMore
        ? (data.nextCursor ?? data.sessions.at(-1)?.updatedAt ?? null)
        : null;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [
    hasMore,
    sessions,
    projectId,
    searchQuery,
    limit,
    includeArchived,
    sessionKind,
    excludeSessionKind,
    enabled,
  ]);

  // Debounced refetch
  const debouncedRefetch = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = setTimeout(() => {
      fetch();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetch]);

  const handleReconnect = useCallback(() => {
    void latestRefreshStatsRef.current?.();
    return fetch();
  }, [fetch]);

  // Handle session ownership changes
  const handleSessionStatusChange = useCallback(
    (event: SessionStatusEvent) => {
      if (!enabled || (projectId && event.projectId !== projectId)) return;
      invalidateSessionRefresh(event.sessionId);
      if (
        !sessionsRef.current.some((session) => session.id === event.sessionId)
      ) {
        if (searchQuery) debouncedRefetch();
        else queueSessionRefresh(event.sessionId, event.projectId);
        return;
      }
      if (event.ownership.owner === "none") {
        queueSessionRefresh(event.sessionId, event.projectId);
      }
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== event.sessionId) return session;
          const activity =
            event.ownership.owner === "none"
              ? undefined
              : (event.activity ?? session.activity);
          return {
            ...session,
            ownership: event.ownership,
            pendingInputType:
              event.ownership.owner === "none"
                ? undefined
                : session.pendingInputType,
            activity,
            runtime: updateRuntimeSnapshot(session, event.ownership, activity),
          };
        }),
      );
    },
    [
      enabled,
      projectId,
      searchQuery,
      debouncedRefetch,
      invalidateSessionRefresh,
      queueSessionRefresh,
    ],
  );

  // Handle process state changes
  const handleProcessStateChange = useCallback(
    (event: ProcessStateEvent) => {
      if (!enabled || (projectId && event.projectId !== projectId)) return;
      invalidateSessionRefresh(event.sessionId);
      if (
        !sessionsRef.current.some((session) => session.id === event.sessionId)
      ) {
        if (searchQuery) debouncedRefetch();
        else queueSessionRefresh(event.sessionId, event.projectId);
        return;
      }
      // A terminal activity event contains no updatedAt, usage or unread
      // summary. Reconcile this card even when no session-updated event follows
      // (notably with an external runtime). The queue coalesces duplicate ends.
      if (event.activity === "idle" || event.activity === "terminated") {
        queueSessionRefresh(event.sessionId, event.projectId);
      }
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== event.sessionId) return session;
          const pendingInputType =
            event.activity === "waiting-input"
              ? (event.pendingInputType ?? session.pendingInputType)
              : undefined;
          return {
            ...session,
            activity: event.activity,
            pendingInputType,
            lastTurnStatus: event.lastTurnStatus,
            lastErrorMessage: event.lastErrorMessage,
            retryStatus: event.retryStatus,
            runtime: updateRuntimeSnapshot(
              session,
              session.ownership,
              event.activity,
            ),
          };
        }),
      );
    },
    [
      enabled,
      projectId,
      searchQuery,
      debouncedRefetch,
      invalidateSessionRefresh,
      queueSessionRefresh,
    ],
  );

  // Handle new session created
  const handleSessionCreated = useCallback(
    (event: SessionCreatedEvent) => {
      if (!enabled) return;

      // If we have a project filter, only add sessions from that project
      if (projectId && event.session.projectId !== projectId) return;

      if (
        !matchesSessionKindFilters(event.session, {
          sessionKind,
          excludeSessionKind,
        })
      ) {
        return;
      }

      // If we have a search query, refetch to let server filter
      if (searchQuery) {
        debouncedRefetch();
        return;
      }

      invalidateSessionRefresh(event.session.id);
      if (!includeArchived && event.session.isArchived) return;
      if (needsPendingTitleRefetch(event.session)) {
        schedulePendingTitleRefetch(event.session.id, event.session.projectId);
      }

      setSessions((prev) => {
        // Check for duplicates
        if (prev.some((s) => s.id === event.session.id)) {
          return prev;
        }

        // Look up project name from loaded projects list
        const project = projectsRef.current.find(
          (p) => p.id === event.session.projectId,
        );
        const projectName = project?.name ?? event.session.projectId;

        // Convert SessionSummary to GlobalSessionItem
        const globalSession: GlobalSessionItem = {
          id: event.session.id,
          forkParentSessionId: event.session.forkParentSessionId,
          forkFamilySessionIds: event.session.forkFamilySessionIds,
          title: event.session.title,
          createdAt: event.session.createdAt,
          updatedAt: event.session.updatedAt,
          messageCount: event.session.messageCount,
          provider: event.session.provider,
          projectId: event.session.projectId,
          projectName,
          ownership: event.session.ownership,
          pendingInputType: event.session.pendingInputType,
          activity: event.session.activity,
          runtime: event.session.runtime,
          hasUnread: event.session.hasUnread,
          customTitle: event.session.customTitle,
          aiTitle: event.session.aiTitle,
          isArchived: event.session.isArchived,
          isStarred: event.session.isStarred,
          createdBy: event.session.createdBy,
          originator: event.session.originator,
          source: event.session.source,
          contextUsage: event.session.contextUsage,
          cumulativeUsage: event.session.cumulativeUsage,
          compactCount: event.session.compactCount,
          compactEvents: event.session.compactEvents,
          model: event.session.model,
          reasoningEffort: event.session.reasoningEffort,
          serviceTier: event.session.serviceTier,
          lastTurnStatus: event.session.lastTurnStatus,
          lastErrorMessage: event.session.lastErrorMessage,
        };

        return collapseEditForkFamilies([globalSession, ...prev]);
      });
    },
    [
      projectId,
      searchQuery,
      sessionKind,
      excludeSessionKind,
      includeArchived,
      enabled,
      debouncedRefetch,
      schedulePendingTitleRefetch,
      invalidateSessionRefresh,
    ],
  );

  // Handle session metadata changes
  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      if (
        !enabled ||
        (projectId && event.projectId && event.projectId !== projectId)
      )
        return;
      invalidateSessionRefresh(event.sessionId);
      const pinned = event.pinned ?? event.starred;

      if (event.title?.trim() || event.aiTitle?.trim()) {
        clearPendingTitleRefetch(event.sessionId);
      }

      const existingSession = sessionsRef.current.find(
        (session) => session.id === event.sessionId,
      );
      const refreshProjectId = event.projectId ?? existingSession?.projectId;

      setSessions((prev) => {
        const updated = prev.map((session) => {
          if (session.id !== event.sessionId) return session;
          const nextCustomTitle = event.title?.trim() ? event.title : undefined;
          const nextAiTitle = event.aiTitle?.trim() ? event.aiTitle : undefined;

          return {
            ...session,
            ...(event.title !== undefined && { customTitle: nextCustomTitle }),
            ...(event.aiTitle !== undefined && { aiTitle: nextAiTitle }),
            ...(event.archived !== undefined && { isArchived: event.archived }),
            ...(pinned !== undefined && { isStarred: pinned }),
          };
        });

        const filtered = updated.filter(
          (session) =>
            (includeArchived || !session.isArchived) &&
            matchesSessionKindFilters(session, {
              sessionKind,
              excludeSessionKind,
            }),
        );

        return filtered;
      });

      if (searchQuery) {
        debouncedRefetch();
      } else if (refreshProjectId) {
        queueSessionRefresh(event.sessionId, refreshProjectId);
      } else if (
        (includePinned && pinned !== undefined) ||
        sessionKind ||
        excludeSessionKind
      ) {
        debouncedRefetch();
      }
    },
    [
      includePinned,
      includeArchived,
      projectId,
      sessionKind,
      excludeSessionKind,
      searchQuery,
      enabled,
      debouncedRefetch,
      clearPendingTitleRefetch,
      invalidateSessionRefresh,
      queueSessionRefresh,
    ],
  );

  // Handle session seen events
  const handleSessionSeen = useCallback(
    (event: SessionSeenEvent) => {
      invalidateSessionRefresh(event.sessionId);
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== event.sessionId) return session;

          return {
            ...session,
            hasUnread: event.timestamp === "",
          };
        }),
      );
    },
    [invalidateSessionRefresh],
  );

  // Handle session content updates (auto-generated title, messageCount, contextUsage)
  const handleSessionUpdated = useCallback(
    (event: SessionUpdatedEvent) => {
      if (!enabled || (projectId && event.projectId !== projectId)) return;
      invalidateSessionRefresh(event.sessionId);
      if (searchQuery) {
        debouncedRefetch();
      } else if (
        !sessionsRef.current.some(
          (session) => session.id === event.sessionId,
        ) ||
        Object.keys(event).every((key) =>
          ["type", "sessionId", "projectId", "timestamp", "trigger"].includes(
            key,
          ),
        )
      ) {
        queueSessionRefresh(event.sessionId, event.projectId);
      }

      if (event.title?.trim()) {
        clearPendingTitleRefetch(event.sessionId);
      } else if (event.title === null || event.messageCount === 0) {
        schedulePendingTitleRefetch(event.sessionId, event.projectId);
      }

      setSessions((prev) => {
        const updated = prev.map((session) => {
          if (session.id !== event.sessionId) return session;
          const ignoreUnresolvedTitle =
            event.title !== undefined &&
            !event.title?.trim() &&
            hasResolvedTitle(session);

          return {
            ...session,
            ...(event.title !== undefined &&
              !ignoreUnresolvedTitle && { title: event.title }),
            ...(event.messageCount !== undefined && {
              messageCount: event.messageCount,
            }),
            ...(event.updatedAt !== undefined && {
              updatedAt: event.updatedAt,
            }),
            ...(event.contextUsage !== undefined && {
              contextUsage: event.contextUsage,
            }),
            ...(event.cumulativeUsage !== undefined && {
              cumulativeUsage: event.cumulativeUsage,
            }),
            ...(event.compactCount !== undefined && {
              compactCount: event.compactCount,
            }),
            ...(event.compactEvents !== undefined && {
              compactEvents: event.compactEvents,
            }),
            ...(event.model !== undefined && { model: event.model }),
            ...(event.reasoningEffort !== undefined && {
              reasoningEffort: event.reasoningEffort,
            }),
            ...(event.serviceTier !== undefined && {
              serviceTier: event.serviceTier,
            }),
            ...(event.lastTurnStatus !== undefined && {
              lastTurnStatus: event.lastTurnStatus ?? undefined,
            }),
            ...(event.lastErrorMessage !== undefined && {
              lastErrorMessage: event.lastErrorMessage ?? undefined,
            }),
          };
        });

        return updated.filter((session) =>
          matchesSessionKindFilters(session, {
            sessionKind,
            excludeSessionKind,
          }),
        );
      });
    },
    [
      clearPendingTitleRefetch,
      schedulePendingTitleRefetch,
      invalidateSessionRefresh,
      queueSessionRefresh,
      projectId,
      searchQuery,
      sessionKind,
      excludeSessionKind,
      enabled,
      debouncedRefetch,
    ],
  );

  // Subscribe to SSE events
  useFileActivity({
    enabled: enabled && (liveUpdates || metadataLiveUpdates),
    onSessionStatusChange: liveUpdates ? handleSessionStatusChange : undefined,
    onSessionCreated: liveUpdates ? handleSessionCreated : undefined,
    onProcessStateChange: liveUpdates ? handleProcessStateChange : undefined,
    onSessionMetadataChange: metadataLiveUpdates
      ? handleSessionMetadataChange
      : undefined,
    // Seen/unread is a metadata-level change (like title/pinned), not a
    // high-frequency process activity. Bind it to metadataLiveUpdates so the
    // metadata-only consumers still clear the unread dot via a single-item
    // update instead of waiting for a full refetch.
    onSessionSeen: metadataLiveUpdates ? handleSessionSeen : undefined,
    onSessionUpdated: liveUpdates ? handleSessionUpdated : undefined,
    onReconnect: liveUpdates ? handleReconnect : undefined,
  });

  // Initial fetch and refetch when options change
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    fetch();
  }, [enabled, fetch]);

  // Global counts are fetched independently so the sessions list can use the
  // server's early-stop path instead of forcing a full stats scan.
  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  // Cancel work belonging to the old visible list, including late responses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these options define the lifetime of queued requests.
  useEffect(() => {
    return () => {
      for (const timer of sessionRefreshTimersRef.current.values())
        clearTimeout(timer);
      sessionRefreshTimersRef.current.clear();
      sessionRefreshesRef.current.clear();
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
      }
      for (const timers of pendingTitleRefetchTimersRef.current.values()) {
        for (const timer of timers) {
          clearTimeout(timer);
        }
      }
      pendingTitleRefetchTimersRef.current.clear();
    };
  }, [
    enabled,
    projectId,
    searchQuery,
    sessionKind,
    excludeSessionKind,
    includeArchived,
  ]);

  return {
    sessions,
    stats,
    projects,
    loading,
    error,
    hasMore,
    loadMore,
    refetch: fetch,
  };
}

import { type SessionKind, sessionMatchesKind } from "@yep-anywhere/shared";
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

function getArchiveBlockForActivity(
  ownership: GlobalSessionItem["ownership"],
  activity: GlobalSessionItem["activity"],
): Partial<
  Pick<
    NonNullable<GlobalSessionItem["runtime"]>,
    "archiveBlockCode" | "archiveBlockReason"
  >
> {
  if (activity === "waiting-input") {
    return {
      archiveBlockCode: "waiting_input",
      archiveBlockReason:
        "This session is waiting for input. Respond or stop it before archiving.",
    };
  }
  if (activity === "hold") {
    return {
      archiveBlockCode: "agent_on_hold",
      archiveBlockReason:
        "This session is on hold. Resume or stop it before archiving.",
    };
  }
  if (activity === "in-turn") {
    return {
      archiveBlockCode: "agent_in_turn",
      archiveBlockReason:
        "This session is currently running. Wait for it to finish or stop it before archiving.",
    };
  }
  if (ownership.owner === "external") {
    return {
      archiveBlockCode: "external_active",
      archiveBlockReason:
        "This session is controlled by an active external process. Wait for it to finish before archiving.",
    };
  }
  return {};
}

function updateRuntimeSnapshot(
  session: GlobalSessionItem,
  ownership: GlobalSessionItem["ownership"],
  activity: GlobalSessionItem["activity"],
): GlobalSessionItem["runtime"] {
  const isBusy = isBusyActivity(activity) || ownership.owner === "external";
  const block = isBusy ? getArchiveBlockForActivity(ownership, activity) : {};
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
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTitleRefetchTimersRef = useRef<
    Map<string, Set<ReturnType<typeof setTimeout>>>
  >(new Map());
  const latestFetchRef = useRef<(() => Promise<void>) | null>(null);
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

  const schedulePendingTitleRefetch = useCallback((sessionId: string) => {
    if (pendingTitleRefetchTimersRef.current.has(sessionId)) return;

    const timers = new Set<ReturnType<typeof setTimeout>>();
    pendingTitleRefetchTimersRef.current.set(sessionId, timers);

    for (const delayMs of PENDING_TITLE_REFETCH_DELAYS_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (timers.size === 0) {
          pendingTitleRefetchTimersRef.current.delete(sessionId);
        }
        void latestFetchRef.current?.();
      }, delayMs);
      timers.add(timer);
    }
  }, []);

  const refreshSessionMetadata = useCallback(
    async (sessionId: string, refreshProjectId: string) => {
      if (!enabled) return;

      try {
        const data = await api.getSessionMetadata(refreshProjectId, sessionId);

        if (hasResolvedTitle(data.session)) {
          clearPendingTitleRefetch(sessionId);
        }

        setSessions((prev) => {
          let didUpdate = false;

          const updated = prev.map((existing) => {
            if (existing.id !== sessionId) return existing;
            didUpdate = true;

            const project = projectsRef.current.find(
              (p) => p.id === data.session.projectId,
            );
            const refreshed: GlobalSessionItem = {
              id: data.session.id,
              title: data.session.title,
              createdAt: data.session.createdAt,
              updatedAt: data.session.updatedAt,
              messageCount: data.session.messageCount,
              userQuestions: data.session.userQuestions,
              provider: data.session.provider,
              projectId: data.session.projectId,
              projectName:
                existing.projectName ?? project?.name ?? data.session.projectId,
              ownership: data.ownership,
              runtime: data.runtime ?? data.session.runtime ?? existing.runtime,
              pendingInputType:
                data.session.pendingInputType ??
                (data.ownership.owner === "none"
                  ? undefined
                  : existing.pendingInputType),
              activity:
                data.session.runtime?.activity ??
                data.runtime?.activity ??
                data.session.activity ??
                (data.ownership.owner === "none"
                  ? undefined
                  : existing.activity),
              hasUnread: data.session.hasUnread ?? existing.hasUnread,
              customTitle: data.session.customTitle,
              aiTitle: data.session.aiTitle,
              isArchived: data.session.isArchived ?? false,
              isStarred: data.session.isStarred ?? false,
              executor: data.session.executor ?? existing.executor,
              createdBy: data.session.createdBy ?? existing.createdBy,
              originator: data.session.originator ?? existing.originator,
              source: data.session.source ?? existing.source,
              contextUsage: data.session.contextUsage ?? existing.contextUsage,
              cumulativeUsage:
                data.session.cumulativeUsage ?? existing.cumulativeUsage,
              compactCount: data.session.compactCount ?? existing.compactCount,
              compactEvents:
                data.session.compactEvents ?? existing.compactEvents,
              model: data.session.model ?? existing.model,
              reasoningEffort:
                data.session.reasoningEffort ?? existing.reasoningEffort,
              serviceTier: data.session.serviceTier ?? existing.serviceTier,
            };

            return mergeFetchedSession(existing, refreshed);
          });

          if (!didUpdate) return prev;

          return updated.filter((session) =>
            matchesSessionKindFilters(session, {
              sessionKind,
              excludeSessionKind,
            }),
          );
        });
      } catch {
        void latestFetchRef.current?.();
      }
    },
    [clearPendingTitleRefetch, enabled, excludeSessionKind, sessionKind],
  );

  // Load more sessions (pagination)
  const loadMore = useCallback(async () => {
    if (!enabled || !hasMore || sessions.length === 0) return;

    const lastSession = sessions[sessions.length - 1];
    if (!lastSession) return;

    try {
      const data = await api.getGlobalSessions({
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        after: lastSession.updatedAt,
        includeArchived,
        includeStats: false,
        kind: sessionKind ?? undefined,
        excludeKind: excludeSessionKind ?? undefined,
      });

      setSessions((prev) => {
        // Deduplicate when appending
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = data.sessions.filter((s) => !existingIds.has(s.id));
        return [...prev, ...newSessions];
      });

      setHasMore(data.hasMore);
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
  const handleSessionStatusChange = useCallback((event: SessionStatusEvent) => {
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
  }, []);

  // Handle process state changes
  const handleProcessStateChange = useCallback((event: ProcessStateEvent) => {
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
  }, []);

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

      if (needsPendingTitleRefetch(event.session)) {
        schedulePendingTitleRefetch(event.session.id);
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

        return [globalSession, ...prev];
      });
    },
    [
      projectId,
      searchQuery,
      sessionKind,
      excludeSessionKind,
      enabled,
      debouncedRefetch,
      schedulePendingTitleRefetch,
    ],
  );

  // Handle session metadata changes
  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      if (!enabled) return;
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

        const filtered = updated.filter((session) =>
          matchesSessionKindFilters(session, {
            sessionKind,
            excludeSessionKind,
          }),
        );

        return filtered;
      });

      if (searchQuery) {
        debouncedRefetch();
      } else if (existingSession && refreshProjectId) {
        void refreshSessionMetadata(event.sessionId, refreshProjectId);
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
      sessionKind,
      excludeSessionKind,
      searchQuery,
      enabled,
      debouncedRefetch,
      clearPendingTitleRefetch,
      refreshSessionMetadata,
    ],
  );

  // Handle session seen events
  const handleSessionSeen = useCallback((event: SessionSeenEvent) => {
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== event.sessionId) return session;

        return {
          ...session,
          hasUnread: event.timestamp === "",
        };
      }),
    );
  }, []);

  // Handle session content updates (auto-generated title, messageCount, contextUsage)
  const handleSessionUpdated = useCallback(
    (event: SessionUpdatedEvent) => {
      if (!enabled) return;

      if (event.title?.trim()) {
        clearPendingTitleRefetch(event.sessionId);
      } else if (event.title === null || event.messageCount === 0) {
        schedulePendingTitleRefetch(event.sessionId);
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

      if (sessionKind || excludeSessionKind) {
        debouncedRefetch();
      }
    },
    [
      clearPendingTitleRefetch,
      schedulePendingTitleRefetch,
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
    // sidebar (liveUpdates=false, metadataLiveUpdates=true) still clears the
    // unread dot via a single-item update instead of waiting for a full refetch.
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

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
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
  }, []);

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

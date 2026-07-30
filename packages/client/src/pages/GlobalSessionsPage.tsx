import {
  ALL_PROVIDERS,
  type ProviderName,
  SLASH_COMMAND_SESSION_KIND,
  type SessionKind,
  isSessionKind,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { type GlobalSessionItem, api } from "../api/client";
import { BulkActionBar } from "../components/BulkActionBar";
import {
  FilterDropdown,
  type FilterOption,
} from "../components/FilterDropdown";
import { PageHeader } from "../components/PageHeader";
import { SessionListItem } from "../components/SessionListItem";
import { SessionListSkeleton } from "../components/Skeleton";
import { useToastContext } from "../contexts/ToastContext";
import { useDrafts } from "../hooks/useDrafts";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { toUrlProjectId } from "../utils";

// Long-press threshold for entering selection mode on mobile
const LONG_PRESS_MS = 500;

// Status filter options
type StatusFilter = "all" | "unread" | "starred" | "archived";

// Age filter options (days)
type AgeFilter = "3" | "7" | "14" | "30";

// Provider colors for filter dropdown (matching ProviderBadge)
const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: "var(--app-yep-green)",
  "claude-ollama": "var(--app-yep-green)", // Same as Claude
  codex: "#10a37f",
  "codex-oss": "#f97316",
  gemini: "#4285f4",
  "gemini-acp": "#4285f4", // Same as gemini
  opencode: "#9333ea", // Purple for OpenCode
  kimi: "var(--provider-kimi)", // Kimi KMBlue
};

const getSessionListTitle = (session: GlobalSessionItem): string | null =>
  session.customTitle ?? session.aiTitle ?? session.title ?? null;

/**
 * A session can be archived only if it is not already archived and its runtime
 * is not busy. The server hard-blocks (409) archiving of busy sessions
 * (waiting-input / hold / in-turn / external), so filtering them out client-side
 * avoids doomed requests and keeps bulk archive tolerant of mixed selections.
 */
const canArchiveSession = (session: GlobalSessionItem): boolean =>
  !session.isArchived && session.runtime?.canArchive !== false;

/** Max number of busy session names to spell out before summarizing the rest. */
const MAX_BUSY_NAMES = 3;

/** Build a readable "A, B, C +N more" list of busy session titles for a toast. */
const formatBusyNames = (
  busy: GlobalSessionItem[],
  t: ReturnType<typeof useI18n>["t"],
): string => {
  const names = busy
    .slice(0, MAX_BUSY_NAMES)
    .map((s) => getSessionListTitle(s) ?? t("sessionUntitled"));
  let label = names.join(", ");
  if (busy.length > MAX_BUSY_NAMES) {
    label += ` ${t("bulkArchiveMore", { count: busy.length - MAX_BUSY_NAMES })}`;
  }
  return label;
};

/**
 * Global sessions page showing all sessions across all projects.
 * Supports filtering by project, status, provider, and search query.
 * Includes multi-select mode with bulk actions.
 */
export function GlobalSessionsPage() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get filter params from URL
  const searchQuery = searchParams.get("q") || "";
  const projectFilter = searchParams.get("project") || undefined;
  const sessionKind = useMemo((): SessionKind | undefined => {
    const param = searchParams.get("kind");
    return isSessionKind(param) ? param : undefined;
  }, [searchParams]);

  // Local state for search input (instant feedback)
  const [searchInput, setSearchInput] = useState(searchQuery);

  // Status and provider filters from URL
  const statusFilters = useMemo(() => {
    const param = searchParams.get("status");
    if (!param) return [];
    return param
      .split(",")
      .filter((s): s is StatusFilter =>
        ["all", "unread", "starred", "archived"].includes(s),
      );
  }, [searchParams]);

  const providerFilters = useMemo(() => {
    const param = searchParams.get("provider");
    if (!param) return [];
    const knownProviders = Object.keys(PROVIDER_COLORS);
    return param
      .split(",")
      .filter((p): p is ProviderName => knownProviders.includes(p));
  }, [searchParams]);

  const executorFilters = useMemo(() => {
    const param = searchParams.get("executor");
    if (!param) return [];
    return param.split(",").filter(Boolean);
  }, [searchParams]);

  const ageFilter = useMemo(() => {
    const param = searchParams.get("age");
    if (param && ["3", "7", "14", "30"].includes(param))
      return param as AgeFilter;
    return undefined;
  }, [searchParams]);

  const setStatusFilters = useCallback(
    (filters: StatusFilter[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("status", filters.join(","));
        } else {
          next.delete("status");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setProviderFilters = useCallback(
    (filters: ProviderName[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("provider", filters.join(","));
        } else {
          next.delete("provider");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setExecutorFilters = useCallback(
    (filters: string[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("executor", filters.join(","));
        } else {
          next.delete("executor");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setAgeFilter = useCallback(
    (selected: AgeFilter[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (selected.length > 0 && selected[0]) {
          next.set("age", selected[0]);
        } else {
          next.delete("age");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  // Default the age filter to "Last 7 days" on first visit. We only apply this
  // once per mount: if the user explicitly clears the filter (which removes
  // ?age= from the URL), we don't re-apply it within the same session.
  const hasAppliedDefaultAgeRef = useRef(false);
  useEffect(() => {
    if (hasAppliedDefaultAgeRef.current) return;
    hasAppliedDefaultAgeRef.current = true;
    if (!sessionKind && !searchParams.get("age")) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("age", "7");
          return next;
        },
        { replace: true },
      );
    }
  }, [sessionKind, searchParams, setSearchParams]);

  // Include archived sessions when archived filter is selected
  const includeArchived = statusFilters.includes("archived");

  const { sessions, stats, projects, loading, error, hasMore, loadMore } =
    useGlobalSessions({
      projectId: projectFilter,
      searchQuery,
      includeArchived,
      includeStats: !projectFilter,
      sessionKind,
    });

  // Dismiss cold-start splash once the first sessions fetch resolves.
  useHideSplashOnReady(!loading || sessions.length > 0 || error !== null);

  // Filter sessions based on status and provider filters (client-side)
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      // Status filtering (empty = show all non-archived)
      if (statusFilters.length === 0) {
        // Default: show non-archived
        if (session.isArchived) return false;
      } else {
        // Check if session matches any selected status filter
        let matchesStatus = false;
        for (const status of statusFilters) {
          switch (status) {
            case "all":
              if (!session.isArchived) matchesStatus = true;
              break;
            case "unread":
              if (session.hasUnread && !session.isArchived)
                matchesStatus = true;
              break;
            case "starred":
              if (session.isStarred) matchesStatus = true;
              break;
            case "archived":
              if (session.isArchived) matchesStatus = true;
              break;
          }
        }
        if (!matchesStatus) return false;
      }

      // Provider filtering (empty = show all providers)
      if (providerFilters.length > 0) {
        if (!session.provider || !providerFilters.includes(session.provider)) {
          return false;
        }
      }

      // Executor filtering (empty = show all executors)
      if (executorFilters.length > 0) {
        const sessionExecutor = session.executor ?? "local";
        if (!executorFilters.includes(sessionExecutor)) {
          return false;
        }
      }

      // Age filtering (only show sessions updated within the last N days)
      if (ageFilter) {
        const days = Number(ageFilter);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        if (new Date(session.updatedAt).getTime() < cutoff) {
          return false;
        }
      }

      return true;
    });
  }, [sessions, statusFilters, providerFilters, executorFilters, ageFilter]);

  // Track which sessions have unsent drafts
  const drafts = useDrafts();

  // Build status filter options with global counts from server
  // When filtering by project, we don't have global stats, so omit counts
  const statusOptions = useMemo((): FilterOption<StatusFilter>[] => {
    // Only show counts when not filtering by project (global view)
    const showCounts = !projectFilter;

    return [
      {
        value: "all",
        label: t("globalSessionsStatusAll"),
        count: showCounts ? stats.totalCount : undefined,
      },
      {
        value: "unread",
        label: t("globalSessionsStatusUnread"),
        count: showCounts ? stats.unreadCount : undefined,
      },
      {
        value: "starred",
        label: t("globalSessionsStatusStarred"),
        count: showCounts ? stats.starredCount : undefined,
      },
      {
        value: "archived",
        label: t("globalSessionsStatusArchived"),
        count: showCounts ? stats.archivedCount : undefined,
      },
    ];
  }, [stats, projectFilter, t]);

  // Build provider filter options with global counts from server
  // When filtering by project, we don't have global stats, so omit counts
  const providerOptions = useMemo((): FilterOption<ProviderName>[] => {
    const showCounts = !projectFilter;
    const providerCounts = stats.providerCounts;

    // Only show providers that have sessions
    const options: FilterOption<ProviderName>[] = [];
    for (const provider of ALL_PROVIDERS) {
      const count = providerCounts[provider];
      if (count && count > 0) {
        options.push({
          value: provider,
          label: provider.charAt(0).toUpperCase() + provider.slice(1),
          count: showCounts ? count : undefined,
          color: PROVIDER_COLORS[provider],
        });
      }
    }
    return options;
  }, [stats.providerCounts, projectFilter]);

  // Age filter options
  const ageOptions = useMemo((): FilterOption<AgeFilter>[] => {
    return [
      { value: "3", label: t("globalSessionsAge3Days") },
      { value: "7", label: t("globalSessionsAge7Days") },
      { value: "14", label: t("globalSessionsAge14Days") },
      { value: "30", label: t("globalSessionsAge30Days") },
    ];
  }, [t]);

  // Build executor filter options with global counts from server
  const executorOptions = useMemo((): FilterOption<string>[] => {
    const showCounts = !projectFilter;
    const executorCounts = stats.executorCounts;

    // Only show executors that have sessions, sorted with "local" first
    const entries = Object.entries(executorCounts).filter(
      ([_, count]) => count > 0,
    );
    entries.sort((a, b) => {
      // "local" always comes first
      if (a[0] === "local") return -1;
      if (b[0] === "local") return 1;
      return a[0].localeCompare(b[0]);
    });

    return entries.map(([executor, count]) => ({
      value: executor,
      label: executor === "local" ? t("globalSessionsExecutorLocal") : executor,
      count: showCounts ? count : undefined,
    }));
  }, [stats.executorCounts, projectFilter, t]);

  // Selection state for multi-select mode
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isBulkActionPending, setIsBulkActionPending] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressSessionRef = useRef<string | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);

  // Selection handlers
  const handleSelect = useCallback((sessionId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      // Exit selection mode when nothing is selected
      if (next.size === 0) {
        setIsSelectionMode(false);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(filteredSessions.map((s) => s.id)));
    setIsSelectionMode(true);
  }, [filteredSessions]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setIsSelectionMode(false);
  }, []);

  // Long-press handlers for mobile selection mode
  const handleLongPressStart = useCallback(
    (sessionId: string, e: React.TouchEvent | React.MouseEvent) => {
      // Already in selection mode or on desktop - don't start long-press
      if (isSelectionMode || isWideScreen) return;

      // Record starting position to detect movement (scrolling)
      if ("touches" in e) {
        const touch = e.touches[0];
        if (touch) {
          touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
        }
      } else if ("clientX" in e) {
        touchStartPosRef.current = { x: e.clientX, y: e.clientY };
      }

      longPressSessionRef.current = sessionId;
      longPressTimerRef.current = setTimeout(() => {
        // Enter selection mode and select this session
        setIsSelectionMode(true);
        setSelectedIds(new Set([sessionId]));
        longPressSessionRef.current = null;
        touchStartPosRef.current = null;
      }, LONG_PRESS_MS);
    },
    [isSelectionMode, isWideScreen],
  );

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressSessionRef.current = null;
    touchStartPosRef.current = null;
  }, []);

  // Cancel long press if user moves finger (scrolling)
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartPosRef.current || !longPressTimerRef.current) return;

    const touch = e.touches[0];
    if (!touch) return;

    const dx = touch.clientX - touchStartPosRef.current.x;
    const dy = touch.clientY - touchStartPosRef.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Cancel if moved more than 10px (scrolling threshold)
    if (distance > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressSessionRef.current = null;
      touchStartPosRef.current = null;
    }
  }, []);

  // Prevent native context menu during long press
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Suppress context menu if long press is active or in selection mode
      if (longPressTimerRef.current || isSelectionMode) {
        e.preventDefault();
      }
    },
    [isSelectionMode],
  );

  // Bulk action handlers

  /**
   * Archive a batch of sessions tolerantly:
   * - skip sessions that are busy/already archived (would 409 server-side)
   * - use allSettled so one failure never aborts the whole batch
   * - report a per-batch summary, naming the busy sessions that were skipped
   */
  const archiveSessions = useCallback(
    async (targets: GlobalSessionItem[]): Promise<void> => {
      const archivable = targets.filter(canArchiveSession);
      const busy = targets.filter(
        (s) => !s.isArchived && !canArchiveSession(s),
      );

      if (archivable.length === 0) {
        if (busy.length > 0) {
          showToast(
            t("bulkArchiveSkippedNames", { names: formatBusyNames(busy, t) }),
            "error",
          );
        } else {
          showToast(t("bulkArchiveNoneEligible"), "error");
        }
        return;
      }

      const results = await Promise.allSettled(
        archivable.map((s) =>
          api.updateSessionMetadata(s.id, { archived: true }),
        ),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - succeeded;

      const parts: string[] = [];
      if (succeeded > 0) {
        parts.push(t("bulkArchiveSucceeded", { count: succeeded }));
      }
      if (busy.length > 0) {
        parts.push(
          t("bulkArchiveSkippedNames", { names: formatBusyNames(busy, t) }),
        );
      }
      if (failed > 0) {
        parts.push(t("bulkArchiveFailed", { count: failed }));
      }
      if (parts.length > 0) {
        showToast(parts.join(" · "), failed > 0 ? "error" : "success");
      }
    },
    [showToast, t],
  );

  const handleBulkArchive = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await archiveSessions(sessions.filter((s) => selectedIds.has(s.id)));
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [
    sessions,
    selectedIds,
    isBulkActionPending,
    handleClearSelection,
    archiveSessions,
  ]);

  const handleBulkUnarchive = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      const results = await Promise.allSettled(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { archived: false }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        showToast(t("bulkArchiveFailed", { count: failed }), "error");
      }
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection, showToast, t]);

  const handleBulkStar = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { starred: true }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkUnstar = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { starred: false }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkMarkRead = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.markSessionSeen(id)),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkMarkUnread = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.markSessionUnread(id)),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  // "Archive all" for filtered results (no manual selection needed)
  const handleArchiveAllFiltered = useCallback(async () => {
    if (isBulkActionPending) return;
    const archivable = filteredSessions.filter(canArchiveSession);
    if (archivable.length === 0) return;
    setIsBulkActionPending(true);
    try {
      await archiveSessions(archivable);
    } finally {
      setIsBulkActionPending(false);
    }
  }, [filteredSessions, isBulkActionPending, archiveSessions]);

  // Count of archivable sessions in filtered results
  const archivableFilteredCount = useMemo(
    () => filteredSessions.filter(canArchiveSession).length,
    [filteredSessions],
  );

  // Compute which bulk actions are applicable based on selection
  const bulkActionState = useMemo(() => {
    const selectedSessions = sessions.filter((s) => selectedIds.has(s.id));
    return {
      canArchive: selectedSessions.some(canArchiveSession),
      canUnarchive: selectedSessions.some((s) => s.isArchived),
      canStar: selectedSessions.some((s) => !s.isStarred),
      canUnstar: selectedSessions.some((s) => s.isStarred),
      canMarkRead: selectedSessions.some((s) => s.hasUnread),
      canMarkUnread: selectedSessions.some((s) => !s.hasUnread),
    };
  }, [sessions, selectedIds]);

  // Handle search form submit
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const newParams = new URLSearchParams(searchParams);
    if (searchInput.trim()) {
      newParams.set("q", searchInput.trim());
    } else {
      newParams.delete("q");
    }
    setSearchParams(newParams);
  };

  // Handle project filter change
  const handleProjectFilter = useCallback(
    (selected: string[]) => {
      const newParams = new URLSearchParams(searchParams);
      if (selected.length > 0 && selected[0]) {
        newParams.set("project", selected[0]);
      } else {
        newParams.delete("project");
      }
      setSearchParams(newParams);
    },
    [searchParams, setSearchParams],
  );

  // Build project filter options
  const projectOptions = useMemo((): FilterOption<string>[] => {
    return projects.map((project) => ({
      value: project.id,
      label: project.name,
    }));
  }, [projects]);

  // Clear all filters
  const clearFilters = () => {
    setSearchInput("");
    setSearchParams(new URLSearchParams());
  };

  const isEmpty = filteredSessions.length === 0;
  const hasFilters =
    searchQuery ||
    projectFilter ||
    statusFilters.length > 0 ||
    providerFilters.length > 0 ||
    executorFilters.length > 0 ||
    ageFilter ||
    sessionKind;
  const pageTitle =
    sessionKind === SLASH_COMMAND_SESSION_KIND
      ? t("slashCommandSessionsTitle")
      : t("globalSessionsTitle");

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader
          title={pageTitle}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {/* Filter bar */}
            <div className="filter-bar">
              <form onSubmit={handleSearch} className="filter-search-form">
                <input
                  type="text"
                  className="filter-search"
                  placeholder={t("globalSessionsSearchPlaceholder")}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                <button type="submit" className="filter-search-button">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
              </form>
              <div className="filter-dropdowns">
                {projectOptions.length > 0 && (
                  <FilterDropdown
                    label={t("inboxFilterProject")}
                    options={projectOptions}
                    selected={projectFilter ? [projectFilter] : []}
                    onChange={handleProjectFilter}
                    multiSelect={false}
                    placeholder={t("globalSessionsFilterProjectPlaceholder")}
                  />
                )}
                <FilterDropdown
                  label={t("globalSessionsFilterStatus")}
                  options={statusOptions}
                  selected={statusFilters}
                  onChange={setStatusFilters}
                  placeholder={t("globalSessionsFilterStatusPlaceholder")}
                />
                {providerOptions.length > 1 && (
                  <FilterDropdown
                    label={t("globalSessionsFilterProvider")}
                    options={providerOptions}
                    selected={providerFilters}
                    onChange={setProviderFilters}
                    placeholder={t("globalSessionsFilterProviderPlaceholder")}
                  />
                )}
                {executorOptions.length > 1 && (
                  <FilterDropdown
                    label={t("globalSessionsFilterExecutor")}
                    options={executorOptions}
                    selected={executorFilters}
                    onChange={setExecutorFilters}
                    placeholder={t("globalSessionsFilterMachinePlaceholder")}
                  />
                )}
                <FilterDropdown
                  label={t("globalSessionsFilterAge")}
                  options={ageOptions}
                  selected={ageFilter ? [ageFilter] : []}
                  onChange={setAgeFilter}
                  multiSelect={false}
                  placeholder={t("globalSessionsFilterAgePlaceholder")}
                />
              </div>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="filter-clear-button"
                >
                  {t("globalSessionsClearFilters")}
                </button>
              )}
              {projectFilter && (
                <Link
                  to={`${basePath}/new-session?projectId=${encodeURIComponent(projectFilter)}`}
                  className="btn-primary global-sessions-new-session-button"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  {t("sidebarNewSession")}
                </Link>
              )}
            </div>

            {loading && sessions.length === 0 && <SessionListSkeleton />}

            {error && (
              <p className="error">
                {t("projectsErrorPrefix")} {error.message}
              </p>
            )}

            {!loading && !error && isEmpty && (
              <div className="inbox-empty content-fade-in">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <h3>{t("globalSessionsNoResultsTitle")}</h3>
                <p>
                  {hasFilters
                    ? t("globalSessionsNoResultsFiltered")
                    : t("globalSessionsNoResultsEmpty")}
                </p>
              </div>
            )}

            {!error && !isEmpty && (
              <>
                {/* Select all header (desktop or when in selection mode) */}
                {(isWideScreen || isSelectionMode) &&
                  filteredSessions.length > 0 && (
                    <div className="session-list-header">
                      <label className="session-list-header__select-all">
                        <input
                          type="checkbox"
                          checked={
                            selectedIds.size === filteredSessions.length &&
                            filteredSessions.length > 0
                          }
                          onChange={(e) =>
                            e.target.checked
                              ? handleSelectAll()
                              : handleClearSelection()
                          }
                        />
                        <span>
                          {selectedIds.size > 0
                            ? t("bulkSelectedCount", {
                                count: selectedIds.size,
                              })
                            : t("globalSessionsSelectAll")}
                        </span>
                      </label>
                    </div>
                  )}

                <ul
                  className={`session-list content-fade-in ${isSelectionMode ? "session-list--selection-mode" : ""}`}
                >
                  {filteredSessions.map((session) => (
                    <div
                      key={session.id}
                      onTouchStart={(e) => handleLongPressStart(session.id, e)}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleLongPressEnd}
                      onTouchCancel={handleLongPressEnd}
                      onMouseDown={(e) =>
                        !isWideScreen && handleLongPressStart(session.id, e)
                      }
                      onMouseUp={handleLongPressEnd}
                      onMouseLeave={handleLongPressEnd}
                      onContextMenu={handleContextMenu}
                    >
                      <SessionListItem
                        sessionId={session.id}
                        projectId={session.projectId}
                        title={getSessionListTitle(session)}
                        fullTitle={getSessionListTitle(session)}
                        updatedAt={session.updatedAt}
                        hasUnread={session.hasUnread}
                        activity={session.activity}
                        runtime={session.runtime}
                        pendingInputType={session.pendingInputType}
                        status={session.ownership}
                        provider={session.provider}
                        interrupted={session.interrupted}
                        lastTurnStatus={session.lastTurnStatus}
                        lastErrorMessage={session.lastErrorMessage}
                        retryStatus={session.retryStatus}
                        model={session.model}
                        reasoningEffort={session.reasoningEffort}
                        serviceTier={session.serviceTier}
                        executor={session.executor}
                        createdBy={session.createdBy}
                        originator={session.originator}
                        sessionSource={session.source}
                        isStarred={session.isStarred}
                        isArchived={session.isArchived}
                        mode="card"
                        showContextUsage={false}
                        showSizeMeta
                        contextUsage={session.contextUsage}
                        cumulativeUsage={session.cumulativeUsage}
                        compactCount={session.compactCount}
                        compactEvents={session.compactEvents}
                        isSelected={selectedIds.has(session.id)}
                        isSelectionMode={isSelectionMode && !isWideScreen}
                        onNavigate={() => {
                          // In selection mode on mobile, tap toggles selection
                          if (isSelectionMode && !isWideScreen) {
                            handleSelect(
                              session.id,
                              !selectedIds.has(session.id),
                            );
                          }
                        }}
                        onSelect={
                          isWideScreen || isSelectionMode
                            ? handleSelect
                            : undefined
                        }
                        showProjectName={!projectFilter}
                        projectName={session.projectName}
                        basePath={basePath}
                        messageCount={session.messageCount}
                        hasDraft={drafts.has(session.id)}
                      />
                    </div>
                  ))}
                </ul>

                {hasMore && (
                  <div className="global-sessions-load-more">
                    <button
                      type="button"
                      onClick={loadMore}
                      className="global-sessions-load-more-button"
                      disabled={loading}
                    >
                      {loading
                        ? t("gitStatusLoading")
                        : t("globalSessionsLoadMore")}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Bulk action bar */}
            <BulkActionBar
              selectedCount={selectedIds.size}
              onArchive={handleBulkArchive}
              onUnarchive={handleBulkUnarchive}
              onStar={handleBulkStar}
              onUnstar={handleBulkUnstar}
              onMarkRead={handleBulkMarkRead}
              onMarkUnread={handleBulkMarkUnread}
              onClearSelection={handleClearSelection}
              isPending={isBulkActionPending}
              canArchive={bulkActionState.canArchive}
              canUnarchive={bulkActionState.canUnarchive}
              canStar={bulkActionState.canStar}
              canUnstar={bulkActionState.canUnstar}
              canMarkRead={bulkActionState.canMarkRead}
              canMarkUnread={bulkActionState.canMarkUnread}
              onArchiveAllFiltered={
                hasFilters ? handleArchiveAllFiltered : undefined
              }
              archivableFilteredCount={archivableFilteredCount}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

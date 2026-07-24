import { SLASH_COMMAND_SESSION_KIND } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { GlobalSessionItem } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useDrafts } from "../hooks/useDrafts";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { resolvePreferredProjectId } from "../hooks/useRecentProject";
import { useRecentProjects } from "../hooks/useRecentProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { activityBus } from "../lib/activityBus";
import { formatSmartTime } from "../lib/datetime";
import { ProjectGitStatusInline } from "./ProjectGitStatusInline";
import { RemoteProjectIcon } from "./RemoteProjectIcon";
import { SessionListItem } from "./SessionListItem";
import {
  SidebarIcons,
  SidebarNavItem,
  SidebarNavSection,
} from "./SidebarNavItem";
import { Skeleton } from "./Skeleton";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { YepAnywhereLogo } from "./YepAnywhereLogo";

const SWIPE_THRESHOLD = 50; // Minimum distance to trigger close
const SWIPE_ENGAGE_THRESHOLD = 15; // Minimum horizontal distance before swipe engages
const RECENT_SESSIONS_INITIAL = 12; // Initial number of recent sessions to show
const RECENT_SESSIONS_INCREMENT = 10; // How many more to show on each expand

const getSessionListTitle = (session: GlobalSessionItem): string | null =>
  session.customTitle ?? session.aiTitle ?? session.title ?? null;

interface SessionProjectGroup {
  key: string;
  projectId: string;
  projectName: string;
  sessions: GlobalSessionItem[];
  latestUpdatedAt: string;
  runningCount: number;
  unreadCount: number;
}

function isRunningSession(session: GlobalSessionItem): boolean {
  return session.activity === "in-turn";
}

function canArchiveSession(session: GlobalSessionItem): boolean {
  return !session.isArchived && session.runtime?.canArchive !== false;
}

function compareSessionsByUpdatedAtDesc(
  a: GlobalSessionItem,
  b: GlobalSessionItem,
): number {
  const diff =
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (diff !== 0) return diff;
  // Stable, deterministic tiebreaker when timestamps match.
  return a.id.localeCompare(b.id);
}

function groupSessionsByProject(
  sectionKey: string,
  sessions: GlobalSessionItem[],
): SessionProjectGroup[] {
  const groupsByProject = new Map<string, SessionProjectGroup>();

  for (const session of sessions) {
    const groupKey = `${sectionKey}:${session.projectId}`;
    const group = groupsByProject.get(groupKey);

    if (group) {
      group.sessions.push(session);
      if (isRunningSession(session)) group.runningCount += 1;
      if (session.hasUnread) group.unreadCount += 1;
      if (
        new Date(session.updatedAt).getTime() >
        new Date(group.latestUpdatedAt).getTime()
      ) {
        group.latestUpdatedAt = session.updatedAt;
      }
      continue;
    }

    groupsByProject.set(groupKey, {
      key: groupKey,
      projectId: session.projectId,
      projectName: session.projectName || session.projectId,
      sessions: [session],
      latestUpdatedAt: session.updatedAt,
      runningCount: isRunningSession(session) ? 1 : 0,
      unreadCount: session.hasUnread ? 1 : 0,
    });
  }

  const groups = Array.from(groupsByProject.values());

  // Surface the freshest session at the top of each collapsed group. Group
  // order itself stays in hook (insertion) order so an active session's project
  // does not jump under the pointer during high-frequency live updates.
  for (const group of groups) {
    group.sessions.sort(compareSessionsByUpdatedAtDesc);
  }

  return groups;
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: () => void;

  /** Current session ID (for highlighting in sidebar) */
  currentSessionId?: string;

  /** Desktop mode: sidebar is always visible, no overlay */
  isDesktop?: boolean;
  /** Desktop mode: sidebar is collapsed (icons only) */
  isCollapsed?: boolean;
  /** Desktop mode: callback to toggle expanded/collapsed state */
  onToggleExpanded?: () => void;
  /** Desktop mode: current sidebar width in pixels */
  sidebarWidth?: number;
  /** Desktop mode: called when resize starts */
  onResizeStart?: () => void;
  /** Desktop mode: called during resize with new width */
  onResize?: (width: number) => void;
  /** Desktop mode: called when resize ends */
  onResizeEnd?: () => void;
}

export function Sidebar({
  isOpen,
  onClose,
  onNavigate,
  currentSessionId,
  // Desktop mode props
  isDesktop = false,
  isCollapsed = false,
  onToggleExpanded,
  sidebarWidth,
  onResizeStart,
  onResize,
  onResizeEnd,
}: SidebarProps) {
  const { t, locale } = useI18n();
  const { showToast } = useToastContext();
  // Base path for navigation links (empty — app is served at its own root).
  const basePath = useRemoteBasePath();
  const shouldLoadSessionLists = isDesktop ? !isCollapsed : isOpen;

  // Fetch global sessions for sidebar (non-starred only for recent/older sections)
  const {
    sessions: globalSessions,
    loading: globalLoading,
    refetch: refetchGlobalSessions,
  } = useGlobalSessions({
    limit: 50,
    includeStats: false,
    excludeSessionKind: SLASH_COMMAND_SESSION_KIND,
    enabled: shouldLoadSessionLists,
    liveUpdates: true,
    metadataLiveUpdates: true,
  });

  // Fetch starred sessions separately to ensure we get ALL starred sessions
  const {
    sessions: starredSessions,
    loading: starredLoading,
    refetch: refetchStarredSessions,
  } = useGlobalSessions({
    starred: true,
    limit: 100,
    includeStats: false,
    excludeSessionKind: SLASH_COMMAND_SESSION_KIND,
    enabled: shouldLoadSessionLists,
    liveUpdates: true,
    metadataLiveUpdates: true,
  });

  const sessionsLoading = globalLoading || starredLoading;

  const {
    recentProjects,
    projects,
    refetch: refetchProjects,
  } = useRecentProjects({
    enabled: shouldLoadSessionLists,
  });
  const newSessionProjectId = resolvePreferredProjectId(
    projects,
    recentProjects[0]?.id,
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  const sidebarRef = useRef<HTMLElement>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swipeEngaged = useRef<boolean>(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef<number | null>(null);
  const resizeStartWidth = useRef<number | null>(null);
  const [recentProjectGroupsLimit, setRecentProjectGroupsLimit] = useState(
    RECENT_SESSIONS_INITIAL,
  );
  const [olderProjectGroupsLimit, setOlderProjectGroupsLimit] = useState(
    RECENT_SESSIONS_INITIAL,
  );
  const [starredSessionsLimit, setStarredSessionsLimit] = useState(
    RECENT_SESSIONS_INITIAL,
  );
  const [isStarredSectionExpanded, setIsStarredSectionExpanded] =
    useState(false);
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false);
  const [expandedProjectGroups, setExpandedProjectGroups] = useState<
    Set<string>
  >(() => new Set());
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isBulkArchivePending, setIsBulkArchivePending] = useState(false);

  const refetchSessionLists = useCallback(async () => {
    if (!shouldLoadSessionLists) return;

    await Promise.all([
      refetchGlobalSessions(),
      refetchStarredSessions(),
      refetchProjects(),
    ]);
  }, [
    refetchGlobalSessions,
    refetchProjects,
    refetchStarredSessions,
    shouldLoadSessionLists,
  ]);

  const handleRefreshRecentSessions = useCallback(async () => {
    if (isRefreshingSessions) return;

    setIsRefreshingSessions(true);
    try {
      await refetchSessionLists();
    } finally {
      setIsRefreshingSessions(false);
    }
  }, [isRefreshingSessions, refetchSessionLists]);

  useEffect(() => {
    if (!shouldLoadSessionLists) return;

    const unsubscribeMetadata = activityBus.on(
      "session-metadata-changed",
      (event) => {
        if (event.archived !== undefined || event.starred !== undefined) {
          void refetchSessionLists();
        }
      },
    );
    const unsubscribeReconnect = activityBus.on("reconnect", () => {
      void refetchSessionLists();
    });
    const unsubscribeRefresh = activityBus.on("refresh", () => {
      void refetchSessionLists();
    });

    return () => {
      unsubscribeMetadata();
      unsubscribeReconnect();
      unsubscribeRefresh();
    };
  }, [refetchSessionLists, shouldLoadSessionLists]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchStartY.current = e.touches[0]?.clientY ?? null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const currentX = e.touches[0]?.clientX;
    const currentY = e.touches[0]?.clientY;
    if (currentX === undefined || currentY === undefined) return;

    const diffX = currentX - touchStartX.current;
    const diffY = currentY - touchStartY.current;

    // If not yet engaged, check if we should engage the swipe
    if (!swipeEngaged.current) {
      const absDiffX = Math.abs(diffX);
      const absDiffY = Math.abs(diffY);

      // Engage swipe only if:
      // 1. Horizontal movement exceeds threshold
      // 2. Horizontal movement is greater than vertical (user is swiping, not scrolling)
      // 3. Movement is to the left (closing gesture)
      if (
        absDiffX > SWIPE_ENGAGE_THRESHOLD &&
        absDiffX > absDiffY &&
        diffX < 0
      ) {
        swipeEngaged.current = true;
      } else {
        return; // Not engaged yet, don't track offset
      }
    }

    // Only allow swiping left (negative offset)
    if (diffX < 0) {
      setSwipeOffset(diffX);
    }
  };

  const handleTouchEnd = () => {
    if (swipeEngaged.current && swipeOffset < -SWIPE_THRESHOLD) {
      onClose();
    }
    touchStartX.current = null;
    touchStartY.current = null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  // Desktop sidebar resize handlers
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    if (!isDesktop || isCollapsed || !sidebarWidth) return;
    e.preventDefault();
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
    setIsResizing(true);
    onResizeStart?.();
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (resizeStartX.current === null || resizeStartWidth.current === null)
        return;
      const diff = e.clientX - resizeStartX.current;
      const newWidth = resizeStartWidth.current + diff;
      onResize?.(newWidth);
    };

    const handleMouseUp = () => {
      resizeStartX.current = null;
      resizeStartWidth.current = null;
      setIsResizing(false);
      onResizeEnd?.();
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onResize, onResizeEnd]);

  // Starred sessions come from dedicated fetch (filtered by server)
  // Filter out archived just in case
  const filteredStarredSessions = useMemo(() => {
    return starredSessions.filter((s) => !s.isArchived);
  }, [starredSessions]);

  // Sessions updated in the last 24 hours (non-starred, non-archived).
  // Keep the hook-provided order stable so high-frequency live updates don't
  // move an active session back under the user's pointer while browsing.
  const recentDaySessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isWithinLastDay = (date: Date) => date.getTime() >= oneDayAgo;

    return globalSessions.filter(
      (s) =>
        !s.isStarred && !s.isArchived && isWithinLastDay(new Date(s.updatedAt)),
    );
  }, [globalSessions]);

  // Older sessions (non-starred, non-archived, NOT in last 24 hours).
  // Preserve stable ordering here for the same reason as recentDaySessions.
  const olderSessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isOlderThanOneDay = (date: Date) => date.getTime() < oneDayAgo;

    return globalSessions.filter(
      (s) =>
        !s.isStarred &&
        !s.isArchived &&
        isOlderThanOneDay(new Date(s.updatedAt)),
    );
  }, [globalSessions]);

  const sidebarSessions = useMemo(
    () => [...filteredStarredSessions, ...recentDaySessions, ...olderSessions],
    [filteredStarredSessions, olderSessions, recentDaySessions],
  );

  const sidebarSessionsById = useMemo(
    () => new Map(sidebarSessions.map((session) => [session.id, session])),
    [sidebarSessions],
  );

  const selectedSessions = useMemo(
    () =>
      Array.from(selectedSessionIds)
        .map((id) => sidebarSessionsById.get(id))
        .filter((session): session is GlobalSessionItem => Boolean(session)),
    [selectedSessionIds, sidebarSessionsById],
  );

  const isSelectionMode = selectedSessionIds.size > 0;

  useEffect(() => {
    setSelectedSessionIds((current) => {
      let changed = false;
      const next = new Set<string>();

      for (const id of current) {
        if (sidebarSessionsById.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [sidebarSessionsById]);

  const handleSelectSession = useCallback(
    (sessionId: string, selected: boolean) => {
      setSelectedSessionIds((current) => {
        const next = new Set(current);
        if (selected) {
          next.add(sessionId);
        } else {
          next.delete(sessionId);
        }
        return next;
      });
    },
    [],
  );

  const handleClearSelection = useCallback(() => {
    setSelectedSessionIds(new Set());
  }, []);

  const handleBulkArchiveSelected = useCallback(async () => {
    if (isBulkArchivePending || selectedSessions.length === 0) return;

    const archivableSessions = selectedSessions.filter(canArchiveSession);
    if (archivableSessions.length === 0) {
      showToast(
        selectedSessions[0]?.runtime?.archiveBlockReason ??
          t("sessionArchiveFailed"),
        "error",
      );
      return;
    }

    setIsBulkArchivePending(true);
    try {
      await Promise.all(
        archivableSessions.map((session) =>
          api.updateSessionMetadata(session.id, { archived: true }),
        ),
      );
      showToast(
        t("sidebarArchivedSelected", { count: archivableSessions.length }),
        "success",
      );
      handleClearSelection();
      await refetchSessionLists();
    } catch (err) {
      console.error("Failed to archive selected sidebar sessions:", err);
      showToast(
        err instanceof Error ? err.message : t("sessionArchiveFailed"),
        "error",
      );
    } finally {
      setIsBulkArchivePending(false);
    }
  }, [
    handleClearSelection,
    isBulkArchivePending,
    refetchSessionLists,
    selectedSessions,
    showToast,
    t,
  ]);

  // Track which sessions have unsent drafts in localStorage
  const drafts = useDrafts();

  const allRecentProjectGroups = useMemo(
    () => groupSessionsByProject("recent", recentDaySessions),
    [recentDaySessions],
  );

  const recentProjectGroups = useMemo(
    () => allRecentProjectGroups.slice(0, recentProjectGroupsLimit),
    [allRecentProjectGroups, recentProjectGroupsLimit],
  );

  const allOlderProjectGroups = useMemo(
    () => groupSessionsByProject("older", olderSessions),
    [olderSessions],
  );

  const olderProjectGroups = useMemo(
    () => allOlderProjectGroups.slice(0, olderProjectGroupsLimit),
    [allOlderProjectGroups, olderProjectGroupsLimit],
  );

  const autoExpandedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentSessionId) {
      autoExpandedSessionIdRef.current = null;
      return;
    }
    if (autoExpandedSessionIdRef.current === currentSessionId) return;

    const currentGroupKeys = [
      ...allRecentProjectGroups,
      ...allOlderProjectGroups,
    ]
      .filter((group) =>
        group.sessions.some((session) => session.id === currentSessionId),
      )
      .map((group) => group.key);

    if (currentGroupKeys.length === 0) return;

    autoExpandedSessionIdRef.current = currentSessionId;
    setExpandedProjectGroups((current) => {
      let changed = false;
      const next = new Set(current);

      for (const key of currentGroupKeys) {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [currentSessionId, allRecentProjectGroups, allOlderProjectGroups]);

  const toggleProjectGroup = (groupKey: string) => {
    setExpandedProjectGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  const renderSessionListItem = (
    session: GlobalSessionItem,
    showProjectName: boolean,
  ) => (
    <SessionListItem
      key={session.id}
      sessionId={session.id}
      projectId={session.projectId}
      title={getSessionListTitle(session)}
      fullTitle={getSessionListTitle(session)}
      updatedAt={session.updatedAt}
      provider={session.provider}
      model={session.model}
      reasoningEffort={session.reasoningEffort}
      serviceTier={session.serviceTier}
      createdBy={session.createdBy}
      originator={session.originator}
      sessionSource={session.source}
      status={session.ownership}
      runtime={session.runtime}
      pendingInputType={session.pendingInputType}
      hasUnread={session.hasUnread}
      interrupted={session.interrupted}
      lastTurnStatus={session.lastTurnStatus}
      lastErrorMessage={session.lastErrorMessage}
      retryStatus={session.retryStatus}
      isStarred={session.isStarred}
      isArchived={session.isArchived}
      mode="compact"
      isCurrent={session.id === currentSessionId}
      activity={session.activity}
      showProjectName={showProjectName}
      projectName={session.projectName}
      basePath={basePath}
      messageCount={session.messageCount}
      cumulativeUsage={session.cumulativeUsage}
      compactCount={session.compactCount}
      compactEvents={session.compactEvents}
      hasDraft={drafts.has(session.id)}
      isSelected={selectedSessionIds.has(session.id)}
      isSelectionMode={isSelectionMode && !isDesktop}
      onSelect={handleSelectSession}
      onNavigate={() => {
        if (isSelectionMode && !isDesktop) {
          handleSelectSession(session.id, !selectedSessionIds.has(session.id));
          return;
        }
        onNavigate();
      }}
    />
  );

  const renderProjectGroups = (groups: SessionProjectGroup[]) => (
    <div className="sidebar-project-groups">
      {groups.map((group) => {
        const isExpanded = expandedProjectGroups.has(group.key);
        const isCurrentGroup = group.sessions.some(
          (session) => session.id === currentSessionId,
        );
        const runningLabel = t("agentsRunning");
        const unreadLabel = t("globalSessionsStatusUnread");
        const project = projectsById.get(group.projectId);
        const gitStatus = project?.gitStatus;

        return (
          <div
            key={group.key}
            className={`sidebar-project-group${isCurrentGroup ? " is-current" : ""}`}
          >
            <div className="sidebar-project-row">
              <button
                type="button"
                className="sidebar-project-toggle"
                onClick={() => toggleProjectGroup(group.key)}
                aria-expanded={isExpanded}
                title={group.projectName}
              >
                <span
                  className={`sidebar-project-chevron${isExpanded ? " expanded" : ""}`}
                  aria-hidden="true"
                >
                  ›
                </span>
                <span className="sidebar-project-main">
                  <span className="sidebar-project-title">
                    <span className="sidebar-project-name">
                      {group.projectName}
                    </span>
                    <RemoteProjectIcon
                      isRemoteProject={project?.isRemoteProject}
                    />
                    <ProjectGitStatusInline
                      status={gitStatus}
                      variant="sidebar"
                      showIcon={false}
                    />
                    {group.runningCount > 0 && (
                      <span
                        className="sidebar-project-status sidebar-project-status--running"
                        title={`${group.runningCount} ${runningLabel}`}
                        aria-label={`${group.runningCount} ${runningLabel}`}
                      >
                        <ThinkingIndicator />
                        <span>{group.runningCount}</span>
                      </span>
                    )}
                    {group.unreadCount > 0 && (
                      <span
                        className="sidebar-project-status sidebar-project-status--unread"
                        title={`${group.unreadCount} ${unreadLabel}`}
                        aria-label={`${group.unreadCount} ${unreadLabel}`}
                      >
                        <span
                          className="sidebar-project-unread-dot"
                          aria-hidden="true"
                        />
                        <span>{group.unreadCount}</span>
                      </span>
                    )}
                  </span>
                  <span className="sidebar-project-meta">
                    {t("projectSelectorSessionsCount", {
                      count: group.sessions.length,
                    })}
                    <span aria-hidden="true">·</span>
                    <span
                      title={new Date(group.latestUpdatedAt).toLocaleString(
                        locale,
                      )}
                    >
                      {formatSmartTime(group.latestUpdatedAt, locale)}
                    </span>
                  </span>
                </span>
              </button>
              <Link
                to={`${basePath}/new-session?projectId=${encodeURIComponent(group.projectId)}`}
                className="sidebar-project-new-session"
                onClick={onNavigate}
                title={t("sidebarNewSession")}
                aria-label={`${t("sidebarNewSession")}: ${group.projectName}`}
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
              </Link>
            </div>
            {isExpanded && (
              <ul className="sidebar-session-list sidebar-project-session-list">
                {group.sessions.map((session) =>
                  renderSessionListItem(session, false),
                )}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );

  // In desktop mode, always render. In mobile mode, only render when open.
  if (!isDesktop && !isOpen) return null;

  // Sidebar toggle icon for desktop mode
  const SidebarToggleIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );

  return (
    <>
      {/* Only show overlay in non-desktop mode */}
      {!isDesktop && (
        <div
          className="sidebar-overlay"
          onClick={onClose}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          role="button"
          tabIndex={0}
          aria-label={t("actionCloseSidebar")}
        />
      )}
      <aside
        ref={sidebarRef}
        className="sidebar"
        onTouchStart={!isDesktop ? handleTouchStart : undefined}
        onTouchMove={!isDesktop ? handleTouchMove : undefined}
        onTouchEnd={!isDesktop ? handleTouchEnd : undefined}
        style={
          !isDesktop && swipeOffset < 0
            ? { transform: `translateX(${swipeOffset}px)`, transition: "none" }
            : undefined
        }
      >
        <div className="sidebar-header">
          {isDesktop && isCollapsed ? (
            /* Desktop collapsed mode: show toggle button to expand */
            <button
              type="button"
              className="sidebar-toggle"
              onClick={onToggleExpanded}
              title={t("actionExpandSidebar")}
              aria-label={t("actionExpandSidebar")}
            >
              <SidebarToggleIcon />
            </button>
          ) : isDesktop ? (
            /* Desktop expanded mode: show brand (toggle is in toolbar) */
            <span className="sidebar-brand">
              <YepAnywhereLogo />
            </span>
          ) : (
            /* Mobile mode: brand text + close button */
            <>
              <span className="sidebar-brand">
                <YepAnywhereLogo />
              </span>
              <button
                type="button"
                className="sidebar-close"
                onClick={onClose}
                aria-label={t("actionCloseSidebar")}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </>
          )}
        </div>

        <div className="sidebar-actions">
          {/* New Session: link to most recent project's new session page */}
          <SidebarNavItem
            to={
              newSessionProjectId
                ? `/new-session?projectId=${encodeURIComponent(newSessionProjectId)}`
                : "/new-session"
            }
            icon={SidebarIcons.newSession}
            label={t("sidebarNewSession")}
            onClick={onNavigate}
            basePath={basePath}
          />
        </div>

        <div className="sidebar-sessions">
          {/* Navigation items that scroll with content */}
          <SidebarNavSection>
            <SidebarNavItem
              to="/sessions"
              icon={SidebarIcons.allSessions}
              label={t("sidebarAllSessions")}
              onClick={onNavigate}
              basePath={basePath}
              inactiveWhenSearchParams={["kind"]}
            />
            <SidebarNavItem
              to="/search"
              icon={SidebarIcons.search}
              label={t("sidebarSearch")}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/reports"
              icon={SidebarIcons.reports}
              label={t("sidebarReports")}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/projects"
              icon={SidebarIcons.projects}
              label={t("sidebarProjects")}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/terminal"
              icon={SidebarIcons.terminal}
              label={t("sidebarTerminal")}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/settings"
              icon={SidebarIcons.settings}
              label={t("sidebarSettings")}
              onClick={onNavigate}
              basePath={basePath}
            />
          </SidebarNavSection>

          {isSelectionMode && (
            <div className="sidebar-bulk-toolbar is-active">
              <span className="sidebar-bulk-toolbar__count">
                {t("bulkSelectedCount", {
                  count: selectedSessionIds.size,
                })}
              </span>
              <div className="sidebar-bulk-toolbar__actions">
                <button
                  type="button"
                  className="sidebar-bulk-toolbar__button sidebar-bulk-toolbar__button--primary"
                  onClick={() => void handleBulkArchiveSelected()}
                  disabled={
                    isBulkArchivePending ||
                    selectedSessions.every(
                      (session) => !canArchiveSession(session),
                    )
                  }
                  title={t("bulkArchiveSelected")}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="21 8 21 21 3 21 3 8" />
                    <rect x="1" y="3" width="22" height="5" />
                    <line x1="10" y1="12" x2="14" y2="12" />
                  </svg>
                  {t("bulkArchive")}
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-toolbar__icon-button"
                  onClick={handleClearSelection}
                  disabled={isBulkArchivePending}
                  aria-label={t("bulkClearSelection")}
                  title={t("bulkClearSelection")}
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
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Global sessions list */}
          {filteredStarredSessions.length > 0 && (
            <div className="sidebar-section">
              <h3 className="sidebar-section-title sidebar-collapsible-title">
                <button
                  type="button"
                  className="sidebar-section-toggle"
                  onClick={() =>
                    setIsStarredSectionExpanded((expanded) => !expanded)
                  }
                  aria-expanded={isStarredSectionExpanded}
                >
                  <span
                    className={`sidebar-section-chevron${
                      isStarredSectionExpanded ? " expanded" : ""
                    }`}
                    aria-hidden="true"
                  >
                    ›
                  </span>
                  <span>{t("sidebarSectionStarred")}</span>
                  <span className="sidebar-section-count">
                    {filteredStarredSessions.length}
                  </span>
                </button>
              </h3>
              {isStarredSectionExpanded && (
                <>
                  <ul className="sidebar-session-list">
                    {filteredStarredSessions
                      .slice(0, starredSessionsLimit)
                      .map((session) => renderSessionListItem(session, true))}
                  </ul>
                  {filteredStarredSessions.length > starredSessionsLimit && (
                    <button
                      type="button"
                      className="sidebar-show-more"
                      onClick={() =>
                        setStarredSessionsLimit(
                          (prev) => prev + RECENT_SESSIONS_INCREMENT,
                        )
                      }
                    >
                      {t("actionShowMore", {
                        count: Math.min(
                          RECENT_SESSIONS_INCREMENT,
                          filteredStarredSessions.length - starredSessionsLimit,
                        ),
                      })}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {recentDaySessions.length > 0 && (
            <div className="sidebar-section">
              <div className="sidebar-section-heading">
                <h3 className="sidebar-section-title">
                  {t("sidebarSectionLast24Hours")}
                </h3>
                <button
                  type="button"
                  className="sidebar-section-refresh"
                  onClick={() => void handleRefreshRecentSessions()}
                  disabled={isRefreshingSessions || sessionsLoading}
                  title={t("contextRefreshTooltip")}
                  aria-label={t("contextRefreshTooltip")}
                >
                  <svg
                    className={isRefreshingSessions ? "spinning" : undefined}
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 0 1-15.5 6.2" />
                    <path d="M3 12A9 9 0 0 1 18.5 5.8" />
                    <path d="M18 2v4h4" />
                    <path d="M6 22v-4H2" />
                  </svg>
                </button>
              </div>
              {renderProjectGroups(recentProjectGroups)}
              {allRecentProjectGroups.length > recentProjectGroupsLimit && (
                <button
                  type="button"
                  className="sidebar-show-more"
                  onClick={() =>
                    setRecentProjectGroupsLimit(
                      (prev) => prev + RECENT_SESSIONS_INCREMENT,
                    )
                  }
                >
                  {t("actionShowMore", {
                    count: Math.min(
                      RECENT_SESSIONS_INCREMENT,
                      allRecentProjectGroups.length - recentProjectGroupsLimit,
                    ),
                  })}
                </button>
              )}
            </div>
          )}

          {olderSessions.length > 0 && (
            <div className="sidebar-section">
              <h3 className="sidebar-section-title">
                {t("sidebarSectionOlder")}
              </h3>
              {renderProjectGroups(olderProjectGroups)}
              {allOlderProjectGroups.length > olderProjectGroupsLimit && (
                <button
                  type="button"
                  className="sidebar-show-more"
                  onClick={() =>
                    setOlderProjectGroupsLimit(
                      (prev) => prev + RECENT_SESSIONS_INCREMENT,
                    )
                  }
                >
                  {t("actionShowMore", {
                    count: Math.min(
                      RECENT_SESSIONS_INCREMENT,
                      allOlderProjectGroups.length - olderProjectGroupsLimit,
                    ),
                  })}
                </button>
              )}
            </div>
          )}

          {filteredStarredSessions.length === 0 &&
            recentDaySessions.length === 0 &&
            olderSessions.length === 0 &&
            (sessionsLoading ? (
              <div className="sidebar-loading">
                {/* Mini skeleton matching compact session list rows. */}
                <Skeleton width="80%" height="0.95em" />
                <Skeleton width="60%" height="0.95em" />
                <Skeleton width="72%" height="0.95em" />
                <Skeleton width="50%" height="0.95em" />
              </div>
            ) : (
              <p className="sidebar-empty">{t("sidebarNoSessions")}</p>
            ))}
        </div>

        {/* Resize handle - desktop only, when expanded */}
        {isDesktop && !isCollapsed && (
          <div
            className={`sidebar-resize-handle ${isResizing ? "active" : ""}`}
            onMouseDown={handleResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("actionResizeSidebar")}
            tabIndex={0}
          />
        )}
      </aside>
    </>
  );
}

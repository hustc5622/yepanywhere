import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import type { AgentActivity } from "../hooks/useFileActivity";
import { useI18n } from "../i18n";
import { formatSmartTime } from "../lib/datetime";
import { formatTokenCount, getEffectiveTokenTotal } from "../lib/tokens";
import type {
  ContextCompactEvent,
  ContextCumulativeUsage,
  ContextUsage,
  PendingInputType,
  ProviderName,
  SessionCreatedBy,
  SessionLastTurnStatus,
  SessionRetryStatus,
  SessionRuntime,
  SessionStatus,
} from "../types";
import { CompactCountBadge } from "./CompactCountBadge";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ProviderBadge } from "./ProviderBadge";
import { SessionMenu } from "./SessionMenu";
import { SessionStatusBadge } from "./StatusBadge";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { TokenUsageBadge } from "./TokenUsageBadge";

interface SessionListItemProps {
  // Core (required)
  sessionId: string;
  projectId: string;
  title: string | null;

  // Optional display data
  fullTitle?: string | null;
  projectName?: string;
  updatedAt?: string;
  hasUnread?: boolean;
  activity?: AgentActivity;
  runtime?: SessionRuntime;
  pendingInputType?: PendingInputType;
  contextUsage?: ContextUsage;
  cumulativeUsage?: ContextCumulativeUsage;
  compactCount?: number;
  compactEvents?: ContextCompactEvent[];
  status?: SessionStatus;
  provider?: ProviderName;
  /**
   * True when the session's last turn was interrupted (e.g. by a server
   * restart) and it can be resumed. Only set for owner==="none" sessions.
   */
  interrupted?: boolean;
  /** Terminal status of the most recent turn (bridge-reported). */
  lastTurnStatus?: SessionLastTurnStatus;
  /** Most recent provider error message, if the last turn failed. */
  lastErrorMessage?: string;
  /** Present while the provider is retrying a failed request (OpenCode). */
  retryStatus?: SessionRetryStatus;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** Explicit creation owner recorded by Yep metadata. */
  createdBy?: SessionCreatedBy;
  /** Launcher identifier from provider metadata. */
  originator?: string;
  /** Provider session source (e.g. "appServer", "exec", "codex-bridge"). */
  sessionSource?: string;

  // Feature toggles
  mode: "card" | "compact";
  showProjectName?: boolean;
  showTimestamp?: boolean;
  showContextUsage?: boolean;
  showStatusBadge?: boolean;

  // Custom badges (for Inbox)
  customBadge?: { label: string; className: string; title?: string } | null;
  customBadges?: Array<{ label: string; className: string; title?: string }>;

  // Actions (menu hidden when all undefined)
  isStarred?: boolean;
  isArchived?: boolean;
  onToggleStar?: () => void;
  onToggleArchive?: () => void;
  onToggleRead?: () => void;
  onRename?: () => void;

  // Selection (for All Sessions page)
  isCurrent?: boolean;
  isSelected?: boolean;
  isSelectionMode?: boolean;
  onSelect?: (sessionId: string, selected: boolean) => void;
  onNavigate?: () => void;

  // For sidebar compact mode
  hasDraft?: boolean;

  /** Base path prefix for navigation links */
  basePath?: string;

  /** Number of messages in session (0 indicates brand new session) */
  messageCount?: number;

  /** Model identifier for provider badge display (e.g. "opus", "gpt-5.5") */
  model?: string;
  /** Provider-specific reasoning effort for provider badge display. */
  reasoningEffort?: string;
  /** Provider-specific service tier / speed label for provider badge display. */
  serviceTier?: string;

  /** When true (and `mode === "card"`), the card shows a "12 条 · 12.3K"
   *  line below the timestamp. Used on the All Sessions page so users can see
   *  at a glance how big each session is. Off by default so other callers
   *  (Inbox, sidebar) aren't disturbed. */
  showSizeMeta?: boolean;
}

type SessionCreationIndicatorKind = "yep" | "terminal" | "unknown";

function normalizeCreationValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function getSessionCreationIndicator({
  createdBy,
  originator,
  sessionSource,
  status,
}: {
  createdBy?: SessionCreatedBy;
  originator?: string;
  sessionSource?: string;
  status?: SessionStatus;
}): {
  kind: SessionCreationIndicatorKind;
  label: string;
  title: string;
} {
  if (createdBy === "yep") {
    return { kind: "yep", label: "Yep", title: "创建来源：Yep 前端" };
  }

  if (createdBy === "external") {
    return {
      kind: "terminal",
      label: "终端",
      title: "创建来源：终端或外部 UI",
    };
  }

  const normalizedSource = normalizeCreationValue(sessionSource);
  const normalizedOriginator = normalizeCreationValue(originator);

  if (
    normalizedSource === "appserver" ||
    normalizedOriginator === "yep-anywhere"
  ) {
    return { kind: "yep", label: "Yep", title: "创建来源：Yep 前端" };
  }

  if (
    ["cli", "exec", "vscode", "codex-bridge"].includes(normalizedSource) ||
    normalizedOriginator.includes("codex_exec") ||
    normalizedOriginator.includes("bridge") ||
    normalizedOriginator.includes("terminal") ||
    status?.owner === "external"
  ) {
    return {
      kind: "terminal",
      label: "终端",
      title: "创建来源：终端或外部 UI",
    };
  }

  return { kind: "unknown", label: "未知", title: "创建来源：未知" };
}

/**
 * Shared session list item component used by Sidebar (compact), SessionsPage (card),
 * RecentsPage, and InboxContent.
 *
 * Features:
 * - Star indicator, title, draft badge
 * - SessionMenu (star, archive, rename actions) - hidden when no action handlers
 * - Inline rename editing with optimistic updates
 * - Card mode: context usage indicator, full status badge, time display
 * - Compact mode: abbreviated badges (Appr/Q/Running)
 * - Optional checkbox for selection mode
 * - Custom badge support (for Inbox)
 */
export function SessionListItem({
  // Core
  sessionId,
  projectId,
  title,
  // Optional display data
  fullTitle,
  projectName,
  updatedAt,
  hasUnread: hasUnreadProp,
  activity,
  runtime,
  pendingInputType,
  contextUsage,
  cumulativeUsage,
  compactCount,
  compactEvents,
  status,
  provider,
  interrupted,
  lastTurnStatus,
  lastErrorMessage,
  retryStatus,
  executor,
  createdBy,
  originator,
  sessionSource,
  // Feature toggles
  mode,
  showProjectName = false,
  showTimestamp = true,
  showContextUsage = true,
  showStatusBadge = true,
  // Custom badge
  customBadge,
  customBadges,
  // Actions
  isStarred: isStarredProp,
  isArchived: isArchivedProp,
  onToggleStar,
  onToggleArchive,
  onToggleRead,
  onRename,
  // Selection
  isCurrent = false,
  isSelected = false,
  isSelectionMode = false,
  onSelect,
  onNavigate,
  // Sidebar
  hasDraft = false,
  // Base path prefix
  basePath = "",
  // New session detection
  messageCount,
  model,
  reasoningEffort,
  serviceTier,
  showSizeMeta = false,
}: SessionListItemProps) {
  const { t, locale } = useI18n();
  const { showToast } = useToastContext();
  const navigate = useNavigate();

  // Local state for optimistic updates (only used when action handlers are provided)
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [localTitle, setLocalTitle] = useState<string | undefined>(undefined);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);

  // Computed values with optimistic fallback
  const isStarred = localIsStarred ?? isStarredProp;
  const isArchived = localIsArchived ?? isArchivedProp;
  const canArchive = isArchived || runtime?.canArchive !== false;
  const archiveBlockReason =
    runtime?.archiveBlockReason ?? "This session cannot be archived right now.";
  // Detect brand new sessions that haven't received a title yet
  // Use messageCount === 0, or if messageCount is unknown but session is actively running
  const isNewSession =
    !localTitle &&
    !title &&
    (messageCount === 0 || (messageCount == null && activity === "in-turn"));
  const displayTitle =
    localTitle ?? title ?? (isNewSession ? "New session" : "Untitled session");
  const effectiveTokenTotal = getEffectiveTokenTotal(cumulativeUsage);
  const fallbackContextTokenTotal =
    effectiveTokenTotal === null && contextUsage && contextUsage.inputTokens > 0
      ? contextUsage.inputTokens
      : null;

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    }
  }, [isEditing]);

  // Local state for optimistic unread toggle
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>(
    undefined,
  );
  const hasUnread = localHasUnread ?? hasUnreadProp;
  const renderedCustomBadges =
    customBadges ?? (customBadge ? [customBadge] : []);
  const creationIndicator = getSessionCreationIndicator({
    createdBy,
    originator,
    sessionSource,
    status,
  });
  const creationIndicatorEl = (
    <span
      className={`session-creation-badge session-creation-badge--${creationIndicator.kind}`}
      title={creationIndicator.title}
      aria-label={creationIndicator.title}
    >
      {creationIndicator.label}
    </span>
  );

  // Handlers for menu actions
  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    setLocalIsStarred(newStarred);
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      onToggleStar?.();
    } catch (err) {
      console.error("Failed to update star status:", err);
      setLocalIsStarred(undefined); // Revert on error
    }
  };

  const handleToggleArchive = async () => {
    const newArchived = !isArchived;
    if (newArchived && !canArchive) {
      showToast(archiveBlockReason, "error");
      return;
    }
    setLocalIsArchived(newArchived);
    try {
      await api.updateSessionMetadata(sessionId, { archived: newArchived });
      onToggleArchive?.();
    } catch (err) {
      console.error("Failed to update archive status:", err);
      showToast(
        err instanceof Error ? err.message : t("sessionArchiveFailed" as never),
        "error",
      );
      setLocalIsArchived(undefined); // Revert on error
    }
  };

  const handleToggleRead = async () => {
    const newHasUnread = !hasUnread;
    setLocalHasUnread(newHasUnread);
    try {
      if (newHasUnread) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      onToggleRead?.();
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined); // Revert on error
    }
  };

  const handleRename = () => {
    setRenameValue(displayTitle);
    setIsEditing(true);
  };

  const handleCancelEditing = () => {
    if (isSavingRef.current) return;
    setIsEditing(false);
    setRenameValue("");
  };

  const handleSaveRename = async () => {
    if (!renameValue.trim() || isSaving) return;
    if (renameValue.trim() === displayTitle) {
      handleCancelEditing();
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      await api.updateSessionMetadata(sessionId, {
        title: renameValue.trim(),
      });
      setLocalTitle(renameValue.trim());
      setIsEditing(false);
      onRename?.();
    } catch (err) {
      console.error("Failed to rename session:", err);
    } finally {
      setIsSaving(false);
      isSavingRef.current = false;
    }
  };

  const handleRenameBlur = () => {
    if (isSavingRef.current) return;
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditing();
      return;
    }
    handleSaveRename();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEditing();
    }
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onSelect?.(sessionId, e.target.checked);
  };

  // Activity indicator for compact mode
  const getCompactActivityIndicator = () => {
    // Priority 1: Needs input
    if (pendingInputType || activity === "waiting-input") {
      const label = pendingInputType === "tool-approval" ? "Appr" : "Q";
      return (
        <span className="session-badge session-badge-needs-input">{label}</span>
      );
    }

    // Priority 2: Retrying - still working, but surface the backoff
    if (activity === "in-turn" && retryStatus) {
      return (
        <span
          className="session-badge session-badge-continue"
          title={retryStatus.message}
        >
          Retry
        </span>
      );
    }

    // Priority 3: In-turn (thinking)
    if (activity === "in-turn") {
      return <ThinkingIndicator />;
    }

    if (activity === "hold") {
      return <span className="session-badge session-badge-external">Hold</span>;
    }

    // Priority 4: The last turn failed - surface the provider error
    if (lastTurnStatus === "failed" || lastErrorMessage) {
      return (
        <span
          className="session-badge session-badge-failed"
          title={lastErrorMessage}
        >
          Fail
        </span>
      );
    }

    // Priority 5: Interrupted (e.g. by a server restart) - prompt to continue
    if (interrupted || lastTurnStatus === "interrupted") {
      return (
        <span
          className="session-badge session-badge-continue"
          title="Session was interrupted — send a message to continue"
        >
          Cont
        </span>
      );
    }

    return null;
  };

  // Build CSS classes
  const liClasses = [
    "session-list-item",
    mode === "card" ? "session-list-item--card" : "session-list-item--compact",
    isCurrent && "current",
    hasUnread && "unread",
    isSelected && "selected",
    isArchived && "archived",
  ]
    .filter(Boolean)
    .join(" ");

  // Star icon SVG
  const StarIcon = ({
    filled,
    size = 10,
  }: { filled: boolean; size?: number }) => (
    <svg
      className="session-star-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );

  return (
    <li className={liClasses}>
      {/* Checkbox for multi-select (only shown when onSelect is provided) */}
      {onSelect && (
        <input
          type="checkbox"
          className="session-list-item__checkbox"
          checked={isSelected}
          onChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${displayTitle}`}
        />
      )}

      {isEditing ? (
        <input
          ref={renameInputRef}
          type="text"
          className="session-rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameBlur}
          onKeyDown={handleRenameKeyDown}
          disabled={isSaving}
        />
      ) : (
        <Link
          to={`${basePath}/projects/${projectId}/sessions/${sessionId}`}
          onClick={(e) => {
            if (isSelectionMode) {
              e.preventDefault();
            }
            onNavigate?.();
          }}
          title={fullTitle || displayTitle}
          className="session-list-item__link"
        >
          {mode === "card" ? (
            // Card mode: title on one line, meta on second line
            <>
              <strong className="session-list-item__title">
                {isStarred && <StarIcon filled size={12} />}
                {isNewSession && <ThinkingIndicator />}
                {displayTitle}
                {hasDraft && <span className="session-draft-badge">Draft</span>}
                {isArchived && (
                  <span className="session-archived-badge">Archived</span>
                )}
              </strong>
              <span className="session-list-item__meta">
                {showProjectName && projectName && (
                  <span className="session-list-item__project">
                    {projectName}
                  </span>
                )}
                {provider && (
                  <ProviderBadge
                    provider={provider}
                    model={model}
                    reasoningEffort={reasoningEffort}
                    serviceTier={serviceTier}
                    isThinking={activity === "in-turn"}
                  />
                )}
                {creationIndicatorEl}
                {showTimestamp && updatedAt && (
                  <span
                    className="session-list-item__time"
                    title={new Date(updatedAt).toLocaleString(locale)}
                  >
                    {formatSmartTime(updatedAt, locale)}
                  </span>
                )}
                {showSizeMeta && messageCount !== undefined && (
                  <span className="session-list-item__size-meta">
                    {t("cardMessageCount", { count: messageCount })}
                  </span>
                )}
                {showSizeMeta && effectiveTokenTotal !== null && (
                  <TokenUsageBadge
                    usage={cumulativeUsage}
                    className="session-list-item__size-meta"
                  />
                )}
                {showSizeMeta &&
                  effectiveTokenTotal === null &&
                  fallbackContextTokenTotal !== null && (
                    <span
                      className="session-list-item__size-meta"
                      title={`${fallbackContextTokenTotal.toLocaleString()} context tokens`}
                    >
                      {formatTokenCount(fallbackContextTokenTotal)}
                    </span>
                  )}
                {showSizeMeta && (
                  <CompactCountBadge
                    count={compactCount}
                    events={compactEvents}
                    className="session-list-item__size-meta"
                  />
                )}
                {executor && (
                  <span
                    className="session-badge session-badge-executor"
                    title={`Running on ${executor}`}
                  >
                    {executor}
                  </span>
                )}
                {showContextUsage && (
                  <ContextUsageIndicator usage={contextUsage} size={14} />
                )}
                {renderedCustomBadges.map((badge) => (
                  <span
                    key={`${badge.className}:${badge.label}`}
                    className={`inbox-item-badge ${badge.className}`}
                    title={badge.title}
                  >
                    {badge.label}
                  </span>
                ))}
                {showStatusBadge && status && (
                  <SessionStatusBadge
                    status={status}
                    pendingInputType={pendingInputType}
                    hasUnread={hasUnread}
                    activity={activity}
                    interrupted={interrupted}
                    lastTurnStatus={lastTurnStatus}
                    lastErrorMessage={lastErrorMessage}
                    retryStatus={retryStatus}
                  />
                )}
              </span>
            </>
          ) : (
            // Compact mode: sidebar summary with title and metadata
            <>
              <span className="session-list-item__compact-content">
                <span className="session-list-item__title-row">
                  {isStarred && <StarIcon filled />}
                  {isNewSession && <ThinkingIndicator />}
                  <span className="session-list-item__title-text">
                    {displayTitle}
                  </span>
                </span>
                <span className="session-list-item__meta session-list-item__meta--compact">
                  {showProjectName && projectName && (
                    <span className="session-list-item__project-compact">
                      {projectName}
                    </span>
                  )}
                  {showTimestamp && updatedAt && (
                    <span
                      className="session-list-item__time"
                      title={new Date(updatedAt).toLocaleString(locale)}
                    >
                      {formatSmartTime(updatedAt, locale)}
                    </span>
                  )}
                  {provider && (
                    <ProviderBadge
                      provider={provider}
                      model={model}
                      reasoningEffort={reasoningEffort}
                      serviceTier={serviceTier}
                      isThinking={activity === "in-turn"}
                      compact
                      className="session-list-item__provider"
                    />
                  )}
                  <TokenUsageBadge
                    usage={cumulativeUsage}
                    className="session-list-item__usage-meta"
                  />
                  <CompactCountBadge
                    count={compactCount}
                    events={compactEvents}
                    className="session-list-item__usage-meta"
                  />
                  {creationIndicatorEl}
                  {hasDraft && (
                    <span className="session-draft-badge">Draft</span>
                  )}
                  {getCompactActivityIndicator()}
                  {isArchived && (
                    <span className="session-archived-badge">Archived</span>
                  )}
                </span>
              </span>
            </>
          )}
        </Link>
      )}

      {/* Only show menu when provider is available (required for clone) */}
      {provider && (
        <SessionMenu
          sessionId={sessionId}
          projectId={projectId}
          title={displayTitle}
          isStarred={isStarred ?? false}
          isArchived={isArchived ?? false}
          hasUnread={hasUnread ?? false}
          provider={provider}
          canArchive={canArchive}
          archiveBlockReason={archiveBlockReason}
          onToggleStar={handleToggleStar}
          onToggleArchive={handleToggleArchive}
          onToggleRead={handleToggleRead}
          onRename={() => {
            setRenameValue(displayTitle);
            setIsEditing(true);
          }}
          onClone={(newSessionId) => {
            navigate(
              `${basePath}/projects/${projectId}/sessions/${newSessionId}`,
            );
          }}
          useEllipsisIcon
          useFixedPositioning
          className="session-list-item__menu"
        />
      )}
    </li>
  );
}

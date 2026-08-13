import { fromUrlProjectId, isUrlProjectId } from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { appPath } from "../lib/apiPath";
import { writeClipboardText } from "../lib/clipboard";
import { getProvider } from "../providers/registry";

/**
 * Decode a base64url project id back into its absolute path.
 *
 * Project ids are always built from a normalized absolute path, so anything
 * that does not decode to one is treated as unknown and the caller omits the
 * row rather than leaking mojibake.
 */
function decodeProjectPath(projectId: string): string | undefined {
  if (!isUrlProjectId(projectId)) return undefined;
  try {
    const decoded = fromUrlProjectId(projectId);
    // U+FFFD means the bytes were not valid UTF-8 to begin with.
    if (!decoded.startsWith("/") || decoded.includes("\uFFFD"))
      return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

/**
 * Text produced by "Copy session info".
 *
 * A bare session id is not resolvable to a project by any Yep API, client
 * route or CLI — every read path is keyed by `projectId + sessionId`. So the
 * copied block carries the project path and a deep link, which is what makes
 * it useful when pasted into an agent running in some other directory.
 */
export function buildSessionInfoText(input: {
  sessionId: string;
  projectId: string;
  title?: string | null;
  provider?: string;
}): string {
  const { sessionId, projectId, title, provider } = input;
  const rows: Array<[string, string | undefined]> = [
    ["Title", title ?? undefined],
    ["Session ID", sessionId],
    ["Provider", provider],
    ["Project", decodeProjectPath(projectId)],
    [
      "Link",
      `${window.location.origin}${appPath(
        `/projects/${projectId}/sessions/${sessionId}`,
      )}`,
    ],
  ];

  return rows
    .filter(([, value]) => value && value.trim().length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

export interface SessionMenuProps {
  sessionId: string;
  projectId: string;
  title?: string | null;
  isStarred: boolean;
  isArchived: boolean;
  hasUnread?: boolean;
  /** Provider name - used for capability checks like cloning support */
  provider?: string;
  /** Process ID if session has an active process (enables terminate option) */
  processId?: string;
  canArchive?: boolean;
  archiveBlockReason?: string;
  onToggleStar: () => void | Promise<void>;
  onToggleArchive: () => void | Promise<void>;
  onToggleRead?: () => void | Promise<void>;
  onRename: () => void;
  /** Called after successful clone with the new session ID */
  onClone?: (newSessionId: string) => void | Promise<void>;
  /** Called to terminate the session's process */
  onTerminate?: () => void | Promise<void>;
  /** Called to trigger a provider-native context compaction (ZCode). */
  onCompact?: () => void | Promise<void>;
  /** Called to open the provider-native goal lifecycle dialog (ZCode). */
  onGoal?: () => void;
  /** Use "..." icon instead of chevron */
  useEllipsisIcon?: boolean;
  /** Whether session sharing is configured */
  sharingConfigured?: boolean;
  /** Called to share the session as a snapshot */
  onShare?: () => void | Promise<void>;
  /** Additional class for the wrapper */
  className?: string;
  /** Use fixed positioning for dropdown (escapes overflow clipping) */
  useFixedPositioning?: boolean;
}

export function SessionMenu({
  sessionId,
  projectId,
  title,
  isStarred,
  isArchived,
  hasUnread,
  provider,
  processId,
  canArchive,
  archiveBlockReason,
  onToggleStar,
  onToggleArchive,
  onToggleRead,
  onRename,
  onClone,
  onTerminate,
  onCompact,
  onGoal,
  sharingConfigured,
  onShare,
  useEllipsisIcon = false,
  className = "",
  useFixedPositioning = false,
}: SessionMenuProps) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [isOpen, setIsOpen] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [isTerminating, setIsTerminating] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside or scrolling (mobile)
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Check both wrapper and dropdown (dropdown may be in portal)
      const clickedInWrapper = wrapperRef.current?.contains(target);
      const clickedInDropdown = dropdownRef.current?.contains(target);
      if (!clickedInWrapper && !clickedInDropdown) {
        setIsOpen(false);
        triggerRef.current?.blur();
      }
    };
    const handleScroll = (e: Event) => {
      // Only close if scroll happens in an ancestor of the menu trigger
      // This prevents closing when unrelated areas (like main content pane) scroll
      const scrollTarget = e.target as Node;
      if (
        scrollTarget instanceof Node &&
        wrapperRef.current &&
        !scrollTarget.contains(wrapperRef.current)
      ) {
        return; // Scroll is not in an ancestor of the menu, ignore
      }
      setIsOpen(false);
      setDropdownPosition(null);
      triggerRef.current?.blur();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [isOpen]);

  const handleToggleOpen = () => {
    if (isOpen) {
      setIsOpen(false);
      setDropdownPosition(null);
      triggerRef.current?.blur();
    } else {
      // Calculate position synchronously before opening to avoid flicker
      if (useFixedPositioning && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const dropdownWidth = 190; // Approximate width of dropdown
        const dropdownHeight = 224; // Approximate height of dropdown (varies by options)
        const rightPosition = window.innerWidth - rect.right;
        const margin = 8;

        // Check if dropdown would overflow bottom of viewport
        const wouldOverflowBottom =
          rect.bottom + margin + dropdownHeight > window.innerHeight;

        // Calculate vertical position - show above trigger if it would overflow bottom
        const top = wouldOverflowBottom
          ? rect.top - dropdownHeight - margin
          : rect.bottom + margin;

        // If right-aligned would overflow left edge, use left-aligned instead
        if (rect.right - dropdownWidth < margin) {
          setDropdownPosition({
            top,
            left: rect.left,
          });
        } else {
          setDropdownPosition({
            top,
            right: rightPosition,
          });
        }
      }
      setIsOpen(true);
    }
  };

  const handleAction = (action: () => void | Promise<void>) => {
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    action();
  };

  const handleClone = async () => {
    if (isCloning) return;
    setIsCloning(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      const result = await api.cloneSession(
        projectId,
        sessionId,
        undefined,
        provider,
      );
      onClone?.(result.sessionId);
    } catch (error) {
      console.error("Failed to clone session:", error);
    } finally {
      setIsCloning(false);
    }
  };

  const handleTerminate = async () => {
    if (isTerminating || !onTerminate) return;
    setIsTerminating(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await onTerminate();
    } catch (error) {
      console.error("Failed to terminate session:", error);
    } finally {
      setIsTerminating(false);
    }
  };

  const handleCompact = async () => {
    if (isCompacting || !onCompact) return;
    setIsCompacting(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await onCompact();
    } catch (error) {
      console.error("Failed to compact session:", error);
    } finally {
      setIsCompacting(false);
    }
  };

  const handleCopySessionInfo = async () => {
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await writeClipboardText(
        buildSessionInfoText({ sessionId, projectId, title, provider }),
      );
      showToast(t("sessionMenuInfoCopied"), "success");
    } catch (error) {
      console.error("Failed to copy session info:", error);
      showToast(t("sessionMenuInfoCopyFailed"), "error");
    }
  };

  const handleShare = async () => {
    if (isSharing || !onShare) return;
    setIsSharing(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await onShare();
    } catch (error) {
      console.error("Failed to share session:", error);
    } finally {
      setIsSharing(false);
    }
  };

  const wrapperClasses = [
    "session-menu-wrapper",
    className,
    isOpen && "is-open",
  ]
    .filter(Boolean)
    .join(" ");

  // For portal mode, we must have fixed positioning with calculated coordinates
  // Fall back to a visible position if calculation failed
  const dropdownStyle = useFixedPositioning
    ? {
        position: "fixed" as const,
        top: dropdownPosition?.top ?? 100,
        ...(dropdownPosition?.left !== undefined
          ? { left: dropdownPosition.left }
          : { right: dropdownPosition?.right ?? 20 }),
      }
    : undefined;

  const dropdownContent = (
    <div
      ref={dropdownRef}
      className="session-menu-dropdown"
      style={dropdownStyle}
    >
      <button type="button" onClick={() => handleAction(onToggleStar)}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill={isStarred ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        {isStarred ? t("sessionMenuUnstar") : t("sessionMenuStar")}
      </button>
      <button type="button" onClick={handleCopySessionInfo}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        {t("sessionMenuCopyInfo")}
      </button>
      <button type="button" onClick={() => handleAction(onRename)}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        {t("sessionMenuRename")}
      </button>
      {onClone && getProvider(provider).capabilities.supportsCloning && (
        <button type="button" onClick={handleClone} disabled={isCloning}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {isCloning ? t("sessionMenuCloning") : t("sessionMenuClone")}
        </button>
      )}
      {sharingConfigured && onShare && (
        <button type="button" onClick={handleShare} disabled={isSharing}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          {isSharing ? t("sessionMenuSharing") : t("sessionMenuShare")}
        </button>
      )}
      {onCompact && (
        <button type="button" onClick={handleCompact} disabled={isCompacting}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M4 14h6v6" />
            <path d="M20 10h-6V4" />
            <path d="M14 10l7-7" />
            <path d="M3 21l7-7" />
          </svg>
          {isCompacting ? t("sessionMenuCompacting") : t("sessionMenuCompact")}
        </button>
      )}
      {onGoal && (
        <button type="button" onClick={() => handleAction(onGoal)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
          {t("sessionMenuGoal")}
        </button>
      )}
      <button
        type="button"
        onClick={() => handleAction(onToggleArchive)}
        disabled={!isArchived && canArchive === false}
        title={
          !isArchived && canArchive === false ? archiveBlockReason : undefined
        }
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
        {isArchived ? t("sessionMenuUnarchive") : t("sessionMenuArchive")}
      </button>
      {onToggleRead && (
        <button type="button" onClick={() => handleAction(onToggleRead)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            {hasUnread ? (
              // Checkmark icon for "Mark as read"
              <polyline points="20 6 9 17 4 12" />
            ) : (
              // Envelope/circle icon for "Mark as unread"
              <circle cx="12" cy="12" r="10" />
            )}
          </svg>
          {hasUnread ? t("sessionMenuMarkRead") : t("sessionMenuMarkUnread")}
        </button>
      )}
      {processId && onTerminate && (
        <button
          type="button"
          onClick={handleTerminate}
          disabled={isTerminating}
          className="terminate-button"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            {/* X in a square (stop/terminate icon) */}
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="9" x2="15" y2="15" />
            <line x1="15" y1="9" x2="9" y2="15" />
          </svg>
          {isTerminating
            ? t("sessionMenuTerminating")
            : t("sessionMenuTerminate")}
        </button>
      )}
    </div>
  );

  // Render dropdown via portal when using fixed positioning to escape overflow clipping
  const renderDropdown = () => {
    if (useFixedPositioning) {
      return createPortal(dropdownContent, document.body);
    }
    return dropdownContent;
  };

  return (
    <div className={wrapperClasses} ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className="session-menu-trigger"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleToggleOpen();
        }}
        title={t("sessionMenuOptions")}
        aria-label={t("sessionMenuOptions")}
        aria-expanded={isOpen}
      >
        {useEllipsisIcon ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
            aria-hidden="true"
          >
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>
      {isOpen && renderDropdown()}
    </div>
  );
}

import type { AgentActivity } from "../hooks/useFileActivity";
import { useI18n } from "../i18n";
import type { SessionLastTurnStatus, SessionRetryStatus } from "../types";
import type { SessionStatus } from "../types";
import { ThinkingIndicator } from "./ThinkingIndicator";

type BadgeVariant = "self" | "external" | "none";
type NotificationVariant = "needs-input" | "unread" | "continue" | "failed";
type PendingInputType = "tool-approval" | "user-question";

interface SessionStatusBadgeProps {
  /** Session ownership object */
  status: SessionStatus;
  /** Type of pending input if session needs user action */
  pendingInputType?: PendingInputType;
  /** Whether session has unread content */
  hasUnread?: boolean;
  /** Current agent activity (in-turn/waiting-input) for activity indicators */
  activity?: AgentActivity;
  /** Whether the session was interrupted and can be resumed */
  interrupted?: boolean;
  /** Terminal status of the most recent turn (bridge-reported) */
  lastTurnStatus?: SessionLastTurnStatus;
  /** Most recent provider error message, shown as tooltip on the failed badge */
  lastErrorMessage?: string;
  /** Present while the provider is retrying a failed request. */
  retryStatus?: SessionRetryStatus;
}

interface CountBadgeProps {
  /** Badge variant */
  variant: BadgeVariant;
  /** Count to display (e.g., "2 Active") */
  count: number;
}

interface NotificationBadgeProps {
  /** Type of notification badge */
  variant: NotificationVariant;
  /** Optional label override */
  label?: string;
  /** Optional hover tooltip (e.g. the provider error message) */
  title?: string;
}

/**
 * Notification badge indicating action needed or unread content.
 * - "needs-input" (blue): Tool approval or user question pending
 * - "unread" (orange): New content since last viewed
 * - "continue" (amber): Session was interrupted (e.g. by a server restart) and can be resumed
 * - "failed" (red): The last turn ended with a provider error
 */
export function NotificationBadge({
  variant,
  label,
  title,
}: NotificationBadgeProps) {
  const defaultLabel =
    variant === "needs-input"
      ? "Input Needed"
      : variant === "continue"
        ? "Continue"
        : variant === "failed"
          ? "Failed"
          : "New";

  return (
    <span className={`status-badge notification-${variant}`} title={title}>
      {label ?? defaultLabel}
    </span>
  );
}

/**
 * Status badge for a single session in a list.
 * Priority: needs-input (blue) > retrying (amber) > in-turn (pulsing) > hold >
 * failed (red) > interrupted (continue) > idle (nothing).
 * Ownership is intentionally not treated as activity.
 */
export function SessionStatusBadge({
  status: _status,
  pendingInputType,
  hasUnread: _hasUnread,
  activity,
  interrupted,
  lastTurnStatus,
  lastErrorMessage,
  retryStatus,
}: SessionStatusBadgeProps) {
  const { t } = useI18n();

  // Priority 1: Needs input (tool approval or user question)
  if (pendingInputType || activity === "waiting-input") {
    const label =
      pendingInputType === "tool-approval" ? "Approval Needed" : "Question";
    return <NotificationBadge variant="needs-input" label={label} />;
  }

  // Priority 2: Provider is retrying a failed request - still working, but
  // surface the backoff instead of showing a silent thinking pulse.
  if (activity === "in-turn" && retryStatus) {
    const label =
      typeof retryStatus.attempt === "number" && retryStatus.attempt > 0
        ? t("statusBadgeRetryingAttempt", {
            attempt: String(retryStatus.attempt),
          })
        : t("statusBadgeRetrying");
    return (
      <NotificationBadge
        variant="continue"
        label={label}
        title={retryStatus.message}
      />
    );
  }

  // Priority 3: In-turn (agent is thinking) - show pulsing indicator
  if (activity === "in-turn") {
    return <ThinkingIndicator variant="pill" />;
  }

  if (activity === "hold") {
    return <span className="status-badge status-self">Hold</span>;
  }

  // Unread content is now handled via CSS class on session list item
  // (bold/bright text like Gmail instead of a badge)

  // Priority 4: The last turn failed - show a red badge with the provider
  // error as tooltip so failures are visible without opening the session.
  if (lastTurnStatus === "failed" || lastErrorMessage) {
    return (
      <NotificationBadge
        variant="failed"
        label={t("statusBadgeFailed")}
        title={lastErrorMessage}
      />
    );
  }

  // Priority 5: Interrupted (server restart / provider-reported interrupted
  // turn) - prompt the user to continue
  if (interrupted || lastTurnStatus === "interrupted") {
    return <NotificationBadge variant="continue" />;
  }

  // Active sessions (self-owned) don't need a separate indicator - "Thinking" badge
  // already shows when the process is actively in-turn
  return null;
}

/**
 * Status badge showing a count of active sessions.
 * Used on the projects list page.
 */
export function ActiveCountBadge({ variant, count }: CountBadgeProps) {
  if (count === 0) return null;

  const label =
    variant === "self"
      ? `${count} Active`
      : variant === "external"
        ? `${count} External`
        : null;

  if (!label) return null;

  return <span className={`status-badge status-${variant}`}>{label}</span>;
}

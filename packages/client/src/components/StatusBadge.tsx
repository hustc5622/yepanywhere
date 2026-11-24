import type { AgentActivity } from "../hooks/useFileActivity";
import { useI18n } from "../i18n";
import {
  type SessionStatusBadgeState,
  resolveSessionStatusBadge,
} from "../lib/sessionStatusBadge";
import type { SessionLastTurnStatus, SessionRetryStatus } from "../types";
import type { SessionStatus } from "../types";
import { ThinkingIndicator } from "./ThinkingIndicator";

type BadgeVariant = "self" | "external" | "none";
type NotificationVariant =
  | "needs-input"
  | "unread"
  | "continue"
  | "failed"
  | "hold"
  | "background"
  | "interrupted"
  | "incomplete";
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
  /** Claude's legacy flag: the history stops mid-turn (same as incomplete). */
  interrupted?: boolean;
  /** Terminal status of the most recent turn (bridge-reported) */
  lastTurnStatus?: SessionLastTurnStatus;
  /** Most recent provider error message, shown as tooltip on the failed badge */
  lastErrorMessage?: string;
  /** Present while the provider is retrying a failed request. */
  retryStatus?: SessionRetryStatus;
  /** The idle owned process still runs provider background work. */
  hasPendingBackgroundWork?: boolean;
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
  /** Visible label */
  label: string;
  /** Optional hover tooltip (e.g. the provider error message) */
  title?: string;
}

/**
 * Notification badge indicating action needed or unread content.
 * - "needs-input" (blue): Tool approval or user question pending
 * - "unread" (orange): New content since last viewed
 * - "continue" (amber): Retrying a failed request
 * - "background" (teal): A background task will resume the agent
 * - "failed" (red): The last turn ended with a provider error
 * - "interrupted" (muted): The last turn was stopped
 * - "incomplete" (amber outline): The last turn never finished
 */
export function NotificationBadge({
  variant,
  label,
  title,
}: NotificationBadgeProps) {
  return (
    <span className={`status-badge notification-${variant}`} title={title}>
      {label}
    </span>
  );
}

/** Label, tooltip and variant for one resolved session status. */
export function useSessionStatusBadgeView(
  state: SessionStatusBadgeState | null,
): { variant: NotificationVariant; label: string; title?: string } | null {
  const { t } = useI18n();
  if (!state || state.kind === "running") return null;
  switch (state.kind) {
    case "approval":
      return {
        variant: "needs-input",
        label: t("statusBadgeApproval"),
        title: t("statusBadgeApprovalTitle"),
      };
    case "question":
      return {
        variant: "needs-input",
        label: t("statusBadgeQuestion"),
        title: t("statusBadgeQuestionTitle"),
      };
    case "retrying":
      return {
        variant: "continue",
        label:
          state.attempt !== undefined
            ? t("statusBadgeRetryingAttempt", {
                attempt: String(state.attempt),
              })
            : t("statusBadgeRetrying"),
        title: state.detail,
      };
    case "hold":
      return { variant: "hold", label: t("statusBadgeHold") };
    case "background":
      return {
        variant: "background",
        label: t("statusBadgeBackground"),
        title: t("statusBadgeBackgroundTitle"),
      };
    case "failed":
      return {
        variant: "failed",
        label: t("statusBadgeFailed"),
        title: state.detail || t("statusBadgeFailedTitle"),
      };
    case "interrupted":
      return {
        variant: "interrupted",
        label: t("statusBadgeInterrupted"),
        title: t("statusBadgeInterruptedTitle"),
      };
    case "incomplete":
      return {
        variant: "incomplete",
        label: t("statusBadgeIncomplete"),
        title: t("statusBadgeIncompleteTitle"),
      };
  }
}

/**
 * Status badge for a single session in a list. See
 * {@link resolveSessionStatusBadge} for the priority order. Ownership is
 * intentionally not treated as activity.
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
  hasPendingBackgroundWork,
}: SessionStatusBadgeProps) {
  const state = resolveSessionStatusBadge({
    pendingInputType,
    activity,
    interrupted,
    lastTurnStatus,
    lastErrorMessage,
    retryStatus,
    hasPendingBackgroundWork,
  });
  const view = useSessionStatusBadgeView(state);
  if (state?.kind === "running") return <ThinkingIndicator variant="pill" />;
  if (!view) return null;
  return <NotificationBadge {...view} />;
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

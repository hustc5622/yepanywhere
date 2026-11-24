import type {
  AgentActivity,
  PendingInputType,
  SessionLastTurnStatus,
  SessionRetryStatus,
} from "../types";

/**
 * One session's status as the session list shows it. Every badge variant
 * (sidebar, global list, compact) derives from this so they cannot drift.
 *
 * Priority: needs input > retrying > running > paused > background work >
 * failed > interrupted > incomplete > nothing.
 */
export type SessionStatusBadgeState =
  | { kind: "running" }
  | { kind: "background" }
  | {
      kind:
        | "approval"
        | "question"
        | "retrying"
        | "hold"
        | "failed"
        | "interrupted"
        | "incomplete";
      /** Provider detail (error or retry message), shown as the tooltip. */
      detail?: string;
      attempt?: number;
    };

export interface SessionStatusBadgeInput {
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  retryStatus?: SessionRetryStatus;
  lastTurnStatus?: SessionLastTurnStatus;
  lastErrorMessage?: string;
  /** Claude's legacy flag; means the same as `lastTurnStatus: "incomplete"`. */
  interrupted?: boolean;
  /** The owned process is idle but still runs provider background work. */
  hasPendingBackgroundWork?: boolean;
}

export function resolveSessionStatusBadge({
  pendingInputType,
  activity,
  retryStatus,
  lastTurnStatus,
  lastErrorMessage,
  interrupted,
  hasPendingBackgroundWork,
}: SessionStatusBadgeInput): SessionStatusBadgeState | null {
  if (pendingInputType || activity === "waiting-input") {
    return {
      kind: pendingInputType === "tool-approval" ? "approval" : "question",
    };
  }
  if (activity === "in-turn") {
    return retryStatus
      ? {
          kind: "retrying",
          detail: retryStatus.message,
          ...(typeof retryStatus.attempt === "number" && retryStatus.attempt > 0
            ? { attempt: retryStatus.attempt }
            : {}),
        }
      : { kind: "running" };
  }
  if (activity === "hold") return { kind: "hold" };
  if (hasPendingBackgroundWork) return { kind: "background" };
  if (lastTurnStatus === "failed" || lastErrorMessage) {
    return { kind: "failed", detail: lastErrorMessage };
  }
  if (lastTurnStatus === "interrupted") return { kind: "interrupted" };
  if (lastTurnStatus === "incomplete" || interrupted) {
    return { kind: "incomplete" };
  }
  return null;
}

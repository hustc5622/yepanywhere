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

/**
 * A project's sessions rolled up from their resolved badges, so a collapsed
 * project row reports the same states its session cards do. Counts are
 * session counts; each session lands in exactly one bucket.
 */
export interface SessionStatusRollup {
  /** Sessions blocked on a tool approval. */
  approval: number;
  /** Sessions blocked on a question. */
  question: number;
  /** Sessions in a turn, including ones retrying a failed request. */
  running: number;
}

export function createSessionStatusRollup(): SessionStatusRollup {
  return { approval: 0, question: 0, running: 0 };
}

export function addToSessionStatusRollup(
  rollup: SessionStatusRollup,
  state: SessionStatusBadgeState | null,
): void {
  switch (state?.kind) {
    case "approval":
      rollup.approval += 1;
      return;
    case "question":
      rollup.question += 1;
      return;
    case "running":
    case "retrying":
      rollup.running += 1;
      return;
  }
}

/** Sessions that cannot make progress until the user acts. */
export function countSessionsNeedingInput(rollup: SessionStatusRollup): number {
  return rollup.approval + rollup.question;
}

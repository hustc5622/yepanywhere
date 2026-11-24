import type {
  AgentActivity,
  PendingInputType,
  SessionLastTurnStatus,
  SessionRuntime,
} from "@yep-anywhere/shared";
import type { SessionOwnership } from "../supervisor/types.js";
import {
  LAST_TURN_OUTCOME_GRACE_MS,
  type SessionLifecycleTurnOutcome,
  type SessionRuntimeProcess,
  resolveSessionLifecycle,
} from "./session-lifecycle.js";

export {
  getProcessActivity,
  isBusyActivity,
  type SessionRuntimeProcess,
} from "./session-lifecycle.js";

export interface DeriveSessionRuntimeOptions {
  process?: SessionRuntimeProcess | null;
  externalActive?: boolean;
  externalActivity?: AgentActivity;
  fallbackOwnership?: SessionOwnership;
}

/** Runtime half of {@link resolveSessionLifecycle}, for callers without history. */
export function deriveSessionRuntime(
  options: DeriveSessionRuntimeOptions,
): SessionRuntime {
  return resolveSessionLifecycle(options).runtime;
}

export function pendingInputTypeFromRequest(
  request: { type: string } | null | undefined,
): PendingInputType | undefined {
  if (!request) return undefined;
  return request.type === "tool-approval" ? "tool-approval" : "user-question";
}

export function pendingInputTypeFromProcess(
  process: SessionRuntimeProcess | undefined | null,
): PendingInputType | undefined {
  const request =
    process?.pendingInputRequest ?? process?.getPendingInputRequest?.() ?? null;
  return pendingInputTypeFromRequest(request);
}

/** Request id of the pending input, for notification action round-trips. */
export function pendingInputRequestIdFromProcess(
  process: SessionRuntimeProcess | undefined | null,
): string | undefined {
  const request =
    process?.pendingInputRequest ?? process?.getPendingInputRequest?.() ?? null;
  return request?.id || undefined;
}

/**
 * The persisted last-turn status as the user should see it.
 *
 * `incomplete` is read off the transcript's shape: the history stops
 * mid-turn. A live writer (an owned process in a turn, on hold, waiting for
 * input or holding background work, or an external agent) writes exactly that
 * shape while it works, so it is hidden then. An owned process that is idle
 * has finished its turn: its own observed outcome wins briefly while the
 * transcript flushes, after which a mid-turn history is shown as incomplete.
 * Explicit outcomes always pass. Prefer {@link resolveSessionLifecycle},
 * which applies the same rule together with the runtime verdict.
 */
export function presentLastTurnStatus(
  status: SessionLastTurnStatus | undefined,
  liveness: {
    owner: SessionOwnership["owner"];
    activity?: AgentActivity;
    hasPendingBackgroundWork?: boolean;
    lastTurnOutcome?: SessionLifecycleTurnOutcome;
    now?: number;
  },
): SessionLastTurnStatus | undefined {
  if (status !== "incomplete") return status;
  if (liveness.owner === "none") return status;
  if (liveness.owner === "external") return undefined;
  // Owned: only an idle process without background work has settled.
  if (
    liveness.activity !== "idle" ||
    liveness.hasPendingBackgroundWork === true
  )
    return undefined;
  const outcome = liveness.lastTurnOutcome;
  const now = liveness.now ?? Date.now();
  if (outcome && now - outcome.endedAt < LAST_TURN_OUTCOME_GRACE_MS)
    return outcome.status;
  return status;
}

/**
 * {@link presentLastTurnStatus} for a runtime already resolved by
 * {@link deriveSessionRuntime}, with the owned process' own turn outcome.
 */
export function presentRuntimeLastTurnStatus(
  status: SessionLastTurnStatus | undefined,
  runtime: SessionRuntime,
  process?: Pick<SessionRuntimeProcess, "lastTurnOutcome"> | null,
): SessionLastTurnStatus | undefined {
  return presentLastTurnStatus(status, {
    owner: runtime.ownership.owner,
    activity: runtime.activity,
    hasPendingBackgroundWork: runtime.hasPendingBackgroundWork,
    lastTurnOutcome: process?.lastTurnOutcome,
  });
}

import { getSessionArchiveBlock } from "@yep-anywhere/shared";
import type {
  AgentActivity,
  PendingInputType,
  SessionLastTurnStatus,
  SessionRetryStatus,
  SessionRuntime,
} from "@yep-anywhere/shared";
import type { PermissionMode } from "../sdk/types.js";
import type { SessionOwnership } from "../supervisor/types.js";

export interface SessionRuntimeProcess {
  id: string;
  state: AgentActivity | { type: AgentActivity };
  permissionMode?: PermissionMode;
  modeVersion?: number;
  retryStatus?: SessionRetryStatus;
  pendingInputRequest?: { type: string; id?: string } | null;
  getPendingInputRequest?: () => { type: string; id?: string } | null;
}

export function getProcessActivity(
  process: SessionRuntimeProcess,
): AgentActivity {
  const activity =
    typeof process.state === "string" ? process.state : process.state.type;
  switch (activity) {
    case "in-turn":
    case "idle":
    case "waiting-input":
    case "hold":
    case "terminated":
      return activity;
  }
}

export function isBusyActivity(activity: AgentActivity | undefined): boolean {
  return (
    activity === "in-turn" ||
    activity === "waiting-input" ||
    activity === "hold"
  );
}

function buildSelfOwnership(process: SessionRuntimeProcess): SessionOwnership {
  return {
    owner: "self",
    processId: process.id,
    permissionMode: process.permissionMode as PermissionMode,
    modeVersion: process.modeVersion,
  };
}

export interface DeriveSessionRuntimeOptions {
  process?: SessionRuntimeProcess | null;
  externalActive?: boolean;
  externalActivity?: AgentActivity;
  fallbackOwnership?: SessionOwnership;
}

export function deriveSessionRuntime({
  process,
  externalActive = false,
  externalActivity,
  fallbackOwnership,
}: DeriveSessionRuntimeOptions): SessionRuntime {
  const ownership = process
    ? buildSelfOwnership(process)
    : externalActive
      ? ({ owner: "external" } as const)
      : (fallbackOwnership ?? { owner: "none" as const });

  const activity = process
    ? getProcessActivity(process)
    : externalActive
      ? externalActivity
      : undefined;

  const isBusy =
    isBusyActivity(activity) ||
    (ownership.owner === "external" && externalActive);
  const hasResidentWorker = Boolean(process && activity === "idle");
  const block = isBusy ? getSessionArchiveBlock(ownership, activity) : {};

  return {
    ownership,
    activity,
    isBusy,
    hasResidentWorker,
    canArchive: !isBusy,
    ...block,
  };
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
 * mid-turn. A live owner writes exactly that shape while it works, and an
 * owned process reports how its turns end (including turns the agent starts
 * on its own) through its live state. So `incomplete` is only shown when
 * nothing owns or drives the session; explicit outcomes always pass.
 */
export function presentLastTurnStatus(
  status: SessionLastTurnStatus | undefined,
  liveness: { owner: SessionOwnership["owner"] },
): SessionLastTurnStatus | undefined {
  if (status === "incomplete" && liveness.owner !== "none") return undefined;
  return status;
}

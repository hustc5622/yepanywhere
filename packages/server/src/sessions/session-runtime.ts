import { getSessionArchiveBlock } from "@yep-anywhere/shared";
import type {
  AgentActivity,
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

export function pendingInputTypeFromProcess(
  process: SessionRuntimeProcess | undefined | null,
): "tool-approval" | "user-question" | undefined {
  const request =
    process?.pendingInputRequest ?? process?.getPendingInputRequest?.() ?? null;
  if (!request) return undefined;
  return request.type === "tool-approval" ? "tool-approval" : "user-question";
}

/** Request id of the pending input, for notification action round-trips. */
export function pendingInputRequestIdFromProcess(
  process: SessionRuntimeProcess | undefined | null,
): string | undefined {
  const request =
    process?.pendingInputRequest ?? process?.getPendingInputRequest?.() ?? null;
  return request?.id || undefined;
}

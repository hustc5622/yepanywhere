import type {
  AgentActivity,
  SessionDisplayActivity,
  SessionLastTurnStatus,
  SessionRuntime,
} from "@yep-anywhere/shared";
import { getSessionArchiveBlock } from "@yep-anywhere/shared";
import type { PermissionMode } from "../sdk/types.js";
import type { SessionOwnership } from "../supervisor/types.js";

/**
 * The single arbiter of a session's lifecycle state.
 *
 * Each harness reports evidence in its own way (a live process, an external
 * process or log-tail probe, a bridge view, the persisted transcript). This
 * module turns that evidence into one verdict that the session list, the
 * session detail, the display projection and the archive guard all share, so
 * they cannot drift apart.
 *
 * Priority (first match wins):
 *  1. owned process waiting for input       -> waiting-input
 *  2. owned process in a turn                -> running
 *  3. owned process on hold                  -> hold
 *  4. owned idle process with background work -> background
 *  5. external process/tail/bridge is active -> running / waiting-input
 *  6. live runtime could not be inspected    -> unknown
 *  7. owned idle process                     -> the turn's outcome
 *  8. nobody drives the session              -> persisted outcome
 *
 * `unknown` ("cannot tell whether it is still running") is reserved for case
 * 6. Whenever Yep owns the process or knows that nothing runs the session, it
 * states the outcome instead.
 */

/**
 * How long a just-finished turn's live outcome outranks a transcript that
 * still reads mid-turn. Providers flush their transcript shortly after the
 * turn's `result`; past this window the transcript is believed.
 */
export const LAST_TURN_OUTCOME_GRACE_MS = 5_000;

export interface SessionLifecycleTurnOutcome {
  status: Exclude<SessionLastTurnStatus, "incomplete">;
  endedAt: number;
}

/** The live process as every runtime source can describe it. */
export interface SessionRuntimeProcess {
  id: string;
  state: AgentActivity | { type: AgentActivity };
  permissionMode?: PermissionMode;
  modeVersion?: number;
  retryStatus?: import("@yep-anywhere/shared").SessionRetryStatus;
  pendingInputRequest?: { type: string; id?: string } | null;
  getPendingInputRequest?: () => { type: string; id?: string } | null;
  /** Idle, but provider-side background work will start a turn on its own. */
  hasPendingBackgroundWork?: boolean;
  /** How the most recent turn ended, cleared when the next one starts. */
  lastTurnOutcome?: SessionLifecycleTurnOutcome;
}

export interface SessionLifecycleEvidence {
  /** The process Yep owns for this session, if any. */
  process?: SessionRuntimeProcess | null;
  /** A pending approval/question is known even if the state lags behind. */
  pendingInput?: boolean;
  /** An external process, log tail or bridge proves the session is live. */
  externalActive?: boolean;
  externalActivity?: AgentActivity;
  /** Ownership recorded on the summary, used when nothing live is known. */
  fallbackOwnership?: SessionOwnership;
  /** Terminal status read off the persisted history. */
  persistedLastTurnStatus?: SessionLastTurnStatus;
  /** Claude's legacy flag; same meaning as `incomplete`. */
  persistedInterrupted?: boolean;
  /** True only when inspecting the live runtime itself failed. */
  runtimeUnavailable?: boolean;
  /** Clock override for tests. */
  now?: number;
}

export type SessionLifecycleDisplayState = Exclude<
  SessionDisplayActivity["state"],
  "finishing"
>;

export interface ResolvedSessionLifecycle {
  runtime: SessionRuntime;
  /** The persisted last-turn status as the user should see it. */
  visibleLastTurnStatus?: SessionLastTurnStatus;
  /** The display projection's activity state. */
  displayActivity: SessionLifecycleDisplayState;
  /** Open tool calls may still receive results. */
  toolsMayBeActive: boolean;
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

function hasPendingInput(
  process: SessionRuntimeProcess | null | undefined,
): boolean {
  return Boolean(
    process?.pendingInputRequest ?? process?.getPendingInputRequest?.(),
  );
}

export function resolveSessionLifecycle(
  evidence: SessionLifecycleEvidence,
): ResolvedSessionLifecycle {
  const {
    process,
    externalActive = false,
    externalActivity,
    fallbackOwnership,
    runtimeUnavailable = false,
  } = evidence;
  const now = evidence.now ?? Date.now();

  const ownership: SessionOwnership = process
    ? buildSelfOwnership(process)
    : externalActive
      ? { owner: "external" }
      : (fallbackOwnership ?? { owner: "none" });

  const activity = process
    ? getProcessActivity(process)
    : externalActive
      ? externalActivity
      : undefined;

  const backgroundWork =
    Boolean(process) &&
    activity === "idle" &&
    process?.hasPendingBackgroundWork === true;
  const isExternal = ownership.owner === "external" && externalActive;
  const isBusy = isBusyActivity(activity) || isExternal || backgroundWork;
  const hasResidentWorker = Boolean(process && activity === "idle");
  const block = isBusy
    ? getSessionArchiveBlock(ownership, activity, {
        hasPendingBackgroundWork: backgroundWork,
      })
    : {};

  const runtime: SessionRuntime = {
    ownership,
    activity,
    isBusy,
    hasResidentWorker,
    ...(backgroundWork ? { hasPendingBackgroundWork: true } : {}),
    canArchive: !isBusy,
    ...block,
  };

  const persisted =
    evidence.persistedLastTurnStatus ??
    (evidence.persistedInterrupted ? "incomplete" : undefined);
  const pendingInput =
    evidence.pendingInput === true ||
    hasPendingInput(process) ||
    activity === "waiting-input";

  // Something may still be writing this history, so a mid-turn shape is
  // not an outcome yet. Recorded outcomes always pass.
  const liveWriter =
    isBusyActivity(activity) ||
    pendingInput ||
    backgroundWork ||
    isExternal ||
    runtimeUnavailable ||
    // A recorded owner nobody can see right now: keep the old caution.
    (!process && ownership.owner !== "none");
  let visibleLastTurnStatus: SessionLastTurnStatus | undefined;
  if (liveWriter) {
    visibleLastTurnStatus = persisted === "incomplete" ? undefined : persisted;
  } else if (process) {
    // Owned and idle: the process saw how its last turn ended.
    const outcome = process.lastTurnOutcome;
    const fresh =
      outcome !== undefined &&
      now - outcome.endedAt < LAST_TURN_OUTCOME_GRACE_MS;
    if (persisted === "incomplete")
      visibleLastTurnStatus = fresh ? outcome?.status : "incomplete";
    else visibleLastTurnStatus = persisted ?? outcome?.status;
  } else {
    visibleLastTurnStatus = persisted;
  }

  let displayActivity: SessionLifecycleDisplayState;
  if (pendingInput) displayActivity = "waiting-input";
  else if (activity === "in-turn") displayActivity = "running";
  else if (activity === "hold") displayActivity = "hold";
  else if (backgroundWork) displayActivity = "background";
  else if (isExternal) displayActivity = "running";
  else if (runtimeUnavailable) displayActivity = "unknown";
  else if (!process && ownership.owner !== "none")
    displayActivity = visibleLastTurnStatus ?? "unknown";
  else displayActivity = visibleLastTurnStatus ?? "completed";

  return {
    runtime,
    visibleLastTurnStatus,
    displayActivity,
    toolsMayBeActive:
      displayActivity === "running" ||
      displayActivity === "waiting-input" ||
      displayActivity === "hold" ||
      displayActivity === "background",
  };
}

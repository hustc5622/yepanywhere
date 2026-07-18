import type { AgentActivity } from "@yep-anywhere/shared";
import type {
  OpenCodeAssistantTerminalEvidence,
  OpenCodeRetryStatus,
  OpenCodeUpstreamStatus,
} from "./status.js";

export const OPENCODE_IDLE_QUIET_WINDOW_MS = 250;
export const OPENCODE_ACTIVE_RECONCILE_INTERVAL_MS = 1_000;
export const OPENCODE_STATUS_FAILURE_GRACE_MS = 15_000;

export type OpenCodeLifecyclePhase =
  | "idle"
  | "running"
  | "retrying"
  | "idle-candidate"
  | "terminal";

export interface OpenCodeIdleCandidate {
  generation: number;
  sequence: number;
  startedAt: number;
  idleSamples: number;
}

export interface OpenCodeLifecycleState {
  generation: number;
  sequence: number;
  phase: OpenCodeLifecyclePhase;
  lastActivePhase: "running" | "retrying";
  waitingInput: boolean;
  retryStatus?: OpenCodeRetryStatus;
  idleCandidate?: OpenCodeIdleCandidate;
  assistantEvidence: OpenCodeAssistantTerminalEvidence;
  unsettledTools: number;
  lastActivityAt: number;
  reconcileFailureSince?: number;
  terminalKind?: "completed" | "failed" | "interrupted";
}

export interface OpenCodeLifecycleProjection {
  activity: AgentActivity;
  active: boolean;
  retryStatus?: OpenCodeRetryStatus;
  terminal: boolean;
  terminalKind?: "completed" | "failed" | "interrupted";
}

export type OpenCodeLifecycleAction =
  | { type: "start-turn"; now: number }
  | {
      type: "status-event";
      now: number;
      status: OpenCodeUpstreamStatus;
    }
  | {
      type: "status-reconciled";
      now: number;
      status: OpenCodeUpstreamStatus;
      expectedSequence?: number;
      quietWindowMs?: number;
    }
  | { type: "activity"; now: number }
  | {
      type: "assistant-evidence";
      now: number;
      evidence: OpenCodeAssistantTerminalEvidence;
    }
  | { type: "unsettled-tools"; now: number; count: number }
  | { type: "pending-input"; now: number; pending: boolean }
  | {
      type: "reconcile-failed";
      now: number;
      expectedSequence?: number;
      graceMs?: number;
    }
  | {
      type: "terminal";
      now: number;
      kind: "completed" | "failed" | "interrupted";
    };

export function createOpenCodeLifecycleState(
  now = Date.now(),
): OpenCodeLifecycleState {
  return {
    generation: 0,
    sequence: 0,
    phase: "idle",
    lastActivePhase: "running",
    waitingInput: false,
    assistantEvidence: "unknown",
    unsettledTools: 0,
    lastActivityAt: now,
  };
}

function startActiveGeneration(
  state: OpenCodeLifecycleState,
  now: number,
): OpenCodeLifecycleState {
  return {
    ...state,
    generation: state.generation + 1,
    sequence: state.sequence + 1,
    phase: "running",
    lastActivePhase: "running",
    waitingInput: false,
    retryStatus: undefined,
    idleCandidate: undefined,
    assistantEvidence: "unknown",
    unsettledTools: 0,
    lastActivityAt: now,
    reconcileFailureSince: undefined,
    terminalKind: undefined,
  };
}

function ensureActiveGeneration(
  state: OpenCodeLifecycleState,
  now: number,
): OpenCodeLifecycleState {
  return state.phase === "idle" || state.phase === "terminal"
    ? startActiveGeneration(state, now)
    : state;
}

function applyActiveStatus(
  state: OpenCodeLifecycleState,
  status: OpenCodeUpstreamStatus,
  now: number,
): OpenCodeLifecycleState {
  const active = ensureActiveGeneration(state, now);
  const retrying = status.type === "retry";
  return {
    ...active,
    sequence: active.sequence + 1,
    phase: retrying ? "retrying" : "running",
    lastActivePhase: retrying ? "retrying" : "running",
    retryStatus: retrying ? status.retryStatus : undefined,
    idleCandidate: undefined,
    lastActivityAt: now,
    reconcileFailureSince: undefined,
    terminalKind: undefined,
  };
}

function markIdleCandidate(
  state: OpenCodeLifecycleState,
  now: number,
): OpenCodeLifecycleState {
  if (state.phase === "idle" || state.phase === "terminal") return state;
  const sequence = state.sequence + 1;
  return {
    ...state,
    sequence,
    phase: "idle-candidate",
    retryStatus: undefined,
    idleCandidate: state.idleCandidate
      ? {
          ...state.idleCandidate,
          sequence,
          idleSamples: state.idleCandidate.idleSamples + 1,
        }
      : {
          generation: state.generation,
          sequence,
          startedAt: now,
          idleSamples: 1,
        },
    reconcileFailureSince: undefined,
  };
}

function terminal(
  state: OpenCodeLifecycleState,
  kind: "completed" | "failed" | "interrupted",
): OpenCodeLifecycleState {
  if (state.phase === "terminal") return state;
  return {
    ...state,
    sequence: state.sequence + 1,
    phase: "terminal",
    waitingInput: false,
    retryStatus: undefined,
    idleCandidate: undefined,
    reconcileFailureSince: undefined,
    terminalKind: kind,
  };
}

/** Deterministic reducer shared by the managed provider and the 4520 bridge. */
export function reduceOpenCodeLifecycle(
  state: OpenCodeLifecycleState,
  action: OpenCodeLifecycleAction,
): OpenCodeLifecycleState {
  if (action.type === "start-turn") {
    return startActiveGeneration(state, action.now);
  }

  if (action.type === "terminal") {
    return terminal(state, action.kind);
  }

  if (
    "expectedSequence" in action &&
    action.expectedSequence !== undefined &&
    action.expectedSequence !== state.sequence
  ) {
    return state;
  }

  if (action.type === "status-event") {
    return action.status.type === "idle"
      ? markIdleCandidate(state, action.now)
      : applyActiveStatus(state, action.status, action.now);
  }

  if (action.type === "status-reconciled") {
    if (action.status.type !== "idle") {
      return applyActiveStatus(state, action.status, action.now);
    }

    const candidate = markIdleCandidate(state, action.now);
    if (!candidate.idleCandidate || candidate.waitingInput) return candidate;
    const quietWindowMs = action.quietWindowMs ?? OPENCODE_IDLE_QUIET_WINDOW_MS;
    const quiet =
      action.now - candidate.idleCandidate.startedAt >= quietWindowMs;
    const terminalEvidence = candidate.assistantEvidence === "terminal";
    const compatibilityEvidence =
      candidate.assistantEvidence === "unknown" &&
      candidate.idleCandidate.idleSamples >= 2;
    if (
      quiet &&
      candidate.unsettledTools === 0 &&
      (terminalEvidence || compatibilityEvidence)
    ) {
      return terminal(candidate, "completed");
    }
    return candidate;
  }

  if (action.type === "activity") {
    if (state.phase === "terminal") return state;
    const active = ensureActiveGeneration(state, action.now);
    return {
      ...active,
      sequence: active.sequence + 1,
      phase: "running",
      lastActivePhase: "running",
      retryStatus: undefined,
      idleCandidate: undefined,
      lastActivityAt: action.now,
      reconcileFailureSince: undefined,
      terminalKind: undefined,
    };
  }

  if (action.type === "assistant-evidence") {
    if (state.phase === "terminal") return state;
    const active = ensureActiveGeneration(state, action.now);
    if (action.evidence === "nonterminal") {
      return {
        ...active,
        sequence: active.sequence + 1,
        phase: "running",
        lastActivePhase: "running",
        retryStatus: undefined,
        idleCandidate: undefined,
        assistantEvidence: action.evidence,
        lastActivityAt: action.now,
        reconcileFailureSince: undefined,
      };
    }
    const sequence = active.sequence + 1;
    return {
      ...active,
      sequence,
      assistantEvidence: action.evidence,
      idleCandidate: active.idleCandidate
        ? { ...active.idleCandidate, sequence }
        : undefined,
      reconcileFailureSince: undefined,
    };
  }

  if (action.type === "unsettled-tools") {
    if (state.phase === "terminal") return state;
    const active = ensureActiveGeneration(state, action.now);
    if (action.count > 0) {
      return {
        ...active,
        sequence: active.sequence + 1,
        phase: "running",
        lastActivePhase: "running",
        retryStatus: undefined,
        idleCandidate: undefined,
        unsettledTools: action.count,
        lastActivityAt: action.now,
        reconcileFailureSince: undefined,
      };
    }
    return {
      ...active,
      sequence: active.sequence + 1,
      unsettledTools: 0,
      reconcileFailureSince: undefined,
    };
  }

  if (action.type === "pending-input") {
    if (
      !action.pending &&
      (state.phase === "idle" || state.phase === "terminal")
    ) {
      return state;
    }
    const active = ensureActiveGeneration(state, action.now);
    return {
      ...active,
      sequence: active.sequence + 1,
      waitingInput: action.pending,
      phase: action.pending
        ? active.phase
        : active.phase === "idle-candidate"
          ? "idle-candidate"
          : active.lastActivePhase,
      lastActivityAt: action.pending ? action.now : active.lastActivityAt,
      reconcileFailureSince: undefined,
    };
  }

  const failureSince = state.reconcileFailureSince ?? action.now;
  const graceMs = action.graceMs ?? OPENCODE_STATUS_FAILURE_GRACE_MS;
  if (action.now - failureSince >= graceMs) {
    return terminal(
      { ...state, reconcileFailureSince: failureSince },
      "interrupted",
    );
  }
  return { ...state, reconcileFailureSince: failureSince };
}

export function projectOpenCodeLifecycle(
  state: OpenCodeLifecycleState,
): OpenCodeLifecycleProjection {
  if (state.phase === "idle" || state.phase === "terminal") {
    return {
      activity: "idle",
      active: false,
      terminal: state.phase === "terminal",
      terminalKind: state.terminalKind,
    };
  }
  if (state.waitingInput) {
    return {
      activity: "waiting-input",
      active: true,
      terminal: false,
    };
  }
  return {
    activity: "in-turn",
    active: true,
    retryStatus:
      state.phase === "retrying" || state.lastActivePhase === "retrying"
        ? state.retryStatus
        : undefined,
    terminal: false,
  };
}

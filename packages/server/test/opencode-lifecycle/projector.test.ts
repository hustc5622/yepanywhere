import { describe, expect, it } from "vitest";
import {
  createOpenCodeLifecycleState,
  parseOpenCodeUpstreamStatus,
  projectOpenCodeLifecycle,
  readOpenCodeAssistantTerminalEvidence,
  readOpenCodeSessionStatus,
  reduceOpenCodeLifecycle,
} from "../../src/opencode-lifecycle/index.js";

describe("OpenCode lifecycle projector", () => {
  it("suppresses an idle edge that is followed by busy inside the quiet window", () => {
    let state = createOpenCodeLifecycleState(0);
    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 1,
      status: { type: "busy" },
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 10,
      status: { type: "idle" },
    });

    expect(state.phase).toBe("idle-candidate");
    expect(projectOpenCodeLifecycle(state)).toMatchObject({
      activity: "in-turn",
      active: true,
      terminal: false,
    });

    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 100,
      status: { type: "busy" },
    });
    expect(state.phase).toBe("running");
    expect(state.idleCandidate).toBeUndefined();
  });

  it("keeps retry active and preserves retry details", () => {
    const state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "status-event",
      now: 1,
      status: {
        type: "retry",
        retryStatus: {
          attempt: 2,
          message: "rate limited",
          next: 1_000,
        },
      },
    });

    expect(state.phase).toBe("retrying");
    expect(projectOpenCodeLifecycle(state)).toEqual({
      activity: "in-turn",
      active: true,
      retryStatus: {
        attempt: 2,
        message: "rate limited",
        next: 1_000,
      },
      terminal: false,
    });
  });

  it("confirms terminal assistant output only after stable authoritative idle", () => {
    let state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "start-turn",
      now: 1,
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "assistant-evidence",
      now: 10,
      evidence: "terminal",
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 20,
      status: { type: "idle" },
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-reconciled",
      now: 270,
      status: { type: "idle" },
      expectedSequence: state.sequence,
      quietWindowMs: 250,
    });

    expect(state.phase).toBe("terminal");
    expect(state.terminalKind).toBe("completed");
    expect(projectOpenCodeLifecycle(state)).toMatchObject({
      activity: "idle",
      active: false,
      terminal: true,
    });
  });

  it("does not complete while the newest assistant still expects tool calls", () => {
    let state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "start-turn",
      now: 1,
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "assistant-evidence",
      now: 10,
      evidence: "nonterminal",
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 20,
      status: { type: "idle" },
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-reconciled",
      now: 500,
      status: { type: "idle" },
      expectedSequence: state.sequence,
      quietWindowMs: 250,
    });

    expect(state.phase).toBe("idle-candidate");
    expect(projectOpenCodeLifecycle(state).active).toBe(true);
  });

  it("completes an unknown finish only after stable authoritative idle", () => {
    let state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "start-turn",
      now: 1,
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "assistant-evidence",
      now: 10,
      evidence: "terminal",
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 20,
      status: { type: "idle" },
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-reconciled",
      now: 270,
      status: { type: "idle" },
      expectedSequence: state.sequence,
      quietWindowMs: 250,
    });

    expect(state.phase).toBe("terminal");
    expect(state.terminalKind).toBe("completed");
    expect(projectOpenCodeLifecycle(state)).toMatchObject({
      activity: "idle",
      active: false,
      terminal: true,
    });
  });

  it("supports the two-sample idle fallback for old OpenCode metadata", () => {
    let state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "start-turn",
      now: 1,
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 10,
      status: { type: "idle" },
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-reconciled",
      now: 260,
      status: { type: "idle" },
      expectedSequence: state.sequence,
      quietWindowMs: 250,
    });

    expect(state.phase).toBe("terminal");
    expect(state.terminalKind).toBe("completed");
  });

  it("ignores a stale reconcile after newer activity", () => {
    let state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "start-turn",
      now: 1,
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 10,
      status: { type: "idle" },
    });
    const staleSequence = state.sequence;
    state = reduceOpenCodeLifecycle(state, { type: "activity", now: 20 });
    const current = state;

    state = reduceOpenCodeLifecycle(state, {
      type: "status-reconciled",
      now: 500,
      status: { type: "idle" },
      expectedSequence: staleSequence,
      quietWindowMs: 250,
    });

    expect(state).toBe(current);
    expect(state.phase).toBe("running");
  });

  it("ignores late content from a terminal generation until a new busy status", () => {
    let state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "start-turn",
      now: 1,
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "terminal",
      now: 2,
      kind: "completed",
    });
    const terminal = state;

    state = reduceOpenCodeLifecycle(state, { type: "activity", now: 3 });
    state = reduceOpenCodeLifecycle(state, {
      type: "assistant-evidence",
      now: 4,
      evidence: "nonterminal",
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "unsettled-tools",
      now: 5,
      count: 1,
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "pending-input",
      now: 5,
      pending: false,
    });
    expect(state).toBe(terminal);

    state = reduceOpenCodeLifecycle(state, {
      type: "status-event",
      now: 6,
      status: { type: "busy" },
    });
    expect(state.phase).toBe("running");
    expect(state.generation).toBe(2);
  });

  it("gives pending input priority and returns to the active phase", () => {
    let state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "status-event",
      now: 1,
      status: { type: "busy" },
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "pending-input",
      now: 2,
      pending: true,
    });
    expect(projectOpenCodeLifecycle(state).activity).toBe("waiting-input");

    state = reduceOpenCodeLifecycle(state, {
      type: "pending-input",
      now: 3,
      pending: false,
    });
    expect(projectOpenCodeLifecycle(state).activity).toBe("in-turn");
    expect(projectOpenCodeLifecycle(state).active).toBe(true);
  });

  it("ends as interrupted only after the bounded reconcile grace", () => {
    let state = reduceOpenCodeLifecycle(createOpenCodeLifecycleState(0), {
      type: "start-turn",
      now: 1,
    });
    state = reduceOpenCodeLifecycle(state, {
      type: "reconcile-failed",
      now: 10,
      graceMs: 100,
    });
    expect(state.phase).toBe("running");

    state = reduceOpenCodeLifecycle(state, {
      type: "reconcile-failed",
      now: 110,
      expectedSequence: state.sequence,
      graceMs: 100,
    });
    expect(state.phase).toBe("terminal");
    expect(state.terminalKind).toBe("interrupted");
  });
});

describe("OpenCode lifecycle status normalization", () => {
  it("normalizes legacy running and retry payloads", () => {
    expect(parseOpenCodeUpstreamStatus({ type: "running" })).toEqual({
      type: "busy",
    });
    expect(
      parseOpenCodeUpstreamStatus({
        type: "retry",
        attempt: 3,
        message: "try again",
        next: 4_000,
        action: { label: "Details", link: "https://example.test" },
      }),
    ).toEqual({
      type: "retry",
      retryStatus: {
        attempt: 3,
        message: "try again",
        next: 4_000,
        actionLabel: "Details",
        actionLink: "https://example.test",
      },
    });
  });

  it("treats an omitted status-map entry as idle", () => {
    expect(readOpenCodeSessionStatus({}, "ses_idle")).toEqual({ type: "idle" });
  });

  it("classifies assistant finish metadata", () => {
    expect(
      readOpenCodeAssistantTerminalEvidence({
        info: {
          role: "assistant",
          finish: "stop",
          time: { completed: 1 },
        },
      }),
    ).toBe("terminal");
    expect(
      readOpenCodeAssistantTerminalEvidence({
        info: {
          role: "assistant",
          finish: "tool-calls",
          time: { completed: 1 },
        },
      }),
    ).toBe("nonterminal");
    expect(
      readOpenCodeAssistantTerminalEvidence({
        info: {
          role: "assistant",
          finish: "unknown",
          time: { completed: 1 },
        },
      }),
    ).toBe("terminal");
    expect(
      readOpenCodeAssistantTerminalEvidence({
        info: {
          role: "assistant",
          finish: "unknown",
          time: { created: 1 },
        },
      }),
    ).toBe("nonterminal");
  });
});

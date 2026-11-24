import { describe, expect, it } from "vitest";
import {
  pendingInputTypeFromProcess,
  pendingInputTypeFromRequest,
  presentLastTurnStatus,
} from "../../src/sessions/session-runtime.js";

describe("presentLastTurnStatus", () => {
  it("shows a history that stops mid-turn only when nothing still writes it", () => {
    expect(presentLastTurnStatus("incomplete", { owner: "none" })).toBe(
      "incomplete",
    );
    // A live writer (an external agent, or an owner whose state is not
    // known to be settled) writes exactly that shape while it works.
    expect(
      presentLastTurnStatus("incomplete", { owner: "self" }),
    ).toBeUndefined();
    expect(
      presentLastTurnStatus("incomplete", { owner: "external" }),
    ).toBeUndefined();
    for (const activity of ["in-turn", "waiting-input", "hold"] as const) {
      expect(
        presentLastTurnStatus("incomplete", { owner: "self", activity }),
      ).toBeUndefined();
    }
    expect(
      presentLastTurnStatus("incomplete", {
        owner: "self",
        activity: "idle",
        hasPendingBackgroundWork: true,
      }),
    ).toBeUndefined();
  });

  it("shows an idle owner's mid-turn history once its own outcome is stale", () => {
    const now = 1_000_000;
    // Idle, no turn outcome observed (e.g. resumed without a turn).
    expect(
      presentLastTurnStatus("incomplete", {
        owner: "self",
        activity: "idle",
        now,
      }),
    ).toBe("incomplete");
    // Just finished: trust the process while the transcript flushes.
    expect(
      presentLastTurnStatus("incomplete", {
        owner: "self",
        activity: "idle",
        lastTurnOutcome: { status: "completed", endedAt: now - 1_000 },
        now,
      }),
    ).toBe("completed");
    expect(
      presentLastTurnStatus("incomplete", {
        owner: "self",
        activity: "idle",
        lastTurnOutcome: { status: "completed", endedAt: now - 60_000 },
        now,
      }),
    ).toBe("incomplete");
  });

  it("always passes recorded outcomes", () => {
    for (const owner of ["self", "external", "none"] as const) {
      expect(presentLastTurnStatus("interrupted", { owner })).toBe(
        "interrupted",
      );
      expect(presentLastTurnStatus("failed", { owner })).toBe("failed");
      expect(presentLastTurnStatus("completed", { owner })).toBe("completed");
    }
  });
});

describe("pendingInputTypeFromRequest", () => {
  it("keeps tool approval and folds every other request into a user question", () => {
    expect(pendingInputTypeFromRequest({ type: "tool-approval" })).toBe(
      "tool-approval",
    );
    expect(pendingInputTypeFromRequest({ type: "question" })).toBe(
      "user-question",
    );
    expect(pendingInputTypeFromRequest({ type: "choice" })).toBe(
      "user-question",
    );
    expect(pendingInputTypeFromRequest(null)).toBeUndefined();
    expect(pendingInputTypeFromRequest(undefined)).toBeUndefined();
  });

  it("reads a resident request before the process getter", () => {
    expect(
      pendingInputTypeFromProcess({
        id: "process-1",
        state: "waiting-input",
        pendingInputRequest: { type: "tool-approval", id: "req-1" },
        getPendingInputRequest: () => ({ type: "question", id: "req-2" }),
      }),
    ).toBe("tool-approval");
    expect(
      pendingInputTypeFromProcess({
        id: "process-2",
        state: "waiting-input",
        getPendingInputRequest: () => ({ type: "question", id: "req-2" }),
      }),
    ).toBe("user-question");
    expect(pendingInputTypeFromProcess(null)).toBeUndefined();
  });
});

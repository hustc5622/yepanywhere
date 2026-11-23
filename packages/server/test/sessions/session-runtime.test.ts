import { describe, expect, it } from "vitest";
import {
  pendingInputTypeFromProcess,
  pendingInputTypeFromRequest,
  presentLastTurnStatus,
} from "../../src/sessions/session-runtime.js";

describe("presentLastTurnStatus", () => {
  it("shows a history that stops mid-turn only when nobody drives it", () => {
    expect(presentLastTurnStatus("incomplete", { owner: "none" })).toBe(
      "incomplete",
    );
    // An owner (or an external agent) writes exactly that shape while it
    // works; its live state is authoritative.
    expect(
      presentLastTurnStatus("incomplete", { owner: "self" }),
    ).toBeUndefined();
    expect(
      presentLastTurnStatus("incomplete", { owner: "external" }),
    ).toBeUndefined();
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

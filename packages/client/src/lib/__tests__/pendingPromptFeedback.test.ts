import { describe, expect, it } from "vitest";
import { pendingPromptStatusKey } from "../pendingPromptFeedback";

describe("pendingPromptStatusKey", () => {
  it("marks a mid-turn prompt as waiting for the running turn", () => {
    expect(pendingPromptStatusKey("pi", "self", "in-turn")).toBe(
      "sessionInsertWaiting",
    );
    expect(pendingPromptStatusKey("mcode", "self", "waiting-input")).toBe(
      "sessionInsertWaiting",
    );
    expect(pendingPromptStatusKey("pi", "self", "hold")).toBe(
      "sessionInsertWaiting",
    );
  });

  it("uses the plain sending label when the session is idle", () => {
    expect(pendingPromptStatusKey("pi", "self", "idle")).toBeNull();
  });

  it("does not claim an insert for sessions this client does not own", () => {
    expect(pendingPromptStatusKey("pi", "external", "in-turn")).toBeNull();
    expect(pendingPromptStatusKey("pi", "none", "in-turn")).toBeNull();
  });

  it("leaves other providers on their default status", () => {
    expect(pendingPromptStatusKey("claude", "self", "in-turn")).toBeNull();
    expect(pendingPromptStatusKey(undefined, "self", "in-turn")).toBeNull();
  });
});

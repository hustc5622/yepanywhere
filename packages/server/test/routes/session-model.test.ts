import { describe, expect, it } from "vitest";
import { resolveSessionModel } from "../../src/routes/session-model.js";

describe("resolveSessionModel", () => {
  it("maps Claude's displayed default to an explicit Sonnet model", () => {
    expect(resolveSessionModel("default", "claude")).toBe("sonnet");
  });

  it("keeps explicit Claude model selections", () => {
    expect(resolveSessionModel("claude-fable-5[1m]", "claude")).toBe(
      "claude-fable-5[1m]",
    );
  });

  it("preserves native defaults for other providers", () => {
    expect(resolveSessionModel("default", "codex")).toBeUndefined();
  });

  it("does not invent a model when none was requested", () => {
    expect(resolveSessionModel(undefined, "claude")).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  DisplaySchemaMismatchError,
  isDisplaySchemaMismatchError,
  parseDisplaySnapshot,
} from "../displaySchemaMismatch";

function snapshot(segment: Record<string, unknown>) {
  return {
    version: 2,
    view: { sessionId: "s", branchScopeId: "active", epoch: "e" },
    seq: 1,
    nodes: [
      { type: "segment", id: "a", turnId: "t", segment },
      { type: "segment", id: "b", turnId: "t", segment },
    ],
    activity: { state: "completed", tools: [], runningCount: 0 },
  };
}

const text = {
  type: "assistant_text",
  id: "text",
  phase: "final",
  content: "hi",
};

describe("parseDisplaySnapshot", () => {
  it("returns valid snapshots", () => {
    expect(parseDisplaySnapshot(snapshot(text), "test").nodes).toHaveLength(2);
  });

  it("turns schema drift into a summarized mismatch error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let caught: unknown;
    try {
      parseDisplaySnapshot(
        snapshot({ ...text, futureField: "x" }),
        "mismatch test",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DisplaySchemaMismatchError);
    expect(isDisplaySchemaMismatchError(caught)).toBe(true);
    // Repeated node issues collapse into one line with a wildcard index.
    expect((caught as DisplaySchemaMismatchError).detail).toBe(
      "nodes.*.segment: unrecognized_keys (futureField)",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not classify unrelated errors", () => {
    expect(isDisplaySchemaMismatchError(new Error("boom"))).toBe(false);
  });
});

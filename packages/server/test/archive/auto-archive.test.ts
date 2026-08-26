import { describe, expect, it } from "vitest";
import { shouldSkipAutoArchiveForPinnedSession } from "../../src/app.js";

describe("auto archive guards", () => {
  it("skips sessions pinned in persisted metadata", () => {
    expect(
      shouldSkipAutoArchiveForPinnedSession(
        { isStarred: false },
        { isStarred: true },
      ),
    ).toBe(true);
  });

  it("skips sessions pinned in session summaries", () => {
    expect(
      shouldSkipAutoArchiveForPinnedSession({ isStarred: true }, undefined),
    ).toBe(true);
  });

  it("allows unpinned sessions to be auto-archived", () => {
    expect(
      shouldSkipAutoArchiveForPinnedSession({ isStarred: false }, undefined),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { collapseEditForkFamilies } from "../../src/sessions/edit-fork-families.js";

const summary = (
  id: string,
  updatedAt: string,
  forkParentSessionId?: string,
) => ({
  id,
  updatedAt,
  ...(forkParentSessionId ? { forkParentSessionId } : {}),
});

describe("collapseEditForkFamilies", () => {
  it("retains hidden ancestors across incremental inserts and missing intermediate rows", () => {
    const source = summary("root", "2026-07-15T00:00:00Z");
    const child = summary("child", "2026-07-15T01:00:00Z", "root");
    const grandchild = summary("grandchild", "2026-07-15T02:00:00Z", "child");
    const collapsed = collapseEditForkFamilies([source, child, grandchild]);
    expect(collapsed).toHaveLength(1);
    expect(
      collapseEditForkFamilies([...collapsed, source, child]),
    ).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      forkFamilySessionIds: expect.arrayContaining([
        "root",
        "child",
        "grandchild",
      ]),
    });
    expect(
      collapseEditForkFamilies([
        summary("left", "2026-07-15T01:00:00Z", "missing"),
        summary("right", "2026-07-15T02:00:00Z", "missing"),
      ]),
    ).toHaveLength(1);
  });
  it("keeps only the most recently updated member of a fork family", () => {
    const summaries = [
      summary("ses_parent", "2026-07-15T00:00:00.000Z"),
      summary("ses_child", "2026-07-15T01:00:00.000Z", "ses_parent"),
      summary("ses_grandchild", "2026-07-15T02:00:00.000Z", "ses_child"),
    ];

    expect(collapseEditForkFamilies(summaries).map((item) => item.id)).toEqual([
      "ses_grandchild",
    ]);
  });

  it("keeps the newest root when work returns to the original branch", () => {
    const summaries = [
      summary("ses_parent", "2026-07-15T05:00:00.000Z"),
      summary("ses_child", "2026-07-15T01:00:00.000Z", "ses_parent"),
    ];

    expect(collapseEditForkFamilies(summaries).map((item) => item.id)).toEqual([
      "ses_parent",
    ]);
  });

  it("keeps unrelated sessions and sessions with dangling parents", () => {
    const summaries = [
      summary("ses_solo", "2026-07-15T00:00:00.000Z"),
      summary("ses_parent", "2026-07-15T00:00:00.000Z"),
      summary("ses_child", "2026-07-15T01:00:00.000Z", "ses_parent"),
      summary("ses_orphan", "2026-07-15T00:00:00.000Z", "ses_missing"),
    ];

    expect(
      collapseEditForkFamilies(summaries)
        .map((item) => item.id)
        .sort(),
    ).toEqual(["ses_child", "ses_orphan", "ses_solo"]);
  });

  it("returns the original array when there are no fork edges", () => {
    const summaries = [
      summary("ses_a", "2026-07-15T00:00:00.000Z"),
      summary("ses_b", "2026-07-15T01:00:00.000Z"),
    ];

    expect(collapseEditForkFamilies(summaries)).toBe(summaries);
  });
});

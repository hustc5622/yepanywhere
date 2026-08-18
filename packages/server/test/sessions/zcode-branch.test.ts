import type { ZCodeStoredMessage } from "@yep-anywhere/shared";
/**
 * buildZCodeBranchView unit tests (pure function, synthetic message lists).
 *
 * Covers the zcode-specific boundary derivation: the fork's copied prefix
 * (fresh ids, identical text) never produces branch options, and the edited
 * original prompt in the parent is derived as the first user message after
 * the matched prefix so the replacement prompt renders as its sibling.
 */
import { describe, expect, it } from "vitest";
import {
  type ZCodeBranchFamilySession,
  buildZCodeBranchView,
} from "../../src/sessions/zcode-branch.js";

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt?: number,
): ZCodeStoredMessage {
  return {
    id,
    role,
    createdAt,
    parts: text
      ? [{ id: `${id}-p0`, messageID: id, sessionID: "", type: "text", text }]
      : [],
  };
}

function family(
  ...sessions: ZCodeBranchFamilySession[]
): ZCodeBranchFamilySession[] {
  return sessions;
}

describe("buildZCodeBranchView", () => {
  it("renders the edited prompt as a sibling of the original boundary", () => {
    const T = Date.UTC(2026, 7, 12, 12, 0, 0);
    const sessions = family(
      {
        id: "root",
        createdAt: new Date(T).toISOString(),
        messages: [
          msg("u1", "user", "first prompt", T),
          msg("a1", "assistant", "answer 1", T + 100),
          msg("u2", "user", "original edited text", T + 200),
          msg("a2", "assistant", "answer 2", T + 300),
          msg("u3", "user", "third prompt", T + 400),
        ],
      },
      {
        id: "child",
        parentId: "root",
        createdAt: new Date(T + 1000).toISOString(),
        // Copied prefix (fresh ids, identical text) up to the fork target a1,
        // then the replacement prompt.
        messages: [
          msg("u1c", "user", "first prompt", T),
          msg("a1c", "assistant", "answer 1", T + 100),
          msg("u2c", "user", "edited replacement text", T + 500),
        ],
      },
    );

    const view = buildZCodeBranchView(sessions, "child");
    expect(view.diagnostics).toEqual([]);
    const state = view.branchState;
    expect(state).toBeDefined();
    expect(state?.provider).toBe("zcode");
    expect(state?.sessionId).toBe("child");

    const byId = new Map(state?.branches.map((b) => [b.id, b]));
    // Copied prefix (u1c) never gets an option.
    expect(byId.has("u1c")).toBe(false);
    expect(byId.has("a1c")).toBe(false);

    // Root options: u1 → u2 → u3 chain.
    expect(byId.get("u1")).toMatchObject({
      sessionId: "root",
      parentId: "zcode-session-root:root",
      depth: 1,
      siblingCount: 1,
    });
    expect(byId.get("u2")).toMatchObject({
      sessionId: "root",
      parentId: "u1",
      depth: 2,
      // u2 (original) and u2c (edited) are siblings under u1.
      siblingCount: 2,
      siblingIndex: 1,
    });
    expect(byId.get("u2c")).toMatchObject({
      sessionId: "child",
      parentId: "u1",
      depth: 2,
      siblingCount: 2,
      siblingIndex: 2,
      isActive: true,
    });
    expect(byId.get("u3")).toMatchObject({ parentId: "u2", depth: 3 });

    // Active/selected branch is the current session's last user option.
    expect(state?.activeBranchId).toBe("u2c");
    expect(state?.selectedBranchId).toBe("u2c");
  });

  it("supports chained forks (grandchild inherits through the child boundary)", () => {
    const T = Date.UTC(2026, 7, 12, 12, 0, 0);
    const sessions = family(
      {
        id: "root",
        createdAt: new Date(T).toISOString(),
        messages: [
          msg("u1", "user", "p1", T),
          msg("a1", "assistant", "a1", T + 100),
          msg("u2", "user", "v1", T + 200),
        ],
      },
      {
        id: "child",
        parentId: "root",
        createdAt: new Date(T + 1000).toISOString(),
        messages: [
          msg("u1c", "user", "p1", T),
          msg("a1c", "assistant", "a1", T + 100),
          msg("u2c", "user", "v2", T + 500),
          msg("a2c", "assistant", "a2", T + 600),
        ],
      },
      {
        id: "grandchild",
        parentId: "child",
        createdAt: new Date(T + 2000).toISOString(),
        messages: [
          msg("u1g", "user", "p1", T),
          msg("a1g", "assistant", "a1", T + 100),
          msg("u2g", "user", "v3", T + 700),
        ],
      },
    );

    const view = buildZCodeBranchView(sessions, "grandchild");
    expect(view.diagnostics).toEqual([]);
    const byId = new Map(view.branchState?.branches.map((b) => [b.id, b]));
    // Three siblings (v1 / v2 / v3) all under u1's logical parent slot.
    expect(byId.get("u2")).toMatchObject({
      parentId: "u1",
      siblingCount: 3,
      siblingIndex: 1,
    });
    expect(byId.get("u2c")).toMatchObject({
      parentId: "u1",
      siblingCount: 3,
      siblingIndex: 2,
    });
    expect(byId.get("u2g")).toMatchObject({
      parentId: "u1",
      siblingCount: 3,
      siblingIndex: 3,
      isActive: true,
    });
    expect(view.branchState?.activeBranchId).toBe("u2g");
  });

  it("never emits options for the copied prefix in the currently viewed child", () => {
    const T = Date.UTC(2026, 7, 12);
    const sessions = family(
      {
        id: "root",
        messages: [
          msg("u1", "user", "hello", T),
          msg("a1", "assistant", "hi", T + 1),
          msg("u2", "user", "orig", T + 2),
        ],
      },
      {
        id: "child",
        parentId: "root",
        messages: [
          msg("u1c", "user", "hello", T),
          msg("a1c", "assistant", "hi", T + 1),
          msg("u2c", "user", "edited", T + 3),
        ],
      },
    );
    const view = buildZCodeBranchView(sessions, "child");
    const branchIds = view.branchState?.branches.map((b) => b.id);
    expect(branchIds).toEqual(["u1", "u2", "u2c"]);
    // The current session contributes exactly one new option, and it is active.
    expect(
      view.branchState?.branches.filter((b) => b.isActive).map((b) => b.id),
    ).toEqual(["u2c"]);
  });

  it("detects cycles with a diagnostic while keeping the surviving edge", () => {
    // The cycle edge is dropped so the view
    // degrades to the remaining valid relation instead of looping forever.
    const sessions = family(
      { id: "a", parentId: "b", messages: [msg("u1", "user", "xa", 1)] },
      { id: "b", parentId: "a", messages: [msg("u2", "user", "xb", 2)] },
    );
    const view = buildZCodeBranchView(sessions, "a");
    expect(view.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "lineage_cycle" }),
      ]),
    );
    expect(view.branchState?.branches.map((b) => b.id).sort()).toEqual([
      "u1",
      "u2",
    ]);
  });

  it("skips the edge with a diagnostic when the boundary cannot be derived", () => {
    const T = Date.UTC(2026, 7, 12);
    const sessions = family(
      // Parent has no user message after the common prefix.
      {
        id: "root",
        messages: [
          msg("u1", "user", "only prompt", T),
          msg("a1", "assistant", "a", T + 1),
        ],
      },
      {
        id: "child",
        parentId: "root",
        messages: [
          msg("u1c", "user", "only prompt", T),
          msg("a1c", "assistant", "a", T + 1),
          // Diverges on an assistant continuation — no user boundary exists.
        ],
      },
    );
    const view = buildZCodeBranchView(sessions, "child");
    expect(view.branchState).toBeUndefined();
    expect(view.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_boundary_message",
          sessionId: "child",
          parentSessionId: "root",
        }),
      ]),
    );
  });

  it("reports missing parents and ignores edges to unknown sessions", () => {
    const sessions = family({
      id: "orphan",
      parentId: "gone",
      messages: [msg("u1", "user", "x", 1)],
    });
    const view = buildZCodeBranchView(sessions, "orphan");
    expect(view.branchState).toBeUndefined();
    expect(view.diagnostics).toEqual([
      expect.objectContaining({
        code: "missing_parent",
        sessionId: "orphan",
        parentSessionId: "gone",
      }),
    ]);
  });

  it("flags duplicate non-prefix message ids", () => {
    const T = Date.UTC(2026, 7, 12);
    const sessions = family(
      {
        id: "root",
        messages: [msg("u1", "user", "orig", T), msg("u2", "user", "orig", T)],
      },
      // No parent link (singleton family is not branchable) — duplicate is
      // instead injected via two unrelated family sessions sharing an id.
    );
    // Add a fork child whose boundary works, plus a second session with the
    // same NEW user message id as the child's edited prompt.
    sessions.push(
      {
        id: "child",
        parentId: "root",
        messages: [msg("u2c", "user", "edited", T + 5)],
      },
      {
        id: "child2",
        parentId: "root",
        messages: [msg("u2c", "user", "edited too", T + 6)],
      },
    );
    const view = buildZCodeBranchView(sessions, "child");
    expect(view.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_message_id" }),
      ]),
    );
  });

  it("falls back to the active branch for an unknown selectedBranchId", () => {
    const T = Date.UTC(2026, 7, 12);
    const sessions = family(
      {
        id: "root",
        messages: [msg("u1", "user", "orig", T)],
      },
      {
        id: "child",
        parentId: "root",
        messages: [
          msg("u2c", "user", "edited", T + 5),
          msg("u3c", "user", "followup", T + 6),
        ],
      },
    );
    const view = buildZCodeBranchView(sessions, "child", "nonexistent");
    expect(view.branchState?.selectedBranchId).toBe("u3c");
    // A valid selection is honoured.
    const selected = buildZCodeBranchView(sessions, "child", "u1");
    expect(selected.branchState?.selectedBranchId).toBe("u1");
  });

  it("returns no branch state for a singleton family", () => {
    const view = buildZCodeBranchView(
      [{ id: "solo", messages: [msg("u1", "user", "hi", 1)] }],
      "solo",
    );
    expect(view.branchState).toBeUndefined();
    expect(view.diagnostics).toEqual([]);
  });
});

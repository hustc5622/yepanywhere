import type {
  OpenCodeMessage,
  OpenCodeSessionEntry,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  type OpenCodeBranchSession,
  buildOpenCodeBranchView,
  findOpenCodeBranchFamilySessionIds,
} from "../../src/sessions/opencode-branch.js";

function entry(
  sessionID: string,
  id: string,
  role: "user" | "assistant",
  text: string,
  created: number,
  parentID?: string,
): OpenCodeSessionEntry {
  const message: OpenCodeMessage = {
    id,
    sessionID,
    role,
    time: { created },
    ...(parentID ? { parentID } : {}),
  };
  return {
    message,
    parts: [
      {
        id: `part_${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      },
    ],
  };
}

function session(
  id: string,
  messages: OpenCodeSessionEntry[],
  yepFork?: {
    parentSessionId: string;
    forkMessageId: string;
  },
): OpenCodeBranchSession {
  return {
    id,
    metadata: yepFork
      ? {
          createdBy: "yep",
          source: "yep-anywhere",
          yepFork: {
            schemaVersion: 1,
            kind: "edit-fork",
            ...yepFork,
            createdAt: "2026-07-15T00:00:00.000Z",
          },
        }
      : {},
    createdAt: `2026-07-15T00:00:0${id.length}.000Z`,
    messages,
  };
}

function baseFamily(): OpenCodeBranchSession[] {
  return [
    session("ses_parent", [
      entry("ses_parent", "u1", "user", "first", 1),
      entry("ses_parent", "a1", "assistant", "one", 2, "u1"),
      entry("ses_parent", "u2", "user", "original", 3),
      entry("ses_parent", "a2", "assistant", "two", 4, "u2"),
    ]),
    session(
      "ses_child",
      [
        entry("ses_child", "u1_copy", "user", "first", 1),
        entry("ses_child", "a1_copy", "assistant", "one", 2, "u1_copy"),
        entry("ses_child", "u2_edit", "user", "edited", 5),
        entry(
          "ses_child",
          "a2_edit",
          "assistant",
          "edited answer",
          6,
          "u2_edit",
        ),
      ],
      { parentSessionId: "ses_parent", forkMessageId: "u2" },
    ),
  ];
}

describe("OpenCode edit-fork branch builder", () => {
  it("models the source and edited prompts as cross-session siblings", () => {
    const family = baseFamily();
    const parent = buildOpenCodeBranchView(family, "ses_parent");
    const child = buildOpenCodeBranchView(family, "ses_child", "u2_edit");

    const parentOriginal = parent.branchState?.branches.find(
      (branch) => branch.id === "u2",
    );
    const parentEdit = parent.branchState?.branches.find(
      (branch) => branch.id === "u2_edit",
    );
    expect(parentOriginal).toMatchObject({
      sessionId: "ses_parent",
      siblingCount: 2,
      isActive: true,
    });
    expect(parentEdit).toMatchObject({
      sessionId: "ses_child",
      siblingCount: 2,
      isActive: false,
      parentId: parentOriginal?.parentId,
    });
    expect(parent.branchState?.activeBranchId).toBe("u2");
    expect(child.branchState?.activeBranchId).toBe("u2_edit");
    expect(child.branchState?.selectedBranchId).toBe("u2_edit");
    expect(
      child.branchState?.branches.find((branch) => branch.id === "u2"),
    ).toMatchObject({ sessionId: "ses_parent", isActive: false });
  });

  it("keeps copied history canonical when a grandchild edits a later prompt", () => {
    const family = baseFamily();
    const child = family[1] as OpenCodeBranchSession;
    child.messages.push(
      entry("ses_child", "u3", "user", "third", 7),
      entry("ses_child", "a3", "assistant", "three", 8, "u3"),
    );
    family.push(
      session(
        "ses_grandchild",
        [
          entry("ses_grandchild", "u1_copy_2", "user", "first", 1),
          entry(
            "ses_grandchild",
            "a1_copy_2",
            "assistant",
            "one",
            2,
            "u1_copy_2",
          ),
          entry("ses_grandchild", "u2_edit_copy_2", "user", "edited", 5),
          entry(
            "ses_grandchild",
            "a2_edit_copy_2",
            "assistant",
            "edited answer",
            6,
            "u2_edit_copy_2",
          ),
          entry("ses_grandchild", "u3_edit", "user", "third edited", 9),
        ],
        { parentSessionId: "ses_child", forkMessageId: "u3" },
      ),
    );

    const view = buildOpenCodeBranchView(family, "ses_grandchild");
    const secondPromptAlternatives = view.branchState?.branches.filter(
      (branch) => ["u2", "u2_edit"].includes(branch.id),
    );
    expect(secondPromptAlternatives).toHaveLength(2);
    expect(
      new Set(secondPromptAlternatives?.map((branch) => branch.parentId)).size,
    ).toBe(1);
    expect(
      secondPromptAlternatives?.every((branch) => branch.siblingCount === 2),
    ).toBe(true);

    const thirdPromptAlternatives = view.branchState?.branches.filter(
      (branch) => ["u3", "u3_edit"].includes(branch.id),
    );
    expect(thirdPromptAlternatives?.map((branch) => branch.sessionId)).toEqual([
      "ses_child",
      "ses_grandchild",
    ]);
    expect(
      thirdPromptAlternatives?.every((branch) => branch.siblingCount === 2),
    ).toBe(true);
    expect(
      thirdPromptAlternatives?.every(
        (branch) => branch.parentId === "u2_edit" && branch.depth === 3,
      ),
    ).toBe(true);
    expect(
      view.branchState?.branches.some((branch) =>
        ["u1_copy", "u1_copy_2", "u2_edit_copy_2"].includes(branch.id),
      ),
    ).toBe(false);
    expect(view.branchState?.activeBranchId).toBe("u3_edit");
    expect(view.branchState?.selectedBranchId).toBe("u3_edit");
    expect(
      view.branchState?.branches.find((branch) => branch.id === "u2_edit"),
    ).toMatchObject({
      sessionId: "ses_child",
      siblingCount: 2,
      isActive: false,
    });
    expect(
      view.branchState?.branches.find((branch) => branch.id === "u3_edit"),
    ).toMatchObject({
      sessionId: "ses_grandchild",
      siblingCount: 2,
      isActive: true,
    });
    expect(view.diagnostics).toEqual([]);
    expect(view.branchState?.branches).toHaveLength(5);
    expect(
      view.branchState?.branches.filter(
        (branch) => branch.sessionId === "ses_grandchild",
      ),
    ).toHaveLength(1);
    expect(
      view.branchState?.branches.filter(
        (branch) => branch.sessionId === "ses_child",
      ),
    ).toHaveLength(2);
    expect(
      view.branchState?.branches.filter(
        (branch) => branch.sessionId === "ses_parent",
      ),
    ).toHaveLength(2);
    expect(
      secondPromptAlternatives?.every((branch) => branch.depth === 2),
    ).toBe(true);
  });

  it("does not infer family membership from unrelated or subagent sessions", () => {
    const sessions = [
      ...baseFamily().map(({ id, metadata }) => ({ id, metadata })),
      { id: "ses_unrelated", metadata: {} },
      {
        id: "ses_subagent",
        parentId: "ses_parent",
        metadata: {
          yepFork: {
            schemaVersion: 1,
            kind: "edit-fork",
            parentSessionId: "ses_parent",
            forkMessageId: "u2",
          },
        },
      },
    ];

    expect(findOpenCodeBranchFamilySessionIds(sessions, "ses_parent")).toEqual([
      "ses_parent",
      "ses_child",
    ]);
    expect(
      findOpenCodeBranchFamilySessionIds(sessions, "ses_unrelated"),
    ).toEqual(["ses_unrelated"]);
  });

  it("ignores broken metadata without failing session loading", () => {
    const broken = session(
      "ses_broken",
      [entry("ses_broken", "broken_edit", "user", "broken", 10)],
      { parentSessionId: "ses_parent", forkMessageId: "missing_user" },
    );
    const view = buildOpenCodeBranchView(
      [baseFamily()[0] as OpenCodeBranchSession, broken],
      "ses_parent",
    );

    expect(view.branchState).toBeUndefined();
    expect(view.diagnostics).toContainEqual({
      code: "missing_fork_message",
      sessionId: "ses_broken",
      parentSessionId: "ses_parent",
      forkMessageId: "missing_user",
    });
  });

  it("does not expose a child branch before its replacement user prompt exists", () => {
    const parent = baseFamily()[0] as OpenCodeBranchSession;
    const emptyChild = session(
      "ses_empty",
      [
        entry("ses_empty", "u1_empty_copy", "user", "first", 1),
        entry(
          "ses_empty",
          "a1_empty_copy",
          "assistant",
          "one",
          2,
          "u1_empty_copy",
        ),
      ],
      { parentSessionId: "ses_parent", forkMessageId: "u2" },
    );

    const view = buildOpenCodeBranchView([parent, emptyChild], "ses_parent");
    expect(view.branchState).toBeUndefined();
  });
});

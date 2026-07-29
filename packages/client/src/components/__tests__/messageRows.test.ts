import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import type { RenderItem } from "../../types/renderItems";
import {
  type PendingMessage,
  buildMessageRows,
  getBranchId,
  getRowKey,
  groupItemsIntoTurns,
} from "../messageRows";

function msg(overrides: Partial<Message> = {}): Message {
  return { type: "user", ...overrides } as Message;
}

function userPrompt(id: string, extra: Partial<RenderItem> = {}): RenderItem {
  return {
    type: "user_prompt",
    id,
    content: `prompt-${id}`,
    sourceMessages: [msg({ uuid: id })],
    ...extra,
  } as RenderItem;
}

function text(
  id: string,
  value: string,
  timestamp = "2024-01-01T00:00:00Z",
): RenderItem {
  return {
    type: "text",
    id,
    text: value,
    sourceMessages: [msg({ uuid: id, timestamp })],
  } as RenderItem;
}

function toolCall(id: string, overrides: Partial<RenderItem> = {}): RenderItem {
  return {
    type: "tool_call",
    id,
    toolName: "Bash",
    toolInput: {},
    status: "complete",
    sourceMessages: [msg({ uuid: id })],
    ...overrides,
  } as RenderItem;
}

function answeredQuestion(id: string): RenderItem {
  return toolCall(id, {
    toolName: "question",
    toolResult: {
      content: "User answered the question",
      isError: false,
      structured: {
        questions: [],
        answers: { "question-0": ["Recommended"] },
      },
    },
  });
}

describe("groupItemsIntoTurns", () => {
  it("splits user prompts into their own group and coalesces assistant items", () => {
    const items = [
      userPrompt("u1"),
      text("t1", "hi"),
      toolCall("tc1"),
      userPrompt("u2"),
      text("t2", "bye"),
    ];
    const groups = groupItemsIntoTurns(items);
    expect(groups.map((g) => g.isUserPrompt)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(groups[1]?.items).toHaveLength(2);
  });

  it("returns an empty array for no items", () => {
    expect(groupItemsIntoTurns([])).toEqual([]);
  });

  it("splits after an answered question and marks the resumed assistant group", () => {
    const groups = groupItemsIntoTurns([
      userPrompt("u1"),
      text("checkpoint", "Three checks passed; one needs a decision."),
      answeredQuestion("q1"),
      toolCall("probe"),
      text("final", "The probe passed."),
    ]);

    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
      ["u1"],
      ["checkpoint", "q1"],
      ["probe", "final"],
    ]);
    expect(groups.map((group) => group.resumedAfterQuestion)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("does not split at a pending, failed, or unanswered question", () => {
    const pendingQuestion = toolCall("q-pending", {
      toolName: "question",
      status: "pending",
    });
    const failedQuestion = toolCall("q-failed", {
      toolName: "AskUserQuestion",
      status: "error",
      toolResult: { content: "cancelled", isError: true },
    });
    const unansweredQuestion = toolCall("q-unanswered", {
      toolName: "question",
      toolResult: {
        content: "Question completed without an answer",
        isError: false,
        structured: { questions: [], answers: {} },
      },
    });

    const groups = groupItemsIntoTurns([
      text("before", "Need input"),
      pendingQuestion,
      failedQuestion,
      unansweredQuestion,
      toolCall("after"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toHaveLength(5);
    expect(groups[0]?.resumedAfterQuestion).toBe(false);
  });

  it("uses an explicit user prompt instead of an extra resumed marker", () => {
    const groups = groupItemsIntoTurns([
      text("checkpoint", "Choose one."),
      answeredQuestion("q1"),
      userPrompt("explicit-answer"),
      toolCall("after"),
    ]);

    expect(groups.map((group) => group.resumedAfterQuestion)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("getBranchId", () => {
  it("reads branch id from the first source message", () => {
    const item = userPrompt("u1", {
      sourceMessages: [msg({ branch: { branchId: "b1" } as never })],
    });
    expect(getBranchId(item)).toBe("b1");
  });

  it("returns undefined for non-user-prompt items", () => {
    expect(getBranchId(text("t1", "x"))).toBeUndefined();
  });
});

describe("buildMessageRows", () => {
  it("preserves order: load-older, turns, load-newer, pending, deferred, compacting, processing", () => {
    const pending: PendingMessage = {
      tempId: "p1",
      content: "pending",
      timestamp: "t",
    };
    const rows = buildMessageRows({
      items: [userPrompt("u1"), text("t1", "answer")],
      hasOlderMessages: true,
      hasNewerMessages: true,
      pendingMessages: [pending],
      deferredMessages: [{ tempId: "d1", content: "deferred", timestamp: "t" }],
      isCompacting: true,
      focusedBranchItemId: null,
      targetItemId: null,
    });
    expect(rows.map((r) => r.kind)).toEqual([
      "load-older",
      "user-prompt",
      "assistant-turn",
      "load-newer",
      "pending",
      "deferred",
      "compacting",
      "processing",
    ]);
  });

  it("always emits a trailing processing row and omits optional blocks when flags are off", () => {
    const rows = buildMessageRows({
      items: [text("t1", "answer")],
      hasOlderMessages: false,
      hasNewerMessages: false,
      pendingMessages: [],
      deferredMessages: [],
      isCompacting: false,
      focusedBranchItemId: null,
      targetItemId: null,
    });
    expect(rows.map((r) => r.kind)).toEqual(["assistant-turn", "processing"]);
  });

  it("marks the focused branch prompt and target item", () => {
    const rows = buildMessageRows({
      items: [userPrompt("u1"), userPrompt("u2")],
      hasOlderMessages: false,
      hasNewerMessages: false,
      pendingMessages: [],
      deferredMessages: [],
      isCompacting: false,
      focusedBranchItemId: "u1",
      targetItemId: "u2",
    });
    const u1 = rows.find((r) => r.kind === "user-prompt" && r.key === "u1");
    const u2 = rows.find((r) => r.kind === "user-prompt" && r.key === "u2");
    expect(u1).toMatchObject({ shouldFocusBranch: true, isTarget: false });
    expect(u2).toMatchObject({ shouldFocusBranch: false, isTarget: true });
  });

  it("flags an assistant turn that contains the target item and derives copy text", () => {
    const rows = buildMessageRows({
      items: [text("t1", "first"), text("t2", "second")],
      hasOlderMessages: false,
      hasNewerMessages: false,
      pendingMessages: [],
      deferredMessages: [],
      isCompacting: false,
      focusedBranchItemId: null,
      targetItemId: "t2",
    });
    const turn = rows.find((r) => r.kind === "assistant-turn");
    expect(turn).toMatchObject({
      kind: "assistant-turn",
      turnHasTarget: true,
      turnCopyText: "first\n\nsecond",
      key: "turn-t1",
    });
  });

  it("keeps the turn start time and derives its most recent update time", () => {
    const rows = buildMessageRows({
      items: [
        text("t1", "first", "2024-01-01T00:00:01Z"),
        text("t2", "second", "2024-01-01T00:00:08Z"),
        text("t3", "third", "2024-01-01T00:00:05Z"),
      ],
      hasOlderMessages: false,
      hasNewerMessages: false,
      pendingMessages: [],
      deferredMessages: [],
      isCompacting: false,
      focusedBranchItemId: null,
      targetItemId: null,
    });
    const turn = rows.find((row) => row.kind === "assistant-turn");

    expect(turn).toMatchObject({
      turnTimestamp: "2024-01-01T00:00:01Z",
      turnUpdatedAt: "2024-01-01T00:00:08Z",
    });
  });

  it("marks a question prelude as progress and the following turn as resumed", () => {
    const rows = buildMessageRows({
      items: [
        toolCall("validation"),
        text("checkpoint", "Three checks passed; one needs a decision."),
        answeredQuestion("q1"),
        toolCall("probe"),
        text("final", "The probe passed."),
      ],
      hasOlderMessages: false,
      hasNewerMessages: false,
      pendingMessages: [],
      deferredMessages: [],
      isCompacting: false,
      focusedBranchItemId: null,
      targetItemId: null,
    });
    const turns = rows.filter((row) => row.kind === "assistant-turn");

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      progressTextItemIds: ["checkpoint"],
      resumedAfterQuestion: false,
    });
    expect(turns[1]).toMatchObject({
      progressTextItemIds: [],
      resumedAfterQuestion: true,
    });
  });

  it("keys deferred rows by tempId and falls back to index", () => {
    const rows = buildMessageRows({
      items: [],
      hasOlderMessages: false,
      hasNewerMessages: false,
      pendingMessages: [],
      deferredMessages: [
        { content: "no id", timestamp: "t" },
        { tempId: "d2", content: "with id", timestamp: "t" },
      ],
      isCompacting: false,
      focusedBranchItemId: null,
      targetItemId: null,
    });
    const deferred = rows.filter((r) => r.kind === "deferred");
    expect(deferred.map((r) => (r.kind === "deferred" ? r.key : ""))).toEqual([
      "deferred-0",
      "d2",
    ]);
  });
});

describe("getRowKey", () => {
  it("uses the row key for keyed rows and the kind for singleton rows", () => {
    expect(
      getRowKey({
        kind: "user-prompt",
        key: "u1",
        item: userPrompt("u1"),
        shouldFocusBranch: false,
        isTarget: false,
      }),
    ).toBe("u1");
    expect(getRowKey({ kind: "load-older" })).toBe("load-older");
    expect(getRowKey({ kind: "processing" })).toBe("processing");
  });

  it("produces unique keys across a mixed row list", () => {
    const rows = buildMessageRows({
      items: [userPrompt("u1"), text("t1", "a")],
      hasOlderMessages: true,
      hasNewerMessages: true,
      pendingMessages: [{ tempId: "p1", content: "p", timestamp: "t" }],
      deferredMessages: [{ tempId: "d1", content: "d", timestamp: "t" }],
      isCompacting: true,
      focusedBranchItemId: null,
      targetItemId: null,
    });
    const keys = rows.map(getRowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

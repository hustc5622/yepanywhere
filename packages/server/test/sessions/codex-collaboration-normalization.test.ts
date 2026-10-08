import type { CodexSessionEntry } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { preprocessMessages } from "../../../client/src/lib/preprocessMessages.js";
import { convertCodexEntries } from "../../src/sessions/normalization.js";

const childId = "019ceff0-8c79-76c0-b928-040b01768c01";
const grandchildId = "019ceff0-8c79-76c0-b928-040b01768c02";

function completedItem(
  item: Record<string, unknown>,
  second = 1,
  turnId = "turn-1",
): CodexSessionEntry {
  return {
    type: "event_msg",
    timestamp: `2026-10-04T01:00:${String(second).padStart(2, "0")}Z`,
    payload: {
      type: "item_completed",
      thread_id: childId,
      turn_id: turnId,
      item,
    },
  };
}

function activity(kind = "started", id = "activity-1") {
  // codex-rs/protocol/src/items.rs: tagged core TurnItem, snake_case fields.
  return {
    type: "SubAgentActivity",
    id,
    kind,
    agent_thread_id: grandchildId,
    agent_path: "/root/child/grandchild",
  };
}

function collabCall(overrides: Record<string, unknown> = {}) {
  return {
    type: "CollabAgentToolCall",
    id: "collab-1",
    tool: "spawn_agent",
    status: "completed",
    sender_thread_id: childId,
    receiver_thread_ids: [grandchildId],
    receiver_agents: [],
    prompt: "Review the parser",
    model: "gpt-6",
    reasoning_effort: "high",
    agents_states: { [grandchildId]: "running" },
    ...overrides,
  };
}

function convert(entries: CodexSessionEntry[]) {
  return convertCodexEntries(entries, childId, undefined, {
    provider: "codex",
    includeNativeCollaborationItems: true,
  });
}

describe("Codex child transcript collaboration normalization", () => {
  it.each(["followup_task", "send_message"])(
    "retains the %s operation on an interacted event",
    (operation) => {
      const messages = convert([
        {
          type: "response_item",
          timestamp: "2026-10-04T01:00:00Z",
          payload: {
            type: "function_call",
            call_id: "interaction-1",
            name: operation,
            namespace: "collaboration",
            arguments: '{"target":"/root/child","message":"Continue"}',
          },
        },
        completedItem(activity("interacted", "interaction-1")),
      ]);
      expect(
        messages.find((message) => message.subtype === "codex_native_item")
          ?.codexThreadItem,
      ).toMatchObject({ kind: "interacted", operation });
    },
  );

  it.each(["started", "interacted", "interrupted", "completed"])(
    "projects a persisted SubAgentActivity/%s into a typed native item",
    (kind) => {
      const [message] = convert([completedItem(activity(kind))]);

      expect(message).toMatchObject({
        type: "system",
        subtype: "codex_native_item",
        timestamp: "2026-10-04T01:00:01Z",
        codexThreadId: childId,
        codexTurnId: "turn-1",
        codexThreadItemId: "activity-1",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "subAgentActivity",
          id: "activity-1",
          kind,
          agentThreadId: grandchildId,
          agentPath: "/root/child/grandchild",
        },
      });
      expect(message?.codexThreadItem).not.toHaveProperty("agent_thread_id");
      expect(message?.codexThreadItem).not.toHaveProperty("agent_path");
    },
  );

  it("keeps native collaboration projection opt-in for legacy/root normalization", () => {
    const entries = [completedItem(activity()), completedItem(collabCall(), 2)];

    expect(convertCodexEntries(entries, childId)).toEqual([]);
    expect(
      convertCodexEntries(entries, childId, undefined, {
        provider: "codex",
        includeNativeCollaborationItems: false,
      }),
    ).toEqual([]);
    expect(convert(entries)).toHaveLength(2);
  });

  it("converts Rust collaboration fields and serde agent states to app-server shapes", () => {
    const [message] = convert([
      completedItem(
        collabCall({
          tool: "send_input",
          agents_states: {
            pending: "pending_init",
            running: "running",
            interrupted: "interrupted",
            [grandchildId]: { completed: "Parser review complete" },
            noReply: { completed: null },
            failed: { errored: "Agent exited" },
            stopped: "shutdown",
            missing: "not_found",
          },
        }),
      ),
    ]);

    expect(message?.codexThreadItem).toEqual({
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "sendInput",
      status: "completed",
      senderThreadId: childId,
      receiverThreadIds: [grandchildId],
      prompt: "Review the parser",
      model: "gpt-6",
      reasoningEffort: "high",
      agentsStates: {
        pending: { status: "pendingInit", message: null },
        running: { status: "running", message: null },
        interrupted: { status: "interrupted", message: null },
        [grandchildId]: {
          status: "completed",
          message: "Parser review complete",
        },
        noReply: { status: "completed", message: null },
        failed: { status: "errored", message: "Agent exited" },
        stopped: { status: "shutdown", message: null },
        missing: { status: "notFound", message: null },
      },
    });
  });

  it("emits valid field types when optional persisted data is absent or malformed", () => {
    const [message] = convert([
      completedItem(
        collabCall({
          status: "in_progress",
          prompt: 123,
          model: undefined,
          reasoning_effort: false,
          receiver_thread_ids: [grandchildId, 42, null],
          agents_states: { valid: "running", malformed: { completed: 42 } },
        }),
      ),
    ]);

    expect(message?.codexThreadItem).toMatchObject({
      status: "inProgress",
      receiverThreadIds: [grandchildId],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: { valid: { status: "running", message: null } },
    });
    expect(message?.codexThreadItem?.agentsStates).not.toHaveProperty(
      "malformed",
    );
    expect(
      convert([
        completedItem({ ...activity(), agent_thread_id: 12 }),
        completedItem({ ...activity(), kind: "unknown" }),
        completedItem(collabCall({ sender_thread_id: false })),
        completedItem(collabCall({ tool: "unknown_tool" })),
      ]),
    ).toEqual([]);
  });

  it("retains text/tool order and identity while deduplicating repeated native items", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-10-04T01:00:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Starting review" }],
        },
      },
      completedItem(activity()),
      {
        type: "response_item",
        timestamp: "2026-10-04T01:00:02Z",
        payload: {
          type: "function_call",
          call_id: "shell-1",
          name: "exec_command",
          arguments: '{"cmd":"pwd"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2026-10-04T01:00:03Z",
        payload: {
          type: "function_call_output",
          call_id: "shell-1",
          output: "/workspace\n",
        },
      },
      completedItem(activity(), 4),
      completedItem(collabCall(), 5),
      completedItem(
        collabCall({
          agents_states: { [grandchildId]: { completed: "Done" } },
        }),
        6,
      ),
    ];
    const messages = convert(entries);
    const nativeItems = messages.filter(
      (message) => message.subtype === "codex_native_item",
    );

    expect(messages.map((message) => message.type)).toEqual([
      "assistant",
      "system",
      "assistant",
      "user",
      "system",
    ]);
    expect(nativeItems).toHaveLength(2);
    expect(nativeItems[1]?.codexThreadItem?.agentsStates).toEqual({
      [grandchildId]: { status: "completed", message: "Done" },
    });
    expect(
      messages.filter((message) => message.subtype !== "codex_native_item"),
    ).toEqual(convertCodexEntries(entries, childId));
    expect(new Set(messages.map((message) => message.uuid)).size).toBe(
      messages.length,
    );
    expect(convert(entries.slice(1, 2))[0]?.uuid).toBe(nativeItems[0]?.uuid);

    const renderItems = preprocessMessages(messages);
    expect(renderItems.map((item) => item.type)).toEqual([
      "text",
      "codex_native_item",
      "tool_call",
      "codex_native_item",
    ]);
    expect(renderItems[1]).toMatchObject({
      type: "codex_native_item",
      threadItem: { type: "subAgentActivity", agentThreadId: grandchildId },
    });
  });
});

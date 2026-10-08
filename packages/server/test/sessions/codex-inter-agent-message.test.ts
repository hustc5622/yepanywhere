import {
  type CodexSessionEntry,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { summarizeCodexNormalizedMessage } from "../../src/codex/correlationDebugLogger.js";
import {
  mergeCodexInterAgentMessages,
  normalizeCodexInterAgentMessage,
} from "../../src/codex/inter-agent-message.js";
import { convertCodexEntries } from "../../src/sessions/normalization.js";
import type { Message } from "../../src/supervisor/types.js";

function communication(
  type: "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER",
  body: string,
  overrides: Record<string, unknown> = {},
): CodexSessionEntry {
  return parseCodexSessionEntry(
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-10-08T01:57:24.000Z",
      payload: {
        type: "agent_message",
        id: "amsg-1",
        author: "/root",
        recipient: "/root/review",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-2" },
        content: [
          {
            type: "input_text",
            text: `Message Type: ${type}\nTask name: /root/review\nSender: /root\nPayload:\n${body}`,
          },
        ],
        ...overrides,
      },
    }),
  ) as CodexSessionEntry;
}

describe("Codex cross-agent mailbox projection", () => {
  it("enriches canonical interactions without adding duplicate activities", () => {
    const activity: Message = {
      uuid: "native",
      type: "system",
      subtype: "codex_native_item",
      codexTurnId: "turn-1",
      codexThreadItemId: "followup-1",
      codexThreadItem: {
        type: "subAgentActivity",
        id: "followup-1",
        kind: "interacted",
      },
    };
    const supplementary: Message = {
      ...activity,
      uuid: "rollout",
      codexThreadItem: {
        type: "subAgentActivity",
        id: "followup-1",
        operation: "followup_task",
      },
    };
    expect(
      mergeCodexInterAgentMessages(
        [activity],
        [{ message: supplementary, updateOnly: true }],
      ),
    ).toEqual([
      {
        ...activity,
        codexThreadItem: {
          type: "subAgentActivity",
          id: "followup-1",
          kind: "interacted",
          operation: "followup_task",
        },
      },
    ]);
    expect(activity.codexThreadItem).not.toHaveProperty("operation");
  });

  it.each([
    ["NEW_TASK", "task"],
    ["MESSAGE", "message"],
    ["FINAL_ANSWER", "result"],
  ] as const)(
    "projects %s with routing, content and provider identity",
    (type, kind) => {
      const [message] = convertCodexEntries(
        [communication(type, "Review only the parser.")],
        "child-thread",
      );
      expect(message).toMatchObject({
        type: "system",
        subtype: "codex_native_item",
        codexThreadId: "child-thread",
        codexTurnId: "turn-2",
        codexThreadItemId: "amsg-1",
        codexCorrelationKey: "codex:turn-2:inter-agent-message:amsg-1",
        codexThreadItem: {
          type: "interAgentMessage",
          id: "amsg-1",
          kind,
          sender: "/root",
          recipient: "/root/review",
          text: "Review only the parser.",
          encrypted: false,
        },
      });
    },
  );

  it("projects encrypted task headers without retaining the ciphertext anywhere", () => {
    const entry = communication("NEW_TASK", "");
    if (
      entry.type !== "response_item" ||
      entry.payload.type !== "agent_message"
    )
      throw new Error("fixture");
    entry.payload.content.push({
      type: "encrypted_content",
      encrypted_content: "sensitive-ciphertext",
    });
    const [message] = convertCodexEntries([entry], "child-thread");
    if (!message) throw new Error("Missing communication");
    expect(message?.codexThreadItem).toEqual({
      type: "interAgentMessage",
      id: "amsg-1",
      kind: "task",
      sender: "/root",
      recipient: "/root/review",
      encrypted: true,
    });
    expect(JSON.stringify(message)).not.toContain("sensitive-ciphertext");
    expect(
      JSON.stringify(summarizeCodexNormalizedMessage(message)),
    ).not.toContain("sensitive-ciphertext");
  });

  it("reads the documented assistant JSON wrapper and uses the inner identity", () => {
    const entry = communication("MESSAGE", "");
    if (entry.type !== "response_item") throw new Error("fixture");
    entry.payload = {
      type: "message",
      id: "outer",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            id: "amsg-legacy",
            author: "/root",
            recipient: "/root/review",
            content: "",
            encrypted_content: "legacy-ciphertext",
            trigger_turn: true,
            internal_chat_message_metadata_passthrough: {
              turn_id: "legacy-turn",
            },
          }),
        },
      ],
    };
    const [message] = convertCodexEntries([entry], "child-thread");
    expect(message).toMatchObject({
      codexTurnId: "legacy-turn",
      codexCorrelationKey: "codex:legacy-turn:inter-agent-message:amsg-legacy",
      codexThreadItem: { id: "amsg-legacy", kind: "task", encrypted: true },
    });
    expect(JSON.stringify(message)).not.toContain("legacy-ciphertext");
  });

  it("preserves malformed and unknown plaintext instead of guessing a task header", () => {
    const content =
      "Message Type: NEW_TASK\nTask name: /root/another\nSender: /root\nPayload:\nDo not lose me.";
    const entry = communication("MESSAGE", "", {
      content: [{ type: "input_text", text: content }],
    });
    const [message] = convertCodexEntries([entry], "child-thread");
    expect(message?.codexThreadItem).toMatchObject({
      kind: "message",
      text: content,
    });
    expect(
      normalizeCodexInterAgentMessage(
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: '{"content":"ordinary JSON"}' },
          ],
        },
        "fallback",
      ),
    ).toBeNull();
  });

  it("deduplicates provider message ids without collapsing identical separate sends", () => {
    const entry = communication("MESSAGE", "Continue");
    const repeated = communication("MESSAGE", "Continue", { id: "amsg-2" });
    const messages = convertCodexEntries(
      [entry, structuredClone(entry), repeated],
      "child-thread",
    );
    expect(messages.map((message) => message.codexThreadItemId)).toEqual([
      "amsg-1",
      "amsg-2",
    ]);
  });

  it("keeps result turn identity rather than assigning the latest running turn", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2026-10-08T02:00:00Z",
        payload: { type: "task_started", turn_id: "new-turn" },
      },
      communication("FINAL_ANSWER", "Previous task is done."),
    ];
    const [message] = convertCodexEntries(entries, "child-thread");
    expect(message?.codexTurnId).toBe("turn-2");
  });
});

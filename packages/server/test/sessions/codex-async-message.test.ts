import {
  type CodexSessionEntry,
  SessionDisplayPageSchema,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { preprocessMessages } from "../../../client/src/lib/preprocessMessages.js";
import { buildSessionDisplayRenderItems } from "../../../client/src/lib/sessionDisplay.js";
import { buildSessionDisplayProjection } from "../../src/sessions/display-projection.js";
import { convertCodexEntries } from "../../src/sessions/normalization.js";

const timestamp = "2026-09-08T07:21:28.392Z";
const questions = [
  { title: "Which address?", options: ["Production", "Local"] },
];
const asyncItem: CodexSessionEntry = {
  type: "event_msg",
  timestamp,
  payload: {
    type: "item_completed",
    turn_id: "turn",
    item: {
      type: "AgentMessage",
      id: "question",
      phase: "final_answer",
      delivery: "async",
      questions,
      content: [
        { type: "Text", text: "Which address?\n- Production\n- Local" },
      ],
    },
  },
};

describe("Codex async question rollout projection", () => {
  it("restores the native question once and preserves it through display and legacy rendering", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Investigate" }],
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call",
          name: "request_user_input_async",
          call_id: "question",
          arguments: JSON.stringify({ questions }),
        },
      },
      asyncItem,
      asyncItem,
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call_output",
          call_id: "question",
          output: '{"accepted":true}',
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "after-question",
          arguments: '{"cmd":"pwd"}',
        },
      },
    ];
    const messages = convertCodexEntries(entries, "session");
    const questionMessages = messages.filter(
      (message) => message.codexAsyncMessage,
    );
    expect(questionMessages).toHaveLength(1);
    expect(questionMessages[0]).toMatchObject({
      codexTurnId: "turn",
      codexCorrelationKey: "codex:turn:agent-message:question",
      codexAsyncMessage: { delivery: "async", questions },
    });
    const projection = buildSessionDisplayProjection({
      sessionId: "session",
      revision: "revision",
      messages,
      provider: "codex",
      questionCoverage: "complete",
    });
    expect(SessionDisplayPageSchema.safeParse(projection.page).success).toBe(
      true,
    );
    const segments = projection.page.turns.flatMap((turn) => turn.segments);
    expect(segments.map((segment) => segment.type)).toEqual([
      "assistant_text",
      "tool_group",
    ]);
    expect(
      buildSessionDisplayRenderItems(projection.page, {
        projectId: "project",
        formatNotice: () => "notice",
      }).find((item) => item.type === "text"),
    ).toMatchObject({ asyncMessage: { delivery: "async", questions } });
    expect(segments[0]).toMatchObject({
      phase: "text",
      asyncMessage: { delivery: "async", questions },
    });
    expect(
      preprocessMessages(messages).find((item) => item.type === "text"),
    ).toMatchObject({ asyncMessage: { delivery: "async", questions } });
  });

  it("can restore an async item when its function call lies outside the history page", () => {
    expect(convertCodexEntries([asyncItem], "session")).toEqual([
      expect.objectContaining({
        codexAsyncMessage: { delivery: "async", questions },
      }),
    ]);
  });
});

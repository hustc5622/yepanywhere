import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  planActiveMessageWindowTrim,
  truncateMessagesForEdit,
} from "../useSessionMessages";

function message(id: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    type: "user",
    message: { role: "user", content: id },
    ...extra,
  };
}

describe("truncateMessagesForEdit", () => {
  it("preserves the streamed optimistic edit that arrived before resume returned", () => {
    const optimisticEdit = message("edited-stream", { tempId: "temp-edit" });
    const messages = [
      message("before"),
      message("edited-original"),
      message("old-response", { type: "assistant" }),
      optimisticEdit,
    ];

    expect(
      truncateMessagesForEdit(messages, "edited-original", "temp-edit"),
    ).toEqual([messages[0], optimisticEdit]);
  });

  it("keeps the previous truncation behavior without a matching temp id", () => {
    const messages = [
      message("before"),
      message("edited-original"),
      message("old-response", { type: "assistant" }),
    ];

    expect(truncateMessagesForEdit(messages, "edited-original")).toEqual([
      messages[0],
    ]);
  });
});

describe("planActiveMessageWindowTrim", () => {
  it("retains complete recent turns and ignores tool-result user messages", () => {
    const messages: Message[] = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push(
        message(`user-${index}`, {
          timestamp: "2020-01-01T00:00:00.000Z",
        }),
        message(`assistant-${index}`, {
          type: "assistant",
          timestamp: "2020-01-01T00:00:01.000Z",
          message: { role: "assistant", content: `response ${index}` },
        }),
        message(`tool-result-${index}`, {
          timestamp: "2020-01-01T00:00:02.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `tool-${index}`,
                content: "done",
              },
            ],
          },
        }),
      );
    }

    const plan = planActiveMessageWindowTrim(
      messages,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );

    expect(plan?.firstRetainedMessageId).toBe("user-26");
    expect(plan?.messages[0]?.id).toBe("user-26");
    expect(plan?.messages).toHaveLength(102);
  });

  it("still bounds a single tool-heavy turn without a nearby user boundary", () => {
    const messages = [
      message("user-0", { timestamp: "2020-01-01T00:00:00.000Z" }),
      ...Array.from({ length: 150 }, (_, index) =>
        message(`assistant-${index}`, {
          type: "assistant",
          timestamp: "2020-01-01T00:00:01.000Z",
          message: { role: "assistant", content: `response ${index}` },
        }),
      ),
    ];

    const plan = planActiveMessageWindowTrim(
      messages,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );

    expect(plan?.firstRetainedMessageId).toBe("assistant-50");
    expect(plan?.messages).toHaveLength(100);
  });

  it("waits for the retained boundary to be old enough to be persisted", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const messages = Array.from({ length: 151 }, (_, index) =>
      message(`user-${index}`, {
        timestamp: new Date(nowMs - 10_000).toISOString(),
      }),
    );

    expect(planActiveMessageWindowTrim(messages, nowMs)).toBeNull();
  });
});

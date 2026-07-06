import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  type PendingMessage,
  reconcilePendingMessagesWithConfirmedMessages,
} from "../useSession";

function pending(overrides?: Partial<PendingMessage>): PendingMessage {
  return {
    tempId: "temp-1",
    content: "please do the thing",
    timestamp: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

function userMessage(overrides?: Partial<Message>): Message {
  return {
    type: "user",
    uuid: "msg-1",
    timestamp: "2026-07-06T12:00:01.000Z",
    message: {
      role: "user",
      content: "please do the thing",
    },
    ...overrides,
  };
}

describe("reconcilePendingMessagesWithConfirmedMessages", () => {
  it("removes a pending message when a confirmed REST user message matches the content", () => {
    const result = reconcilePendingMessagesWithConfirmedMessages(
      [pending()],
      [userMessage({ _source: "jsonl" })],
    );

    expect(result).toEqual([]);
  });

  it("removes a pending message when a streamed user message echoes the temp id", () => {
    const result = reconcilePendingMessagesWithConfirmedMessages(
      [pending()],
      [
        userMessage({
          tempId: "temp-1",
          message: { role: "user", content: "different formatting" },
        } as Partial<Message>),
      ],
    );

    expect(result).toEqual([]);
  });

  it("keeps pending messages when only an older same-content history message exists", () => {
    const item = pending();
    const result = reconcilePendingMessagesWithConfirmedMessages(
      [item],
      [
        userMessage({
          timestamp: "2026-07-06T11:59:00.000Z",
        }),
      ],
    );

    expect(result).toEqual([item]);
  });

  it("matches server-expanded attachment text", () => {
    const result = reconcilePendingMessagesWithConfirmedMessages(
      [pending()],
      [
        userMessage({
          message: {
            role: "user",
            content:
              "please do the thing\n\nUser uploaded files:\n- image.png (1.0 KB, image/png): /tmp/image.png",
          },
        }),
      ],
    );

    expect(result).toEqual([]);
  });
});

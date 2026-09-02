import { describe, expect, it } from "vitest";
import {
  SESSION_DISPLAY_INITIAL_TURN_LIMIT,
  SESSION_DISPLAY_TOOL_DETAIL_PAGE_LIMIT,
  SessionDisplayPageSchema,
  SessionQuestionPageSchema,
} from "../src/session-display.js";

describe("session display contract", () => {
  it("accepts the confirmed lightweight defaults and contract", () => {
    expect(SESSION_DISPLAY_INITIAL_TURN_LIMIT).toBe(40);
    expect(SESSION_DISPLAY_TOOL_DETAIL_PAGE_LIMIT).toBe(50);

    const page = SessionDisplayPageSchema.parse({
      sessionId: "session-1",
      revision: "revision-1",
      turns: [
        {
          id: "turn-1",
          question: {
            messageId: "message-1",
            content: [
              { type: "text", text: "Please inspect this image" },
              {
                type: "media",
                kind: "image",
                mimeType: "image/png",
                deferred: true,
              },
            ],
          },
          segments: [
            {
              type: "assistant_text",
              id: "text-1",
              phase: "progress",
              content: "I will inspect it.",
              renderedHtml: "<p>I will inspect it.</p>",
            },
            {
              type: "tool_group",
              id: "group-1",
              status: "mixed",
              count: 3,
              failedCount: 1,
              changedFileCount: 1,
              checkCount: 1,
              toolNames: ["Edit", "Bash"],
              detailRef: "opaque-detail-ref",
              liveTail: true,
            },
          ],
        },
      ],
    });

    expect(page.turns[0]?.segments[1]).toMatchObject({
      type: "tool_group",
      count: 3,
      failedCount: 1,
      liveTail: true,
    });
    expect(page.turns[0]?.segments[0]).toMatchObject({
      type: "assistant_text",
      renderedHtml: "<p>I will inspect it.</p>",
    });
  });

  it("fails closed when tool bodies or arbitrary provider fields leak in", () => {
    const leakingPage = {
      sessionId: "session-1",
      revision: "revision-1",
      turns: [
        {
          id: "turn-1",
          question: {
            messageId: "message-1",
            content: "Run the checks",
          },
          segments: [
            {
              type: "tool_group",
              id: "group-1",
              status: "completed",
              count: 1,
              failedCount: 0,
              toolNames: ["Bash"],
              detailRef: "opaque-detail-ref",
              toolInput: { command: "secret command" },
              toolResult: "secret output",
            },
          ],
        },
      ],
    };

    expect(() => SessionDisplayPageSchema.parse(leakingPage)).toThrow();
  });

  it("requires question coverage to be explicit", () => {
    expect(
      SessionQuestionPageSchema.parse({
        coverage: "partial",
        questions: [
          {
            messageId: "message-1",
            turnId: "turn-1",
            clientUserMessageId: "client-message-1",
            codexCorrelationKey: "codex:user-message:client-message-1",
            preview: "Run the checks",
          },
        ],
      }).coverage,
    ).toBe("partial");

    expect(() => SessionQuestionPageSchema.parse({ questions: [] })).toThrow();
  });
});

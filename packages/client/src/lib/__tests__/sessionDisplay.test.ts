import type { SessionDisplayPage } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  buildSessionDisplayRenderItems,
  mergeSessionInspectorMessages,
  resolveSessionInspectorNavigation,
} from "../sessionDisplay";

describe("buildSessionDisplayRenderItems", () => {
  it("maps lightweight turns without reconstructing hidden tool messages", () => {
    const page: SessionDisplayPage = {
      sessionId: "session-1",
      revision: "revision-1",
      turns: [
        {
          id: "turn:native-1",
          question: {
            messageId: "user-1",
            parentMessageId: "parent-1",
            content: [
              { type: "text", text: "Inspect this" },
              { type: "media", kind: "image", deferred: true },
            ],
          },
          segments: [
            {
              type: "assistant_text",
              id: "text-1",
              codexCorrelationKey: "codex:native-1:agent-message:text-1",
              phase: "progress",
              content: "Checking.",
            },
            {
              type: "tool_group",
              id: "group-1",
              status: "completed",
              count: 2,
              failedCount: 0,
              toolNames: ["Read", "Bash"],
              detailRef: "detail-1",
            },
            {
              type: "assistant_text",
              id: "text-2",
              phase: "final",
              content: "Done.",
            },
          ],
        },
      ],
    };

    const items = buildSessionDisplayRenderItems(page, {
      projectId: "project-1",
      formatNotice: () => "notice",
    });

    expect(items.map((item) => item.type)).toEqual([
      "user_prompt",
      "text",
      "display_tool_group",
      "text",
    ]);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      sourceMessages: [
        {
          uuid: "user-1",
          parentUuid: "parent-1",
          codexTurnId: "native-1",
          _source: "jsonl",
        },
      ],
    });
    expect(items[1]).toMatchObject({
      type: "text",
      sourceMessages: [
        {
          codexCorrelationKey: "codex:native-1:agent-message:text-1",
        },
      ],
    });
    expect(JSON.stringify(items)).not.toContain("tool_result");
    expect(items[2]).toMatchObject({
      type: "display_tool_group",
      projectId: "project-1",
      sessionId: "session-1",
      revision: "revision-1",
      group: { count: 2, detailRef: "detail-1" },
    });

    const withoutHydratedTail = buildSessionDisplayRenderItems(page, {
      projectId: "project-1",
      omitToolGroupDetailRef: "detail-1",
      formatNotice: () => "notice",
    });
    expect(withoutHydratedTail.map((item) => item.type)).toEqual([
      "user_prompt",
      "text",
      "text",
    ]);
  });
});

describe("mergeSessionInspectorMessages", () => {
  it("keeps the safe index, appends live rows, and removes exact replays", () => {
    const indexed = [{ uuid: "persisted-tool", type: "assistant" as const }];
    const live = [
      { uuid: "persisted-tool", type: "assistant" as const },
      { uuid: "live-tool", type: "assistant" as const },
    ];

    expect(mergeSessionInspectorMessages(indexed, live)).toEqual([
      indexed[0],
      live[1],
    ]);
  });

  it("reconnects a page-leading tool row to the preceding question boundary", () => {
    expect(
      resolveSessionInspectorNavigation([
        {
          uuid: "question-1",
          type: "system",
          inspectorQuestionBoundary: true,
          inspectorNavigationMessageId: "question-1",
        },
        {
          uuid: "tool-on-next-page",
          type: "assistant",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        uuid: "tool-on-next-page",
        inspectorNavigationMessageId: "question-1",
      }),
    ]);
  });
});

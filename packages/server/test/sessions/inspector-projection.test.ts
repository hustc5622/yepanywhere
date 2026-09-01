import { describe, expect, it } from "vitest";
import { preprocessMessages } from "../../../client/src/lib/preprocessMessages.ts";
import type { Message as ClientMessage } from "../../../client/src/types.ts";
import { projectSessionInspectorMessages } from "../../src/sessions/inspector-projection.js";
import type { Message } from "../../src/supervisor/types.js";

describe("session inspector projection", () => {
  it("keeps index metadata without returning hidden tool or assistant bodies", () => {
    const messages: Message[] = [
      {
        uuid: "question-1",
        type: "user",
        message: { role: "user", content: "Inspect the project" },
      },
      {
        uuid: "assistant-1",
        type: "assistant",
        codexMessagePhase: "commentary",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ASSISTANT_BODY_MUST_NOT_LEAK" },
            {
              type: "tool_use",
              id: "edit-1",
              name: "Edit",
              input: {
                file_path: "src/example.ts",
                old_string: "OLD_PATCH_SECRET",
                new_string: "NEW_PATCH_SECRET",
              },
            },
            {
              type: "tool_use",
              id: "check-1",
              name: "Bash",
              input: {
                command: "pnpm test",
                description: "COMMAND_DESCRIPTION_SECRET",
              },
            },
          ],
        },
      },
      {
        uuid: "results-1",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "edit-1",
              content: "EDIT_RESULT_SECRET",
            },
            {
              type: "tool_result",
              tool_use_id: "check-1",
              content: "CHECK_RESULT_SECRET",
              is_error: true,
            },
          ],
        },
      },
      {
        uuid: "goal-1",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItem: {
          type: "threadGoal",
          objective: "Ship the feature",
          status: "active",
          tokensUsed: 42,
          privatePayload: "GOAL_SECRET",
        },
      },
    ];

    const projected = projectSessionInspectorMessages(messages);
    const json = JSON.stringify(projected);
    const items = preprocessMessages(projected as ClientMessage[]);

    expect(json).toContain("src/example.ts");
    expect(json).toContain("pnpm test");
    expect(json).toContain("Ship the feature");
    expect(json).not.toContain("ASSISTANT_BODY_MUST_NOT_LEAK");
    expect(json).not.toContain("OLD_PATCH_SECRET");
    expect(json).not.toContain("NEW_PATCH_SECRET");
    expect(json).not.toContain("EDIT_RESULT_SECRET");
    expect(json).not.toContain("CHECK_RESULT_SECRET");
    expect(json).not.toContain("COMMAND_DESCRIPTION_SECRET");
    expect(json).not.toContain("GOAL_SECRET");
    expect(
      items.find((item) => item.type === "tool_call" && item.id === "check-1"),
    ).toMatchObject({ status: "error" });
    expect(
      projected.filter(
        (message) =>
          message.inspectorNavigationMessageId === "question-1" &&
          !message.inspectorQuestionBoundary,
      ),
    ).toHaveLength(2);
    expect(
      items.find(
        (item) =>
          item.type === "codex_native_item" &&
          item.threadItem.type === "threadGoal",
      ),
    ).toBeDefined();
  });
});

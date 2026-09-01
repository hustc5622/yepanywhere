import { describe, expect, it } from "vitest";
import type {
  RenderItem,
  TextItem,
  ToolCallItem,
  UserPromptItem,
} from "../../types/renderItems";
import { groupToolsBeforeAssistantOutput } from "../liveToolGrouping";

function user(id: string): UserPromptItem {
  return { type: "user_prompt", id, content: id, sourceMessages: [] };
}

function text(id: string, value = id): TextItem {
  return { type: "text", id, text: value, sourceMessages: [] };
}

function tool(id: string, toolName = "Bash"): ToolCallItem {
  return {
    type: "tool_call",
    id,
    toolName,
    toolInput: { command: id },
    status: "complete",
    sourceMessages: [],
  };
}

describe("groupToolsBeforeAssistantOutput", () => {
  it("groups tools closed by progress and leaves the unfinished tail detailed", () => {
    const result = groupToolsBeforeAssistantOutput([
      user("user-1"),
      text("progress-1"),
      tool("tool-1"),
      tool("tool-2", "Edit"),
      text("progress-2"),
      tool("tool-3"),
    ]);

    expect(result.map((item) => item.type)).toEqual([
      "user_prompt",
      "text",
      "assistant_output_tool_group",
      "text",
      "tool_call",
    ]);
    const group = result[2];
    expect(
      group?.type === "assistant_output_tool_group"
        ? group.tools.map((item) => item.id)
        : [],
    ).toEqual(["tool-1", "tool-2"]);
  });

  it("uses final output to close the last tool batch", () => {
    const result = groupToolsBeforeAssistantOutput([
      user("user-1"),
      tool("tool-1"),
      text("final", "Done"),
    ]);

    expect(result.map((item) => item.type)).toEqual([
      "user_prompt",
      "assistant_output_tool_group",
      "text",
    ]);
  });

  it("does not treat thinking or system rows as user-readable output", () => {
    const items: RenderItem[] = [
      user("user-1"),
      tool("tool-1"),
      {
        type: "thinking",
        id: "thinking-1",
        thinking: "internal",
        status: "complete",
        sourceMessages: [],
      },
      tool("tool-2"),
      {
        type: "system",
        id: "system-1",
        subtype: "status",
        content: "internal status",
        sourceMessages: [],
      },
    ];

    expect(groupToolsBeforeAssistantOutput(items)).toEqual(items);
  });

  it("does not close tools across the next user question", () => {
    const items: RenderItem[] = [
      user("user-1"),
      tool("tool-1"),
      user("user-2"),
      text("progress-2"),
    ];

    expect(groupToolsBeforeAssistantOutput(items)).toEqual(items);
  });

  it("keeps interactive question tools explicit", () => {
    const result = groupToolsBeforeAssistantOutput([
      user("user-1"),
      tool("question-1", "AskUserQuestion"),
      text("progress-1"),
    ]);

    expect(result[1]?.type).toBe("tool_call");
  });

  it("keeps plan progress tools explicit", () => {
    const result = groupToolsBeforeAssistantOutput([
      user("user-1"),
      tool("plan-1", "UpdatePlan"),
      text("progress-1"),
    ]);

    expect(result[1]?.type).toBe("tool_call");
  });
});

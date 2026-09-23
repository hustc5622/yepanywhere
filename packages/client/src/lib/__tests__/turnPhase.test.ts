import { describe, expect, it } from "vitest";
import type { RenderItem, ToolCallItem } from "../../types/renderItems";
import { getTurnPhase } from "../turnPhase";

function tool(status: ToolCallItem["status"] = "pending"): ToolCallItem {
  return {
    type: "tool_call",
    id: "tool",
    toolName: "Bash",
    toolInput: {},
    status,
    sourceMessages: [],
  };
}

function group(runningCount?: number): RenderItem {
  return {
    type: "display_tool_group",
    id: "group",
    projectId: "project",
    sessionId: "session",
    revision: "revision",
    sourceMessages: [],
    group: {
      type: "tool_group",
      id: "group",
      status: "running",
      runningCount,
      count: 2,
      failedCount: 0,
      toolNames: ["Bash"],
      detailRef: "detail",
    },
  };
}

describe("getTurnPhase", () => {
  it("waits for all parallel calls, then returns to the model", () => {
    expect(getTurnPhase([])).toBe("llm");
    expect(getTurnPhase([tool(), tool("complete")])).toBe("tools");
    expect(
      getTurnPhase([tool("complete"), tool("error"), tool("aborted")]),
    ).toBe("llm");
  });

  it("does not treat returned results or background agents as foreground execution", () => {
    expect(
      getTurnPhase([
        { ...tool(), toolResult: { content: "done", isError: false } },
        { ...tool(), isSubagent: true },
      ]),
    ).toBe("llm");
  });

  it.each(["text", "thinking"] as const)(
    "fresh %s closes stale pending calls",
    (type) => {
      const output: RenderItem =
        type === "text"
          ? { type, id: "output", text: "Continuing", sourceMessages: [] }
          : {
              type,
              id: "output",
              thinking: "Next",
              status: "streaming",
              sourceMessages: [],
            };
      expect(getTurnPhase([tool(), output])).toBe("llm");
      expect(getTurnPhase([tool(), output, tool()])).toBe("tools");
    },
  );

  it("uses collapsed group counts without loading details, including legacy groups", () => {
    expect(getTurnPhase([group(1)])).toBe("tools");
    expect(getTurnPhase([group()])).toBe("tools");
    expect(getTurnPhase([group(0)])).toBe("llm");
  });

  it("does not label pending human input as model or tool execution", () => {
    expect(
      getTurnPhase([{ ...tool(), toolName: "AskUserQuestion" }]),
    ).toBeUndefined();
    const action = group();
    if (action.type !== "display_tool_group") throw new Error("Expected group");
    action.group = {
      type: "action_required",
      id: "approval",
      action: "approval",
      status: "running",
    };
    expect(getTurnPhase([action])).toBeUndefined();
  });

  it("tracks foreground Codex collaboration calls, not the spawned agent lifetime", () => {
    const call: RenderItem = {
      type: "codex_native_item",
      id: "collab",
      lifecycle: "started",
      threadItem: { type: "collabAgentToolCall", status: "inProgress" },
      sourceMessages: [],
    };
    expect(getTurnPhase([call])).toBe("tools");
    expect(getTurnPhase([{ ...call, lifecycle: "completed" }])).toBe("llm");
  });
});

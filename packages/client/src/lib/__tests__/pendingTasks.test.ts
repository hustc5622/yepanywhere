import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { findPendingTasks } from "../pendingTasks";

describe("findPendingTasks", () => {
  it("finds Task tool_use without matching tool_result", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description: "Research trees", subagent_type: "Explore" },
          },
          {
            type: "tool_use",
            id: "task-2",
            name: "Task",
            input: {
              description: "Research forests",
              subagent_type: "Explore",
            },
          },
        ],
      },
      {
        id: "msg-2",
        type: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-1",
            content: "Task completed",
          },
        ],
      },
    ];

    const pending = findPendingTasks(messages);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolUseId).toBe("task-2");
    expect(pending[0]?.description).toBe("Research forests");
    expect(pending[0]?.subagentType).toBe("Explore");
  });

  it("returns empty array when all Tasks complete", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description: "Research trees", subagent_type: "Explore" },
          },
        ],
      },
      {
        id: "msg-2",
        type: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-1",
            content: "Task completed",
          },
        ],
      },
    ];

    const pending = findPendingTasks(messages);

    expect(pending).toHaveLength(0);
  });

  it("finds multiple pending Tasks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description: "Research trees", subagent_type: "Explore" },
          },
          {
            type: "tool_use",
            id: "task-2",
            name: "Task",
            input: {
              description: "Research forests",
              subagent_type: "general-purpose",
            },
          },
          {
            type: "tool_use",
            id: "task-3",
            name: "Task",
            input: { description: "Research plants", subagent_type: "Plan" },
          },
        ],
      },
    ];

    const pending = findPendingTasks(messages);

    expect(pending).toHaveLength(3);
    expect(pending.map((t) => t.toolUseId)).toEqual([
      "task-1",
      "task-2",
      "task-3",
    ]);
  });

  it("ignores non-Task tool_use blocks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: [
          { type: "tool_use", id: "read-1", name: "Read", input: {} },
          { type: "tool_use", id: "bash-1", name: "Bash", input: {} },
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description: "My task", subagent_type: "Explore" },
          },
        ],
      },
    ];

    const pending = findPendingTasks(messages);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolUseId).toBe("task-1");
  });

  it("handles messages with nested message.content structure", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "task-1",
              name: "Task",
              input: { description: "Nested task", subagent_type: "Explore" },
            },
          ],
        },
      },
    ];

    const pending = findPendingTasks(messages);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.description).toBe("Nested task");
  });

  it("returns empty array for empty messages", () => {
    const pending = findPendingTasks([]);
    expect(pending).toHaveLength(0);
  });

  it("handles missing input fields gracefully", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: [
          { type: "tool_use", id: "task-1", name: "Task", input: {} },
          { type: "tool_use", id: "task-2", name: "Task" }, // no input at all
        ],
      },
    ];

    const pending = findPendingTasks(messages);

    expect(pending).toHaveLength(2);
    expect(pending[0]?.description).toBe("Unknown task");
    expect(pending[0]?.subagentType).toBe("unknown");
    expect(pending[1]?.description).toBe("Unknown task");
    expect(pending[1]?.subagentType).toBe("unknown");
  });

  it("handles messages with string content (no tool_use)", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "user",
        content: "Hello, can you help me?",
      },
      {
        id: "msg-2",
        type: "assistant",
        content: "Sure, I can help!",
      },
    ];

    const pending = findPendingTasks(messages);

    expect(pending).toHaveLength(0);
  });

  it("detects pending kimi Agent and AgentSwarm tool calls", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "Agent_0",
            name: "Agent",
            input: {
              description: "explore frontend",
              subagent_type: "explore",
            },
          },
          {
            type: "tool_use",
            id: "Swarm_0",
            name: "AgentSwarm",
            input: { description: "explore all", subagent_type: "explore" },
          },
        ],
      },
    ];

    const pending = findPendingTasks(messages);

    expect(pending.map((t) => t.toolUseId)).toEqual(["Agent_0", "Swarm_0"]);
    expect(pending[0]?.subagentType).toBe("explore");
  });
});

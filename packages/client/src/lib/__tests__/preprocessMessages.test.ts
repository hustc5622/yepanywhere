import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { preprocessMessages } from "../preprocessMessages";

function codexWaitPair(
  id: string,
  timestamp: number,
  output: string,
  input: Record<string, unknown> = {
    cell_id: "1",
    yield_time_ms: 10000,
  },
): Message[] {
  return [
    {
      id: `${id}-use`,
      role: "assistant",
      content: [{ type: "tool_use", id, name: "wait", input }],
      timestamp: `2024-01-01T00:00:${String(timestamp).padStart(2, "0")}Z`,
    },
    {
      id: `${id}-result`,
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: output }],
      timestamp: `2024-01-01T00:00:${String(timestamp + 1).padStart(2, "0")}Z`,
    },
  ];
}

describe("preprocessMessages", () => {
  it("pairs tool_use with tool_result", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "test.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "file contents",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "tool-1",
      toolName: "Read",
      status: "complete",
      toolResult: { content: "file contents", isError: false },
    });
  });

  it("collapses adjacent silent Codex wait polls but preserves progress text", () => {
    const running =
      "Script running with cell ID 1\nWall time 10.0 seconds\nOutput:\n";
    const terminated = "Script terminated\nWall time 0.0 seconds\nOutput:\n";
    const messages: Message[] = [
      ...codexWaitPair("wait-1", 1, running),
      ...codexWaitPair("wait-2", 3, running),
      ...codexWaitPair("wait-3", 5, running),
      {
        id: "progress",
        type: "assistant",
        content: "I am checking the official integration status.",
        codexMessagePhase: "commentary",
        timestamp: "2024-01-01T00:00:07Z",
      },
      ...codexWaitPair("wait-4", 8, running),
      ...codexWaitPair("wait-5", 10, terminated, {
        cell_id: "1",
        yield_time_ms: 1000,
        terminate: true,
      }),
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "wait-1",
      toolName: "wait",
      toolInput: {
        cell_id: "1",
        poll_count: 3,
        total_wall_time_seconds: 30,
      },
    });
    expect(items[1]).toMatchObject({
      type: "text",
      phase: "commentary",
      text: "I am checking the official integration status.",
    });
    expect(items[2]).toMatchObject({
      type: "tool_call",
      id: "wait-4",
      toolInput: {
        cell_id: "1",
        terminate: true,
        poll_count: 2,
        total_wall_time_seconds: 10,
      },
    });
  });

  it("does not collapse wait calls that returned useful output", () => {
    const messages: Message[] = [
      ...codexWaitPair(
        "wait-output",
        1,
        "Script running with cell ID 1\nWall time 10.0 seconds\nOutput:\nfirst result",
      ),
      ...codexWaitPair(
        "wait-silent",
        3,
        "Script running with cell ID 1\nWall time 10.0 seconds\nOutput:\n",
      ),
    ];

    const items = preprocessMessages(messages);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.type === "tool_call" && item.id)).toEqual([
      "wait-output",
      "wait-silent",
    ]);
  });

  it("pairs OpenCode tool_result blocks from the same assistant message", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "websearch",
            input: { query: "ST4000VN006 ST4000VN008" },
            opencodeStatus: "completed",
          },
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content:
              "Found comparison notes at https://www.seagate.com/products/nas-drives/ironwolf-hard-drive/",
            is_error: false,
            opencodeStatus: "completed",
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "call_1",
      toolName: "websearch",
      status: "complete",
      toolResult: {
        content:
          "Found comparison notes at https://www.seagate.com/products/nas-drives/ironwolf-hard-drive/",
        isError: false,
      },
    });
  });

  it.each([
    [undefined, "pending"],
    ["completed", "complete"],
    ["error", "error"],
  ] as const)(
    "tracks an OpenCode background task until its %s notification",
    (terminalState, expectedStatus) => {
      const messages: Message[] = [
        {
          id: "msg-task",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_task",
              name: "task",
              input: {
                description: "Analyze swing middleware",
                subagent_type: "explore",
                background: true,
              },
              opencodeMetadata: {
                sessionId: "ses_child",
                parentSessionId: "ses_parent",
                background: true,
              },
              opencodeStatus: "completed",
            },
            {
              type: "tool_result",
              tool_use_id: "call_task",
              content: '<task id="ses_child" state="running"></task>',
              opencodeStatus: "completed",
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];
      if (terminalState) {
        messages.push({
          id: "msg-task-notification",
          role: "user",
          content: `<task state="${terminalState}" id="ses_child"><task_result>done</task_result></task>`,
          timestamp: "2024-01-01T00:00:01Z",
        });
      }

      const task = preprocessMessages(messages).find(
        (item) => item.type === "tool_call" && item.id === "call_task",
      );

      expect(task).toMatchObject({
        type: "tool_call",
        status: expectedStatus,
        toolInput: {
          opencodeMetadata: {
            sessionId: "ses_child",
            background: true,
          },
        },
      });
    },
  );

  it("normalizes OpenCode tool input and string output for expandable rows", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_read",
            name: "read",
            input: {
              filePath:
                "/repo/packages/client/src/components/blocks/ToolCallRow.tsx",
            },
            opencodeStatus: "completed",
            opencodeTitle:
              "packages/client/src/components/blocks/ToolCallRow.tsx",
          },
          {
            type: "tool_result",
            tool_use_id: "call_read",
            content:
              '<path>/repo/packages/client/src/components/blocks/ToolCallRow.tsx</path>\n<type>file</type>\n<content>\n10: import { ToolCallRow } from "./blocks/ToolCallRow";\n11: \n(End of file - total 11 lines)\n</content>',
            is_error: false,
            opencodeStatus: "completed",
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "call_read",
      toolName: "read",
      status: "complete",
      toolInput: {
        filePath: "/repo/packages/client/src/components/blocks/ToolCallRow.tsx",
        file_path:
          "/repo/packages/client/src/components/blocks/ToolCallRow.tsx",
        opencodeTitle: "packages/client/src/components/blocks/ToolCallRow.tsx",
      },
      toolResult: {
        isError: false,
        structured: {
          type: "text",
          file: {
            filePath:
              "/repo/packages/client/src/components/blocks/ToolCallRow.tsx",
            content: 'import { ToolCallRow } from "./blocks/ToolCallRow";',
            numLines: 1,
            startLine: 10,
            totalLines: 11,
          },
        },
      },
    });
  });

  it("normalizes OpenCode write output from input content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_write",
            name: "write",
            input: {
              filePath: "/repo/migrations/0011_benchmark_metrics.sql",
              content:
                "CREATE TABLE benchmark_metric (\n  id BIGINT PRIMARY KEY\n);",
            },
            opencodeStatus: "completed",
            opencodeTitle: "migrations/0011_benchmark_metrics.sql",
          },
          {
            type: "tool_result",
            tool_use_id: "call_write",
            content: "Wrote file successfully.",
            is_error: false,
            opencodeStatus: "completed",
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "call_write",
      toolName: "write",
      status: "complete",
      toolInput: {
        filePath: "/repo/migrations/0011_benchmark_metrics.sql",
        file_path: "/repo/migrations/0011_benchmark_metrics.sql",
        content: "CREATE TABLE benchmark_metric (\n  id BIGINT PRIMARY KEY\n);",
      },
      toolResult: {
        isError: false,
        structured: {
          type: "text",
          file: {
            filePath: "/repo/migrations/0011_benchmark_metrics.sql",
            content:
              "CREATE TABLE benchmark_metric (\n  id BIGINT PRIMARY KEY\n);",
            numLines: 3,
            startLine: 1,
            totalLines: 3,
          },
        },
      },
    });
  });

  it("normalizes OpenCode edit output into an expandable diff result", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_edit",
            name: "edit",
            input: {
              filePath: "/repo/src/app.ts",
              oldString: "const value = 1;",
              newString: "const value = 2;",
            },
            opencodeStatus: "completed",
            opencodeTitle: "src/app.ts",
          },
          {
            type: "tool_result",
            tool_use_id: "call_edit",
            content: "Edited successfully.",
            is_error: false,
            opencodeStatus: "completed",
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "call_edit",
      toolName: "edit",
      status: "complete",
      toolInput: {
        filePath: "/repo/src/app.ts",
        file_path: "/repo/src/app.ts",
        oldString: "const value = 1;",
        old_string: "const value = 1;",
        newString: "const value = 2;",
        new_string: "const value = 2;",
      },
      toolResult: {
        isError: false,
        structured: {
          filePath: "/repo/src/app.ts",
          oldString: "const value = 1;",
          newString: "const value = 2;",
          structuredPatch: [
            {
              lines: ["-const value = 1;", "+const value = 2;"],
            },
          ],
        },
      },
    });
  });

  it("normalizes OpenCode question prompts and answers into a structured result", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_question",
            name: "question",
            input: {
              questions: [
                {
                  header: "Materializer",
                  question: "How far should MySQL-as-source go?",
                  multiple: false,
                  options: [
                    { label: "Full", description: "Everything from MySQL" },
                    { label: "Partial", description: "Only pytest scripts" },
                  ],
                },
                {
                  header: "Framework",
                  question: "Which frameworks to support?",
                  multiple: true,
                  options: [
                    { label: "pytest", description: "" },
                    { label: "unittest", description: "" },
                  ],
                },
              ],
            },
            opencodeStatus: "completed",
            opencodeTitle: "Asked 2 questions",
            opencodeMetadata: {
              answers: [["Full"], ["pytest", "unittest"]],
            },
          },
          {
            type: "tool_result",
            tool_use_id: "call_question",
            content:
              'User has answered your questions: "How far should MySQL-as-source go?"="Full", "Which frameworks to support?"="pytest, unittest".',
            is_error: false,
            opencodeStatus: "completed",
            opencodeMetadata: {
              answers: [["Full"], ["pytest", "unittest"]],
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    const item = items[0];
    if (!item || item.type !== "tool_call") {
      throw new Error("expected a tool_call item");
    }
    expect(item).toMatchObject({
      id: "call_question",
      toolName: "question",
      status: "complete",
    });

    // Prompts normalized to the AskUserQuestion shape (id + multiSelect).
    expect(item.toolInput).toMatchObject({
      questions: [
        {
          id: "question-0",
          header: "Materializer",
          multiSelect: false,
          options: [
            { label: "Full", description: "Everything from MySQL" },
            { label: "Partial", description: "Only pytest scripts" },
          ],
        },
        { id: "question-1", header: "Framework", multiSelect: true },
      ],
    });

    // Structured result carries the selected answers keyed by question id.
    expect(item.toolResult?.structured).toEqual({
      questions: (item.toolInput as { questions: unknown }).questions,
      answers: {
        "question-0": ["Full"],
        "question-1": ["pytest", "unittest"],
      },
    });
  });

  it("collapses repeated plan progress snapshots within one user turn", () => {
    const messages: Message[] = [
      {
        id: "msg-user",
        role: "user",
        content: "Implement the feature",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-plan-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "plan-1",
            name: "UpdatePlan",
            input: {
              plan: [
                { step: "Inspect code", status: "in_progress" },
                { step: "Patch renderer", status: "pending" },
              ],
            },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-plan-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "plan-2",
            name: "UpdatePlan",
            input: {
              plan: [
                { step: "Inspect code", status: "completed" },
                { step: "Patch renderer", status: "in_progress" },
              ],
            },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const planItems = items.filter(
      (item) => item.type === "tool_call" && item.toolName === "UpdatePlan",
    );

    expect(planItems).toHaveLength(1);
    expect(planItems[0]).toMatchObject({
      type: "tool_call",
      id: "plan-1",
      toolInput: {
        plan: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch renderer", status: "in_progress" },
        ],
      },
    });
  });

  it("keeps a synthetic code-mode plan complete without a tool result", () => {
    const messages: Message[] = [
      {
        id: "msg-code-mode",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "exec-1",
            name: "CodexExec",
            input: { script: "await tools.update_plan({...});" },
          },
          {
            type: "tool_use",
            id: "exec-1-update-plan",
            name: "UpdatePlan",
            input: {
              plan: [{ step: "Inspect code", status: "completed" }],
            },
            status: "completed",
          },
        ],
      },
    ];

    const planItem = preprocessMessages(messages).find(
      (item) => item.type === "tool_call" && item.toolName === "UpdatePlan",
    );

    expect(planItem).toMatchObject({
      type: "tool_call",
      id: "exec-1-update-plan",
      status: "complete",
      toolInput: {
        plan: [{ step: "Inspect code", status: "completed" }],
      },
    });
  });

  it("keeps plan progress snapshots separate across user turns", () => {
    const messages: Message[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "First task",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-plan-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "plan-1",
            name: "UpdatePlan",
            input: { plan: [{ step: "Do first", status: "completed" }] },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-user-2",
        role: "user",
        content: "Second task",
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "msg-plan-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "plan-2",
            name: "UpdatePlan",
            input: { plan: [{ step: "Do second", status: "pending" }] },
          },
        ],
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const items = preprocessMessages(messages);
    const planItems = items.filter(
      (item) => item.type === "tool_call" && item.toolName === "UpdatePlan",
    );

    expect(planItems).toHaveLength(2);
  });

  it("collapses repeated TodoWrite snapshots within one user turn", () => {
    const messages: Message[] = [
      {
        id: "msg-user",
        role: "user",
        content: "Implement the feature",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-todo-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Inspect code", status: "in_progress" },
                { content: "Patch renderer", status: "pending" },
              ],
            },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-todo-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "todo-2",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Inspect code", status: "completed" },
                { content: "Patch renderer", status: "in_progress" },
              ],
            },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const todoItems = items.filter(
      (item) => item.type === "tool_call" && item.toolName === "TodoWrite",
    );

    expect(todoItems).toHaveLength(1);
    expect(todoItems[0]).toMatchObject({
      type: "tool_call",
      id: "todo-1",
      toolInput: {
        todos: [
          { content: "Inspect code", status: "completed" },
          { content: "Patch renderer", status: "in_progress" },
        ],
      },
    });
  });

  it("preserves Agent tool summaries for rendering completed tasks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Agent",
            input: {
              description: "Explore codebase for refactoring",
              prompt: "Find cleanup opportunities",
              subagent_type: "Explore",
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "text",
                text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
              },
              {
                type: "text",
                text: "agentId: summary123\n<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
              },
            ],
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "tool-1",
      toolName: "Agent",
      status: "complete",
      toolResult: {
        isError: false,
        structured: {
          agentId: "summary123",
          status: "completed",
          content: [
            {
              type: "text",
              text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
            },
          ],
          totalTokens: 200,
          totalToolUseCount: 3,
          totalDurationMs: 1000,
        },
      },
    });
  });

  it("routes task notifications back into the matching Agent tool call", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Agent",
            input: {
              description: "查找 session 未读状态定义",
              prompt: "Find unread session logic",
              subagent_type: "Explore",
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "text",
                text: "Async agent launched successfully.\nagentId: agent-123\noutput_file: /tmp/agent-123.output",
              },
            ],
          },
        ],
        toolUseResult: {
          isAsync: true,
          status: "async_launched",
          agentId: "agent-123",
          outputFile: "/tmp/agent-123.output",
        },
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-3",
        role: "user",
        type: "user",
        content: `<task-notification>
<task-id>agent-123</task-id>
<tool-use-id>tool-1</tool-use-id>
<output-file>/tmp/agent-123.output</output-file>
<status>completed</status>
<summary>Agent "查找 session 未读状态定义" finished</summary>
<result># Report

Details with a &gt; comparison.</result>
<usage><subagent_tokens>173541</subagent_tokens><tool_uses>44</tool_uses><duration_ms>640939</duration_ms></usage>
</task-notification>`,
        _taskNotificationResultHtml: "<h1>Report</h1><p>Details</p>",
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "tool-1",
      toolName: "Agent",
      status: "complete",
      toolResult: {
        isError: false,
        structured: {
          agentId: "agent-123",
          status: "completed",
          totalTokens: 173541,
          totalToolUseCount: 44,
          totalDurationMs: 640939,
          content: [
            {
              type: "text",
              text: "# Report\n\nDetails with a > comparison.",
              _renderedHtml: "<h1>Report</h1><p>Details</p>",
            },
          ],
        },
      },
    });
  });

  it("marks tool_use as pending when result not yet received", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "pending",
      toolResult: undefined,
    });
  });

  it("deduplicates repeated tool_use blocks with the same id", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);
    const toolCalls = items.filter((item) => item.type === "tool_call");

    expect(toolCalls).toHaveLength(1);
    const call = toolCalls[0];
    if (call?.type === "tool_call") {
      expect(call.id).toBe("call_1");
      expect(call.status).toBe("pending");
    }
  });

  it("attaches tool_result to deduplicated tool_use", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-3",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "success",
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const toolCalls = items.filter((item) => item.type === "tool_call");

    expect(toolCalls).toHaveLength(1);
    const call = toolCalls[0];
    if (call?.type === "tool_call") {
      expect(call.status).toBe("complete");
      expect(call.toolResult?.content).toBe("success");
    }
  });

  it("handles multiple tool calls in sequence", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "a.ts" },
          },
          {
            type: "tool_use",
            id: "tool-2",
            name: "Read",
            input: { file_path: "b.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "contents a" },
          { type: "tool_result", tool_use_id: "tool-2", content: "contents b" },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    const item0 = items[0];
    const item1 = items[1];
    expect(item0?.type).toBe("tool_call");
    expect(item1?.type).toBe("tool_call");
    if (item0?.type === "tool_call" && item1?.type === "tool_call") {
      expect(item0.status).toBe("complete");
      expect(item1.status).toBe("complete");
    }
  });

  it("links write_stdin calls to prior bash command using session id", () => {
    const messages: Message[] = [
      {
        id: "msg-bash-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-bash-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content: "Process running with session ID 29243",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 29243, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 29243,
        linked_command: "pnpm test",
      });
    }
  });

  it("links write_stdin calls to prior exec_command using session id", () => {
    const messages: Message[] = [
      {
        id: "msg-exec-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "exec-1",
            name: "exec_command",
            input: {
              cmd: "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx",
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-exec-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "exec-1",
            content: "Process running with session ID 70073",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 70073, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 70073,
        linked_command:
          "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx",
      });
    }
  });

  it("links write_stdin calls to prior Read tool using structured session id", () => {
    const messages: Message[] = [
      {
        id: "msg-read-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: {
              file_path: "packages/client/src/hooks/useGlobalSessions.ts",
              offset: 1,
              limit: 260,
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-read-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "",
          },
        ],
        toolUseResult: {
          type: "text",
          file: {
            filePath: "packages/client/src/hooks/useGlobalSessions.ts",
            content:
              'import { useCallback, useEffect, useRef, useState } from "react";\n',
            numLines: 1,
            startLine: 1,
            totalLines: 1,
          },
          session_id: 37863,
        },
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 37863, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 37863,
        linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
        linked_tool_name: "Read",
      });
    }
  });

  it("preserves thinking blocks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me analyze this..." },
          { type: "text", text: "Here is my response." },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]?.type).toBe("thinking");
    expect(items[1]?.type).toBe("text");
  });

  it("handles user prompts with string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: "Hello, please help me",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      id: "msg-1",
      content: "Hello, please help me",
    });
  });

  it("collapses leading session setup prompts into one item", () => {
    const messages: Message[] = [
      {
        id: "msg-setup-1",
        role: "user",
        content: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfoo",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-2",
        role: "user",
        content:
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-user-1",
        role: "user",
        content: "Implement the requested change",
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [
        "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfoo",
        "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
      ],
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: "Implement the requested change",
    });
  });

  it("does not collapse a single setup-like prompt in the middle of a session", () => {
    const messages: Message[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "normal first prompt",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-1",
        role: "user",
        content: "# AGENTS.md instructions for /repo",
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      content: "normal first prompt",
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: "# AGENTS.md instructions for /repo",
    });
  });

  it("collapses strong setup prompts between duplicate initial user prompts", () => {
    const setupContent =
      "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfoo\n</INSTRUCTIONS><environment_context>\n  <cwd>/repo</cwd>\n</environment_context>";
    const prompt = "Implement the requested change";
    const messages: Message[] = [
      {
        id: "msg-user-sdk",
        role: "user",
        content: prompt,
        timestamp: "2024-01-01T00:00:00Z",
        _source: "sdk",
      },
      {
        id: "msg-setup",
        role: "user",
        content: setupContent,
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-user-jsonl",
        role: "user",
        content: prompt,
        timestamp: "2024-01-01T00:00:02Z",
        _source: "jsonl",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      id: "msg-user-jsonl",
      content: prompt,
    });
    expect(items[1]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [setupContent],
    });
  });

  it("collapses repeated setup prompts inserted after resume", () => {
    const messages: Message[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "normal first prompt",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-1",
        role: "user",
        content: "# AGENTS.md instructions for /repo",
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-setup-2",
        role: "user",
        content:
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "msg-user-2",
        role: "user",
        content: "follow-up after resume",
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      content: "normal first prompt",
    });
    expect(items[1]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [
        "# AGENTS.md instructions for /repo",
        "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
      ],
    });
    expect(items[2]).toMatchObject({
      type: "user_prompt",
      content: "follow-up after resume",
    });
  });

  it("deduplicates identical setup prompts inside a collapsed setup run", () => {
    const setupContent =
      "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfoo\n</INSTRUCTIONS><environment_context>\n  <cwd>/repo</cwd>\n</environment_context>";
    const messages: Message[] = [
      {
        id: "msg-setup-1",
        role: "user",
        content: setupContent,
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-2",
        role: "user",
        content: setupContent,
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-user-1",
        role: "user",
        content: "Implement the requested change",
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [setupContent],
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: "Implement the requested change",
    });
  });

  it("attaches markdown augment to assistant string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: "Hello **world**",
        _html: "<p>Hello <strong>world</strong></p>",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      id: "msg-1",
      text: "Hello **world**",
      augmentHtml: "<p>Hello <strong>world</strong></p>",
    });
  });

  it("falls back to markdown augment map for assistant string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: "Hello **world**",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages, {
      markdown: {
        "msg-1": { html: "<p>Hello <strong>world</strong></p>" },
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      id: "msg-1",
      text: "Hello **world**",
      augmentHtml: "<p>Hello <strong>world</strong></p>",
    });
  });

  it("marks tool result as error when is_error is true", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "invalid" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Command failed",
            is_error: true,
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "error",
      toolResult: { content: "Command failed", isError: true },
    });
  });

  it("skips empty text blocks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
          { type: "text", text: "Actual content" },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      text: "Actual content",
    });
  });

  it("attaches structured tool result data", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "test.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "file contents",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
        toolUseResult: { lineCount: 42, filePath: "/test.ts" },
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.type === "tool_call") {
      expect(item.toolResult?.structured).toEqual({
        lineCount: 42,
        filePath: "/test.ts",
      });
    }
  });

  it("renders turn_aborted system messages as a concise marker", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "system",
        subtype: "turn_aborted",
        content:
          "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      content: "Conversation stopped by user",
    });
  });

  it("renders provider error messages", () => {
    const messages: Message[] = [
      {
        id: "msg-err-1",
        type: "error",
        error: "Your refresh token was already used. Please sign in again.",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "error",
      content: "Your refresh token was already used. Please sign in again.",
    });
  });

  describe("orphaned tool handling", () => {
    it("marks orphaned tool_use as aborted", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "aborted",
        toolResult: undefined,
      });
    });

    it("handles mix of orphaned and completed tools", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "tool-2",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-2"], // only tool-2 is orphaned
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "file contents",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(2);
      const tool1 = items.find(
        (i) => i.type === "tool_call" && i.id === "tool-1",
      );
      const tool2 = items.find(
        (i) => i.type === "tool_call" && i.id === "tool-2",
      );

      expect(tool1?.type === "tool_call" && tool1.status).toBe("complete");
      expect(tool2?.type === "tool_call" && tool2.status).toBe("aborted");
    });

    it("non-orphaned pending tools remain pending", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          // No orphanedToolUseIds - tool is still pending (live conversation)
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending",
      });
    });
  });

  describe("activeToolApproval handling", () => {
    it("treats all orphaned tools as pending when activeToolApproval is true", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending", // Should be pending, not aborted
      });
    });

    it("still marks orphaned tools as aborted when activeToolApproval is false", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "aborted",
      });
    });

    it("treats multiple orphaned tools as pending when activeToolApproval is true", () => {
      // Scenario: batch of tool calls all queued for approval
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Edit",
              input: { file_path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "tool-2",
              name: "Edit",
              input: { file_path: "b.ts" },
            },
            {
              type: "tool_use",
              id: "tool-3",
              name: "Edit",
              input: { file_path: "c.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1", "tool-2", "tool-3"],
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(3);
      // All should be pending, not aborted
      for (const item of items) {
        expect(item).toMatchObject({
          type: "tool_call",
          status: "pending",
        });
      }
    });

    it("handles activeToolApproval with no orphaned tools (no-op)", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          // No orphanedToolUseIds
        },
      ];

      const items = preprocessMessages(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending", // Already pending, stays pending
      });
    });
  });

  describe("streaming partial output", () => {
    it("carries partialOutput onto the pending tool call", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-live",
              name: "Bash",
              input: { command: "make build" },
              partialOutput: "compiling...\n",
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-live",
        status: "pending",
        partialOutput: "compiling...\n",
      });
    });

    it("refreshes partialOutput from replayed tool_use snapshots", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-live",
              name: "Bash",
              input: { command: "make build" },
              partialOutput: "compiling...\n",
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-live",
              name: "Bash",
              input: { command: "make build" },
              partialOutput: "compiling...\nlinking...\n",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        partialOutput: "compiling...\nlinking...\n",
      });
    });
  });

  describe("duplicate & batched tool results", () => {
    it("does not fan out message-level toolUseResult to parallel tool results", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-a",
              name: "Read",
              input: { file_path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "tool-b",
              name: "Read",
              input: { file_path: "b.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-a", content: "aaa" },
            { type: "tool_result", tool_use_id: "tool-b", content: "bbb" },
          ],
          timestamp: "2024-01-01T00:00:01Z",
          // Ambiguous: belongs to one of the two blocks, not both.
          toolUseResult: { lineCount: 1, filePath: "/a.ts" },
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.type).toBe("tool_call");
        if (item.type === "tool_call") {
          expect(item.toolResult?.structured).not.toEqual({
            lineCount: 1,
            filePath: "/a.ts",
          });
        }
      }
    });

    it("still attaches message-level toolUseResult for single-result messages", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-a",
              name: "Read",
              input: { file_path: "a.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-a", content: "aaa" },
          ],
          timestamp: "2024-01-01T00:00:01Z",
          toolUseResult: { lineCount: 1, filePath: "/a.ts" },
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      const item = items[0];
      if (item?.type === "tool_call") {
        expect(item.toolResult?.structured).toEqual({
          lineCount: 1,
          filePath: "/a.ts",
        });
      }
    });

    it("upgrades a partial result when a richer duplicate arrives later", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-a",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-a", content: "par" },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
        {
          id: "msg-3",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-a",
              content: "partial output now complete",
            },
          ],
          timestamp: "2024-01-01T00:00:02Z",
          toolUseResult: { stdout: "partial output now complete" },
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item?.type).toBe("tool_call");
      if (item?.type === "tool_call") {
        expect(item.toolResult?.content).toBe("partial output now complete");
        expect(item.toolResult?.structured).toEqual({
          stdout: "partial output now complete",
        });
      }
    });

    it("keeps the richer result when a shorter duplicate arrives later", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-a",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-a",
              content: "complete output",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
          toolUseResult: { stdout: "complete output" },
        },
        {
          id: "msg-3",
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-a", content: "com" },
          ],
          timestamp: "2024-01-01T00:00:02Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      const item = items[0];
      if (item?.type === "tool_call") {
        expect(item.toolResult?.content).toBe("complete output");
        expect(item.toolResult?.structured).toEqual({
          stdout: "complete output",
        });
      }
    });
  });
});

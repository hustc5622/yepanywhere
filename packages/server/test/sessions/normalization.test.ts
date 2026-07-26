import type {
  ClaudeSessionContent,
  ClaudeSessionEntry,
  CodexSessionContent,
  UnifiedSession,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { normalizeSession } from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";

describe("normalizeSession", () => {
  it("includes sibling tool_results for parallel Tasks with same parentUuid", () => {
    // This simulates 3 parallel Task tool_uses where each produces a tool_result
    // with the same parentUuid (all are children of the assistant message)
    const rawMessages: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "msg-1",
        parentUuid: null,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "task-1", name: "Task", input: {} },
            { type: "tool_use", id: "task-2", name: "Task", input: {} },
            { type: "tool_use", id: "task-3", name: "Task", input: {} },
          ],
        },
      },
      // All 3 results have the same parentUuid - they are siblings
      {
        type: "user",
        uuid: "result-1",
        parentUuid: "msg-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-1", content: "Result 1" },
          ],
        },
      },
      {
        type: "user",
        uuid: "result-2",
        parentUuid: "msg-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-2", content: "Result 2" },
          ],
        },
      },
      {
        type: "user",
        uuid: "result-3",
        parentUuid: "msg-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-3", content: "Result 3" },
          ],
        },
      },
    ];

    const mockSession: LoadedSession = {
      summary: {
        id: "test-session",
        projectId: "test-project" as UrlProjectId,
        title: "Test Session",
        fullTitle: "Test Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 4,
        status: { state: "idle" },
        provider: "claude",
      },
      data: {
        provider: "claude",
        session: {
          messages: rawMessages,
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);

    // Should have 4 messages: assistant + 3 tool results (2 siblings + 1 active)
    expect(normalized.messages).toHaveLength(4);

    // First message should be the assistant with 3 tool_use blocks
    expect(normalized.messages[0].type).toBe("assistant");
    const assistantContent = normalized.messages[0].message?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    expect((assistantContent as unknown[]).length).toBe(3);

    // Collect all tool_use_ids from the remaining messages (tool_results)
    const toolResultIds: string[] = [];
    for (let i = 1; i < normalized.messages.length; i++) {
      const msg = normalized.messages[i];
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            toolResultIds.push(block.tool_use_id);
          }
        }
      }
    }

    // All 3 task results should be present
    expect(toolResultIds).toContain("task-1");
    expect(toolResultIds).toContain("task-2");
    expect(toolResultIds).toContain("task-3");
  });

  it("normalizes OpenCode reasoning and tool inputs for shared renderers", () => {
    const mockSession: LoadedSession = {
      summary: {
        id: "opencode-test-session",
        projectId: "test-project" as UrlProjectId,
        title: "OpenCode Test",
        fullTitle: "OpenCode Test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        status: { state: "idle" },
        provider: "opencode",
      },
      data: {
        provider: "opencode",
        session: {
          messages: [
            {
              message: {
                id: "msg-1",
                sessionID: "session-1",
                role: "assistant",
                time: { created: Date.now(), completed: Date.now() + 1 },
              },
              parts: [
                {
                  id: "part-reasoning",
                  sessionID: "session-1",
                  messageID: "msg-1",
                  type: "reasoning",
                  text: "Need to inspect the file.",
                },
                {
                  id: "part-tool",
                  sessionID: "session-1",
                  messageID: "msg-1",
                  type: "tool",
                  callID: "call-edit",
                  tool: "edit",
                  state: {
                    status: "completed",
                    input: {
                      filePath: "/repo/src/app.ts",
                      oldString: "const value = 1;",
                      newString: "const value = 2;",
                    },
                    output: "Edited successfully.",
                    title: "src/app.ts",
                  },
                },
              ],
            },
          ],
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);
    const content = normalized.messages[0]?.message?.content;

    expect(content).toMatchObject([
      { type: "thinking", thinking: "Need to inspect the file." },
      {
        type: "tool_use",
        id: "call-edit",
        name: "Edit",
        input: {
          filePath: "/repo/src/app.ts",
          file_path: "/repo/src/app.ts",
          oldString: "const value = 1;",
          old_string: "const value = 1;",
          newString: "const value = 2;",
          new_string: "const value = 2;",
        },
      },
      {
        type: "tool_result",
        tool_use_id: "call-edit",
        content: "Edited successfully.",
      },
    ]);
    expect(normalized.messages[0]?.openCodeHasToolPart).toBe(true);
    expect(normalized.messages[0]?.openCodeCompleted).toBe(false);
    expect(normalized.messages[0]?.finish).toBeUndefined();
  });

  it("normalizes Kimi file tools and emits pairable tool result messages", () => {
    const mockSession: LoadedSession = {
      summary: {
        id: "session-kimi",
        projectId: "test-project" as UrlProjectId,
        title: "Kimi tools",
        fullTitle: "Kimi tools",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:01.000Z",
        messageCount: 7,
        status: { state: "idle" },
        provider: "kimi",
      },
      data: {
        provider: "kimi",
        session: {
          sessionId: "session-kimi",
          createdAt: "2026-07-25T00:00:00.000Z",
          records: [
            {
              type: "turn.prompt",
              input: [{ type: "text", text: "Inspect and update the file" }],
              time: 1,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "content.part",
                part: { type: "think", think: "User" },
              },
              time: 1,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "content.part",
                part: { type: "think", think: " wants" },
              },
              time: 1,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "content.part",
                part: { type: "text", text: "Starting" },
              },
              time: 1,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "content.part",
                part: { type: "text", text: "." },
              },
              time: 1,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "tool.call",
                toolCallId: "read-1",
                name: "Read",
                args: {
                  path: "src/app.ts",
                  line_offset: 3,
                  n_lines: 2,
                },
              },
              time: 2,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "tool.result",
                toolCallId: "read-1",
                result: { output: "3\tconst oldValue = 1;\n4\t" },
              },
              time: 3,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "tool.call",
                toolCallId: "write-1",
                name: "Write",
                args: {
                  path: "src/new.ts",
                  content: "export const value = 2;\n",
                },
              },
              time: 4,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "tool.result",
                toolCallId: "write-1",
                result: { output: "Wrote 24 bytes to src/new.ts" },
              },
              time: 5,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "tool.call",
                toolCallId: "edit-1",
                name: "Edit",
                args: {
                  path: "src/app.ts",
                  old_string: "const oldValue = 1;",
                  new_string: "const oldValue = 2;",
                },
              },
              time: 6,
            },
            {
              type: "context.append_loop_event",
              event: {
                type: "tool.result",
                toolCallId: "edit-1",
                result: {
                  output: "old_string was not found",
                  isError: true,
                },
              },
              time: 7,
            },
          ],
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);

    expect(normalized.messages).toHaveLength(7);
    expect(normalized.messages[1]?.message?.content).toEqual([
      {
        type: "thinking",
        thinking: "User wants",
      },
      {
        type: "text",
        text: "Starting.",
      },
      {
        type: "tool_use",
        id: "read-1",
        name: "Read",
        input: {
          path: "src/app.ts",
          file_path: "src/app.ts",
          line_offset: 3,
          offset: 3,
          n_lines: 2,
          limit: 2,
        },
      },
    ]);
    expect(normalized.messages[2]).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "3\tconst oldValue = 1;\n4\t",
          },
        ],
      },
    });
    expect(normalized.messages[3]?.message?.content).toEqual([
      {
        type: "tool_use",
        id: "write-1",
        name: "Write",
        input: {
          path: "src/new.ts",
          file_path: "src/new.ts",
          content: "export const value = 2;\n",
        },
      },
    ]);
    expect(normalized.messages[5]?.message?.content).toEqual([
      {
        type: "tool_use",
        id: "edit-1",
        name: "Edit",
        input: {
          path: "src/app.ts",
          file_path: "src/app.ts",
          old_string: "const oldValue = 1;",
          new_string: "const oldValue = 2;",
        },
      },
    ]);
    expect(normalized.messages[6]).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "edit-1",
            content: "old_string was not found",
            is_error: true,
          },
        ],
      },
    });
  });

  it("does not persist an unnamed OpenCode data URI attachment as text", () => {
    const dataUri = `data:application/pdf;base64,${"A".repeat(8_192)}`;
    const mockSession: LoadedSession = {
      summary: {
        id: "opencode-file-session",
        projectId: "test-project" as UrlProjectId,
        title: "OpenCode File",
        fullTitle: "OpenCode File",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        provider: "opencode",
      },
      data: {
        provider: "opencode",
        session: {
          messages: [
            {
              message: {
                id: "msg-file",
                sessionID: "opencode-file-session",
                role: "user",
                time: { created: Date.now() },
              },
              parts: [
                {
                  id: "part-file",
                  sessionID: "opencode-file-session",
                  messageID: "msg-file",
                  type: "file",
                  mime: "application/pdf",
                  url: dataUri,
                },
              ],
            },
          ],
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);
    const text = JSON.stringify(normalized.messages[0]?.message?.content);
    expect(text).toContain("📎 attachment (application/pdf)");
    expect(text).not.toContain("data:application/pdf;base64");
  });

  it("does not duplicate native file markers for persisted Yep uploads", () => {
    const prompt =
      "Review this screenshot\n\nUser uploaded files:\n- screenshot.png (1.0 KB, image/png): /uploads/screenshot.png";
    const mockSession: LoadedSession = {
      summary: {
        id: "opencode-yep-file-session",
        projectId: "test-project" as UrlProjectId,
        title: "OpenCode Yep File",
        fullTitle: "OpenCode Yep File",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        provider: "opencode",
      },
      data: {
        provider: "opencode",
        session: {
          messages: [
            {
              message: {
                id: "msg-yep-file",
                sessionID: "opencode-yep-file-session",
                role: "user",
                time: { created: Date.now() },
              },
              parts: [
                {
                  id: "part-synthetic-read",
                  sessionID: "opencode-yep-file-session",
                  messageID: "msg-yep-file",
                  type: "text",
                  synthetic: true,
                  text: 'Called the Read tool with the following input: {"filePath":"/uploads/screenshot.png"}',
                },
                {
                  id: "part-text",
                  sessionID: "opencode-yep-file-session",
                  messageID: "msg-yep-file",
                  type: "text",
                  text: prompt,
                },
                {
                  id: "part-file",
                  sessionID: "opencode-yep-file-session",
                  messageID: "msg-yep-file",
                  type: "file",
                  mime: "image/png",
                  filename: "screenshot.png",
                  url: "data:image/png;base64,AQID",
                },
              ],
            },
          ],
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);
    expect(normalized.messages[0]?.message?.content).toEqual([
      { type: "text", text: prompt },
    ]);
  });

  it("marks a persisted legacy OpenCode text response as completed", () => {
    const mockSession: LoadedSession = {
      summary: {
        id: "opencode-legacy-response",
        projectId: "test-project" as UrlProjectId,
        title: "OpenCode legacy response",
        fullTitle: "OpenCode legacy response",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        status: { state: "idle" },
        provider: "opencode",
      },
      data: {
        provider: "opencode",
        session: {
          messages: [
            {
              message: {
                id: "msg-legacy",
                sessionID: "opencode-legacy-response",
                role: "assistant",
                time: { created: 1, completed: 2 },
              },
              parts: [
                {
                  id: "part-text",
                  sessionID: "opencode-legacy-response",
                  messageID: "msg-legacy",
                  type: "text",
                  text: "The legacy response is complete.",
                },
              ],
            },
          ],
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);

    expect(normalized.messages[0]?.openCodeCompleted).toBe(true);
  });

  it("normalizes OpenCode parent IDs and copied cross-session branch aliases", () => {
    const mockSession: LoadedSession = {
      summary: {
        id: "ses_grandchild",
        projectId: "test-project" as UrlProjectId,
        title: "OpenCode branch",
        fullTitle: "OpenCode branch",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:01.000Z",
        messageCount: 2,
        status: { state: "idle" },
        provider: "opencode",
      },
      branchState: {
        // Deliberately differs from the matching option to prove annotation
        // takes the concrete alternative's target session.
        sessionId: "ses_parent",
        provider: "opencode",
        activeBranchId: "u2_edit",
        selectedBranchId: "u2_edit",
        branches: [
          {
            id: "u2",
            sessionId: "ses_parent",
            parentId: "u1",
            prompt: "original",
            title: "original",
            depth: 2,
            index: 1,
            siblingIndex: 1,
            siblingCount: 2,
            isActive: false,
            provider: "opencode",
          },
          {
            id: "u2_edit",
            sessionId: "ses_child",
            parentId: "u1",
            prompt: "edited",
            title: "edited",
            depth: 2,
            index: 2,
            siblingIndex: 2,
            siblingCount: 2,
            isActive: true,
            createdAt: "2026-07-15T00:00:00.000Z",
            provider: "opencode",
          },
        ],
      },
      data: {
        provider: "opencode",
        session: {
          messages: [
            {
              message: {
                id: "u2_edit_copy",
                sessionID: "ses_grandchild",
                role: "user",
                parentID: "native-parent",
                time: { created: Date.UTC(2026, 6, 15) },
              },
              parts: [
                {
                  id: "part-u2-edit-copy",
                  sessionID: "ses_grandchild",
                  messageID: "u2_edit_copy",
                  type: "text",
                  text: "edited",
                },
              ],
            },
            {
              message: {
                id: "a2_edit",
                sessionID: "ses_grandchild",
                role: "assistant",
                parentID: "u2_edit_copy",
                time: { created: Date.UTC(2026, 6, 15, 0, 0, 1) },
              },
              parts: [],
            },
          ],
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);
    expect(normalized.branchState).toBe(mockSession.branchState);
    expect(normalized.messages[0]).toMatchObject({
      uuid: "u2_edit_copy",
      parentUuid: "native-parent",
      parentId: "native-parent",
      branch: {
        sessionId: "ses_child",
        branchId: "u2_edit",
        siblingCount: 2,
      },
    });
    expect(normalized.messages[1]).toMatchObject({
      parentUuid: "u2_edit_copy",
      parentId: "u2_edit_copy",
    });
  });

  it("preserves same-session Claude branch annotation", () => {
    const mockSession: LoadedSession = {
      summary: {
        id: "claude-session",
        projectId: "test-project" as UrlProjectId,
        title: "Claude branch",
        fullTitle: "Claude branch",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:01.000Z",
        messageCount: 1,
        status: { state: "idle" },
        provider: "claude",
      },
      messagesAlreadyProjected: true,
      branchState: {
        sessionId: "claude-session",
        provider: "claude",
        activeBranchId: "u2-edit",
        selectedBranchId: "u2-edit",
        branches: [
          {
            id: "u2-original",
            sessionId: "claude-session",
            parentId: "a1",
            prompt: "original",
            title: "original",
            depth: 2,
            index: 1,
            siblingIndex: 1,
            siblingCount: 2,
            isActive: false,
            provider: "claude",
          },
          {
            id: "u2-edit",
            sessionId: "claude-session",
            parentId: "a1",
            prompt: "edited",
            title: "edited",
            depth: 2,
            index: 2,
            siblingIndex: 2,
            siblingCount: 2,
            isActive: true,
            provider: "claude",
          },
        ],
      },
      data: {
        provider: "claude",
        session: {
          messages: [
            {
              type: "user",
              uuid: "u2-edit",
              parentUuid: "a1",
              message: { role: "user", content: "edited" },
            },
          ],
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);
    expect(normalized.messages[0]?.branch).toMatchObject({
      sessionId: "claude-session",
      branchId: "u2-edit",
      siblingCount: 2,
    });
  });

  it("preserves OpenCode edit metadata diff as a raw patch augment", () => {
    const rawDiff = [
      "===================================================================",
      "--- /repo/src/app.ts",
      "+++ /repo/src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-const value = 1;",
      "+const value = 2;",
    ].join("\n");
    const mockSession: LoadedSession = {
      summary: {
        id: "opencode-diff-session",
        projectId: "test-project" as UrlProjectId,
        title: "OpenCode Diff",
        fullTitle: "OpenCode Diff",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        status: { state: "idle" },
        provider: "opencode",
      },
      data: {
        provider: "opencode",
        session: {
          messages: [
            {
              message: {
                id: "msg-1",
                sessionID: "session-1",
                role: "assistant",
                time: { created: Date.now() },
              },
              parts: [
                {
                  id: "part-tool",
                  sessionID: "session-1",
                  messageID: "msg-1",
                  type: "tool",
                  callID: "call-edit",
                  tool: "edit",
                  state: {
                    status: "completed",
                    input: {
                      filePath: "/repo/src/app.ts",
                    },
                    output: "Edited successfully.",
                    title: "src/app.ts",
                    metadata: {
                      diff: rawDiff,
                    },
                  },
                },
              ],
            },
          ],
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);
    const content = normalized.messages[0]?.message?.content;

    expect(content?.[0]).toMatchObject({
      type: "tool_use",
      id: "call-edit",
      name: "Edit",
      input: {
        filePath: "/repo/src/app.ts",
        file_path: "/repo/src/app.ts",
        _rawPatch: rawDiff,
      },
    });
  });

  it("normalizes codex-oss sessions correctly", () => {
    const mockSession: LoadedSession = {
      summary: {
        id: "oss-test-session",
        projectId: "test-project" as UrlProjectId,
        title: "Test Session",
        fullTitle: "Test Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        status: { state: "idle" },
        provider: "codex-oss",
      },
      data: {
        provider: "codex-oss",
        session: {
          entries: [
            {
              type: "session_meta",
              timestamp: new Date().toISOString(),
              payload: {
                id: "oss-test-session",
                cwd: "/test/path",
                timestamp: new Date().toISOString(),
                model_provider: "ollama",
              },
            },
            {
              type: "event_msg",
              timestamp: new Date().toISOString(),
              payload: {
                type: "user_message",
                message: "Hello OSS",
              },
            },
          ],
        } as CodexSessionContent,
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);

    expect(normalized).toBeDefined();
    expect(normalized.id).toBe("oss-test-session");
    // Should have 1 message (user message)
    // The session_meta entry is not converted to a message
    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0].message.content).toEqual("Hello OSS");
  });

  it("includes chained parallel Tasks on sibling branches", () => {
    // This simulates the real-world scenario where Claude spawns 3 parallel Tasks
    // as CHAINED messages (each task in separate assistant message that chains from previous)
    // When results come back, conversation continues from the FIRST result,
    // leaving other tasks on "dead" branches
    const rawMessages: ClaudeSessionEntry[] = [
      {
        type: "assistant",
        uuid: "text-msg",
        parentUuid: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me explore..." }],
        },
      },
      {
        type: "assistant",
        uuid: "task-1-msg",
        parentUuid: "text-msg",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "task-1-id", name: "Task", input: {} },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "task-2-msg",
        parentUuid: "task-1-msg",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "task-2-id", name: "Task", input: {} },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "task-3-msg",
        parentUuid: "task-2-msg",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "task-3-id", name: "Task", input: {} },
          ],
        },
      },
      // Results
      {
        type: "user",
        uuid: "result-3",
        parentUuid: "task-3-msg",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-3-id", content: "R3" },
          ],
        },
      },
      {
        type: "user",
        uuid: "result-2",
        parentUuid: "task-2-msg",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-2-id", content: "R2" },
          ],
        },
      },
      {
        type: "user",
        uuid: "result-1",
        parentUuid: "task-1-msg",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-1-id", content: "R1" },
          ],
        },
      },
      // Conversation continues from result-1, making task-2 and task-3 on dead branches
      {
        type: "assistant",
        uuid: "cont-1",
        parentUuid: "result-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Excellent..." }],
        },
      },
      {
        type: "user",
        uuid: "cont-2",
        parentUuid: "cont-1",
        message: { role: "user", content: "Continue" },
      },
      {
        type: "assistant",
        uuid: "cont-3",
        parentUuid: "cont-2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Sure..." }],
        },
      },
      {
        type: "user",
        uuid: "cont-4",
        parentUuid: "cont-3",
        message: { role: "user", content: "More" },
      },
    ];

    const mockSession: LoadedSession = {
      summary: {
        id: "test-session",
        projectId: "test-project" as UrlProjectId,
        title: "Test Session",
        fullTitle: "Test Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 11,
        status: { state: "idle" },
        provider: "claude",
      },
      data: {
        provider: "claude",
        session: {
          messages: rawMessages,
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);

    // Collect all tool_use IDs and tool_result IDs from normalized messages
    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];
    for (const msg of normalized.messages) {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.id) {
            toolUseIds.push(block.id);
          }
          if (block.type === "tool_result" && block.tool_use_id) {
            toolResultIds.push(block.tool_use_id);
          }
        }
      }
    }

    // All 3 Task tool_uses should be present
    expect(toolUseIds).toContain("task-1-id");
    expect(toolUseIds).toContain("task-2-id");
    expect(toolUseIds).toContain("task-3-id");

    // All 3 Task results should be present
    expect(toolResultIds).toContain("task-1-id");
    expect(toolResultIds).toContain("task-2-id");
    expect(toolResultIds).toContain("task-3-id");
  });

  it("reconstructs removed queued prompts as persisted user messages", () => {
    const rawMessages: ClaudeSessionEntry[] = [
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-03-28T12:12:01.573Z",
        sessionId: "queue-history-session",
        content:
          "i want to test a session where i speak out of turn (while you're busy doing stuff). to that end please run a sleep 20 command (so you sleep for 20 seconds).",
      },
      {
        type: "queue-operation",
        operation: "dequeue",
        timestamp: "2026-03-28T12:12:01.575Z",
        sessionId: "queue-history-session",
      },
      {
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        message: {
          role: "user",
          content:
            "i want to test a session where i speak out of turn (while you're busy doing stuff). to that end please run a sleep 20 command (so you sleep for 20 seconds).",
        },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-sleep",
              name: "Bash",
              input: { command: "sleep 20" },
            },
          ],
        },
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-03-28T12:12:10.002Z",
        sessionId: "queue-history-session",
        content: "i'm talking out of turn!",
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-03-28T12:12:14.115Z",
        sessionId: "queue-history-session",
        content: "saying a second thing out of turn",
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-03-28T12:12:17.757Z",
        sessionId: "queue-history-session",
        content: "saying a third thing out of turn",
      },
      {
        type: "user",
        uuid: "tool-result-1",
        parentUuid: "assistant-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-sleep",
              content: "(Bash completed with no output)",
            },
          ],
        },
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-03-28T12:12:27.772Z",
        sessionId: "queue-history-session",
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-03-28T12:12:27.773Z",
        sessionId: "queue-history-session",
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-03-28T12:12:27.774Z",
        sessionId: "queue-history-session",
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "tool-result-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done sleeping. I saw the queued messages.",
            },
          ],
        },
      },
    ];

    const mockSession: LoadedSession = {
      summary: {
        id: "queue-history-session",
        projectId: "test-project" as UrlProjectId,
        title: "Queue history session",
        fullTitle: "Queue history session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: rawMessages.length,
        status: { state: "idle" },
        provider: "claude",
      },
      data: {
        provider: "claude",
        session: {
          messages: rawMessages,
        },
      } as UnifiedSession,
    };

    const normalized = normalizeSession(mockSession);
    const visibleUserMessages = normalized.messages
      .filter((message) => message.type === "user")
      .map((message) => message.message?.content);

    expect(visibleUserMessages).toEqual([
      "i want to test a session where i speak out of turn (while you're busy doing stuff). to that end please run a sleep 20 command (so you sleep for 20 seconds).",
      "i'm talking out of turn!",
      "saying a second thing out of turn",
      "saying a third thing out of turn",
      [
        {
          type: "tool_result",
          tool_use_id: "bash-sleep",
          content: "(Bash completed with no output)",
        },
      ],
    ]);

    expect(
      normalized.messages
        .filter((message) => message.deferred === true)
        .map((message) => message.message?.content),
    ).toEqual([
      "i'm talking out of turn!",
      "saying a second thing out of turn",
      "saying a third thing out of turn",
    ]);
  });
});

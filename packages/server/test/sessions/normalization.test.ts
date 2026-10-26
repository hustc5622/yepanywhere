import type {
  ClaudeSessionContent,
  ClaudeSessionEntry,
  CodexSessionContent,
  PiSessionContent,
  UnifiedSession,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  convertPiSession,
  normalizeSession,
} from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";

/** Minimal Pi session holding one user prompt (used by branch tests). */
function piUserSession(
  sessionId: string,
  messageId: string,
  timestamp: string,
  text: string,
): PiSessionContent {
  const entries: PiSessionContent["entries"] = [
    {
      type: "message",
      id: messageId,
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text }] },
    },
  ];
  return {
    header: { type: "session", id: sessionId, timestamp, cwd: "/tmp/project" },
    entries,
    activeEntries: entries,
  };
}

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

  it("defers Pi media and thinking while deriving summary data in one pass", () => {
    const piSession: PiSessionContent = {
      header: {
        type: "session",
        id: "session-pi-deferred",
        timestamp: "2026-08-18T00:00:00.000Z",
        cwd: "/tmp/project",
      },
      entries: [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-08-18T00:00:01.000Z",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Review this" },
              {
                type: "image",
                mimeType: "image/png",
                data: "a".repeat(256),
              },
            ],
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-08-18T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private reasoning" },
              { type: "text", text: "Done" },
              {
                type: "image",
                mimeType: "image/jpeg",
                data: "b".repeat(256),
              },
            ],
          },
        },
      ],
      activeEntries: [],
    };
    piSession.activeEntries = piSession.entries;

    const conversion = convertPiSession(piSession, {
      deferMedia: true,
      deferThinking: true,
    });
    expect(conversion.derived.messageCount).toBe(2);
    expect(conversion.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: "user-1",
          message: expect.objectContaining({
            content: [
              { type: "text", text: "Review this" },
              { type: "input_image", mime_type: "image/png", deferred: true },
            ],
          }),
        }),
        expect.objectContaining({
          uuid: "assistant-1",
          message: expect.objectContaining({
            content: [
              { type: "thinking", thinking: "private reasoning" },
              { type: "text", text: "Done" },
              { type: "image", mime_type: "image/jpeg", deferred: true },
            ],
          }),
        }),
      ]),
    );

    const normalized = normalizeSession(
      {
        summary: {
          id: "session-pi-deferred",
          projectId: "test-project" as UrlProjectId,
          title: "Pi images",
          fullTitle: "Pi images",
          createdAt: piSession.header.timestamp,
          updatedAt: "2026-08-18T00:00:02.000Z",
          messageCount: 2,
          status: { state: "idle" },
          provider: "pi",
        },
        data: { provider: "pi", session: piSession },
      },
      { deferMedia: true, deferThinking: true },
    );
    expect(JSON.stringify(normalized)).not.toContain("base64");
  });

  it("closes Pi tool calls abandoned by a broken assistant stream", () => {
    const piSession: PiSessionContent = {
      header: {
        type: "session",
        id: "session-pi-abandoned",
        timestamp: "2026-09-16T05:21:51.000Z",
        cwd: "/tmp/project",
      },
      entries: [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-09-16T05:21:51.000Z",
          message: { role: "user", content: "edit the changelog" },
        },
        {
          // Stream died before `message_stop`: the tool call is persisted with
          // empty arguments and never receives a result.
          type: "message",
          id: "assistant-broken",
          parentId: "user-1",
          timestamp: "2026-09-16T05:40:07.000Z",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "Anthropic stream ended before message_stop",
            content: [
              {
                type: "toolCall",
                id: "call-dead",
                name: "edit",
                arguments: {},
              },
            ],
          },
        },
        {
          type: "message",
          id: "assistant-retry",
          parentId: "assistant-broken",
          timestamp: "2026-09-16T05:40:45.000Z",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call-live",
                name: "edit",
                arguments: { path: "/tmp/project/a.md", edits: [] },
              },
            ],
          },
        },
        {
          type: "message",
          id: "result-live",
          parentId: "assistant-retry",
          timestamp: "2026-09-16T05:40:45.100Z",
          message: {
            role: "toolResult",
            toolCallId: "call-live",
            toolName: "edit",
            isError: false,
            content: [{ type: "text", text: "Successfully replaced" }],
          },
        },
      ],
      activeEntries: [],
    };
    piSession.activeEntries = piSession.entries;

    const { messages } = convertPiSession(piSession);
    const results = messages.filter(
      (message) => typeof message.tool_use_id === "string",
    );
    expect(results.map((message) => message.tool_use_id)).toEqual([
      "call-dead",
      "call-live",
    ]);
    const abandoned = results[0];
    expect(abandoned?.uuid).toBe("assistant-broken:abandoned-tool:call-dead");
    expect(abandoned?.message).toMatchObject({
      content: [{ type: "tool_result", is_error: true }],
    });
    // The synthetic result must sit right after the assistant message that
    // asked for the call, so the display timeline keeps its order.
    expect(messages.findIndex((m) => m.uuid === abandoned?.uuid)).toBe(
      messages.findIndex((m) => m.uuid === "assistant-broken") + 1,
    );
  });

  it("never synthesizes a Pi tool result that the log already carries", () => {
    const piSession: PiSessionContent = {
      header: {
        type: "session",
        id: "session-pi-aborted",
        timestamp: "2026-09-16T05:21:51.000Z",
        cwd: "/tmp/project",
      },
      entries: [
        {
          type: "message",
          id: "assistant-aborted",
          parentId: null,
          timestamp: "2026-09-16T05:41:00.000Z",
          message: {
            role: "assistant",
            stopReason: "aborted",
            content: [
              { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
            ],
          },
        },
        {
          type: "message",
          id: "result-1",
          parentId: "assistant-aborted",
          timestamp: "2026-09-16T05:41:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            isError: true,
            content: [{ type: "text", text: "aborted by user" }],
          },
        },
      ],
      activeEntries: [],
    };
    piSession.activeEntries = piSession.entries;

    const { messages } = convertPiSession(piSession);
    expect(
      messages.filter((message) => message.tool_use_id === "call-1"),
    ).toHaveLength(1);
  });

  it("annotates Pi user prompts with cross-session branch alternatives", () => {
    const createdAtMs = Date.UTC(2026, 7, 12, 12, 0, 0);
    const createdAtIso = new Date(createdAtMs).toISOString();
    const mockSession: LoadedSession = {
      summary: {
        id: "ses_parent",
        projectId: "test-project" as UrlProjectId,
        title: "Pi branch",
        fullTitle: "Pi branch",
        createdAt: createdAtIso,
        updatedAt: createdAtIso,
        messageCount: 2,
        status: { state: "idle" },
        provider: "pi",
      },
      branchState: {
        sessionId: "ses_parent",
        provider: "pi",
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
            createdAt: createdAtIso,
            provider: "pi",
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
            createdAt: new Date(createdAtMs + 400).toISOString(),
            provider: "pi",
          },
        ],
      },
      data: {
        provider: "pi",
        session: piUserSession("ses_parent", "u2", createdAtIso, "original"),
      },
    };

    const normalized = normalizeSession(mockSession);
    expect(normalized.branchState).toBe(mockSession.branchState);
    expect(normalized.messages[0]).toMatchObject({
      uuid: "u2",
      timestamp: createdAtIso,
      branch: {
        sessionId: "ses_parent",
        branchId: "u2",
        siblingCount: 2,
        alternatives: [
          expect.objectContaining({ id: "u2", sessionId: "ses_parent" }),
          expect.objectContaining({ id: "u2_edit", sessionId: "ses_child" }),
        ],
      },
    });
  });

  it("resolves a Pi copied prompt to the canonical option by timestamp and text", () => {
    const createdAtMs = Date.UTC(2026, 7, 12, 12, 0, 0);
    const createdAtIso = new Date(createdAtMs).toISOString();
    const mockSession: LoadedSession = {
      summary: {
        id: "ses_child",
        projectId: "test-project" as UrlProjectId,
        title: "Pi branch",
        fullTitle: "Pi branch",
        createdAt: createdAtIso,
        updatedAt: createdAtIso,
        messageCount: 1,
        status: { state: "idle" },
        provider: "pi",
      },
      branchState: {
        sessionId: "ses_child",
        provider: "pi",
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
            createdAt: createdAtIso,
            provider: "pi",
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
            provider: "pi",
          },
        ],
      },
      data: {
        provider: "pi",
        session: piUserSession(
          "ses_child",
          "u2_copy",
          createdAtIso,
          "original",
        ),
      },
    };

    const normalized = normalizeSession(mockSession);
    expect(normalized.messages[0]).toMatchObject({
      uuid: "u2_copy",
      branch: { sessionId: "ses_parent", branchId: "u2", siblingCount: 2 },
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

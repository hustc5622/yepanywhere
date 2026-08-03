import type {
  ClaudeSessionEntry,
  CodexSessionEntry,
  UnifiedSession,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  mergeJSONLMessages,
  mergeStreamMessage,
} from "../../client/src/lib/mergeMessages.ts";
import { preprocessMessages } from "../../client/src/lib/preprocessMessages.ts";
import type { Message as ClientMessage } from "../../client/src/types.ts";
import { CodexProvider } from "../src/sdk/providers/codex.js";
import { normalizeSession } from "../src/sessions/normalization.js";
import type { LoadedSession } from "../src/sessions/types.js";
import {
  assertRenderParity,
  normalizeRenderItemsForComparison,
  runPersistedPipeline,
  runStreamPipeline,
} from "./utils/render-parity-harness.ts";

type CodexProviderBridge = {
  convertItemToSDKMessages: (
    item: unknown,
    sessionId: string,
    turnId: string,
    sourceEvent: "item/started" | "item/completed",
  ) => Array<Record<string, unknown>>;
};

function buildLoadedCodexSession(entries: CodexSessionEntry[]): LoadedSession {
  return {
    summary: {
      id: "codex-render-parity",
      projectId: "test-project" as UrlProjectId,
      title: "Codex render parity",
      fullTitle: "Codex render parity",
      createdAt: "2026-03-05T12:00:00.000Z",
      updatedAt: "2026-03-05T12:00:10.000Z",
      messageCount: entries.length,
      status: "chat",
      provider: "codex",
    } as LoadedSession["summary"],
    data: {
      provider: "codex",
      events: [],
      session: { entries },
    } as UnifiedSession,
  };
}

function buildLoadedClaudeSession(
  messages: ClaudeSessionEntry[],
): LoadedSession {
  return {
    summary: {
      id: "claude-render-parity",
      projectId: "test-project" as UrlProjectId,
      title: "Claude render parity",
      fullTitle: "Claude render parity",
      createdAt: "2026-03-05T12:00:00.000Z",
      updatedAt: "2026-03-05T12:00:10.000Z",
      messageCount: messages.length,
      status: { state: "idle" },
      provider: "claude",
    } as LoadedSession["summary"],
    data: {
      provider: "claude",
      session: { messages },
    } as UnifiedSession,
  };
}

function normalizeClaudeMessages(
  messages: ClaudeSessionEntry[],
): ClientMessage[] {
  return normalizeSession(buildLoadedClaudeSession(messages)).messages;
}

function buildReplayMessages(
  messages: ClaudeSessionEntry[],
  indices: number[],
): ClientMessage[] {
  return indices.map((index) => ({
    ...(structuredClone(messages[index]) as unknown as ClientMessage),
    isReplay: true,
  }));
}

function runReconnectScenario(
  steps: Array<
    | { source: "jsonl"; messages: ClientMessage[] }
    | { source: "stream"; messages: ClientMessage[] }
  >,
) {
  let state: ClientMessage[] = [];

  for (const step of steps) {
    if (step.source === "jsonl") {
      state = mergeJSONLMessages(state, step.messages).messages;
      continue;
    }

    for (const message of step.messages) {
      state = mergeStreamMessage(state, message).messages;
    }
  }

  return normalizeRenderItemsForComparison(preprocessMessages(state));
}

const EDIT_DIFF = [
  "diff --git a/src/readme.md b/src/readme.md",
  "--- a/src/readme.md",
  "+++ b/src/readme.md",
  "@@ -1,1 +1,1 @@",
  "-# Old heading",
  "+# New heading",
].join("\n");

function codexPersistedEntries(): CodexSessionEntry[] {
  return [
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Check tools and summarize." }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:01.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-read",
        arguments: '{"cmd":"cat src/readme.md"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:02.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call-read",
        output: "# Old heading\nsecond line\n",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:03.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-grep",
        arguments: '{"command":"rg -n \\"needle\\" src -S"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:04.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call-grep",
        output:
          "Chunk ID: grep1\nWall time: 0.0100 seconds\nProcess exited with code 1\nOutput:\n\n",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:05.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-bash",
        arguments: '{"command":"echo done"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:06.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call-bash",
        output: "done\n",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-03-05T12:00:07.000Z",
      payload: {
        type: "patch_apply_end",
        call_id: "call-edit",
        turn_id: "turn-parity-1",
        stdout: "File changes applied:\nupdate: src/readme.md",
        stderr: "",
        success: true,
        status: "completed",
        changes: {
          "src/readme.md": {
            type: "update",
            unified_diff: EDIT_DIFF,
            move_path: null,
          },
        },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-03-05T12:00:09.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Summary:\n\n```ts\nconst x = 1;\n```" },
        ],
      },
    },
  ];
}

function codexStreamMessages(): Array<Record<string, unknown>> {
  const provider = new CodexProvider() as unknown as CodexProviderBridge;
  const sessionId = "codex-render-parity-stream";
  const turnId = "turn-parity-1";

  const messages: Array<Record<string, unknown>> = [
    {
      type: "user",
      session_id: sessionId,
      uuid: "codex-user-1",
      message: { role: "user", content: "Check tools and summarize." },
    },
  ];

  const streamItems = [
    {
      id: "call-read",
      type: "command_execution",
      command: "cat src/readme.md",
      aggregated_output: "# Old heading\nsecond line\n",
      exit_code: 0,
      status: "completed",
    },
    {
      id: "call-grep",
      type: "command_execution",
      command: 'rg -n "needle" src -S',
      aggregated_output: "",
      exit_code: 1,
      status: "completed",
    },
    {
      id: "call-bash",
      type: "command_execution",
      command: "echo done",
      aggregated_output: "done\n",
      exit_code: 0,
      status: "completed",
    },
    {
      id: "call-edit",
      type: "file_change",
      status: "completed",
      changes: [{ path: "src/readme.md", kind: "update", diff: EDIT_DIFF }],
    },
    {
      id: "agent-final",
      type: "agent_message",
      text: "Summary:\n\n```ts\nconst x = 1;\n```",
    },
  ];

  for (const item of streamItems) {
    messages.push(
      ...provider.convertItemToSDKMessages(
        item,
        sessionId,
        turnId,
        "item/completed",
      ),
    );
  }

  return messages;
}

const CLAUDE_FIXTURE: ClaudeSessionEntry[] = [
  {
    type: "user",
    uuid: "claude-user-1",
    parentUuid: null,
    message: { role: "user", content: "Read /tmp/test.md and report." },
  },
  {
    type: "assistant",
    uuid: "claude-assistant-1",
    parentUuid: "claude-user-1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll read it now." },
        {
          type: "tool_use",
          id: "claude-read-1",
          name: "Read",
          input: { file_path: "/tmp/test.md" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "claude-user-2",
    parentUuid: "claude-assistant-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "claude-read-1",
          content: "# hello\nsecond line\n",
        },
      ],
    },
    toolUseResult: {
      type: "text",
      file: {
        filePath: "/tmp/test.md",
        content: "# hello\nsecond line\n",
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    },
  },
  {
    type: "assistant",
    uuid: "claude-assistant-2",
    parentUuid: "claude-user-2",
    message: {
      role: "assistant",
      content: "Done.\n\n```md\n# hello\n```",
    },
  },
];

const CLAUDE_EDIT_CHAIN_FIXTURE: ClaudeSessionEntry[] = [
  {
    type: "user",
    uuid: "claude-edit-user-1",
    parentUuid: null,
    message: { role: "user", content: "Update the remote access docs." },
  },
  {
    type: "assistant",
    uuid: "claude-edit-1",
    parentUuid: "claude-edit-user-1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "claude-edit-tool-1",
          name: "Edit",
          input: {
            file_path: "/tmp/README.md",
            old_string: "Old README paragraph",
            new_string: "Updated README paragraph",
          },
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "claude-edit-2",
    parentUuid: "claude-edit-1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "claude-edit-tool-2",
          name: "Edit",
          input: {
            file_path: "/tmp/remote-access.md",
            old_string: "Old relay section",
            new_string: "Updated relay section",
          },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "claude-edit-result-1",
    parentUuid: "claude-edit-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "claude-edit-tool-1",
          content: "README updated successfully.",
        },
      ],
    },
    toolUseResult: {
      filePath: "/tmp/README.md",
      oldString: "Old README paragraph",
      newString: "Updated README paragraph",
      originalFile: "Old README paragraph",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-Old README paragraph", "+Updated README paragraph"],
        },
      ],
      userModified: false,
      replaceAll: false,
    },
  },
  {
    type: "user",
    uuid: "claude-edit-result-2",
    parentUuid: "claude-edit-2",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "claude-edit-tool-2",
          content: "Remote access doc updated successfully.",
        },
      ],
    },
    toolUseResult: {
      filePath: "/tmp/remote-access.md",
      oldString: "Old relay section",
      newString: "Updated relay section",
      originalFile: "Old relay section",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-Old relay section", "+Updated relay section"],
        },
      ],
      userModified: false,
      replaceAll: false,
    },
  },
  {
    type: "assistant",
    uuid: "claude-edit-final",
    parentUuid: "claude-edit-result-2",
    message: {
      role: "assistant",
      content: "Done. Updated both files.",
    },
  },
];

const CLAUDE_SESSION_2E582BFB_FIXTURE: ClaudeSessionEntry[] = [
  {
    type: "user",
    uuid: "e416e5ea-2d96-46eb-836a-e7e0f8c79f00",
    parentUuid: null,
    message: { role: "user", content: "test session abc 123" },
  },
  {
    type: "assistant",
    uuid: "8a1ddf40-3ab7-4520-b1ab-3c0bc3447028",
    parentUuid: "e416e5ea-2d96-46eb-836a-e7e0f8c79f00",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking:
            'The user said "test session abc 123" - this seems like a test message. I will respond simply.',
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "31163611-077b-489a-b12f-de7864927631",
    parentUuid: "e416e5ea-2d96-46eb-836a-e7e0f8c79f00",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Got it — looks like a test message. Everything's working. What can I help you with?",
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "5ab134ec-de5a-421e-a259-23ddc980b145",
    parentUuid: "31163611-077b-489a-b12f-de7864927631",
    message: { role: "user", content: "read claude.md" },
  },
  {
    type: "assistant",
    uuid: "85dfc3d9-26b0-4ca0-84ad-883b9e49a804",
    parentUuid: "5ab134ec-de5a-421e-a259-23ddc980b145",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "The user wants me to read the CLAUDE.md file.",
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "6f74c169-29ed-4c04-bc47-ed14a8e67259",
    parentUuid: "5ab134ec-de5a-421e-a259-23ddc980b145",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01F85BCXN9KXiBR8uZJzVKCe",
          name: "Read",
          input: { file_path: "/Users/kgraehl/code/yepanywhere/CLAUDE.md" },
          caller: { type: "direct" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "f03026c2-5ee3-46fc-92d6-610d110de974",
    parentUuid: "6f74c169-29ed-4c04-bc47-ed14a8e67259",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01F85BCXN9KXiBR8uZJzVKCe",
          content:
            "     1→# Yep Anywhere\n     2→...\n   328→- **Type discrimination**: Use `type` field (user/assistant/system/summary)\n",
        },
      ],
    },
    toolUseResult: {
      type: "text",
      file: {
        filePath: "/Users/kgraehl/code/yepanywhere/CLAUDE.md",
        content:
          "# Yep Anywhere\n...\n- **Type discrimination**: Use `type` field (user/assistant/system/summary)\n",
        numLines: 328,
        startLine: 1,
        totalLines: 328,
      },
    },
  },
  {
    type: "assistant",
    uuid: "a8eee3db-83a3-4907-9ba8-1634ab489abc",
    parentUuid: "f03026c2-5ee3-46fc-92d6-610d110de974",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "There it is — the full `CLAUDE.md` for Yep Anywhere (328 lines). It covers:\n\n- **Project overview** — mobile-first Claude Code supervisor\n- **Architecture** — Hono server + React client + WebSocket",
        },
      ],
    },
  },
];

const CLAUDE_QUEUE_HISTORY_FIXTURE: ClaudeSessionEntry[] = [
  {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-03-28T12:12:01.573Z",
    sessionId: "9269d1e3-2bcf-4b90-b287-a4bd43981baa",
    content:
      "i want to test a session where i speak out of turn (while you're busy doing stuff). to that end please run a sleep 20 command (so you sleep for 20 seconds).",
  },
  {
    type: "queue-operation",
    operation: "dequeue",
    timestamp: "2026-03-28T12:12:01.575Z",
    sessionId: "9269d1e3-2bcf-4b90-b287-a4bd43981baa",
  },
  {
    type: "user",
    uuid: "dc898006-83a5-499b-8a75-5d9a0f68edf7",
    parentUuid: null,
    message: {
      role: "user",
      content:
        "i want to test a session where i speak out of turn (while you're busy doing stuff). to that end please run a sleep 20 command (so you sleep for 20 seconds).",
    },
  },
  {
    type: "assistant",
    uuid: "c7ad881f-9db6-4667-b94b-278de0bcbccf",
    parentUuid: "dc898006-83a5-499b-8a75-5d9a0f68edf7",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01AZiGYyNYXrGVAiThf1DGGA",
          name: "Bash",
          input: {
            command: "sleep 20",
            description: "Sleep for 20 seconds",
            timeout: 30000,
          },
          caller: { type: "direct" },
        },
      ],
    },
  },
  {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-03-28T12:12:10.002Z",
    sessionId: "9269d1e3-2bcf-4b90-b287-a4bd43981baa",
    content: "i'm talking out of turn!",
  },
  {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-03-28T12:12:14.115Z",
    sessionId: "9269d1e3-2bcf-4b90-b287-a4bd43981baa",
    content: "saying a second thing out of turn",
  },
  {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-03-28T12:12:17.757Z",
    sessionId: "9269d1e3-2bcf-4b90-b287-a4bd43981baa",
    content: "saying a third thing out of turn",
  },
  {
    type: "user",
    uuid: "a53067e7-43e7-402a-a722-6db37fbde377",
    parentUuid: "c7ad881f-9db6-4667-b94b-278de0bcbccf",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01AZiGYyNYXrGVAiThf1DGGA",
          content: "(Bash completed with no output)",
          is_error: false,
        },
      ],
    },
    toolUseResult: {
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    },
  },
  {
    type: "queue-operation",
    operation: "remove",
    timestamp: "2026-03-28T12:12:27.772Z",
    sessionId: "9269d1e3-2bcf-4b90-b287-a4bd43981baa",
  },
  {
    type: "queue-operation",
    operation: "remove",
    timestamp: "2026-03-28T12:12:27.772Z",
    sessionId: "9269d1e3-2bcf-4b90-b287-a4bd43981baa",
  },
  {
    type: "queue-operation",
    operation: "remove",
    timestamp: "2026-03-28T12:12:27.772Z",
    sessionId: "9269d1e3-2bcf-4b90-b287-a4bd43981baa",
  },
  {
    type: "assistant",
    uuid: "0c6a9d84-9d56-4e04-b83c-37b942bb7978",
    parentUuid: "a53067e7-43e7-402a-a722-6db37fbde377",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Done sleeping. I see you sent three messages while I was busy:\n\n1. "i\'m talking out of turn!"\n2. "saying a second thing out of turn"\n3. "saying a third thing out of turn"\n\nAll received. How did the out-of-turn experience look on your end?',
        },
      ],
    },
  },
];

describe("Render Parity Harness", () => {
  it("keeps Codex stream and persisted rendering equivalent", async () => {
    const persisted = await runPersistedPipeline(
      buildLoadedCodexSession(codexPersistedEntries()),
    );
    const stream = await runStreamPipeline(codexStreamMessages());

    assertRenderParity("codex", persisted.renderItems, stream.renderItems);

    const comparable = normalizeRenderItemsForComparison(
      persisted.renderItems,
    ) as Array<Record<string, unknown>>;
    const toolCalls = comparable.filter(
      (item) => item.type === "tool_call",
    ) as Array<Record<string, unknown>>;

    expect(toolCalls.map((call) => call.toolName)).toEqual([
      "Read",
      "Grep",
      "Bash",
      "Edit",
    ]);
    expect(toolCalls[0]?.toolResult).toMatchObject({
      isError: false,
      structured: {
        type: "text",
        file: {
          filePath: "src/readme.md",
        },
      },
    });
    expect(toolCalls[1]?.toolResult).toMatchObject({
      isError: false,
      structured: { mode: "files_with_matches", numFiles: 0 },
    });
    expect(
      comparable.some(
        (item) => item.type === "text" && item.hasAugmentHtml === true,
      ),
    ).toBe(true);
  });

  it("keeps Claude stream and persisted rendering equivalent", async () => {
    const persisted = await runPersistedPipeline(
      buildLoadedClaudeSession(CLAUDE_FIXTURE),
    );
    const stream = await runStreamPipeline(
      CLAUDE_FIXTURE as unknown as Array<Record<string, unknown>>,
    );

    assertRenderParity("claude", persisted.renderItems, stream.renderItems);

    const comparable = normalizeRenderItemsForComparison(
      persisted.renderItems,
    ) as Array<Record<string, unknown>>;
    const readCall = comparable.find(
      (item) =>
        item.type === "tool_call" &&
        item.toolName === "Read" &&
        item.status === "complete",
    ) as Record<string, unknown> | undefined;

    expect(readCall).toBeDefined();
    expect(readCall?.toolResult).toMatchObject({
      isError: false,
      structured: {
        type: "text",
        file: {
          filePath: "/tmp/test.md",
          numLines: 2,
        },
      },
    });
    expect(
      comparable.some(
        (item) => item.type === "text" && item.hasAugmentHtml === true,
      ),
    ).toBe(true);
  });

  it("keeps chained Claude Edit branches visible after persisted reload", async () => {
    const persisted = await runPersistedPipeline(
      buildLoadedClaudeSession(CLAUDE_EDIT_CHAIN_FIXTURE),
    );
    const stream = await runStreamPipeline(
      CLAUDE_EDIT_CHAIN_FIXTURE as unknown as Array<Record<string, unknown>>,
    );

    assertRenderParity(
      "claude-edit-chain",
      persisted.renderItems,
      stream.renderItems,
    );

    const comparable = normalizeRenderItemsForComparison(
      persisted.renderItems,
    ) as Array<Record<string, unknown>>;
    const editCalls = comparable.filter(
      (item) => item.type === "tool_call" && item.toolName === "Edit",
    );

    expect(editCalls).toHaveLength(2);
  });

  it("renders session 2e582bfb in stable persisted order", async () => {
    const persisted = await runPersistedPipeline(
      buildLoadedClaudeSession(CLAUDE_SESSION_2E582BFB_FIXTURE),
    );

    const comparable = normalizeRenderItemsForComparison(
      persisted.renderItems,
    ) as Array<Record<string, unknown>>;

    expect(
      comparable.map((item) =>
        item.type === "tool_call"
          ? `${item.type}:${item.toolName}:${item.status}`
          : String(item.type),
      ),
    ).toEqual([
      "user_prompt",
      "text",
      "user_prompt",
      "tool_call:Read:complete",
      "text",
    ]);

    expect(comparable[0]).toMatchObject({
      type: "user_prompt",
      content: "test session abc 123",
    });
    expect(comparable[1]).toMatchObject({
      type: "text",
      text: "Got it — looks like a test message. Everything's working. What can I help you with?",
    });
    expect(comparable[2]).toMatchObject({
      type: "user_prompt",
      content: "read claude.md",
    });
    expect(comparable[3]).toMatchObject({
      type: "tool_call",
      toolName: "Read",
      status: "complete",
      toolResult: {
        isError: false,
        structured: {
          type: "text",
          file: {
            filePath: "/Users/kgraehl/code/yepanywhere/CLAUDE.md",
            numLines: 328,
          },
        },
      },
    });
    expect(comparable[4]).toMatchObject({
      type: "text",
      text: "There it is — the full `CLAUDE.md` for Yep Anywhere (328 lines). It covers:\n\n- **Project overview** — mobile-first Claude Code supervisor\n- **Architecture** — Hono server + React client + WebSocket",
    });
  });

  it("keeps reconnect replay order convergent for session 2e582bfb", () => {
    const authoritativeMessages = normalizeClaudeMessages(
      CLAUDE_SESSION_2E582BFB_FIXTURE,
    );
    const expected = normalizeRenderItemsForComparison(
      preprocessMessages(authoritativeMessages),
    );

    const replayOutOfOrder = buildReplayMessages(
      CLAUDE_SESSION_2E582BFB_FIXTURE,
      [1, 2, 0, 5, 7, 6, 3, 4],
    );
    const replaySecondTurnFirst = buildReplayMessages(
      CLAUDE_SESSION_2E582BFB_FIXTURE,
      [4, 5, 6, 7, 1, 2],
    );

    const firstTurnJsonl = authoritativeMessages.slice(0, 2);
    const secondTurnJsonl = authoritativeMessages.slice(2);

    const scenarios = [
      runReconnectScenario([
        { source: "stream", messages: replayOutOfOrder },
        { source: "jsonl", messages: authoritativeMessages },
      ]),
      runReconnectScenario([
        { source: "jsonl", messages: authoritativeMessages },
        { source: "stream", messages: replayOutOfOrder },
        { source: "jsonl", messages: authoritativeMessages },
      ]),
      runReconnectScenario([
        { source: "jsonl", messages: firstTurnJsonl },
        { source: "stream", messages: replaySecondTurnFirst },
        { source: "jsonl", messages: secondTurnJsonl },
        {
          source: "stream",
          messages: buildReplayMessages(
            CLAUDE_SESSION_2E582BFB_FIXTURE,
            [1, 2],
          ),
        },
      ]),
    ];

    for (const scenario of scenarios) {
      expect(scenario).toEqual(expected);
    }
  });

  it("renders removed queued Claude prompts during persisted load", async () => {
    const persisted = await runPersistedPipeline(
      buildLoadedClaudeSession(CLAUDE_QUEUE_HISTORY_FIXTURE),
    );

    const comparable = normalizeRenderItemsForComparison(
      persisted.renderItems,
    ) as Array<Record<string, unknown>>;

    expect(
      comparable.map((item) =>
        item.type === "tool_call"
          ? `${item.type}:${item.toolName}:${item.status}`
          : String(item.type),
      ),
    ).toEqual([
      "user_prompt",
      "tool_call:Bash:complete",
      "user_prompt",
      "user_prompt",
      "user_prompt",
      "text",
    ]);

    expect(comparable[2]).toMatchObject({
      type: "user_prompt",
      content: "i'm talking out of turn!",
    });
    expect(comparable[3]).toMatchObject({
      type: "user_prompt",
      content: "saying a second thing out of turn",
    });
    expect(comparable[4]).toMatchObject({
      type: "user_prompt",
      content: "saying a third thing out of turn",
    });
  });
});

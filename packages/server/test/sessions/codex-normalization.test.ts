import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexBranchState, CodexSessionEntry } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { preprocessMessages } from "../../../client/src/lib/preprocessMessages.ts";
import { publicCodexFileChangePath } from "../../src/codex/path-projection.js";
import {
  buildCodexBranchView,
  computeCodexRollbackNumTurns,
} from "../../src/sessions/codex-rollback.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildLoadedSession(
  entries: CodexSessionEntry[],
  codexBranchState?: CodexBranchState,
): LoadedSession {
  return {
    summary: {
      id: "test-session",
      projectId: "test-project",
      title: "Test Session",
      fullTitle: "Test Session",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:02Z",
      messageCount: entries.length,
      status: "chat",
      provider: "codex-oss",
      // biome-ignore lint/suspicious/noExplicitAny: mock summary shape
    } as any,
    data: {
      provider: "codex-oss",
      events: [],
      session: {
        entries,
      },
      // biome-ignore lint/suspicious/noExplicitAny: mock session shape
    } as any,
    codexBranchState,
  };
}

function loadCodexFixtureEntries(name: string): CodexSessionEntry[] {
  const fixturePath = join(
    __dirname,
    "..",
    "fixtures",
    "codex",
    `${name}.jsonl`,
  );
  const content = readFileSync(fixturePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CodexSessionEntry);
}

function codexUserMessage(text: string, second: number): CodexSessionEntry {
  return {
    type: "response_item",
    timestamp: `2024-01-01T00:00:${String(second).padStart(2, "0")}Z`,
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

function codexTurnAbortedPseudoUser(second: number): CodexSessionEntry {
  return codexUserMessage(
    "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
    second,
  );
}

function codexTurnAbortedEvent(second: number): CodexSessionEntry {
  return {
    type: "event_msg",
    timestamp: `2024-01-01T00:00:${String(second).padStart(2, "0")}Z`,
    payload: {
      type: "turn_aborted",
      reason:
        "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
    },
  };
}

function codexAssistantMessage(
  text: string,
  second: number,
  phase?: "commentary" | "final_answer",
): CodexSessionEntry {
  return {
    type: "response_item",
    timestamp: `2024-01-01T00:00:${String(second).padStart(2, "0")}Z`,
    payload: {
      type: "message",
      role: "assistant",
      ...(phase ? { phase } : {}),
      content: [{ type: "output_text", text }],
    },
  };
}

function codexTokenCount(
  inputTokens: number,
  second: number,
  options: {
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    modelContextWindow?: number;
  } = {},
): CodexSessionEntry {
  const outputTokens = options.outputTokens ?? 100;
  const cachedInputTokens = options.cachedInputTokens ?? 0;
  const totalTokens = options.totalTokens ?? inputTokens + outputTokens;
  const usage = {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };

  return {
    type: "event_msg",
    timestamp: `2024-01-01T00:00:${String(second).padStart(2, "0")}Z`,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage,
        last_token_usage: usage,
        model_context_window: options.modelContextWindow ?? 258_000,
      },
      rate_limits: null,
    },
  };
}

function codexRollbackMarker(
  numTurns: number,
  second: number,
): CodexSessionEntry {
  return {
    type: "event_msg",
    timestamp: `2024-01-01T00:00:${String(second).padStart(2, "0")}Z`,
    payload: {
      type: "thread_rolled_back",
      num_turns: numTurns,
    },
  };
}

function firstMessageText(message: {
  message?: { content?: unknown };
}): string | undefined {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  const block = Array.isArray(content) ? content[0] : content;
  if (block && typeof block === "object" && "text" in block) {
    return String(block.text);
  }
  return undefined;
}

function firstEntryText(entry: CodexSessionEntry): string | undefined {
  if (entry.type !== "response_item" || entry.payload.type !== "message") {
    return undefined;
  }
  const block = entry.payload.content[0];
  return block && "text" in block ? block.text : undefined;
}

describe("Codex Normalization", () => {
  it("normalizes a codex session as a flat list without parentUuid", () => {
    // 1. User message (event_msg) - will be deduped because of item #3
    // 2. Assistant message (response_item)
    // 3. User message (response_item)
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi there" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "user_message",
          message: "How are you?",
        },
      },
      // Duplicate user message event (should be deduped/shadowed by response_item)
      // Actually, we want to test that if a response_item exists, event_msgs are ignored.
      // So we add a response_item for the user message.
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "How are you?" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    // Expecting 2 messages because the first event_msg is deduped
    expect(result.messages).toHaveLength(2);

    // Check that parentUuid is undefined for all messages
    // Check that parentUuid is undefined for all messages
    for (const msg of result.messages) {
      expect(msg.parentUuid).toBeUndefined();
    }

    // Check content
    // Message 0: Assistant "Hi there"
    const msg0 = result.messages[0];
    const content0 = msg0.message?.content;
    expect(Array.isArray(content0) ? content0[0] : content0).toEqual({
      type: "text",
      text: "Hi there",
    });

    // Message 1: User "How are you?"
    const msg1 = result.messages[1];
    const content1 = msg1.message?.content;
    expect(Array.isArray(content1) ? content1[0] : content1).toEqual({
      type: "text",
      text: "How are you?",
    });
  });

  it("annotates codex user messages with turn context usage snapshots", () => {
    const entries: CodexSessionEntry[] = [
      codexUserMessage("Beijing weather", 1),
      codexAssistantMessage("Beijing is sunny", 2),
      codexTokenCount(10_000, 3),
      codexUserMessage("Wuhan weather", 4),
      codexAssistantMessage("Wuhan is cloudy", 5),
      codexTokenCount(20_100, 6),
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const users = result.messages.filter((message) => message.type === "user");

    expect(users).toHaveLength(2);
    expect(users[0]?.contextBefore).toMatchObject({
      inputTokens: 10_000,
      percentage: 4,
      contextWindow: 258_000,
    });
    expect(users[1]?.contextBefore).toMatchObject({
      inputTokens: 20_100,
      percentage: 8,
      contextWindow: 258_000,
    });
  });

  it("keeps Codex turn context usage on the prompt instead of tool results", () => {
    const entries: CodexSessionEntry[] = [
      codexUserMessage("Use pwd", 1),
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-1",
          arguments: '{"command":"pwd"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "/tmp/project",
        },
      },
      codexAssistantMessage("Done", 4),
      codexTokenCount(12_345, 5),
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const prompt = result.messages.find(
      (message) => firstMessageText(message) === "Use pwd",
    );
    const toolResult = result.messages.find((message) => {
      const content = message.message?.content;
      return (
        Array.isArray(content) &&
        content.some(
          (block) =>
            block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "tool_result",
        )
      );
    });

    expect(prompt?.contextBefore?.inputTokens).toBe(12_345);
    expect(toolResult?.contextBefore).toBeUndefined();
  });

  it("does not let post-compaction token counts overwrite the previous user snapshot", () => {
    const entries: CodexSessionEntry[] = [
      codexUserMessage("pre-compact prompt", 1),
      codexAssistantMessage("pre-compact answer", 2),
      codexTokenCount(227_243, 3),
      {
        type: "compacted",
        timestamp: "2024-01-01T00:00:04Z",
        payload: {
          message: "Context compacted",
          replacement_history: [],
        },
      },
      codexTokenCount(0, 5, {
        outputTokens: 0,
        totalTokens: 7_945,
      }),
      codexUserMessage("post-compact prompt", 6),
      codexAssistantMessage("post-compact answer", 7),
      codexTokenCount(9_500, 8),
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const users = result.messages.filter((message) => message.type === "user");

    expect(users).toHaveLength(2);
    expect(users[0]?.contextBefore?.inputTokens).toBe(227_243);
    expect(users[1]?.contextBefore?.inputTokens).toBe(9_500);
  });

  it("preserves Codex assistant message phase metadata", () => {
    const entries: CodexSessionEntry[] = [
      codexUserMessage("Do the thing", 1),
      codexAssistantMessage("I am checking the repo.", 2, "commentary"),
      codexAssistantMessage("Done.", 3, "final_answer"),
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages[1]).toMatchObject({
      type: "assistant",
      codexMessagePhase: "commentary",
    });
    expect(result.messages[2]).toMatchObject({
      type: "assistant",
      codexMessagePhase: "final_answer",
    });
  });

  it("preserves the native Codex item identity for live/disk reconciliation", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          id: "msg-native-1",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking the repository." }],
          internal_chat_message_metadata_passthrough: {
            turn_id: "turn-native-1",
          },
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages).toEqual([
      expect.objectContaining({
        codexTurnId: "turn-native-1",
        codexCorrelationKey: "codex:turn-native-1:agent-message:msg-native-1",
      }),
    ]);
  });

  it("projects persisted user client identity onto the owning response item", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-08-27T09:31:11.130Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "# AGENTS.md instructions for /repo" },
          ],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-27T09:31:11.197Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect the screenshot" },
            {
              type: "input_text",
              text: '<image name=[Image #1] path="/tmp/screenshot.png">',
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA==",
            },
            { type: "input_text", text: "</image>" },
          ],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-27T09:31:11.198Z",
        payload: {
          type: "user_message",
          client_id: "client-message-1",
          message: "Inspect the screenshot",
          images: [],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const prompt = result.messages.find(
      (message) => message.clientUserMessageId === "client-message-1",
    );

    expect(prompt).toMatchObject({
      type: "user",
      clientUserMessageId: "client-message-1",
      codexCorrelationKey: "codex:user-message:client-message-1",
    });
    expect(prompt?.uuid).not.toBe("client-message-1");
    expect(
      result.messages.find((message) =>
        firstMessageText(message)?.startsWith("# AGENTS.md instructions"),
      ),
    ).not.toHaveProperty("clientUserMessageId");
  });

  it("applies Codex thread_rolled_back markers before normalizing", () => {
    const entries: CodexSessionEntry[] = [
      codexUserMessage("q1", 1),
      codexAssistantMessage("a1", 2),
      codexUserMessage("q2", 3),
      codexAssistantMessage("a2", 4),
      codexUserMessage("q3", 5),
      codexAssistantMessage("a3", 6),
      codexRollbackMarker(2, 7),
      codexUserMessage("q2-1", 8),
      codexAssistantMessage("a2-1", 9),
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages.map(firstMessageText)).toEqual([
      "q1",
      "a1",
      "q2-1",
      "a2-1",
    ]);
    expect(result.messages.map(firstMessageText)).not.toContain("q2");
    expect(result.messages.map(firstMessageText)).not.toContain("q3");
  });

  it("can project an older Codex rollback branch", () => {
    const entries: CodexSessionEntry[] = [
      codexUserMessage("q1", 1),
      codexAssistantMessage("a1", 2),
      codexUserMessage("q2", 3),
      codexAssistantMessage("a2", 4),
      codexUserMessage("q3", 5),
      codexAssistantMessage("a3", 6),
      codexRollbackMarker(2, 7),
      codexUserMessage("q2-1", 8),
      codexAssistantMessage("a2-1", 9),
    ];

    const activeView = buildCodexBranchView(entries, "test-session");
    expect(activeView.entries.map(firstEntryText)).toEqual([
      "q1",
      "a1",
      "q2-1",
      "a2-1",
    ]);

    const oldQ2Branch = activeView.branchState.branches.find(
      (branch) => branch.prompt === "q2",
    );
    expect(oldQ2Branch?.siblingCount).toBe(2);

    const oldView = buildCodexBranchView(
      entries,
      "test-session",
      oldQ2Branch?.id,
    );
    expect(oldView.entries.map(firstEntryText)).toEqual([
      "q1",
      "a1",
      "q2",
      "a2",
      "q3",
      "a3",
    ]);
  });

  it("annotates Codex user prompts with sibling branch choices", () => {
    const entries: CodexSessionEntry[] = [
      codexUserMessage("q1", 1),
      codexAssistantMessage("a1", 2),
      codexUserMessage("q2", 3),
      codexAssistantMessage("a2", 4),
      codexRollbackMarker(1, 5),
      codexUserMessage("q2-1", 6),
      codexAssistantMessage("a2-1", 7),
    ];
    const branchView = buildCodexBranchView(entries, "test-session");
    const result = normalizeSession(
      buildLoadedSession(branchView.entries, branchView.branchState),
    );
    const editedPrompt = result.messages.find(
      (message) => firstMessageText(message) === "q2-1",
    );

    expect(editedPrompt?.codexBranch).toMatchObject({
      sessionId: "test-session",
      branchId: "codex-branch-5",
      siblingCount: 2,
    });
    expect(
      editedPrompt?.codexBranch?.alternatives.map((branch) => branch.prompt),
    ).toEqual(["q2", "q2-1"]);
  });

  it("does not expose synthetic user messages as prompts or branches", () => {
    const entries: CodexSessionEntry[] = [
      codexUserMessage("q1", 1),
      codexAssistantMessage("a1", 2),
      codexUserMessage("<skill>\n<name>git-commit-push</name>\n</skill>", 3),
      codexTurnAbortedPseudoUser(4),
      codexTurnAbortedEvent(5),
      codexUserMessage("q2", 6),
      codexAssistantMessage("a2", 7),
    ];

    const branchView = buildCodexBranchView(entries, "test-session");
    expect(
      branchView.branchState.branches.map((branch) => branch.prompt),
    ).toEqual(["q1", "q2"]);
    expect(branchView.entries.map(firstEntryText).filter(Boolean)).toEqual([
      "q1",
      "a1",
      "q2",
      "a2",
    ]);

    const result = normalizeSession(
      buildLoadedSession(branchView.entries, branchView.branchState),
    );
    const visibleText = result.messages.map((message) =>
      message.type === "system" ? message.content : firstMessageText(message),
    );

    expect(JSON.stringify(result.messages)).not.toContain("<turn_aborted>");
    expect(JSON.stringify(result.messages)).not.toContain("<skill>");
    expect(visibleText).toEqual([
      "q1",
      "a1",
      "Conversation stopped by user",
      "q2",
      "a2",
    ]);
  });

  it("normalizes function_call_output into user tool_result blocks", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-1",
          arguments: '{"command":"npm test"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Exit code: 0",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseMessage = result.messages[0];
    const toolResultMessage = result.messages[1];
    const toolUseContent = toolUseMessage?.message?.content;
    const toolResultContent = toolResultMessage?.message?.content;

    expect(
      Array.isArray(toolUseContent) ? toolUseContent[0] : toolUseContent,
    ).toMatchObject({
      type: "tool_use",
      id: "call-1",
      name: "Bash",
    });
    expect(toolResultMessage?.type).toBe("user");
    expect(
      Array.isArray(toolResultContent)
        ? toolResultContent[0]
        : toolResultContent,
    ).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-1",
      content: "Exit code: 0",
    });
  });

  it("normalizes completed Codex web_search_call into a completed tool row", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "weather: Shanghai",
            queries: ["weather: Shanghai"],
          },
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    expect(normalized.messages).toHaveLength(2);

    const renderItems = preprocessMessages(normalized.messages);
    const webSearchItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "WebSearch",
    );

    expect(webSearchItem?.type).toBe("tool_call");
    if (webSearchItem?.type !== "tool_call") {
      throw new Error("Expected WebSearch render item");
    }

    expect(webSearchItem.status).toBe("complete");
    expect(webSearchItem.toolInput).toMatchObject({
      query: "weather: Shanghai",
      action: {
        type: "search",
        query: "weather: Shanghai",
      },
    });
    expect(webSearchItem.toolResult?.structured).toMatchObject({
      query: "weather: Shanghai",
      results: [],
      codexActionLabel: "Search: weather: Shanghai",
    });
  });

  it("normalizes a Codex web.run function_call into a WebSearch row with a derived action", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "run",
          namespace: "web",
          call_id: "call-web-run",
          arguments: JSON.stringify({
            search_query: [{ q: "bilibili video downloader" }],
            response_length: "long",
          }),
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));

    const renderItems = preprocessMessages(normalized.messages);
    const webSearchItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "WebSearch",
    );

    expect(webSearchItem?.type).toBe("tool_call");
    if (webSearchItem?.type !== "tool_call") {
      throw new Error("Expected WebSearch render item");
    }

    expect(webSearchItem.toolName).toBe("WebSearch");
    expect(webSearchItem.toolInput).toMatchObject({
      query: "bilibili video downloader",
      action: {
        type: "search",
        query: "bilibili video downloader",
      },
    });
  });

  it("derives find_in_page action for a Codex web.run function_call", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "run",
          namespace: "web",
          call_id: "call-web-find",
          arguments: JSON.stringify({
            find: [{ ref_id: "turn2view2", pattern: "--cookies-from-browser" }],
          }),
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const webSearchItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "WebSearch",
    );

    if (webSearchItem?.type !== "tool_call") {
      throw new Error("Expected WebSearch render item");
    }
    expect(webSearchItem.toolInput).toMatchObject({
      action: {
        type: "find_in_page",
        pattern: "--cookies-from-browser",
      },
    });
  });

  it("normalizes persisted Codex imageGeneration into a completed ViewImage row", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "imageGeneration",
          id: "img-1",
          status: "completed",
          revisedPrompt: "A quiet product screenshot",
          result: "file:///tmp/generated-product.png",
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    expect(normalized.messages).toHaveLength(2);

    const renderItems = preprocessMessages(normalized.messages);
    const imageItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "ViewImage",
    );

    expect(imageItem?.type).toBe("tool_call");
    if (imageItem?.type !== "tool_call") {
      throw new Error("Expected ViewImage render item");
    }

    expect(imageItem.status).toBe("complete");
    expect(imageItem.toolInput).toMatchObject({
      path: "/tmp/generated-product.png",
      revised_prompt: "A quiet product screenshot",
      status: "completed",
      title: "Generated image",
    });
    expect(imageItem.toolResult?.content).toBe(
      "Generated image: /tmp/generated-product.png",
    );
    expect(imageItem.toolResult?.structured).toMatchObject({
      type: "image",
      path: "/tmp/generated-product.png",
    });
  });

  it("normalizes Codex item_completed imageGeneration events when no response_item exists", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "item_completed",
          item: {
            type: "imageGeneration",
            id: "img-event-1",
            status: "completed",
            savedPath: "/tmp/event-generated.png",
            result: "Image saved",
          },
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const imageItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "ViewImage",
    );

    expect(imageItem?.type).toBe("tool_call");
    if (imageItem?.type !== "tool_call") {
      throw new Error("Expected ViewImage render item");
    }

    expect(imageItem.status).toBe("complete");
    expect(imageItem.id).toBe("img-event-1");
    expect(imageItem.toolInput).toMatchObject({
      path: "/tmp/event-generated.png",
    });
  });

  it("normalizes Codex image_generation_end events and skips duplicate image_generation_call rows", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "image_generation_end",
          status: "generating",
          revised_prompt: "A generated preview",
          result: "iVBORw0KGgoAAAANSUhEUgAA",
          saved_path:
            "/Users/test/.codex/generated_images/session-1/ig_123.png",
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "image_generation_call",
          id: "ig_123",
          status: "generating",
          revised_prompt: "A generated preview",
          result: "iVBORw0KGgoAAAANSUhEUgAA",
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const imageItems = renderItems.filter(
      (item) => item.type === "tool_call" && item.toolName === "ViewImage",
    );

    expect(imageItems).toHaveLength(1);
    const imageItem = imageItems[0];
    expect(imageItem?.type).toBe("tool_call");
    if (imageItem?.type !== "tool_call") {
      throw new Error("Expected ViewImage render item");
    }

    expect(imageItem.toolInput).toMatchObject({
      path: "/Users/test/.codex/generated_images/session-1/ig_123.png",
      revised_prompt: "A generated preview",
      status: "generating",
      title: "Generated image",
    });
    expect(imageItem.toolResult?.content).toBe(
      "Generated image: /Users/test/.codex/generated_images/session-1/ig_123.png",
    );
  });

  it("keeps distinct image_generation_call rows when an end event exists", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "image_generation_end",
          id: "ig_123",
          status: "completed",
          result: "iVBORw0KGgoAAAANSUhEUgAA",
          saved_path:
            "/Users/test/.codex/generated_images/session-1/ig_123.png",
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "image_generation_call",
          id: "ig_456",
          status: "completed",
          result: "iVBORw0KGgoAAAANSUhEUgBB",
          saved_path:
            "/Users/test/.codex/generated_images/session-1/ig_456.png",
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const imageItems = renderItems.filter(
      (item) => item.type === "tool_call" && item.toolName === "ViewImage",
    );

    expect(imageItems).toHaveLength(2);
  });

  it("projects Codex external agent Read markers into a completed tool row", () => {
    const entries: CodexSessionEntry[] = [
      codexAssistantMessage(
        "[external_agent_tool_call: Read]\nfile: CLAUDE.md\n[/external_agent_tool_call]",
        1,
      ),
      codexAssistantMessage(
        "[external_agent_tool_result]\n220\tfirst line\n221\tsecond line\n[/external_agent_tool_result]",
        2,
      ),
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const readItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "Read",
    );

    expect(readItem?.type).toBe("tool_call");
    if (readItem?.type !== "tool_call") {
      throw new Error("Expected Read render item");
    }

    expect(readItem.status).toBe("complete");
    expect(readItem.toolInput).toMatchObject({
      file_path: "CLAUDE.md",
    });
    expect(readItem.toolResult?.structured).toMatchObject({
      type: "text",
      file: {
        filePath: "CLAUDE.md",
        content: "first line\nsecond line",
        numLines: 2,
        startLine: 220,
        totalLines: 221,
      },
    });
  });

  it("projects Codex external agent JSON tool results into the matching tool row", () => {
    const entries: CodexSessionEntry[] = [
      codexAssistantMessage(
        "[external_agent_tool_call: TaskCreate]\ndescription: 汇总风险点与回归关注\n[/external_agent_tool_call]",
        1,
      ),
      codexAssistantMessage(
        '[external_agent_tool_result]\n{"task":{"id":"8","subject":"汇总风险点与回归关注"}}\n[/external_agent_tool_result]',
        2,
      ),
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const taskItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "TaskCreate",
    );

    expect(taskItem?.type).toBe("tool_call");
    if (taskItem?.type !== "tool_call") {
      throw new Error("Expected TaskCreate render item");
    }

    expect(taskItem.status).toBe("complete");
    expect(taskItem.toolInput).toMatchObject({
      description: "汇总风险点与回归关注",
    });
    expect(taskItem.toolResult?.structured).toMatchObject({
      task: {
        id: "8",
        subject: "汇总风险点与回归关注",
      },
    });
  });

  it("normalizes exec_command input.cmd into Bash input.command", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-exec",
          name: "exec_command",
          input: { cmd: "pnpm lint" },
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-exec",
          output: "Process exited with code 0",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const block = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;

    expect(block).toMatchObject({
      type: "tool_use",
      id: "call-exec",
      name: "Bash",
      input: {
        cmd: "pnpm lint",
        command: "pnpm lint",
      },
    });
  });

  it("normalizes Codex code-mode exec scripts into an Exec tool row", () => {
    const script =
      'const result = await tools.exec_command({cmd: "pnpm test", yield_time_ms: 30000});';
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-code-exec",
          name: "exec",
          input: script,
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-code-exec",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 0.2 seconds\nOutput:\n",
            },
            { type: "input_text", text: "Tests passed" },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const toolUseContent = result.messages[0]?.message?.content;
    const block = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;

    expect(block).toMatchObject({
      type: "tool_use",
      id: "call-code-exec",
      name: "CodexExec",
      input: { script },
    });

    const toolResultMessage = result.messages[1];
    const toolResultContent = toolResultMessage?.message?.content;
    expect(
      Array.isArray(toolResultContent)
        ? toolResultContent[0]
        : toolResultContent,
    ).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-code-exec",
      content: "Script completed\nWall time 0.2 seconds\nOutput:\nTests passed",
    });
    expect(toolResultMessage?.toolUseResult).toEqual([
      {
        type: "input_text",
        text: "Script completed\nWall time 0.2 seconds\nOutput:\n",
      },
      { type: "input_text", text: "Tests passed" },
    ]);
  });

  it("projects code-mode patch_apply_end events into completed Edit rows", () => {
    const entries = loadCodexFixtureEntries("code-mode-apply-patch");

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const editItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "Edit",
    );

    expect(normalized.messages).toHaveLength(4);
    expect(editItem?.type).toBe("tool_call");
    if (editItem?.type !== "tool_call") {
      throw new Error(
        "Expected patch_apply_end to produce an Edit render item",
      );
    }

    expect(editItem.status).toBe("complete");
    expect(editItem.id).toBe("exec-inner-patch");
    expect(editItem.toolInput).toMatchObject({
      changes: [
        {
          path: "/repo/src/a.ts",
          kind: "add",
          diff: "export const value = 1;\n",
        },
        {
          path: "/repo/src/z.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    });
    expect(editItem.toolResult?.content).toContain(
      "Success. Updated the following files:",
    );
  });

  it("restores temp and Downloads filenames from existing code-mode JSONL patches", () => {
    const paths = [
      "/var/folders/aa/private-user/T/authoring_run/api_request.py",
      "/Users/private-user/Downloads/report/api_request.py",
    ];
    const entries: CodexSessionEntry[] = [
      {
        type: "session_meta",
        timestamp: "2026-08-26T12:00:00Z",
        payload: {
          id: "test-session",
          timestamp: "2026-08-26T12:00:00Z",
          cwd: "/repo",
        },
      },
      ...paths.map(
        (path, i) =>
          ({
            type: "event_msg",
            timestamp: `2026-08-26T12:00:0${i + 1}Z`,
            payload: {
              type: "patch_apply_end",
              call_id: `patch-${i}`,
              success: true,
              stdout: `Success. Updated the following files:\nA ${path}`,
              stderr: "",
              changes: { [path]: { type: "add", content: "import json\n" } },
            },
          }) as CodexSessionEntry,
      ),
    ];
    const normalized = normalizeSession(buildLoadedSession(entries));
    const edits = preprocessMessages(normalized.messages).filter(
      (item) => item.type === "tool_call" && item.toolName === "Edit",
    );
    expect(edits).toHaveLength(2);
    for (const [index, path] of paths.entries()) {
      const edit = edits[index];
      if (edit?.type !== "tool_call") throw new Error("Expected Edit row");
      expect(edit.toolInput).toMatchObject({
        file_path: publicCodexFileChangePath(path),
      });
      expect(edit.toolResult?.content).toContain(
        publicCodexFileChangePath(path),
      );
    }
    expect(JSON.stringify(edits)).not.toContain("[path hidden]");
    expect(JSON.stringify(edits)).toContain("private-user");
  });

  it("surfaces a literal code-mode update_plan alongside the outer exec", () => {
    const script = `
      const plan = await tools.update_plan({
        explanation: "Starting verification",
        plan: [
          { step: "Inspect changes", status: "completed" },
          { step: "Run tests", status: "inProgress" }
        ]
      });
      const result = await tools.exec_command({ cmd: "pnpm test" });
      text(JSON.stringify({ plan, result }));
    `;
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-code-plan",
          name: "exec",
          input: script,
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const content = result.messages[0]?.message?.content;

    expect(content).toEqual([
      {
        type: "tool_use",
        id: "call-code-plan",
        name: "CodexExec",
        input: { script },
      },
      {
        type: "tool_use",
        id: "call-code-plan-update-plan",
        name: "UpdatePlan",
        input: {
          explanation: "Starting verification",
          plan: [
            { step: "Inspect changes", status: "completed" },
            { step: "Run tests", status: "in_progress" },
          ],
        },
        status: "completed",
      },
    ]);
  });

  it("does not evaluate dynamic code-mode update_plan arguments", () => {
    const script = "await tools.update_plan(planInput);";
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-dynamic-plan",
          name: "exec",
          input: script,
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages[0]?.message?.content).toEqual([
      {
        type: "tool_use",
        id: "call-dynamic-plan",
        name: "CodexExec",
        input: { script },
      },
    ]);
  });

  it("ignores update_plan examples inside strings and comments", () => {
    const script = `
      const example = 'tools.update_plan({plan: [{step: "Fake", status: "completed"}]})';
      // tools.update_plan({plan: [{step: "Comment", status: "completed"}]});
      /* tools.update_plan({plan: [{step: "Block", status: "completed"}]}); */
      await tools.exec_command({cmd: "pnpm test"});
    `;
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-plan-example",
          name: "exec",
          input: script,
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages[0]?.message?.content).toEqual([
      {
        type: "tool_use",
        id: "call-plan-example",
        name: "CodexExec",
        input: { script },
      },
    ]);
  });

  it("marks failed Codex code-mode exec output as an error", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-code-exec-failed",
          name: "exec",
          input: "throw new Error('boom')",
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-code-exec-failed",
          output: [
            {
              type: "input_text",
              text: "Script failed\nWall time 0.0 seconds\nOutput:\n",
            },
            { type: "input_text", text: "Script error:\nboom" },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const toolResultContent = result.messages[1]?.message?.content;

    expect(
      Array.isArray(toolResultContent)
        ? toolResultContent[0]
        : toolResultContent,
    ).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-code-exec-failed",
      is_error: true,
      content:
        "Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\nboom",
    });
  });

  it("maps ripgrep exec_command calls to Grep and treats no matches as non-error", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-rg",
          arguments:
            '{"cmd":"rg -n \\"preventBackgroundThrottling|background.*throttl\\" packages/server/src -S"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-rg",
          output:
            "Chunk ID: 9e8716\nWall time: 0.8740 seconds\nProcess exited with code 1\nOriginal token count: 0\nOutput:\n\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-rg",
      name: "Grep",
      input: {
        pattern: "preventBackgroundThrottling|background.*throttl",
        path: "packages/server/src",
      },
    });

    const toolResultContent = result.messages[1]?.message?.content;
    const resultBlock = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-rg",
    });
    expect((resultBlock as { is_error?: boolean }).is_error).toBeUndefined();
    expect(result.messages[1]?.toolUseResult).toMatchObject({
      mode: "files_with_matches",
      numFiles: 0,
      filenames: [],
    });
  });

  it("maps sed range commands to Read with line metadata", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-sed",
          arguments:
            '{"command":"sed -n \\"120,122p\\" packages/server/src/auth/routes.ts"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-sed",
          output:
            "Chunk ID: 111111\nWall time: 0.4000 seconds\nProcess exited with code 0\nOriginal token count: 123\nOutput:\n\nline120\nline121\nline122\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-sed",
      name: "Read",
      input: {
        file_path: "packages/server/src/auth/routes.ts",
        offset: 120,
        limit: 3,
      },
    });

    expect(result.messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "packages/server/src/auth/routes.ts",
        numLines: 3,
        startLine: 120,
        totalLines: 122,
      },
    });
  });

  it("maps shell-launcher wrapped sed commands to Read", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-wrapped-sed",
          arguments: JSON.stringify({
            command:
              "/bin/bash -lc \"sed -n '120,122p' packages/server/src/auth/routes.ts\"",
          }),
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-wrapped-sed",
          output:
            "Chunk ID: wrapped111\nWall time: 0.4000 seconds\nProcess exited with code 0\nOriginal token count: 123\nOutput:\n\nline120\nline121\nline122\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-wrapped-sed",
      name: "Read",
      input: {
        file_path: "packages/server/src/auth/routes.ts",
        offset: 120,
        limit: 3,
      },
    });
  });

  it("maps nl -ba | sed range commands to Read and strips line numbers", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-nl-sed",
          arguments:
            '{"command":"nl -ba packages/server/src/auth/routes.ts | sed -n \\"200,202p\\""}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-nl-sed",
          output:
            "Chunk ID: 222222\nWall time: 0.4100 seconds\nProcess exited with code 0\nOriginal token count: 210\nOutput:\n\n  200\tconst a = 1;\n  201\tconst b = 2;\n  202\treturn a + b;\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-nl-sed",
      name: "Read",
      input: {
        file_path: "packages/server/src/auth/routes.ts",
        offset: 200,
        limit: 3,
      },
    });

    expect(result.messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "packages/server/src/auth/routes.ts",
        content: "const a = 1;\nconst b = 2;\nreturn a + b;\n",
        numLines: 3,
        startLine: 200,
        totalLines: 202,
      },
    });
  });

  it("maps simple cat commands to Read for richer file rendering", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-cat",
          arguments: '{"command":"cat packages/server/package.json"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-cat",
          output:
            'Chunk ID: 333333\nWall time: 0.5000 seconds\nProcess exited with code 0\nOriginal token count: 300\nOutput:\n\n{"name":"@yep-anywhere/server","private":true}\n',
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-cat",
      name: "Read",
      input: {
        file_path: "packages/server/package.json",
      },
    });

    expect(result.messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "packages/server/package.json",
        startLine: 1,
      },
    });
  });

  it("maps heredoc cat writes to Write with structured file result", () => {
    const content =
      'import { publish } from "./sw-v2";\n\nexport default publish;\n';
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-write",
          arguments: JSON.stringify({
            cmd: `cat > website/sw-v2-adapter.ts <<'EOF'\n${content}EOF`,
          }),
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-write",
          output:
            "Chunk ID: write123\nWall time: 0.0400 seconds\nProcess exited with code 0\nOutput:\n\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-write",
      name: "Write",
      input: {
        file_path: "website/sw-v2-adapter.ts",
        content,
      },
    });

    const toolResultContent = result.messages[1]?.message?.content;
    const resultBlock = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-write",
    });
    expect((resultBlock as { is_error?: boolean }).is_error).toBeUndefined();
    expect(result.messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "website/sw-v2-adapter.ts",
        content,
        numLines: 3,
        startLine: 1,
        totalLines: 3,
      },
    });
  });

  it('does not mark shell output as error when exit code is 0 and output text contains "failed"', () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-ok",
          arguments: '{"command":"sed -n \\"1,240p\\" file.ts"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-ok",
          output:
            'Exit code: 0\nWall time: 1.2 seconds\nOutput:\nconst statuses = ["pending", "running", "completed", "failed"];\n',
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const toolResultContent = result.messages[1]?.message?.content;
    const block = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;

    expect(block).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-ok",
    });
    expect((block as { is_error?: boolean }).is_error).toBeUndefined();
  });

  it("marks shell output as error when exit code is non-zero even without error keywords", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-fail",
          arguments: '{"command":"some-command"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-fail",
          output: "Exit code: 2\nWall time: 0.3 seconds\nOutput:\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const toolResultContent = result.messages[1]?.message?.content;
    const block = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;

    expect(block).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-fail",
      is_error: true,
    });
  });

  it("marks exec output as error when text contains non-zero process exit code", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-exec-fail",
          arguments: '{"cmd":"pnpm -r exec tsc --noEmit"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-exec-fail",
          output:
            "Chunk ID: abc123\nWall time: 0.8 seconds\nProcess exited with code 2\nOriginal token count: 100\nOutput:\n\nNo explicit error marker text.\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-exec-fail",
      name: "Bash",
      input: {
        cmd: "pnpm -r exec tsc --noEmit",
        command: "pnpm -r exec tsc --noEmit",
      },
    });

    const toolResultContent = result.messages[1]?.message?.content;
    const resultBlock = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-exec-fail",
      is_error: true,
    });
  });

  it("normalizes custom_tool_call and maps apply_patch to Edit", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-2",
          name: "apply_patch",
          input: { patch: "*** Begin Patch" },
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-2",
          output: '{"ok":true}',
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseMessage = result.messages[0];
    const toolResultMessage = result.messages[1];
    const toolUseContent = toolUseMessage?.message?.content;

    expect(
      Array.isArray(toolUseContent) ? toolUseContent[0] : toolUseContent,
    ).toMatchObject({
      type: "tool_use",
      id: "call-2",
      name: "Edit",
    });
    expect(toolResultMessage?.toolUseResult).toMatchObject({ ok: true });
  });

  it("merges matching patch events into direct apply_patch without duplicates", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-08-03T07:18:17.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-direct-patch",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-03T07:18:18.000Z",
        payload: {
          type: "patch_apply_end",
          call_id: "call-direct-patch",
          turn_id: "turn-1",
          stdout: "Success. Updated the following files:\nM src/a.ts\n",
          stderr: "",
          success: true,
          status: "completed",
          changes: {
            "src/a.ts": {
              type: "update",
              unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
              move_path: null,
            },
          },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-03T07:18:18.100Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-direct-patch",
          output: '{"ok":true}',
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const editItems = renderItems.filter(
      (item) => item.type === "tool_call" && item.toolName === "Edit",
    );

    expect(normalized.messages).toHaveLength(2);
    expect(editItems).toHaveLength(1);
    expect(editItems[0]).toMatchObject({
      type: "tool_call",
      id: "call-direct-patch",
      status: "complete",
      toolInput: {
        input: "*** Begin Patch\n*** End Patch",
        file_path: "src/a.ts",
        changes: [
          {
            path: "src/a.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
      },
    });
  });

  it("marks failed patch_apply_end events as failed Edit rows", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2026-08-03T07:18:18.000Z",
        payload: {
          type: "patch_apply_end",
          call_id: "exec-failed-patch",
          turn_id: "turn-1",
          stdout: "",
          stderr: "Failed to apply patch",
          success: false,
          status: "failed",
          changes: {},
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);
    const editItem = renderItems.find(
      (item) => item.type === "tool_call" && item.toolName === "Edit",
    );

    expect(editItem).toMatchObject({
      type: "tool_call",
      id: "exec-failed-patch",
      status: "error",
      toolResult: {
        content: "Failed to apply patch",
        isError: true,
      },
    });
  });

  it("preserves custom tool namespaces instead of treating namespaced exec as code mode", () => {
    const result = normalizeSession(
      buildLoadedSession([
        {
          type: "response_item",
          timestamp: "2024-01-01T00:00:01Z",
          payload: {
            type: "custom_tool_call",
            call_id: "call-namespaced-exec",
            namespace: "mcp__python::",
            name: "exec",
            input: "print('hello')",
          },
        },
      ]),
    );

    const content = result.messages[0]?.message?.content;
    expect(Array.isArray(content) ? content[0] : content).toMatchObject({
      type: "tool_use",
      id: "call-namespaced-exec",
      name: "mcp__python::exec",
      input: "print('hello')",
    });
  });

  it("normalizes new tooling fixture (update_plan + write_stdin) with readable output text", () => {
    const entries = loadCodexFixtureEntries("new-tooling-format");

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(4);

    const updatePlanUse = result.messages[0]?.message?.content;
    const updatePlanUseBlock = Array.isArray(updatePlanUse)
      ? updatePlanUse[0]
      : updatePlanUse;
    expect(updatePlanUseBlock).toMatchObject({
      type: "tool_use",
      id: "plan-1",
      name: "UpdatePlan",
    });

    const updatePlanResult = result.messages[1]?.message?.content;
    const updatePlanResultBlock = Array.isArray(updatePlanResult)
      ? updatePlanResult[0]
      : updatePlanResult;
    expect(updatePlanResultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "plan-1",
      content: "Plan updated",
    });

    const stdinUse = result.messages[2]?.message?.content;
    const stdinUseBlock = Array.isArray(stdinUse) ? stdinUse[0] : stdinUse;
    expect(stdinUseBlock).toMatchObject({
      type: "tool_use",
      id: "stdin-1",
      name: "WriteStdin",
    });

    const stdinResult = result.messages[3]?.message?.content;
    const stdinResultBlock = Array.isArray(stdinResult)
      ? stdinResult[0]
      : stdinResult;
    expect(stdinResultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "stdin-1",
      content:
        "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOriginal token count: 184\nOutput:\n\nready\n",
    });
    expect(
      (stdinResultBlock as { is_error?: boolean }).is_error,
    ).toBeUndefined();
  });

  it("links write_stdin rows back to the exact exec_command from persisted Codex fixture", () => {
    const entries = loadCodexFixtureEntries("write-stdin-linked-command");

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = preprocessMessages(normalized.messages);

    const writeStdinItem = renderItems.find(
      (item) =>
        item.type === "tool_call" &&
        item.id === "call_soO8V845UAwDhcG4REHKJ0XF",
    );

    expect(writeStdinItem?.type).toBe("tool_call");
    if (writeStdinItem?.type !== "tool_call") {
      throw new Error("Expected write_stdin render item");
    }

    expect(writeStdinItem.toolInput).toMatchObject({
      session_id: 37863,
      linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
      linked_tool_name: "Read",
    });
    expect(writeStdinItem.toolResult?.content).toContain(
      'import { useCallback, useEffect, useRef, useState } from "react";',
    );
  });

  it("preserves Codex input_image preview data without dumping it into text", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Please review this.\n<image>\nThanks.",
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
            },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);

    const content = result.messages[0]?.message?.content;
    expect(Array.isArray(content)).toBe(true);

    const blocks = Array.isArray(content) ? content : [];
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    const inputImageBlock = blocks.find(
      (block) => block.type === "input_image",
    );

    expect(text).toContain("<image>");
    expect(text).not.toContain("data:image/png;base64");
    expect(inputImageBlock).toMatchObject({
      type: "input_image",
      mime_type: "image/png",
      image_url: "data:image/png;base64,AAAA",
    });
  });

  it("does not add encrypted reasoning placeholder when summary is present", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Clarifying next step" }],
          encrypted_content: "encrypted-payload",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);

    const content = result.messages[0]?.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "thinking",
      thinking: "Clarifying next step",
    });
  });

  it("skips encrypted-only reasoning when no summary is present", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "reasoning",
          encrypted_content: "encrypted-payload",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(0);
  });

  it("skips developer messages from the normalized transcript", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal prompt" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Visible output" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message?.role).toBe("assistant");
  });

  it("emits turn_aborted as a concise visible system entry", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "turn_aborted",
          reason:
            "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      content: "Conversation stopped by user",
    });
  });

  it("emits compacted entries as compact boundary system messages", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "compacted",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          message: "Compacted 12 messages",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      content: "Compacted 12 messages",
    });
  });

  it("deduplicates context_compacted events next to compacted entries", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "compacted",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          message: "",
          replacement_history: [],
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.014Z",
        payload: {
          type: "context_compacted",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      content: "Context compacted",
    });
  });
});

describe("Codex public prompt projection", () => {
  it("retains managed media paths without mutating rollout", () => {
    const uploadPath =
      "/test/runtime/uploads/cHJvamVjdA/session-1/123e4567-e89b-12d3-a456-426614174000_report.pdf";
    const downloadUrl =
      "/api/projects/cHJvamVjdA/sessions/session-1/upload/123e4567-e89b-12d3-a456-426614174000_report.pdf";
    const imagePath = "/test/runtime/media/shot.png";
    const prompt = `Review /workspace/project/README.md\n\nUser uploaded files:\n- report.pdf (2.0 KB, application/pdf): ${uploadPath}`;
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_text",
              text: `<image name=[Image #1] path="${imagePath}">`,
            },
            {
              type: "input_image",
              file_path: imagePath,
              mime_type: "image/png",
              image_url: "data:image/png;base64,AAAA",
            },
            { type: "input_text", text: "</image>" },
          ],
        },
      },
    ];
    const original = structuredClone(entries);

    const normalized = normalizeSession(buildLoadedSession(entries));
    const serialized = JSON.stringify(normalized);

    expect(serialized).not.toContain("[managed attachment]");
    expect(serialized).not.toContain(downloadUrl);
    expect(serialized).toContain("/workspace/project/README.md");
    expect(serialized).toContain(uploadPath);
    expect(serialized).toContain(imagePath);
    expect(entries).toEqual(original);
  });
});

describe("computeCodexRollbackNumTurns", () => {
  const entries: CodexSessionEntry[] = [
    codexUserMessage("q1", 1),
    codexAssistantMessage("a1", 2),
    codexUserMessage("q2", 3),
    codexAssistantMessage("a2", 4),
    codexUserMessage("q3", 5),
    codexAssistantMessage("a3", 6),
  ];

  it("counts turns from the edited prompt to the active tip", () => {
    const { branchState } = buildCodexBranchView(entries, "s");

    expect(
      computeCodexRollbackNumTurns(branchState, {
        prompt: "q2",
        timestamp: "2024-01-01T00:00:03Z",
      }),
    ).toBe(2);
    expect(computeCodexRollbackNumTurns(branchState, { prompt: "q1" })).toBe(3);
    expect(computeCodexRollbackNumTurns(branchState, { prompt: "q3" })).toBe(1);
  });

  it("returns null for unknown prompts", () => {
    const { branchState } = buildCodexBranchView(entries, "s");
    expect(
      computeCodexRollbackNumTurns(branchState, { prompt: "missing" }),
    ).toBeNull();
    expect(
      computeCodexRollbackNumTurns(branchState, { prompt: "   " }),
    ).toBeNull();
  });

  it("counts turns on the active path after a prior rollback", () => {
    const rolled: CodexSessionEntry[] = [
      ...entries,
      codexRollbackMarker(2, 7),
      codexUserMessage("q2-1", 8),
      codexAssistantMessage("a2-1", 9),
    ];
    const { branchState } = buildCodexBranchView(rolled, "s");

    // Active path is q1 -> q2-1.
    expect(computeCodexRollbackNumTurns(branchState, { prompt: "q2-1" })).toBe(
      1,
    );
    expect(computeCodexRollbackNumTurns(branchState, { prompt: "q1" })).toBe(2);
  });

  it("unwinds to the common ancestor when editing a sibling branch turn", () => {
    const rolled: CodexSessionEntry[] = [
      ...entries,
      codexRollbackMarker(2, 7),
      codexUserMessage("q2-1", 8),
      codexAssistantMessage("a2-1", 9),
    ];
    const { branchState } = buildCodexBranchView(rolled, "s");

    // q2/q3 live on the rolled-back sibling branch. Editing q2 should unwind
    // the active path back to q1 (drop q2-1 only).
    expect(computeCodexRollbackNumTurns(branchState, { prompt: "q2" })).toBe(1);
  });

  it("disambiguates duplicate prompts by timestamp", () => {
    const dup: CodexSessionEntry[] = [
      codexUserMessage("same", 1),
      codexAssistantMessage("a1", 2),
      codexUserMessage("same", 3),
      codexAssistantMessage("a2", 4),
    ];
    const { branchState } = buildCodexBranchView(dup, "s");

    expect(
      computeCodexRollbackNumTurns(branchState, {
        prompt: "same",
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ).toBe(2);
    expect(
      computeCodexRollbackNumTurns(branchState, {
        prompt: "same",
        timestamp: "2024-01-01T00:00:03Z",
      }),
    ).toBe(1);
    // Without a timestamp the most recent occurrence wins.
    expect(computeCodexRollbackNumTurns(branchState, { prompt: "same" })).toBe(
      1,
    );
  });

  it("matches a public managed-attachment prompt against raw branch history", () => {
    const path = "/test/runtime/uploads/report.pdf";
    const rawPrompt = `Review\n\nUser uploaded files:\n- report.pdf (1.0 KB, application/pdf): ${path}`;
    const publicPrompt = rawPrompt.replace(path, "[managed attachment]");
    const { branchState } = buildCodexBranchView(
      [codexUserMessage(rawPrompt, 1), codexAssistantMessage("answer", 2)],
      "s",
    );

    expect(
      computeCodexRollbackNumTurns(branchState, {
        prompt: publicPrompt,
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ).toBe(1);
  });
});

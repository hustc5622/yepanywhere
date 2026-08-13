/**
 * ZCode event converter unit tests.
 *
 * Tests the pure-function `convertZCodeNotificationToSDKMessages` converter
 * against each event name: session lifecycle, turn lifecycle, text/reasoning
 * delta aggregation, tool call/result, message upsert dedup, and unknown
 * event safe-ignoring.
 *
 * Uses the REAL ZCode CLI 0.16.1 event envelope shape:
 *   `{method: "session/event", params: {type, payload?, seq, sessionId, eventId, timestamp}}`
 * The event name is in `params.type` and the typed body is in `params.payload`.
 */

import type { ZCodeJsonRpcNotification } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  convertZCodeNotificationToSDKMessages,
  createZCodeEventConverterState,
  normalizeZCodeUsage,
} from "../../../src/sdk/providers/zcode-protocol/events.js";

const SESSION_ID = "test-session-1";

function makeNotification(
  method: string,
  params: Record<string, unknown> = {},
): ZCodeJsonRpcNotification {
  return { method, params };
}

function makeEventNotification(
  eventName: string,
  params: Record<string, unknown> = {},
): ZCodeJsonRpcNotification {
  // Real ZCode CLI 0.16.1 event envelope:
  // {method: "session/event", params: {type, payload, seq, sessionId, eventId, timestamp}}
  return {
    method: "session/event",
    params: {
      type: eventName,
      payload: params,
      seq: 0,
      sessionId: SESSION_ID,
      eventId: "test-evt",
      timestamp: 0,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ZCode event converter", () => {
  describe("session lifecycle", () => {
    it("converts session.created to system/init", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("session.created", { model: "zai/glm-4.6" }),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe("system");
      expect(messages[0]?.subtype).toBe("init");
      expect(messages[0]?.session_id).toBe(SESSION_ID);
      expect(messages[0]?.model).toBe("zai/glm-4.6");
    });

    it("converts session.resumed to system/init", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("session.resumed"),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]?.subtype).toBe("init");
    });

    it("safely ignores session.updated/titleUpdated/closed", () => {
      const state = createZCodeEventConverterState();
      for (const evt of [
        "session.updated",
        "session.titleUpdated",
        "session.closed",
      ]) {
        const messages = convertZCodeNotificationToSDKMessages(
          makeEventNotification(evt),
          state,
          SESSION_ID,
        );
        expect(messages).toEqual([]);
      }
    });
  });

  describe("turn lifecycle", () => {
    it("converts turn.completed to turn_complete + result", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("turn.completed", {
          usage: { inputTokens: 120, outputTokens: 45 },
        }),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(2);
      expect(messages[0]?.type).toBe("system");
      expect(messages[0]?.subtype).toBe("turn_complete");
      expect(messages[1]?.type).toBe("result");
      expect(messages[1]?.usage).toEqual({
        input_tokens: 120,
        output_tokens: 45,
      });
    });

    it("omits usage when turn.completed carries no recognized token counts", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("turn.completed", { usage: { tokens: 100 } }),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(2);
      expect(messages[0]?.usage).toBeUndefined();
      expect(messages[1]?.usage).toBeUndefined();
    });

    it("converts turn.failed to error + result", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("turn.failed", {
          error: { message: "Model error" },
        }),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(2);
      expect(messages[0]?.type).toBe("error");
      expect(messages[0]?.error).toBe("Model error");
      expect(messages[1]?.type).toBe("result");
    });

    it("safely ignores turn.started and steer events", () => {
      const state = createZCodeEventConverterState();
      for (const evt of [
        "turn.started",
        "turn.steerQueued",
        "turn.steerDrained",
      ]) {
        const messages = convertZCodeNotificationToSDKMessages(
          makeEventNotification(evt),
          state,
          SESSION_ID,
        );
        expect(messages).toEqual([]);
      }
    });
  });

  describe("text streaming aggregation", () => {
    it("aggregates text deltas into a single assistant message on text_end", () => {
      const state = createZCodeEventConverterState();
      const msgId = "msg-1";

      // text_start
      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_start",
          messageId: msgId,
        }),
        state,
        SESSION_ID,
      );

      // text_delta (returns stream_event)
      const deltaMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_delta",
          messageId: msgId,
          text: "Hello",
        }),
        state,
        SESSION_ID,
      );
      expect(deltaMessages).toHaveLength(1);
      expect(deltaMessages[0]?.type).toBe("stream_event");

      // text_end (returns aggregated assistant message)
      const endMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_end",
          messageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      expect(endMessages).toHaveLength(1);
      expect(endMessages[0]?.type).toBe("assistant");
      expect(endMessages[0]?.message?.content).toEqual([
        { type: "text", text: "Hello" },
      ]);
    });

    it("aggregates multiple text deltas", () => {
      const state = createZCodeEventConverterState();
      const msgId = "msg-2";

      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_start",
          messageId: msgId,
        }),
        state,
        SESSION_ID,
      );

      for (const text of ["Hello", " ", "world"]) {
        convertZCodeNotificationToSDKMessages(
          makeEventNotification("model.streaming", {
            kind: "text_delta",
            messageId: msgId,
            text,
          }),
          state,
          SESSION_ID,
        );
      }

      const endMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_end",
          messageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      expect(endMessages).toHaveLength(1);
      const content = endMessages[0]?.message?.content as Array<{
        text: string;
      }>;
      expect(content[0]?.text).toBe("Hello world");
    });
  });

  describe("reasoning streaming aggregation", () => {
    it("aggregates reasoning deltas into a thinking block on reasoning_end", () => {
      const state = createZCodeEventConverterState();
      const msgId = "msg-r1";

      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "reasoning_start",
          messageId: msgId,
        }),
        state,
        SESSION_ID,
      );

      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "reasoning_delta",
          messageId: msgId,
          reasoning: "Let me think...",
        }),
        state,
        SESSION_ID,
      );

      const endMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "reasoning_end",
          messageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      expect(endMessages).toHaveLength(1);
      expect(endMessages[0]?.type).toBe("assistant");
      const content = endMessages[0]?.message?.content as Array<{
        thinking: string;
      }>;
      expect(content[0]?.thinking).toBe("Let me think...");
    });
  });

  describe("tool streaming", () => {
    it("emits a tool_use block on tool_call", () => {
      const state = createZCodeEventConverterState();
      const toolCallId = "tool-1";

      // tool_input_start + delta + end
      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_input_start",
          toolCallId,
        }),
        state,
        SESSION_ID,
      );

      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_input_delta",
          toolCallId,
          toolInput: '{"command": "ls"}',
        }),
        state,
        SESSION_ID,
      );

      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_input_end",
          toolCallId,
        }),
        state,
        SESSION_ID,
      );

      // tool_call
      const callMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_call",
          toolCallId,
          toolName: "Bash",
        }),
        state,
        SESSION_ID,
      );
      expect(callMessages).toHaveLength(1);
      expect(callMessages[0]?.type).toBe("assistant");
      const content = callMessages[0]?.message?.content as Array<
        Record<string, unknown>
      >;
      expect(content[0]?.type).toBe("tool_use");
      expect(content[0]?.name).toBe("Bash");
      expect(content[0]?.input).toEqual({ command: "ls" });
      expect(content[0]?.status).toBe("pending");
    });
  });

  describe("real CLI 0.16.1 streaming payload contract", () => {
    // Verified by the 2026-08-13 live-model smoke against the real CLI:
    //   text_delta sample: {"assistantMessageId":"msg_...","delta":"Y","done":false,"kind":"text_delta"}
    //   - chunks live in `delta` (NOT `text`/`reasoning`)
    //   - message identity is `assistantMessageId` (NOT `messageId`; `partId` on replays)
    //   - tool_input_delta.delta is the full ACCUMULATED input (buffer flush)
    //   - tool_call carries the parsed `input` object directly
    it("aggregates text deltas carried in `delta` keyed by `assistantMessageId`", () => {
      const state = createZCodeEventConverterState();
      const msgId = "msg_real_1";

      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      for (const delta of ["YEP", "-OK"]) {
        convertZCodeNotificationToSDKMessages(
          makeEventNotification("model.streaming", {
            kind: "text_delta",
            delta,
            done: false,
            assistantMessageId: msgId,
          }),
          state,
          SESSION_ID,
        );
      }
      const endMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_end",
          delta: "",
          done: false,
          assistantMessageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      expect(endMessages).toHaveLength(1);
      expect(endMessages[0]?.uuid).toBe(msgId);
      expect(endMessages[0]?.message?.content).toEqual([
        { type: "text", text: "YEP-OK" },
      ]);
    });

    it("aggregates reasoning deltas carried in `delta`", () => {
      const state = createZCodeEventConverterState();
      const msgId = "msg_real_2";

      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "reasoning_start",
          delta: "",
          done: false,
          assistantMessageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "reasoning_delta",
          delta: "thinking...",
          done: false,
          assistantMessageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      const endMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "reasoning_end",
          delta: "",
          done: false,
          assistantMessageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      const content = endMessages[0]?.message?.content as Array<{
        thinking: string;
      }>;
      expect(content[0]?.thinking).toBe("thinking...");
    });

    it("treats tool_input_delta.delta as an accumulated snapshot, not an increment", () => {
      const state = createZCodeEventConverterState();
      const toolCallId = "tool-real-1";

      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_input_start",
          delta: "",
          done: false,
          toolCallId,
        }),
        state,
        SESSION_ID,
      );
      // Real CLI flushes the whole buffer each time: first a prefix, then the
      // full input. Appending would corrupt the JSON; replacing must win.
      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_input_delta",
          delta: '{"command":"ls"',
          done: false,
          toolCallId,
        }),
        state,
        SESSION_ID,
      );
      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_input_delta",
          delta: '{"command":"ls"}',
          done: false,
          toolCallId,
        }),
        state,
        SESSION_ID,
      );
      // Legacy tool_call without `input` falls back to the buffer path.
      const callMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_call",
          toolCallId,
          toolName: "Bash",
        }),
        state,
        SESSION_ID,
      );
      const content = callMessages[0]?.message?.content as Array<
        Record<string, unknown>
      >;
      expect(content[0]?.input).toEqual({ command: "ls" });
    });

    it("prefers the parsed `input` object on real tool_call payloads", () => {
      const state = createZCodeEventConverterState();
      const callMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "tool_call",
          input: { command: "ls" },
          done: false,
          toolCallId: "tool-real-2",
          toolName: "Bash",
        }),
        state,
        SESSION_ID,
      );
      const content = callMessages[0]?.message?.content as Array<
        Record<string, unknown>
      >;
      expect(content[0]?.type).toBe("tool_use");
      expect(content[0]?.input).toEqual({ command: "ls" });
    });
  });

  describe("tool.updated", () => {
    it("emits a tool_result on completed", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("tool.updated", {
          toolCallId: "tool-1",
          toolName: "Bash",
          toolStatus: "completed",
          toolOutput: "file1.txt\nfile2.txt",
        }),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe("user");
      expect(messages[0]?.tool_use_id).toBe("tool-1");
      const content = messages[0]?.message?.content as Array<
        Record<string, unknown>
      >;
      expect(content[0]?.type).toBe("tool_result");
      expect(content[0]?.tool_use_id).toBe("tool-1");
    });

    it("emits a tool_result with error status on error", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("tool.updated", {
          toolCallId: "tool-err",
          toolName: "Bash",
          toolStatus: "error",
          toolError: "Command not found",
        }),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(1);
      const content = messages[0]?.message?.content as Array<
        Record<string, unknown>
      >;
      expect(content[0]?.status).toBe("error");
    });
  });

  describe("message.upserted dedup", () => {
    it("projects a message on first upsert and skips duplicates", () => {
      const state = createZCodeEventConverterState();
      const msgId = "msg-upsert-1";

      const firstMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("message.upserted", {
          messageId: msgId,
          message: { role: "assistant", content: "Hello" },
        }),
        state,
        SESSION_ID,
      );
      expect(firstMessages).toHaveLength(1);
      expect(firstMessages[0]?.type).toBe("assistant");

      // Second upsert of the same message → skipped.
      const secondMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("message.upserted", {
          messageId: msgId,
          message: { role: "assistant", content: "Hello" },
        }),
        state,
        SESSION_ID,
      );
      expect(secondMessages).toEqual([]);
    });

    it("skips upserted messages already projected via streaming", () => {
      const state = createZCodeEventConverterState();
      const msgId = "msg-streamed-1";

      // Stream the text.
      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_start",
          messageId: msgId,
        }),
        state,
        SESSION_ID,
      );
      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_delta",
          messageId: msgId,
          text: "Hi",
        }),
        state,
        SESSION_ID,
      );
      convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "text_end",
          messageId: msgId,
        }),
        state,
        SESSION_ID,
      );

      // Upsert of the same message → skipped (already projected).
      const upsertMessages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("message.upserted", {
          messageId: msgId,
          message: { role: "assistant", content: "Hi" },
        }),
        state,
        SESSION_ID,
      );
      expect(upsertMessages).toEqual([]);
    });
  });

  describe("unknown events", () => {
    it("safely ignores unknown event names and increments counter", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("unknown.future.event"),
        state,
        SESSION_ID,
      );
      expect(messages).toEqual([]);
      expect(state.unknownEventCount).toBe(1);
    });

    it("safely ignores P5 events (checkpoint, rewind, streamRecovery)", () => {
      const state = createZCodeEventConverterState();
      // Real CLI 0.16.1 only has rewind.triggered (not started/completed/failed)
      for (const evt of [
        "checkpoint.created",
        "rewind.triggered",
        "streamRecovery.updated",
      ]) {
        const messages = convertZCodeNotificationToSDKMessages(
          makeEventNotification(evt),
          state,
          SESSION_ID,
        );
        expect(messages).toEqual([]);
      }
    });
  });

  describe("model.streaming error", () => {
    it("converts model streaming error to error SDKMessage", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeEventNotification("model.streaming", {
          kind: "error",
          error: "Rate limit exceeded",
        }),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe("error");
      expect(messages[0]?.error).toBe("Rate limit exceeded");
    });
  });

  describe("permission events", () => {
    it("safely ignores permission.requested and permission.resolved", () => {
      const state = createZCodeEventConverterState();
      for (const evt of ["permission.requested", "permission.resolved"]) {
        const messages = convertZCodeNotificationToSDKMessages(
          makeEventNotification(evt),
          state,
          SESSION_ID,
        );
        expect(messages).toEqual([]);
      }
    });
  });

  describe("userInput events (real CLI 0.16.1)", () => {
    it("safely ignores userInput.requested and userInput.resolved", () => {
      const state = createZCodeEventConverterState();
      for (const evt of ["userInput.requested", "userInput.resolved"]) {
        const messages = convertZCodeNotificationToSDKMessages(
          makeEventNotification(evt),
          state,
          SESSION_ID,
        );
        expect(messages).toEqual([]);
      }
    });
  });

  describe("part events (real CLI 0.16.1)", () => {
    it("safely ignores part.started, part.delta, part.upserted, part.removed", () => {
      const state = createZCodeEventConverterState();
      for (const evt of [
        "part.started",
        "part.delta",
        "part.upserted",
        "part.removed",
      ]) {
        const messages = convertZCodeNotificationToSDKMessages(
          makeEventNotification(evt),
          state,
          SESSION_ID,
        );
        expect(messages).toEqual([]);
      }
    });
  });

  describe("direct notification method (non-session/event)", () => {
    it("handles events delivered with the event name as method", () => {
      const state = createZCodeEventConverterState();
      const messages = convertZCodeNotificationToSDKMessages(
        makeNotification("turn.completed"),
        state,
        SESSION_ID,
      );
      expect(messages).toHaveLength(2);
      expect(messages[0]?.subtype).toBe("turn_complete");
    });
  });

  describe("normalizeZCodeUsage", () => {
    it("maps AI-SDK camelCase token counts", () => {
      expect(
        normalizeZCodeUsage({
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 7,
          cachedInputTokens: 64,
        }),
      ).toEqual({
        input_tokens: 100,
        output_tokens: 20,
        reasoning_tokens: 7,
        cache_read_input_tokens: 64,
      });
    });

    it("maps Anthropic snake_case token counts including cache writes", () => {
      expect(
        normalizeZCodeUsage({
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 3,
        }),
      ).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
      });
    });

    it("maps OpenAI prompt/completion spellings and nested detail objects", () => {
      expect(
        normalizeZCodeUsage({
          prompt_tokens: 40,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 8 },
          completion_tokens_details: { reasoning_tokens: 4 },
        }),
      ).toEqual({
        input_tokens: 40,
        output_tokens: 12,
        reasoning_tokens: 4,
        cache_read_input_tokens: 8,
      });
    });

    it("falls back to cacheStats.cacheReadTokens when usage omits cache accounting", () => {
      expect(
        normalizeZCodeUsage({ inputTokens: 9 }, { cacheReadTokens: 5 }),
      ).toEqual({ input_tokens: 9, cache_read_input_tokens: 5 });
    });

    it("prefers usage cache accounting over cacheStats", () => {
      expect(
        normalizeZCodeUsage(
          { inputTokens: 9, cachedInputTokens: 11 },
          { cacheReadTokens: 5 },
        ),
      ).toEqual({ input_tokens: 9, cache_read_input_tokens: 11 });
    });

    it("returns undefined for missing, non-object, or unusable usage", () => {
      expect(normalizeZCodeUsage(undefined)).toBeUndefined();
      expect(normalizeZCodeUsage(null)).toBeUndefined();
      expect(normalizeZCodeUsage("120 tokens")).toBeUndefined();
      expect(normalizeZCodeUsage([1, 2, 3])).toBeUndefined();
      expect(normalizeZCodeUsage({})).toBeUndefined();
      expect(normalizeZCodeUsage({ totalTokens: 50 })).toBeUndefined();
    });

    it("rejects negative and non-finite token counts", () => {
      expect(
        normalizeZCodeUsage({
          inputTokens: -1,
          outputTokens: Number.NaN,
          reasoningTokens: Number.POSITIVE_INFINITY,
        }),
      ).toBeUndefined();
    });

    it("keeps a zero token count rather than dropping it", () => {
      expect(normalizeZCodeUsage({ inputTokens: 0, outputTokens: 8 })).toEqual({
        input_tokens: 0,
        output_tokens: 8,
      });
    });
  });
});

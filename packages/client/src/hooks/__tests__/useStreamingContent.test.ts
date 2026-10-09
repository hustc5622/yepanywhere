import { act, renderHook } from "@testing-library/react";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type UseStreamingContentOptions,
  useStreamingContent,
} from "../useStreamingContent";

// Mock getStreamingEnabled to control streaming behavior in tests
vi.mock("../useStreamingEnabled", () => ({
  getStreamingEnabled: vi.fn(() => true),
}));

import { getStreamingEnabled } from "../useStreamingEnabled";

describe("useStreamingContent", () => {
  let onUpdateMessage: Mock;
  let onToolUseMapping: Mock;
  let onAgentContextUsage: Mock;
  let streamingMarkdownCallbacks: {
    setCurrentMessageId: Mock;
    onStreamEnd: Mock;
  };

  const defaultOptions = (): UseStreamingContentOptions => ({
    onUpdateMessage,
    onToolUseMapping,
    onAgentContextUsage,
    streamingMarkdownCallbacks,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    onUpdateMessage = vi.fn();
    onToolUseMapping = vi.fn();
    onAgentContextUsage = vi.fn();
    streamingMarkdownCallbacks = {
      setCurrentMessageId: vi.fn(),
      onStreamEnd: vi.fn(),
    };
    (getStreamingEnabled as Mock).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each(["content_block_stop", "message_stop"])(
    "flushes final tokens and stops the cursor on %s",
    (type) => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );
      const emit = (event: Record<string, unknown>) =>
        result.current.handleStreamEvent({ type: "stream_event", event });
      act(() => {
        emit({ type: "message_start", message: { id: "message" } });
        emit({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        emit({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Final tokens" },
        });
        emit({ type, index: 0 });
      });
      expect(onUpdateMessage.mock.lastCall?.[0]).toMatchObject({
        _isStreaming: false,
        _isStreamingPlaceholder: true,
        message: { content: [{ text: "Final tokens" }] },
      });
      const count = onUpdateMessage.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(onUpdateMessage).toHaveBeenCalledTimes(count);
    },
  );

  it("handles Codex item-scoped deltas without start events and closes a superseded item", () => {
    const { result } = renderHook(() => useStreamingContent(defaultOptions()));
    const delta = (id: string, text: string) =>
      result.current.handleStreamEvent({
        type: "stream_event",
        uuid: id,
        codexTurnId: "turn",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
      });
    act(() => {
      delta("old", "Old partial");
      delta("new", "New text");
      vi.advanceTimersByTime(50);
    });
    expect(
      onUpdateMessage.mock.calls.map(([message]) => message),
    ).toMatchObject([
      {
        id: "old",
        _isStreaming: false,
        message: { content: [{ text: "Old partial" }] },
      },
      {
        id: "new",
        _isStreaming: true,
        message: { content: [{ text: "New text" }] },
      },
    ]);
  });

  it("a child completion does not flush or discard the main stream", () => {
    const { result } = renderHook(() => useStreamingContent(defaultOptions()));
    const emit = (
      agentId: string | undefined,
      event: Record<string, unknown>,
    ) =>
      result.current.handleStreamEvent({
        type: "stream_event",
        ...(agentId ? { isSubagent: true, agentId } : {}),
        event,
      });
    act(() => {
      for (const agentId of [undefined, "child"]) {
        emit(agentId, {
          type: "message_start",
          message: { id: agentId ?? "main" },
        });
        emit(agentId, {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
      }
      emit(undefined, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Main" },
      });
      emit("child", { type: "message_stop" });
      result.current.clearStreaming({ agentId: "child" });
      emit(undefined, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " continues" },
      });
      vi.advanceTimersByTime(50);
    });
    expect(onUpdateMessage.mock.lastCall).toMatchObject([
      {
        id: "main",
        _isStreaming: true,
        message: { content: [{ text: "Main continues" }] },
      },
      undefined,
    ]);
    expect(streamingMarkdownCallbacks.onStreamEnd).not.toHaveBeenCalled();
    expect(
      streamingMarkdownCallbacks.setCurrentMessageId,
    ).toHaveBeenCalledTimes(1);
  });

  it("late tokens and completion of an old turn cannot stop a newer stream", () => {
    const { result } = renderHook(() => useStreamingContent(defaultOptions()));
    const delta = (id: string, turn: string, text: string) =>
      result.current.handleStreamEvent({
        type: "stream_event",
        uuid: id,
        codexTurnId: turn,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
      });
    act(() => {
      delta("old", "old-turn", "Old");
      result.current.finishStreaming({ turnId: "old-turn" });
      delta("new", "new-turn", "New");
      result.current.clearStreaming({ turnId: "old-turn" });
      delta("old", "old-turn", " late");
      result.current.finishStreaming({ turnId: "old-turn" });
      delta("new", "new-turn", " continues");
      vi.advanceTimersByTime(50);
    });
    expect(onUpdateMessage.mock.lastCall?.[0]).toMatchObject({
      id: "new",
      _isStreaming: true,
      message: { content: [{ text: "New continues" }] },
    });
  });

  describe("handleStreamEvent", () => {
    it("returns false for non-stream_event messages", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      const handled = result.current.handleStreamEvent({
        type: "message",
        content: "hello",
      });

      expect(handled).toBe(false);
    });

    it("returns false when streaming is disabled", () => {
      (getStreamingEnabled as Mock).mockReturnValue(false);

      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      const handled = result.current.handleStreamEvent({
        type: "stream_event",
        event: { type: "message_start" },
      });

      expect(handled).toBe(false);
    });

    it("returns true for stream_event with no event data", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      const handled = result.current.handleStreamEvent({
        type: "stream_event",
      });

      expect(handled).toBe(true);
    });

    it("handles message_start and sets current message ID", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
      });

      expect(
        streamingMarkdownCallbacks.setCurrentMessageId,
      ).toHaveBeenCalledWith("msg-123");
    });

    it("handles content_block_start and creates streaming message", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      // First send message_start to set the ID
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
      });

      // Then send content_block_start
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
      });

      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "msg-123",
          type: "assistant",
          _isStreaming: true,
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text" }),
            ]),
          }),
        }),
        undefined, // no agentId for main stream
      );
    });

    it("accumulates text deltas and throttles updates", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      // Set up streaming
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
      });

      // Clear previous calls
      onUpdateMessage.mockClear();

      // Send multiple deltas rapidly
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: " world" },
          },
        });
      });

      // Before throttle fires, no update
      expect(onUpdateMessage).not.toHaveBeenCalled();

      // Advance past throttle interval (50ms)
      act(() => {
        vi.advanceTimersByTime(50);
      });

      // Now update should have fired with accumulated text
      expect(onUpdateMessage).toHaveBeenCalledTimes(1);
      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ text: "Hello world" }),
            ]),
          }),
        }),
        undefined,
      );
    });

    it("batches independent agent streams without mixing their text", () => {
      const onUpdateMessages = vi.fn();
      const { result } = renderHook(() =>
        useStreamingContent({ ...defaultOptions(), onUpdateMessages }),
      );
      const emit = (agentId: string, event: Record<string, unknown>) =>
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          agentId,
          event,
        });
      act(() => {
        for (const id of ["one", "two"]) {
          emit(id, { type: "message_start", message: { id } });
          emit(id, {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
        }
      });
      onUpdateMessages.mockClear();
      act(() => {
        emit("one", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "One" },
        });
        emit("two", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Two" },
        });
      });
      expect(onUpdateMessages).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(onUpdateMessages).toHaveBeenCalledTimes(1);
      expect(onUpdateMessages.mock.calls[0]?.[0]).toMatchObject([
        {
          agentId: "one",
          message: { id: "one", message: { content: [{ text: "One" }] } },
        },
        {
          agentId: "two",
          message: { id: "two", message: { content: [{ text: "Two" }] } },
        },
      ]);
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it("handles thinking deltas", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
        });
      });

      onUpdateMessage.mockClear();

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Let me think..." },
          },
        });
      });

      act(() => {
        vi.advanceTimersByTime(50);
      });

      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ thinking: "Let me think..." }),
            ]),
          }),
        }),
        undefined,
      );
    });

    it("handles message_stop and calls onStreamEnd", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_stop",
          },
        });
      });

      expect(streamingMarkdownCallbacks.onStreamEnd).toHaveBeenCalled();
    });

    it("routes subagent streams with agentId", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
      });

      expect(onToolUseMapping).toHaveBeenCalledWith("tool-456", "tool-456");
      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({ _isStreaming: true }),
        "tool-456", // agentId is passed
      );
    });

    it("routes subagent streams with agentId only (SDK 0.2.76+, no parentToolUseId)", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          agentId: "a1dd713c82c78b9ed",
          // No parentToolUseId — new SDK format
          event: {
            type: "message_start",
            message: { id: "msg-new-sdk" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          agentId: "a1dd713c82c78b9ed",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
      });

      // Should use agentId as the routing key
      expect(onToolUseMapping).toHaveBeenCalledWith(
        "a1dd713c82c78b9ed",
        "a1dd713c82c78b9ed",
      );
      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({ _isStreaming: true }),
        "a1dd713c82c78b9ed",
      );
    });

    it("extracts context usage for subagent streams", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "message_start",
            message: {
              id: "msg-123",
              usage: { input_tokens: 50000 },
            },
          },
        });
      });

      expect(onAgentContextUsage).toHaveBeenCalledWith("tool-456", {
        inputTokens: 50000,
        percentage: 25, // 50000 / 200000 * 100
      });
    });

    it("uses message model_context_window when available", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "message_start",
            message: {
              id: "msg-123",
              usage: { input_tokens: 50000 },
              model_context_window: 258000,
            },
          },
        });
      });

      const usage = onAgentContextUsage.mock.calls[0]?.[1];
      expect(usage?.inputTokens).toBe(50000);
      expect(usage?.percentage).toBeCloseTo(19.38, 2);
    });
  });

  describe("clearStreaming", () => {
    it("clears streaming state and agent ID", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      // Set up streaming with agent
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
      });

      expect(result.current.getCurrentAgentId()).toBe("tool-456");

      act(() => {
        result.current.clearStreaming();
      });

      expect(result.current.getCurrentAgentId()).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("clears pending throttle timers", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      // Set up streaming and send delta to start throttle timer
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          },
        });
      });

      onUpdateMessage.mockClear();

      // Call cleanup
      act(() => {
        result.current.cleanup();
      });

      // Advance timers - should not trigger update since timer was cleared
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(onUpdateMessage).not.toHaveBeenCalled();
    });
  });

  describe("getCurrentAgentId", () => {
    it("returns null when no streaming", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      expect(result.current.getCurrentAgentId()).toBeNull();
    });

    it("returns agentId during subagent streaming", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-789",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
      });

      expect(result.current.getCurrentAgentId()).toBe("tool-789");
    });
  });
});

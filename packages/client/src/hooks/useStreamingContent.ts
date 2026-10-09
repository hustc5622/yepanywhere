import { getModelContextWindow } from "@yep-anywhere/shared";
import { useCallback, useRef } from "react";
import { getMessageId } from "../lib/mergeMessages";
import type { ContentBlock, Message } from "../types";
import { getStreamingEnabled } from "./useStreamingEnabled";

/** Throttle interval for batching streaming UI updates */
const STREAMING_THROTTLE_MS = 50;

/** Callbacks for streaming markdown events (augment/pending from SSE) */
export interface StreamingMarkdownCallbacks {
  onAugment?: (augment: {
    blockIndex: number;
    html: string;
    type: string;
    messageId?: string;
  }) => void;
  onPending?: (pending: { html: string; messageId?: string }) => void;
  onStreamEnd?: () => void;
  setCurrentMessageId?: (messageId: string | null) => void;
  captureHtml?: () => string | null;
}

/** Streaming placeholder update emitted to session message state */
export interface StreamingContentUpdate {
  message: Message;
  agentId?: string;
}

/** Context usage info for subagent progress tracking */
export interface ContextUsage {
  inputTokens: number;
  percentage: number;
}

/** Options for useStreamingContent hook */
export interface UseStreamingContentOptions {
  /** Called when a streaming message needs to be updated in state */
  onUpdateMessage: (message: Message, agentId?: string) => void;
  /** Called with all streaming messages flushed in the same throttle window */
  onUpdateMessages?: (updates: StreamingContentUpdate[]) => void;
  /** Streaming markdown callbacks (passed through) */
  streamingMarkdownCallbacks?: StreamingMarkdownCallbacks;
  /** Callback when toolUseId→agentId mapping is discovered */
  onToolUseMapping?: (toolUseId: string, agentId: string) => void;
  /** Callback for agent context usage updates */
  onAgentContextUsage?: (agentId: string, usage: ContextUsage) => void;
  /** Fallback context window size when stream metadata doesn't include one */
  contextWindowSize?: number;
}

/** Result from useStreamingContent hook */
export interface UseStreamingContentResult {
  /** Process a stream_event SSE message. Returns true if handled. */
  handleStreamEvent: (data: Record<string, unknown>) => boolean;
  /** Clear all streaming state (called when assistant message arrives) */
  clearStreaming: (scope?: {
    agentId?: string;
    allAgents?: boolean;
    turnId?: string;
  }) => void;
  /** Stop indicators and flush partial text without discarding it. */
  finishStreaming: (scope?: {
    agentId?: string;
    allAgents?: boolean;
    turnId?: string;
  }) => void;
  /** Cleanup function for useEffect (clears timers) */
  cleanup: () => void;
  /** Get the current streaming agent ID (for routing assistant messages) */
  getCurrentAgentId: () => string | null;
}

/** Internal streaming state for a message */
interface StreamingState {
  blocks: ContentBlock[];
  isStreaming: boolean;
  agentId?: string;
  activeBlockIndex?: number;
  codexTurnId?: string;
}

/**
 * Hook for managing streaming content accumulation from SSE stream_event messages.
 *
 * This hook handles:
 * - Accumulating content blocks from streaming API events
 * - Throttling UI updates to avoid overwhelming React with re-renders
 * - Routing subagent streams via agentId
 * - Notifying streaming markdown context of updates
 */
export function useStreamingContent(
  options: UseStreamingContentOptions,
): UseStreamingContentResult {
  const {
    onUpdateMessage,
    onUpdateMessages,
    streamingMarkdownCallbacks,
    onToolUseMapping,
    onAgentContextUsage,
    contextWindowSize: defaultContextWindowSize,
  } = options;

  // Streaming state: accumulates content from stream_event messages
  // Key is the message uuid, value is the accumulated content blocks
  const streamingContentRef = useRef<Map<string, StreamingState>>(new Map());

  // Track current streaming message ID (from message_start event)
  // Each stream_event has its own uuid, but they all belong to the same message
  const currentStreamingIdsRef = useRef(new Map<string, string>());
  const closedIdsRef = useRef(new Set<string>());
  const rememberClosed = useCallback((id: string) => {
    closedIdsRef.current.add(id);
    if (closedIdsRef.current.size > 256) {
      const first = closedIdsRef.current.values().next().value;
      if (first) closedIdsRef.current.delete(first);
    }
  }, []);

  // Track current streaming agentId (if this is a subagent stream)
  const currentStreamingAgentIdRef = useRef<string | null>(null);

  // Throttle streaming UI updates to avoid overwhelming React with re-renders
  // Data accumulates in streamingContentRef immediately, but state updates are batched
  const streamingThrottleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pendingIds: Set<string>;
  }>({ timer: null, pendingIds: new Set() });

  const buildStreamingUpdate = useCallback(
    (messageId: string): StreamingContentUpdate | null => {
      const streaming = streamingContentRef.current.get(messageId);
      if (!streaming) return null;

      const streamingMessage: Message = {
        id: messageId,
        type: "assistant",
        role: "assistant",
        message: {
          role: "assistant",
          content: streaming.blocks.map((block) => ({ ...block })),
        },
        _isStreaming: streaming.isStreaming,
        _isStreamingPlaceholder: true,
        _streamingBlockIndex: streaming.activeBlockIndex,
        ...(streaming.codexTurnId
          ? { codexTurnId: streaming.codexTurnId }
          : {}),
        _source: "sdk",
      };

      return { message: streamingMessage, agentId: streaming.agentId };
    },
    [],
  );

  const emitStreamingUpdates = useCallback(
    (messageIds: Iterable<string>) => {
      const updates: StreamingContentUpdate[] = [];
      for (const id of messageIds) {
        const update = buildStreamingUpdate(id);
        if (update) updates.push(update);
      }
      if (updates.length === 0) return;

      if (onUpdateMessages) {
        onUpdateMessages(updates);
        return;
      }

      for (const update of updates) {
        onUpdateMessage(update.message, update.agentId);
      }
    },
    [buildStreamingUpdate, onUpdateMessage, onUpdateMessages],
  );

  // Update messages with streaming content.
  // Creates or updates a streaming placeholder message with accumulated content.
  const updateStreamingMessage = useCallback(
    (messageId: string) => {
      emitStreamingUpdates([messageId]);
    },
    [emitStreamingUpdates],
  );

  // Throttled version of updateStreamingMessage for delta events
  // Batches rapid updates to reduce React re-renders during streaming
  const throttledUpdateStreamingMessage = useCallback(
    (messageId: string) => {
      const throttle = streamingThrottleRef.current;
      throttle.pendingIds.add(messageId);

      // If no timer running, start one
      if (!throttle.timer) {
        throttle.timer = setTimeout(() => {
          // Flush all pending updates in one callback.
          const pendingIds = Array.from(throttle.pendingIds);
          throttle.pendingIds.clear();
          throttle.timer = null;
          emitStreamingUpdates(pendingIds);
        }, STREAMING_THROTTLE_MS);
      }
    },
    [emitStreamingUpdates],
  );

  const finishStreaming = useCallback(
    (scope?: { agentId?: string; allAgents?: boolean; turnId?: string }) => {
      const ids: string[] = [];
      for (const [id, state] of streamingContentRef.current) {
        if (scope && !scope.allAgents && state.agentId !== scope.agentId)
          continue;
        if (
          scope?.turnId &&
          state.codexTurnId &&
          state.codexTurnId !== scope.turnId
        )
          continue;
        if (!state.isStreaming) continue;
        state.isStreaming = false;
        state.activeBlockIndex = undefined;
        streamingThrottleRef.current.pendingIds.delete(id);
        ids.push(id);
      }
      emitStreamingUpdates(ids);
    },
    [emitStreamingUpdates],
  );

  // Process a stream_event SSE message
  // Returns true if the event was handled, false if it should be processed elsewhere
  const handleStreamEvent = useCallback(
    (data: Record<string, unknown>): boolean => {
      // Only handle stream_event messages when streaming is enabled
      const msgType = data.type as string | undefined;
      if (msgType !== "stream_event" || !getStreamingEnabled()) {
        return false;
      }

      const event = data.event as Record<string, unknown> | undefined;
      if (!event) return true; // Handled but no event data

      const eventType = event.type as string | undefined;

      // Check if this is a subagent stream (marked by server via markSubagent)
      // Legacy SDK: uses parentToolUseId as routing key
      // SDK 0.2.76+: uses agentId directly (no parentToolUseId)
      const isSubagentStream =
        data.isSubagent &&
        (typeof data.parentToolUseId === "string" ||
          typeof data.agentId === "string");
      const streamAgentId = isSubagentStream
        ? ((data.parentToolUseId as string) ?? (data.agentId as string))
        : undefined;
      const route = streamAgentId ?? "";

      // Set toolUseToAgent mapping for subagent streams so TaskRenderer can find content
      if (streamAgentId && onToolUseMapping) {
        onToolUseMapping(streamAgentId, streamAgentId);
      }

      // Handle message_start to capture the message ID for this streaming response
      // Each stream_event has its own uuid, but they all belong to the same API message
      if (eventType === "message_start") {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.id) {
          if (closedIdsRef.current.has(message.id as string)) return true;
          finishStreaming({ agentId: streamAgentId });
          currentStreamingIdsRef.current.set(route, message.id as string);
          // Also track if this is a subagent stream
          currentStreamingAgentIdRef.current = streamAgentId ?? null;
          // Notify streaming markdown context of new message
          if (!streamAgentId)
            streamingMarkdownCallbacks?.setCurrentMessageId?.(
              message.id as string,
            );

          // Extract context usage for subagent progress tracking
          // Note: We only update subagent context usage from message_start, not main session.
          // Main session context usage comes from the API (which reads from JSONL after
          // the assistant message is complete with full usage data).
          if (streamAgentId && onAgentContextUsage) {
            const usage = message.usage as
              | { input_tokens?: number }
              | undefined;
            if (usage?.input_tokens) {
              const inputTokens = usage.input_tokens;
              const model =
                typeof message.model === "string" ? message.model : undefined;
              const modelContextWindow =
                typeof message.model_context_window === "number"
                  ? message.model_context_window
                  : undefined;
              const contextWindow =
                modelContextWindow && modelContextWindow > 0
                  ? modelContextWindow
                  : model
                    ? getModelContextWindow(model)
                    : (defaultContextWindowSize ??
                      getModelContextWindow(undefined));
              const percentage = (inputTokens / contextWindow) * 100;
              onAgentContextUsage(streamAgentId, { inputTokens, percentage });
            }
          }
        }
        return true;
      }

      // Codex supplies item identity directly; other providers use message_start.
      const explicitId =
        typeof data.codexTurnId === "string"
          ? getMessageId(data as Message)
          : undefined;
      const streamingId =
        explicitId ?? currentStreamingIdsRef.current.get(route);
      if (!streamingId) return true;
      if (
        closedIdsRef.current.has(streamingId) ||
        (eventType === "content_block_delta" &&
          streamingContentRef.current.get(streamingId)?.isStreaming === false)
      )
        return true;
      if (
        explicitId &&
        currentStreamingIdsRef.current.get(route) !== explicitId
      ) {
        finishStreaming({ agentId: streamAgentId });
        currentStreamingIdsRef.current.set(route, explicitId);
      }
      const agentId = streamAgentId;
      const index =
        typeof event.index === "number" &&
        Number.isSafeInteger(event.index) &&
        event.index >= 0 &&
        event.index < 10_000
          ? event.index
          : 0;

      // Handle different stream event types
      if (eventType === "content_block_start") {
        // New content block starting
        const contentBlock = event.content_block as Record<
          string,
          unknown
        > | null;
        if (contentBlock) {
          const streaming = streamingContentRef.current.get(streamingId) ?? {
            blocks: [],
            isStreaming: true,
            agentId, // Track which agent this stream belongs to
          };
          streaming.isStreaming =
            contentBlock.type === "text" || contentBlock.type === "thinking";
          streaming.activeBlockIndex = index;
          // Ensure array is long enough
          while (streaming.blocks.length <= index) {
            streaming.blocks.push({ type: "text", text: "" });
          }
          // Initialize the block with its type
          streaming.blocks[index] = {
            type: (contentBlock.type as string) ?? "text",
            text: (contentBlock.text as string) ?? "",
            thinking: (contentBlock.thinking as string) ?? undefined,
          };
          streamingContentRef.current.set(streamingId, streaming);
          updateStreamingMessage(streamingId);
        }
      } else if (eventType === "content_block_delta") {
        // Content delta - append to existing block
        // Use throttled updates to avoid overwhelming React with re-renders
        const delta = event.delta as Record<string, unknown> | null;
        if (delta) {
          let streaming = streamingContentRef.current.get(streamingId);
          // Codex emits item-scoped deltas without message/block start events.
          if (!streaming && explicitId && delta.type === "text_delta") {
            streaming = {
              blocks: [{ type: "text", text: "" }],
              isStreaming: true,
              activeBlockIndex: index,
              agentId,
              codexTurnId: data.codexTurnId as string,
            };
            streamingContentRef.current.set(streamingId, streaming);
          }
          if (!streaming?.isStreaming || streaming.activeBlockIndex !== index)
            return true;
          if (streaming?.blocks[index]) {
            const block = streaming.blocks[index];
            const deltaType = delta.type as string;
            if (deltaType === "text_delta" && delta.text) {
              block.text = (block.text ?? "") + (delta.text as string);
            } else if (deltaType === "thinking_delta" && delta.thinking) {
              block.thinking =
                (block.thinking ?? "") + (delta.thinking as string);
            }
            throttledUpdateStreamingMessage(streamingId);
          }
        }
      } else if (eventType === "content_block_stop") {
        const streaming = streamingContentRef.current.get(streamingId);
        if (streaming?.activeBlockIndex === index) finishStreaming({ agentId });
      } else if (eventType === "message_stop") {
        // Flush throttled tokens before closing. Keep the placeholder until its
        // authoritative message arrives, but never show a cursor on it again.
        finishStreaming({ agentId });
        rememberClosed(streamingId);
        if (!agentId) streamingMarkdownCallbacks?.onStreamEnd?.();
      }

      return true; // Event was handled
    },
    [
      updateStreamingMessage,
      throttledUpdateStreamingMessage,
      streamingMarkdownCallbacks,
      onToolUseMapping,
      onAgentContextUsage,
      defaultContextWindowSize,
      finishStreaming,
      rememberClosed,
    ],
  );

  // Clear all streaming state (called when assistant message arrives)
  const clearStreaming = useCallback(
    (scope?: { agentId?: string; allAgents?: boolean; turnId?: string }) => {
      for (const [id, state] of streamingContentRef.current) {
        if (scope && !scope.allAgents && state.agentId !== scope.agentId)
          continue;
        if (
          scope?.turnId &&
          state.codexTurnId &&
          state.codexTurnId !== scope.turnId
        )
          continue;
        streamingThrottleRef.current.pendingIds.delete(id);
        streamingContentRef.current.delete(id);
        rememberClosed(id);
      }
      for (const [route, id] of currentStreamingIdsRef.current) {
        if (
          (!scope || scope.allAgents || route === (scope.agentId ?? "")) &&
          (!scope?.turnId || !streamingContentRef.current.has(id))
        )
          currentStreamingIdsRef.current.delete(route);
      }
      if (
        !streamingThrottleRef.current.pendingIds.size &&
        streamingThrottleRef.current.timer
      ) {
        clearTimeout(streamingThrottleRef.current.timer);
        streamingThrottleRef.current.timer = null;
      }
      if (
        !scope ||
        scope.allAgents ||
        currentStreamingAgentIdRef.current === (scope.agentId ?? null)
      )
        currentStreamingAgentIdRef.current = null;
    },
    [rememberClosed],
  );

  // Get the current streaming agent ID (for routing assistant messages)
  const getCurrentAgentId = useCallback(() => {
    return currentStreamingAgentIdRef.current;
  }, []);

  // Cleanup function for useEffect (clears timers)
  const cleanup = useCallback(() => {
    if (streamingThrottleRef.current.timer) {
      clearTimeout(streamingThrottleRef.current.timer);
      streamingThrottleRef.current.timer = null;
    }
    streamingThrottleRef.current.pendingIds.clear();
  }, []);

  return {
    handleStreamEvent,
    clearStreaming,
    finishStreaming,
    cleanup,
    getCurrentAgentId,
  };
}

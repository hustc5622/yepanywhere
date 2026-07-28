/**
 * Shared subscription handlers for session and activity streams.
 *
 * WebSocket handlers call these functions, providing their own
 * `emit` implementation for the transport layer.
 */

import {
  type StreamAugmenter,
  createStreamAugmenter,
  extractIdFromAssistant,
  extractMessageIdFromStart,
  extractTextDelta,
  extractTextFromAssistant,
  isStreamingComplete,
  markSubagent,
} from "./augments/index.js";
import { getLogger } from "./logging/logger.js";
import type { Process } from "./supervisor/Process.js";
import type { ProcessEvent } from "./supervisor/types.js";
import type { BusEvent, EventBus } from "./watcher/index.js";

export type Emit = (eventType: string, data: unknown) => void;

type ReplayHistoryMessage = Record<string, unknown> & {
  parent_tool_use_id?: string | null;
  agentId?: string | null;
  isSidechain?: boolean;
  isReplay?: boolean;
};

export interface SubscriptionOptions {
  /** Called when an internal error occurs (e.g. augmentation failure). */
  onError?: (err: unknown) => void;
  /** Optional label for debug logs (e.g., subscription id). */
  logLabel?: string;
  /** Replay only buffered session messages after this message ID. */
  replayAfterMessageId?: string;
}

function getReplayMessageId(message: Record<string, unknown>): string | null {
  const uuid = message.uuid;
  if (typeof uuid === "string" && uuid.length > 0) {
    return uuid;
  }

  const id = message.id;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }

  return null;
}

function getReplayMessages(
  history: ReplayHistoryMessage[],
  replayAfterMessageId?: string,
): ReplayHistoryMessage[] {
  if (!replayAfterMessageId) {
    return history;
  }

  let cursorIndex = -1;
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (message && getReplayMessageId(message) === replayAfterMessageId) {
      cursorIndex = index;
    }
  }

  return cursorIndex >= 0 ? history.slice(cursorIndex + 1) : history;
}

/**
 * Normalize provider stream message shapes before augmentation/rendering.
 * Keep this lightweight; provider-specific heavy transforms should happen upstream.
 */
export function normalizeStreamMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  if (
    message.type === "user" &&
    message.tool_use_result === undefined &&
    message.toolUseResult !== undefined
  ) {
    message.tool_use_result = message.toolUseResult;
  }
  return message;
}

/**
 * Create a session subscription that forwards process events via `emit`.
 *
 * Subscribes to process events BEFORE capturing state for the "connected" event,
 * preventing a race condition where state changes during replay are lost.
 */
export function createSessionSubscription(
  process: Process,
  emit: Emit,
  options?: SubscriptionOptions,
): { cleanup: () => void } {
  let completed = false;
  let currentStreamingMessageId: string | null = null;

  // Lazy augmenter
  let augmenter: StreamAugmenter | null = null;
  let augmenterPromise: Promise<StreamAugmenter> | null = null;

  const getAugmenter = async (): Promise<StreamAugmenter> => {
    if (augmenter) return augmenter;
    if (!augmenterPromise) {
      augmenterPromise = createStreamAugmenter({
        onMarkdownAugment: (data) => {
          if (!completed) emit("markdown-augment", data);
        },
        onPending: (data) => {
          if (!completed) emit("pending", data);
        },
        onError: (err, context) => {
          options?.onError?.(err);
          console.warn(`[subscription] ${context}:`, err);
        },
      });
    }
    augmenter = await augmenterPromise;
    return augmenter;
  };

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    try {
      if (!completed) {
        emit("heartbeat", { timestamp: new Date().toISOString() });
      }
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 30_000);

  // Message ids the provider has streamed token-by-token. Their final message
  // must not be replayed into the markdown coordinator or the catch-up buffer.
  const streamedMessageIds = new Set<string>();

  // Augmentation is async, so handling events concurrently would let cheap
  // events overtake expensive ones and reorder the outbound stream. OpenCode
  // returns `[message_stop, assistant(text), assistant(tool_use)]` from a single
  // upstream event; without this queue the tool_use rows (no augmentation work)
  // arrive before the text they follow, so the streamed commentary is dropped
  // from its place and only reappears in the final authoritative snapshot.
  let eventQueue: Promise<void> = Promise.resolve();
  // Returns the queued promise so callers (and tests) can await drain; the
  // Process listener contract ignores it.
  const enqueue = (handler: () => Promise<void>): Promise<void> => {
    eventQueue = eventQueue.then(handler).catch((err) => {
      options?.onError?.(err);
    });
    return eventQueue;
  };

  // IMPORTANT: Subscribe BEFORE capturing state to prevent race condition.
  // Any state change is guaranteed to either:
  // 1. Be captured in the state snapshot below (if it happened before)
  // 2. Be received by this subscriber (if it happened after)
  const unsubscribe = process.subscribe((event: ProcessEvent) =>
    enqueue(async () => {
      if (completed) return;

      try {
        switch (event.type) {
          case "message": {
            const message = normalizeStreamMessage(
              event.message as Record<string, unknown>,
            );
            const aug = await getAugmenter();
            await aug.processMessage(message);
            emit("message", markSubagent(message));

            const streamStartMessageId = extractMessageIdFromStart(message);
            if (streamStartMessageId) {
              streamedMessageIds.add(streamStartMessageId);
            }
            const startMessageId =
              streamStartMessageId ?? extractIdFromAssistant(message);
            if (startMessageId) {
              currentStreamingMessageId = startMessageId;
            }

            const finalId = extractIdFromAssistant(message);
            const alreadyStreamed =
              finalId !== null && streamedMessageIds.has(finalId);
            const textDelta =
              extractTextDelta(message) ??
              (alreadyStreamed ? null : extractTextFromAssistant(message));
            if (textDelta && currentStreamingMessageId) {
              process.accumulateStreamingText(
                currentStreamingMessageId,
                textDelta,
              );
            }

            if (isStreamingComplete(message)) {
              currentStreamingMessageId = null;
              process.clearStreamingText();
            }
            break;
          }

          case "state-change":
            emit("status", {
              state: event.state.type,
              ...(event.state.type === "waiting-input"
                ? { request: event.state.request }
                : {}),
            });
            break;

          case "mode-change":
            emit("mode-change", {
              permissionMode: event.mode,
              modeVersion: event.version,
            });
            break;

          case "error":
            emit("error", { message: event.error.message });
            break;

          case "session-id-changed":
            emit("session-id-changed", {
              oldSessionId: event.oldSessionId,
              newSessionId: event.newSessionId,
            });
            break;

          case "deferred-queue":
            emit("deferred-queue", { messages: event.messages });
            break;

          case "complete":
            if (augmenter) {
              await augmenter.flush();
            }
            emit("complete", { timestamp: new Date().toISOString() });
            completed = true;
            clearInterval(heartbeatInterval);
            break;
        }
      } catch (err) {
        options?.onError?.(err);
      }
    }),
  );

  // Now that we're subscribed, capture state and emit "connected"
  const currentState = process.state;
  const deferredMessages = process.getDeferredQueueSummary();
  emit("connected", {
    processId: process.id,
    sessionId: process.sessionId,
    state: currentState.type,
    permissionMode: process.permissionMode,
    modeVersion: process.modeVersion,
    provider: process.provider,
    model: process.resolvedModel,
    reasoningEffort: process.resolvedReasoningEffort,
    serviceTier: process.serviceTier,
    ...(currentState.type === "waiting-input"
      ? { request: currentState.request }
      : {}),
    ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
  });

  // Replay buffered messages for late-joining clients
  for (const message of getReplayMessages(
    process.getMessageHistory() as ReplayHistoryMessage[],
    options?.replayAfterMessageId,
  )) {
    emit(
      "message",
      markSubagent({
        ...message,
        isReplay: true,
      }),
    );
  }

  // Catch-up: send accumulated streaming text as pending HTML
  const streamingContent = process.getStreamingContent();
  if (streamingContent) {
    getAugmenter()
      .then(async (aug) => {
        await aug.processCatchUp(
          streamingContent.text,
          streamingContent.messageId,
        );
      })
      .catch((err) => {
        console.warn(
          "[subscription] Failed to send catch-up pending HTML:",
          err,
        );
      });
  }

  return {
    cleanup: () => {
      completed = true;
      clearInterval(heartbeatInterval);
      unsubscribe();
      if (currentStreamingMessageId) {
        process.clearStreamingText();
        currentStreamingMessageId = null;
      }
    },
  };
}

/**
 * Create an activity subscription that forwards EventBus events via `emit`.
 */
export function createActivitySubscription(
  eventBus: EventBus,
  emit: Emit,
  options?: SubscriptionOptions,
): { cleanup: () => void } {
  let closed = false;

  emit("connected", { timestamp: new Date().toISOString() });

  const heartbeatInterval = setInterval(() => {
    try {
      if (!closed) {
        emit("heartbeat", { timestamp: new Date().toISOString() });
      }
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 30_000);

  const unsubscribe = eventBus.subscribe((event: BusEvent) => {
    if (closed) return;
    try {
      const label = options?.logLabel ? ` sub=${options.logLabel}` : "";
      getLogger().debug(
        `[ActivitySubscription] Forwarding event type=${event.type}${label}`,
      );
      emit(event.type, event);
    } catch (err) {
      options?.onError?.(err);
    }
  });

  return {
    cleanup: () => {
      closed = true;
      clearInterval(heartbeatInterval);
      unsubscribe();
    },
  };
}

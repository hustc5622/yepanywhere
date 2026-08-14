/**
 * ZCode protocol event → SDKMessage converter.
 *
 * This is a pure-function module that converts ZCode `session/event`
 * notifications (delivered as `ZCodeJsonRpcNotification`) into `SDKMessage[]`
 * for the provider's `runSession` iterator to yield.
 *
 * Real ZCode CLI 0.16.1 event envelope shape (verified from CLI bundle):
 *   - Notification method: `"session/event"`
 *   - Notification params: `{eventId, sessionId, turnId?, seq, traceId?, timestamp, deliveryKind?, type, payload?}`
 *   - The event name is in `params.type` (NOT `params.event` or `params.kind`)
 *   - The typed body is in `params.payload` (optional)
 *   - `seq` is the sequence number for ordering and dedup
 *   - `sessionId` is always present
 *
 * The converter maintains stateful aggregation buffers for streaming deltas
 * (text, reasoning, tool input) so that individual delta events are combined
 * into coherent content blocks rather than emitted as separate messages.
 *
 * Aggregation rules:
 *   - `model.streaming` `text_start` → `text_delta`* → `text_end`: one `text`
 *     content block per message ID.
 *   - `reasoning_start` → `reasoning_delta`* → `reasoning_end`: one `thinking`
 *     content block per message ID.
 *   - `tool_input_start` → `tool_input_delta`* → `tool_input_end`: accumulates
 *     into the tool_use `input` field.
 *   - `tool.updated` with status `completed`/`error`: emits a `tool_result`
 *     block.
 *   - `message.upserted`: full message snapshot — used for reconciliation, not
 *     for delta replay. The converter ignores upserted messages that have
 *     already been projected via streaming.
 *
 * Unknown event `type` values are safely ignored (counted for diagnostics).
 *
 * The real-time stream and the SQLite normalizer (P2) should share the same
 * "ZCode part → Yep content block" mapping to avoid display inconsistency.
 */

import type { ZCodeJsonRpcNotification } from "@yep-anywhere/shared";
import type { ContentBlock, SDKMessage } from "../../types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Internal state for streaming delta aggregation.
 * Keyed by the ZCode message/part ID to coalesce deltas into single blocks.
 */
export interface ZCodeEventConverterState {
  /** Text delta buffers keyed by message ID. */
  readonly textBuffers: Map<string, string>;
  /** Reasoning delta buffers keyed by message ID. */
  readonly reasoningBuffers: Map<string, string>;
  /** Tool input delta buffers keyed by tool call ID. */
  readonly toolInputBuffers: Map<string, string>;
  /** Already-projected message IDs (from upsert or stream end). */
  readonly projectedMessageIds: Set<string>;
  /** Highest unified event sequence already handled. */
  lastEventSeq: number | null;
  /** Recently handled event IDs for exact replay suppression. */
  readonly seenEventIds: Set<string>;
  /** Completed streamed text awaiting its full message.upserted snapshot. */
  lastCompletedText: string | null;
  /** Count of unknown events for diagnostics. */
  unknownEventCount: number;
}

export function createZCodeEventConverterState(): ZCodeEventConverterState {
  return {
    textBuffers: new Map(),
    reasoningBuffers: new Map(),
    toolInputBuffers: new Map(),
    projectedMessageIds: new Set(),
    lastEventSeq: null,
    seenEventIds: new Set(),
    lastCompletedText: null,
    unknownEventCount: 0,
  };
}

// =============================================================================
// Event params extraction helpers
// =============================================================================

/**
 * Extract event parameters from a ZCode notification.
 *
 * Real CLI 0.16.1 event envelope:
 *   `{method: "session/event", params: {type, payload?, seq, sessionId, ...}}`
 *
 * The event name is in `params.type`. The typed body is in `params.payload`.
 * For backward compatibility, we also tolerate the legacy shape where the
 * event name is in `params.event` and fields are at the top level.
 */
interface ZCodeEventParams {
  sessionId?: string;
  eventId?: string;
  seq?: number;
  // Event discriminator: real CLI uses `type`, legacy fixtures use `event`.
  type?: string;
  // Typed body (real CLI): the payload object contains event-specific fields.
  payload?: Record<string, unknown>;
  // Legacy envelope fields (for backward compat with older fixtures):
  event?: string;
  messageId?: string;
  message?: unknown;
  content?: unknown;
  attachments?: unknown[];
  toolCalls?: unknown[];
  model?: string;
  text?: string;
  reasoning?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolStatus?: string;
  toolOutput?: unknown;
  toolError?: unknown;
  turnId?: string;
  turnStatus?: string;
  usage?: unknown;
  /**
   * `turn.completed` cache accounting, used as a fallback source for
   * `cache_read_input_tokens` when `usage` omits it.
   */
  cacheStats?: unknown;
  error?: { message?: string } | string;
  title?: string;
  kind?: string;
  /**
   * Real CLI 0.16.1 streaming payload fields. `model.streaming` payloads use
   * `assistantMessageId` (NOT `messageId`), carry the chunk in `delta` (NOT
   * `text`/`reasoning`), and use `partId` on some emissions:
   *   `{kind, delta, done, assistantMessageId?, partId?}`.
   * `tool_input_delta.delta` is the full ACCUMULATED tool input (the CLI
   *   flushes its buffer), not an increment. `tool_call` carries the parsed
   *   `input` object directly.
   */
  assistantMessageId?: string;
  partId?: string;
  delta?: string;
  input?: unknown;
}

function extractParams(
  notification: ZCodeJsonRpcNotification,
): ZCodeEventParams {
  const rawParams =
    (notification.params as Record<string, unknown> | undefined) ?? {};

  // Real CLI 0.16.1: event name in `type`, body in `payload`.
  // If payload is an object, merge its fields with the envelope for easy
  // access by the downstream converters.  Fields in payload take priority.
  const payload = rawParams.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...rawParams,
      ...(payload as Record<string, unknown>),
    } as ZCodeEventParams;
  }

  return rawParams as ZCodeEventParams;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MAX_SEEN_ZCODE_EVENT_IDS = 2_048;

function isDuplicateUnifiedEvent(
  notification: ZCodeJsonRpcNotification,
  state: ZCodeEventConverterState,
): boolean {
  if (
    notification.method !== "session/event" &&
    notification.method !== "event"
  ) {
    return false;
  }

  const rawParams =
    (notification.params as Record<string, unknown> | undefined) ?? {};
  const eventId = asString(rawParams.eventId);
  const seq =
    typeof rawParams.seq === "number" &&
    Number.isInteger(rawParams.seq) &&
    rawParams.seq >= 0
      ? rawParams.seq
      : undefined;

  if (eventId && state.seenEventIds.has(eventId)) {
    return true;
  }
  if (
    seq !== undefined &&
    state.lastEventSeq !== null &&
    seq <= state.lastEventSeq
  ) {
    return true;
  }

  if (seq !== undefined) {
    state.lastEventSeq = seq;
  }
  if (eventId) {
    if (state.seenEventIds.size >= MAX_SEEN_ZCODE_EVENT_IDS) {
      state.seenEventIds.clear();
    }
    state.seenEventIds.add(eventId);
  }
  return false;
}

// =============================================================================
// Usage normalization
// =============================================================================

function asTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/** Read the first present token count from a list of candidate field names. */
function pickTokenCount(
  sources: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): number | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const count = asTokenCount(source[key]);
      if (count !== undefined) return count;
    }
  }
  return undefined;
}

/**
 * Normalize a ZCode `turn.completed` usage object into Yep's canonical usage
 * shape (`input_tokens`, `output_tokens`, `reasoning_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens`).
 *
 * ZCode declares `usage` as an opaque value in its own event schema and the
 * value passes through whichever SDK served the turn, so both the AI-SDK
 * camelCase spelling (`inputTokens`, `cachedInputTokens`) and the
 * Anthropic/OpenAI snake_case spellings (`input_tokens`, `prompt_tokens`)
 * appear in practice. Accept every spelling the CLI itself reads, and fall
 * back to `cacheStats.cacheReadTokens` from the same payload when the usage
 * object omits cache accounting.
 *
 * Returns `undefined` when nothing usable is present, so the caller can omit
 * the field rather than emit an empty object.
 */
export function normalizeZCodeUsage(
  rawUsage: unknown,
  cacheStats?: unknown,
): Record<string, unknown> | undefined {
  const usage = asObject(rawUsage);
  if (!usage) return undefined;

  // Nested detail objects used by OpenAI-compatible and AI-SDK payloads.
  const inputDetails = asObject(usage.inputTokenDetails);
  const outputDetails = asObject(usage.outputTokenDetails);
  const promptDetails = asObject(usage.prompt_tokens_details);
  const completionDetails = asObject(usage.completion_tokens_details);
  const stats = asObject(cacheStats);

  const inputTokens = pickTokenCount(
    [usage],
    ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"],
  );
  const outputTokens = pickTokenCount(
    [usage],
    ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"],
  );
  const reasoningTokens = pickTokenCount(
    [usage, outputDetails, completionDetails],
    ["reasoningTokens", "reasoning_tokens"],
  );
  const cacheReadTokens = pickTokenCount(
    [usage, inputDetails, promptDetails, stats],
    [
      "cacheReadTokens",
      "cachedInputTokens",
      "cache_read_input_tokens",
      "cached_tokens",
      "cacheReadInputTokens",
    ],
  );
  const cacheWriteTokens = pickTokenCount(
    [usage, inputDetails, promptDetails],
    [
      "cacheWriteTokens",
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
    ],
  );

  const normalized: Record<string, unknown> = {};
  if (inputTokens !== undefined) normalized.input_tokens = inputTokens;
  if (outputTokens !== undefined) normalized.output_tokens = outputTokens;
  if (reasoningTokens !== undefined) {
    normalized.reasoning_tokens = reasoningTokens;
  }
  if (cacheReadTokens !== undefined) {
    normalized.cache_read_input_tokens = cacheReadTokens;
  }
  if (cacheWriteTokens !== undefined) {
    normalized.cache_creation_input_tokens = cacheWriteTokens;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// =============================================================================
// Main converter
// =============================================================================

/**
 * Convert a ZCode protocol notification into zero or more SDKMessages.
 *
 * The `state` object is mutated to track streaming aggregation and
 * deduplication. The caller owns the state and passes it to every call.
 *
 * Returns an empty array for events that are safely ignored (unknown event
 * names, intermediate deltas, or upserted messages already projected).
 */
export function convertZCodeNotificationToSDKMessages(
  notification: ZCodeJsonRpcNotification,
  state: ZCodeEventConverterState,
  sessionId: string,
): SDKMessage[] {
  const method = notification.method;

  if (isDuplicateUnifiedEvent(notification, state)) {
    return [];
  }

  // The unified event stream arrives as "session/event" with the actual event
  // name in params.type (real CLI 0.16.1).
  // Legacy fallback: some fixtures may use params.event or params.kind.
  // For model.streaming, the sub-kind is in the payload's `kind` field.
  let eventName = method;
  if (method === "session/event" || method === "event") {
    const rawParams =
      (notification.params as Record<string, unknown> | undefined) ?? {};
    eventName =
      (typeof rawParams.type === "string" ? rawParams.type : undefined) ??
      (typeof rawParams.event === "string" ? rawParams.event : undefined) ??
      (typeof rawParams.kind === "string" ? rawParams.kind : undefined) ??
      method;
  }

  switch (eventName) {
    case "session.created":
    case "session.resumed":
      return convertSessionCreated(notification, state, sessionId);

    case "session.updated":
    case "session.titleUpdated":
    case "session.closed":
      return []; // metadata-only, no transcript impact in P1

    case "turn.started":
      return []; // turn lifecycle tracked by caller, no SDKMessage needed

    case "turn.completed":
      return convertTurnCompleted(notification, state, sessionId);

    case "turn.failed":
      return convertTurnFailed(notification, state, sessionId);

    case "turn.steerQueued":
    case "turn.steerDrained":
      return []; // steer lifecycle, no transcript impact

    case "message.upserted":
      return convertMessageUpserted(notification, state, sessionId);

    case "message.removed":
      return []; // P5: handle removal for replay consistency

    case "model.streaming":
      return convertModelStreaming(notification, state, sessionId);

    case "tool.updated":
      return convertToolUpdated(notification, state, sessionId);

    case "permission.requested":
    case "permission.resolved":
      return []; // handled by server-request path, not as SDKMessage

    // User input events (real CLI 0.16.1 uses userInput.*, not interaction/*)
    case "userInput.requested":
    case "userInput.resolved":
      return []; // handled by server-request path, not as SDKMessage

    // Part events (real CLI 0.16.1 uses part.started/delta/upserted for
    // streaming content, but model.streaming is also emitted. We handle
    // part.* as no-ops for now since model.streaming covers the same content.)
    case "part.started":
    case "part.delta":
    case "part.upserted":
    case "part.removed":
      return []; // P5: handle part events for richer replay

    case "checkpoint.created":
    case "rewind.triggered":
    case "streamRecovery.updated":
      return []; // P5 features

    default:
      state.unknownEventCount += 1;
      return [];
  }
}

// =============================================================================
// Session lifecycle
// =============================================================================

function convertSessionCreated(
  notification: ZCodeJsonRpcNotification,
  _state: ZCodeEventConverterState,
  sessionId: string,
): SDKMessage[] {
  const params = extractParams(notification);
  const model = asString(params.model);
  return [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: model ?? undefined,
    },
  ];
}

// =============================================================================
// Turn lifecycle
// =============================================================================

function convertTurnCompleted(
  notification: ZCodeJsonRpcNotification,
  _state: ZCodeEventConverterState,
  sessionId: string,
): SDKMessage[] {
  const params = extractParams(notification);
  const usage = normalizeZCodeUsage(params.usage, params.cacheStats);
  return [
    {
      type: "system",
      subtype: "turn_complete",
      session_id: sessionId,
      ...(usage !== undefined ? { usage } : {}),
    },
    {
      type: "result",
      session_id: sessionId,
      ...(usage !== undefined ? { usage } : {}),
    },
  ];
}

function convertTurnFailed(
  notification: ZCodeJsonRpcNotification,
  _state: ZCodeEventConverterState,
  sessionId: string,
): SDKMessage[] {
  const params = extractParams(notification);
  const error = params.error;
  const errorMessage =
    typeof error === "string" ? error : (error?.message ?? "ZCode turn failed");
  return [
    {
      type: "error",
      session_id: sessionId,
      error: errorMessage,
    },
    {
      type: "result",
      session_id: sessionId,
    },
  ];
}

// =============================================================================
// Message upsert (snapshot reconciliation)
// =============================================================================

function convertMessageUpserted(
  notification: ZCodeJsonRpcNotification,
  state: ZCodeEventConverterState,
  sessionId: string,
): SDKMessage[] {
  const params = extractParams(notification);
  const legacyMessage = asObject(params.message);
  const legacyMessageId = asString(params.messageId);
  const eventId = asString(params.eventId);
  const messageId =
    legacyMessageId ?? (eventId ? `zcode-event:${eventId}` : undefined);
  if (!messageId) return [];

  // Skip if already projected via streaming.
  if (state.projectedMessageIds.has(messageId)) {
    return [];
  }

  const rawRole = asString(legacyMessage?.role) ?? asString(params.type);
  const normalizedRole = rawRole?.toLowerCase().replaceAll("-", "_");
  const role =
    normalizedRole === "user" || normalizedRole === "user_message"
      ? "user"
      : normalizedRole === "system" || normalizedRole === "system_message"
        ? "system"
        : "assistant";
  const content = legacyMessage?.content ?? params.content;

  // Extract text from content (could be string or array of parts).
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (p): p is Record<string, unknown> =>
          p !== null && typeof p === "object" && p.type === "text",
      )
      .map((p) => asString(p.text) ?? "")
      .filter(Boolean);
    text = textParts.length > 0 ? textParts.join("\n") : undefined;
  }

  // The provider already yields the submitted user message before session/send,
  // and system snapshots are metadata. Project only assistant upserts here.
  if (role !== "assistant" || !text) return [];

  if (!legacyMessageId && state.lastCompletedText === text) {
    state.lastCompletedText = null;
    state.projectedMessageIds.add(messageId);
    return [];
  }

  state.projectedMessageIds.add(messageId);

  return [
    {
      type: "assistant",
      uuid: messageId,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: text,
      },
    },
  ];
}

// =============================================================================
// Model streaming (text/reasoning/tool deltas)
// =============================================================================

function convertModelStreaming(
  notification: ZCodeJsonRpcNotification,
  state: ZCodeEventConverterState,
  sessionId: string,
): SDKMessage[] {
  const params = extractParams(notification);
  const kind = asString(params.kind);
  if (!kind) return [];

  const messageId =
    asString(params.messageId) ??
    asString(params.assistantMessageId) ??
    asString(params.partId) ??
    "default";

  switch (kind) {
    // Text streaming
    case "text_start": {
      state.textBuffers.set(messageId, "");
      state.lastCompletedText = null;
      return [];
    }
    case "text_delta": {
      // Real CLI 0.16.1 carries the chunk in `delta`; `text` is the legacy
      // fixture spelling kept for backward compatibility.
      const text = asString(params.text) ?? asString(params.delta) ?? "";
      const current = state.textBuffers.get(messageId) ?? "";
      state.textBuffers.set(messageId, current + text);
      return [
        {
          type: "stream_event",
          subtype: "text_delta",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
          },
        },
      ];
    }
    case "text_end": {
      const text = state.textBuffers.get(messageId) ?? "";
      state.textBuffers.delete(messageId);
      state.projectedMessageIds.add(messageId);
      state.lastCompletedText = text || null;
      return [
        {
          type: "assistant",
          uuid: messageId,
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
          },
        },
      ];
    }

    // Reasoning streaming
    case "reasoning_start": {
      state.reasoningBuffers.set(messageId, "");
      return [];
    }
    case "reasoning_delta": {
      // Real CLI 0.16.1 carries the chunk in `delta`; `reasoning` is the
      // legacy fixture spelling kept for backward compatibility.
      const reasoning =
        asString(params.reasoning) ?? asString(params.delta) ?? "";
      const current = state.reasoningBuffers.get(messageId) ?? "";
      state.reasoningBuffers.set(messageId, current + reasoning);
      return [
        {
          type: "stream_event",
          subtype: "reasoning_delta",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: reasoning }],
          },
        },
      ];
    }
    case "reasoning_end": {
      const thinking = state.reasoningBuffers.get(messageId) ?? "";
      state.reasoningBuffers.delete(messageId);
      return [
        {
          type: "assistant",
          uuid: `${messageId}:reasoning`,
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking }],
          },
        },
      ];
    }

    // Tool input streaming
    case "tool_input_start": {
      const toolCallId = asString(params.toolCallId) ?? messageId;
      state.toolInputBuffers.set(toolCallId, "");
      return [];
    }
    case "tool_input_delta": {
      const toolCallId =
        asString(params.toolCallId) ??
        asString(params.assistantMessageId) ??
        messageId;
      // Real CLI 0.16.1: `delta` is the full ACCUMULATED tool input flushed
      // from the CLI's buffer — REPLACE the buffer, do not append. The legacy
      // `toolInput` spelling is incremental and keeps append semantics.
      const snapshot = asString(params.delta);
      if (snapshot !== undefined) {
        state.toolInputBuffers.set(toolCallId, snapshot);
      } else {
        const delta = asString(params.toolInput) ?? "";
        const current = state.toolInputBuffers.get(toolCallId) ?? "";
        state.toolInputBuffers.set(toolCallId, current + delta);
      }
      return []; // delta not projected as separate messages
    }
    case "tool_input_end": {
      // Tool input is complete; the tool_call event will emit the tool_use.
      return [];
    }

    case "tool_call": {
      return convertToolCallEvent(params, state, sessionId);
    }

    case "start":
    case "finish":
      return []; // model lifecycle markers, no transcript impact

    case "error": {
      const errorMessage = asString(params.error) ?? "Model streaming error";
      return [
        {
          type: "error",
          session_id: sessionId,
          error: errorMessage,
        },
      ];
    }

    default:
      state.unknownEventCount += 1;
      return [];
  }
}

function convertToolCallEvent(
  params: ZCodeEventParams,
  state: ZCodeEventConverterState,
  sessionId: string,
): SDKMessage[] {
  const toolCallId =
    asString(params.toolCallId) ??
    asString(params.messageId) ??
    asString(params.assistantMessageId);
  const toolName = asString(params.toolName) ?? "Unknown";
  // Real CLI 0.16.1 `tool_call` payloads carry the parsed `input` object
  // directly; only fall back to the accumulated input buffer when absent.
  let toolInput: unknown = params.input;
  if (toolInput === undefined) {
    const toolInputStr = toolCallId
      ? (state.toolInputBuffers.get(toolCallId) ?? "")
      : "";
    toolInput = toolInputStr;
    if (toolInputStr) {
      try {
        toolInput = JSON.parse(toolInputStr);
      } catch {
        // Keep as string if not valid JSON.
      }
    }
  }
  if (toolCallId) state.toolInputBuffers.delete(toolCallId);

  const blocks: ContentBlock[] = [
    {
      type: "tool_use",
      id: toolCallId,
      name: toolName,
      input: toolInput,
      status: "pending",
    },
  ];

  return [
    {
      type: "assistant",
      uuid: `${toolCallId ?? "unknown"}:tool-use`,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: blocks,
      },
    },
  ];
}

// =============================================================================
// Tool updated (lifecycle: pending → running → completed/error)
// =============================================================================

function convertToolUpdated(
  notification: ZCodeJsonRpcNotification,
  state: ZCodeEventConverterState,
  sessionId: string,
): SDKMessage[] {
  const params = extractParams(notification);
  const toolCallId = asString(params.toolCallId) ?? asString(params.messageId);
  const toolStatus = asString(params.toolStatus);
  const toolName = asString(params.toolName) ?? "Unknown";

  if (!toolCallId) return [];

  const messages: SDKMessage[] = [];

  if (toolStatus === "completed" || toolStatus === "error") {
    const isError = toolStatus === "error";
    const content = isError
      ? JSON.stringify(params.toolError ?? "Tool error")
      : JSON.stringify(params.toolOutput ?? "");

    messages.push({
      type: "user",
      uuid: `${toolCallId}:tool-result`,
      session_id: sessionId,
      tool_use_id: toolCallId,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content,
            ...(isError ? { status: "error" } : {}),
          },
        ],
      },
    });
  }

  return messages;
}

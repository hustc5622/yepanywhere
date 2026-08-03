import { join } from "node:path";
import type {
  ClaudeSessionEntry,
  CodexCompactedEntry,
  CodexCustomToolCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexEventMsgEntry,
  CodexFunctionCallPayload,
  CodexImageGenerationPayload,
  CodexMessagePayload,
  CodexMessagePhase,
  CodexPatchApplyEndEvent,
  CodexReasoningPayload,
  CodexResponseItemEntry,
  CodexSessionEntry,
  CodexWebSearchCallPayload,
  ContextUsage,
  GeminiAssistantMessage,
  GeminiSessionMessage,
  GeminiUserMessage,
  KimiContentPartEvent,
  KimiSessionContent,
  KimiToolCallEvent,
  KimiToolResultEvent,
  OpenCodeSessionEntry,
  OpenCodeStoredPart,
  SessionBranchOption,
  SessionBranchState,
  UnifiedSession,
} from "@yep-anywhere/shared";
import {
  getGeminiUserMessageText,
  getKimiPromptImages,
  getKimiPromptText,
  getMessageContent,
  getModelContextWindow,
  isConversationEntry,
  isKimiLoopEventRecord,
  isKimiTurnPromptRecord,
} from "@yep-anywhere/shared";
import {
  isCodexCorrelationDebugEnabled,
  logCodexCorrelationDebug,
  summarizeCodexNormalizedMessage,
} from "../codex/correlationDebugLogger.js";
import {
  buildCodexEditInput,
  formatCodexFileChangeResult,
  isCodexFileChangeError,
  normalizeCodexFileChangeStatus,
  normalizeCodexFileChanges,
} from "../codex/file-change.js";
import {
  buildCodexImageGenerationResultText,
  isCodexImageGenerationRecord,
  normalizeCodexImageGenerationRecord,
  summarizeCodexImageGenerationResult,
} from "../codex/image-generation.js";
import {
  type CodexToolCallContext,
  canonicalizeCodexToolName,
  deriveCodexWebRunInvocation,
  extractCodexExecUpdatePlan,
  normalizeCodexToolInvocation,
  normalizeCodexToolOutputWithContext,
  parseCodexToolArguments,
} from "../codex/normalization.js";
import { normalizeKimiToolInput } from "../kimi/tool-input.js";
import {
  getOpenCodeAttachmentLabel,
  hasYepUploadMetadataForFile,
} from "../opencode/attachments.js";
import {
  formatOpenCodeError,
  isOpenCodeAbortError,
} from "../opencode/error.js";
import type { ContentBlock, Message, Session } from "../supervisor/types.js";
import { collectVisibleClaudeEntries } from "./claude-messages.js";
import { applyCodexRollbackMarkers } from "./codex-rollback.js";
import {
  CODEX_TURN_ABORTED_DISPLAY_TEXT,
  isCodexTurnAbortedNoticeText,
} from "./codex-turn-aborted.js";
import type { LoadedSession } from "./types.js";
import { isUserPromptMessage } from "./user-prompt-message.js";

interface CodexToolUseConversion {
  callId: string;
  message: Message;
  context: CodexToolCallContext;
}

interface PendingExternalCodexToolCall {
  callId: string;
  context: CodexToolCallContext;
}

function appendNestedCodexPlanBlock(
  content: ContentBlock[],
  callId: string,
  context: CodexToolCallContext,
): void {
  if (context.toolName !== "CodexExec") return;
  const nestedPlan = extractCodexExecUpdatePlan(context.input);
  if (!nestedPlan) return;

  content.push({
    type: "tool_use",
    id: `${callId}-update-plan`,
    name: "UpdatePlan",
    input: nestedPlan,
    status: "completed",
  });
}

function normalizeClaudeQueueOperationContent(content: unknown): string {
  if (content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (!item || typeof item !== "object") {
        return "";
      }

      const type = (item as { type?: unknown }).type;
      if (type === "text") {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      if (type === "image") return "[Image]";
      if (type === "document") return "[Document]";
      if (type === "tool_result") return "[Tool Result]";

      return "";
    })
    .join("\n");
}

/**
 * Normalize a UnifiedSession into the generic Session format expected by the frontend.
 */
export function normalizeSession(loaded: LoadedSession): Session {
  const { summary, data } = loaded;

  switch (data.provider) {
    case "claude":
    case "claude-ollama": {
      const rawMessages = data.session.messages;
      const { entries, orphanedToolUses } = loaded.messagesAlreadyProjected
        ? {
            entries: rawMessages,
            orphanedToolUses: loaded.orphanedToolUses ?? new Set<string>(),
          }
        : collectVisibleClaudeEntries(rawMessages, {
            branchId: loaded.branchState?.selectedBranchId ?? undefined,
            sessionId: summary.id,
          });
      const messages: Message[] = entries.map((raw, index) =>
        convertClaudeMessage(raw, index, orphanedToolUses),
      );

      return {
        ...summary,
        branchState: loaded.branchState,
        messages: loaded.branchState
          ? annotateBranchMessages(messages, loaded.branchState)
          : messages,
      };
    }
    case "codex":
    case "codex-oss": {
      const branchState = loaded.codexBranchState ?? loaded.branchState;
      return {
        ...summary,
        branchState,
        codexBranchState: loaded.codexBranchState,
        messages: convertCodexEntries(
          applyCodexRollbackMarkers(data.session.entries),
          summary.id,
          branchState,
          {
            model: summary.model,
            provider: data.provider,
          },
        ),
      };
    }
    case "gemini":
      return {
        ...summary,
        messages: convertGeminiMessages(data.session.messages),
      };
    case "opencode": {
      const messages = convertOpenCodeEntries(data.session.messages);
      return {
        ...summary,
        branchState: loaded.branchState,
        messages: loaded.branchState
          ? annotateBranchMessages(messages, loaded.branchState)
          : messages,
      };
    }
    case "kimi":
      return {
        ...summary,
        messages: convertKimiMessages(data.session),
      };
  }
}

// --- Claude Conversion Logic ---

function convertClaudeMessage(
  raw: ClaudeSessionEntry,
  _index: number,
  orphanedToolUses: Set<string>,
): Message {
  if (raw.type === "queue-operation" && raw.operation === "enqueue") {
    const content = normalizeClaudeQueueOperationContent(raw.content).trim();
    const rawAny = raw as Record<string, unknown>;

    return {
      ...rawAny,
      id: `queue-operation-${_index}-${raw.timestamp}`,
      type: "user",
      role: "user",
      content,
      message: {
        role: "user",
        content,
      },
      deferred: true,
      deferredSource: "queue-operation",
    };
  }

  // Normalize content blocks - pass through all fields
  let content: string | ContentBlock[] | undefined;
  const rawContent = getMessageContent(raw);
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Pass through all fields from each content block
    // Filter out string items (which can appear in user message content)
    content = rawContent
      .filter((block) => typeof block !== "string")
      .map((block) => ({ ...(block as object) })) as ContentBlock[];
  }

  // Build message by spreading all raw fields, then override with normalized values
  // Use type assertion since we're converting to a looser Message type
  const rawAny = raw as Record<string, unknown>;
  const message: Message = {
    ...rawAny,
    // Include normalized content if message had content
    ...(isConversationEntry(raw) && {
      message: {
        ...(raw.message as Record<string, unknown>),
        ...(content !== undefined && { content }),
      },
    }),
    // Ensure type is set
    type: raw.type,
  };

  // Identify orphaned tool_use IDs in this message's content
  if (Array.isArray(content)) {
    const orphanedIds = content
      .filter(
        (b): b is ContentBlock & { id: string } =>
          b.type === "tool_use" &&
          typeof b.id === "string" &&
          orphanedToolUses.has(b.id),
      )
      .map((b) => b.id);

    if (orphanedIds.length > 0) {
      message.orphanedToolUseIds = orphanedIds;
    }
  }

  return message;
}

// --- Codex Conversion Logic ---

const CODEX_COMPACTION_EVENT_DEDUPE_WINDOW_MS = 5_000;

function timestampToMs(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function hasNearbyCodexCompactedEntry(
  compactedTimestamps: number[],
  timestamp: string | undefined,
): boolean {
  const eventTimestamp = timestampToMs(timestamp);
  if (eventTimestamp === null) return false;

  return compactedTimestamps.some(
    (compactedTimestamp) =>
      Math.abs(compactedTimestamp - eventTimestamp) <=
      CODEX_COMPACTION_EVENT_DEDUPE_WINDOW_MS,
  );
}

interface CodexContextSnapshotOptions {
  model?: string;
  provider: "codex" | "codex-oss";
}

function isCodexTokenCountImmediatelyAfterCompaction(
  entries: CodexSessionEntry[],
  tokenCountIndex: number,
): boolean {
  for (let i = tokenCountIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === "compacted") return true;
    if (
      entry.type === "event_msg" &&
      entry.payload.type === "context_compacted"
    ) {
      return true;
    }
    if (entry.type === "event_msg" && entry.payload.type === "token_count") {
      return false;
    }
  }

  return false;
}

function extractCodexTokenCountContextUsage(
  entries: CodexSessionEntry[],
  tokenCountIndex: number,
  options: CodexContextSnapshotOptions,
): ContextUsage | undefined {
  const entry = entries[tokenCountIndex];
  if (
    !entry ||
    entry.type !== "event_msg" ||
    entry.payload.type !== "token_count"
  ) {
    return undefined;
  }

  const info = entry.payload.info;
  const usage = info?.last_token_usage ?? info?.total_token_usage;
  if (!usage) return undefined;

  let inputTokens = usage.input_tokens;
  if (
    inputTokens === 0 &&
    usage.total_tokens > 0 &&
    isCodexTokenCountImmediatelyAfterCompaction(entries, tokenCountIndex)
  ) {
    inputTokens = usage.total_tokens;
  }
  if (inputTokens <= 0) return undefined;

  const contextWindow =
    info?.model_context_window && info.model_context_window > 0
      ? info.model_context_window
      : getModelContextWindow(options.model, options.provider);

  const result: ContextUsage = {
    inputTokens,
    percentage: Math.min(100, Math.round((inputTokens / contextWindow) * 100)),
    contextWindow,
  };

  if (usage.output_tokens > 0) {
    result.outputTokens = usage.output_tokens;
  }
  if ((usage.cached_input_tokens ?? 0) > 0) {
    result.cacheReadTokens = usage.cached_input_tokens;
  }

  return result;
}

function convertCodexEntries(
  entries: CodexSessionEntry[],
  sessionId: string,
  branchState?: SessionBranchState,
  contextOptions: CodexContextSnapshotOptions = { provider: "codex" },
): Message[] {
  const messages: Message[] = [];
  let messageIndex = 0;
  let pendingContextMessage: Message | null = null;
  const hasResponseItemUser = hasCodexResponseItemUserMessages(entries);
  const compactedTimestamps = entries
    .filter((entry) => entry.type === "compacted")
    .map((entry) => timestampToMs(entry.timestamp))
    .filter((timestamp): timestamp is number => timestamp !== null);
  const toolCallContexts = new Map<string, CodexToolCallContext>();
  const externalToolCalls: PendingExternalCodexToolCall[] = [];
  const responseItemImageGenerationIds =
    collectResponseItemImageGenerationIds(entries);
  const imageGenerationEndKeys = collectCodexImageGenerationEndKeys(entries);
  const patchApplyEndByCallId = collectCodexPatchApplyEndEvents(entries);
  const directEditCallIds = collectCodexDirectEditCallIds(entries);

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (!entry) continue;

    if (entry.type === "response_item") {
      const converted = convertCodexResponseItem(
        entry,
        messageIndex++,
        toolCallContexts,
        externalToolCalls,
        {
          skippedImageGenerationCallKeys: imageGenerationEndKeys,
          patchApplyEndByCallId,
        },
      );
      const convertedMessages = Array.isArray(converted)
        ? converted
        : converted
          ? [converted]
          : [];
      for (const msg of convertedMessages) {
        if (isCodexCorrelationDebugEnabled()) {
          logCodexCorrelationDebug({
            sessionId,
            channel: "jsonl",
            authority: "durable",
            entryType: entry.type,
            payloadType: entry.payload.type,
            eventKind: getCodexResponseEventKind(entry.payload),
            callId: getCodexResponsePayloadCallId(entry.payload),
            itemId: getCodexResponsePayloadItemId(entry.payload),
            ...summarizeCodexNormalizedMessage(msg),
          });
        }
        messages.push(msg);
        if (isUserPromptMessage(msg)) {
          pendingContextMessage = msg;
        }
      }
    } else if (entry.type === "compacted") {
      pendingContextMessage = null;
      const msg = convertCodexCompactedEntry(entry, messageIndex++);
      if (msg) {
        if (isCodexCorrelationDebugEnabled()) {
          logCodexCorrelationDebug({
            sessionId,
            channel: "jsonl",
            authority: "durable",
            entryType: entry.type,
            eventKind: "context_compacted",
            ...summarizeCodexNormalizedMessage(msg),
          });
        }
        messages.push(msg);
      }
    } else if (entry.type === "event_msg") {
      if (entry.payload.type === "token_count") {
        const contextUsage = extractCodexTokenCountContextUsage(
          entries,
          entryIndex,
          contextOptions,
        );
        if (contextUsage && pendingContextMessage) {
          pendingContextMessage.contextBefore = contextUsage;
          pendingContextMessage = null;
        }
        continue;
      }

      const shouldIncludeUserMessage =
        entry.payload.type === "user_message" && !hasResponseItemUser;
      const shouldIncludeTurnAborted = entry.payload.type === "turn_aborted";
      const shouldIncludeContextCompacted =
        entry.payload.type === "context_compacted" &&
        !hasNearbyCodexCompactedEntry(compactedTimestamps, entry.timestamp);
      if (entry.payload.type === "context_compacted") {
        pendingContextMessage = null;
      }
      const imageGenerationMessages =
        entry.payload.type === "item_completed"
          ? convertCodexItemCompletedImageGeneration(
              entry,
              messageIndex,
              responseItemImageGenerationIds,
            )
          : entry.payload.type === "image_generation_end"
            ? convertCodexImageGenerationEndEvent(entry, messageIndex)
            : null;
      const patchApplyPayload =
        entry.payload.type === "patch_apply_end" ? entry.payload : null;
      const patchApplyMessages = patchApplyPayload
        ? convertCodexPatchApplyEndEvent(
            entry,
            messageIndex,
            !directEditCallIds.has(patchApplyPayload.call_id),
          )
        : null;
      // Skip agent_message and agent_reasoning events when response_item exists;
      // those are streaming artifacts that duplicate full response data.
      if (patchApplyMessages && patchApplyPayload) {
        messageIndex++;
        for (const msg of patchApplyMessages) {
          if (isCodexCorrelationDebugEnabled()) {
            logCodexCorrelationDebug({
              sessionId,
              channel: "jsonl",
              authority: "durable",
              entryType: entry.type,
              payloadType: entry.payload.type,
              eventKind: "file_change",
              turnId: getCodexEventPayloadTurnId(entry.payload),
              callId: patchApplyPayload.call_id,
              status: normalizeCodexFileChangeStatus(
                patchApplyPayload.status,
                patchApplyPayload.success,
              ),
              ...summarizeCodexNormalizedMessage(msg),
            });
          }
          messages.push(msg);
        }
      } else if (imageGenerationMessages) {
        messageIndex++;
        for (const msg of imageGenerationMessages) {
          if (isCodexCorrelationDebugEnabled()) {
            logCodexCorrelationDebug({
              sessionId,
              channel: "jsonl",
              authority: "durable",
              entryType: entry.type,
              payloadType: entry.payload.type,
              eventKind: "image_generation",
              turnId: getCodexEventPayloadTurnId(entry.payload),
              itemId: getCodexEventPayloadItemId(entry.payload),
              ...summarizeCodexNormalizedMessage(msg),
            });
          }
          messages.push(msg);
        }
      } else if (
        shouldIncludeUserMessage ||
        shouldIncludeTurnAborted ||
        shouldIncludeContextCompacted
      ) {
        const msg = convertCodexEventMsg(entry, messageIndex++);
        if (msg) {
          if (isCodexCorrelationDebugEnabled()) {
            logCodexCorrelationDebug({
              sessionId,
              channel: "jsonl",
              authority: "durable",
              entryType: entry.type,
              payloadType: entry.payload.type,
              eventKind: entry.payload.type,
              turnId: getCodexEventPayloadTurnId(entry.payload),
              itemId: getCodexEventPayloadItemId(entry.payload),
              ...summarizeCodexNormalizedMessage(msg),
            });
          }
          messages.push(msg);
          if (isUserPromptMessage(msg)) {
            pendingContextMessage = msg;
          }
        }
      }
    }
  }

  return branchState
    ? annotateBranchMessages(messages, branchState, { includeCodexAlias: true })
    : messages;
}

function getNormalizedUserText(message: Message): string | null {
  if (message.type !== "user") return null;

  const content = message.message?.content ?? message.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text.length > 0 ? content : null;
  }

  if (!Array.isArray(content)) return null;

  const text = content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String(block.text ?? "")
        : "",
    )
    .join("");
  return text.trim().length > 0 ? text : null;
}

function branchMessageKey(timestamp: string | undefined, prompt: string) {
  return `${timestamp ?? ""}\n${prompt}`;
}

function annotateBranchMessages(
  messages: Message[],
  branchState: SessionBranchState,
  options: { includeCodexAlias?: boolean } = {},
): Message[] {
  if (branchState.branches.length === 0) {
    return messages;
  }

  const branchById = new Map<string, SessionBranchOption>();
  const branchByKey = new Map<string, SessionBranchOption>();
  const branchesByParent = new Map<string, SessionBranchOption[]>();

  for (const branch of branchState.branches) {
    branchById.set(branch.id, branch);
    branchByKey.set(branchMessageKey(branch.createdAt, branch.prompt), branch);

    const parentKey = branch.parentId ?? "<root>";
    const siblings = branchesByParent.get(parentKey) ?? [];
    siblings.push(branch);
    branchesByParent.set(parentKey, siblings);
  }

  for (const siblings of branchesByParent.values()) {
    siblings.sort((a, b) => a.siblingIndex - b.siblingIndex);
  }

  return messages.map((message) => {
    const text = getNormalizedUserText(message);
    if (!text) return message;

    const messageId =
      typeof message.uuid === "string"
        ? message.uuid
        : typeof message.id === "string"
          ? message.id
          : undefined;
    const branch =
      (messageId ? branchById.get(messageId) : undefined) ??
      branchByKey.get(branchMessageKey(message.timestamp, text));
    if (!branch || branch.siblingCount <= 1) return message;

    const parentKey = branch.parentId ?? "<root>";
    const alternatives = branchesByParent.get(parentKey) ?? [branch];
    const branchMetadata = {
      // OpenCode edit alternatives span native sessions. Claude and Codex
      // options still carry the same session id as branchState.sessionId.
      sessionId: branch.sessionId,
      branchId: branch.id,
      activeBranchId: branchState.activeBranchId,
      selectedBranchId: branchState.selectedBranchId,
      parentId: branch.parentId,
      siblingIndex: branch.siblingIndex,
      siblingCount: branch.siblingCount,
      alternatives,
    };

    return {
      ...message,
      branch: branchMetadata,
      ...(options.includeCodexAlias && { codexBranch: branchMetadata }),
    };
  });
}

function getCodexResponseEventKind(
  payload: CodexResponseItemEntry["payload"],
): string {
  if (payload.type === "message") {
    return payload.role === "assistant" ? "assistant_message" : "user_message";
  }
  return payload.type;
}

function getCodexResponsePayloadCallId(
  payload: CodexResponseItemEntry["payload"],
): string | undefined {
  switch (payload.type) {
    case "function_call":
    case "function_call_output":
      return payload.call_id;
    case "custom_tool_call":
    case "custom_tool_call_output":
    case "web_search_call":
      return typeof payload.call_id === "string"
        ? payload.call_id
        : typeof payload.id === "string"
          ? payload.id
          : undefined;
    default:
      return undefined;
  }
}

function getCodexResponsePayloadItemId(
  payload: CodexResponseItemEntry["payload"],
): string | undefined {
  switch (payload.type) {
    case "function_call":
    case "function_call_output":
      return payload.call_id;
    case "custom_tool_call":
    case "custom_tool_call_output":
    case "web_search_call":
      return typeof payload.id === "string"
        ? payload.id
        : typeof payload.call_id === "string"
          ? payload.call_id
          : undefined;
    default:
      return undefined;
  }
}

function getCodexEventPayloadTurnId(
  payload: CodexEventMsgEntry["payload"],
): string | undefined {
  return "turn_id" in payload && typeof payload.turn_id === "string"
    ? payload.turn_id
    : undefined;
}

function getCodexEventPayloadItemId(
  payload: CodexEventMsgEntry["payload"],
): string | undefined {
  if (payload.type !== "item_completed") {
    return undefined;
  }

  if (!payload.item || typeof payload.item !== "object") {
    return undefined;
  }

  const item = payload.item as { id?: unknown };
  return typeof item.id === "string" ? item.id : undefined;
}

function hasCodexResponseItemUserMessages(
  entries: CodexSessionEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "response_item" &&
      entry.payload.type === "message" &&
      entry.payload.role === "user",
  );
}

function collectResponseItemImageGenerationIds(
  entries: CodexSessionEntry[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (!isCodexImageGenerationRecord(payload)) continue;
    const id = getFirstString((payload as Record<string, unknown>).id);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function collectCodexPatchApplyEndEvents(
  entries: CodexSessionEntry[],
): Map<string, CodexPatchApplyEndEvent> {
  const events = new Map<string, CodexPatchApplyEndEvent>();
  for (const entry of entries) {
    if (
      entry.type === "event_msg" &&
      entry.payload.type === "patch_apply_end"
    ) {
      events.set(entry.payload.call_id, entry.payload);
    }
  }
  return events;
}

function collectCodexDirectEditCallIds(
  entries: CodexSessionEntry[],
): Set<string> {
  const callIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (
      payload.type !== "function_call" &&
      payload.type !== "custom_tool_call"
    ) {
      continue;
    }
    const rawName = payload.name;
    if (
      typeof rawName === "string" &&
      canonicalizeCodexToolName(rawName, payload.namespace ?? undefined) ===
        "Edit"
    ) {
      const callId = getCodexResponsePayloadCallId(payload);
      if (callId) callIds.add(callId);
    }
  }
  return callIds;
}

function collectCodexImageGenerationEndKeys(
  entries: CodexSessionEntry[],
): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (
      entry.type !== "event_msg" ||
      entry.payload.type !== "image_generation_end"
    ) {
      continue;
    }

    for (const key of collectCodexImageGenerationRecordKeys(
      entry.payload as Record<string, unknown>,
    )) {
      keys.add(key);
    }
  }
  return keys;
}

function collectCodexImageGenerationRecordKeys(
  record: Record<string, unknown>,
): string[] {
  const image = normalizeCodexImageGenerationRecord(record);
  const keys: string[] = [];
  if (image.id) keys.push(`id:${image.id}`);
  if (image.path) keys.push(`path:${image.path}`);
  if (image.url) keys.push(`url:${image.url}`);
  if (image.result) keys.push(`result:${image.result}`);
  return keys;
}

function hasMatchingCodexImageGenerationRecordKey(
  record: Record<string, unknown>,
  keys?: Set<string>,
): boolean {
  if (!keys?.size) return false;
  return collectCodexImageGenerationRecordKeys(record).some((key) =>
    keys.has(key),
  );
}

function convertCodexItemCompletedImageGeneration(
  entry: CodexEventMsgEntry,
  index: number,
  responseItemImageGenerationIds: Set<string>,
): Message[] | null {
  if (entry.payload.type !== "item_completed") {
    return null;
  }

  const item = entry.payload.item;
  if (!isRecord(item) || !isCodexImageGenerationRecord(item)) {
    return null;
  }

  const itemId = getFirstString(item.id);
  if (itemId && responseItemImageGenerationIds.has(itemId)) {
    return null;
  }

  return convertCodexImageGenerationRecord(
    item,
    `codex-event-${index}-${entry.timestamp}`,
    entry.timestamp,
  );
}

function convertCodexImageGenerationEndEvent(
  entry: CodexEventMsgEntry,
  index: number,
): Message[] | null {
  if (entry.payload.type !== "image_generation_end") {
    return null;
  }

  return convertCodexImageGenerationRecord(
    entry.payload as Record<string, unknown>,
    `codex-event-${index}-${entry.timestamp}`,
    entry.timestamp,
  );
}

function convertCodexPatchApplyEndEvent(
  entry: CodexEventMsgEntry,
  index: number,
  includeToolUse = true,
): Message[] | null {
  if (entry.payload.type !== "patch_apply_end") {
    return null;
  }

  const payload = entry.payload;
  const changes = normalizeCodexFileChanges(payload.changes);
  const status = normalizeCodexFileChangeStatus(
    payload.status,
    payload.success,
  );
  const isError = isCodexFileChangeError(status);
  const stdout = payload.stdout?.trim() ?? "";
  const stderr = payload.stderr?.trim() ?? "";
  const fallbackResult = formatCodexFileChangeResult(changes, status);
  const resultText = isError
    ? [stderr, stdout].filter(Boolean).join("\n") || fallbackResult
    : stdout || stderr || fallbackResult;
  const uuid = `codex-${index}-${entry.timestamp}-patch`;

  const toolUseMessage: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: payload.call_id,
          name: "Edit",
          input: buildCodexEditInput(changes),
          status: isError ? "error" : "completed",
        },
      ],
    },
    codexToolName: "apply_patch",
    timestamp: entry.timestamp,
  };
  const toolResultMessage: Message = {
    uuid: `${uuid}-result`,
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: payload.call_id,
          content: resultText,
          ...(isError && { is_error: true }),
        },
      ],
    },
    timestamp: entry.timestamp,
  };

  return includeToolUse
    ? [toolUseMessage, toolResultMessage]
    : [toolResultMessage];
}

function convertCodexResponseItem(
  entry: CodexResponseItemEntry,
  index: number,
  toolCallContexts: Map<string, CodexToolCallContext>,
  externalToolCalls: PendingExternalCodexToolCall[],
  options: {
    skippedImageGenerationCallKeys?: Set<string>;
    patchApplyEndByCallId?: ReadonlyMap<string, CodexPatchApplyEndEvent>;
  } = {},
): Message | Message[] | null {
  const payload = entry.payload;
  const uuid = `codex-${index}-${entry.timestamp}`;

  switch (payload.type) {
    case "message":
      if (payload.role === "developer") {
        return null;
      }
      return convertCodexMessagePayload(
        payload,
        uuid,
        entry.timestamp,
        externalToolCalls,
      );

    case "reasoning":
      return convertCodexReasoningPayload(payload, uuid, entry.timestamp);

    case "function_call": {
      const converted = convertCodexFunctionCallPayload(
        payload,
        uuid,
        entry.timestamp,
      );
      enrichCodexEditConversionWithPatchEvent(
        converted,
        options.patchApplyEndByCallId?.get(converted.callId),
      );
      toolCallContexts.set(converted.callId, converted.context);
      return converted.message;
    }

    case "function_call_output":
      if (options.patchApplyEndByCallId?.has(payload.call_id)) {
        return null;
      }
      return convertCodexToolCallOutputPayload(
        payload.call_id,
        payload.output,
        uuid,
        entry.timestamp,
        toolCallContexts.get(payload.call_id),
      );

    case "custom_tool_call": {
      const converted = convertCodexCustomToolCallPayload(
        payload,
        uuid,
        entry.timestamp,
      );
      enrichCodexEditConversionWithPatchEvent(
        converted,
        options.patchApplyEndByCallId?.get(converted.callId),
      );
      toolCallContexts.set(converted.callId, converted.context);
      return converted.message;
    }

    case "custom_tool_call_output": {
      const customCallId = payload.call_id ?? `${uuid}-custom-tool-result`;
      if (options.patchApplyEndByCallId?.has(customCallId)) {
        return null;
      }
      return convertCodexToolCallOutputPayload(
        customCallId,
        payload.output,
        uuid,
        entry.timestamp,
        toolCallContexts.get(customCallId),
      );
    }

    case "web_search_call":
      return convertCodexWebSearchCallPayload(payload, uuid, entry.timestamp);

    case "image_generation":
    case "imageGeneration":
    case "image_generation_call":
      if (
        payload.type === "image_generation_call" &&
        hasMatchingCodexImageGenerationRecordKey(
          payload as Record<string, unknown>,
          options.skippedImageGenerationCallKeys,
        )
      ) {
        return null;
      }
      return convertCodexImageGenerationPayload(payload, uuid, entry.timestamp);

    case "ghost_snapshot":
      return null;

    default:
      return null;
  }
}

function enrichCodexEditConversionWithPatchEvent(
  conversion: CodexToolUseConversion,
  event: CodexPatchApplyEndEvent | undefined,
): void {
  if (!event || conversion.context.toolName !== "Edit") return;

  const changes = normalizeCodexFileChanges(event.changes);
  if (changes.length === 0) return;

  const editInput = buildCodexEditInput(changes);
  const currentInput = conversion.context.input;
  const mergedInput = isRecord(currentInput)
    ? { ...currentInput, ...editInput }
    : {
        ...(currentInput !== undefined ? { input: currentInput } : {}),
        ...editInput,
      };
  conversion.context.input = mergedInput;

  const content = conversion.message.message?.content;
  if (!Array.isArray(content)) return;
  const toolUse = content.find(
    (block) =>
      block.type === "tool_use" &&
      block.id === conversion.callId &&
      block.name === "Edit",
  );
  if (toolUse) {
    toolUse.input = mergedInput;
  }
}

function convertCodexImageGenerationPayload(
  payload: CodexImageGenerationPayload,
  uuid: string,
  timestamp: string,
): Message[] {
  return convertCodexImageGenerationRecord(
    payload as Record<string, unknown>,
    uuid,
    timestamp,
  );
}

function convertCodexImageGenerationRecord(
  record: Record<string, unknown>,
  uuid: string,
  timestamp: string,
): Message[] {
  const image = normalizeCodexImageGenerationRecord(record);
  const callId = image.id ?? `${uuid}-image-generation`;

  const input: Record<string, unknown> = {
    title: "Generated image",
    ...(image.path ? { path: image.path } : {}),
    ...(image.url ? { url: image.url } : {}),
    ...(image.status ? { status: image.status } : {}),
    ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
    ...(!image.path && !image.url && image.result
      ? { result: summarizeCodexImageGenerationResult(image.result) }
      : {}),
  };

  const toolUseMessage: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "ViewImage",
          input,
        },
      ],
    },
    codexToolName: "imageGeneration",
    timestamp,
  };

  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: callId,
    content: buildCodexImageGenerationResultText({
      path: image.path,
      url: image.url,
      status: image.status,
      result: image.result,
    }),
  };

  return [
    toolUseMessage,
    {
      uuid: `${uuid}-result`,
      type: "user",
      message: {
        role: "user",
        content: [toolResult],
      },
      toolUseResult: {
        type: "image",
        ...(image.path ? { path: image.path } : {}),
        ...(image.url ? { url: image.url } : {}),
        ...(image.status ? { status: image.status } : {}),
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      },
      timestamp,
    },
  ];
}

function convertCodexMessagePayload(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
  externalToolCalls: PendingExternalCodexToolCall[],
): Message | null {
  const codexMessagePhase =
    payload.role === "assistant"
      ? normalizeCodexMessagePhase(payload.phase)
      : undefined;

  if (payload.role === "assistant") {
    const externalToolMessage = convertExternalAgentToolMarkerPayload(
      payload,
      uuid,
      timestamp,
      externalToolCalls,
    );
    if (externalToolMessage) {
      return externalToolMessage;
    }
  }

  const content: ContentBlock[] = [];

  const fullText = payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");

  if (
    payload.role === "user" &&
    fullText.trim() &&
    isCodexTurnAbortedNoticeText(fullText)
  ) {
    return null;
  }

  if (fullText.trim()) {
    content.push({
      type: "text",
      text: fullText,
    });
  }

  for (const block of payload.content) {
    if (block.type !== "input_image") continue;
    content.push(normalizeCodexInputImageBlock(block));
  }

  if (content.length === 0) {
    return {
      uuid,
      type: payload.role,
      ...(codexMessagePhase ? { codexMessagePhase } : {}),
      message: {
        role: payload.role,
        content: [],
      },
      timestamp,
    };
  }

  return {
    uuid,
    type: payload.role,
    ...(codexMessagePhase ? { codexMessagePhase } : {}),
    message: {
      role: payload.role,
      content,
    },
    timestamp,
  };
}

function normalizeCodexMessagePhase(
  phase: CodexMessagePhase,
): "commentary" | "final_answer" | undefined {
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

function convertCodexReasoningPayload(
  payload: CodexReasoningPayload,
  uuid: string,
  timestamp: string,
): Message | null {
  const summaryText = payload.summary
    ?.map((s) => s.text)
    .join("\n")
    .trim();

  if (!summaryText) {
    return null;
  }

  return {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: summaryText,
        },
      ],
    },
    timestamp,
  };
}

type CodexInputImageBlock = Extract<
  CodexMessagePayload["content"][number],
  { type: "input_image" }
>;

function normalizeCodexInputImageBlock(
  block: CodexInputImageBlock,
): ContentBlock {
  const normalized: ContentBlock = { type: "input_image" };

  const filePath =
    typeof block.file_path === "string" ? block.file_path.trim() : "";
  if (filePath) {
    normalized.file_path = filePath;
  }

  const mimeType = resolveCodexInputImageMimeType(block);
  if (mimeType) {
    normalized.mime_type = mimeType;
  }

  const imageUrl =
    typeof block.image_url === "string" ? block.image_url.trim() : "";
  if (imageUrl) {
    normalized.image_url = imageUrl;
  }

  return normalized;
}

function resolveCodexInputImageMimeType(
  block: CodexInputImageBlock,
): string | undefined {
  const explicitMime =
    typeof block.mime_type === "string" ? block.mime_type.trim() : "";
  if (explicitMime) {
    return explicitMime;
  }

  if (typeof block.image_url !== "string") {
    return undefined;
  }

  const dataUrlMime = parseDataUrlMimeType(block.image_url);
  return dataUrlMime || undefined;
}

function parseDataUrlMimeType(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1] ?? null;
}

function convertExternalAgentToolMarkerPayload(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
  externalToolCalls: PendingExternalCodexToolCall[],
): Message | null {
  const text = payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");

  const toolCall = parseExternalAgentToolCallText(text);
  if (toolCall) {
    const converted = convertExternalAgentToolCall(toolCall, uuid, timestamp);
    externalToolCalls.push({
      callId: converted.callId,
      context: converted.context,
    });
    return converted.message;
  }

  const toolResult = parseExternalAgentToolResultText(text);
  if (!toolResult) {
    return null;
  }

  const pendingCall = externalToolCalls.shift();
  if (!pendingCall) {
    return null;
  }

  return convertCodexToolCallOutputPayload(
    pendingCall.callId,
    toolResult.output,
    uuid,
    timestamp,
    pendingCall.context,
    toolResult.isError,
  );
}

function parseExternalAgentToolCallText(
  text: string,
): { toolName: string; input: unknown } | null {
  const match =
    /^\[external_agent_tool_call:\s*([^\]\n]+)\]\n?([\s\S]*?)\n?\[\/external_agent_tool_call\]$/.exec(
      text.trim(),
    );
  if (!match?.[1]) {
    return null;
  }

  return {
    toolName: match[1].trim(),
    input: parseExternalAgentToolInput(match[2] ?? ""),
  };
}

function parseExternalAgentToolResultText(
  text: string,
): { output: string; isError: boolean } | null {
  const match =
    /^\[external_agent_tool_result(?::\s*([^\]\n]+))?\]\n?([\s\S]*?)\n?\[\/external_agent_tool_result\]$/.exec(
      text.trim(),
    );
  if (!match) {
    return null;
  }

  const status = match[1]?.trim().toLowerCase();
  return {
    output: match[2] ?? "",
    isError: status === "error",
  };
}

function parseExternalAgentToolInput(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }

  const inputMatch = /^input:\s*([\s\S]*)$/.exec(trimmed);
  if (inputMatch?.[1]) {
    return parseExternalAgentToolValue(inputMatch[1].trim());
  }

  const lines = trimmed.split("\n");
  const input: Record<string, unknown> = {};
  let sawField = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!fieldMatch?.[1]) {
      continue;
    }

    sawField = true;
    const key = normalizeExternalAgentToolInputKey(fieldMatch[1]);
    const value = fieldMatch[2] ?? "";

    if (key === "command") {
      input.command = [value, ...lines.slice(i + 1)].join("\n").trimEnd();
      break;
    }

    input[key] = parseExternalAgentToolValue(value.trim());
  }

  return sawField ? input : { content: trimmed };
}

function normalizeExternalAgentToolInputKey(key: string): string {
  const normalized = key.trim();
  if (normalized === "file" || normalized === "path") {
    return "file_path";
  }
  return normalized;
}

function parseExternalAgentToolValue(value: string): unknown {
  if (!value) {
    return "";
  }

  if (/^(?:\{|\[|"|-?\d|true$|false$|null$)/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

function convertExternalAgentToolCall(
  marker: { toolName: string; input: unknown },
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const rawToolName = marker.toolName;
  const canonicalToolName = canonicalizeCodexToolName(rawToolName);
  const normalizedInvocation = normalizeCodexToolInvocation(
    canonicalToolName,
    marker.input,
  );
  const callId = `${uuid}-external-tool`;

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
    },
  ];
  appendNestedCodexPlanBlock(content, callId, {
    toolName: normalizedInvocation.toolName,
    input: normalizedInvocation.input,
  });

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  return {
    callId,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
      writeShellInfo: normalizedInvocation.writeShellInfo,
    },
  };
}

function convertCodexFunctionCallPayload(
  payload: CodexFunctionCallPayload,
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const rawToolName = payload.name;
  const parsedInput = parseCodexToolArguments(payload.arguments);
  const normalizedInvocation =
    deriveCodexWebRunInvocation(
      rawToolName,
      payload.namespace ?? undefined,
      parsedInput,
    ) ??
    normalizeCodexToolInvocation(
      canonicalizeCodexToolName(rawToolName),
      parsedInput,
    );

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: payload.call_id,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
    },
  ];
  appendNestedCodexPlanBlock(content, payload.call_id, {
    toolName: normalizedInvocation.toolName,
    input: normalizedInvocation.input,
  });

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  return {
    callId: payload.call_id,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
      writeShellInfo: normalizedInvocation.writeShellInfo,
    },
  };
}

function convertCodexCustomToolCallPayload(
  payload: CodexCustomToolCallPayload,
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const callId = payload.call_id ?? payload.id ?? `${uuid}-custom-tool`;
  const rawToolName = payload.name ?? "custom_tool_call";
  const canonicalToolName = canonicalizeCodexToolName(
    rawToolName,
    payload.namespace,
  );
  const rawInput =
    payload.input !== undefined
      ? payload.input
      : parseCodexToolArguments(payload.arguments);
  const normalizedInvocation = normalizeCodexToolInvocation(
    canonicalToolName,
    rawInput,
  );

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
    },
  ];
  appendNestedCodexPlanBlock(content, callId, {
    toolName: normalizedInvocation.toolName,
    input: normalizedInvocation.input,
  });

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    ...(payload.namespace ? { codexToolNamespace: payload.namespace } : {}),
    timestamp,
  };

  return {
    callId,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
      writeShellInfo: normalizedInvocation.writeShellInfo,
    },
  };
}

function convertCodexWebSearchCallPayload(
  payload: CodexWebSearchCallPayload,
  uuid: string,
  timestamp: string,
): Message[] {
  const callId = payload.call_id ?? payload.id ?? `${uuid}-web-search`;
  const rawToolName = payload.name ?? payload.type;
  const toolName = canonicalizeCodexToolName(rawToolName);
  const payloadRecord = payload as Record<string, unknown>;
  const status =
    typeof payloadRecord.status === "string" ? payloadRecord.status : undefined;

  const parsedArguments = parseCodexToolArguments(payload.arguments);
  let input: Record<string, unknown>;

  if (isRecord(payload.input)) {
    input = { ...payload.input };
  } else if (isRecord(parsedArguments)) {
    input = { ...parsedArguments };
  } else {
    input = {};
  }

  if (typeof payload.query === "string" && typeof input.query !== "string") {
    input.query = payload.query;
  }

  if (payload.action !== undefined && input.action === undefined) {
    input.action = payload.action;
  }
  const actionSummary = summarizeCodexWebSearchAction(payload.action);
  if (typeof input.query !== "string" && actionSummary.query) {
    input.query = actionSummary.query;
  }
  if (actionSummary.label && typeof input.query !== "string") {
    input.query = actionSummary.label;
  }

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: toolName,
      input,
    },
  ];

  const toolUseMessage: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  if (status !== "completed" && status !== "complete") {
    return [toolUseMessage];
  }

  const query =
    typeof input.query === "string" && input.query.trim()
      ? input.query
      : actionSummary.label || "Codex web search";
  const result = {
    query,
    results: [],
    codexActionLabel: actionSummary.label,
    codexAction: payload.action,
  };
  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: callId,
    content: actionSummary.label
      ? `Codex web search completed: ${actionSummary.label}`
      : "Codex web search completed",
  };

  return [
    toolUseMessage,
    {
      uuid: `${uuid}-result`,
      type: "user",
      message: {
        role: "user",
        content: [toolResult],
      },
      toolUseResult: result,
      timestamp,
    },
  ];
}

function summarizeCodexWebSearchAction(action: unknown): {
  label?: string;
  query?: string;
} {
  if (!isRecord(action)) {
    return {};
  }

  const actionType =
    typeof action.type === "string" && action.type.trim()
      ? action.type.trim()
      : undefined;

  if (actionType === "search") {
    const query = getFirstString(
      action.query,
      Array.isArray(action.queries) ? action.queries[0] : undefined,
    );
    return {
      ...(query ? { query } : {}),
      label: query ? `Search: ${query}` : "Search",
    };
  }

  if (actionType === "open_page" || actionType === "openPage") {
    const url = getFirstString(action.url);
    return {
      ...(url ? { query: url } : {}),
      label: url ? `Open page: ${url}` : "Open page",
    };
  }

  if (actionType === "find_in_page" || actionType === "findInPage") {
    const pattern = getFirstString(action.pattern);
    const url = getFirstString(action.url);
    const target = [pattern, url].filter(Boolean).join(" @ ");
    return {
      ...(target ? { query: target } : {}),
      label: target ? `Find in page: ${target}` : "Find in page",
    };
  }

  return actionType ? { label: actionType } : {};
}

function getFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function convertCodexToolCallOutputPayload(
  callId: string,
  output: unknown,
  uuid: string,
  timestamp: string,
  context?: CodexToolCallContext,
  forceError = false,
): Message {
  const normalized = normalizeCodexToolOutputWithContext(output, context);
  const content = normalized.content;
  const structured = normalized.structured;
  const isError = forceError || normalized.isError;

  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: callId,
    content,
    ...(isError && { is_error: true }),
  };

  return {
    uuid,
    type: "user",
    message: {
      role: "user",
      content: [toolResult],
    },
    ...(structured !== undefined && {
      toolUseResult: structured,
    }),
    timestamp,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function convertCodexCompactedEntry(
  entry: CodexCompactedEntry,
  index: number,
): Message {
  const uuid = `codex-compacted-${index}-${entry.timestamp}`;
  return {
    uuid,
    type: "system",
    subtype: "compact_boundary",
    content: entry.payload.message || "Context compacted",
    timestamp: entry.timestamp,
  };
}

function convertCodexEventMsg(
  entry: CodexEventMsgEntry,
  index: number,
): Message | null {
  const payload = entry.payload;
  const uuid = `codex-event-${index}-${entry.timestamp}`;

  switch (payload.type) {
    case "user_message":
      return {
        uuid,
        type: "user",
        message: {
          role: "user",
          content: payload.message,
        },
        timestamp: entry.timestamp,
      };

    case "agent_message":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: payload.message }],
        },
        timestamp: entry.timestamp,
      };

    case "agent_reasoning":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: payload.text }],
        },
        timestamp: entry.timestamp,
      };

    case "turn_aborted":
      return {
        uuid,
        type: "system",
        subtype: "turn_aborted",
        content: CODEX_TURN_ABORTED_DISPLAY_TEXT,
        timestamp: entry.timestamp,
      };

    case "context_compacted":
      return {
        uuid,
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
        timestamp: entry.timestamp,
      };

    case "item_completed":
      return null;

    default:
      return null;
  }
}

// --- Gemini Conversion Logic ---

function convertGeminiMessages(
  sessionMessages: GeminiSessionMessage[],
): Message[] {
  const messages: Message[] = [];
  for (const msg of sessionMessages) {
    if (msg.type === "user") {
      const userMsg = msg as GeminiUserMessage;
      messages.push({
        uuid: userMsg.id,
        type: "user",
        message: {
          role: "user",
          content: getGeminiUserMessageText(userMsg.content),
        },
        timestamp: userMsg.timestamp,
      });
    } else if (msg.type === "gemini") {
      const assistantMsg = msg as GeminiAssistantMessage;
      const content: ContentBlock[] = [];

      if (assistantMsg.thoughts) {
        for (const thought of assistantMsg.thoughts) {
          content.push({
            type: "thinking",
            thinking: `${thought.subject}: ${thought.description}`,
          });
        }
      }

      if (assistantMsg.content) {
        content.push({
          type: "text",
          text: assistantMsg.content,
        });
      }

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.args,
          });
        }
      }

      messages.push({
        uuid: assistantMsg.id,
        type: "assistant",
        message: {
          role: "assistant",
          content,
        },
        timestamp: assistantMsg.timestamp,
      });

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          if (toolCall.result && toolCall.result.length > 0) {
            for (const result of toolCall.result) {
              messages.push({
                uuid: `${assistantMsg.id}-result-${result.functionResponse.id}`,
                type: "tool_result",
                toolUseResult: {
                  tool_use_id: result.functionResponse.id,
                  content: result.functionResponse.response.output,
                },
                timestamp: toolCall.timestamp ?? assistantMsg.timestamp,
              });
            }
          }
        }
      }
    }
  }
  return messages;
}

/**
 * Build the normalized content for one Kimi user turn.
 *
 * Text-only turns stay a plain string (the common case, and what the client's
 * prompt parser expects). When the turn carried images, they are emitted as
 * `input_image` blocks — the same shape Codex uses, so the client renders them
 * as attachment chips with an inline preview without provider-specific code.
 *
 * `blobref:` parts are served through `/api/local-image`; the blobs directory
 * is allow-listed alongside yep's own uploads. `data:` urls are passed straight
 * through as the preview source.
 */
function buildKimiUserContent(
  input: readonly unknown[],
  blobsDir: string | undefined,
): string | ContentBlock[] {
  const text = getKimiPromptText(input);
  const images = getKimiPromptImages(input);
  if (images.length === 0) return text;

  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: "text", text } as ContentBlock);

  for (const image of images) {
    const block: Record<string, unknown> = {
      type: "input_image",
      mime_type: image.mimeType,
    };
    if (image.blobHash && blobsDir) {
      const path = join(blobsDir, image.blobHash);
      block.file_path = path;
      block.image_url = `/api/local-image?path=${encodeURIComponent(path)}`;
    } else if (!image.blobHash) {
      block.image_url = image.url;
    }
    blocks.push(block as ContentBlock);
  }

  return blocks;
}

// --- Kimi Conversion Logic ---

/**
 * Convert a parsed Kimi session (wire.jsonl records) into normalized messages.
 *
 * Reconstruction uses `turn.prompt` for user turns and `context.append_loop_event`
 * for the assistant stream (content.part think/text, tool.call, tool.result).
 * `context.append_message` records are ignored — they are the post-compaction
 * context-memory projection and would double-count tool results as user turns.
 */
export function convertKimiMessages(session: KimiSessionContent): Message[] {
  const messages: Message[] = [];
  const sid = session.sessionId;

  let assistantBlocks: ContentBlock[] = [];
  let assistantTs: number | undefined;
  let assistantSeq = 0;
  let userSeq = 0;

  const appendAssistantPart = (
    part:
      | { type: "thinking"; thinking: string }
      | { type: "text"; text: string },
  ) => {
    const previous = assistantBlocks[assistantBlocks.length - 1];
    if (
      part.type === "thinking" &&
      previous?.type === "thinking" &&
      typeof previous.thinking === "string"
    ) {
      previous.thinking += part.thinking;
      return;
    }
    if (
      part.type === "text" &&
      previous?.type === "text" &&
      typeof previous.text === "string"
    ) {
      previous.text += part.text;
      return;
    }
    assistantBlocks.push(part);
  };

  const toIso = (ms: number | undefined): string | undefined =>
    typeof ms === "number" ? new Date(ms).toISOString() : session.createdAt;

  const flushAssistant = () => {
    if (assistantBlocks.length === 0) return;
    messages.push({
      uuid: `${sid}-assistant-${assistantSeq++}`,
      type: "assistant",
      message: { role: "assistant", content: assistantBlocks },
      timestamp: toIso(assistantTs),
    });
    assistantBlocks = [];
    assistantTs = undefined;
  };

  for (const record of session.records) {
    if (isKimiTurnPromptRecord(record)) {
      flushAssistant();
      messages.push({
        uuid: `${sid}-user-${userSeq++}`,
        type: "user",
        message: {
          role: "user",
          content: buildKimiUserContent(record.input, session.blobsDir),
        },
        timestamp: toIso(record.time),
      });
      continue;
    }

    if (!isKimiLoopEventRecord(record)) continue;

    const event = record.event;
    switch (event.type) {
      case "content.part": {
        const part = (event as KimiContentPartEvent).part;
        if (part.type === "think") {
          appendAssistantPart({ type: "thinking", thinking: part.think });
        } else if (part.type === "text") {
          appendAssistantPart({ type: "text", text: part.text });
        }
        assistantTs ??= record.time;
        break;
      }
      case "tool.call": {
        const toolCall = event as KimiToolCallEvent;
        assistantBlocks.push({
          type: "tool_use",
          id: toolCall.toolCallId,
          name: toolCall.name,
          input: normalizeKimiToolInput(toolCall.name, toolCall.args),
        });
        assistantTs ??= record.time;
        break;
      }
      case "tool.result": {
        // Flush the assistant message (carrying the tool_use blocks) before
        // emitting the corresponding tool results.
        flushAssistant();
        const toolResult = event as KimiToolResultEvent;
        const output =
          toolResult.result?.output ?? toolResult.result?.note ?? "";
        const toolUseId = toolResult.toolCallId ?? "";
        messages.push({
          uuid: `${sid}-result-${toolResult.toolCallId ?? `${assistantSeq}-${messages.length}`}`,
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: output,
                ...(toolResult.result?.isError === true && { is_error: true }),
              },
            ],
          },
          timestamp: toIso(record.time),
        });
        break;
      }
      default:
        break;
    }
  }

  flushAssistant();
  return messages;
}

// --- OpenCode Conversion Logic ---

function convertOpenCodeEntries(entries: OpenCodeSessionEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    const { message, parts } = entry;
    const uuid = message.id;
    const timestamp = message.time?.created
      ? new Date(message.time.created).toISOString()
      : undefined;

    const content = convertOpenCodeParts(parts, message.role);
    const usage = createOpenCodeUsage(message.tokens, message.cost, parts);
    const openCodeHasToolPart =
      message.role === "assistant" &&
      parts.some((part) => part.type === "tool");
    const openCodeHasError =
      message.role === "assistant" && message.error !== undefined;
    const openCodeError =
      openCodeHasError && !isOpenCodeAbortError(message.error)
        ? formatOpenCodeError(message.error)
        : null;

    messages.push({
      uuid,
      type: message.role,
      message: {
        role: message.role,
        content,
        model: message.modelID,
        usage,
      },
      timestamp,
      // Include OpenCode-specific fields
      ...(message.parentID && {
        parentUuid: message.parentID,
        parentId: message.parentID,
      }),
      ...(message.providerID && { providerId: message.providerID }),
      ...(message.cost !== undefined && { cost: message.cost }),
      ...(message.mode && { mode: message.mode }),
      ...(message.agent && { agent: message.agent }),
      ...(message.finish && { finish: message.finish }),
      ...(openCodeHasToolPart && { openCodeHasToolPart: true }),
      ...(message.role === "assistant" &&
        !openCodeHasError &&
        !message.finish &&
        typeof message.time?.completed === "number" && {
          // Legacy OpenCode messages may omit `finish`. A completed message
          // that contains a tool part is still an intermediate tool stage,
          // not the assistant's final response.
          openCodeCompleted: !openCodeHasToolPart,
        }),
      ...(message.path && { path: message.path }),
    });

    if (openCodeError) {
      messages.push({
        uuid: `${uuid}:error`,
        type: "error",
        error: openCodeError,
        content: openCodeError,
        timestamp: message.time?.completed
          ? new Date(message.time.completed).toISOString()
          : timestamp,
        parentUuid: uuid,
      });
    }
  }

  return messages;
}

function createOpenCodeUsage(
  messageTokens: OpenCodeStoredPart["tokens"],
  messageCost: number | undefined,
  parts: OpenCodeStoredPart[],
): Record<string, unknown> | undefined {
  const stepFinish = [...parts]
    .reverse()
    .find((part) => part.type === "step-finish" && (part.tokens || part.cost));
  const tokens = messageTokens ?? stepFinish?.tokens;
  const cost = messageCost ?? stepFinish?.cost;
  if (!tokens && cost === undefined) return undefined;

  const usage: Record<string, unknown> = {};
  if (tokens?.input !== undefined) usage.input_tokens = tokens.input;
  if (tokens?.output !== undefined) usage.output_tokens = tokens.output;
  if (tokens?.reasoning !== undefined)
    usage.reasoning_tokens = tokens.reasoning;
  if (tokens?.cache?.read !== undefined) {
    usage.cache_read_input_tokens = tokens.cache.read;
  }
  if (tokens?.cache?.write !== undefined) {
    usage.cache_creation_input_tokens = tokens.cache.write;
  }
  if (cost !== undefined) usage.cost_usd = cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function convertOpenCodeParts(
  parts: OpenCodeStoredPart[],
  role?: "user" | "assistant",
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const userText =
    role === "user"
      ? parts
          .filter(
            (part) => part.type === "text" && !part.synthetic && part.text,
          )
          .map((part) => part.text)
          .join("\n")
      : undefined;

  for (const part of parts) {
    switch (part.type) {
      case "text":
        // OpenCode inserts synthetic user text while resolving attachments
        // (for example, "Called the Read tool..."). It is model context, not
        // user-authored transcript content, and OpenCode's own UI hides it.
        if (!part.synthetic && part.text) {
          blocks.push({
            type: "text",
            text: part.text,
          });
        }
        break;

      case "reasoning":
        if (part.text?.trim()) {
          blocks.push({
            type: "thinking",
            thinking: part.text,
          });
        }
        break;

      case "tool":
        if (part.tool && part.callID) {
          const toolName = canonicalizeOpenCodeToolName(part.tool);
          // Tool use block
          blocks.push({
            type: "tool_use",
            id: part.callID,
            name: toolName,
            input: normalizeOpenCodeToolInput(
              toolName,
              part.state?.input,
              part.state?.metadata,
            ),
            opencodeStatus: part.state?.status,
            opencodeTitle: part.state?.title,
            opencodeMetadata: part.state?.metadata,
            opencodeTime: part.state?.time ?? part.time,
          });

          // If tool has completed, add tool result block
          if (
            part.state?.status === "completed" ||
            part.state?.status === "error"
          ) {
            const resultContent = part.state.error
              ? part.state.error
              : typeof part.state.output === "string"
                ? part.state.output
                : JSON.stringify(part.state.output ?? "");

            blocks.push({
              type: "tool_result",
              tool_use_id: part.callID,
              content: resultContent,
              is_error: part.state.status === "error" || !!part.state.error,
              opencodeStatus: part.state.status,
              opencodeTitle: part.state.title,
              opencodeMetadata: part.state.metadata,
              opencodeTime: part.state.time ?? part.time,
            });
          }
        }
        break;

      // Skip step-start (metadata, not content)
      case "step-start":
      case "step-finish":
        break;

      case "subtask": {
        // Subagent launch marker: keep subagent work visible in transcripts.
        const subtask = part as unknown as {
          prompt?: string;
          description?: string;
          agent?: string;
        };
        const description =
          subtask.description?.trim() || subtask.prompt?.trim() || "";
        const agentName = subtask.agent?.trim() || "subagent";
        blocks.push({
          type: "text",
          text: `**Subagent (${agentName})**: ${description}`,
        });
        break;
      }

      case "file": {
        // Attachment marker (user uploads / tool-produced files).
        const file = part as unknown as {
          filename?: string;
          mime?: string;
          url?: string;
        };
        if (hasYepUploadMetadataForFile(userText, file.filename)) break;
        const label = getOpenCodeAttachmentLabel(file);
        blocks.push({
          type: "text",
          text: `📎 ${label}${file.mime ? ` (${file.mime})` : ""}`,
        });
        break;
      }

      // retry: transient backoff bookkeeping; patch/snapshot: internal VCS
      // state; agent: @-mention reference duplicated in the text part.
      // compaction is emitted as a session-level system marker elsewhere.
      case "retry":
      case "patch":
      case "snapshot":
      case "agent":
      case "compaction":
        break;

      default:
        // Unknown part type - skip
        break;
    }
  }

  return blocks;
}

function canonicalizeOpenCodeToolName(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case "bash":
    case "shell":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
    case "apply_patch":
      return "Edit";
    case "glob":
      return "Glob";
    case "grep":
      return "Grep";
    case "todowrite":
    case "todo":
      return "TodoWrite";
    default:
      return toolName;
  }
}

function normalizeOpenCodeToolInput(
  toolName: string,
  input: unknown,
  metadata?: unknown,
): unknown {
  const baseInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const normalized = { ...(baseInput as Record<string, unknown>) };
  const lowerToolName = toolName.toLowerCase();
  const metadataRecord =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;

  if (
    (lowerToolName === "read" ||
      lowerToolName === "write" ||
      lowerToolName === "edit") &&
    typeof normalized.filePath === "string" &&
    typeof normalized.file_path !== "string"
  ) {
    normalized.file_path = normalized.filePath;
  }

  if (
    lowerToolName === "edit" &&
    typeof normalized.oldString === "string" &&
    typeof normalized.old_string !== "string"
  ) {
    normalized.old_string = normalized.oldString;
  }

  if (
    lowerToolName === "edit" &&
    typeof normalized.newString === "string" &&
    typeof normalized.new_string !== "string"
  ) {
    normalized.new_string = normalized.newString;
  }

  if (
    lowerToolName === "edit" &&
    typeof normalized.replaceAll === "boolean" &&
    typeof normalized.replace_all !== "boolean"
  ) {
    normalized.replace_all = normalized.replaceAll;
  }

  if (
    lowerToolName === "edit" &&
    typeof metadataRecord?.diff === "string" &&
    metadataRecord.diff.trim() &&
    typeof normalized._rawPatch !== "string"
  ) {
    normalized._rawPatch = metadataRecord.diff;
  }

  if (
    lowerToolName === "grep" &&
    typeof normalized.include === "string" &&
    typeof normalized.glob !== "string"
  ) {
    normalized.glob = normalized.include;
  }

  return normalized;
}

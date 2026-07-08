import type { MarkdownAugment } from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";
import type {
  RenderItem,
  SessionSetupItem,
  SystemItem,
  ToolCallItem,
  ToolResultData,
  UserPromptItem,
} from "../types/renderItems";
import { getMessageId } from "./mergeMessages";

const CODEX_TURN_ABORTED_DISPLAY_TEXT = "Conversation stopped by user";

interface TaskNotification {
  taskId: string;
  toolUseId: string;
  outputFile?: string;
  status: string;
  summary?: string;
  result?: string;
  usage?: {
    subagentTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
}

/**
 * When true, indicates the session has an active tool approval request.
 * All orphaned tools will be treated as pending (not interrupted).
 *
 * This handles the case where multiple tools are queued for approval -
 * only the first is sent to the client, but all are waiting in the server queue.
 */
export type ActiveToolApproval = boolean;

/**
 * Augments to embed into RenderItems during preprocessing.
 * These are pre-computed on the server for completed messages.
 */
export interface PreprocessAugments {
  /** Pre-rendered markdown HTML keyed by message ID */
  markdown?: Record<string, MarkdownAugment>;
  /** Active tool approval request - if present, matching tool_use won't be marked aborted */
  activeToolApproval?: ActiveToolApproval;
}

/**
 * Preprocess messages into render items, pairing tool_use with tool_result.
 *
 * This is a pure function - given the same messages, returns the same items.
 * Safe to call on every render (use useMemo).
 */
export function preprocessMessages(
  messages: Message[],
  augments?: PreprocessAugments,
): RenderItem[] {
  const items: RenderItem[] = [];
  const toolCallIndices = new Map<string, number>(); // tool_use_id → index in items
  const pendingToolCalls = new Map<string, number>(); // tool_use_id → index in items

  // Collect all orphaned tool IDs from messages (set by server DAG filtering)
  // If there's an active tool approval, skip orphan detection entirely -
  // all tools without results are pending (either current or queued for approval)
  const orphanedToolIds = new Set<string>();
  if (!augments?.activeToolApproval) {
    for (const msg of messages) {
      if (msg.orphanedToolUseIds) {
        for (const id of msg.orphanedToolUseIds) {
          orphanedToolIds.add(id);
        }
      }
    }
  }

  for (const msg of messages) {
    processMessage(
      msg,
      items,
      toolCallIndices,
      pendingToolCalls,
      orphanedToolIds,
      augments,
    );
  }

  const enrichedItems = enrichWriteStdinWithCommand(items);
  return collapsePlanProgressItems(collapseSessionSetupRuns(enrichedItems));
}

const SESSION_SETUP_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
];

function getPromptText(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter(
      (block): block is ContentBlock & { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function isSessionSetupPrompt(item: UserPromptItem): boolean {
  const text = getPromptText(item.content).trimStart();
  return SESSION_SETUP_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function isStrongSessionSetupPrompt(item: UserPromptItem): boolean {
  const text = getPromptText(item.content).trimStart();
  const lowerText = text.toLowerCase();

  if (lowerText.startsWith("<environment_context>")) {
    return true;
  }

  return (
    lowerText.startsWith("# agents.md instructions") &&
    (lowerText.includes("<instructions") ||
      lowerText.includes("<environment_context>"))
  );
}

function dedupeSessionSetupItems(items: UserPromptItem[]): UserPromptItem[] {
  const seen = new Set<string>();
  const deduped: UserPromptItem[] = [];

  for (const item of items) {
    const key = getPromptText(item.content).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function getUserPromptDedupeKey(item: UserPromptItem): string | null {
  if (isSessionSetupPrompt(item)) {
    return null;
  }

  const text = getPromptText(item.content).trim();
  return text.length > 0 ? text : null;
}

function hasJsonlSource(item: UserPromptItem): boolean {
  return item.sourceMessages.some((message) => message._source === "jsonl");
}

function preferUserPromptItem(
  existing: UserPromptItem,
  incoming: UserPromptItem,
): UserPromptItem {
  const existingIsJsonl = hasJsonlSource(existing);
  const incomingIsJsonl = hasJsonlSource(incoming);

  if (existingIsJsonl && !incomingIsJsonl) {
    return existing;
  }
  if (incomingIsJsonl && !existingIsJsonl) {
    return incoming;
  }

  return incoming;
}

function dedupeUserPromptsSeparatedOnlyBySetup(
  items: RenderItem[],
): RenderItem[] {
  const result: RenderItem[] = [];

  for (const item of items) {
    if (item.type !== "user_prompt") {
      result.push(item);
      continue;
    }

    const itemKey = getUserPromptDedupeKey(item);
    if (!itemKey) {
      result.push(item);
      continue;
    }

    let priorUserPromptIndex: number | null = null;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const candidate = result[index];
      if (!candidate) {
        continue;
      }
      if (candidate.type === "session_setup") {
        continue;
      }
      if (candidate.type === "user_prompt") {
        priorUserPromptIndex = index;
      }
      break;
    }

    if (priorUserPromptIndex !== null) {
      const prior = result[priorUserPromptIndex];
      if (
        prior?.type === "user_prompt" &&
        getUserPromptDedupeKey(prior) === itemKey
      ) {
        result[priorUserPromptIndex] = preferUserPromptItem(prior, item);
        continue;
      }
    }

    result.push(item);
  }

  return result;
}

function collapseSessionSetupRuns(items: RenderItem[]): RenderItem[] {
  const result: RenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (!item || item.type !== "user_prompt" || !isSessionSetupPrompt(item)) {
      result.push(item as RenderItem);
      index += 1;
      continue;
    }

    const setupItems: UserPromptItem[] = [];
    let runIndex = index;
    while (runIndex < items.length) {
      const runItem = items[runIndex];
      if (
        !runItem ||
        runItem.type !== "user_prompt" ||
        !isSessionSetupPrompt(runItem)
      ) {
        break;
      }
      setupItems.push(runItem);
      runIndex += 1;
    }

    // Preserve likely user-authored single setup-like messages mid-session.
    // Collapse start-of-session runs, multi-item resume preambles, and full
    // Codex setup payloads that include real instructions/environment tags.
    const shouldCollapse =
      setupItems.length > 1 ||
      index === 0 ||
      setupItems.some(isStrongSessionSetupPrompt);
    if (shouldCollapse) {
      const dedupedSetupItems = dedupeSessionSetupItems(setupItems);
      const firstSetupItem = dedupedSetupItems[0];
      if (!firstSetupItem) {
        index = runIndex;
        continue;
      }

      const collapsedItem: SessionSetupItem = {
        type: "session_setup",
        id: `session-setup-${firstSetupItem.id}`,
        title: "Session setup",
        prompts: dedupedSetupItems.map((setupItem) => setupItem.content),
        sourceMessages: dedupedSetupItems.flatMap(
          (setupItem) => setupItem.sourceMessages,
        ),
      };
      result.push(collapsedItem);
    } else {
      const singleSetupItem = setupItems[0];
      if (singleSetupItem) {
        result.push(singleSetupItem);
      }
    }

    index = runIndex;
  }

  return dedupeUserPromptsSeparatedOnlyBySetup(result);
}

function isPlanProgressToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().replace(/[_-]/g, "");
  return normalized === "updateplan" || normalized === "todowrite";
}

export function isPlanProgressItem(item: RenderItem): item is ToolCallItem {
  return item.type === "tool_call" && isPlanProgressToolName(item.toolName);
}

function uniqueSourceMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const unique: Message[] = [];

  for (const message of messages) {
    const id = getMessageId(message);
    const key = id || `${message.type ?? "unknown"}-${message.timestamp ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(message);
  }

  return unique;
}

function collapsePlanProgressSegment(segment: RenderItem[]): RenderItem[] {
  let firstPlanIndex: number | null = null;
  let firstPlanItem: ToolCallItem | null = null;
  let latestPlanItem: ToolCallItem | null = null;
  const planSourceMessages: Message[] = [];

  for (let index = 0; index < segment.length; index++) {
    const item = segment[index];
    if (!item || !isPlanProgressItem(item)) {
      continue;
    }

    firstPlanIndex ??= index;
    firstPlanItem ??= item;
    latestPlanItem = item;
    planSourceMessages.push(...item.sourceMessages);
  }

  if (
    firstPlanIndex === null ||
    !firstPlanItem ||
    !latestPlanItem ||
    firstPlanItem === latestPlanItem
  ) {
    return segment;
  }

  const collapsedPlanItem: ToolCallItem = {
    ...latestPlanItem,
    id: firstPlanItem.id,
    sourceMessages: uniqueSourceMessages(planSourceMessages),
  };

  const collapsedSegment: RenderItem[] = [];
  for (let index = 0; index < segment.length; index++) {
    const item = segment[index];
    if (!item) {
      continue;
    }
    if (!isPlanProgressItem(item)) {
      collapsedSegment.push(item);
      continue;
    }
    if (index === firstPlanIndex) {
      collapsedSegment.push(collapsedPlanItem);
    }
  }

  return collapsedSegment;
}

/**
 * Keep plan progress as a single current card per user turn. Claude's
 * TodoWrite and Codex's UpdatePlan both emit repeated snapshots as work
 * advances; rendering every snapshot creates noisy historical cards.
 */
export function collapsePlanProgressItems(items: RenderItem[]): RenderItem[] {
  const collapsed: RenderItem[] = [];
  let assistantSegment: RenderItem[] = [];

  const flushAssistantSegment = () => {
    if (assistantSegment.length === 0) {
      return;
    }
    collapsed.push(...collapsePlanProgressSegment(assistantSegment));
    assistantSegment = [];
  };

  for (const item of items) {
    if (item.type === "user_prompt" || item.type === "session_setup") {
      flushAssistantSegment();
      collapsed.push(item);
      continue;
    }
    assistantSegment.push(item);
  }

  flushAssistantSegment();
  return collapsed;
}

function processMessage(
  msg: Message,
  items: RenderItem[],
  toolCallIndices: Map<string, number>,
  pendingToolCalls: Map<string, number>,
  orphanedToolIds: Set<string>,
  augments?: PreprocessAugments,
): void {
  const msgId = getMessageId(msg);

  const taskNotification = parseTaskNotificationMessage(msg);
  if (taskNotification) {
    attachTaskNotificationResult(
      taskNotification,
      msg,
      items,
      toolCallIndices,
      pendingToolCalls,
    );
    return;
  }

  // Handle provider/runtime error entries as visible system messages.
  if (msg.type === "error") {
    const errorText =
      (typeof msg.error === "string" && msg.error) ||
      (typeof msg.content === "string" && msg.content) ||
      "Agent error";
    const systemItem: SystemItem = {
      type: "system",
      id: msgId || `error-${msg.timestamp ?? Date.now()}`,
      subtype: "error",
      content: errorText,
      sourceMessages: [msg],
    };
    items.push(systemItem);
    return;
  }

  // Handle system entries (compact_boundary, status, etc.)
  if (msg.type === "system") {
    const subtype = (msg as { subtype?: string }).subtype ?? "unknown";
    // Render compact_boundary as a visible system message
    if (subtype === "compact_boundary" || subtype === "turn_aborted") {
      const systemItem: SystemItem = {
        type: "system",
        id: msgId,
        subtype,
        content:
          subtype === "turn_aborted"
            ? CODEX_TURN_ABORTED_DISPLAY_TEXT
            : typeof msg.content === "string"
              ? msg.content
              : "Context compacted",
        sourceMessages: [msg],
      };
      items.push(systemItem);
    }
    // Status messages (compacting indicator) are transient - handled separately via isCompacting state
    // Skip other system entries (init, status, etc.) - they're internal
    return;
  }

  // Debug logging for streaming transition issues
  if (
    typeof window !== "undefined" &&
    window.__STREAMING_DEBUG__ &&
    msg.type === "assistant"
  ) {
    console.log("[preprocessMessages] Processing assistant message:", {
      msgId,
      uuid: msg.uuid,
      id: msg.id,
      _isStreaming: msg._isStreaming,
    });
  }

  // Get content from nested message object (SDK structure) first, fall back to top-level
  // Phase 4c: prefer message.content over top-level content
  const content =
    (msg.message as { content?: string | ContentBlock[] } | undefined)
      ?.content ?? msg.content;

  // Use type for discrimination (SDK field), fall back to role for legacy data
  // Phase 4c: prefer type over role, but maintain backward compatibility
  const role =
    (msg.message as { role?: "user" | "assistant" } | undefined)?.role ??
    msg.role;
  const isUserMessage = msg.type === "user" || role === "user";

  // String content = user prompt (only if type is user)
  if (typeof content === "string") {
    if (isUserMessage) {
      items.push({
        type: "user_prompt",
        id: msgId,
        content,
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
      });
      return;
    }
    // Assistant message with string content - convert to text block
    if (content.trim()) {
      const messageHtml = (msg as { _html?: string })._html;
      items.push({
        type: "text",
        id: msgId,
        text: content,
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
        augmentHtml: messageHtml ?? augments?.markdown?.[msgId]?.html,
      });
    }
    return;
  }

  // Not an array - shouldn't happen but handle gracefully
  if (!Array.isArray(content)) {
    return;
  }

  // Check if this is a user message with only tool_result blocks
  const isToolResultMessage =
    isUserMessage && content.every((b) => b.type === "tool_result");

  if (isToolResultMessage) {
    // Attach results to pending tool calls
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        attachToolResult(block, msg, items, pendingToolCalls);
      }
    }
    return;
  }

  // Check if this is a real user prompt (not tool results)
  if (isUserMessage) {
    items.push({
      type: "user_prompt",
      id: msgId,
      content,
      sourceMessages: [msg],
      isSubagent: msg.isSubagent,
    });
    return;
  }

  // Assistant message - process each block
  // First pass: find the last text block index (for streaming cursor placement)
  let lastTextBlockIndex = -1;
  if (msg._isStreaming) {
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block?.type === "text" && block.text?.trim()) {
        lastTextBlockIndex = i;
        break;
      }
    }
  }

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block) continue;

    const blockId = `${msgId}-${i}`;

    if (block.type === "text") {
      if (block.text?.trim()) {
        // Get _html from server-injected augment, fall back to markdownAugments (for SSE path)
        const blockHtml = (block as { _html?: string })._html;
        items.push({
          type: "text",
          id: blockId,
          text: block.text,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
          // Only show streaming cursor on the last text block
          isStreaming: msg._isStreaming && i === lastTextBlockIndex,
          // Prefer inline _html from server, fall back to markdownAugments (SSE path)
          augmentHtml: blockHtml ?? augments?.markdown?.[msgId]?.html,
        });
      }
    } else if (block.type === "thinking") {
      if (block.thinking?.trim()) {
        items.push({
          type: "thinking",
          id: blockId,
          thinking: block.thinking,
          signature: undefined,
          status: "complete",
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
      }
    } else if (block.type === "tool_use") {
      if (block.id && block.name) {
        // Stream reconnects/resume can replay the same tool_use id from a
        // different assistant message snapshot. Keep one render item per tool id.
        const existingIndex = toolCallIndices.get(block.id);
        if (existingIndex !== undefined) {
          const existingItem = items[existingIndex];
          if (existingItem?.type === "tool_call") {
            const replayStatus = getInitialToolStatus(
              block,
              orphanedToolIds.has(block.id),
            );
            const nextItem = appendSourceMessage(existingItem, msg);
            items[existingIndex] =
              existingItem.status === "pending" && replayStatus !== "pending"
                ? { ...nextItem, status: replayStatus }
                : nextItem;
            if (existingItem.status === "pending") {
              pendingToolCalls.set(block.id, existingIndex);
            }
          }
          continue;
        }

        // Check if this tool call is orphaned (process killed before result)
        const isOrphaned = orphanedToolIds.has(block.id);
        const toolCall: ToolCallItem = {
          type: "tool_call",
          id: block.id,
          toolName: block.name,
          toolInput: block.input,
          toolResult: undefined,
          status: getInitialToolStatus(block, isOrphaned),
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        };
        const itemIndex = items.length;
        toolCallIndices.set(block.id, itemIndex);
        pendingToolCalls.set(block.id, itemIndex);
        items.push(toolCall);
      }
    } else if (block.type === "tool_result" && block.tool_use_id) {
      // OpenCode persists tool_use and tool_result blocks together in the
      // assistant message. Pair those results here; Claude/Codex usually put
      // tool_result blocks in a following user message handled above.
      attachToolResult(block, msg, items, pendingToolCalls);
    }
  }
}

function getInitialToolStatus(
  block: ContentBlock,
  isOrphaned: boolean,
): ToolCallItem["status"] {
  if (isOrphaned) {
    return "aborted";
  }

  const providerStatus =
    getStringField(block, "opencodeStatus") ?? getStringField(block, "status");

  switch (providerStatus?.toLowerCase()) {
    case "complete":
    case "completed":
    case "success":
      return "complete";
    case "error":
    case "failed":
      return "error";
    case "aborted":
    case "cancelled":
    case "canceled":
      return "aborted";
    default:
      return "pending";
  }
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.trim()
    ? fieldValue.trim()
    : undefined;
}

function parseTaskNotificationMessage(msg: Message): TaskNotification | null {
  const content = msg.message?.content ?? msg.content;
  const text = getTaskNotificationText(content);
  if (!text) {
    return null;
  }

  const taskId = extractXmlTag(text, "task-id");
  const toolUseId = extractXmlTag(text, "tool-use-id");
  if (!taskId || !toolUseId) {
    return null;
  }

  return {
    taskId,
    toolUseId,
    outputFile: extractXmlTag(text, "output-file"),
    status: extractXmlTag(text, "status") ?? "completed",
    summary: decodeXmlEntities(extractXmlTag(text, "summary") ?? ""),
    result: decodeXmlEntities(extractXmlTag(text, "result") ?? ""),
    usage: parseTaskNotificationUsage(extractXmlTag(text, "usage")),
  };
}

function getTaskNotificationText(
  content: string | ContentBlock[] | undefined,
): string | null {
  if (typeof content === "string") {
    const trimmed = content.trimStart();
    return trimmed.startsWith("<task-notification>") ? content : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter(
      (block): block is ContentBlock & { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  return text.trimStart().startsWith("<task-notification>") ? text : null;
}

function extractXmlTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1]?.trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseTaskNotificationUsage(
  usage: string | undefined,
): TaskNotification["usage"] {
  if (!usage) {
    return undefined;
  }

  const subagentTokens = parseIntegerXmlField(usage, "subagent_tokens");
  const toolUses = parseIntegerXmlField(usage, "tool_uses");
  const durationMs = parseIntegerXmlField(usage, "duration_ms");

  if (
    subagentTokens === undefined &&
    toolUses === undefined &&
    durationMs === undefined
  ) {
    return undefined;
  }

  return { subagentTokens, toolUses, durationMs };
}

function parseIntegerXmlField(
  text: string,
  fieldName: string,
): number | undefined {
  const match =
    new RegExp(`${fieldName}:\\s*(\\d+)`).exec(text) ??
    new RegExp(`<${fieldName}>(\\d+)</${fieldName}>`).exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function getTaskNotificationRenderedHtml(msg: Message): string | undefined {
  const messageRecord = msg as Record<string, unknown>;
  if (typeof messageRecord._taskNotificationResultHtml === "string") {
    return messageRecord._taskNotificationResultHtml;
  }

  const nestedMessage = msg.message as Record<string, unknown> | undefined;
  return typeof nestedMessage?._taskNotificationResultHtml === "string"
    ? nestedMessage._taskNotificationResultHtml
    : undefined;
}

function taskNotificationStatusToTaskStatus(
  status: string,
): "completed" | "failed" | "timeout" {
  if (status === "completed") {
    return "completed";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "failed";
}

function attachTaskNotificationResult(
  notification: TaskNotification,
  resultMessage: Message,
  items: RenderItem[],
  toolCallIndices: Map<string, number>,
  pendingToolCalls: Map<string, number>,
): void {
  const index = toolCallIndices.get(notification.toolUseId);
  if (index === undefined) {
    return;
  }

  const item = items[index];
  if (!item || item.type !== "tool_call") {
    return;
  }

  const existingStructured = isRecord(item.toolResult?.structured)
    ? item.toolResult.structured
    : {};
  const isError = notification.status !== "completed";
  const notificationHtml = getTaskNotificationRenderedHtml(resultMessage);
  const contentBlocks: ContentBlock[] = notification.result
    ? [
        {
          type: "text",
          text: notification.result,
          ...(notificationHtml ? { _renderedHtml: notificationHtml } : {}),
        } as ContentBlock,
      ]
    : [];

  const structured = {
    ...existingStructured,
    agentId:
      typeof existingStructured.agentId === "string"
        ? existingStructured.agentId
        : notification.taskId,
    status: taskNotificationStatusToTaskStatus(notification.status),
    content: contentBlocks,
    totalTokens:
      notification.usage?.subagentTokens ??
      (typeof existingStructured.totalTokens === "number"
        ? existingStructured.totalTokens
        : undefined),
    totalToolUseCount:
      notification.usage?.toolUses ??
      (typeof existingStructured.totalToolUseCount === "number"
        ? existingStructured.totalToolUseCount
        : undefined),
    totalDurationMs:
      notification.usage?.durationMs ??
      (typeof existingStructured.totalDurationMs === "number"
        ? existingStructured.totalDurationMs
        : undefined),
    outputFile: notification.outputFile,
    summary: notification.summary,
  };

  items[index] = {
    ...item,
    toolResult: {
      content: notification.result ?? notification.summary ?? "",
      isError,
      structured,
    },
    status: isError ? "error" : "complete",
    sourceMessages: appendSourceMessage(item, resultMessage).sourceMessages,
  };
  pendingToolCalls.delete(notification.toolUseId);
}

function appendSourceMessage(
  item: ToolCallItem,
  message: Message,
): ToolCallItem {
  const messageId = getMessageId(message);
  if (
    item.sourceMessages.some((source) => getMessageId(source) === messageId)
  ) {
    return item;
  }
  return {
    ...item,
    sourceMessages: [...item.sourceMessages, message],
  };
}

/**
 * Parse Agent tool result from text content blocks (SDK 0.2.76+).
 *
 * New SDK embeds agentId and usage stats in text rather than a structured
 * tool_use_result. Example text block:
 *   "agentId: abc123 (for resuming...)\n<usage>total_tokens: 1234\ntool_uses: 5\nduration_ms: 6789</usage>"
 *
 * Returns a TaskResult-shaped object for the renderer, or undefined if not parseable.
 */
export function parseAgentResultFromText(
  block: ContentBlock,
): Record<string, unknown> | undefined {
  // Content may be a string or array of content blocks
  const texts: string[] = [];
  if (typeof block.content === "string") {
    texts.push(block.content);
  } else if (Array.isArray(block.content)) {
    for (const cb of block.content as Array<{ type?: string; text?: string }>) {
      if (cb.type === "text" && cb.text) texts.push(cb.text);
    }
  }

  const fullText = texts.join("\n");
  if (!fullText) return undefined;

  const displayContent = extractAgentDisplayContent(block);

  // Extract agentId
  const agentIdMatch = fullText.match(/^agentId:\s*(\S+)/m);
  if (!agentIdMatch) return undefined;

  const result: Record<string, unknown> = {
    agentId: agentIdMatch[1],
    status: "completed",
  };
  if (displayContent && displayContent.length > 0) {
    result.content = displayContent;
  }

  // Extract usage stats from <usage> block
  const usageMatch = fullText.match(/<usage>([\s\S]*?)<\/usage>/);
  if (usageMatch?.[1]) {
    const usage = usageMatch[1];
    const tokens = usage.match(/total_tokens:\s*(\d+)/);
    const tools = usage.match(/tool_uses:\s*(\d+)/);
    const duration = usage.match(/duration_ms:\s*(\d+)/);
    if (tokens?.[1]) result.totalTokens = Number(tokens[1]);
    if (tools?.[1]) result.totalToolUseCount = Number(tools[1]);
    if (duration?.[1]) result.totalDurationMs = Number(duration[1]);
  }

  return result;
}

function stripAgentMetadata(text: string): string {
  return text
    .replace(/^agentId:\s*\S+.*$/gm, "")
    .replace(/<usage>[\s\S]*?<\/usage>/g, "")
    .trim();
}

function extractAgentDisplayContent(
  block: ContentBlock,
): ContentBlock[] | undefined {
  if (typeof block.content === "string") {
    const text = stripAgentMetadata(block.content);
    return text ? [{ type: "text", text }] : undefined;
  }

  if (!Array.isArray(block.content)) {
    return undefined;
  }

  const displayBlocks: ContentBlock[] = [];
  for (const contentBlock of block.content) {
    if (!contentBlock || typeof contentBlock !== "object") {
      continue;
    }

    if (contentBlock.type === "text" && typeof contentBlock.text === "string") {
      const text = stripAgentMetadata(contentBlock.text);
      if (!text) {
        continue;
      }
      displayBlocks.push({ ...contentBlock, text });
      continue;
    }

    displayBlocks.push(contentBlock as ContentBlock);
  }

  return displayBlocks.length > 0 ? displayBlocks : undefined;
}

function attachToolResult(
  block: ContentBlock,
  resultMessage: Message,
  items: RenderItem[],
  pendingToolCalls: Map<string, number>,
): void {
  const toolUseId = block.tool_use_id;
  if (!toolUseId) return;

  const index = pendingToolCalls.get(toolUseId);
  if (index === undefined) {
    // Orphan result - shouldn't happen normally
    console.warn(`Tool result for unknown tool_use: ${toolUseId}`);
    return;
  }

  const item = items[index];
  if (!item || item.type !== "tool_call") return;

  // Attach result to existing tool call
  // Handle both camelCase (toolUseResult) and snake_case (tool_use_result) from SDK
  let structured =
    resultMessage.toolUseResult ??
    (resultMessage as Record<string, unknown>).tool_use_result;

  // SDK 0.2.76+: Agent tool has no structured tool_use_result.
  // Parse agentId and usage stats from the text content blocks instead.
  if (!structured && (item.toolName === "Agent" || item.toolName === "Task")) {
    structured = parseAgentResultFromText(block);
  }

  const resultData: ToolResultData = {
    content: typeof block.content === "string" ? block.content : "",
    isError: block.is_error || false,
    structured,
  };

  // Create a new ToolCallItem to ensure React sees the change
  const updatedItem: ToolCallItem = {
    type: "tool_call",
    id: item.id,
    toolName: item.toolName,
    toolInput: item.toolInput,
    toolResult: resultData,
    status: block.is_error ? "error" : "complete",
    sourceMessages: appendSourceMessage(item, resultMessage).sourceMessages,
    isSubagent: item.isSubagent,
  };

  items[index] = updatedItem;
  pendingToolCalls.delete(toolUseId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractCommandFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (typeof input.command === "string" && input.command.trim().length > 0) {
    return input.command;
  }
  if (typeof input.cmd === "string" && input.cmd.trim().length > 0) {
    return input.cmd;
  }
  return undefined;
}

function coerceSessionId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function extractSessionIdFromWriteStdinInput(
  input: unknown,
): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return coerceSessionId(input.session_id ?? input.sessionId);
}

function extractSessionIdFromToolResult(
  item: ToolCallItem,
): string | undefined {
  const structured = item.toolResult?.structured;
  if (isRecord(structured)) {
    const fromStructured = coerceSessionId(
      structured.session_id ?? structured.sessionId,
    );
    if (fromStructured) {
      return fromStructured;
    }
  }

  const raw = item.toolResult?.content ?? "";
  const text = typeof raw === "string" ? raw : "";
  const match = text.match(
    /(?:^|\n)\s*(?:Process\s+running\s+with\s+session\s+ID|session(?:\s+id)?)\s*:?\s*(\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return match[1];
}

function withLinkedCommand(input: unknown, command: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (typeof input.linked_command === "string" && input.linked_command.trim()) {
    return input;
  }
  return { ...input, linked_command: command };
}

function withLinkedFilePath(input: unknown, filePath: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (
    typeof input.linked_file_path === "string" &&
    input.linked_file_path.trim()
  ) {
    return input;
  }
  return { ...input, linked_file_path: filePath };
}

function withLinkedToolName(input: unknown, toolName: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (
    typeof input.linked_tool_name === "string" &&
    input.linked_tool_name.trim()
  ) {
    return input;
  }
  return { ...input, linked_tool_name: toolName };
}

function isCommandSessionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "exec_command" ||
    normalized === "shell_command"
  );
}

function isFileSessionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" || normalized === "write" || normalized === "edit"
  );
}

function extractFilePathFromToolInput(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.file_path !== "string") {
    return undefined;
  }
  const filePath = input.file_path.trim();
  return filePath.length > 0 ? filePath : undefined;
}

function enrichWriteStdinWithCommand(items: RenderItem[]): RenderItem[] {
  const sessionToMetadata = new Map<
    string,
    { command?: string; filePath?: string; toolName?: string }
  >();

  return items.map((item) => {
    if (item.type !== "tool_call") {
      return item;
    }

    if (
      isCommandSessionToolName(item.toolName) ||
      isFileSessionToolName(item.toolName)
    ) {
      const sessionId = extractSessionIdFromToolResult(item);
      if (!sessionId) {
        return item;
      }

      const existing = sessionToMetadata.get(sessionId) ?? {};
      const command = isCommandSessionToolName(item.toolName)
        ? extractCommandFromInput(item.toolInput)
        : undefined;
      const filePath = isFileSessionToolName(item.toolName)
        ? extractFilePathFromToolInput(item.toolInput)
        : undefined;

      sessionToMetadata.set(sessionId, {
        command: command ?? existing.command,
        filePath: filePath ?? existing.filePath,
        toolName: item.toolName ?? existing.toolName,
      });
      return item;
    }

    const toolName = item.toolName.toLowerCase();
    if (toolName !== "writestdin" && toolName !== "write_stdin") {
      return item;
    }

    const sessionId = extractSessionIdFromWriteStdinInput(item.toolInput);
    if (!sessionId) {
      return item;
    }

    const metadata = sessionToMetadata.get(sessionId);
    if (!metadata) {
      return item;
    }

    let toolInput = item.toolInput;
    if (metadata.command) {
      toolInput = withLinkedCommand(toolInput, metadata.command);
    }
    if (metadata.filePath) {
      toolInput = withLinkedFilePath(toolInput, metadata.filePath);
    }
    if (metadata.toolName) {
      toolInput = withLinkedToolName(toolInput, metadata.toolName);
    }

    if (toolInput === item.toolInput) {
      return item;
    }

    return {
      ...item,
      toolInput,
    };
  });
}

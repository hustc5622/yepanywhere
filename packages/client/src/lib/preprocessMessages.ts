import type { CodexRetryStatus, MarkdownAugment } from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";
import type {
  RenderItem,
  SessionSetupItem,
  SystemItem,
  ToolCallItem,
  ToolResultData,
  UserPromptItem,
  WarningRenderItem,
} from "../types/renderItems";
import { getCodexExecResultOverview } from "./codexExec";
import {
  dedupeCodexNativeRenderItems,
  renderCodexThreadItem,
} from "./codexRenderItems";
import { getMessageId } from "./mergeMessages";
import {
  extractOpenCodeTaskStateUpdates,
  getOpenCodeSubagentSessionId,
  isOpenCodeBackgroundTask,
  resolveOpenCodeTaskStatus,
} from "./openCodeSubagents";

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

  const enrichedItems = enrichWriteStdinWithCommand(
    dedupeCodexNativeRenderItems(items),
  );
  const compactWaits = collapseCodexWaitPolls(enrichedItems);
  return reconcileOpenCodeBackgroundTaskStatuses(
    collapsePlanProgressItems(collapseSessionSetupRuns(compactWaits)),
  );
}

function getOpenCodeTaskStateText(item: RenderItem): string[] {
  switch (item.type) {
    case "tool_call":
      return item.toolResult?.content ? [item.toolResult.content] : [];
    case "text":
      return [item.text];
    case "user_prompt":
      return [getPromptText(item.content)];
    case "session_setup":
      return item.prompts.map(getPromptText);
    case "system":
      return [item.content];
    case "thinking":
      return [];
  }

  // Native Codex render items never carry OpenCode's synthetic task marker.
  return [];
}

/**
 * OpenCode background task tools finish after launching the child, then emit a
 * later synthetic `<task state="completed|error">` notification. Reconcile the
 * launcher card with the latest persisted child lifecycle marker so refreshes
 * and resumed task sessions retain the real status.
 */
export function reconcileOpenCodeBackgroundTaskStatuses(
  items: RenderItem[],
): RenderItem[] {
  const latestStates = new Map<
    string,
    ReturnType<typeof extractOpenCodeTaskStateUpdates>[number]["state"]
  >();

  for (const item of items) {
    for (const text of getOpenCodeTaskStateText(item)) {
      for (const update of extractOpenCodeTaskStateUpdates(text)) {
        latestStates.set(update.sessionId, update.state);
      }
    }
  }

  return items.map((item) => {
    if (
      item.type !== "tool_call" ||
      item.toolName.toLowerCase() !== "task" ||
      !isOpenCodeBackgroundTask(item.toolInput)
    ) {
      return item;
    }

    const sessionId = getOpenCodeSubagentSessionId(item.toolInput);
    const status = resolveOpenCodeTaskStatus(
      item.toolInput,
      item.toolResult?.content,
      item.status,
      sessionId ? latestStates.get(sessionId) : undefined,
    );
    return status === item.status ? item : { ...item, status };
  });
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

function isCodexWaitItem(item: RenderItem): item is ToolCallItem {
  if (item.type !== "tool_call") return false;
  const normalized = item.toolName.trim().toLowerCase().replace(/[_-]/g, "");
  return normalized === "wait" || normalized === "codexwait";
}

function getWaitInputRecord(item: ToolCallItem): Record<string, unknown> {
  return isRecord(item.toolInput) ? item.toolInput : {};
}

function getWaitCellId(item: ToolCallItem): string {
  const input = getWaitInputRecord(item);
  const cellId = input.cell_id ?? input.cellId;
  return cellId === undefined ? "" : String(cellId);
}

function isSilentCodexWait(item: ToolCallItem): boolean {
  if (item.status === "error") return false;
  if (!item.toolResult) return true;
  const overview = getCodexExecResultOverview(
    item.toolResult.structured ?? item.toolResult.content,
    item.toolResult.isError,
  );
  return (
    !overview.output &&
    (overview.status === "running" || overview.status === "terminated")
  );
}

function collapseCodexWaitRun(run: ToolCallItem[]): ToolCallItem[] {
  if (run.length < 2) return run;
  const first = run[0];
  const last = run[run.length - 1];
  if (!first || !last) return run;

  let totalWallTimeSeconds = 0;
  let hasWallTime = false;
  for (const item of run) {
    if (!item.toolResult) continue;
    const overview = getCodexExecResultOverview(
      item.toolResult.structured ?? item.toolResult.content,
      item.toolResult.isError,
    );
    if (overview.wallTimeSeconds !== undefined) {
      totalWallTimeSeconds += overview.wallTimeSeconds;
      hasWallTime = true;
    }
  }

  return [
    {
      ...last,
      id: first.id,
      toolInput: {
        ...getWaitInputRecord(last),
        poll_count: run.length,
        ...(hasWallTime && { total_wall_time_seconds: totalWallTimeSeconds }),
      },
      sourceMessages: uniqueSourceMessages(
        run.flatMap((item) => item.sourceMessages),
      ),
    },
  ];
}

/**
 * Codex can poll the same long-running code-mode cell every ten seconds. Keep
 * progress commentary in the timeline, but collapse adjacent silent polls so
 * transport mechanics do not dominate the model's visible progress updates.
 */
export function collapseCodexWaitPolls(items: RenderItem[]): RenderItem[] {
  const collapsed: RenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (!item || !isCodexWaitItem(item) || !isSilentCodexWait(item)) {
      if (item) collapsed.push(item);
      index += 1;
      continue;
    }

    const cellId = getWaitCellId(item);
    const run: ToolCallItem[] = [item];
    let runIndex = index + 1;
    while (runIndex < items.length) {
      const candidate = items[runIndex];
      if (
        !candidate ||
        !isCodexWaitItem(candidate) ||
        !isSilentCodexWait(candidate) ||
        getWaitCellId(candidate) !== cellId
      ) {
        break;
      }
      run.push(candidate);
      runIndex += 1;
    }

    collapsed.push(...collapseCodexWaitRun(run));
    index = runIndex;
  }

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

  if (msg.codexThreadItem) {
    items.push(
      renderCodexThreadItem({
        item: msg.codexThreadItem,
        threadId: msg.codexThreadId,
        turnId: msg.codexTurnId,
        timestamp: msg.timestamp,
        sequence: msg.codexEventSequence,
        lifecycle: msg.codexThreadItemLifecycle,
        rawReasoningAllowed: msg.codexRawReasoningAllowed,
        sourceMessage: msg,
      }),
    );
    return;
  }

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
    const retryStatus = codexRetryStatusValue(msg.codexRetryStatus);
    if (subtype === "warning" && retryStatus) {
      const warningItem: WarningRenderItem = {
        type: "warning",
        id: msgId || `codex-retry-${retryStatus.attempt}`,
        message:
          retryStatus.state === "queued"
            ? "Codex is busy. The request is queued for a bounded retry."
            : "Codex is busy. Retrying the request.",
        retrying: true,
        retryStatus,
        status: "running",
        sourceMessages: [msg],
      };
      items.push(warningItem);
      return;
    }
    // Render compact_boundary / turn_aborted / warning as visible markers
    if (
      subtype === "compact_boundary" ||
      subtype === "turn_aborted" ||
      subtype === "warning"
    ) {
      const systemItem: SystemItem = {
        type: "system",
        id: msgId,
        subtype,
        content:
          subtype === "turn_aborted"
            ? CODEX_TURN_ABORTED_DISPLAY_TEXT
            : typeof msg.content === "string"
              ? msg.content
              : subtype === "warning"
                ? "Warning"
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
        ...(msg.codexMessagePhase && { phase: msg.codexMessagePhase }),
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
        attachToolResult(block, msg, items, toolCallIndices, pendingToolCalls);
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
          ...(msg.codexMessagePhase && { phase: msg.codexMessagePhase }),
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
        // different assistant message snapshot. Keep one render item per tool
        // id, but let a richer input snapshot refresh the arguments (OpenCode
        // streams pending tools with empty input and fills it while running).
        const existingIndex = toolCallIndices.get(block.id);
        if (existingIndex !== undefined) {
          const existingItem = items[existingIndex];
          if (existingItem?.type === "tool_call") {
            const replayStatus = getInitialToolStatus(
              block,
              orphanedToolIds.has(block.id),
            );
            const incomingInput = normalizeToolInput(block);
            const incomingHasInput =
              incomingInput !== undefined &&
              incomingInput !== null &&
              (typeof incomingInput !== "object" ||
                Object.keys(incomingInput as Record<string, unknown>).length >
                  0);
            const existingInput = existingItem.toolInput;
            const existingIsEmpty =
              existingInput === undefined ||
              existingInput === null ||
              (typeof existingInput === "object" &&
                Object.keys(existingInput as Record<string, unknown>).length ===
                  0);
            const nextItem = appendSourceMessage(existingItem, msg);
            const incomingPartialOutput =
              typeof block.partialOutput === "string" &&
              block.partialOutput.length >
                (existingItem.partialOutput?.length ?? 0)
                ? block.partialOutput
                : existingItem.partialOutput;
            const withInput =
              incomingHasInput &&
              (existingIsEmpty || existingItem.toolResult === undefined)
                ? {
                    ...nextItem,
                    toolInput: incomingInput,
                    partialOutput: incomingPartialOutput,
                  }
                : { ...nextItem, partialOutput: incomingPartialOutput };
            items[existingIndex] =
              existingItem.status === "pending" && replayStatus !== "pending"
                ? { ...withInput, status: replayStatus }
                : withInput;
            if (existingItem.status === "pending") {
              pendingToolCalls.set(block.id, existingIndex);
            }
          }
          continue;
        }

        // Check if this tool call is orphaned (process killed before result)
        const isOrphaned = orphanedToolIds.has(block.id);
        const toolInput = normalizeToolInput(block);
        const toolCall: ToolCallItem = {
          type: "tool_call",
          id: block.id,
          toolName: block.name,
          toolInput,
          toolResult: undefined,
          status: getInitialToolStatus(block, isOrphaned),
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
          ...(typeof block.partialOutput === "string" &&
          block.partialOutput.length > 0
            ? { partialOutput: block.partialOutput }
            : {}),
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
      attachToolResult(block, msg, items, toolCallIndices, pendingToolCalls);
    }
  }
}

function codexRetryStatusValue(value: unknown): CodexRetryStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const status = value as Record<string, unknown>;
  if (
    (status.state !== "queued" && status.state !== "retrying") ||
    status.category !== "overloaded" ||
    status.retryable !== true ||
    !isPositiveInteger(status.attempt) ||
    !isPositiveInteger(status.nextAttempt) ||
    !isPositiveInteger(status.maxAttempts) ||
    typeof status.retryInMs !== "number" ||
    !Number.isFinite(status.retryInMs) ||
    status.retryInMs < 0 ||
    status.nextAttempt !== status.attempt + 1 ||
    status.nextAttempt > status.maxAttempts
  ) {
    return undefined;
  }
  return status as unknown as CodexRetryStatus;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function normalizeToolInput(block: ContentBlock): unknown {
  const input = isRecord(block.input) ? { ...block.input } : block.input;
  if (!isRecord(input)) {
    return input;
  }

  const title = getStringField(block, "opencodeTitle");
  if (title) {
    input.opencodeTitle = title;
  }
  if (isRecord(block) && block.opencodeMetadata !== undefined) {
    input.opencodeMetadata = block.opencodeMetadata;
  }

  const name = typeof block.name === "string" ? block.name.toLowerCase() : "";
  if (
    (name === "read" || name === "write" || name === "edit") &&
    typeof input.file_path !== "string"
  ) {
    const filePath =
      typeof input.filePath === "string"
        ? input.filePath
        : typeof input.path === "string"
          ? input.path
          : undefined;
    if (filePath) {
      input.file_path = filePath;
    }
  }

  if (
    name === "read" &&
    typeof input.line_offset === "number" &&
    typeof input.offset !== "number"
  ) {
    input.offset = input.line_offset;
  }

  if (
    name === "read" &&
    typeof input.n_lines === "number" &&
    typeof input.limit !== "number"
  ) {
    input.limit = input.n_lines;
  }

  if (
    name === "edit" &&
    typeof input.oldString === "string" &&
    typeof input.old_string !== "string"
  ) {
    input.old_string = input.oldString;
  }
  if (
    name === "edit" &&
    typeof input.newString === "string" &&
    typeof input.new_string !== "string"
  ) {
    input.new_string = input.newString;
  }
  if (
    name === "edit" &&
    typeof input.replaceAll === "boolean" &&
    typeof input.replace_all !== "boolean"
  ) {
    input.replace_all = input.replaceAll;
  }

  if (
    name === "grep" &&
    typeof input.include === "string" &&
    typeof input.glob !== "string"
  ) {
    input.glob = input.include;
  }

  if (name === "question" && Array.isArray(input.questions)) {
    input.questions = normalizeOpenCodeQuestions(input.questions);
  }

  return input;
}

/**
 * Normalize opencode's `question` tool prompts into the shape the shared
 * AskUserQuestion renderer expects: stable ids, `multiSelect` (opencode uses
 * `multiple`), and `{ label, description }` options.
 */
function normalizeOpenCodeQuestions(raw: unknown[]): unknown[] {
  return raw
    .map((item, index) => {
      if (!isRecord(item)) return null;
      const question = typeof item.question === "string" ? item.question : "";
      if (!question) return null;

      const options = Array.isArray(item.options)
        ? item.options
            .map((option) => {
              if (!isRecord(option)) return null;
              const label =
                typeof option.label === "string" ? option.label : "";
              if (!label) return null;
              return {
                label,
                description:
                  typeof option.description === "string"
                    ? option.description
                    : "",
              };
            })
            .filter(
              (option): option is { label: string; description: string } =>
                option !== null,
            )
        : [];

      return {
        id: `question-${index}`,
        question,
        header:
          typeof item.header === "string" && item.header.trim()
            ? item.header
            : "Question",
        options,
        multiSelect: Boolean(item.multiSelect ?? item.multiple),
        ...(typeof item.custom === "boolean" ? { custom: item.custom } : {}),
      };
    })
    .filter((question) => question !== null);
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

  // Extract agentId. Claude/SDK 0.2.76+ emit `agentId: <id>`; Kimi's Agent
  // emits `agent_id: agent-0`, while AgentSwarm wraps each child in a
  // `<subagent agent_id="agent-0" outcome="completed">` element. The current
  // renderer and server mapping are 1:1, so use the first swarm child.
  const directAgentId = fullText.match(/^agent(?:Id|_id):\s*(\S+)/m)?.[1];
  const firstSubagentAttributes = fullText.match(/<subagent\b([^>]*)>/i)?.[1];
  const swarmAgentId = firstSubagentAttributes?.match(
    /\bagent_id\s*=\s*["']([^"']+)["']/i,
  )?.[1];
  const agentId = directAgentId ?? swarmAgentId;
  if (!agentId) return undefined;

  // Kimi Agent results carry `status:`, while AgentSwarm puts `outcome=` on
  // each child. Honor terminal failures so interrupted children render as
  // failed; successful and legacy results default to completed.
  const explicitStatus =
    fullText.match(/^status:\s*([^\s]+)/m)?.[1] ??
    firstSubagentAttributes?.match(/\boutcome\s*=\s*["']([^"']+)["']/i)?.[1];
  const status =
    explicitStatus &&
    /^(?:failed|error|cancelled|canceled|timeout)$/i.test(explicitStatus)
      ? "failed"
      : "completed";

  const result: Record<string, unknown> = {
    agentId,
    status,
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

/**
 * Count tool_result blocks carried by a message. The message-level
 * `toolUseResult` field is only unambiguous when the message carries exactly
 * one tool_result block; with parallel tool calls batched into one message the
 * field belongs to an unknown block and must not be fanned out to all calls.
 */
function countToolResultBlocks(message: Message): number {
  const content =
    (message.message as { content?: string | ContentBlock[] } | undefined)
      ?.content ?? message.content;
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (block?.type === "tool_result") count += 1;
  }
  return count;
}

/** Rough completeness score used to decide which duplicate result to keep. */
function scoreToolResult(result: ToolResultData): number {
  let score = result.content.length;
  if (result.structured !== undefined && result.structured !== null) {
    // Structured payloads unlock rich renderers; weigh them heavily so a
    // JSONL-complete result beats a partial streaming snapshot.
    score += 10_000;
  }
  // For OpenCode `question` results, richer answer sets should outrank
  // partial ones. A live-stream `{questions, answers:{}}` snapshot arrives
  // before the completed tool_result carries the real `metadata.answers`;
  // without this, the empty-answers copy scores equal to the filled one and
  // `attachToolResult` keeps the stale copy on duplicate arrival.
  const structured = result.structured;
  if (
    structured &&
    typeof structured === "object" &&
    !Array.isArray(structured)
  ) {
    const answers = (structured as { answers?: unknown }).answers;
    if (answers && typeof answers === "object" && !Array.isArray(answers)) {
      score += Object.keys(answers as Record<string, unknown>).length;
    }
  }
  return score;
}

function attachToolResult(
  block: ContentBlock,
  resultMessage: Message,
  items: RenderItem[],
  toolCallIndices: Map<string, number>,
  pendingToolCalls: Map<string, number>,
): void {
  const toolUseId = block.tool_use_id;
  if (!toolUseId) return;

  let index = pendingToolCalls.get(toolUseId);
  let existingResult: ToolResultData | undefined;
  if (index === undefined) {
    // Late duplicate: the SDK stream and JSONL persistence can both deliver a
    // result for the same tool_use id (streaming partial vs complete). Allow
    // the richer copy to upgrade the already-attached result instead of
    // dropping it on the floor.
    index = toolCallIndices.get(toolUseId);
    if (index === undefined) {
      // Orphan result - shouldn't happen normally
      console.warn(`Tool result for unknown tool_use: ${toolUseId}`);
      return;
    }
    const existingItem = items[index];
    if (!existingItem || existingItem.type !== "tool_call") return;
    existingResult = existingItem.toolResult;
  }

  const item = items[index];
  if (!item || item.type !== "tool_call") return;

  // Attach result to existing tool call
  // Handle both camelCase (toolUseResult) and snake_case (tool_use_result) from SDK
  const content = typeof block.content === "string" ? block.content : "";
  // Only trust the message-level structured result when it unambiguously
  // belongs to this block (single tool_result per message).
  let structured =
    countToolResultBlocks(resultMessage) <= 1
      ? (resultMessage.toolUseResult ??
        (resultMessage as Record<string, unknown>).tool_use_result)
      : undefined;

  if (!structured) {
    structured = normalizeOpenCodeToolResult(
      item.toolName,
      content,
      block.is_error || false,
      item.toolInput,
      getBlockMetadata(block),
    );
  }

  // SDK 0.2.76+: Agent tool has no structured tool_use_result.
  // Parse agentId and usage stats from the text content blocks instead.
  if (
    !structured &&
    (item.toolName === "Agent" ||
      item.toolName === "AgentSwarm" ||
      item.toolName === "Task")
  ) {
    structured = parseAgentResultFromText(block);
  }

  const resultData: ToolResultData = {
    content,
    isError: block.is_error || false,
    structured,
  };

  if (
    existingResult &&
    scoreToolResult(existingResult) >= scoreToolResult(resultData)
  ) {
    // Existing copy is at least as complete; keep it.
    return;
  }

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

/**
 * Pull the provider-stamped metadata bag off a tool_result block. OpenCode
 * writes the final `state.metadata` (including `answers` for the `question`
 * tool) onto the completed `tool_result` as `opencodeMetadata`; the streamed
 * `tool_use` snapshot may never be re-emitted with that metadata, so the
 * result block is the authoritative source.
 */
function getBlockMetadata(block: ContentBlock): unknown {
  if (!isRecord(block)) return undefined;
  const metadata = block.opencodeMetadata;
  return metadata !== undefined ? metadata : undefined;
}

function normalizeOpenCodeToolResult(
  toolName: string,
  content: string,
  isError: boolean,
  input: unknown,
  resultMetadata?: unknown,
): unknown {
  const normalized = toolName.toLowerCase();

  if (normalized === "bash" || normalized === "shell") {
    return {
      stdout: isError ? "" : content,
      stderr: isError ? content : "",
      interrupted: false,
      isImage: false,
    };
  }

  if (normalized === "read") {
    return normalizeOpenCodeReadResult(content, input);
  }

  if (normalized === "write") {
    return normalizeOpenCodeWriteResult(input);
  }

  if (normalized === "edit" || normalized === "apply_patch") {
    return normalizeOpenCodeEditResult(input);
  }

  if (normalized === "glob") {
    const filenames = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("("));
    return {
      filenames,
      numFiles: filenames.length,
      durationMs: 0,
      truncated: content.includes("Results are truncated"),
    };
  }

  if (normalized === "grep") {
    const filenames = new Set<string>();
    for (const line of content.split("\n")) {
      if (!line.trim() || line.startsWith("  Line ")) continue;
      if (line.endsWith(":")) {
        filenames.add(line.slice(0, -1));
      }
    }
    return {
      mode: "content",
      filenames: Array.from(filenames),
      numFiles: filenames.size,
      content,
      numLines: content.split("\n").filter(Boolean).length,
    };
  }

  if (normalized === "todowrite" || normalized === "todo") {
    try {
      const todos = JSON.parse(content);
      if (Array.isArray(todos)) {
        return { oldTodos: [], newTodos: todos };
      }
    } catch {
      return undefined;
    }
  }

  if (normalized === "question") {
    return normalizeOpenCodeQuestionResult(input, resultMetadata);
  }

  return undefined;
}

/**
 * Build an AskUserQuestion-shaped result for opencode's `question` tool by
 * pairing the (already normalized) prompts with the selected answers.
 *
 * Answer precedence:
 * 1. `resultMetadata.answers` — stamped on the completed `tool_result`
 *    block's `opencodeMetadata` during live streaming. This is the
 *    authoritative source because the server emits the `tool_result` once
 *    the user submits, without re-emitting the `tool_use` with the final
 *    metadata (the `tool_use` dedup keys off the input fingerprint, which
 *    doesn't change when answers arrive).
 * 2. `input.opencodeMetadata.answers` — fallback for persisted snapshots
 *    where the metadata was also copied onto the `tool_use` block. Without
 *    this, full-session refreshes would regress.
 */
function normalizeOpenCodeQuestionResult(
  input: unknown,
  resultMetadata?: unknown,
): unknown {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return undefined;
  }
  const questions = input.questions;
  if (questions.length === 0) {
    return undefined;
  }

  const resultMeta = isRecord(resultMetadata) ? resultMetadata : undefined;
  const inputMeta = isRecord(input.opencodeMetadata)
    ? input.opencodeMetadata
    : undefined;
  const rawAnswers = Array.isArray(resultMeta?.answers)
    ? resultMeta.answers
    : Array.isArray(inputMeta?.answers)
      ? inputMeta.answers
      : [];

  const answers: Record<string, string[]> = {};
  questions.forEach((question, index) => {
    if (!isRecord(question) || typeof question.id !== "string") return;
    const rawAnswer = rawAnswers[index];
    const values = Array.isArray(rawAnswer)
      ? rawAnswer.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
      : typeof rawAnswer === "string" && rawAnswer
        ? [rawAnswer]
        : [];
    // Only record questions the user actually answered so the summary and
    // per-question selection reflect unanswered prompts correctly.
    if (values.length > 0) {
      answers[question.id] = values;
    }
  });

  return { questions, answers };
}

function normalizeOpenCodeEditResult(input: unknown): unknown {
  if (!isRecord(input)) {
    return undefined;
  }

  const filePath = getOpenCodeFilePath(input);
  const oldString = getStringInputField(input, "old_string", "oldString");
  const newString = getStringInputField(input, "new_string", "newString");
  const replaceAll =
    typeof input.replace_all === "boolean"
      ? input.replace_all
      : typeof input.replaceAll === "boolean"
        ? input.replaceAll
        : false;

  if (!filePath || oldString === undefined || newString === undefined) {
    return undefined;
  }

  return {
    filePath,
    oldString,
    newString,
    originalFile: oldString,
    replaceAll,
    userModified: false,
    structuredPatch: createReplacementPatch(oldString, newString),
  };
}

function createReplacementPatch(oldString: string, newString: string) {
  const oldLines = oldString.length > 0 ? oldString.split("\n") : [];
  const newLines = newString.length > 0 ? newString.split("\n") : [];
  const lines = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];

  return [
    {
      oldStart: 1,
      oldLines: Math.max(oldLines.length, 1),
      newStart: 1,
      newLines: Math.max(newLines.length, 1),
      lines,
    },
  ];
}

function normalizeOpenCodeWriteResult(input: unknown): unknown {
  if (!isRecord(input)) {
    return undefined;
  }

  const filePath = getOpenCodeFilePath(input);
  const content = typeof input.content === "string" ? input.content : undefined;
  if (!filePath || content === undefined) {
    return undefined;
  }

  const lineCount = content.split("\n").length;
  return {
    type: "text",
    file: {
      filePath,
      content,
      numLines: lineCount,
      startLine: 1,
      totalLines: lineCount,
    },
  };
}

function getOpenCodeFilePath(
  input: Record<string, unknown>,
): string | undefined {
  return getStringInputField(input, "file_path", "filePath", "path");
}

function getStringInputField(
  input: Record<string, unknown>,
  ...fields: string[]
): string | undefined {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function normalizeOpenCodeReadResult(content: string, input: unknown): unknown {
  const filePath =
    getXmlTag(content, "path") ??
    (isRecord(input) &&
    (typeof input.file_path === "string" || typeof input.filePath === "string")
      ? String(input.file_path ?? input.filePath)
      : "");
  if (!filePath) {
    return undefined;
  }

  const type = getXmlTag(content, "type");
  const taggedContent =
    getXmlTag(content, "content") ?? getXmlTag(content, "entries");
  const isKimiNumberedText =
    taggedContent === undefined && /^\d+\t/m.test(content);
  if (!taggedContent && !isKimiNumberedText) {
    return {
      type: "text",
      file: {
        filePath,
        content,
        numLines: content.split("\n").length,
        startLine: 1,
        totalLines: content.split("\n").length,
      },
    };
  }
  const rawContent = taggedContent ?? content;

  const startLine = parseOpenCodeReadStartLine(rawContent);
  const text =
    type === "directory"
      ? rawContent.trim()
      : stripOpenCodeReadLineNumbers(rawContent);
  const numLines = text ? text.split("\n").length : 0;
  const totalLines =
    parseOpenCodeReadTotalLines(content) ??
    Math.max(startLine + Math.max(numLines - 1, 0), numLines);

  return {
    type: "text",
    file: {
      filePath,
      content: text,
      numLines,
      startLine,
      totalLines,
    },
  };
}

function getXmlTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1]?.trim();
}

function stripOpenCodeReadLineNumbers(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("(End of file") && !line.startsWith("(Showing lines"),
    )
    .map((line) => line.replace(/^\d+(?::\s?|\t)/, ""))
    .join("\n")
    .trimEnd();
}

function parseOpenCodeReadStartLine(text: string): number {
  const firstNumberedLine = text.match(/^(\d+)(?::|\t)/m);
  return firstNumberedLine?.[1] ? Number.parseInt(firstNumberedLine[1], 10) : 1;
}

function parseOpenCodeReadTotalLines(text: string): number | undefined {
  const totalMatch =
    text.match(/total\s+(\d+)\s+lines/i) ?? text.match(/of\s+(\d+)\./i);
  return totalMatch?.[1] ? Number.parseInt(totalMatch[1], 10) : undefined;
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

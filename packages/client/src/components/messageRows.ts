import type { RenderItem } from "../types/renderItems";

/**
 * Pure row-model for the message list.
 *
 * MessageList used to render turnGroups inline, interleaved with header/footer
 * blocks (load-older / load-newer / pending / deferred / compacting / processing).
 * That made virtualization impossible because there was no single flat list to
 * window over.
 *
 * `buildMessageRows` collapses everything into one flat `MessageRow[]` so the
 * component can render `rows.map(renderRow)` and (in a later step) hand the same
 * array to a virtualizer. This module is intentionally free of React/DOM so it
 * can be unit-tested in isolation.
 */

/** Pending message waiting for server confirmation */
export interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  status?: string;
}

/** Deferred message queued server-side */
export interface DeferredMessage {
  tempId?: string;
  content: string;
  timestamp: string;
}

export type MessageRow =
  | { kind: "load-older" }
  | {
      kind: "user-prompt";
      key: string;
      item: RenderItem;
      shouldFocusBranch: boolean;
      isTarget: boolean;
    }
  | {
      kind: "assistant-turn";
      key: string;
      items: RenderItem[];
      /** Text blocks immediately preceding an answered question are progress. */
      progressTextItemIds: string[];
      /** This turn resumed after a question result that contains the user's answer. */
      resumedAfterQuestion: boolean;
      turnTimestamp?: string;
      /** Most recent timestamp among all source messages in this turn. */
      turnUpdatedAt?: string;
      turnCopyText?: string;
      turnHasTarget: boolean;
    }
  | { kind: "load-newer" }
  | { kind: "pending"; key: string; pending: PendingMessage }
  | { kind: "deferred"; key: string; deferred: DeferredMessage; index: number }
  | { kind: "compacting" }
  | { kind: "processing" };

interface MessageTurnGroup {
  isUserPrompt: boolean;
  items: RenderItem[];
  resumedAfterQuestion: boolean;
}

/**
 * Assigns the React key for one assistant turn.
 *
 * `MessageList` supplies a sticky implementation so a turn keeps its key when
 * older messages are prepended (load-older) or when the live turn grows. See
 * `defaultTurnKey` for the window-relative fallback.
 */
export type TurnKeyResolver = (items: RenderItem[]) => string;

/**
 * Window-relative turn key. Only safe when the transcript window never gains
 * items at the head of a turn, so it is a fallback for callers (mostly tests)
 * that do not track turn identity across pagination.
 */
export function defaultTurnKey(items: RenderItem[]): string {
  const firstItem = items[0];
  return `turn-${firstItem ? firstItem.id : "empty"}`;
}

/**
 * Build a resolver that keeps a turn's key stable across pagination.
 *
 * `registry` maps render-item id → the turn key that item was first rendered
 * under, and is owned by the caller so it survives re-renders. Load-older
 * prepends items into the turn at the top of the window; without this, the key
 * would change and React would unmount the whole turn subtree — destroying any
 * in-progress text selection and the scroll anchor with it.
 *
 * One resolver instance covers exactly one `buildMessageRows` pass: it tracks
 * the keys it has already handed out so a turn that splits in two (an answered
 * question ends a turn) cannot produce duplicate React keys.
 */
export function createStickyTurnKeyResolver(
  registry: Map<string, string>,
): TurnKeyResolver {
  const claimedKeys = new Set<string>();

  return (items: RenderItem[]): string => {
    let key: string | undefined;
    for (const item of items) {
      const knownKey = registry.get(item.id);
      if (knownKey && !claimedKeys.has(knownKey)) {
        key = knownKey;
        break;
      }
    }

    if (!key) {
      const fallbackKey = defaultTurnKey(items);
      key = fallbackKey;
      let suffix = 2;
      while (claimedKeys.has(key)) {
        key = `${fallbackKey}-${suffix}`;
        suffix += 1;
      }
    }

    claimedKeys.add(key);
    for (const item of items) registry.set(item.id, key);
    return key;
  };
}

/**
 * Forget registry entries for items that left the transcript window (active
 * window trim, branch switch, load-newer) so the map cannot grow unbounded.
 */
export function pruneTurnKeyRegistry(
  registry: Map<string, string>,
  liveItems: RenderItem[],
): void {
  if (registry.size <= liveItems.length * 2) return;
  const liveItemIds = new Set(liveItems.map((item) => item.id));
  for (const itemId of Array.from(registry.keys())) {
    if (!liveItemIds.has(itemId)) registry.delete(itemId);
  }
}

function isQuestionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "question" || normalized === "askuserquestion";
}

function hasRecordedQuestionAnswer(item: RenderItem): boolean {
  if (item.type !== "tool_call") return false;
  const structured = item.toolResult?.structured;
  if (
    !structured ||
    typeof structured !== "object" ||
    Array.isArray(structured)
  ) {
    return false;
  }
  const answers = (structured as { answers?: unknown }).answers;
  return (
    answers !== null &&
    typeof answers === "object" &&
    !Array.isArray(answers) &&
    Object.keys(answers).length > 0
  );
}

/**
 * A successful question result is an implicit user interaction. Providers such
 * as some providers persist the answer on the tool result instead of emitting a new
 * user-prompt message, so it still needs to end the current visual turn.
 */
function isAnsweredQuestion(item: RenderItem): boolean {
  return (
    item.type === "tool_call" &&
    isQuestionToolName(item.toolName) &&
    item.status === "complete" &&
    item.toolResult !== undefined &&
    !item.toolResult.isError &&
    hasRecordedQuestionAnswer(item)
  );
}

/**
 * Groups consecutive assistant items (text, thinking, tool_call) into turns.
 * User prompts and successful question results break the grouping. The latter
 * preserves the otherwise-hidden point where the user answered and the agent
 * resumed execution.
 */
export function groupItemsIntoTurns(items: RenderItem[]): MessageTurnGroup[] {
  const groups: MessageTurnGroup[] = [];
  let currentAssistantGroup: RenderItem[] = [];
  let currentResumedAfterQuestion = false;
  let nextAssistantResumesAfterQuestion = false;

  const flushAssistantGroup = () => {
    if (currentAssistantGroup.length === 0) return;
    groups.push({
      isUserPrompt: false,
      items: currentAssistantGroup,
      resumedAfterQuestion: currentResumedAfterQuestion,
    });
    currentAssistantGroup = [];
    currentResumedAfterQuestion = false;
  };

  for (const item of items) {
    if (item.type === "user_prompt" || item.type === "session_setup") {
      // Flush any pending assistant items
      flushAssistantGroup();
      // An explicit user row already provides the visual boundary.
      nextAssistantResumesAfterQuestion = false;
      // User prompt is its own group
      groups.push({
        isUserPrompt: true,
        items: [item],
        resumedAfterQuestion: false,
      });
    } else {
      if (currentAssistantGroup.length === 0) {
        currentResumedAfterQuestion = nextAssistantResumesAfterQuestion;
        nextAssistantResumesAfterQuestion = false;
      }
      // Accumulate assistant items
      currentAssistantGroup.push(item);
      if (isAnsweredQuestion(item)) {
        flushAssistantGroup();
        nextAssistantResumesAfterQuestion = true;
      }
    }
  }

  // Flush remaining assistant items
  flushAssistantGroup();

  return groups;
}

/**
 * Providers without commentary/final markers treat only the contiguous
 * text immediately before an answered question as progress: it is a checkpoint
 * leading into a decision, not the final response for the whole user turn.
 */
function getQuestionPreludeTextItemIds(items: RenderItem[]): string[] {
  let questionIndex = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item && isAnsweredQuestion(item)) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return [];

  const ids: string[] = [];
  for (let index = questionIndex - 1; index >= 0; index--) {
    const item = items[index];
    if (!item || item.type !== "text") break;
    if (item.phase === undefined) {
      ids.unshift(item.id);
    }
  }
  return ids;
}

export function getBranchId(item: RenderItem): string | undefined {
  if (item.type !== "user_prompt") return undefined;
  const source = item.sourceMessages[0];
  return source?.branch?.branchId ?? source?.codexBranch?.branchId;
}

/**
 * Stable key for a row, used both as the React key and as the virtualizer's
 * `getItemKey`. A stable key lets the virtualizer keep measured heights when
 * rows are prepended (load-older), so scroll anchoring stays accurate.
 */
export function getRowKey(row: MessageRow): string {
  return "key" in row ? row.key : row.kind;
}

/** Concatenate text-block content for a turn's copy button. */
function getTurnCopyText(items: RenderItem[]): string {
  return items
    .filter(
      (item): item is RenderItem & { type: "text"; text: string } =>
        item.type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

/** Return the newest valid source-message timestamp in an assistant turn. */
function getTurnUpdatedAt(items: RenderItem[]): string | undefined {
  let latestTimestamp: string | undefined;
  let latestTimestampMs = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    for (const message of item.sourceMessages) {
      if (typeof message.timestamp !== "string") continue;
      const timestampMs = Date.parse(message.timestamp);
      if (Number.isNaN(timestampMs) || timestampMs <= latestTimestampMs) {
        continue;
      }
      latestTimestamp = message.timestamp;
      latestTimestampMs = timestampMs;
    }
  }

  return latestTimestamp;
}

interface BuildMessageRowsParams {
  /** Visible render items (already filtered of plan-progress items). */
  items: RenderItem[];
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  pendingMessages: PendingMessage[];
  deferredMessages: DeferredMessage[];
  isCompacting: boolean;
  /** Render-item id of the branch prompt to focus, if any. */
  focusedBranchItemId: string | null;
  /** Render-item id containing the deep-link target message, if any. */
  targetItemId: string | null;
  /** Turn-key strategy. Defaults to the window-relative `defaultTurnKey`. */
  resolveTurnKey?: TurnKeyResolver;
}

/**
 * Build the flat row model from render items plus the surrounding UI state.
 *
 * Row order mirrors the previous inline JSX exactly:
 *   load-older? → turns → load-newer? → pending* → deferred* → compacting? →
 *   processing (always present; the indicator self-hides when idle).
 */
export function buildMessageRows({
  items,
  hasOlderMessages,
  hasNewerMessages,
  pendingMessages,
  deferredMessages,
  isCompacting,
  focusedBranchItemId,
  targetItemId,
  resolveTurnKey = defaultTurnKey,
}: BuildMessageRowsParams): MessageRow[] {
  const rows: MessageRow[] = [];

  if (hasOlderMessages) {
    rows.push({ kind: "load-older" });
  }

  const turnGroups = groupItemsIntoTurns(items);
  for (const group of turnGroups) {
    if (group.isUserPrompt) {
      const item = group.items[0];
      if (!item) continue;
      rows.push({
        kind: "user-prompt",
        key: item.id,
        item,
        shouldFocusBranch: item.id === focusedBranchItemId,
        isTarget: item.id === targetItemId,
      });
      continue;
    }

    const firstItem = group.items[0];
    if (!firstItem) continue;
    const turnCopyText = getTurnCopyText(group.items);
    rows.push({
      kind: "assistant-turn",
      key: resolveTurnKey(group.items),
      items: group.items,
      progressTextItemIds: getQuestionPreludeTextItemIds(group.items),
      resumedAfterQuestion: group.resumedAfterQuestion,
      turnTimestamp: firstItem.sourceMessages[0]?.timestamp,
      turnUpdatedAt: getTurnUpdatedAt(group.items),
      turnCopyText: turnCopyText || undefined,
      turnHasTarget: group.items.some((item) => item.id === targetItemId),
    });
  }

  if (hasNewerMessages) {
    rows.push({ kind: "load-newer" });
  }

  for (const pending of pendingMessages) {
    rows.push({ kind: "pending", key: pending.tempId, pending });
  }

  deferredMessages.forEach((deferred, index) => {
    rows.push({
      kind: "deferred",
      key: deferred.tempId ?? `deferred-${index}`,
      deferred,
      index,
    });
  });

  if (isCompacting) {
    rows.push({ kind: "compacting" });
  }

  // ProcessingIndicator was always rendered (it returns null when idle), so
  // keep it as a permanent trailing row to preserve behavior exactly.
  rows.push({ kind: "processing" });

  return rows;
}

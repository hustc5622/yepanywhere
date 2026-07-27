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

/**
 * Groups consecutive assistant items (text, thinking, tool_call) into turns.
 * User prompts break the grouping and are returned as separate groups.
 */
export function groupItemsIntoTurns(
  items: RenderItem[],
): Array<{ isUserPrompt: boolean; items: RenderItem[] }> {
  const groups: Array<{ isUserPrompt: boolean; items: RenderItem[] }> = [];
  let currentAssistantGroup: RenderItem[] = [];

  for (const item of items) {
    if (item.type === "user_prompt" || item.type === "session_setup") {
      // Flush any pending assistant items
      if (currentAssistantGroup.length > 0) {
        groups.push({ isUserPrompt: false, items: currentAssistantGroup });
        currentAssistantGroup = [];
      }
      // User prompt is its own group
      groups.push({ isUserPrompt: true, items: [item] });
    } else {
      // Accumulate assistant items
      currentAssistantGroup.push(item);
    }
  }

  // Flush remaining assistant items
  if (currentAssistantGroup.length > 0) {
    groups.push({ isUserPrompt: false, items: currentAssistantGroup });
  }

  return groups;
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
      key: `turn-${firstItem.id}`,
      items: group.items,
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

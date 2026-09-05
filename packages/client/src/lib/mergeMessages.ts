import { orderByParentChain } from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";

/**
 * Get the message ID, preferring uuid over id.
 * Messages should always have at least one identifier; assigns an object-local
 * fallback for malformed messages so missing IDs do not collapse together.
 */
const missingMessageIds = new WeakMap<Message, string>();
let nextMissingMessageId = 0;

export function getMessageId(m: Message): string {
  if (typeof m.uuid === "string" && m.uuid.length > 0) {
    return m.uuid;
  }
  if (typeof m.id === "string" && m.id.length > 0) {
    return m.id;
  }

  let fallback = missingMessageIds.get(m);
  if (!fallback) {
    nextMissingMessageId += 1;
    fallback = `missing-message-id-${nextMissingMessageId}`;
    missingMessageIds.set(m, fallback);
  }
  return fallback;
}

/**
 * Helper to get content from a message, handling both top-level and SDK nested structure.
 * SDK messages have content nested in message.content.
 */
export function getMessageContent(m: Message): unknown {
  return m.content ?? (m.message as { content?: unknown } | undefined)?.content;
}

function getMessageRole(m: Message): string | undefined {
  const nestedRole = (m.message as { role?: unknown } | undefined)?.role;
  if (
    nestedRole === "user" ||
    nestedRole === "assistant" ||
    nestedRole === "system"
  ) {
    return nestedRole;
  }
  if (m.role === "user" || m.role === "assistant" || m.role === "system") {
    return m.role;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function structurallyEquivalent(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  const compared = new WeakMap<object, WeakSet<object>>();
  while (pending.length > 0) {
    const pair = pending.pop();
    if (!pair) continue;
    const [a, b] = pair;
    if (Object.is(a, b)) continue;
    if (
      !a ||
      !b ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      Array.isArray(a) !== Array.isArray(b)
    ) {
      return false;
    }
    const seenRight = compared.get(a);
    if (seenRight?.has(b)) continue;
    if (seenRight) seenRight.add(b);
    else compared.set(a, new WeakSet([b]));

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index += 1) {
        pending.push([a[index], b[index]]);
      }
      continue;
    }

    const leftRecord = a as Record<string, unknown>;
    const rightRecord = b as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(rightRecord, key)) return false;
      pending.push([leftRecord[key], rightRecord[key]]);
    }
  }
  return true;
}

type MergeableContentBlock = ContentBlock & Record<string, unknown>;

function isContentBlock(value: unknown): value is MergeableContentBlock {
  return isRecord(value) && typeof value.type === "string";
}

function getContentBlocks(message: Message): MergeableContentBlock[] | null {
  const content = getMessageContent(message);
  if (!Array.isArray(content)) {
    return null;
  }
  return content.filter(isContentBlock);
}

function getBlockText(block: MergeableContentBlock): string | undefined {
  if (block.type === "thinking") {
    return typeof block.thinking === "string" ? block.thinking : undefined;
  }
  if (block.type === "text") {
    return typeof block.text === "string" ? block.text : undefined;
  }
  return undefined;
}

function getBlockKey(block: MergeableContentBlock): string | null {
  if (typeof block.id === "string" && block.id) {
    return `${String(block.type)}:${block.id}`;
  }
  if (typeof block.tool_use_id === "string" && block.tool_use_id) {
    return `${String(block.type)}:${block.tool_use_id}`;
  }
  return null;
}

function blocksAreSameStream(
  existing: MergeableContentBlock | undefined,
  incoming: MergeableContentBlock,
): boolean {
  if (!existing || existing.type !== incoming.type) {
    return false;
  }

  const existingKey = getBlockKey(existing);
  const incomingKey = getBlockKey(incoming);
  if (existingKey || incomingKey) {
    return existingKey === incomingKey;
  }

  const existingText = getBlockText(existing);
  const incomingText = getBlockText(incoming);
  if (existingText === undefined || incomingText === undefined) {
    return false;
  }

  return (
    incomingText.startsWith(existingText) ||
    existingText.startsWith(incomingText)
  );
}

/**
 * Richness score for tool_result content so streaming partials never
 * clobber a more complete snapshot: structured arrays beat strings,
 * longer strings beat shorter ones, anything beats null/undefined.
 */
function getToolResultContentRichness(value: unknown): number {
  if (Array.isArray(value)) {
    return 1_000_000 + value.length;
  }
  if (typeof value === "string") {
    return value.length;
  }
  if (value === null || value === undefined) {
    return -1;
  }
  return 0;
}

function mergeBlocks(
  existing: MergeableContentBlock,
  incoming: MergeableContentBlock,
): MergeableContentBlock {
  const existingText = getBlockText(existing);
  const incomingText = getBlockText(incoming);

  if (incoming.type === "thinking" && incomingText !== undefined) {
    return {
      ...existing,
      ...incoming,
      thinking:
        existingText && existingText.length > incomingText.length
          ? existingText
          : incomingText,
    };
  }

  if (incoming.type === "text" && incomingText !== undefined) {
    return {
      ...existing,
      ...incoming,
      text:
        existingText && existingText.length > incomingText.length
          ? existingText
          : incomingText,
    };
  }

  if (incoming.type === "tool_result") {
    // Shallow spread would let a partial streaming snapshot (short or empty
    // content) overwrite the complete result. Keep the richer content copy.
    const merged: MergeableContentBlock = { ...existing, ...incoming };
    if (
      getToolResultContentRichness(existing.content) >
      getToolResultContentRichness(incoming.content)
    ) {
      merged.content = existing.content;
    }
    return merged;
  }

  return { ...existing, ...incoming };
}

function hasEquivalentBlock(
  blocks: MergeableContentBlock[],
  incoming: MergeableContentBlock,
): boolean {
  const incomingKey = getBlockKey(incoming);
  const incomingText = getBlockText(incoming);

  return blocks.some((block) => {
    const blockKey = getBlockKey(block);
    if (incomingKey || blockKey) {
      return incomingKey === blockKey;
    }

    return (
      block.type === incoming.type &&
      incomingText !== undefined &&
      getBlockText(block) === incomingText
    );
  });
}

function cloneBlock(block: MergeableContentBlock): MergeableContentBlock {
  return { ...block, type: block.type };
}

function shallowBlockEqual(
  left: MergeableContentBlock,
  right: MergeableContentBlock,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function mergeSdkContentBlocks(existing: Message, incoming: Message): Message {
  const existingBlocks = getContentBlocks(existing);
  const incomingBlocks = getContentBlocks(incoming);
  if (!existingBlocks || !incomingBlocks) {
    return incoming;
  }

  const mergedBlocks: MergeableContentBlock[] = existingBlocks.map(cloneBlock);

  for (let index = 0; index < incomingBlocks.length; index += 1) {
    const incomingBlock = incomingBlocks[index];
    if (!incomingBlock) continue;
    const existingAtIndex = mergedBlocks[index];

    if (
      existingAtIndex &&
      blocksAreSameStream(existingAtIndex, incomingBlock)
    ) {
      mergedBlocks[index] = mergeBlocks(existingAtIndex, incomingBlock);
      continue;
    }

    const lastIndex = mergedBlocks.length - 1;
    const lastBlock = mergedBlocks[lastIndex];
    if (lastBlock && blocksAreSameStream(lastBlock, incomingBlock)) {
      mergedBlocks[lastIndex] = mergeBlocks(lastBlock, incomingBlock);
      continue;
    }

    if (!hasEquivalentBlock(mergedBlocks, incomingBlock)) {
      mergedBlocks.push(cloneBlock(incomingBlock));
    }
  }

  return {
    ...incoming,
    message: {
      ...(incoming.message ?? {}),
      content: mergedBlocks,
    },
  };
}

function mergeAuthoritativeContentBlocks(
  existing: Message,
  incoming: Message,
): Message {
  const existingBlocks = getContentBlocks(existing);
  const incomingBlocks = getContentBlocks(incoming);
  if (!existingBlocks || !incomingBlocks) {
    return incoming;
  }

  let changed = false;
  const mergedBlocks = incomingBlocks.map((incomingBlock, index) => {
    const existingAtIndex = existingBlocks[index];
    let mergedBlock: MergeableContentBlock;
    if (blocksAreSameStream(existingAtIndex, incomingBlock)) {
      mergedBlock = mergeBlocks(
        existingAtIndex as MergeableContentBlock,
        incomingBlock,
      );
    } else {
      const matchingExisting = existingBlocks.find((block) =>
        blocksAreSameStream(block, incomingBlock),
      );
      mergedBlock = matchingExisting
        ? mergeBlocks(matchingExisting, incomingBlock)
        : incomingBlock;
    }

    if (!shallowBlockEqual(mergedBlock, incomingBlock)) {
      changed = true;
    }
    return mergedBlock;
  });

  if (!changed) return incoming;

  return {
    ...incoming,
    message: {
      ...(incoming.message ?? {}),
      content: mergedBlocks,
    },
  };
}

function getConversationSiblingKey(m: Message): string | null {
  if (m.parentUuid == null) {
    return null;
  }

  const type = m.type;
  if (type !== "user" && type !== "assistant") {
    return null;
  }

  return `${m.parentUuid}:${type}:${getMessageRole(m) ?? ""}`;
}

function hasAuthoritativeSibling(
  existing: Message[],
  incoming: Message,
): boolean {
  const incomingKey = getConversationSiblingKey(incoming);
  if (!incomingKey) {
    return false;
  }

  const incomingId = getMessageId(incoming);
  return existing.some((message) => {
    if ((message._source ?? "sdk") !== "jsonl") {
      return false;
    }
    if (getMessageId(message) === incomingId) {
      return false;
    }
    return getConversationSiblingKey(message) === incomingKey;
  });
}

function pruneSupersededSdkSiblings(
  messages: Message[],
  authoritativeMessages: Message[],
): Message[] {
  const authoritativeSiblingKeys = new Set<string>();

  for (const message of authoritativeMessages) {
    const key = getConversationSiblingKey(message);
    if (key) {
      authoritativeSiblingKeys.add(key);
    }
  }

  if (authoritativeSiblingKeys.size === 0) {
    return messages;
  }

  const filtered = messages.filter((message) => {
    if ((message._source ?? "sdk") === "jsonl") {
      return true;
    }

    const key = getConversationSiblingKey(message);
    if (!key) {
      return true;
    }

    return !authoritativeSiblingKeys.has(key);
  });

  return filtered.length === messages.length ? messages : filtered;
}

/**
 * Merge messages from different sources.
 * JSONL (from disk) is authoritative; SDK (streaming) provides real-time updates.
 *
 * Strategy:
 * - If message only exists from one source, use it
 * - If both exist, use JSONL as base but preserve any SDK-only fields
 * - Warn if SDK has fields that JSONL doesn't (validates our assumption)
 */
export function mergeMessage(
  existing: Message | undefined,
  incomingMessage: Message,
  incomingSource: "sdk" | "jsonl",
): Message {
  // Adoption is monotonic: a late admission echo must not turn an already
  // confirmed user prompt back into a pending bubble. Persisted input also
  // clears the transient optimistic flag even though JSONL doesn't carry it.
  const clearOptimistic =
    incomingMessage.type === "user" &&
    (incomingMessage.isOptimistic === true ||
      existing?.isOptimistic === true) &&
    (incomingSource === "jsonl" ||
      existing?._source === "jsonl" ||
      (existing?.type === "user" && existing.isOptimistic !== true));
  const incoming = clearOptimistic
    ? { ...incomingMessage, isOptimistic: false }
    : incomingMessage;

  if (!existing) {
    return { ...incoming, _source: incomingSource };
  }

  const existingSource = existing._source ?? "sdk";

  // If incoming is JSONL, it's authoritative - use it as base
  if (incomingSource === "jsonl") {
    // SDK messages have extra streaming metadata not persisted to JSONL:
    // - session_id: routing/tracking for the streaming session
    // - parent_tool_use_id: tracks which tool spawned a sub-agent message
    // - eventType: stream envelope type (message, status, etc.)
    // This is expected - JSONL stores conversation content, SDK includes transient fields.
    // The merge preserves SDK-only fields while using JSONL as authoritative base.
    // Merge nested content blocks before applying the authoritative envelope.
    // A Codex disk snapshot can lag the live app-server stream, so a shallow
    // spread here would discard SDK-only block fields such as `partialOutput`
    // (or replace a complete tool result with a shorter persisted snapshot).
    const mergedContent = mergeAuthoritativeContentBlocks(existing, incoming);
    const merged: Message = {
      ...existing,
      ...mergedContent,
      _source: "jsonl",
    };
    return structurallyEquivalent(existing, merged) ? existing : merged;
  }

  // If incoming is SDK and existing is JSONL, keep JSONL (it's authoritative)
  if (existingSource === "jsonl") {
    // Keep the persisted envelope while carrying forward richer live fields on
    // the same block. This is also used by Codex semantic reconciliation when
    // stream and JSONL copies have different message IDs but the same tool ID.
    const mergedContent = mergeAuthoritativeContentBlocks(incoming, existing);
    if (mergedContent === existing) {
      return existing;
    }
    return {
      ...incoming,
      ...mergedContent,
      _source: "jsonl",
    };
  }

  // Both are SDK - use the newer one (incoming)
  return {
    ...mergeSdkContentBlocks(existing, incoming),
    _source: "sdk",
  };
}

export interface MergeJSONLResult {
  messages: Message[];
}

/**
 * Merge incoming JSONL messages with existing messages.
 *
 * Handles:
 * - Deduplication by message ID (uuid)
 * - Position preservation
 * - Adding new messages at end
 *
 * Note: Temp message deduplication is no longer needed since pending messages
 * are tracked separately via tempId echoed from stream.
 */
export function mergeJSONLMessages(
  existing: Message[],
  incoming: Message[],
  options?: { skipDagOrdering?: boolean },
): MergeJSONLResult {
  // Create a map of existing messages for efficient lookup
  // Use getMessageId for canonical identifier (uuid preferred over id)
  const messageMap = new Map(existing.map((m) => [getMessageId(m), m]));

  // Merge each incoming JSONL message
  for (const incomingMsg of incoming) {
    const incomingId = getMessageId(incomingMsg);
    const existingMsg = messageMap.get(incomingId);
    messageMap.set(incomingId, mergeMessage(existingMsg, incomingMsg, "jsonl"));
  }

  // Build result array, preserving order
  const result: Message[] = [];
  const seen = new Set<string>();

  // First add existing messages (in order)
  for (const msg of existing) {
    const msgId = getMessageId(msg);
    if (!seen.has(msgId)) {
      result.push(messageMap.get(msgId) ?? msg);
      seen.add(msgId);
    }
  }

  // Then add any truly new messages
  for (const incomingMsg of incoming) {
    const incomingId = getMessageId(incomingMsg);
    if (!seen.has(incomingId)) {
      result.push(messageMap.get(incomingId) ?? incomingMsg);
      seen.add(incomingId);
    }
  }

  const reconciled = pruneSupersededSdkSiblings(result, incoming);

  // Reorder messages by parentUuid chain to fix race conditions
  // where stream messages arrived before their parent (e.g., agent response before user message)
  if (options?.skipDagOrdering) {
    return { messages: reconciled };
  }
  return { messages: orderByParentChain(reconciled) };
}

export interface MergeStreamResult {
  messages: Message[];
  /** Index where the message was inserted/updated */
  index: number;
}

/**
 * Merge an incoming stream message with existing messages.
 *
 * Handles:
 * - Merging with existing message if same ID
 * - Adding new messages at end
 *
 * Note: Temp message replacement is no longer needed since pending messages
 * are tracked separately via tempId echoed from stream.
 */
export function mergeStreamMessage(
  existing: Message[],
  incoming: Message,
): MergeStreamResult {
  if (
    incoming.isReplay === true &&
    hasAuthoritativeSibling(existing, incoming)
  ) {
    return {
      messages: existing,
      index: -1,
    };
  }

  const incomingId = getMessageId(incoming);
  // Check for existing message with same ID
  const existingIdx = existing.findIndex((m) => getMessageId(m) === incomingId);

  // A provider echo under the persisted id names the optimistic row it
  // replaces (Pi: client UUID -> session entry id). Swap that row in place so
  // the prompt keeps its position and does not render twice.
  const supersededId =
    typeof incoming.supersedesMessageId === "string" &&
    incoming.supersedesMessageId !== incomingId
      ? incoming.supersedesMessageId
      : null;
  const supersededIdx =
    supersededId === null
      ? -1
      : existing.findIndex((m) => getMessageId(m) === supersededId);
  if (supersededIdx >= 0) {
    if (existingIdx >= 0) {
      // The persisted copy is already loaded; drop the optimistic row and let
      // the echo merge into the existing message below.
      const withoutSuperseded = existing.filter(
        (_, index) => index !== supersededIdx,
      );
      return mergeStreamMessage(withoutSuperseded, incoming);
    }
    const optimistic = existing[supersededIdx];
    const updated = [...existing];
    updated[supersededIdx] = {
      ...optimistic,
      ...incoming,
      isOptimistic: false,
      _source: "sdk",
    };
    return { messages: updated, index: supersededIdx };
  }

  if (existingIdx >= 0) {
    // Merge with existing message
    const existingMsg = existing[existingIdx];
    const merged = mergeMessage(existingMsg, incoming, "sdk");

    // Only update if actually different
    if (existingMsg === merged) {
      return {
        messages: existing,
        index: existingIdx,
      };
    }

    const updated = [...existing];
    updated[existingIdx] = merged;
    return {
      messages: updated,
      index: existingIdx,
    };
  }

  // Add new message
  return {
    messages: [...existing, { ...incoming, _source: "sdk" }],
    index: existing.length,
  };
}

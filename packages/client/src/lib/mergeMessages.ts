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
  incoming: Message,
  incomingSource: "sdk" | "jsonl",
): Message {
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
    return {
      ...existing,
      ...incoming,
      _source: "jsonl",
    };
  }

  // If incoming is SDK and existing is JSONL, keep JSONL (it's authoritative)
  if (existingSource === "jsonl") {
    return existing;
  }

  // Both are SDK - use the newer one (incoming)
  return { ...mergeSdkContentBlocks(existing, incoming), _source: "sdk" };
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

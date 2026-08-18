/**
 * Compact-boundary pagination for session messages.
 *
 * Slices a normalized message array at compact_boundary positions to reduce
 * payload size for initial loads. This runs AFTER normalization but BEFORE
 * expensive augmentation (markdown, diffs, syntax highlighting).
 */

import type { Message } from "../supervisor/types.js";

/** Pagination metadata returned alongside sliced messages */
export interface PaginationInfo {
  /** Whether there are older messages not included in this response */
  hasOlderMessages: boolean;
  /** Whether there are newer messages not included in this response */
  hasNewerMessages?: boolean;
  /** Total message count in the full session */
  totalMessageCount: number;
  /** Number of messages returned in this response */
  returnedMessageCount: number;
  /** UUID of the first returned message (pass as beforeMessageId to load previous chunk) */
  truncatedBeforeMessageId?: string;
  /** UUID of the last returned message (pass as afterWindowMessageId to load next chunk) */
  truncatedAfterMessageId?: string;
  /** Total number of compact_boundary entries in the session */
  totalCompactions: number;
  /** Target message requested by an anchored window request */
  targetMessageId?: string;
  /** Whether the target message was found in the normalized session */
  targetMessageFound?: boolean;
  /** Rollout revision used to build this page, when supplied by Codex. */
  rolloutRevision?: string;
}

/** Result of slicing messages at compact boundaries */
export interface SliceResult {
  messages: Message[];
  pagination: PaginationInfo;
}

function getMessageId(m: Message): string | undefined {
  return m.uuid ?? (typeof m.id === "string" ? m.id : undefined);
}

function isCompactBoundary(m: Message): boolean {
  return m.type === "system" && m.subtype === "compact_boundary";
}

/**
 * Slice messages to return only the tail portion starting from the Nth-from-last
 * compact_boundary. The boundary message itself is included so the client sees
 * the "Context compacted" divider.
 *
 * @param messages - Normalized message array (active branch, in conversation order)
 * @param tailCompactions - Number of compact boundaries to include from the end
 * @param beforeMessageId - Optional cursor: only consider messages before this ID
 *                          (used for loading progressively older chunks)
 * @param maxMessages - Optional hard cap on the number of returned messages. When
 *                      the compact-boundary slice still exceeds this count (e.g.
 *                      a long session that was never compacted), only the last
 *                      `maxMessages` are returned. Older messages remain reachable
 *                      via the "load older" cursor.
 */
export function sliceAtCompactBoundaries(
  messages: Message[],
  tailCompactions: number,
  beforeMessageId?: string,
  maxMessages?: number,
): SliceResult {
  const totalMessageCount = messages.length;

  // For "load older" requests: work with messages before the cursor
  let workingMessages = messages;
  if (beforeMessageId) {
    const idx = messages.findIndex((m) => getMessageId(m) === beforeMessageId);
    if (idx > 0) {
      workingMessages = messages.slice(0, idx);
    }
    // If not found or idx === 0, use all messages (graceful fallback)
  }

  // Find all compact_boundary indices in the working set
  const compactIndices: number[] = [];
  for (let i = 0; i < workingMessages.length; i++) {
    const m = workingMessages[i];
    if (m && isCompactBoundary(m)) {
      compactIndices.push(i);
    }
  }

  const totalCompactions = compactIndices.length;

  // If fewer or equal compactions than requested, return everything
  if (compactIndices.length <= tailCompactions) {
    return capByCount(
      {
        messages: workingMessages,
        pagination: {
          hasOlderMessages: false,
          totalMessageCount,
          returnedMessageCount: workingMessages.length,
          truncatedBeforeMessageId: undefined,
          totalCompactions,
        },
      },
      maxMessages,
    );
  }

  // Slice starting from the Nth-from-last compact boundary (inclusive)
  const sliceFromIdx =
    compactIndices[compactIndices.length - tailCompactions] ?? 0;
  const slicedMessages = workingMessages.slice(sliceFromIdx);
  const firstId = slicedMessages[0]
    ? getMessageId(slicedMessages[0])
    : undefined;

  return capByCount(
    {
      messages: slicedMessages,
      pagination: {
        hasOlderMessages: true,
        totalMessageCount,
        returnedMessageCount: slicedMessages.length,
        truncatedBeforeMessageId: firstId,
        totalCompactions,
      },
    },
    maxMessages,
  );
}

/**
 * Return a bounded window centered around a target message. This is used for
 * deterministic deep-links into long sessions, where the frontend should not
 * have to page backward repeatedly until the target happens to appear.
 */
export function sliceAroundMessage(
  messages: Message[],
  targetMessageId: string,
  maxMessages: number,
): SliceResult {
  const totalMessageCount = messages.length;
  const targetIndex = messages.findIndex(
    (message) => getMessageId(message) === targetMessageId,
  );

  if (targetIndex === -1) {
    return {
      messages: [],
      pagination: {
        hasOlderMessages: false,
        hasNewerMessages: false,
        totalMessageCount,
        returnedMessageCount: 0,
        totalCompactions: countCompactBoundaries(messages),
        targetMessageId,
        targetMessageFound: false,
      },
    };
  }

  return sliceWindow(messages, targetIndex, maxMessages, {
    targetMessageId,
    targetMessageFound: true,
  });
}

/**
 * Return the next bounded window after a cursor. This complements
 * sliceAroundMessage when a user jumps into the middle of a session and then
 * wants to continue toward newer messages.
 */
export function sliceAfterMessage(
  messages: Message[],
  afterMessageId: string,
  maxMessages: number,
): SliceResult {
  const cursorIndex = messages.findIndex(
    (message) => getMessageId(message) === afterMessageId,
  );
  if (cursorIndex === -1 || cursorIndex >= messages.length - 1) {
    return {
      messages: [],
      pagination: {
        hasOlderMessages: cursorIndex > 0,
        hasNewerMessages: false,
        totalMessageCount: messages.length,
        returnedMessageCount: 0,
        totalCompactions: countCompactBoundaries(messages),
      },
    };
  }

  return sliceRange(messages, cursorIndex + 1, cursorIndex + 1 + maxMessages);
}

/**
 * Apply a hard message-count cap to an already-sliced result. Keeps only the
 * last `maxMessages` entries so a long, never-compacted session doesn't ship
 * (and re-render) thousands of messages on first load. The dropped prefix stays
 * reachable through the "load older" cursor.
 *
 * No-op when `maxMessages` is unset or the slice already fits — preserving the
 * original compact-boundary behavior for callers that don't pass a cap.
 */
function capByCount(result: SliceResult, maxMessages?: number): SliceResult {
  if (maxMessages === undefined || result.messages.length <= maxMessages) {
    return result;
  }

  const capped = result.messages.slice(-maxMessages);
  return {
    messages: capped,
    pagination: {
      ...result.pagination,
      hasOlderMessages: true,
      returnedMessageCount: capped.length,
      truncatedBeforeMessageId: capped[0]
        ? getMessageId(capped[0])
        : result.pagination.truncatedBeforeMessageId,
    },
  };
}

function sliceWindow(
  messages: Message[],
  targetIndex: number,
  maxMessages: number,
  extraPagination: Partial<PaginationInfo> = {},
): SliceResult {
  const safeMaxMessages = Math.max(1, maxMessages);
  const beforeCount = Math.floor((safeMaxMessages - 1) / 2);
  const afterCount = safeMaxMessages - beforeCount - 1;

  let startIndex = Math.max(0, targetIndex - beforeCount);
  let endIndex = Math.min(messages.length, targetIndex + afterCount + 1);

  if (endIndex - startIndex < safeMaxMessages && startIndex > 0) {
    startIndex = Math.max(0, endIndex - safeMaxMessages);
  }
  if (endIndex - startIndex < safeMaxMessages && endIndex < messages.length) {
    endIndex = Math.min(messages.length, startIndex + safeMaxMessages);
  }

  return sliceRange(messages, startIndex, endIndex, extraPagination);
}

function sliceRange(
  messages: Message[],
  rawStartIndex: number,
  rawEndIndex: number,
  extraPagination: Partial<PaginationInfo> = {},
): SliceResult {
  const startIndex = Math.max(0, Math.min(messages.length, rawStartIndex));
  const endIndex = Math.max(startIndex, Math.min(messages.length, rawEndIndex));
  const sliced = messages.slice(startIndex, endIndex);
  const firstMessage = sliced[0];
  const lastMessage = sliced[sliced.length - 1];
  const firstId = firstMessage ? getMessageId(firstMessage) : undefined;
  const lastId = lastMessage ? getMessageId(lastMessage) : undefined;

  return {
    messages: sliced,
    pagination: {
      hasOlderMessages: startIndex > 0,
      ...(endIndex < messages.length ? { hasNewerMessages: true } : {}),
      totalMessageCount: messages.length,
      returnedMessageCount: sliced.length,
      ...(startIndex > 0 && firstId
        ? { truncatedBeforeMessageId: firstId }
        : {}),
      ...(endIndex < messages.length && lastId
        ? { truncatedAfterMessageId: lastId }
        : {}),
      totalCompactions: countCompactBoundaries(messages),
      ...extraPagination,
    },
  };
}

function countCompactBoundaries(messages: Message[]): number {
  return messages.reduce(
    (count, message) => count + (isCompactBoundary(message) ? 1 : 0),
    0,
  );
}

import type { CodexSessionEntry } from "@yep-anywhere/shared";

/**
 * Codex persists inherited model context before a child's projected history.
 * The canonical first metadata record owns this boundary; later metadata may
 * have been copied from its parent. See protocol.rs SessionMeta and
 * thread-store/src/local/thread_history_materialization.rs.
 */
export function getCodexSubagentHistoryStart(
  metadata: CodexSessionEntry,
  threadId: string,
): number | null {
  if (metadata.type !== "session_meta" || metadata.payload.id !== threadId) {
    throw new Error(
      "Codex subagent history metadata does not match its thread",
    );
  }
  const boundary = metadata.payload.subagent_history_start_ordinal;
  if (boundary === undefined || boundary === null) return null;
  if (
    typeof boundary !== "number" ||
    !Number.isSafeInteger(boundary) ||
    boundary < 0
  ) {
    throw new Error("Invalid Codex subagent history start ordinal");
  }
  return boundary;
}

/** Missing ordinals in paginated history are invalid, never a reason to show the parent. */
export function isCodexOwnHistoryEntry(
  entry: CodexSessionEntry,
  startOrdinal: number | null,
): boolean {
  // Legacy/non-forked children do not provide a projection boundary.
  if (startOrdinal === null) return true;
  const ordinal = entry.ordinal;
  if (
    typeof ordinal !== "number" ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  ) {
    throw new Error("Codex subagent history record is missing a valid ordinal");
  }
  return ordinal >= startOrdinal;
}

export function partitionCodexSubagentHistory(
  entries: readonly CodexSessionEntry[],
  threadId: string,
): {
  own: readonly CodexSessionEntry[];
  inherited: readonly CodexSessionEntry[];
} {
  const metadata = entries[0];
  if (!metadata || metadata.type !== "session_meta") {
    throw new Error("Codex subagent history metadata is missing");
  }
  const boundary = getCodexSubagentHistoryStart(metadata, threadId);
  if (boundary === null) return { own: entries, inherited: [] };
  // Keep the child's own identity/instructions while excluding the inherited
  // prefix from messages, latest-result selection and lifecycle inference.
  // Preserve original entries and their byte-offset anchors for stable ids.
  const own: CodexSessionEntry[] = [];
  const inherited: CodexSessionEntry[] = [];
  for (const entry of entries) {
    const belongsToChild = isCodexOwnHistoryEntry(entry, boundary);
    if (belongsToChild || entry === metadata) own.push(entry);
    else if ((entry.ordinal ?? 0) >= 1) inherited.push(entry);
  }
  return { own, inherited };
}

export function selectCodexSubagentOwnHistory(
  entries: readonly CodexSessionEntry[],
  threadId: string,
): readonly CodexSessionEntry[] {
  return partitionCodexSubagentHistory(entries, threadId).own;
}

/**
 * Whether a rollout can be served from a tail read.
 *
 * `thread_rolled_back` markers remove the *preceding* N user turns from the
 * effective history (see `codex-rs/core/src/thread_rollout_truncation.rs`). A
 * tail read starts partway through the file, so the turns a marker is supposed
 * to drop may sit before the window: the marker then silently does nothing and
 * the window keeps turns a full read would have discarded. That is a semantic
 * difference, not just an id difference, so rollouts containing rollback markers
 * must be read in full.
 */

import type { CodexSessionEntry } from "@yep-anywhere/shared";

/** True when the entry is a `thread_rolled_back` marker. */
export function isCodexRollbackMarker(entry: CodexSessionEntry): boolean {
  return (
    entry.type === "event_msg" &&
    (entry.payload as { type?: unknown }).type === "thread_rolled_back"
  );
}

/**
 * True when a window for this rollout may be built from a tail read.
 *
 * Callers that cannot see the whole file (an index-driven tail read) must treat
 * `false` as "fall back to a full read".
 */
export function codexRolloutSupportsTailRead(
  entries: readonly CodexSessionEntry[],
): boolean {
  return !entries.some(isCodexRollbackMarker);
}

/**
 * Stable, position-independent anchors for Codex rollout entries.
 *
 * Codex message ids used to be derived from a running counter over whatever
 * entry array was handed to `convertCodexEntries`. That made identity a function
 * of *how much of the file was read*: parsing only the tail of a rollout
 * produced `codex-225-...` for the message that a full read called
 * `codex-15760-...`. It also meant switching branches shifted the ids of
 * messages in the shared prefix, because the branch view changes which entries
 * are visible.
 *
 * The anchor fixes identity to the entry's absolute byte offset in the rollout
 * file, which is:
 *
 *   - unique — measured over a 32k-entry production rollout, byte offsets had
 *     zero collisions while `timestamp` alone had 294 colliding groups and
 *     `timestamp|type|payloadType` still had 4;
 *   - stable under append — Codex only ever appends to rollouts
 *     (`codex-rs/rollout/src/recorder.rs` opens with `append(true)`), and the
 *     newline fixup it performs also appends at EOF;
 *   - stable across compression — zstd is lossless, so a compress/decompress
 *     round trip reproduces the file byte for byte;
 *   - derivable from a partial read — a tail read knows its own base offset.
 *
 * The offset is attached once, at read time, to the parsed entry object. It is
 * deliberately not part of the shared Codex wire schemas: it describes where a
 * record sits in one file, not the record's own format.
 */

import type { CodexSessionEntry } from "@yep-anywhere/shared";

/** Property name kept distinct from every Codex wire field. */
const BYTE_OFFSET_KEY = "__yepByteOffset";

interface WithByteOffset {
  [BYTE_OFFSET_KEY]?: number;
}

/**
 * Record an entry's absolute byte offset in its rollout file.
 *
 * Called once per entry by the rollout reader, before the entry is shared with
 * any consumer. Entries flow by reference through `buildCodexBranchView` and
 * into normalization, so the offset survives branch selection and windowing.
 */
export function attachCodexEntryByteOffset(
  entry: CodexSessionEntry,
  byteOffset: number,
): void {
  Object.defineProperty(entry, BYTE_OFFSET_KEY, {
    value: byteOffset,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/**
 * The entry's absolute byte offset, or undefined when it was not read from a
 * rollout file (hand-built entries in tests, for example).
 */
export function getCodexEntryByteOffset(
  entry: CodexSessionEntry,
): number | undefined {
  const value = (entry as WithByteOffset)[BYTE_OFFSET_KEY];
  return typeof value === "number" ? value : undefined;
}

/**
 * The identity fragment used to build an id for this entry.
 *
 * Offset-anchored entries produce `@<offset>`, which cannot collide with any
 * positional fallback because the fallback never starts with `@`.
 *
 * The fallback is supplied by the caller rather than computed here because the
 * historical id shapes differ per call site — message uuids were
 * `<index>-<timestamp>` while branch ids were just `<index>`. Passing it in
 * keeps every non-file code path (hand-built entries in tests, synthetic
 * fixtures) producing byte-identical ids to before.
 */
export function codexEntryAnchor(
  entry: CodexSessionEntry,
  positionalFallback: string,
): string {
  const offset = getCodexEntryByteOffset(entry);
  return offset === undefined ? positionalFallback : `@${offset}`;
}

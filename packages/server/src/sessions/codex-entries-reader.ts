/**
 * Single-flight reader for Codex rollout files.
 *
 * Opening one session fans out into several independent endpoints — session
 * content, `/metadata`, `/agents`, plus provider resolution — and each one used
 * to read and JSON-parse the whole rollout file on its own. On a large session
 * that meant paying the full read+parse cost once per request, with the
 * concurrent copies competing for memory and GC: three requests against a
 * 188 MB rollout took ~7 s wall clock instead of the ~2.3 s a single read costs.
 *
 * This coalesces reads that overlap in time so a burst shares one read+parse.
 *
 * Nothing is retained after a read settles — the map only ever holds in-flight
 * promises. Two consequences worth keeping in mind:
 *
 *   - Peak memory is one parsed copy of the file instead of N, so this lowers
 *     memory pressure as well as latency.
 *   - There is no cache to invalidate. A caller can observe data at most one
 *     read older than its own request, which was already true when every
 *     caller read the file at a slightly different instant. Live sessions get
 *     their tail from the WebSocket stream, not from these reads.
 *
 * Callers MUST treat the result as read-only. The entries array and the entry
 * objects inside it are shared with every other caller in the same burst.
 * `buildCodexBranchView` and `convertCodexEntries` both build fresh output
 * arrays and never write back into their input, which is what makes the
 * sharing safe; keep it that way.
 */

import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

import {
  type CodexSessionEntry,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";

import { stripBom } from "../utils/jsonl.js";
import { attachCodexEntryByteOffset } from "./codex-entry-anchor.js";
import { readCodexRolloutText } from "./codex-rollout-file.js";

/** Parsed rollout file plus the stats captured during the same read. */
export interface LoadedCodexEntries {
  /** Read-only: shared with every caller coalesced into the same read. */
  readonly entries: readonly CodexSessionEntry[];
  readonly stats: Stats;
}

const inFlight = new Map<string, Promise<LoadedCodexEntries>>();

async function loadCodexEntries(filePath: string): Promise<LoadedCodexEntries> {
  // stat() is issued alongside the read so every consumer of one shared read
  // sees mtime/size consistent with the entries it was given.
  const [rawText, stats] = await Promise.all([
    readCodexRolloutText(filePath),
    stat(filePath),
  ]);

  // Offsets are measured on the BOM-stripped stream and are deliberately not
  // trimmed: any partial reader must use the same convention so that
  // `baseOffset + localOffset` names the same entry a full read names. Codex
  // writes rollouts from Rust without a BOM, so in practice the two coincide.
  const text = stripBom(rawText);
  const lines = text.split("\n");

  const entries: CodexSessionEntry[] = [];
  let byteOffset = 0;
  for (const line of lines) {
    if (line) {
      const parsed = parseCodexSessionEntry(line);
      if (parsed) {
        attachCodexEntryByteOffset(parsed, byteOffset);
        entries.push(parsed);
      }
    }
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
  }
  return { entries, stats };
}

/**
 * Read and parse a Codex rollout file, sharing the work with any read of the
 * same path that is already in flight.
 */
export function readSharedCodexEntries(
  filePath: string,
): Promise<LoadedCodexEntries> {
  const existing = inFlight.get(filePath);
  if (existing) return existing;

  const tracked = loadCodexEntries(filePath).finally(() => {
    // Only clear our own entry: a later read may already have replaced it.
    if (inFlight.get(filePath) === tracked) inFlight.delete(filePath);
  });
  inFlight.set(filePath, tracked);
  return tracked;
}

/** Number of reads currently in flight. Exposed for tests and diagnostics. */
export function getInFlightCodexReadCount(): number {
  return inFlight.size;
}

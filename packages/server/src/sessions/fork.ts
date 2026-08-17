/**
 * Session cloning and forking utilities.
 *
 * Supports cloning sessions across providers:
 * - Claude: JSONL with DAG structure (uuid/parentUuid)
 * - Codex: JSONL linear format
 * - Gemini: JSON linear format (TODO)
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  plainCodexRolloutPath,
  readCodexRolloutText,
} from "./codex-rollout-file.js";

/**
 * Result of cloning a session.
 */
export interface CloneResult {
  /** The new session ID */
  newSessionId: string;
  /** Number of JSONL entries copied */
  entries: number;
}

/**
 * Clone a Claude session by copying the JSONL file with a new session_id.
 *
 * The clone copies the entire conversation history, preserving:
 * - All messages (user, assistant, system)
 * - DAG structure (uuid/parentUuid relationships)
 * - Tool use history
 *
 * The only change is the session_id field (when present) is updated to the new ID.
 *
 * @param sessionDir - Directory containing session JSONL files
 * @param sourceSessionId - The session ID to clone
 * @param newSessionId - Optional new session ID (generated if not provided)
 * @returns Clone result with new session ID and entry count
 */
export async function cloneClaudeSession(
  sessionDir: string,
  sourceSessionId: string,
  newSessionId?: string,
): Promise<CloneResult> {
  const sourcePath = join(sessionDir, `${sourceSessionId}.jsonl`);
  const content = await readFile(sourcePath, "utf-8");
  const trimmed = content.trim();

  if (!trimmed) {
    throw new Error("Source session is empty");
  }

  const lines = trimmed.split("\n");
  const targetId = newSessionId ?? randomUUID();

  // Transform each line: update session_id if present
  const transformedLines = lines.map((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      // Update session_id if present (some entries have it, some don't)
      if ("session_id" in entry) {
        entry.session_id = targetId;
      }

      return JSON.stringify(entry);
    } catch {
      // Keep malformed lines as-is (shouldn't happen, but be safe)
      return line;
    }
  });

  const targetPath = join(sessionDir, `${targetId}.jsonl`);
  await writeFile(targetPath, `${transformedLines.join("\n")}\n`, "utf-8");

  return {
    newSessionId: targetId,
    entries: lines.length,
  };
}

/**
 * Clone a Codex session by copying the JSONL file with a new session ID.
 *
 * Codex sessions are linear (no DAG). Only the first line (session_meta)
 * contains the session ID in `payload.id`; all other lines are copied as-is.
 *
 * This is the only place Yep writes a rollout file, which makes it the only
 * place where mis-decoding a rollout produces a *new corrupt artifact* rather
 * than a failed read. Two rules follow, and both matter more than the zstd
 * support that prompted them:
 *
 *   1. Decoding goes through `readCodexRolloutText`, the single chokepoint that
 *      knows how rollout bytes are stored. `readFile(path, "utf-8")` used to be
 *      inlined here; it does not fail on compressed bytes, it silently yields
 *      mojibake.
 *   2. The decoded text is validated before anything is written, so an encoding
 *      this build does not understand degrades to a clean error instead of a
 *      garbage `rollout-*.jsonl` that then pollutes the manifest forever.
 *
 * @param sourceFilePath - Full path to the source rollout (`.jsonl` or `.jsonl.zst`)
 * @param newSessionId - Optional new session ID (generated if not provided)
 * @returns Clone result with new session ID and entry count
 */
export async function cloneCodexSession(
  sourceFilePath: string,
  newSessionId?: string,
): Promise<CloneResult> {
  const content = await readCodexRolloutText(sourceFilePath);
  const trimmed = content.trim();

  if (!trimmed) {
    throw new Error("Source session is empty");
  }

  const lines = trimmed.split("\n");
  assertDecodedRolloutLine(lines[0], sourceFilePath);
  const targetId = newSessionId ?? randomUUID();

  // Update session_meta (first line) with new session ID
  const transformedLines = lines.map((line, index) => {
    if (index !== 0) return line;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        entry.type === "session_meta" &&
        typeof entry.payload === "object" &&
        entry.payload !== null
      ) {
        (entry.payload as Record<string, unknown>).id = targetId;
      }
      return JSON.stringify(entry);
    } catch {
      return line;
    }
  });

  // Write clone next to the source file (same date directory) using
  // Codex's standard rollout-* naming for consistency with native files. The
  // clone is always plain, whatever the source was: Yep never compresses.
  const targetPath = join(
    dirname(plainCodexRolloutPath(sourceFilePath)),
    `rollout-${targetId}.jsonl`,
  );
  await writeFile(targetPath, `${transformedLines.join("\n")}\n`, "utf-8");

  return {
    newSessionId: targetId,
    entries: lines.length,
  };
}

/**
 * Refuse to clone from bytes that were not decoded into JSONL.
 *
 * Checking the first line is enough and is the cheapest possible guard: every
 * rollout starts with `session_meta`, and the manifest already refuses to list a
 * file whose first line does not parse. Undecoded binary — a storage format this
 * build does not know, a truncated frame, a file that is not a rollout at all —
 * fails here, before a single byte is written.
 */
function assertDecodedRolloutLine(
  line: string | undefined,
  sourceFilePath: string,
): void {
  if (line) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return;
      }
    } catch {
      // Fall through to the shared error below.
    }
  }
  throw new Error(
    `Source session is not decodable JSONL: ${sourceFilePath}. Refusing to write a clone from content that could not be decoded.`,
  );
}

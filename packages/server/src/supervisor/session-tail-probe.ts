import { open } from "node:fs/promises";
import { parseCodexSessionEntry } from "@yep-anywhere/shared";
import { readAgyTranscriptTail } from "../sessions/agy-store.js";
import { nextCodexLastTurnStatus } from "../sessions/codex-reader.js";
import { readDshLogActivity } from "../sessions/dsh-store.js";
import { readPiSessionTailActivity } from "../sessions/pi-files.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";

/**
 * Whether the newest turn in a session's own log is still open.
 *
 * - `in-flight`: the log ends mid-turn, so something may be driving it.
 * - `settled`: the log ends on a turn that handed control back.
 * - `unknown`: no tail probe for this provider, or the tail was unreadable.
 *
 * The external session tracker treats `settled` as authoritative (an idle
 * CLI sitting in the same cwd does not make this session active) and
 * `in-flight` as live evidence the process probe cannot contradict (a
 * provider hosted in-process by an app has no CLI process to find).
 */
export type SessionTailActivity = "in-flight" | "settled" | "unknown";

export interface SessionTailProbeResult {
  turn: SessionTailActivity;
  /** The open turn waits on an approval or a question. */
  waitingInput?: boolean;
}

type SessionTailProbe = (filePath: string) => Promise<SessionTailProbeResult>;

const CODEX_TAIL_READ_BYTES = 256 * 1024;
const CODEX_TAIL_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Fold the end of a Codex rollout through the turn-status rule. The window
 * widens until it holds a turn marker; a compressed rollout reads as unknown.
 */
async function readCodexRolloutTailActivity(
  filePath: string,
): Promise<SessionTailProbeResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    if (size === 0) return { turn: "unknown" };
    for (let window = CODEX_TAIL_READ_BYTES; ; window *= 4) {
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      let text = buffer.toString("utf8");
      // A window that starts mid-line drops its torn first line.
      if (length < size) text = text.slice(text.indexOf("\n") + 1);
      let status: ReturnType<typeof nextCodexLastTurnStatus>;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const entry = parseCodexSessionEntry(line);
        if (entry) status = nextCodexLastTurnStatus(status, entry);
      }
      if (status)
        return { turn: status === "incomplete" ? "in-flight" : "settled" };
      if (length >= size || window >= CODEX_TAIL_MAX_BYTES)
        return { turn: "unknown" };
    }
  } catch {
    return { turn: "unknown" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Per-harness readers of a session log's tail. Providers without one (Claude,
 * Gemini, Cursor) rely on the process probe alone: Cursor writes a
 * finished-looking answer while the model is still working, so its store
 * cannot settle a turn.
 */
const TAIL_PROBES: Partial<
  Record<FileChangeEvent["provider"], SessionTailProbe>
> = {
  pi: async (filePath) => ({
    turn: await readPiSessionTailActivity(filePath),
  }),
  mcode: async (filePath) => ({
    turn: await readPiSessionTailActivity(filePath, { rowFormat: "mcode" }),
  }),
  dsh: async (filePath) => {
    const activity = await readDshLogActivity(filePath);
    return { turn: activity.turn, waitingInput: activity.waitingInput };
  },
  agy: async (filePath) => {
    const tail = await readAgyTranscriptTail(filePath);
    if (!tail) return { turn: "unknown" };
    return { turn: tail.yielded ? "settled" : "in-flight" };
  },
  codex: readCodexRolloutTailActivity,
};

export function hasSessionTailProbe(
  provider: FileChangeEvent["provider"],
): boolean {
  return TAIL_PROBES[provider] !== undefined;
}

export async function probeSessionTailActivity(
  provider: FileChangeEvent["provider"],
  filePath: string | undefined,
): Promise<SessionTailProbeResult> {
  const probe = filePath ? TAIL_PROBES[provider] : undefined;
  if (!probe || !filePath) return { turn: "unknown" };
  try {
    return await probe(filePath);
  } catch {
    return { turn: "unknown" };
  }
}

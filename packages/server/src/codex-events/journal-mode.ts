import { CODEX_EVENT_DELTA_METHODS } from "./journal-retention.js";

export const CODEX_EVENT_JOURNAL_MODES = [
  "minimal",
  "lifecycle",
  "full",
] as const;

export type CodexEventJournalMode = (typeof CODEX_EVENT_JOURNAL_MODES)[number];

/**
 * Methods the always-on consumer needs.
 *
 * `routes/sessions.ts` overlays provider errors and turn health on every Codex
 * session detail response, and it replays exactly these two methods. Everything
 * else in the journal exists for the opt-in `?view=canonical` and the explicit
 * transcript export.
 */
const CODEX_EVENT_MINIMAL_METHODS = new Set<string>([
  "error",
  "turn/completed",
]);

export function resolveCodexEventJournalMode(
  value: string | undefined,
): CodexEventJournalMode {
  const normalized = value?.trim().toLowerCase();
  return CODEX_EVENT_JOURNAL_MODES.includes(normalized as CodexEventJournalMode)
    ? (normalized as CodexEventJournalMode)
    : "lifecycle";
}

/**
 * Decide whether one event earns a durable journal record.
 *
 * This is a *storage* policy, not a transport or projection policy. A rejected
 * event is still redacted, still turned into an envelope, and still projected
 * into the live message stream exactly as before; it simply leaves no trace on
 * disk. That is the same split the 4510 bridge already makes, where deltas stay
 * on the wire but never enter its journal.
 *
 * Why deltas are droppable: they are incremental fragments whose settled form
 * is already carried by the `item/completed` event we keep, and by the native
 * rollout that remains the authority for full history. Measured on this install
 * they were 83% of journal bytes -- `item/agentMessage/delta`,
 * `item/commandExecution/outputDelta`, and a `turn/diff/updated` that re-writes
 * a whole diff at ~30 KB a time.
 */
export function shouldJournalCodexEvent(
  mode: CodexEventJournalMode,
  event: { method: string; direction: string },
): boolean {
  if (mode === "full") return true;
  if (mode === "minimal") {
    return (
      event.direction === "server_notification" &&
      CODEX_EVENT_MINIMAL_METHODS.has(event.method)
    );
  }
  // lifecycle: keep every correlation-bearing record, drop only high-frequency
  // deltas. Client/server request-response pairs are rare and carry the
  // correlation identities the reducer needs, so they are never dropped.
  if (event.direction !== "server_notification") return true;
  return !CODEX_EVENT_DELTA_METHODS.has(event.method);
}

/**
 * How a submitted prompt is confirmed on screen.
 *
 * Pi, MiniMax Code and Antigravity stream tool blocks only: `SessionDisplayService` drops
 * their prose from the live display transport and re-reads the session file for
 * it. Their optimistic user echo therefore never becomes visible, so treating
 * that echo as delivery proof removes the composer bubble while the prompt is
 * still waiting to be injected into the running turn.
 */
const PROSE_FROM_SESSION_FILE: ReadonlySet<string> = new Set([
  "pi",
  "mcode",
  "agy",
]);

export type PendingPromptStatusKey = "sessionInsertWaiting";

/**
 * Status line for an optimistic prompt that is waiting on the provider rather
 * than on the network. Providers above steer mid-turn input into the running
 * turn, so it lands only after the turn's tool calls finish.
 */
export function pendingPromptStatusKey(
  provider: string | undefined,
  owner: "self" | "external" | "none",
  processState: string,
): PendingPromptStatusKey | null {
  if (owner !== "self") return null;
  if (!provider || !PROSE_FROM_SESSION_FILE.has(provider)) return null;
  return processState === "idle" ? null : "sessionInsertWaiting";
}

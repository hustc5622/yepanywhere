/** Mirrors the server-side bound on compaction guidance. */
export const MAX_PI_COMPACT_INSTRUCTIONS_LENGTH = 4000;

export type PiSlashCommandResult =
  | { kind: "none" }
  | { kind: "compact"; customInstructions?: string }
  | { kind: "compact-instructions-too-long" };

/**
 * Pi's built-in `/compact` exists only in its interactive TUI; over RPC the
 * text would reach the model as an ordinary prompt. Yep intercepts it and
 * calls the native `compact` command, forwarding any trailing text as the
 * summary's custom instructions (same as `/compact <instructions>` in Pi).
 */
export function parsePiSlashCommand(text: string): PiSlashCommandResult {
  const match = /^\/compact(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return { kind: "none" };
  const customInstructions = match[1]?.trim();
  if (!customInstructions) return { kind: "compact" };
  if (customInstructions.length > MAX_PI_COMPACT_INSTRUCTIONS_LENGTH) {
    return { kind: "compact-instructions-too-long" };
  }
  return { kind: "compact", customInstructions };
}

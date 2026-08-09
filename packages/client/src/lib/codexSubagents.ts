import type { AppSessionSummary } from "@yep-anywhere/shared";

/**
 * Codex collaboration child threads are parent-owned in the pinned protocol.
 * Yep may safely open their persisted transcript, but must not present it as an
 * independently controllable session.
 */
export function isCodexSubagentViewOnly(
  session:
    | Pick<AppSessionSummary, "parentSessionId" | "provider">
    | null
    | undefined,
): boolean {
  return (
    (session?.provider === "codex" || session?.provider === "codex-oss") &&
    Boolean(session.parentSessionId)
  );
}

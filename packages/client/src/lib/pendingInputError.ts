/**
 * Detect a pending-input response (tool approval / question answer) that
 * failed because the request was already resolved or is no longer active.
 *
 * External bridge processes report this as HTTP 404, but owned SDK processes
 * (e.g. OpenCode running as a Yep-managed process) return HTTP 400 from
 * `POST /sessions/:id/input` (see packages/server/src/routes/sessions.ts):
 *   - "No pending input request"            (process no longer waiting)
 *   - "Invalid request ID or no pending request" (requestId no longer matches)
 *
 * Both cases mean the on-screen approval popup is stale and should be cleared
 * silently instead of surfacing an error toast that lingers until the user
 * manually refreshes the page. This is the root cause of the duplicate/stuck
 * OpenCode approval popup: after a successful first approve the popup could
 * transiently re-appear, and a second click hit a 400 that the client did not
 * treat as "already resolved".
 */
export function isStalePendingInputError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: number }).status;
  if (status === 404) return true;
  if (status === 409) {
    const code = (err as { code?: string }).code;
    return (
      code === "interaction_already_resolved" ||
      code === "interaction_stale_version"
    );
  }
  if (status === 400) {
    const message = (err as { message?: string }).message ?? "";
    return (
      message.includes("No pending input request") ||
      message.includes("Invalid request ID or no pending request")
    );
  }
  return false;
}

/** A preview identifies recorded bytes, never the mutable source filename. */
export function codexImagePreviewUrl(
  sessionId: string,
  itemId: string,
): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/codex-images/${encodeURIComponent(itemId)}`;
}

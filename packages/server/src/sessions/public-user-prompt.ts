/** Keep provider/user text verbatim in history, summaries and edit matching. */
export function sanitizeCodexUserContentBlockText(text: string): string {
  return text;
}

export function sanitizeCodexPublicUserPrompt(text: string): string {
  return text;
}

export function sanitizePublicUserPrompt(
  text: string,
  _options: { codex?: boolean } = {},
): string {
  return text;
}

export { MANAGED_ATTACHMENT_MARKER } from "../sdk/messageQueue.js";

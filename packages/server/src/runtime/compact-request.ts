/**
 * Validation for manual context-compaction requests, shared by the web/API
 * shell route and the external agent runtime control server.
 */

/** Upper bound for compaction guidance; it is forwarded into a model prompt. */
export const MAX_COMPACT_INSTRUCTIONS_LENGTH = 4000;

export function parseCompactRequestBody(
  body: unknown,
):
  | { ok: true; options: { customInstructions?: string } }
  | { ok: false; error: string } {
  if (body === null || body === undefined) return { ok: true, options: {} };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid compact request body" };
  }
  const raw = (body as { customInstructions?: unknown }).customInstructions;
  if (raw === undefined || raw === null) return { ok: true, options: {} };
  if (typeof raw !== "string") {
    return { ok: false, error: "customInstructions must be a string" };
  }
  const customInstructions = raw.trim();
  if (customInstructions.length > MAX_COMPACT_INSTRUCTIONS_LENGTH) {
    return {
      ok: false,
      error: `customInstructions must be at most ${MAX_COMPACT_INSTRUCTIONS_LENGTH} characters`,
    };
  }
  return {
    ok: true,
    options: customInstructions ? { customInstructions } : {},
  };
}

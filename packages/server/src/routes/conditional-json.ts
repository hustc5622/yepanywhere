/**
 * Conditional JSON responses (ETag + 304).
 *
 * Session detail is the single largest recurring API payload: a measured
 * transcript page is 176 KB identity / 64 KB gzip, and the client re-fetches it
 * on every SWR revalidation — reopening a session you already read, returning
 * from the background, switching branches back and forth. On a tunnelled
 * connection that re-transfer is the dominant cost of "why does switching back
 * to a session still spin".
 *
 * The client reaches these routes through the browser's own `fetch`, so we do
 * not need any client-side bookkeeping: emitting a validator plus a `no-cache`
 * (store-but-always-revalidate) directive is enough for the browser to send
 * `If-None-Match` by itself and to transparently resolve a 304 from its HTTP
 * cache. That keeps the whole optimisation on the server.
 */
import { createHash } from "node:crypto";
import type { Context } from "hono";

/**
 * Session payloads mix durable transcript content with live runtime fields
 * (`activity`, `hasUnread`, `lastSeenAt`, ...). Deriving the validator from a
 * file revision would therefore be wrong — it would serve a 304 while the live
 * state had moved on. Hashing the serialized representation is always correct,
 * and costs a single pass over bytes we had to serialize anyway.
 */
function etagForBody(body: string): string {
  const digest = createHash("sha1").update(body).digest("base64url");
  // Weak, deliberately: the response is content-coded on the way out by the
  // compression middleware, so byte-for-byte equality is not guaranteed across
  // representations, but semantic equivalence is. `If-None-Match` on GET uses
  // the weak comparison function anyway (RFC 9110 §13.1.2).
  return `W/"${digest}"`;
}

/**
 * Weak comparison of `If-None-Match` against our validator.
 */
export function matchesIfNoneMatch(
  ifNoneMatch: string | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  const target = normalize(etag);
  return ifNoneMatch
    .split(",")
    .some((candidate) => normalize(candidate) === target);
}

export interface ConditionalJsonOptions {
  /**
   * Cache-Control for the 200 response.
   *
   * Defaults to `private, no-cache`: the browser may store the body but must
   * revalidate before reuse, which is exactly the behaviour that turns a
   * revalidation into a 304 instead of a full transfer. `no-store` would defeat
   * this entirely, and any `max-age > 0` would risk showing stale transcripts.
   */
  cacheControl?: string;
}

/**
 * Serialize `payload` as JSON with an ETag, answering 304 when the client
 * already holds the same representation.
 *
 * Returns the same shape as `c.json()` so call sites can swap directly.
 */
export function conditionalJson(
  c: Context,
  payload: unknown,
  options?: ConditionalJsonOptions,
): Response {
  const body = JSON.stringify(payload);
  const etag = etagForBody(body);

  c.header("ETag", etag);
  c.header("Cache-Control", options?.cacheControl ?? "private, no-cache");

  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    // A 304 carries no body and must not describe one. Skipping the
    // serialization-heavy path here is also what saves the gzip work.
    return c.body(null, 304);
  }

  return c.body(body, 200, {
    "Content-Type": "application/json; charset=UTF-8",
  });
}

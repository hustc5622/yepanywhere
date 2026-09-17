/**
 * Compact, locale-independent elapsed-time label for running tool steps.
 *
 * Examples: `0s`, `45s`, `3m12s`, `1h04m`, `2d03h`. Negative or non-finite
 * input clamps to `0s` so a small client/server clock skew never renders a
 * nonsensical value.
 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600) % 24;
  const days = Math.floor(total / 86400);
  if (days > 0) return `${days}d${String(hours).padStart(2, "0")}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Upper bound after which a start timestamp is treated as unreliable. */
const MAX_ELAPSED_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Parses an ISO start timestamp into epoch milliseconds, returning `null` for
 * malformed input or values so far in the past they cannot be a live tool.
 */
export function parseStartedAt(
  timestamp: string | undefined,
  now = Date.now(),
): number | null {
  if (!timestamp) return null;
  const startedAt = Date.parse(timestamp);
  if (!Number.isFinite(startedAt)) return null;
  if (now - startedAt > MAX_ELAPSED_MS) return null;
  return startedAt;
}

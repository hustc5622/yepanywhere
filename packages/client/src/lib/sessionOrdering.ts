import type { GlobalSessionItem } from "../api/client";

type SessionOrderKey = Pick<
  GlobalSessionItem,
  "id" | "updatedAt" | "isStarred"
>;

type SessionAgeKey = Pick<GlobalSessionItem, "updatedAt" | "isStarred">;

function updatedAtMs(session: SessionOrderKey): number {
  const timestamp = new Date(session.updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/**
 * Keep pinned sessions above ordinary sessions while retaining recency order
 * inside both groups. `isStarred` is the legacy storage name for the pin bit.
 */
export function compareSessionsByPinAndUpdatedAt(
  a: SessionOrderKey,
  b: SessionOrderKey,
): number {
  if (Boolean(a.isStarred) !== Boolean(b.isStarred)) {
    return a.isStarred ? -1 : 1;
  }

  const aUpdatedAt = updatedAtMs(a);
  const bUpdatedAt = updatedAtMs(b);
  if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt - aUpdatedAt;

  return a.id.localeCompare(b.id);
}

/**
 * Keep pins visible regardless of the ordinary recency window. The server
 * deliberately backfills old pins into the response, so applying the age
 * cutoff to them again on the client would silently discard that coverage.
 */
export function isSessionVisibleInAgeWindow(
  session: SessionAgeKey,
  days: number,
  nowMs = Date.now(),
): boolean {
  if (session.isStarred) return true;

  const timestamp = new Date(session.updatedAt).getTime();
  if (!Number.isFinite(timestamp)) return true;

  return timestamp >= nowMs - days * 24 * 60 * 60 * 1000;
}

import type { GlobalSessionItem } from "../api/client";

type SessionOrderKey = Pick<
  GlobalSessionItem,
  "id" | "updatedAt" | "isStarred"
>;

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

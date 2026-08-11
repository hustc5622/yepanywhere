import { applyCodexEventMutable, createReductionIndexes } from "./reducer.js";
import type { CodexEventEnvelope } from "./types.js";
import {
  type CanonicalCodexSessionState,
  createCanonicalCodexSessionState,
} from "./types.js";

export interface CodexProjectionCacheEntry {
  sourceId: string;
  sessionId: string;
  state: CanonicalCodexSessionState;
  indexes: { appliedEventIds: Set<string>; appliedDedupeKeys: Set<string> };
  lastSequence: number;
  eventCount: number;
  lastAccessedMs: number;
}

export interface CodexProjectionCacheOptions {
  maxEntries?: number;
  /** Approximate memory waterline expressed as total accepted events. */
  maxTotalEvents?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_TOTAL_EVENTS = 100_000;

/**
 * Process-level LRU cache of canonical Codex projection state.
 *
 * Each entry is keyed by (sourceId, sessionId) and holds a mutable projection
 * plus its dedupe Sets. On a cache hit, only events with sequence >
 * lastSequence are replayed into the existing state, so a warm session refresh
 * avoids the full cold replay.
 *
 * Cache invalidation is explicit: callers must discard an entry when a
 * journal is truncated, rotated, or has a schema/version mismatch. The cache
 * never inspects file stats itself; that boundary belongs to the store layer.
 */
export class CodexProjectionCache {
  private readonly entries = new Map<string, CodexProjectionCacheEntry>();
  private readonly maxEntries: number;
  private readonly maxTotalEvents: number;
  private readonly now: () => number;

  constructor(options: CodexProjectionCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxTotalEvents = options.maxTotalEvents ?? DEFAULT_MAX_TOTAL_EVENTS;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError(
        "Codex projection cache maxEntries must be positive",
      );
    }
    if (!Number.isSafeInteger(this.maxTotalEvents) || this.maxTotalEvents < 1) {
      throw new RangeError(
        "Codex projection cache maxTotalEvents must be positive",
      );
    }
    this.now = options.now ?? Date.now;
  }

  private key(sourceId: string, sessionId: string): string {
    return `${sourceId}\0${sessionId}`;
  }

  /**
   * Apply a batch of events into the cached projection for (sourceId,
   * sessionId). On a cold miss, a fresh state is created. On a warm hit, only
   * events with sequence > lastSequence are replayed.
   *
   * The caller must ensure the events array belongs to exactly one journal
   * sequence space (provider or bridge, never mixed) and is already sorted
   * by sequence. Events are applied in place; the returned state reference is
   * the internal mutable state and must not be mutated by the caller.
   */
  apply(
    sourceId: string,
    sessionId: string,
    events: readonly CodexEventEnvelope[],
  ): CanonicalCodexSessionState {
    const cacheKey = this.key(sourceId, sessionId);
    let entry = this.entries.get(cacheKey);
    if (!entry) {
      const state = createCanonicalCodexSessionState(sessionId);
      entry = {
        sourceId,
        sessionId,
        state,
        indexes: createReductionIndexes(state),
        lastSequence: 0,
        eventCount: 0,
        lastAccessedMs: this.now(),
      };
      this.entries.set(cacheKey, entry);
      this.evictIfNeeded();
    }

    // Fast path: no new events.
    if (events.length === 0) {
      entry.lastAccessedMs = this.now();
      this.touch(cacheKey);
      return entry.state;
    }

    // Only apply events strictly newer than what the cache has seen.
    const startIndex = this.findStartIndex(events, entry.lastSequence);
    for (let i = startIndex; i < events.length; i += 1) {
      const event = events[i];
      if (!event) continue;
      applyCodexEventMutable(entry.state, event, entry.indexes);
    }

    const lastEvent = events[events.length - 1];
    if (lastEvent && lastEvent.sequence > entry.lastSequence) {
      entry.lastSequence = lastEvent.sequence;
    }
    entry.eventCount = entry.state.appliedEventIds.length;
    entry.lastAccessedMs = this.now();
    this.touch(cacheKey);
    this.evictIfNeeded();
    return entry.state;
  }

  private findStartIndex(
    events: readonly CodexEventEnvelope[],
    lastSequence: number,
  ): number {
    // Events are assumed pre-sorted by sequence. Find the first event with
    // sequence > lastSequence so we skip already-applied tail.
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midSeq = events[mid]?.sequence ?? 0;
      if (midSeq <= lastSequence) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Discard a single entry when the caller detects journal rotation/truncation. */
  invalidate(sourceId: string, sessionId: string): void {
    this.entries.delete(this.key(sourceId, sessionId));
  }

  /** Discard all entries for a session (e.g. on schema version change). */
  invalidateSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(key);
      }
    }
  }

  /** Clear all cached projections. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Read the cached last applied sequence without creating an entry. */
  getLastSequence(sourceId: string, sessionId: string): number {
    return this.entries.get(this.key(sourceId, sessionId))?.lastSequence ?? 0;
  }

  /**
   * Verify that a complete replay still contains the exact prefix represented
   * by the cached projection. This catches journal replacement/truncation even
   * when the replacement happens to have an equal or larger final sequence.
   */
  matchesReplaySnapshot(
    sourceId: string,
    sessionId: string,
    events: readonly CodexEventEnvelope[],
  ): boolean {
    const entry = this.entries.get(this.key(sourceId, sessionId));
    if (!entry) return true;

    let appliedIndex = 0;
    let highestComparedSequence = 0;
    const replayEventIds = new Set<string>();
    const replayDedupeKeys = new Set<string>();
    for (const event of events) {
      if (event.sequence > entry.lastSequence) continue;
      highestComparedSequence = Math.max(
        highestComparedSequence,
        event.sequence,
      );
      if (
        replayEventIds.has(event.eventId) ||
        (event.dedupeKey !== undefined && replayDedupeKeys.has(event.dedupeKey))
      ) {
        continue;
      }
      if (entry.state.appliedEventIds[appliedIndex] !== event.eventId) {
        return false;
      }
      replayEventIds.add(event.eventId);
      if (event.dedupeKey !== undefined) {
        replayDedupeKeys.add(event.dedupeKey);
      }
      appliedIndex += 1;
    }
    return (
      appliedIndex === entry.state.appliedEventIds.length &&
      highestComparedSequence === entry.lastSequence
    );
  }

  private touch(key: string): void {
    // Map preserves insertion order; re-insert to mark most-recently-used.
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
  }

  private evictIfNeeded(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalEventCount() > this.maxTotalEvents
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  private totalEventCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.eventCount;
    return total;
  }
}

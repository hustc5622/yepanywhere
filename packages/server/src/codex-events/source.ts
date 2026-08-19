import type { CodexProjectionCache } from "./projection-cache.js";
import type { CodexEventStore } from "./store.js";
import type { CodexEventEnvelope } from "./types.js";

const MAX_STORE_SOURCES = 8;
const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CODEX_EVENT_STORE_ADMISSION_BYTES = (() => {
  const configured = Number.parseInt(
    process.env.YEP_CODEX_EVENT_STORE_ADMISSION_BYTES ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 512 * 1024 * 1024;
})();

export class CodexEventSourceAdmissionError extends Error {
  readonly code = "CODEX_EVENT_SOURCE_ADMISSION_EXCEEDED";
  readonly fallback = "rollout" as const;

  constructor(
    readonly maxBytes: number,
    readonly rejectedSourceIds: readonly string[],
  ) {
    super("Canonical Codex event source exceeds the safe read budget");
    this.name = "CodexEventSourceAdmissionError";
  }
}

/**
 * One independently sequenced canonical Codex journal.
 *
 * A factory is intentional: provider and bridge writers own their file-store
 * instances, while readers must observe appends made after the server started.
 */
export interface CodexEventStoreSource {
  id: string;
  createStore: () => CodexEventStore;
  /** Old 4510 canonical capture; explicit compatibility reads only. */
  legacyBridgeFull?: boolean;
}

export interface CodexEventSourceCoverage {
  scope: "retained-journal";
  completePrefix: boolean;
  firstAvailableSequence: number;
  lastSequence: number;
  leadingGap: number;
  /** Native rollout remains the authority outside this retained event view. */
  fallback: "rollout";
}

export interface SelectedCodexEventSource {
  sourceId: string;
  sourceKind: "provider" | "legacy-bridge-full" | "custom";
  coverage: CodexEventSourceCoverage;
  /** Read-only: shared references into the store's indexes, never copies. */
  events: readonly CodexEventEnvelope[];
}

/** Validate source ids once at route construction or an injectable boundary. */
export function normalizeCodexEventStoreSources(
  sources: readonly CodexEventStoreSource[],
): CodexEventStoreSource[] {
  if (sources.length > MAX_STORE_SOURCES) {
    throw new RangeError(
      `Codex event-store sources must not exceed ${MAX_STORE_SOURCES}`,
    );
  }

  const seen = new Set<string>();
  return sources.map((source) => {
    if (!SAFE_SOURCE_ID.test(source.id) || seen.has(source.id)) {
      throw new Error(
        "Codex event-store source ids must be unique safe tokens",
      );
    }
    seen.add(source.id);
    return source;
  });
}

/**
 * Pick the journal that holds the freshest view of a session.
 *
 * Precedence used to be positional: the first source that held *any* event for
 * the session won. That silently preferred a stale journal. Measured on a live
 * install, one session existed in both journals:
 *
 *   provider  142,555 events, newest 2026-08-16T05:09:30Z
 *   bridge    118,753 events, newest 2026-08-16T18:18:37Z
 *
 * and provider came first, so every canonical projection of that session was
 * 13.2 hours behind what had actually been recorded, with nothing to indicate it.
 *
 * Journals are still never merged: their sequence spaces are independent, so one
 * of them is chosen whole. Freshest wins because the overlay's job is to enrich
 * the rows the client is looking at, which are the recent ones, and because the
 * legacy rollout - not this journal - is the source of full history. Ties keep
 * the original positional precedence, so a single-journal install and any
 * equal-freshness case behave exactly as before.
 *
 * Cost: every source is probed, where previously the search stopped at the first
 * hit. The probe is O(1) per source once a store is loaded, but it does force a
 * cold load of journals that positional precedence might have skipped. That is
 * accepted: a mixed workload loads them all anyway, since any session absent
 * from the first journal already required loading the next one.
 */
async function selectFreshestSourceStore(
  sources: readonly CodexEventStoreSource[],
  sessionId: string,
): Promise<{ source: CodexEventStoreSource; store: CodexEventStore } | null> {
  const rejectedSourceIds: string[] = [];
  let best: {
    source: CodexEventStoreSource;
    store: CodexEventStore;
    freshnessMs: number;
  } | null = null;
  for (const source of sources) {
    const store = source.createStore();
    const storageBytes = await store.getStorageBytes?.();
    if (
      storageBytes !== undefined &&
      storageBytes > CODEX_EVENT_STORE_ADMISSION_BYTES
    ) {
      // A cold JSONL hydration retains several indexes and can exceed the
      // rollout budget by hundreds of MiB. The rollout remains the canonical
      // history source, so fail closed to the legacy view instead of loading a
      // journal that cannot fit the process admission budget.
      rejectedSourceIds.push(source.id);
      continue;
    }
    const freshnessMs = await store.latestEventAtMs(sessionId);
    if (freshnessMs <= 0 && (await store.latestSequence(sessionId)) < 1) {
      // No events for this session in this journal at all.
      continue;
    }
    // Strictly greater, so equal freshness keeps the earlier source.
    if (!best || freshnessMs > best.freshnessMs) {
      best = { source, store, freshnessMs };
    }
  }
  if (!best && rejectedSourceIds.length > 0) {
    throw new CodexEventSourceAdmissionError(
      CODEX_EVENT_STORE_ADMISSION_BYTES,
      rejectedSourceIds,
    );
  }
  return best ? { source: best.source, store: best.store } : null;
}

/**
 * Select the journal holding the freshest view of the session.
 *
 * Provider and bridge journals have independent sequence spaces. They must
 * never be concatenated or sorted together; callers share this selector so a
 * transcript export and a normal session refresh use identical precedence.
 */
export async function selectCodexEventSource(
  sources: readonly CodexEventStoreSource[],
  sessionId: string,
): Promise<SelectedCodexEventSource | null> {
  const selected = await selectFreshestSourceStore(sources, sessionId);
  if (!selected) return null;
  const events = await selected.store.replay({ sessionId });
  if (events.length === 0) return null;
  return selectedSource(selected.source, events);
}

/**
 * Select the freshest journal while materializing only events needed to
 * reconstruct user-visible provider failures.
 */
export async function selectCodexProviderErrorEventSource(
  sources: readonly CodexEventStoreSource[],
  sessionId: string,
): Promise<SelectedCodexEventSource | null> {
  const selected = await selectFreshestSourceStore(
    sources.filter((source) => !source.legacyBridgeFull),
    sessionId,
  );
  if (!selected) return null;
  const events = await selected.store.replay({
    sessionId,
    methods: ["error", "turn/completed"],
  });
  return selectedSource(selected.source, events);
}

export interface SelectedCodexEventSourceWithCache {
  sourceId: string;
  sourceKind: "provider" | "legacy-bridge-full" | "custom";
  coverage: CodexEventSourceCoverage;
  /** Read-only: shared references into the store's indexes, never copies. */
  events: readonly CodexEventEnvelope[];
  /** True when an existing compatible projection can consume this replay. */
  warm: boolean;
}

/**
 * Select the freshest journal containing the session while validating any
 * cached projection against that journal's persisted prefix.
 *
 * The JSONL store performs incremental file-tail hydration internally, but the
 * selector returns a complete in-memory replay because candidate timestamps,
 * interactions, and generated-artifact provenance require historical events.
 * The reducer cache still applies only sequences newer than its lastSequence.
 */
export async function selectCodexEventSourceWithCache(
  sources: readonly CodexEventStoreSource[],
  sessionId: string,
  cache: CodexProjectionCache,
): Promise<SelectedCodexEventSourceWithCache | null> {
  const selected = await selectFreshestSourceStore(sources, sessionId);
  if (!selected) return null;
  const sourceId = selected.source.id;
  const cachedSequence = cache.getLastSequence(sourceId, sessionId);
  const events = await selected.store.replay({ sessionId });
  if (events.length === 0) return null;
  let warm = cachedSequence > 0;
  if (warm && !cache.matchesReplaySnapshot(sourceId, sessionId, events)) {
    cache.invalidate(sourceId, sessionId);
    warm = false;
  }
  const result = selectedSource(selected.source, events);
  return { ...result, warm };
}

function selectedSource(
  source: CodexEventStoreSource,
  events: readonly CodexEventEnvelope[],
): SelectedCodexEventSource {
  const firstAvailableSequence = events[0]?.sequence ?? 0;
  const lastSequence = events.at(-1)?.sequence ?? 0;
  return {
    sourceId: source.id,
    sourceKind: source.legacyBridgeFull
      ? "legacy-bridge-full"
      : source.id === "provider"
        ? "provider"
        : "custom",
    coverage: {
      scope: "retained-journal",
      completePrefix: firstAvailableSequence === 1,
      firstAvailableSequence,
      lastSequence,
      leadingGap: Math.max(0, firstAvailableSequence - 1),
      fallback: "rollout",
    },
    events,
  };
}

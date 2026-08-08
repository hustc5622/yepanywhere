import type { CodexEventStore } from "./store.js";
import type { CodexEventEnvelope } from "./types.js";

const MAX_STORE_SOURCES = 8;
const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * One independently sequenced canonical Codex journal.
 *
 * A factory is intentional: provider and bridge writers own their file-store
 * instances, while readers must observe appends made after the server started.
 */
export interface CodexEventStoreSource {
  id: string;
  createStore: () => CodexEventStore;
}

export interface SelectedCodexEventSource {
  sourceId: string;
  events: CodexEventEnvelope[];
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
 * Select the first complete journal containing the session.
 *
 * Provider and bridge journals have independent sequence spaces. They must
 * never be concatenated or sorted together; callers share this selector so a
 * transcript export and a normal session refresh use identical precedence.
 */
export async function selectCodexEventSource(
  sources: readonly CodexEventStoreSource[],
  sessionId: string,
): Promise<SelectedCodexEventSource | null> {
  for (const source of sources) {
    const events = await source.createStore().replay({ sessionId });
    if (events.length > 0) {
      return { sourceId: source.id, events };
    }
  }
  return null;
}

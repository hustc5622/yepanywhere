import type { UrlProjectId } from "@yep-anywhere/shared";
import type { Message, Session } from "../supervisor/types.js";
import { normalizeSession } from "./normalization.js";
import type { ISessionReader } from "./types.js";

/** Load the entire visible history, not the default tail used by the UI. */
export async function loadSessionTitleContext(
  reader: Pick<ISessionReader, "getSession">,
  sessionId: string,
  projectId: UrlProjectId,
  preferredReader?: Pick<ISessionReader, "getSession">,
): Promise<Session | null> {
  // A running rollout can change between pages. Restart from a fresh snapshot
  // rather than mixing revisions or silently generating from partial history.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await loadSnapshot(reader, sessionId, projectId, preferredReader);
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof Error) ||
        !["ROLLOUT_CURSOR_STALE", "ROLLOUT_CHANGED_DURING_SCAN"].includes(
          error.message,
        )
      ) {
        throw error;
      }
    }
  }
}

async function loadSnapshot(
  reader: Pick<ISessionReader, "getSession">,
  sessionId: string,
  projectId: UrlProjectId,
  preferredReader?: Pick<ISessionReader, "getSession">,
): Promise<Session | null> {
  // Native Codex history includes the inherited prefix of paginated forks.
  // Choose the source on the first page and keep it for the entire traversal.
  let loaded = await preferredReader?.getSession(
    sessionId,
    projectId,
    undefined,
    {
      includeOrphans: false,
    },
  );
  const pageReader = loaded && preferredReader ? preferredReader : reader;
  if (!loaded) {
    loaded = await reader.getSession(sessionId, projectId, undefined, {
      includeOrphans: false,
    });
  }
  if (!loaded) return null;
  if (
    loaded.data.provider === "codex" ||
    loaded.data.provider === "codex-oss"
  ) {
    const meta = loaded.data.session.entries.find(
      (entry) => entry.type === "session_meta",
    );
    // Paginated forks store only the child suffix in the local rollout. If
    // native history is unavailable, that file cannot establish full coverage.
    if (
      meta?.type === "session_meta" &&
      meta.payload.forked_from_id &&
      typeof meta.payload.forked_from_ordinal_exclusive === "number" &&
      meta.payload.forked_from_ordinal_exclusive > 0
    ) {
      throw new Error(
        "Session title history requires inherited Codex fork messages",
      );
    }
  }

  const session = normalizeSession(loaded);
  const revision = loaded.pagination?.rolloutRevision;
  const source = loaded.historySource;
  const pages: Message[][] = [session.messages];
  const cursors = new Set<string>();

  while (loaded.pagination?.hasOlderMessages) {
    const cursor = loaded.pagination.truncatedBeforeMessageId;
    if (!cursor || cursors.has(cursor)) {
      throw new Error("Session title history pagination did not advance");
    }
    cursors.add(cursor);
    loaded = await pageReader.getSession(sessionId, projectId, undefined, {
      includeOrphans: false,
      beforeMessageId: cursor,
      ...(revision ? { rolloutRevision: revision } : {}),
    });
    if (!loaded) {
      throw new Error("Session title history disappeared while loading");
    }
    if (loaded.historySource !== source) {
      throw new Error("Session title history source changed while loading");
    }
    if (loaded.pagination?.rolloutRevision !== revision) {
      throw new Error("ROLLOUT_CURSOR_STALE");
    }
    pages.push(normalizeSession(loaded).messages);
  }

  // Some readers include their boundary message on both pages. Deduplicate by
  // identity, never text: repeated user instructions are separate turns.
  const seen = new Set<string>();
  const messages: Message[] = [];
  for (const page of pages.reverse()) {
    for (const message of page) {
      const id = getMessageId(message);
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      messages.push(message);
    }
  }
  return { ...session, messages, messageCount: messages.length };
}

function getMessageId(message: Message): string | undefined {
  const id = message.uuid ?? message.id;
  return typeof id === "string" ? id : undefined;
}

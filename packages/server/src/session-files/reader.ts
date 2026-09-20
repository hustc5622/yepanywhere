import { realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  SessionFileActivity,
  SessionSavedFileVersion,
} from "@yep-anywhere/shared";
import { isUserPromptMessage } from "../sessions/user-prompt-message.js";
import type { Message } from "../supervisor/types.js";
import type { SessionFileStore } from "./store.js";
import type { FileChangeRecord } from "./types.js";

export interface SelectedFileRecord {
  id: string;
  record: FileChangeRecord;
  timestamp: string;
  messageId: string;
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  let parent = absolute;
  while (true) {
    try {
      return join(await realpath(parent), relative(parent, absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (parent === dirname(parent)) throw error;
      parent = dirname(parent);
    }
  }
}

/** Select only turns present in the reader's selected active ancestry. Never infer by time. */
export async function readSavedFileRecords(
  store: SessionFileStore,
  provider: "codex" | "pi",
  sessionId: string,
  projectPath: string,
  messages: readonly Message[],
  recordIds?: readonly string[],
): Promise<{
  records: SelectedFileRecord[];
  incomplete: boolean;
  truncated: boolean;
}> {
  const identities = new Map<string, string>();
  let questionId: string | undefined;
  for (const message of messages) {
    const id =
      message.uuid ?? (typeof message.id === "string" ? message.id : undefined);
    if (isUserPromptMessage(message)) {
      questionId = id;
      if (provider === "pi" && id) identities.set(id, id);
    }
    if (provider === "codex") {
      const turn = message.codexTurnId ?? message.turnId;
      if (typeof turn === "string" && (questionId || id)) {
        identities.set(turn.replace(/^turn:/, ""), questionId ?? id ?? turn);
      }
    }
  }
  const scope = { provider, sessionId };
  const ids = recordIds ?? (await store.listRecords(scope));
  const records: SelectedFileRecord[] = [];
  const truncated = ids.length > 5_000;
  let incomplete = truncated;
  const root = await canonicalPath(projectPath);
  for (const id of ids.slice(0, 5_000)) {
    const record = await store.readRecord(scope, id);
    if (
      record.scope.provider !== provider ||
      record.scope.sessionId !== sessionId
    )
      throw new Error("Snapshot session mismatch");
    if (record.execution?.status === "rejected") continue;
    const messageId = identities.get(record.scope.turnId);
    // Unknown IDs may be rolled back, another branch, or not persisted yet.
    if (!messageId) continue;
    const [before, after] = await Promise.all([
      store.readSnapshot(record.beforeSnapshot),
      store.readSnapshot(record.afterSnapshot),
    ]);
    if (before.workspace !== root || after.workspace !== root) {
      incomplete = true;
      continue;
    }
    records.push({ id, record, messageId, timestamp: after.finishedAt });
    incomplete ||= !record.complete;
  }
  records.sort(
    (a, b) =>
      b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id),
  );
  return { records, incomplete, truncated };
}

export function savedFileActivities(
  records: SelectedFileRecord[],
): SessionFileActivity[] {
  const files = new Map<string, SessionFileActivity>();
  for (const { id, record, timestamp, messageId } of records) {
    for (const change of record.changes) {
      const version: SessionSavedFileVersion = {
        recordId: id,
        timestamp,
        kind: change.kind,
        complete: record.complete,
      };
      const previous = files.get(change.path);
      if (previous) {
        previous.savedVersions?.push(version);
        previous.count += 1;
        continue;
      }
      files.set(change.path, {
        path: change.path,
        outsideProject: false,
        kind: "modified",
        tools: [],
        count: 1,
        source: "snapshot",
        confidence: "high",
        messageId,
        timestamp,
        savedVersions: [version],
      });
    }
  }
  return [...files.values()];
}

export function decodeSavedText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

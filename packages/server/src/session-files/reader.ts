import { realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  SessionFileActivity,
  SessionFileCoverageReason,
  SessionSavedFileVersion,
} from "@yep-anywhere/shared";
import { diffLines } from "diff";
import { isUserPromptMessage } from "../sessions/user-prompt-message.js";
import type { Message } from "../supervisor/types.js";
import type { SessionFileStore } from "./store.js";
import type { FileChangeRecord } from "./types.js";

export interface SelectedFileRecord {
  id: string;
  record: FileChangeRecord;
  timestamp: string;
  messageId: string;
  coverageReasons?: SessionFileCoverageReason[];
}

/** Listed changes already have known before/after states, even if other paths were omitted. */
export function savedFileChangeComplete(record: FileChangeRecord): boolean {
  return record.execution?.coverage !== "partial";
}

/** A live checkpoint is superseded by a newer/terminal observation of the same execution. */
function currentExecutionRecords(
  records: SelectedFileRecord[],
): SelectedFileRecord[] {
  const current = new Map<string, SelectedFileRecord>();
  for (const entry of records) {
    const execution = entry.record.execution;
    if (!execution?.captureId) continue;
    const previous = current.get(execution.captureId);
    if (
      !previous ||
      (previous.record.execution?.status === "active" &&
        execution.status !== "active")
    ) {
      current.set(execution.captureId, entry);
    }
  }
  return records.filter(
    (entry) =>
      !entry.record.execution?.captureId ||
      current.get(entry.record.execution.captureId) === entry,
  );
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
  coverageReasons: SessionFileCoverageReason[];
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
  const coverageReasons = new Set<SessionFileCoverageReason>();
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
      coverageReasons.add("workspace-mismatch");
      continue;
    }
    const reasons = new Set<SessionFileCoverageReason>();
    if (record.execution?.coverage === "partial")
      reasons.add("execution-partial");
    for (const snapshot of [before, after]) {
      if (!snapshot.listingComplete) reasons.add("entry-limit");
      for (const omission of snapshot.omissions) {
        if (omission.reason === "ignored") continue;
        reasons.add(
          omission.reason === "byte-budget" || omission.reason === "too-large"
            ? omission.reason
            : "file-unavailable",
        );
      }
    }
    records.push({
      id,
      record,
      messageId,
      timestamp: after.finishedAt,
      coverageReasons: [...reasons],
    });
  }
  records.sort(
    (a, b) =>
      b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id),
  );
  const current = currentExecutionRecords(records);
  incomplete ||= current.some((entry) => !entry.record.complete);
  for (const entry of current) {
    for (const reason of entry.coverageReasons ?? [])
      coverageReasons.add(reason);
  }
  return {
    records,
    incomplete,
    truncated,
    coverageReasons: [...coverageReasons],
  };
}

export function savedFileActivities(
  records: SelectedFileRecord[],
): SessionFileActivity[] {
  const files = new Map<string, SessionFileActivity>();
  for (const { id, record, timestamp, messageId } of currentExecutionRecords(
    records,
  )) {
    for (const change of record.changes) {
      const version: SessionSavedFileVersion = {
        recordId: id,
        timestamp,
        kind: change.kind,
        complete: savedFileChangeComplete(record),
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

/** Enrich only displayed files, using the same latest saved version the panel opens. */
export async function addSavedFileLineCounts(
  store: SessionFileStore,
  records: SelectedFileRecord[],
  files: SessionFileActivity[],
): Promise<void> {
  const byId = new Map(records.map((entry) => [entry.id, entry.record]));
  // Bound aggregate CPU work as well as each individual diff. Unknown is never zero.
  let remainingMs = 250;
  for (const file of files) {
    if (remainingMs <= 0) break;
    const id = file.savedVersions?.[0]?.recordId;
    const change = id
      ? byId.get(id)?.changes.find((entry) => entry.path === file.path)
      : undefined;
    if (!change) continue;
    try {
      const [before, after] = await Promise.all(
        [change.before, change.after].map(async (version) =>
          version ? decodeSavedText(await store.readBlob(version.blob)) : "",
        ),
      );
      if (before === undefined || after === undefined) continue;
      const started = performance.now();
      const parts = diffLines(before, after, {
        timeout: Math.min(25, remainingMs),
      });
      remainingMs -= performance.now() - started;
      if (!parts) continue;
      file.additions = parts.reduce(
        (sum, part) => sum + (part.added ? part.count : 0),
        0,
      );
      file.deletions = parts.reduce(
        (sum, part) => sum + (part.removed ? part.count : 0),
        0,
      );
    } catch {
      // A missing/corrupt blob must not hide the index or invent line counts.
      // Opening the saved file still reports the underlying read failure.
    }
  }
}

export function decodeSavedText(
  bytes: Buffer,
  preserveBom = false,
): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: preserveBom,
    }).decode(bytes);
  } catch {
    return undefined;
  }
}

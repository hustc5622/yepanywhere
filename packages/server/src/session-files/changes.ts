import type { SessionFileStore } from "./store.js";
import {
  type FileChangeRecord,
  type FileChangeScope,
  type FileSnapshot,
  ScopeSchema,
} from "./types.js";

function knownAbsent(snapshot: FileSnapshot, path: string): boolean {
  return (
    snapshot.listingComplete &&
    !snapshot.omissions.some(
      (omission) =>
        path === omission.path || path.startsWith(`${omission.path}/`),
    ) &&
    !path
      .split("/")
      .some((part) => snapshot.policy.excludedDirectories.includes(part))
  );
}

/** Compare immutable versions, never the current worktree or HEAD. */
export async function recordSnapshotChanges(
  store: SessionFileStore,
  scope: FileChangeScope,
  beforeSnapshot: string,
  afterSnapshot: string,
  execution?: FileChangeRecord["execution"],
): Promise<{ id: string; record: FileChangeRecord }> {
  const parsedScope = ScopeSchema.parse(scope);
  const [before, after] = await Promise.all([
    store.readSnapshot(beforeSnapshot),
    store.readSnapshot(afterSnapshot),
  ]);
  if (
    before.workspace !== after.workspace ||
    before.enumeration !== after.enumeration ||
    JSON.stringify(before.policy) !== JSON.stringify(after.policy)
  ) {
    throw new Error(
      "Cannot compare snapshots from different workspaces or capture policies",
    );
  }
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.files.map((file) => [file.path, file]));
  const record: FileChangeRecord = {
    version: 1,
    scope: parsedScope,
    beforeSnapshot,
    afterSnapshot,
    evidence: "snapshot",
    attribution: "observed-during-execution",
    ...(execution ? { execution } : {}),
    complete:
      execution?.coverage !== "partial" &&
      before.listingComplete &&
      after.listingComplete &&
      [...before.omissions, ...after.omissions].every(
        (o) => o.reason === "ignored",
      ),
    changes: [],
    uncertainPaths: [],
  };
  for (const path of [
    ...new Set([...oldFiles.keys(), ...newFiles.keys()]),
  ].sort()) {
    const oldFile = oldFiles.get(path);
    const newFile = newFiles.get(path);
    if (
      (!oldFile && !knownAbsent(before, path)) ||
      (!newFile && !knownAbsent(after, path))
    ) {
      record.uncertainPaths.push(path);
      record.complete = false;
    } else if (
      !oldFile ||
      !newFile ||
      oldFile.blob !== newFile.blob ||
      oldFile.executable !== newFile.executable
    ) {
      record.changes.push({
        path,
        kind: !oldFile ? "added" : !newFile ? "deleted" : "modified",
        ...(oldFile ? { before: oldFile } : {}),
        ...(newFile ? { after: newFile } : {}),
      });
    }
  }
  const id = await store.putRecord(record);
  return { id, record };
}

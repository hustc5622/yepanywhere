import { resolve } from "node:path";
import {
  type SessionFileActivity,
  type SessionFileOperationChange,
  type SessionFileOperationStats,
  normalizeSessionFilePath,
} from "@yep-anywhere/shared";
import { diffLines, parsePatch } from "diff";
import type {
  SessionFileOperationStore,
  StoredFileOperation,
} from "./operation-store.js";
import { decodeSavedText } from "./reader.js";

/** Only an explicit branch ancestry can authorize operation visibility. */
export function selectFileOperations(
  operations: readonly StoredFileOperation[],
  workspace: string,
  visibleTurns: ReadonlyMap<string, string>,
): StoredFileOperation[] {
  return operations.filter(
    ({ record }) =>
      resolve(record.workspace) === resolve(workspace) &&
      visibleTurns.has(record.identity.turnId),
  );
}

export function countOperationPatch(
  change: SessionFileOperationChange,
): SessionFileOperationStats {
  if (change.before?.binary || change.after?.binary)
    return { availability: "unavailable", reason: "binary" };
  if (!change.patch?.complete)
    return { availability: "unavailable", reason: "missing-evidence" };
  try {
    const patches = parsePatch(change.patch.text);
    if (patches.length !== 1 || !patches[0]?.hunks.length)
      return { availability: "unavailable", reason: "invalid-patch" };
    let additions = 0;
    let deletions = 0;
    for (const hunk of patches[0]?.hunks ?? []) {
      let oldLines = 0;
      let newLines = 0;
      for (const line of hunk.lines) {
        if (line.startsWith("+")) {
          additions++;
          newLines++;
        } else if (line.startsWith("-")) {
          deletions++;
          oldLines++;
        } else if (line.startsWith(" ")) {
          oldLines++;
          newLines++;
        } else if (!line.startsWith("\\ No newline"))
          throw new Error("Invalid diff line");
      }
      if (oldLines !== hunk.oldLines || newLines !== hunk.newLines)
        throw new Error("Incomplete diff hunk");
    }
    return { additions, deletions, availability: "complete" };
  } catch {
    return { availability: "unavailable", reason: "invalid-patch" };
  }
}

export async function operationLineStats(
  store: SessionFileOperationStore,
  change: SessionFileOperationChange,
): Promise<SessionFileOperationStats> {
  if (change.outcome !== "applied")
    return { availability: "unavailable", reason: "missing-evidence" };
  if (change.kind === "mode-change")
    return { availability: "complete", additions: 0, deletions: 0 };
  if (change.before?.binary || change.after?.binary)
    return { availability: "unavailable", reason: "binary" };
  if (change.before === undefined || change.after === undefined)
    return countOperationPatch(change);
  try {
    const [before, after] = await Promise.all(
      [change.before, change.after].map(async (ref) =>
        ref === null ? "" : decodeSavedText(await store.readContent(ref), true),
      ),
    );
    if (before === undefined || after === undefined)
      return { availability: "unavailable", reason: "binary" };
    const parts = diffLines(before, after, { timeout: 25 });
    if (!parts) return { availability: "unavailable", reason: "timeout" };
    return {
      availability: "complete",
      additions: parts.reduce(
        (sum, part) => sum + (part.added ? part.count : 0),
        0,
      ),
      deletions: parts.reduce(
        (sum, part) => sum + (part.removed ? part.count : 0),
        0,
      ),
    };
  } catch {
    const patch = countOperationPatch(change);
    return patch.availability === "complete"
      ? patch
      : { availability: "unavailable", reason: "missing-content" };
  }
}

export interface OperationFileProjection {
  files: SessionFileActivity[];
  unavailableOperations: number;
  truncated: boolean;
}

export async function projectFileOperations(
  store: SessionFileOperationStore,
  operations: readonly StoredFileOperation[],
  workspace: string,
  visibleTurns: ReadonlyMap<string, string>,
): Promise<OperationFileProjection> {
  const files = new Map<string, SessionFileActivity>();
  const unavailableIds = new Set<string>();
  let truncated = false;
  const selected = selectFileOperations(operations, workspace, visibleTurns);
  const statsDeadline = performance.now() + 250;
  // Statistics describe individual operations; never splice an externally modified version chain.
  for (const entry of [...selected].reverse()) {
    const { record } = entry;
    if (entry.conflict || ["pending", "unknown"].includes(record.outcome)) {
      unavailableIds.add(entry.id);
      continue;
    }
    if (!["applied", "partially-applied"].includes(record.outcome)) continue;
    if (record.outcome === "partially-applied") unavailableIds.add(entry.id);
    for (const change of record.changes) {
      if (change.outcome !== "applied") continue;
      const path = normalizeSessionFilePath(change.path, workspace);
      if (!path) continue;
      let file = files.get(path.path);
      if (!file) {
        if (files.size >= 500) {
          truncated = true;
          continue;
        }
        file = {
          path: path.path,
          outsideProject: path.outsideProject,
          kind: "modified",
          tools: [],
          count: 0,
          source: "operation",
          confidence: "high",
          messageId:
            visibleTurns.get(record.identity.turnId) ?? record.messageId,
          timestamp: record.timestamp,
          savedVersions: [],
          additions: 0,
          deletions: 0,
          statisticsScope: "session-operations",
          knownOperations: 0,
          unknownOperations: 0,
        };
        files.set(path.path, file);
      }
      const stats: SessionFileOperationStats =
        performance.now() < statsDeadline
          ? await operationLineStats(store, change)
          : { availability: "unavailable", reason: "timeout" };
      file.count++;
      if (!file.tools.includes(record.toolName))
        file.tools.push(record.toolName);
      if (stats.availability === "complete") {
        file.knownOperations = (file.knownOperations ?? 0) + 1;
        file.additions = (file.additions ?? 0) + (stats.additions ?? 0);
        file.deletions = (file.deletions ?? 0) + (stats.deletions ?? 0);
      } else {
        file.unknownOperations = (file.unknownOperations ?? 0) + 1;
        unavailableIds.add(entry.id);
      }
      file.savedVersions?.push({
        recordId: `op:${entry.id}`,
        timestamp: record.timestamp,
        kind:
          change.kind === "added"
            ? "added"
            : change.kind === "deleted"
              ? "deleted"
              : "modified",
        complete: stats.availability === "complete",
        source: "operation",
        additions: stats.additions,
        deletions: stats.deletions,
        contentAvailable:
          (change.after ?? change.before) !== undefined &&
          (change.after ?? change.before) !== null,
      });
    }
  }
  for (const file of files.values()) {
    if (!file.knownOperations) {
      file.additions = undefined;
      file.deletions = undefined;
    }
  }
  return {
    files: [...files.values()],
    unavailableOperations: unavailableIds.size,
    truncated,
  };
}

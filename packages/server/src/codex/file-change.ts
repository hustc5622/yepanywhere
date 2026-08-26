import {
  type CodexPublicPathOptions,
  codexFilePathFingerprint,
  hiddenCodexFilePath,
  isCodexPathFingerprint,
  isHiddenCodexFilePath,
  publicCodexFileChangePath,
} from "./path-projection.js";

export { publicCodexFilePath } from "./path-projection.js";

export type CodexFileChangeKind = "add" | "delete" | "update";

export type CodexFileChangeStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "declined"
  | "unknown";

/** Canonical shape shared by Codex JSONL and app-server projections. */
export interface NormalizedCodexFileChange {
  path: string;
  /** Correlates older fingerprint-only journals with a normalized rollout. */
  pathFingerprint?: string;
  kind: CodexFileChangeKind;
  diff?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonBlankString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.trim()) return value;
  }
  return undefined;
}

function firstTrimmedString(...values: unknown[]): string | undefined {
  return firstNonBlankString(...values)?.trim();
}

function normalizeKind(value: unknown): {
  kind: CodexFileChangeKind;
  movePath?: string;
} {
  const kindRecord = isRecord(value) ? value : undefined;
  const rawKind =
    typeof value === "string"
      ? value.trim()
      : firstTrimmedString(kindRecord?.type, kindRecord?.kind);
  const normalized = rawKind
    ?.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
    .toLowerCase();
  const kind: CodexFileChangeKind =
    normalized === "add" || normalized === "delete" || normalized === "update"
      ? normalized
      : "update";
  const movePath = firstTrimmedString(
    kindRecord?.move_path,
    kindRecord?.movePath,
  );
  return { kind, ...(movePath ? { movePath } : {}) };
}

function normalizeChange(
  pathValue: unknown,
  value: unknown,
): NormalizedCodexFileChange | null {
  const path = firstTrimmedString(pathValue);
  if (!path || !isRecord(value)) return null;

  const kindInfo = normalizeKind(value.kind ?? value.type);
  const movePath = firstTrimmedString(
    value.move_path,
    value.movePath,
    kindInfo.movePath,
  );
  let diff = firstNonBlankString(
    value.diff,
    value.unified_diff,
    value.unifiedDiff,
    value.content,
  );

  // Match Codex app-server's convert_patch_changes representation for moves.
  if (
    diff &&
    kindInfo.kind === "update" &&
    movePath &&
    !diff.includes(`Moved to: ${movePath}`)
  ) {
    diff = `${diff}\n\nMoved to: ${movePath}`;
  }

  return {
    path,
    ...(isCodexPathFingerprint(value.pathFingerprint)
      ? { pathFingerprint: value.pathFingerprint }
      : {}),
    kind: kindInfo.kind,
    ...(diff ? { diff } : {}),
  };
}

/**
 * Normalize both Codex persisted changes (`Record<path, FileChange>`) and
 * app-server `FileUpdateChange[]` into the same sorted representation.
 */
export function normalizeCodexFileChanges(
  value: unknown,
): NormalizedCodexFileChange[] {
  const changes: NormalizedCodexFileChange[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const normalized = normalizeChange(item.path, item);
      if (normalized) changes.push(normalized);
    }
  } else if (isRecord(value)) {
    for (const [path, change] of Object.entries(value)) {
      const normalized = normalizeChange(path, change);
      if (normalized) changes.push(normalized);
    }
  }

  changes.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return changes;
}

/**
 * Public projection shared by live app-server events and persisted rollout
 * normalization. Provider-internal paths remain available to execution code,
 * while transcripts retain original paths and bounded patch bodies. Fingerprints
 * are kept only to correlate older journals that already lost their paths.
 */
export function publicCodexFileChanges(
  value: unknown,
  options: CodexPublicPathOptions = {},
): NormalizedCodexFileChange[] {
  const pathSafeValue = Array.isArray(value)
    ? value.map((entry) => {
        const change = isRecord(entry) ? entry : undefined;
        return change &&
          (typeof change.path !== "string" ||
            !change.path.trim() ||
            isHiddenCodexFilePath(change.path)) &&
          isCodexPathFingerprint(change.pathFingerprint)
          ? { ...change, path: hiddenCodexFilePath(change.pathFingerprint) }
          : entry;
      })
    : value;

  return normalizeCodexFileChanges(pathSafeValue)
    .slice(0, 200)
    .map((change) => ({
      path: publicCodexFileChangePath(change.path, options),
      pathFingerprint:
        change.pathFingerprint ?? codexFilePathFingerprint(change.path),
      kind: change.kind,
      ...(change.diff
        ? {
            diff: change.diff.slice(0, 64 * 1024),
          }
        : {}),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

export function buildCodexEditInput(
  changes: NormalizedCodexFileChange[],
): Record<string, unknown> {
  const input: Record<string, unknown> = { changes };
  if (changes.length === 1 && changes[0]?.path) {
    input.file_path = changes[0].path;
  }
  return input;
}

export function summarizeCodexFileChanges(
  changes: NormalizedCodexFileChange[],
): string {
  return changes.map((change) => `${change.kind}: ${change.path}`).join("\n");
}

export function normalizeCodexFileChangeStatus(
  status: unknown,
  success?: unknown,
): CodexFileChangeStatus {
  if (typeof status === "string") {
    const normalized = status
      .trim()
      .replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
      .toLowerCase();
    switch (normalized) {
      case "in_progress":
        return "in_progress";
      case "complete":
      case "completed":
      case "success":
        return "completed";
      case "error":
      case "failed":
        return "failed";
      case "declined":
        return "declined";
    }
  }

  if (typeof success === "boolean") {
    return success ? "completed" : "failed";
  }
  return "unknown";
}

export function isCodexFileChangeError(status: CodexFileChangeStatus): boolean {
  return status === "failed" || status === "declined";
}

export function formatCodexFileChangeResult(
  changes: NormalizedCodexFileChange[],
  status: CodexFileChangeStatus,
): string {
  const heading =
    status === "completed"
      ? "File changes applied"
      : status === "declined"
        ? "File changes declined"
        : status === "in_progress"
          ? "File changes pending"
          : "File changes failed";
  const summary = summarizeCodexFileChanges(changes);
  return summary ? `${heading}:\n${summary}` : `${heading}.`;
}

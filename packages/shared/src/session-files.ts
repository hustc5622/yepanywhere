/**
 * Session file activity: the structured index of files a session touched.
 *
 * The index is derived from structured tool inputs (and, with lower
 * confidence, from shell commands that obviously write to disk). It is never
 * derived by scanning assistant prose for path-looking substrings, which is
 * both noisy and impossible to verify.
 */

export type SessionFileActivityKind =
  | "modified"
  | "read"
  | "searched"
  | "other";

/** Where the path was observed. `shell` results are heuristic. */
export type SessionFileActivitySource = "tool" | "shell";

export type SessionFileActivityConfidence = "high" | "low";

export interface SessionFileActivity {
  /** Project-relative path when resolvable, otherwise the observed path. */
  path: string;
  /** True when the path resolves outside the project root. */
  outsideProject: boolean;
  kind: SessionFileActivityKind;
  /** Distinct tool names that touched this path, most recent last. */
  tools: string[];
  /** Number of tool calls that touched this path. */
  count: number;
  source: SessionFileActivitySource;
  confidence: SessionFileActivityConfidence;
  /** Message id to navigate to for the most recent touch. */
  messageId: string;
  /** Timestamp of the most recent touch, when known. */
  timestamp?: string;
  /** Lines this session added to the file, summed over its edit calls. */
  additions?: number;
  /** Lines this session removed from the file. */
  deletions?: number;
  /** Number of edit operations this session applied to the file. */
  edits?: number;
}

export interface SessionFileDiff {
  path: string;
  diffHtml: string;
  structuredPatch: unknown[];
  /**
   * False when the session baseline could only be partially reconstructed
   * (e.g. an overwrite whose previous content was never recorded), so the diff
   * understates what the session changed.
   */
  exact: boolean;
}

export interface SessionFileActivityIndex {
  projectId: string;
  sessionId: string;
  files: SessionFileActivity[];
  /** True when the underlying message scan hit its cap. */
  truncated: boolean;
  generatedAt: string;
}

export const SESSION_FILE_ACTIVITY_MAX_PATHS = 2_000;
const MAX_PATH_LENGTH = 4_096;

const MUTATING_FILE_TOOLS = new Set([
  "edit",
  "multiedit",
  "notebookedit",
  "write",
  "applypatch",
  "createfile",
  "strreplace",
  "strreplaceeditor",
  "updatefile",
  "patch",
]);
const READ_FILE_TOOLS = new Set([
  "read",
  "readfile",
  "viewimage",
  "notebookread",
]);
const SEARCH_FILE_TOOLS = new Set(["glob", "grep", "search", "codebasesearch"]);

const KIND_PRIORITY: Record<SessionFileActivityKind, number> = {
  modified: 3,
  read: 2,
  searched: 1,
  other: 0,
};

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function classifyFileActivityKind(
  toolName: string,
): SessionFileActivityKind {
  const normalized = normalizeToolName(toolName);
  if (MUTATING_FILE_TOOLS.has(normalized)) return "modified";
  if (READ_FILE_TOOLS.has(normalized)) return "read";
  if (SEARCH_FILE_TOOLS.has(normalized)) return "searched";
  return "other";
}

export function prioritizeFileActivityKind(
  previous: SessionFileActivityKind,
  next: SessionFileActivityKind,
): SessionFileActivityKind {
  return KIND_PRIORITY[next] > KIND_PRIORITY[previous] ? next : previous;
}

/**
 * Reject values that are clearly commands or prose rather than paths. Tool
 * inputs sometimes reuse `path`-ish keys for free-form strings.
 */
export function looksLikeShellCommand(value: string): boolean {
  return (
    value.includes("\n") ||
    /[|;&<>*?$`]/.test(value) ||
    /\s-{1,2}[a-z]/i.test(value) ||
    value.length > MAX_PATH_LENGTH
  );
}

const TOOL_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "old_path",
  "oldPath",
  "new_path",
  "newPath",
  "target_file",
  "targetFile",
  "abs_path",
  "absPath",
] as const;

/** Extract file paths from a structured tool input payload. */
export function extractToolFilePaths(
  input: unknown,
  maxPaths = SESSION_FILE_ACTIVITY_MAX_PATHS,
): string[] {
  if (!isRecord(input)) return [];
  const candidates: unknown[] = TOOL_PATH_KEYS.map((key) => input[key]);
  // Codex `apply_patch` and multi-file edits carry a `changes` array instead
  // of a top-level path.
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      if (isRecord(change)) candidates.push(change.path ?? change.file_path);
      else if (typeof change === "string") candidates.push(change);
    }
  }
  if (Array.isArray(input.files)) {
    for (const file of input.files) {
      if (isRecord(file)) candidates.push(file.path ?? file.file_path);
      else if (typeof file === "string") candidates.push(file);
    }
  }
  if (Array.isArray(input.paths)) candidates.push(...input.paths);

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed || looksLikeShellCommand(trimmed) || seen.has(trimmed))
      continue;
    seen.add(trimmed);
    paths.push(trimmed);
    if (paths.length >= maxPaths) break;
  }
  return paths;
}

/** Read a shell command out of a tool input, regardless of provider spelling. */
export function extractToolCommand(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ["command", "cmd", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return value.join(" ");
    }
  }
  if (
    Array.isArray(input.args) &&
    input.args.every((a) => typeof a === "string")
  ) {
    return input.args.join(" ");
  }
  return null;
}

const SHELL_TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;

/**
 * Best-effort extraction of files a shell command writes to.
 *
 * This is intentionally conservative and always reported with low confidence:
 * `Bash`-style tools are the single largest blind spot of tool-input-derived
 * indexes (`sed -i`, redirects, `tee`, `mv`), and surfacing them as "maybe
 * changed" beats dropping them entirely.
 */
export function extractShellWritePaths(command: string): string[] {
  if (!command.trim()) return [];
  const results: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    const cleaned = value.trim().replace(/^['"]|['"]$/g, "");
    if (!cleaned || cleaned.startsWith("-")) return;
    if (/[*?$`|;&<>]/.test(cleaned)) return;
    if (cleaned === "/dev/null" || cleaned.startsWith("/dev/")) return;
    if (!cleaned.includes("/") && !cleaned.includes(".")) return;
    if (cleaned.length > MAX_PATH_LENGTH) return;
    if (!results.includes(cleaned)) results.push(cleaned);
  };

  for (const segment of splitShellSegments(command)) {
    const tokens: string[] = [];
    SHELL_TOKEN_RE.lastIndex = 0;
    let match = SHELL_TOKEN_RE.exec(segment);
    while (match) {
      tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
      match = SHELL_TOKEN_RE.exec(segment);
    }
    if (tokens.length === 0) continue;

    // Redirections: `> out.txt`, `>>out.txt`, `1> out.txt`
    const redirects = segment.matchAll(/(?:^|\s)\d?>>?\s*([^\s|;&>]+)/g);
    for (const redirect of redirects) push(redirect[1]);

    const command0 = basename(tokens[0] ?? "");
    const rest = tokens.slice(1);
    switch (command0) {
      case "tee":
        for (const token of rest) if (!token.startsWith("-")) push(token);
        break;
      case "sed":
      case "perl":
        if (rest.some((token) => /^-.*i/.test(token))) {
          // Drop flags, the empty backup-suffix operand, and the script itself;
          // everything after the script is a file operand.
          const operands = rest.filter(
            (token) => token !== "" && !token.startsWith("-"),
          );
          for (const token of operands.slice(1)) push(token);
        }
        break;
      case "mv":
      case "cp":
      case "install": {
        const operands = rest.filter((token) => !token.startsWith("-"));
        push(operands[operands.length - 1]);
        if (command0 === "mv") push(operands[0]);
        break;
      }
      case "rm":
      case "unlink":
      case "touch":
      case "truncate":
        for (const token of rest) if (!token.startsWith("-")) push(token);
        break;
      default:
        break;
    }
  }
  return results;
}

function splitShellSegments(command: string): string[] {
  return command
    .split(/\n|&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function basename(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
}

export interface NormalizedSessionFilePath {
  /** Project-relative path when inside the project, else the absolute path. */
  path: string;
  outsideProject: boolean;
}

/**
 * Normalize an observed path against the project root so the same file is not
 * indexed twice under absolute and relative spellings.
 */
export function normalizeSessionFilePath(
  raw: string,
  projectPath?: string,
): NormalizedSessionFilePath | null {
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("file://")) {
    try {
      value = decodeURIComponent(value.slice("file://".length));
    } catch {
      value = value.slice("file://".length);
    }
  }
  value = value.replace(/^['"]|['"]$/g, "").trim();
  if (!value) return null;

  const isAbsolute = value.startsWith("/");
  const root = projectPath?.replace(/\/+$/, "");
  if (isAbsolute && root) {
    if (value === root) return null;
    if (value.startsWith(`${root}/`)) {
      const relative = collapse(value.slice(root.length + 1));
      return relative ? { path: relative, outsideProject: false } : null;
    }
    return { path: collapse(value) || value, outsideProject: true };
  }
  if (isAbsolute)
    return { path: collapse(value) || value, outsideProject: true };

  const relative = collapse(value);
  if (!relative) return null;
  return { path: relative, outsideProject: relative.startsWith("../") };
}

/** Collapse `./` and redundant slashes without touching `..` semantics. */
function collapse(value: string): string {
  const absolute = value.startsWith("/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Project Path Utilities
 *
 * This module handles the different path encoding schemes used in Claude's
 * session storage. There are TWO different encodings to be aware of:
 *
 * ## 1. Project ID (used in URLs/API)
 *
 * The `projectId` is a **base64url** encoding of the absolute project path.
 * Example: `/home/user/my-project` → `L2hvbWUvdXNlci9teS1wcm9qZWN0`
 *
 * This encoding is:
 * - Reversible via `decodeProjectId()`
 * - URL-safe (no special characters)
 * - Used in API routes and client URLs
 *
 * ## 2. Directory Names (in ~/.claude/projects/)
 *
 * Session files are stored in directories with **slash-to-hyphen** encoding.
 * Example: `/home/user/my-project` → `-home-user-my-project`
 *
 * The directory structure is:
 * ```
 * ~/.claude/projects/
 *   ├── -home-user-project/              # Direct encoding (no hostname)
 *   │   └── session-123.jsonl
 *   └── hostname/                        # With hostname prefix
 *       └── -home-user-project/
 *           └── session-456.jsonl
 * ```
 *
 * ## Why Two Encodings?
 *
 * The slash-to-hyphen encoding is **LOSSY** - you cannot reliably decode it
 * back to the original path because hyphens in the original path create
 * ambiguity:
 *
 * Directory: `-home-user-name-my-project`
 * Could be:  `/home/user-name/my-project`
 *       or:  `/home/user/name-my-project`
 *       or:  `/home/user/name/my-project`
 *
 * ## The Solution: Read CWD from Session Files
 *
 * Instead of decoding directory names, we read the actual project path from
 * the `cwd` field in session JSONL files. This is reliable because the Claude
 * SDK writes the working directory to session files when they're created.
 *
 * See `ProjectScanner.getProjectPathFromSessions()` for the implementation.
 *
 * ## Best Practices
 *
 * 1. Always use `Project.path` for the absolute path - never try to decode
 *    directory names.
 * 2. Use `projectId` (base64url) for API calls and URLs.
 * 3. Use `Project.sessionDir` to access the session files directory.
 * 4. Use `getSessionFilePath()` to construct paths to specific session files.
 */

import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { stripBom } from "../utils/jsonl.js";

/** Check if a path is absolute (works for both Unix and Windows paths). */
export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p);
}

/** The root directory where Claude stores project sessions */
export const CLAUDE_DIR =
  process.env.CLAUDE_SESSIONS_DIR?.replace(
    new RegExp(`\\${sep}projects$`),
    "",
  ) ??
  process.env.CLAUDE_CONFIG_DIR ??
  join(homedir(), ".claude");
export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_SESSIONS_DIR ?? join(CLAUDE_DIR, "projects");

/**
 * Encode an absolute project path to a projectId (base64url).
 * This is reversible via `decodeProjectId()`.
 *
 * @example
 * encodeProjectId("/home/user/my-project")
 * // => "L2hvbWUvdXNlci9teS1wcm9qZWN0"
 */
export function encodeProjectId(path: string): UrlProjectId {
  return Buffer.from(path).toString("base64url") as UrlProjectId;
}

/**
 * Decode a projectId back to an absolute project path.
 *
 * @example
 * decodeProjectId("L2hvbWUvdXNlci9teS1wcm9qZWN0")
 * // => "/home/user/my-project"
 */
export function decodeProjectId(id: UrlProjectId): string {
  return Buffer.from(id, "base64url").toString("utf-8");
}

/**
 * Get the name (basename) of a project from its path.
 *
 * @example
 * getProjectName("/home/user/my-project")
 * // => "my-project"
 */
export function getProjectName(projectPath: string): string {
  return basename(projectPath);
}

/**
 * Canonicalize a project path for identity comparisons.
 *
 * This keeps the path semantically the same while normalizing Windows-only
 * variations that otherwise create duplicate project records:
 * - backslashes vs forward slashes
 * - lowercase vs uppercase drive letters
 */
export function canonicalizeProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.replace(/^([a-z]):/, (_match, drive: string) => {
    return `${drive.toUpperCase()}:`;
  });
}

/**
 * Normalize a project path for cross-machine deduplication.
 *
 * Strips OS-specific home directory prefixes so the same project
 * on different machines (macOS vs Linux) merges into one entry.
 *
 * @example
 * normalizeProjectPathForDedup("/Users/kgraehl/dotfiles")  // => "kgraehl/dotfiles"
 * normalizeProjectPathForDedup("/home/kgraehl/dotfiles")   // => "kgraehl/dotfiles"
 * normalizeProjectPathForDedup("/root/dotfiles")           // => "root/dotfiles"
 * normalizeProjectPathForDedup("/opt/shared/project")      // => "/opt/shared/project"
 */
export function normalizeProjectPathForDedup(path: string): string {
  const normalized = canonicalizeProjectPath(path);
  // Unix: /Users/kgraehl/dotfiles or /home/kgraehl/dotfiles
  const unixMatch = normalized.match(/^\/(?:Users|home)\/(.+)$/);
  if (unixMatch?.[1]) return unixMatch[1];
  // Windows: C:/Users/kgraehl/dotfiles (after backslash normalization)
  const winMatch = normalized.match(/^[a-zA-Z]:\/(?:Users|home)\/(.+)$/);
  if (winMatch?.[1]) return winMatch[1];
  const rootMatch = normalized.match(/^\/root\/(.+)$/);
  if (rootMatch?.[1]) return `root/${rootMatch[1]}`;
  return normalized;
}

/**
 * Get the full path to a session file.
 *
 * @param sessionDir - The project's session directory (Project.sessionDir)
 * @param sessionId - The session ID (filename without .jsonl)
 *
 * @example
 * getSessionFilePath("/home/user/.claude/projects/-home-user-proj", "abc123")
 * // => "/home/user/.claude/projects/-home-user-proj/abc123.jsonl"
 */
export function getSessionFilePath(
  sessionDir: string,
  sessionId: string,
): string {
  return join(sessionDir, `${sessionId}.jsonl`);
}

/**
 * Extract the session ID from a file path.
 * Works with both absolute paths and relative paths.
 *
 * @example
 * getSessionIdFromPath("/path/to/projects/xxx/my-session.jsonl")
 * // => "my-session"
 *
 * getSessionIdFromPath("projects/xxx/my-session.jsonl")
 * // => "my-session"
 */
export function getSessionIdFromPath(filePath: string): string | null {
  const match = filePath.match(/([^/\\]+)\.jsonl$/);
  return match?.[1] ?? null;
}

/**
 * Read the working directory (cwd) from a session file.
 * This is the most reliable way to get the actual project path.
 *
 * The cwd is stored in the first few lines of the JSONL file by the Claude SDK.
 *
 * @param sessionFilePath - Absolute path to the session .jsonl file
 * @returns The cwd field value, or null if not found
 */
export async function readCwdFromSessionFile(
  sessionFilePath: string,
): Promise<string | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    // Read only the first 8KB — cwd is always near the start of the file.
    // Avoids reading multi-MB session files entirely.
    fd = await open(sessionFilePath, "r");
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buf, 0, 8192, 0);
    if (bytesRead === 0) return null;

    const content = stripBom(buf.toString("utf-8", 0, bytesRead));
    const lines = content.split("\n").slice(0, 20);

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.cwd && typeof data.cwd === "string") {
          return data.cwd;
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

/**
 * Recover the working directory to use when resuming a session whose cached
 * `projectPath` may be stale.
 *
 * Background: a `Project` is identified by a base64url-encoded `projectId`.
 * If the user moves the project directory on disk, the cached index keeps the
 * old encoding, so `decodeProjectId(project.id)` can point at a path that no
 * longer exists. The Claude SDK rewrites the real `cwd` into the session jsonl
 * on every turn, so the jsonl is the source of truth.
 *
 * If the project path resolves to a directory that exists, we return null —
 * the caller should keep using the project as-is. Otherwise we read the latest
 * `cwd` from the session jsonl and return it iff it exists on disk; if neither
 * works we return null and the caller should error out cleanly rather than let
 * `spawn()` fail with an opaque ENOENT (which the SDK currently mis-renders as
 * "binary exists but failed to launch").
 */
export async function resolveResumeCwd(
  projectPath: string,
  sessionDir: string,
  sessionId: string,
  mapCwd: (cwd: string) => string = (cwd) => cwd,
): Promise<string | null> {
  try {
    const s = await stat(projectPath);
    if (s.isDirectory()) return null;
  } catch {
    // fall through to recovery
  }

  const sessionFile = getSessionFilePath(sessionDir, sessionId);
  let recoveredCwd = await readCwdFromSessionFile(sessionFile);
  if (recoveredCwd) recoveredCwd = mapCwd(recoveredCwd);
  if (!recoveredCwd) {
    // sessionId.jsonl might not exist (e.g. new session, or the session is
    // tracked in a sibling directory after a rename). Fall back to scanning
    // any jsonl in the sessionDir.
    recoveredCwd = await recoverCwdFromSessionDir(sessionDir, mapCwd);
  }
  if (!recoveredCwd) return null;

  try {
    const s = await stat(recoveredCwd);
    if (s.isDirectory()) return recoveredCwd;
  } catch {
    // recovered path is also gone
  }
  return null;
}

/**
 * Recover the real cwd for a project by scanning its session directory.
 *
 * Used when we need to spawn a Claude process for a project whose `path` is
 * stale (e.g. the user moved the directory on disk) but we don't have a
 * specific sessionId to read — for example when starting a brand-new session
 * via the `POST /api/projects/:projectId/sessions` route, or when the named
 * session jsonl isn't where we expected it. The SDK writes the real `cwd`
 * into every session jsonl, so reading any one of them gives a current,
 * trustworthy path.
 *
 * Returns the first cwd we can read that still points at an existing
 * directory, or null if no recovery is possible.
 */
export async function recoverCwdFromSessionDir(
  sessionDir: string,
  mapCwd: (cwd: string) => string = (cwd) => cwd,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
  for (const file of jsonlFiles) {
    const rawCwd = await readCwdFromSessionFile(join(sessionDir, file));
    if (!rawCwd) continue;
    const cwd = mapCwd(rawCwd);
    try {
      const s = await stat(cwd);
      if (s.isDirectory()) return cwd;
    } catch {
      // try the next jsonl
    }
  }
  return null;
}

/**
 * Recover the real cwd for a project whose `projectPath` may be stale.
 *
 * Like {@link resolveResumeCwd} but doesn't require a sessionId — used by the
 * "start new session in project" path where there's no session yet. Returns
 * the recovered cwd, or null if `projectPath` is already healthy / nothing
 * could be recovered.
 */
export async function resolveStartCwd(
  projectPath: string,
  sessionDir: string,
  mapCwd: (cwd: string) => string = (cwd) => cwd,
): Promise<string | null> {
  try {
    const s = await stat(projectPath);
    if (s.isDirectory()) return null;
  } catch {
    // fall through to recovery
  }

  const recovered = await recoverCwdFromSessionDir(sessionDir, mapCwd);
  return recovered ?? null;
}

/**
 * Determine the file type from a relative path within ~/.claude.
 *
 * @param relativePath - Path relative to ~/.claude (e.g., "projects/xxx/session.jsonl")
 */
export function getFileTypeFromRelativePath(
  relativePath: string,
):
  | "session"
  | "agent-session"
  | "settings"
  | "credentials"
  | "telemetry"
  | "other" {
  // Session files: projects/<encoded-path>/<session-id>.jsonl
  if (
    (relativePath.includes("projects/") ||
      relativePath.includes("projects\\")) &&
    relativePath.endsWith(".jsonl")
  ) {
    const filename = basename(relativePath);
    if (filename.startsWith("agent-")) {
      return "agent-session";
    }
    return "session";
  }

  // Settings file
  if (relativePath === "settings.json") {
    return "settings";
  }

  // Credentials
  if (
    relativePath === "credentials.json" ||
    relativePath.includes("credentials")
  ) {
    return "credentials";
  }

  // Telemetry (statsig, analytics)
  if (
    relativePath.startsWith("statsig/") ||
    relativePath.startsWith("statsig\\")
  ) {
    return "telemetry";
  }

  return "other";
}

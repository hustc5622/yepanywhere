import { posix, win32 } from "node:path";

export const CODEX_HIDDEN_PATH = "[path hidden]";

export interface CodexPublicPathOptions {
  /** Trusted workspace root for converting provider absolute paths to public relative paths. */
  workspaceRoot?: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || isAbsolutePath(value)) return false;
  return !normalizeSeparators(value)
    .split("/")
    .some((component) => component === "..");
}

/**
 * Convert an absolute provider path to a workspace-relative public path.
 * This is lexical only: it grants no file access and never follows symlinks.
 */
export function codexWorkspaceRelativePath(
  value: string,
  workspaceRoot: string | undefined,
): string | undefined {
  const target = value.trim();
  const root = workspaceRoot?.trim();
  if (!target || !root || target.includes("\0") || root.includes("\0")) {
    return undefined;
  }

  const targetIsWindows = WINDOWS_ABSOLUTE_PATH_PATTERN.test(target);
  const rootIsWindows = WINDOWS_ABSOLUTE_PATH_PATTERN.test(root);
  let relativePath: string;

  if (targetIsWindows || rootIsWindows) {
    if (!targetIsWindows || !rootIsWindows) return undefined;
    relativePath = normalizeSeparators(
      win32.relative(win32.resolve(root), win32.resolve(target)),
    );
  } else {
    const normalizedTarget = normalizeSeparators(target);
    const normalizedRoot = normalizeSeparators(root);
    if (
      !posix.isAbsolute(normalizedTarget) ||
      !posix.isAbsolute(normalizedRoot)
    ) {
      return undefined;
    }
    relativePath = posix.relative(
      posix.resolve(normalizedRoot),
      posix.resolve(normalizedTarget),
    );
  }

  if (relativePath === "") return ".";
  return isSafeRelativePath(relativePath) ? relativePath : undefined;
}

/**
 * Project a provider path across the public transcript boundary.
 * Safe relative paths survive; absolute paths only survive after bounded
 * conversion under the trusted workspace root.
 */
export function publicCodexFilePath(
  value: string,
  options: CodexPublicPathOptions = {},
): string {
  const trimmed = value.trim();
  const normalized = normalizeSeparators(trimmed);
  if (
    !normalized ||
    normalized.includes("\0") ||
    /^file:\/\//i.test(normalized)
  ) {
    return CODEX_HIDDEN_PATH;
  }

  if (isAbsolutePath(trimmed)) {
    return (
      codexWorkspaceRelativePath(trimmed, options.workspaceRoot)?.slice(
        0,
        2_048,
      ) ?? CODEX_HIDDEN_PATH
    );
  }

  return isSafeRelativePath(normalized)
    ? normalized.slice(0, 2_048)
    : CODEX_HIDDEN_PATH;
}

/** Replace filesystem references embedded in public tool text/diffs. */
export function publicCodexTextPaths(
  value: string,
  options: CodexPublicPathOptions = {},
): string {
  return value
    .replace(/file:\/\/\/[^\s]+/gi, CODEX_HIDDEN_PATH)
    .replace(
      /(^|[\s([{\"'`=])(\/(?:[^/\s]+\/)*[^/\s)\]}\"'`,;]+)/gm,
      (_match, prefix: string, path: string) =>
        `${prefix}${publicCodexFilePath(path, options)}`,
    )
    .replace(
      /(^|[\s([{\"'`=])([A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*)/gm,
      (_match, prefix: string, path: string) =>
        `${prefix}${publicCodexFilePath(path, options)}`,
    );
}

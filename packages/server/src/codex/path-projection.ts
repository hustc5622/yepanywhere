import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export const CODEX_HIDDEN_PATH = "[path hidden]";

export interface CodexPublicPathOptions {
  /** Compatibility context for callers; display paths remain plaintext. */
  workspaceRoot?: string;
}

export function codexFilePathFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function isCodexPathFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{16}$/.test(value);
}

export function hiddenCodexFilePath(fingerprint: unknown): string {
  return isCodexPathFingerprint(fingerprint)
    ? `[path hidden:${fingerprint.slice(7)}]`
    : CODEX_HIDDEN_PATH;
}

export function isHiddenCodexFilePath(value: string): boolean {
  return /^\[path hidden(?::[a-f0-9]{16})?\]$/.test(value);
}

/** Recognize only labels written by older builds, for exact fingerprint recovery. */
export function isLegacyMaskedCodexFilePath(value: string): boolean {
  return (
    isHiddenCodexFilePath(value) ||
    /^\[(?:tmp|home|external):[a-f0-9]{16}\]\//.test(value)
  );
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

/** Keep the original display path. This never grants filesystem access. */
export function publicCodexFilePath(
  value: string,
  _options: CodexPublicPathOptions = {},
): string {
  return value.slice(0, 2_048);
}

/** Plaintext display shared by live, persisted and historical file changes. */
export function publicCodexFileChangePath(
  value: string,
  options: CodexPublicPathOptions = {},
): string {
  return publicCodexFilePath(value, options);
}

/** Compatibility entry point: tool text and patch headings stay verbatim. */
export function publicCodexTextPaths(
  value: string,
  _options: CodexPublicPathOptions & { fileChangePaths?: boolean } = {},
): string {
  return value;
}

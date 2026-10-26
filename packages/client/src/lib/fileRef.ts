/**
 * Client-side reference to a file shown in the side preview.
 *
 * Every entry point (assistant prose, tool calls, inspector, …) builds a
 * `FileRef` and hands it to `useFilePreview().openFile`. The preview fetches
 * through `/api/fs/*`, which accepts any absolute path, so callers no longer
 * need to decide between "project file" and "local file" viewers.
 */
import { parseLineColumn } from "@yep-anywhere/shared";
import { API_BASE, appPath } from "./apiPath";

export interface FileRef {
  /** Absolute path, or a path relative to `projectId`'s root. */
  path: string;
  /** Needed only to resolve a relative `path`. */
  projectId?: string;
  lineNumber?: number;
  lineEnd?: number;
  /**
   * Set when `path` was built from a relative path seen in a session: the
   * path as written and the directory it was resolved against. Lets the
   * viewer explain a miss and offer to look in other projects.
   */
  relative?: { path: string; baseDir: string };
}

/**
 * Content a tool reported when it read the file. Shown alongside the current
 * file, and instead of it when the file can no longer be read.
 */
export type FileSnapshot =
  | {
      kind: "text";
      content: string;
      startLine: number;
      totalLines?: number;
      highlightedHtml?: string;
      highlightedTruncated?: boolean;
      renderedMarkdownHtml?: string;
    }
  | { kind: "image"; src: string };

export interface SessionPathContext {
  projectId?: string | null;
  projectPath?: string | null;
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

/** Collapse `.`/`..` segments; relative paths keep leading `..`. */
export function normalizeFilePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/**
 * Build a `FileRef` for a path seen in a session. Relative paths are made
 * absolute against the session's project when its path is known; otherwise
 * the project id is kept so the server can resolve them.
 */
export function fileRefFromPath(
  rawPath: string,
  context: SessionPathContext | null | undefined,
  location: { lineNumber?: number; lineEnd?: number } = {},
): FileRef {
  const trimmed = rawPath.trim();
  const projectPath = context?.projectPath?.replace(/\/+$/, "");
  let path = trimmed;
  let relative: FileRef["relative"];
  if (!isAbsoluteFilePath(trimmed) && projectPath) {
    path = `${projectPath}/${trimmed}`;
    const written = normalizeFilePath(trimmed);
    // `../x` already names a place outside the base; nothing to look up.
    if (written && !written.startsWith("..")) {
      relative = { path: written, baseDir: projectPath };
    }
  }
  path = normalizeFilePath(path);
  const ref: FileRef = { path, ...location, ...(relative && { relative }) };
  if (!isAbsoluteFilePath(path) && context?.projectId) {
    ref.projectId = context.projectId;
  }
  return ref;
}

/** Parse an optional `:line[:column]` suffix into a `FileRef`. */
export function fileRefFromPathWithLocation(
  rawPath: string,
  context: SessionPathContext | null | undefined,
): FileRef {
  const parsed = parseLineColumn(rawPath.trim());
  return fileRefFromPath(parsed.path, context, {
    lineNumber: parsed.line,
  });
}

function fsQuery(ref: FileRef): URLSearchParams {
  const params = new URLSearchParams({ path: ref.path });
  if (ref.projectId) params.set("projectId", ref.projectId);
  return params;
}

/** Browser-loadable URL for a file's bytes (img/video/iframe src, downloads). */
export function fileRawUrl(ref: FileRef, download = false): string {
  const params = fsQuery(ref);
  if (download) params.set("download", "true");
  return `${API_BASE}/fs/raw?${params.toString()}`;
}

/** API path (without base) for the preview JSON. */
export function filePreviewApiPath(ref: FileRef, highlight: boolean): string {
  const params = fsQuery(ref);
  if (highlight) params.set("highlight", "true");
  return `/fs/preview?${params.toString()}`;
}

/** Router path of the standalone file page. */
export function filePageRoute(ref: FileRef): string {
  const params = fsQuery(ref);
  if (ref.lineNumber !== undefined) params.set("line", String(ref.lineNumber));
  return `/file?${params.toString()}`;
}

/** Browser URL of the standalone file page (used for "open in new tab"). */
export function filePageUrl(ref: FileRef): string {
  return appPath(filePageRoute(ref));
}

export function getFileRefName(ref: FileRef): string {
  return ref.path.split("/").pop() || ref.path;
}

export function sameFileRef(a: FileRef, b: FileRef): boolean {
  return (
    a.path === b.path &&
    a.projectId === b.projectId &&
    a.lineNumber === b.lineNumber &&
    a.lineEnd === b.lineEnd
  );
}

/** Target of a server-rendered `.local-file-link` / `.local-media-link`. */
export function extractFileLinkTarget(
  anchor: HTMLAnchorElement,
): { path: string; lineNumber?: number } | null {
  const datasetPath = anchor.dataset.filePath;
  if (datasetPath) {
    const line = Number.parseInt(anchor.dataset.line ?? "", 10);
    return {
      path: datasetPath,
      lineNumber: Number.isFinite(line) ? line : undefined,
    };
  }
  const href = anchor.getAttribute("href");
  if (!href) return null;
  try {
    const url = new URL(href, "http://localhost");
    const isLocalFile = url.pathname.endsWith("/api/local-file");
    const isLocalMedia = url.pathname.endsWith("/api/local-image");
    const isFsRaw = url.pathname.endsWith("/api/fs/raw");
    if (!isLocalFile && !isLocalMedia && !isFsRaw) return null;
    const path = url.searchParams.get("path");
    if (!path) return null;
    if (isLocalMedia) {
      const parsed = parseLineColumn(path);
      return { path: parsed.path, lineNumber: parsed.line };
    }
    const line = Number.parseInt(url.searchParams.get("line") ?? "", 10);
    return { path, lineNumber: Number.isFinite(line) ? line : undefined };
  } catch {
    return null;
  }
}

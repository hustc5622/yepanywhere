/**
 * File preview core shared by every file-serving route.
 *
 * `/api/fs/*`, `/api/projects/:id/files*`, `/api/local-file` and
 * `/api/local-image` differ only in how they turn a request into an absolute
 * path and which file types they accept. Reading, metadata, highlighting,
 * markdown rendering and raw byte streaming all live here so the routes stay
 * thin and behave identically.
 *
 * Access policy: any path the server can read (see
 * `docs/project/file-preview-unification.md`); authentication is enforced by
 * the global API middleware, not here.
 */

import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  type FilePreviewResponse,
  classifyPreview,
  getFileExtension,
  getFileMimeType,
  getPathBasename,
  isMarkdownFilePath,
  isTextFilePath,
  parseLineColumn,
} from "@yep-anywhere/shared";
import { renderMarkdownDocumentToHtml } from "../augments/markdown-augments.js";
import { highlightFile } from "../highlighting/index.js";
import {
  MAX_OFFICE_FILE_BYTES,
  OfficePreviewError,
  convertOfficeDocument,
  isConvertibleOfficeExtension,
} from "./office.js";

/** Maximum size of text content returned inline (1 MB). */
export const MAX_INLINE_TEXT_BYTES = 1024 * 1024;

export class FilePreviewError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 415 | 500,
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
  }

  toJSON(): Record<string, string> {
    return { error: this.message, ...this.details };
  }
}

export interface ResolvedPreviewPath {
  /** Absolute path (not symlink-resolved) used for display and reading. */
  absolutePath: string;
  line?: number;
  column?: number;
}

/**
 * Resolve a requested path. Absolute paths are used as-is; relative paths are
 * resolved against `baseDir` (typically the project root). A `:line[:col]`
 * suffix is stripped unless a file with the literal name exists.
 */
export async function resolvePreviewPath(
  rawPath: string,
  baseDir?: string,
): Promise<ResolvedPreviewPath> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new FilePreviewError(400, "Missing path parameter");

  const toAbsolute = (path: string): string => {
    if (isAbsolute(path)) return resolve(path);
    if (!baseDir) {
      throw new FilePreviewError(
        400,
        "Relative paths require a project context",
      );
    }
    return resolve(baseDir, path);
  };

  const literal = toAbsolute(trimmed);
  const parsed = parseLineColumn(trimmed);
  if (parsed.line === undefined) return { absolutePath: literal };
  if (await pathExists(literal)) return { absolutePath: literal };
  return {
    absolutePath: toAbsolute(parsed.path),
    line: parsed.line,
    column: parsed.column,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface PreviewFile {
  absolutePath: string;
  /** Symlink-resolved path actually read from disk. */
  realPath: string;
  stats: Stats;
}

/** Stat a path and require a regular file. */
export async function openPreviewFile(
  absolutePath: string,
  displayPath: string = absolutePath,
): Promise<PreviewFile> {
  const details = { path: displayPath, absolutePath };
  let realPath: string;
  let stats: Stats;
  try {
    realPath = await realpath(absolutePath);
    stats = await stat(realPath);
  } catch {
    throw new FilePreviewError(404, "File not found", details);
  }
  if (!stats.isFile()) {
    throw new FilePreviewError(400, "Path is not a file", details);
  }
  return { absolutePath, realPath, stats };
}

export interface BuildPreviewOptions {
  /** Path reported back as `metadata.path` (project-relative or absolute). */
  displayPath: string;
  rawUrl: string;
  /** Add shiki highlighting for text files. */
  highlight?: boolean;
  /** Render markdown files to HTML (defaults to `highlight`). */
  renderMarkdown?: boolean;
}

/** Metadata plus inline content/highlighting for a regular file. */
export async function buildFilePreview(
  file: PreviewFile,
  options: BuildPreviewOptions,
): Promise<FilePreviewResponse> {
  const response = await buildBasePreview(file, options);
  if (response.kind === "office") await addOfficePreview(file, response);
  return response;
}

async function addOfficePreview(
  file: PreviewFile,
  response: FilePreviewResponse,
): Promise<void> {
  const ext = getFileExtension(file.absolutePath);
  if (!isConvertibleOfficeExtension(ext)) return;
  if (file.stats.size > MAX_OFFICE_FILE_BYTES) {
    response.officeError = "Document is too large to preview";
    return;
  }
  try {
    response.office = convertOfficeDocument(await readFile(file.realPath), ext);
  } catch (error) {
    response.officeError =
      error instanceof OfficePreviewError
        ? error.message
        : "Document could not be converted";
  }
}

async function buildBasePreview(
  file: PreviewFile,
  options: BuildPreviewOptions,
): Promise<FilePreviewResponse> {
  const { absolutePath, realPath, stats } = file;
  const isText = isTextFilePath(absolutePath);
  const mimeType = getFileMimeType(absolutePath);
  const response: FilePreviewResponse = {
    kind: classifyPreview(absolutePath, mimeType),
    metadata: {
      path: options.displayPath,
      absolutePath,
      size: stats.size,
      mimeType,
      isText,
    },
    rawUrl: options.rawUrl,
  };

  if (!isText || stats.size > MAX_INLINE_TEXT_BYTES) return response;

  let content: string;
  try {
    content = await readFile(realPath, "utf-8");
  } catch {
    return response;
  }
  response.content = content;

  if (options.highlight) {
    const highlighted = await highlightFile(content, absolutePath);
    if (highlighted) {
      response.highlightedHtml = highlighted.html;
      response.highlightedLanguage = highlighted.language;
      response.highlightedTruncated = highlighted.truncated;
    }
  }
  if (
    (options.renderMarkdown ?? options.highlight) &&
    isMarkdownFilePath(absolutePath)
  ) {
    try {
      response.renderedMarkdownHtml =
        await renderMarkdownDocumentToHtml(content);
    } catch {
      // Plain text still renders if markdown rendering fails.
    }
  }
  return response;
}

/** Types a browser would execute when opened directly from our origin. */
function isActiveContent(mimeType: string): boolean {
  return (
    mimeType === "text/html" ||
    mimeType === "image/svg+xml" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml")
  );
}

function contentDispositionName(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export interface RawFileOptions {
  mimeType?: string;
  download?: boolean;
  cacheControl?: string;
  /** Request `Range` header for partial content (video seeking, PDF). */
  range?: string | null;
}

/**
 * Stream a file's bytes. Supports a single `bytes=` range. Active content
 * (HTML/SVG/XML) is sandboxed so opening a raw URL cannot run scripts on the
 * Yep origin.
 */
export function rawFileResponse(
  file: PreviewFile,
  options: RawFileOptions = {},
): Response {
  const { realPath, absolutePath, stats } = file;
  const mimeType = options.mimeType ?? getFileMimeType(absolutePath);
  const fileName = getPathBasename(absolutePath) || "file";
  const headers = new Headers({
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${options.download ? "attachment" : "inline"}; ${contentDispositionName(fileName)}`,
  });
  if (options.cacheControl) headers.set("Cache-Control", options.cacheControl);
  if (isActiveContent(mimeType)) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    );
  }

  const size = stats.size;
  const range = parseRange(options.range, size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  headers.set("Content-Length", String(size === 0 ? 0 : end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const body =
    size === 0
      ? null
      : (Readable.toWeb(
          createReadStream(realPath, { start, end }),
        ) as ReadableStream<Uint8Array>);
  return new Response(body, { status: range ? 206 : 200, headers });
}

function parseRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText = "", endText = ""] = match;
  if (!startText && !endText) return null;
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

import { readFile, realpath, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parseLineColumn } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { renderMarkdownDocumentToHtml } from "../augments/markdown-augments.js";

interface LocalFileDeps {
  maxInlineSizeBytes?: number;
}

const MAX_INLINE_SIZE = 1024 * 1024;

const TEXT_FILE_MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
};

function isMarkdownPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

/**
 * Serve small local text files readable by the server, regardless of project
 * or session. This route uses the application's normal API authentication.
 *
 * Supports .md/.markdown/.txt files at absolute paths and refuses large files.
 */
export function createLocalFileRoutes(deps: LocalFileDeps = {}) {
  const routes = new Hono();
  const maxInlineSizeBytes = deps.maxInlineSizeBytes ?? MAX_INLINE_SIZE;

  routes.get("/", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    const parsed = parseLineColumn(rawPath);
    const filePath = parsed.path;
    if (!filePath.startsWith("/")) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    const mimeType = TEXT_FILE_MIME_TYPES[extname(filePath).toLowerCase()];
    if (!mimeType) {
      return c.json({ error: "Not a supported local text file type" }, 400);
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    const stats = await stat(resolvedPath);
    if (!stats.isFile()) {
      return c.json({ error: "Not a file" }, 404);
    }

    if (stats.size > maxInlineSizeBytes) {
      return c.json({ error: "File too large" }, 413);
    }

    let content: string;
    try {
      content = await readFile(resolvedPath, "utf-8");
    } catch {
      return c.json({ error: "Failed to read file" }, 500);
    }

    let renderedMarkdownHtml: string | undefined;
    if (isMarkdownPath(resolvedPath)) {
      try {
        renderedMarkdownHtml = await renderMarkdownDocumentToHtml(content);
      } catch {
        // Plain text still renders if markdown rendering fails.
      }
    }

    return c.json({
      metadata: {
        path: filePath,
        size: stats.size,
        mimeType,
        isText: true,
      },
      content,
      rawUrl: `/api/local-file?path=${encodeURIComponent(filePath)}`,
      renderedMarkdownHtml,
      lineNumber: parsed.line,
      columnNumber: parsed.column,
    });
  });

  return routes;
}

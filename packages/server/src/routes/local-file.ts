import { isTextFilePath } from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  FilePreviewError,
  MAX_INLINE_TEXT_BYTES,
  buildFilePreview,
  openPreviewFile,
  resolvePreviewPath,
} from "../file-preview/index.js";

interface LocalFileDeps {
  maxInlineSizeBytes?: number;
}

/**
 * Serve small local text files readable by the server, regardless of project
 * or session. This route uses the application's normal API authentication.
 *
 * Kept for URLs embedded in rendered markdown (`.local-file-link`); new code
 * should use `/api/fs/preview`. Accepts every text type in the shared
 * file-type table at absolute paths and refuses large files.
 */
export function createLocalFileRoutes(deps: LocalFileDeps = {}) {
  const routes = new Hono();
  const maxInlineSizeBytes = deps.maxInlineSizeBytes ?? MAX_INLINE_TEXT_BYTES;

  routes.get("/", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    try {
      if (!rawPath.trim().startsWith("/")) {
        return c.json({ error: "Path must be absolute" }, 400);
      }
      const resolved = await resolvePreviewPath(rawPath);
      const filePath = resolved.absolutePath;
      if (!isTextFilePath(filePath)) {
        return c.json({ error: "Not a supported local text file type" }, 400);
      }

      let file: Awaited<ReturnType<typeof openPreviewFile>>;
      try {
        file = await openPreviewFile(filePath);
      } catch (error) {
        if (error instanceof FilePreviewError && error.status === 400) {
          return c.json({ error: "Not a file" }, 404);
        }
        return c.json({ error: "File not found" }, 404);
      }
      if (file.stats.size > maxInlineSizeBytes) {
        return c.json({ error: "File too large" }, 413);
      }

      const preview = await buildFilePreview(file, {
        displayPath: filePath,
        rawUrl: `/api/fs/raw?path=${encodeURIComponent(filePath)}`,
        renderMarkdown: true,
      });
      if (preview.content === undefined) {
        return c.json({ error: "Failed to read file" }, 500);
      }

      return c.json({
        ...preview,
        lineNumber: resolved.line,
        columnNumber: resolved.column,
      });
    } catch (error) {
      if (error instanceof FilePreviewError) {
        return c.json(error.toJSON(), error.status);
      }
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return routes;
}

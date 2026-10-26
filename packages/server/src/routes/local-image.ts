import { type FileHandle, open } from "node:fs/promises";
import {
  getFileExtension,
  getFileMimeType,
  getMediaPreviewKind,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  FilePreviewError,
  type PreviewFile,
  openPreviewFile,
  rawFileResponse,
} from "../file-preview/index.js";

/**
 * Create routes for serving local images and videos.
 *
 * Any absolute path the server can read is allowed (the same policy as
 * `/api/fs/*`); access is gated by the normal API authentication. Kept for
 * `.local-media-link` URLs in rendered markdown; byte streaming (including
 * `Range` for video seeking) is shared with `/api/fs/raw`. The
 * route only checks that the target is a regular file of a recognized media
 * type, so it cannot be used to stream arbitrary text or binaries.
 */
export function createLocalImageRoutes() {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }
    if (!filePath.startsWith("/")) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    // Extensionless files (e.g. content-addressed blobs) are sniffed below.
    const ext = getFileExtension(filePath);
    let contentType = getMediaPreviewKind(filePath)
      ? getFileMimeType(filePath)
      : undefined;
    if (ext && !contentType) {
      return c.json({ error: "Not a recognized media type" }, 400);
    }

    let file: PreviewFile;
    try {
      file = await openPreviewFile(filePath);
    } catch (error) {
      if (error instanceof FilePreviewError && error.status === 400) {
        return c.json({ error: "Not a file" }, 404);
      }
      return c.json({ error: "File not found" }, 404);
    }

    // Only serve extensionless files whose bytes really are a known image.
    if (!contentType) {
      contentType = await sniffImageContentType(file.realPath);
      if (!contentType) {
        return c.json({ error: "Not a recognized media type" }, 400);
      }
    }

    return rawFileResponse(file, {
      mimeType: contentType,
      cacheControl: "private, no-store",
      range: c.req.header("range"),
    });
  });

  return routes;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Detect an image content type from the file's leading bytes. */
async function sniffImageContentType(
  path: string,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.length < 4) return undefined;

    if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return "image/png";
    }
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return "image/jpeg";
    }
    if (head.subarray(0, 3).toString("ascii") === "GIF") {
      return "image/gif";
    }
    if (
      head.length >= 12 &&
      head.subarray(0, 4).toString("ascii") === "RIFF" &&
      head.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
    if (head[0] === 0x42 && head[1] === 0x4d) {
      return "image/bmp";
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

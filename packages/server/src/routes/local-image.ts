import { createReadStream } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { Hono } from "hono";
import { stream } from "hono/streaming";

interface LocalImageDeps {
  allowedPaths: string[];
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
  svg: "image/svg+xml",
  // Video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
};

/**
 * Create routes for serving local images from allowed paths.
 *
 * Security: Only serves files that:
 * 1. Resolve (after symlink resolution) to a path under an allowed prefix
 * 2. Have a recognized image or video extension
 * 3. Are regular files (not directories, devices, etc.)
 */
export function createLocalImageRoutes(deps: LocalImageDeps) {
  const routes = new Hono();

  // Resolve allowed paths at startup so symlinks like /tmp -> /private/tmp work
  let resolvedAllowedPaths: string[] | null = null;
  async function getAllowedPaths(): Promise<string[]> {
    if (!resolvedAllowedPaths) {
      resolvedAllowedPaths = await Promise.all(
        deps.allowedPaths
          .filter((p) => p.trim().length > 0)
          .map(async (p) => {
            try {
              return await realpath(p);
            } catch {
              return p;
            }
          }),
      );
    }
    return resolvedAllowedPaths;
  }

  routes.get("/", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    // Must be an absolute path
    if (!filePath.startsWith("/")) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    // Check file extension. Extensionless files (Kimi stores prompt images
    // content-addressed as `blobs/<sha256>`) are sniffed below instead.
    const name = filePath.split("/").pop() ?? "";
    const ext = name.includes(".")
      ? (name.split(".").pop()?.toLowerCase() ?? "")
      : "";
    let contentType = ext ? MEDIA_EXTENSIONS[ext] : undefined;
    if (ext && !contentType) {
      return c.json({ error: "Not a recognized media type" }, 400);
    }

    // Resolve symlinks to get the real path
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    // Check resolved path against resolved allowed prefixes
    const allowed = await getAllowedPaths();
    const isAllowed = allowed.some((prefix) =>
      resolvedPath.startsWith(`${prefix}/`),
    );
    if (!isAllowed) {
      return c.json({ error: "Path not in allowed directories" }, 403);
    }

    try {
      const stats = await stat(resolvedPath);
      if (!stats.isFile()) {
        return c.json({ error: "Not a file" }, 404);
      }

      // Sniff extensionless files — only serve them if the bytes really are a
      // known image format, which is a stronger check than trusting a suffix.
      if (!contentType) {
        contentType = await sniffImageContentType(resolvedPath);
        if (!contentType) {
          return c.json({ error: "Not a recognized media type" }, 400);
        }
      }

      c.header("Content-Type", contentType);
      c.header("Content-Length", stats.size.toString());
      c.header("Cache-Control", "private, max-age=3600");

      return stream(c, async (s) => {
        const readable = createReadStream(resolvedPath);
        for await (const chunk of readable) {
          await s.write(chunk);
        }
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "File not found" }, 404);
      }
      console.error("[LocalImage] Error serving file:", err);
      return c.json({ error: "Internal error" }, 500);
    }
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

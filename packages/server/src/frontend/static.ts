/**
 * Static file serving for production mode.
 *
 * In production, we serve the built Vite output directly from the backend.
 * This provides a single-port deployment without needing a separate web server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";

export interface StaticServeOptions {
  /** Path to the built client dist directory */
  distPath: string;
  /** Optional base path prefix to strip from requests (e.g., "/_stable") */
  basePath?: string;
}

const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATED_ASSET_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const STATIC_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".map",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]);

function isExplicitStaticRequest(reqPath: string): boolean {
  return (
    reqPath.startsWith("/assets/") ||
    STATIC_EXTENSIONS.has(path.extname(reqPath).toLowerCase())
  );
}

function acceptsHtml(accept: string | undefined): boolean {
  return accept?.toLowerCase().includes("text/html") ?? false;
}

/**
 * Create Hono routes for serving static files.
 *
 * This serves:
 * - Static assets (JS, CSS, images) with appropriate headers
 * - index.html for all other routes (SPA fallback)
 */
export function createStaticRoutes(options: StaticServeOptions): Hono {
  const { distPath, basePath } = options;
  const app = new Hono();

  // Check if dist directory exists
  if (!fs.existsSync(distPath)) {
    console.warn(
      `[Static] Warning: dist directory not found at ${distPath}. Run 'pnpm build' first.`,
    );
  }

  // Path to index.html for SPA fallback (read fresh each request to pick up rebuilds)
  const indexPath = path.join(distPath, "index.html");

  // Serve static files
  app.get("*", async (c) => {
    let reqPath = c.req.path;

    // Strip base path prefix if configured (e.g., "/_stable" -> "")
    if (basePath && reqPath.startsWith(basePath)) {
      reqPath = reqPath.slice(basePath.length) || "/";
    }

    // Try to serve the exact file
    const filePath = path.join(distPath, reqPath);

    // Security: ensure we're not escaping the dist directory
    const normalizedFilePath = path.normalize(filePath);
    if (!normalizedFilePath.startsWith(distPath)) {
      return c.text("Forbidden", 403);
    }

    try {
      const stat = await fs.promises.stat(filePath);

      if (stat.isFile()) {
        const content = await fs.promises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const contentType = getContentType(ext);

        const isImmutableAsset = isHashedAsset(reqPath);
        const cacheControl = isImmutableAsset
          ? IMMUTABLE_ASSET_CACHE_CONTROL
          : REVALIDATED_ASSET_CACHE_CONTROL;

        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Cache-Control": cacheControl,
        };

        if (isImmutableAsset) {
          headers["CDN-Cache-Control"] = IMMUTABLE_ASSET_CACHE_CONTROL;
          headers["Cloudflare-CDN-Cache-Control"] =
            IMMUTABLE_ASSET_CACHE_CONTROL;
        }

        // Add CSP frame-ancestors for HTML files (must be HTTP header, not meta tag)
        if (ext === ".html") {
          headers["Content-Security-Policy"] =
            "frame-ancestors 'self' tauri://localhost https://tauri.localhost";
        }

        return c.body(content, 200, headers);
      }
      // Not a file (e.g., directory), fall through to SPA fallback
    } catch (err) {
      // Only fall through to SPA for missing files, not for other errors
      const isNotFound =
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) {
        console.error(`[Static] Error serving ${filePath}:`, err);
      }
    }

    if (
      reqPath === "/api" ||
      reqPath.startsWith("/api/") ||
      isExplicitStaticRequest(reqPath) ||
      !acceptsHtml(c.req.header("accept"))
    ) {
      return c.text("Not found", 404, { "Cache-Control": "no-store" });
    }

    // SPA fallback: serve index.html for all other routes
    // Read fresh each time to pick up rebuilds without server restart
    try {
      const indexHtml = await fs.promises.readFile(indexPath, "utf-8");
      return c.html(indexHtml, 200, {
        // frame-ancestors must be set via HTTP header (not meta tag)
        "Content-Security-Policy":
          "frame-ancestors 'self' tauri://localhost https://tauri.localhost",
        // Don't cache index.html (hashed asset paths change on rebuild)
        "Cache-Control": "no-cache",
      });
    } catch {
      return c.text(
        "Not found. Did you run 'pnpm build' to build the client?",
        404,
      );
    }
  });

  return app;
}

/**
 * Get content type for a file extension.
 */
function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".map": "application/json",
  };

  return types[ext] || "application/octet-stream";
}

/**
 * Check if a path is a hashed asset (can be cached forever).
 * Vite adds hashes to filenames like: index-abc123.js
 */
function isHashedAsset(reqPath: string): boolean {
  // Vite uses base64url-ish hashes, e.g. index-CREDb_As.js.
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(reqPath);
}

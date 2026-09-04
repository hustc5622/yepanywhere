/**
 * Static file serving for production mode.
 *
 * In production, we serve the built Vite output directly from the backend.
 * This provides a single-port deployment without needing a separate web server.
 *
 * Remote/tunnelled access is the constraint that shapes this module. The
 * measured first-load payload is 1.65 MB raw and 430 KB gzipped (3.84:1; the
 * Tailwind CSS bundle alone compresses 6.9:1), and on a frp tunnel that
 * difference is several seconds of blank screen plus head-of-line blocking on
 * the shared TCP connection that also carries the live WebSocket. So this
 * module negotiates content coding and answers conditional requests instead of
 * always shipping raw bytes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { constants as zlibConstants } from "node:zlib";
import { Hono } from "hono";

const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);

export interface StaticServeOptions {
  /** Path to the built client dist directory */
  distPath: string;
  /** Optional base path prefix to strip from requests (e.g., "/_stable") */
  basePath?: string;
}

const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATED_ASSET_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/**
 * Extensions worth compressing. Everything else here is already compressed
 * (png/jpg/woff2/ico) and would only burn CPU for a few bytes.
 */
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

/**
 * Smallest response worth compressing, matching the `/api/*` threshold in
 * `app.ts`. Below roughly a packet's worth of payload the framing and CPU cost
 * outweigh the saving.
 */
const COMPRESSION_MIN_BYTES = 1024;

/**
 * Compression settings for the on-demand path.
 *
 * These are deliberately *fast*, not maximal: the first request for an asset
 * pays this cost inline. Brotli quality 5 lands within ~5% of quality 11 on our
 * bundles while running roughly an order of magnitude faster, and a build-time
 * precompression step (see `preferPrecompressed` below) is what produces
 * maximal artifacts when it is available.
 */
const GZIP_LEVEL = 6;
const BROTLI_QUALITY = 5;

/**
 * Byte budget for the in-memory compressed/raw asset cache.
 *
 * Hashed Vite assets are immutable, so caching them by `mtime+size` is safe and
 * removes both the per-request `readFile` (the largest chunk is 448 KB) and the
 * repeated compression work. The cap keeps a pathological dist directory from
 * pinning unbounded memory in a process that already runs >1 GiB RSS.
 */
const ASSET_CACHE_MAX_BYTES = 48 * 1024 * 1024;

type ContentEncoding = "br" | "gzip" | "identity";

interface CachedRepresentation {
  body: Uint8Array<ArrayBuffer>;
  encoding: ContentEncoding;
}

/**
 * Re-view a Node `Buffer` as a plain `Uint8Array` over a concrete `ArrayBuffer`.
 *
 * `Buffer` instances from `readFile`/`zlib` are backed by `ArrayBufferLike`,
 * which the web `Response` body type does not accept. This is a zero-copy view,
 * bounded to the buffer's own region so pooled allocations stay correct.
 */
function asResponseBody(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    buffer.buffer as ArrayBuffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
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

  const cache = new RepresentationCache(ASSET_CACHE_MAX_BYTES);

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
        const ext = path.extname(filePath).toLowerCase();
        const contentType = getContentType(ext);

        const isImmutableAsset = isHashedAsset(reqPath);
        const cacheControl = isImmutableAsset
          ? IMMUTABLE_ASSET_CACHE_CONTROL
          : REVALIDATED_ASSET_CACHE_CONTROL;

        const acceptEncoding = c.req.header("accept-encoding") ?? "";
        const representation = await loadRepresentation({
          filePath,
          ext,
          stat,
          acceptEncoding,
          cache,
        });

        // A representation is identified by both its bytes and its coding, so
        // the encoding has to participate in the validator (RFC 9110 §8.8.1).
        // Otherwise a shared cache can hand a brotli body to a client that only
        // speaks gzip.
        const etag = buildFileETag(stat, representation.encoding);

        const headers: Record<string, string> = {
          "Cache-Control": cacheControl,
          ETag: etag,
          // Always advertise the negotiation axis, even for identity responses:
          // an intermediary may have cached the identity form for a client that
          // did not send `Accept-Encoding`.
          Vary: "Accept-Encoding",
        };

        if (isImmutableAsset) {
          headers["CDN-Cache-Control"] = IMMUTABLE_ASSET_CACHE_CONTROL;
          headers["Cloudflare-CDN-Cache-Control"] =
            IMMUTABLE_ASSET_CACHE_CONTROL;
        }

        // Add CSP frame-ancestors for HTML files (must be HTTP header, not meta tag)
        if (ext === ".html") {
          headers["Content-Security-Policy"] = HTML_CSP;
        }

        if (isNotModified(c.req.header("if-none-match"), etag)) {
          // A 304 carries no body, so it must not describe one: no
          // `Content-Type` and no `Content-Encoding`.
          return c.body(null, 304, headers);
        }

        return c.body(representation.body, 200, {
          ...headers,
          "Content-Type": contentType,
          ...(representation.encoding !== "identity"
            ? { "Content-Encoding": representation.encoding }
            : {}),
        });
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

    // SPA fallback: serve index.html for all other routes
    // Read fresh each time to pick up rebuilds without server restart
    try {
      const indexHtml = await fs.promises.readFile(indexPath);
      // The shell is revalidated on every navigation (hashed asset URLs change
      // on rebuild, so it must never be served stale). A validator turns that
      // mandatory revalidation into a 304 instead of a full re-transfer, which
      // is what `public/sw.js` already assumes when it fetches navigations with
      // `cache: "no-cache"`.
      const etag = buildContentETag(indexHtml);
      const headers: Record<string, string> = {
        // frame-ancestors must be set via HTTP header (not meta tag)
        "Content-Security-Policy": HTML_CSP,
        // Don't cache index.html (hashed asset paths change on rebuild)
        "Cache-Control": "no-cache",
        ETag: etag,
        Vary: "Accept-Encoding",
      };

      if (isNotModified(c.req.header("if-none-match"), etag)) {
        return c.body(null, 304, headers);
      }

      headers["Content-Type"] = "text/html; charset=utf-8";
      return c.body(asResponseBody(indexHtml), 200, headers);
    } catch {
      return c.text(
        "Not found. Did you run 'pnpm build' to build the client?",
        404,
      );
    }
  });

  return app;
}

const HTML_CSP =
  "frame-ancestors 'self' tauri://localhost https://tauri.localhost";

/**
 * Resolve the best representation of a file for the requesting client.
 *
 * Order of preference:
 * 1. A build-time precompressed sibling (`file.br` / `file.gz`) — best bytes,
 *    zero runtime CPU.
 * 2. A cached on-demand compression.
 * 3. A fresh on-demand compression.
 * 4. The raw file.
 */
async function loadRepresentation(args: {
  filePath: string;
  ext: string;
  stat: fs.Stats;
  acceptEncoding: string;
  cache: RepresentationCache;
}): Promise<CachedRepresentation> {
  const { filePath, ext, stat, acceptEncoding, cache } = args;

  const wanted = negotiateEncoding(acceptEncoding);
  const compressible =
    COMPRESSIBLE_EXTENSIONS.has(ext) && stat.size >= COMPRESSION_MIN_BYTES;

  if (!compressible || wanted === "identity") {
    const cacheKey = representationKey(filePath, stat, "identity");
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const body = await fs.promises.readFile(filePath);
    const representation: CachedRepresentation = {
      body: asResponseBody(body),
      encoding: "identity",
    };
    cache.set(cacheKey, representation);
    return representation;
  }

  const cacheKey = representationKey(filePath, stat, wanted);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const precompressed = await readPrecompressed(filePath, wanted, stat);
  if (precompressed) {
    const representation: CachedRepresentation = {
      body: asResponseBody(precompressed),
      encoding: wanted,
    };
    cache.set(cacheKey, representation);
    return representation;
  }

  const raw = await fs.promises.readFile(filePath);
  let body: Buffer;
  try {
    body =
      wanted === "br"
        ? await brotliCompressAsync(raw, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
            },
          })
        : await gzipAsync(raw, { level: GZIP_LEVEL });
  } catch (err) {
    console.warn(`[Static] Compression failed for ${filePath}:`, err);
    return { body: asResponseBody(raw), encoding: "identity" };
  }

  // Pathological inputs (already-compressed payloads with a compressible
  // extension, e.g. a base64 blob in a .json) can grow. Never ship more bytes
  // than the original.
  if (body.byteLength >= raw.byteLength) {
    const identityKey = representationKey(filePath, stat, "identity");
    const representation: CachedRepresentation = {
      body: asResponseBody(raw),
      encoding: "identity",
    };
    cache.set(identityKey, representation);
    return representation;
  }

  const representation: CachedRepresentation = {
    body: asResponseBody(body),
    encoding: wanted,
  };
  cache.set(cacheKey, representation);
  return representation;
}

/**
 * Read a build-time precompressed sibling if it is at least as fresh as the
 * source file. A stale artifact left over from an earlier build would otherwise
 * serve the wrong bundle forever, so mtime is checked rather than trusted.
 */
async function readPrecompressed(
  filePath: string,
  encoding: Exclude<ContentEncoding, "identity">,
  sourceStat: fs.Stats,
): Promise<Buffer | null> {
  const suffix = encoding === "br" ? ".br" : ".gz";
  const candidate = `${filePath}${suffix}`;
  try {
    const stat = await fs.promises.stat(candidate);
    if (!stat.isFile()) return null;
    if (stat.mtimeMs < sourceStat.mtimeMs) return null;
    return await fs.promises.readFile(candidate);
  } catch {
    return null;
  }
}

/**
 * Pick a content coding from `Accept-Encoding`.
 *
 * Brotli wins when both are offered: it is 4–8% smaller than gzip on our
 * bundles and every browser that speaks it also speaks gzip, so there is no
 * compatibility cost. `q=0` is honoured because clients use it to opt out.
 */
export function negotiateEncoding(acceptEncoding: string): ContentEncoding {
  if (!acceptEncoding) return "identity";

  const offers = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [rawToken, ...params] = part.split(";");
    const token = rawToken?.trim().toLowerCase();
    if (!token) continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q=([0-9.]+)\s*$/i.exec(param);
      if (match?.[1] !== undefined) quality = Number.parseFloat(match[1]);
    }
    offers.set(token, Number.isFinite(quality) ? quality : 1);
  }

  const accepts = (token: string): boolean => {
    const explicit = offers.get(token);
    if (explicit !== undefined) return explicit > 0;
    const wildcard = offers.get("*");
    return wildcard !== undefined && wildcard > 0;
  };

  if (accepts("br")) return "br";
  if (accepts("gzip")) return "gzip";
  return "identity";
}

function representationKey(
  filePath: string,
  stat: fs.Stats,
  encoding: ContentEncoding,
): string {
  return `${filePath}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${encoding}`;
}

function buildFileETag(stat: fs.Stats, encoding: ContentEncoding): string {
  return `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}-${encoding}"`;
}

function buildContentETag(content: Buffer): string {
  // FNV-1a over the shell (a few KB) is cheaper than a crypto hash and only
  // needs to detect change, not resist collisions.
  let hash = 0x811c9dc5;
  for (const byte of content) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `W/"${content.byteLength.toString(36)}-${hash.toString(36)}"`;
}

/**
 * Match `If-None-Match` against our validator.
 *
 * Comparison is weak (RFC 9110 §13.1.2): `If-None-Match` on a GET always uses
 * the weak comparison function, so a `W/` prefix on either side is ignored.
 */
function isNotModified(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  const target = normalize(etag);
  return ifNoneMatch
    .split(",")
    .some((candidate) => normalize(candidate) === target);
}

/**
 * Bounded cache of file representations keyed by path + mtime + size + coding.
 *
 * Insertion-ordered `Map` iteration gives a cheap LRU: reads re-insert, and
 * eviction pops from the front.
 */
class RepresentationCache {
  private readonly entries = new Map<string, CachedRepresentation>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): CachedRepresentation | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, value: CachedRepresentation): void {
    if (value.body.byteLength > this.maxBytes) return;

    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.body.byteLength;
      this.entries.delete(key);
    }

    this.entries.set(key, value);
    this.bytes += value.body.byteLength;

    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted) this.bytes -= evicted.body.byteLength;
    }
  }
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
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    // Without this the PWA manifest is served as octet-stream, which also
    // excludes it from compression and from some browsers' manifest parsing.
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
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

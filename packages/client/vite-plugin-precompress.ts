import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import type { Logger, Plugin, ResolvedConfig } from "vite";

const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);

/**
 * Extensions worth precompressing. Must stay in sync with
 * `COMPRESSIBLE_EXTENSIONS` in `packages/server/src/frontend/static.ts`, which
 * is what serves these artifacts.
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

/** Matches the server-side threshold; below this, framing overhead dominates. */
const MIN_BYTES = 1024;

export interface PrecompressOptions {
  /** Skip work entirely (e.g. for fast local builds). */
  enabled?: boolean;
  /** Emit `.br` alongside `.gz`. */
  brotli?: boolean;
}

/**
 * Emit `.gz` and `.br` siblings for every compressible build artifact.
 *
 * The server can compress on demand, but it has to use fast settings because
 * the first request pays that cost inline. Doing it at build time is free at
 * runtime and lets us use maximal settings: on our bundles brotli quality 11
 * beats the runtime quality-5 path by a further 4–8%, and the whole first-load
 * set drops from 1.65 MB raw to roughly 400 KB.
 *
 * Assets are content-hashed and immutable, so a precompressed sibling can never
 * drift from its source within a build. The server still compares mtimes before
 * trusting one, which covers artifacts left behind by an earlier build.
 */
export function precompressPlugin(options: PrecompressOptions = {}): Plugin {
  const { enabled = true, brotli = true } = options;

  let outDir: string | null = null;
  let logger: Logger | null = null;

  return {
    name: "vite-plugin-precompress",
    apply: "build",
    enforce: "post",
    configResolved(config: ResolvedConfig) {
      // `--outDir` may be relative to root (see the `build:stable` script), so
      // resolve it once here rather than guessing at bundle-close time.
      outDir = path.resolve(config.root, config.build.outDir);
      logger = config.logger;
    },
    async closeBundle() {
      if (!enabled) return;
      if (!outDir) return;
      const absoluteOutDir = outDir;

      const files = await collectFiles(absoluteOutDir);
      const targets = files.filter((file) =>
        COMPRESSIBLE_EXTENSIONS.has(path.extname(file).toLowerCase()),
      );

      let rawBytes = 0;
      let gzipBytes = 0;
      let brotliBytes = 0;
      let written = 0;

      await Promise.all(
        targets.map(async (file) => {
          const source = await readFile(file);
          if (source.byteLength < MIN_BYTES) return;

          const [gzipped, brotlied] = await Promise.all([
            gzipAsync(source, { level: 9 }),
            brotli
              ? brotliCompressAsync(source, {
                  params: {
                    [zlibConstants.BROTLI_PARAM_QUALITY]:
                      zlibConstants.BROTLI_MAX_QUALITY,
                    [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
                  },
                })
              : Promise.resolve(null),
          ]);

          rawBytes += source.byteLength;

          // Never emit an artifact that is not actually smaller; the server
          // would happily serve it and waste bytes plus a decode step.
          if (gzipped.byteLength < source.byteLength) {
            await writeFile(`${file}.gz`, gzipped);
            gzipBytes += gzipped.byteLength;
            written += 1;
          } else {
            gzipBytes += source.byteLength;
          }

          if (brotlied && brotlied.byteLength < source.byteLength) {
            await writeFile(`${file}.br`, brotlied);
            brotliBytes += brotlied.byteLength;
            written += 1;
          } else {
            brotliBytes += source.byteLength;
          }
        }),
      );

      if (written === 0) return;

      const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
      const summary = `precompress: ${written} artifacts, raw ${mb(rawBytes)} MB -> gzip ${mb(gzipBytes)} MB${
        brotli ? ` / brotli ${mb(brotliBytes)} MB` : ""
      }`;
      if (logger) logger.info(summary);
      else console.log(summary);
    },
  };
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Do not recompress our own output on a rebuild into a dirty outDir.
      if (full.endsWith(".gz") || full.endsWith(".br")) continue;
      out.push(full);
    }
  };

  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return out;
  } catch {
    return out;
  }

  await walk(dir);
  return out;
}

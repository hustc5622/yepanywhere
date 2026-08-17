/**
 * Plain-or-compressed access to Codex rollout files.
 *
 * Codex ships a background worker (`codex-rs/rollout/src/compression.rs`) that
 * compresses rollouts which have been cold for 7 days: it writes
 * `<name>.jsonl.zst` and then deletes the plain `<name>.jsonl`. When a session is
 * resumed, `materialize_rollout_for_append` decompresses it back to plain.
 *
 * The worker is gated behind `Feature::LocalThreadStoreCompression`, which is
 * `under development` / default-off in Codex 0.147.0, so most installs only ever
 * have plain files. But the flag is user-reachable
 * (`codex -c features.local_thread_store_compression=true`) and may graduate, and
 * a reader that only globs `.jsonl` does not degrade gracefully in that case — it
 * simply stops seeing every session older than a week. These helpers mirror
 * Codex's own `path::existing_rollout_path` so both layouts resolve.
 *
 * zstd is lossless, so a compress/decompress round trip is byte-identical: line
 * content and byte offsets within the decompressed stream are unchanged.
 *
 * Yep never writes rollout files, so there is deliberately no
 * materialize-for-append counterpart here.
 *
 * Node's zstd bindings only exist from v22.15.0 (still flagged experimental),
 * while this package supports `node >=22.13.0`. They are therefore resolved
 * lazily and only when a compressed path is actually read: binding them at module
 * scope would throw during import on a supported runtime and take the whole
 * server down, rather than degrading to "compressed rollouts are unreadable",
 * which is exactly the behaviour those runtimes had before this module existed.
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

import { stripBom } from "../utils/jsonl.js";

export const CODEX_ROLLOUT_COMPRESSED_SUFFIX = ".zst";

const ZSTD_UNSUPPORTED_MESSAGE =
  "Reading compressed Codex rollouts requires Node.js 22.15.0 or newer (node:zlib zstd support).";

/** True when this runtime can decompress zstd. */
export function isCodexRolloutDecompressionSupported(): boolean {
  return (
    typeof zlib.zstdDecompress === "function" &&
    typeof zlib.createZstdDecompress === "function"
  );
}

function requireZstd(): {
  decompress: (buf: Buffer) => Promise<Buffer>;
  createDecompressStream: () => zlib.ZstdDecompress;
} {
  if (!isCodexRolloutDecompressionSupported()) {
    throw new Error(ZSTD_UNSUPPORTED_MESSAGE);
  }
  return {
    decompress: promisify(zlib.zstdDecompress) as (
      buf: Buffer,
    ) => Promise<Buffer>,
    createDecompressStream: () => zlib.createZstdDecompress(),
  };
}

/** True when the path points at a compressed rollout. */
export function isCompressedCodexRolloutPath(filePath: string): boolean {
  return filePath.endsWith(CODEX_ROLLOUT_COMPRESSED_SUFFIX);
}

/** The plain `.jsonl` path for a rollout, whether or not it is compressed. */
export function plainCodexRolloutPath(filePath: string): string {
  return isCompressedCodexRolloutPath(filePath)
    ? filePath.slice(0, -CODEX_ROLLOUT_COMPRESSED_SUFFIX.length)
    : filePath;
}

/** The compressed path for a rollout, whether or not it is already compressed. */
export function compressedCodexRolloutPath(filePath: string): string {
  return isCompressedCodexRolloutPath(filePath)
    ? filePath
    : `${filePath}${CODEX_ROLLOUT_COMPRESSED_SUFFIX}`;
}

/**
 * Resolve whichever form of a rollout exists on disk, preferring plain.
 *
 * Plain wins because Codex materializes a compressed rollout back to plain
 * before appending, so during a resume both files can exist briefly and the
 * plain one is the live copy.
 */
export async function resolveExistingCodexRolloutPath(
  filePath: string,
): Promise<string | null> {
  const plain = plainCodexRolloutPath(filePath);
  if (await pathExists(plain)) return plain;
  const compressed = compressedCodexRolloutPath(plain);
  return (await pathExists(compressed)) ? compressed : null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Read a rollout as text, decompressing when needed. */
export async function readCodexRolloutText(filePath: string): Promise<string> {
  if (!isCompressedCodexRolloutPath(filePath)) {
    return (await readFile(filePath)).toString("utf8");
  }
  const { decompress } = requireZstd();
  const decompressed = await decompress(await readFile(filePath));
  return decompressed.toString("utf8");
}

/** Read a rollout as BOM-stripped lines, decompressing when needed. */
export async function readCodexRolloutLines(
  filePath: string,
): Promise<string[]> {
  const text = await readCodexRolloutText(filePath);
  return stripBom(text).trim().split("\n");
}

/**
 * Read only the first line of a rollout.
 *
 * The manifest scan does this once per session file, so a compressed rollout is
 * streamed through the decompressor and abandoned as soon as the first newline
 * arrives instead of inflating the whole file.
 */
export async function readCodexRolloutFirstLine(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  let text = "";
  // Only errors raised *because* we tore the stream down early may be ignored.
  // Anything else (corrupt frame, unreadable file) must still surface.
  let stoppedEarly = false;

  const source = createReadStream(filePath);
  const consume = async (
    stream: AsyncIterable<Buffer | string>,
  ): Promise<void> => {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      text = Buffer.concat(chunks).toString("utf8");
      if (text.includes("\n") || total >= maxBytes) {
        stoppedEarly = true;
        return;
      }
    }
  };

  try {
    if (isCompressedCodexRolloutPath(filePath)) {
      const decompressor = requireZstd().createDecompressStream();
      await pipeline(source, decompressor, consume).catch((error: unknown) => {
        if (!stoppedEarly) throw error;
      });
    } else {
      await consume(source).catch((error: unknown) => {
        if (!stoppedEarly) throw error;
      });
    }
  } finally {
    source.destroy();
  }

  if (total === 0) return null;
  const stripped = stripBom(text);
  const newline = stripped.indexOf("\n");
  const line = (newline > 0 ? stripped.slice(0, newline) : stripped).trim();
  return line || null;
}

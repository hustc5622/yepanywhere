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
import type { Stats } from "node:fs";
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

/** A stable identity for one opened rollout snapshot. */
export interface CodexRolloutRevision {
  /** Device/inode identity when the filesystem provides it. */
  readonly dev: number;
  readonly ino: number;
  /** File size and mtime captured at the same boundary. */
  readonly size: number;
  readonly mtimeMs: number;
  /** Compact value suitable for logs and pagination cursors. */
  readonly key: string;
}

export function codexRolloutRevision(stats: Stats): CodexRolloutRevision {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    key: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`,
  };
}

export function sameCodexRolloutRevision(
  left: CodexRolloutRevision,
  right: CodexRolloutRevision,
): boolean {
  return left.key === right.key;
}

/** Stable error codes emitted by the bounded rollout scanner. */
export type CodexRolloutScanErrorCode =
  | "entry_too_large"
  | "scan_budget_exceeded"
  | "invalid_utf8";

export class CodexRolloutScanError extends Error {
  readonly code: CodexRolloutScanErrorCode;
  readonly offset: number;

  constructor(
    code: CodexRolloutScanErrorCode,
    message: string,
    offset: number,
  ) {
    super(message);
    this.name = "CodexRolloutScanError";
    this.code = code;
    this.offset = offset;
  }
}

export interface CodexRolloutLine {
  /** Logical UTF-8 byte offset in the decompressed, BOM-stripped JSONL. */
  readonly offset: number;
  /** The line without its LF/CRLF terminator or BOM. */
  readonly line: string;
  /** Number of logical bytes occupied by the line, excluding LF. */
  readonly byteLength: number;
}

export interface CodexRolloutLineIteratorOptions {
  /** Refuse a line before constructing a string or calling JSON.parse. */
  readonly maxLineBytes?: number;
  /** Refuse after this many logical bytes have been consumed. */
  readonly maxBytes?: number;
}

async function* decodedCodexRolloutChunks(
  filePath: string,
): AsyncGenerator<Buffer> {
  const source = createReadStream(filePath);
  let decoded: AsyncIterable<Buffer | string> = source;
  let decompressor: zlib.ZstdDecompress | undefined;

  try {
    if (isCompressedCodexRolloutPath(filePath)) {
      decompressor = requireZstd().createDecompressStream();
      source.pipe(decompressor);
      decoded = decompressor;
    }

    for await (const chunk of decoded) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
  } finally {
    source.destroy();
    decompressor?.destroy();
  }
}

/** Open a decoded rollout byte stream without materializing the file. */
export function openCodexRolloutStream(
  filePath: string,
): AsyncIterable<Buffer> {
  return decodedCodexRolloutChunks(filePath);
}

function decodeCodexLine(bytes: Buffer, offset: number): string {
  try {
    // TextDecoder with fatal=true keeps a malformed line from being silently
    // turned into replacement characters and then accepted by JSON.parse.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CodexRolloutScanError(
      "invalid_utf8",
      `Invalid UTF-8 in Codex rollout at byte offset ${offset}`,
      offset,
    );
  }
}

/**
 * Iterate a rollout one UTF-8 JSONL line at a time.
 *
 * The iterator is intentionally byte-oriented: message ids and cursors use the
 * decompressed JSONL byte offset, and a large line is rejected while it is
 * still a bounded byte buffer rather than after a whole-file string/split.
 */
export async function* iterateCodexRolloutLines(
  filePath: string,
  options: CodexRolloutLineIteratorOptions = {},
): AsyncGenerator<CodexRolloutLine> {
  const maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const chunks: Buffer[] = [];
  let pendingBytes = 0;
  let logicalOffset = 0;
  let consumedBytes = 0;
  let firstLine = true;

  const emitLine = (rawLine: Buffer): CodexRolloutLine => {
    let lineBytes = rawLine;
    let bomBytes = 0;
    if (
      firstLine &&
      rawLine[0] === 0xef &&
      rawLine[1] === 0xbb &&
      rawLine[2] === 0xbf
    ) {
      lineBytes = rawLine.subarray(3);
      bomBytes = 3;
    }

    let contentBytes = lineBytes;
    if (contentBytes[contentBytes.length - 1] === 0x0d) {
      contentBytes = contentBytes.subarray(0, contentBytes.length - 1);
    }

    const line = decodeCodexLine(contentBytes, logicalOffset);
    // Preserve CR in the byte accounting even though it is removed from the
    // decoded JSON text. This keeps revision/scan budgets conservative for
    // CRLF files.
    const byteLength = lineBytes.length;
    const result = { offset: logicalOffset, line, byteLength };
    // The iterator emits a line that ended at LF; keep that delimiter in the
    // next line's absolute offset, matching the historical split("\\n") reader.
    logicalOffset += rawLine.length - bomBytes + 1;
    firstLine = false;
    return result;
  };

  const flush = async function* (
    bytes: Buffer,
  ): AsyncGenerator<CodexRolloutLine> {
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      const piece = bytes.subarray(start, index);
      if (piece.length > 0) {
        chunks.push(piece);
        pendingBytes += piece.length;
      }
      if (pendingBytes > maxLineBytes) {
        throw new CodexRolloutScanError(
          "entry_too_large",
          `Codex rollout line exceeds ${maxLineBytes} bytes at offset ${logicalOffset}`,
          logicalOffset,
        );
      }
      const rawLine = Buffer.concat(chunks, pendingBytes);
      chunks.length = 0;
      pendingBytes = 0;
      consumedBytes += rawLine.length + 1;
      if (consumedBytes > maxBytes) {
        throw new CodexRolloutScanError(
          "scan_budget_exceeded",
          `Codex rollout scan exceeds ${maxBytes} bytes`,
          logicalOffset,
        );
      }
      yield emitLine(rawLine);
      start = index + 1;
    }

    const tail = bytes.subarray(start);
    if (tail.length > 0) {
      chunks.push(tail);
      pendingBytes += tail.length;
      if (pendingBytes > maxLineBytes) {
        throw new CodexRolloutScanError(
          "entry_too_large",
          `Codex rollout line exceeds ${maxLineBytes} bytes at offset ${logicalOffset}`,
          logicalOffset,
        );
      }
    }
  };

  for await (const chunk of openCodexRolloutStream(filePath)) {
    for await (const line of flush(chunk)) {
      yield line;
    }
  }

  if (pendingBytes > 0) {
    const rawLine = Buffer.concat(chunks, pendingBytes);
    if (consumedBytes + rawLine.length > maxBytes) {
      throw new CodexRolloutScanError(
        "scan_budget_exceeded",
        `Codex rollout scan exceeds ${maxBytes} bytes`,
        logicalOffset,
      );
    }
    yield emitLine(rawLine);
  }
}

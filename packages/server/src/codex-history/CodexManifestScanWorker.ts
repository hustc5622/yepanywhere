import { Worker } from "node:worker_threads";

export interface CodexManifestFileHeader {
  filePath: string;
  mtimeMs: number;
  size: number;
  firstLine: string | null;
}

/**
 * The worker reads first lines in small steps with bounded concurrency, and
 * skips files whose mtime and size the caller already knows; only changed
 * headers cross the thread boundary.
 */
const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");

const READ_STEP_BYTES = 16 * 1024;
const CONCURRENCY = 16;

async function walk(root, files) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return; }
  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return walk(fullPath, files);
    if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))) files.push(fullPath);
  }));
}

async function firstLine(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const length = Math.min(READ_STEP_BYTES, maxBytes - total);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, total);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      total += bytesRead;
      if (newline >= 0) break;
    }
    if (total === 0) return null;
    return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
  } finally { await handle.close(); }
}

async function header(filePath, maxBytes, known) {
  try {
    const metadata = await fs.stat(filePath);
    const stamp = metadata.mtimeMs + ":" + metadata.size;
    if (known[filePath] === stamp) {
      return { filePath, mtimeMs: metadata.mtimeMs, size: metadata.size, unchanged: true };
    }
    const line = filePath.endsWith(".jsonl") ? await firstLine(filePath, maxBytes) : null;
    return { filePath, mtimeMs: metadata.mtimeMs, size: metadata.size, firstLine: line };
  } catch { return null; }
}

parentPort.on("message", async ({ id, root, maxBytes, known }) => {
  try {
    const files = [];
    await walk(root, files);
    const rows = new Array(files.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        rows[index] = await header(files[index], maxBytes, known);
      }
    }));
    parentPort.postMessage({ id, ok: true, rows: rows.filter(Boolean) });
  } catch {
    parentPort.postMessage({ id, ok: false });
  }
});
`;

type WorkerRow = Omit<CodexManifestFileHeader, "firstLine"> &
  ({ firstLine: string | null } | { unchanged: true });

const inFlight = new Map<string, Promise<CodexManifestFileHeader[] | null>>();
/** Last headers per root, reused for files whose mtime and size are unchanged. */
const knownHeaders = new Map<string, Map<string, CodexManifestFileHeader>>();

function stamp(header: { mtimeMs: number; size: number }): string {
  return `${header.mtimeMs}:${header.size}`;
}

/** One physical root scan at a time, entirely outside the main event loop. */
export function scanCodexManifestHeadersInWorker(
  root: string,
  maxBytes: number,
  timeoutMs = 30_000,
): Promise<CodexManifestFileHeader[] | null> {
  const existing = inFlight.get(root);
  if (existing) return existing;
  const request = runWorker(root, maxBytes, timeoutMs).finally(() => {
    if (inFlight.get(root) === request) inFlight.delete(root);
  });
  inFlight.set(root, request);
  return request;
}

function runWorker(
  root: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<CodexManifestFileHeader[] | null> {
  const previous = knownHeaders.get(root) ?? new Map();
  const known: Record<string, string> = {};
  for (const [filePath, header] of previous) known[filePath] = stamp(header);

  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true });
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: CodexManifestFileHeader[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    worker.once("message", (message: { ok?: boolean; rows?: WorkerRow[] }) => {
      if (!message.ok) {
        finish(null);
        return;
      }
      const headers: CodexManifestFileHeader[] = [];
      const current = new Map<string, CodexManifestFileHeader>();
      for (const row of message.rows ?? []) {
        const header =
          "unchanged" in row
            ? previous.get(row.filePath)
            : (row as CodexManifestFileHeader);
        if (!header) continue;
        headers.push(header);
        current.set(header.filePath, header);
      }
      knownHeaders.set(root, current);
      finish(headers);
    });
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
    worker.postMessage({ id: 1, root, maxBytes, known });
  });
}

export function resetCodexManifestHeaderCacheForTests(): void {
  knownHeaders.clear();
}

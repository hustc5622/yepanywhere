import { Worker } from "node:worker_threads";

export interface CodexManifestFileHeader {
  filePath: string;
  mtimeMs: number;
  size: number;
  firstLine: string | null;
}

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");

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
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    if (bytesRead === 0) return null;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    return (newline >= 0 ? text.slice(0, newline) : text).replace(/^\uFEFF/, "");
  } finally { await handle.close(); }
}

parentPort.on("message", async ({ id, root, maxBytes }) => {
  try {
    const files = [];
    await walk(root, files);
    const rows = await Promise.all(files.map(async (filePath) => {
      try {
        const [metadata, line] = await Promise.all([
          fs.stat(filePath),
          filePath.endsWith(".jsonl") ? firstLine(filePath, maxBytes) : Promise.resolve(null),
        ]);
        return { filePath, mtimeMs: metadata.mtimeMs, size: metadata.size, firstLine: line };
      } catch { return null; }
    }));
    parentPort.postMessage({ id, ok: true, rows: rows.filter(Boolean) });
  } catch {
    parentPort.postMessage({ id, ok: false });
  }
});
`;

const inFlight = new Map<string, Promise<CodexManifestFileHeader[] | null>>();

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
    worker.once(
      "message",
      (message: { ok?: boolean; rows?: CodexManifestFileHeader[] }) =>
        finish(message.ok ? (message.rows ?? []) : null),
    );
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
    worker.postMessage({ id: 1, root, maxBytes });
  });
}

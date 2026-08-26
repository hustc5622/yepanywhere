import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  CodexBridgeJournalMode,
  CodexBridgeNotificationClass,
} from "./journal-policy.js";

const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CONNECTION_QUEUE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 25;
const DEFAULT_MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_KEEP_SEGMENTS = 2;
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const MAX_RECORD_BYTES = 16 * 1024;

export type CodexBridgeJournalRecordKind =
  | "client-request"
  | "client-response"
  | "server-notification"
  | "server-request"
  | "server-request-resolution";

/**
 * Compact bridge-owned observation. It intentionally has no generic payload
 * field, so prompt text, tool output, commands, cwd and secret config cannot be
 * added accidentally by spreading a JSON-RPC message into the record.
 */
export interface CodexBridgeJournalRecord {
  schema: "yep.codex-bridge.lifecycle";
  version: 1;
  instanceId: string;
  recordedAt: string;
  mode: "lifecycle" | "full";
  kind: CodexBridgeJournalRecordKind;
  classification: CodexBridgeNotificationClass | "request" | "response";
  direction: "client" | "server";
  connectionId: number;
  profile: "clear" | "light" | "full";
  method: string;
  sessionId?: string;
  turnId?: string;
  itemId?: string;
  status?: string;
  requestId?: string | number;
  requestIdFingerprint?: string;
  wireBytes: number;
  count: number;
}

export interface CodexBridgeJournalEnqueueOptions {
  connectionId: number;
  coalesceKey?: string;
  priority: "normal" | "terminal";
}

export interface CodexBridgeJournalStats {
  queueBytes: number;
  peakQueueBytes: number;
  queuedRecords: number;
  enqueuedRecords: number;
  coalescedRecords: number;
  droppedRecords: number;
  writtenRecords: number;
  journalBytes: number;
  flushCount: number;
  flushFailures: number;
  lastFlushMs: number;
  circuitOpen: boolean;
}

export interface CodexBridgeJournalWriter {
  enqueue(
    record: CodexBridgeJournalRecord,
    options: CodexBridgeJournalEnqueueOptions,
  ): boolean;
  flush(timeoutMs?: number): Promise<void>;
  close(timeoutMs?: number): Promise<void>;
  getStats(): CodexBridgeJournalStats;
}

export interface AsyncCodexBridgeJournalOptions {
  mode: Extract<CodexBridgeJournalMode, "lifecycle" | "full">;
  filePath: string;
  instanceId?: string;
  maxQueueBytes?: number;
  maxConnectionQueueBytes?: number;
  maxBatchBytes?: number;
  flushIntervalMs?: number;
  maxSegmentBytes?: number;
  keepSegments?: number;
  terminalDatasync?: boolean;
  /** Test/benchmark-only artificial writer delay. Never enters proxy awaits. */
  writeDelayMs?: number;
  onFlush?: (durationMs: number) => void;
  onFailure?: (code: "lease" | "open" | "write" | "rotate") => void;
}

interface QueuedJournalRecord {
  record: CodexBridgeJournalRecord;
  connectionId: number;
  coalesceKey?: string;
  priority: "normal" | "terminal";
  estimatedBytes: number;
}

interface WriterLeasePayload {
  token: string;
  pid: number;
  createdAt: string;
}

class CodexBridgeWriterError extends Error {
  constructor(
    readonly stage: "lease" | "open" | "write" | "rotate",
    options: { cause?: unknown } = {},
  ) {
    super(`Codex bridge writer failed at ${stage}`, options);
    this.name = "CodexBridgeWriterError";
  }
}

/**
 * One service-owned asynchronous writer shared by every bridge connection.
 * Enqueue never waits for disk. A real exclusive lease prevents two processes
 * from appending through independent handles while claiming sole ownership.
 */
export class AsyncCodexBridgeJournal implements CodexBridgeJournalWriter {
  readonly instanceId: string;

  private readonly mode: "lifecycle" | "full";
  private readonly filePath: string;
  private readonly leasePath: string;
  private readonly maxQueueBytes: number;
  private readonly maxConnectionQueueBytes: number;
  private readonly maxBatchBytes: number;
  private readonly flushIntervalMs: number;
  private readonly maxSegmentBytes: number;
  private readonly keepSegments: number;
  private readonly terminalDatasync: boolean;
  private readonly writeDelayMs: number;
  private readonly onFlush?: AsyncCodexBridgeJournalOptions["onFlush"];
  private readonly onFailure?: AsyncCodexBridgeJournalOptions["onFailure"];

  private readonly queue: QueuedJournalRecord[] = [];
  private readonly coalesced = new Map<string, QueuedJournalRecord>();
  private readonly connectionQueueBytes = new Map<number, number>();
  private fileHandle: FileHandle | null = null;
  private leaseHandle: FileHandle | null = null;
  private leaseToken: string | null = null;
  private fileBytes = 0;
  private nextSequence = 1;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTail: Promise<void> = Promise.resolve();
  private closed = false;
  private abandoning = false;

  private stats: CodexBridgeJournalStats = {
    queueBytes: 0,
    peakQueueBytes: 0,
    queuedRecords: 0,
    enqueuedRecords: 0,
    coalescedRecords: 0,
    droppedRecords: 0,
    writtenRecords: 0,
    journalBytes: 0,
    flushCount: 0,
    flushFailures: 0,
    lastFlushMs: 0,
    circuitOpen: false,
  };

  constructor(options: AsyncCodexBridgeJournalOptions) {
    if (!options.filePath.trim()) {
      throw new Error("Codex bridge journal requires a non-empty filePath");
    }
    this.mode = options.mode;
    this.filePath = options.filePath;
    this.leasePath = `${options.filePath}.writer.lock`;
    this.instanceId = options.instanceId ?? randomUUID();
    this.maxQueueBytes = positiveInteger(
      options.maxQueueBytes,
      DEFAULT_MAX_QUEUE_BYTES,
      "maxQueueBytes",
    );
    this.maxConnectionQueueBytes = positiveInteger(
      options.maxConnectionQueueBytes,
      DEFAULT_MAX_CONNECTION_QUEUE_BYTES,
      "maxConnectionQueueBytes",
    );
    this.maxBatchBytes = positiveInteger(
      options.maxBatchBytes,
      DEFAULT_MAX_BATCH_BYTES,
      "maxBatchBytes",
    );
    this.flushIntervalMs = positiveInteger(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
      "flushIntervalMs",
    );
    this.maxSegmentBytes = positiveInteger(
      options.maxSegmentBytes,
      DEFAULT_MAX_SEGMENT_BYTES,
      "maxSegmentBytes",
    );
    this.keepSegments = nonNegativeInteger(
      options.keepSegments,
      DEFAULT_KEEP_SEGMENTS,
      "keepSegments",
    );
    this.terminalDatasync = options.terminalDatasync === true;
    this.writeDelayMs = nonNegativeInteger(
      options.writeDelayMs,
      0,
      "writeDelayMs",
    );
    this.onFlush = options.onFlush;
    this.onFailure = options.onFailure;
  }

  enqueue(
    record: CodexBridgeJournalRecord,
    options: CodexBridgeJournalEnqueueOptions,
  ): boolean {
    if (this.closed || this.abandoning || this.stats.circuitOpen) {
      this.stats.droppedRecords += 1;
      return false;
    }

    const coalesceKey = options.coalesceKey;
    if (coalesceKey) {
      const existing = this.coalesced.get(coalesceKey);
      if (existing) {
        const previousBytes = existing.estimatedBytes;
        const updatedRecord: CodexBridgeJournalRecord = {
          ...record,
          recordedAt: record.recordedAt,
          count: existing.record.count + record.count,
          wireBytes: existing.record.wireBytes + record.wireBytes,
        };
        const updatedBytes = estimateRecordBytes(updatedRecord);
        const difference = updatedBytes - previousBytes;
        if (
          this.stats.queueBytes + difference > this.maxQueueBytes ||
          (this.connectionQueueBytes.get(existing.connectionId) ?? 0) +
            difference >
            this.maxConnectionQueueBytes
        ) {
          this.stats.droppedRecords += 1;
          return false;
        }
        existing.record = updatedRecord;
        existing.estimatedBytes = updatedBytes;
        this.stats.queueBytes += difference;
        this.connectionQueueBytes.set(
          existing.connectionId,
          (this.connectionQueueBytes.get(existing.connectionId) ?? 0) +
            difference,
        );
        this.stats.coalescedRecords += 1;
        this.updateQueueStats();
        return true;
      }
    }

    const estimatedBytes = estimateRecordBytes(record);
    if (estimatedBytes > MAX_RECORD_BYTES) {
      this.stats.droppedRecords += 1;
      return false;
    }

    if (!this.makeRoom(estimatedBytes, options)) {
      this.stats.droppedRecords += 1;
      return false;
    }

    const queued: QueuedJournalRecord = {
      record,
      connectionId: options.connectionId,
      ...(coalesceKey ? { coalesceKey } : {}),
      priority: options.priority,
      estimatedBytes,
    };
    this.queue.push(queued);
    if (coalesceKey) this.coalesced.set(coalesceKey, queued);
    this.stats.queueBytes += estimatedBytes;
    this.connectionQueueBytes.set(
      options.connectionId,
      (this.connectionQueueBytes.get(options.connectionId) ?? 0) +
        estimatedBytes,
    );
    this.stats.enqueuedRecords += 1;
    this.updateQueueStats();
    this.scheduleFlush(options.priority === "terminal");
    return true;
  }

  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.kickFlush();
    const completed = await withTimeout(this.flushTail, timeoutMs);
    if (!completed) {
      this.abandoning = true;
      this.stats.droppedRecords += this.queue.length;
      while (this.queue.length > 0) this.removeQueuedAt(0);
    }
  }

  async close(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush(timeoutMs);
    await this.fileHandle?.close().catch(() => undefined);
    this.fileHandle = null;
    await this.releaseLease();
  }

  getStats(): CodexBridgeJournalStats {
    return { ...this.stats };
  }

  private makeRoom(
    bytes: number,
    options: CodexBridgeJournalEnqueueOptions,
  ): boolean {
    const fits = (): boolean =>
      this.stats.queueBytes + bytes <= this.maxQueueBytes &&
      (this.connectionQueueBytes.get(options.connectionId) ?? 0) + bytes <=
        this.maxConnectionQueueBytes;
    if (fits()) return true;
    if (options.priority !== "terminal") return false;

    // Terminal state wins over queued snapshots/diagnostics. Prefer evicting
    // the same connection first, then any non-terminal record globally.
    while (!fits()) {
      let index = this.queue.findIndex(
        (entry) =>
          entry.priority === "normal" &&
          entry.connectionId === options.connectionId,
      );
      if (index < 0) {
        index = this.queue.findIndex((entry) => entry.priority === "normal");
      }
      if (index < 0) return false;
      this.removeQueuedAt(index);
      this.stats.droppedRecords += 1;
    }
    return true;
  }

  private removeQueuedAt(index: number): QueuedJournalRecord | undefined {
    const [entry] = this.queue.splice(index, 1);
    if (!entry) return undefined;
    if (entry.coalesceKey) this.coalesced.delete(entry.coalesceKey);
    this.stats.queueBytes -= entry.estimatedBytes;
    const connectionBytes =
      (this.connectionQueueBytes.get(entry.connectionId) ?? 0) -
      entry.estimatedBytes;
    if (connectionBytes > 0) {
      this.connectionQueueBytes.set(entry.connectionId, connectionBytes);
    } else {
      this.connectionQueueBytes.delete(entry.connectionId);
    }
    this.updateQueueStats();
    return entry;
  }

  private updateQueueStats(): void {
    this.stats.queueBytes = Math.max(0, this.stats.queueBytes);
    this.stats.queuedRecords = this.queue.length;
    this.stats.peakQueueBytes = Math.max(
      this.stats.peakQueueBytes,
      this.stats.queueBytes,
    );
  }

  private scheduleFlush(immediate: boolean): void {
    if (this.stats.circuitOpen || this.closed) return;
    if (this.flushTimer) {
      if (!immediate) return;
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = null;
        this.kickFlush();
      },
      immediate ? 0 : this.flushIntervalMs,
    );
    this.flushTimer.unref?.();
  }

  private kickFlush(): void {
    this.flushTail = this.flushTail.then(
      () => this.drainQueue(),
      () => this.drainQueue(),
    );
  }

  private async drainQueue(): Promise<void> {
    while (
      this.queue.length > 0 &&
      !this.stats.circuitOpen &&
      !this.abandoning
    ) {
      const batch: QueuedJournalRecord[] = [];
      let estimatedBatchBytes = 0;
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (!next) break;
        if (
          batch.length > 0 &&
          estimatedBatchBytes + next.estimatedBytes > this.maxBatchBytes
        ) {
          break;
        }
        const removed = this.removeQueuedAt(0);
        if (!removed) break;
        batch.push(removed);
        estimatedBatchBytes += removed.estimatedBytes;
      }
      if (batch.length === 0) break;
      await this.writeBatch(batch);
    }
  }

  private async writeBatch(
    batch: readonly QueuedJournalRecord[],
  ): Promise<void> {
    const startedAt = performance.now();
    try {
      if (this.writeDelayMs > 0) await delay(this.writeDelayMs);
      if (this.abandoning) {
        this.stats.droppedRecords += batch.length;
        return;
      }
      await this.ensureOpen();
      if (this.abandoning) {
        this.stats.droppedRecords += batch.length;
        return;
      }
      const lines = batch.map((entry) =>
        JSON.stringify({
          ...entry.record,
          sequence: this.nextSequence++,
        }),
      );
      const payload = `${lines.join("\n")}\n`;
      const payloadBytes = Buffer.byteLength(payload);
      if (
        this.fileBytes > 0 &&
        this.fileBytes + payloadBytes > this.maxSegmentBytes
      ) {
        await this.rotate();
      }
      await this.fileHandle?.writeFile(payload, { encoding: "utf8" });
      this.fileBytes += payloadBytes;
      this.stats.journalBytes += payloadBytes;
      this.stats.writtenRecords += batch.length;
      this.stats.flushCount += 1;
      if (
        this.terminalDatasync &&
        batch.some((entry) => entry.priority === "terminal")
      ) {
        await this.fileHandle?.datasync();
      }
      this.stats.lastFlushMs = performance.now() - startedAt;
      this.onFlush?.(this.stats.lastFlushMs);
    } catch (error) {
      const code = classifyWriterFailure(error);
      this.tripCircuit(code);
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.fileHandle) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await this.acquireLease();
    try {
      this.fileHandle = await open(this.filePath, "a", 0o600);
      this.fileBytes = (await this.fileHandle.stat()).size;
    } catch (error) {
      throw new CodexBridgeWriterError("open", { cause: error });
    }
  }

  private async acquireLease(): Promise<void> {
    if (this.leaseHandle) return;
    const payload: WriterLeasePayload = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.leasePath, "wx", 0o600);
        await handle.writeFile(JSON.stringify(payload), { encoding: "utf8" });
        this.leaseHandle = handle;
        this.leaseToken = payload.token;
        return;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST" || attempt > 0) {
          throw new CodexBridgeWriterError("lease", { cause: error });
        }
        const stale = await this.isStaleLease();
        if (!stale) {
          throw new CodexBridgeWriterError("lease", { cause: error });
        }
        await rm(this.leasePath, { force: true });
      }
    }
  }

  private async isStaleLease(): Promise<boolean> {
    try {
      const parsed = JSON.parse(
        await readFile(this.leasePath, "utf8"),
      ) as Partial<WriterLeasePayload>;
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) {
        return false;
      }
      return !isProcessAlive(parsed.pid as number);
    } catch {
      return false;
    }
  }

  private async releaseLease(): Promise<void> {
    await this.leaseHandle?.close().catch(() => undefined);
    this.leaseHandle = null;
    const token = this.leaseToken;
    this.leaseToken = null;
    if (!token) return;
    try {
      const parsed = JSON.parse(
        await readFile(this.leasePath, "utf8"),
      ) as Partial<WriterLeasePayload>;
      if (parsed.token === token) {
        await rm(this.leasePath, { force: true });
      }
    } catch {
      // Lease cleanup is best-effort; a stale lease is reclaimed next start.
    }
  }

  private async rotate(): Promise<void> {
    try {
      await this.fileHandle?.close();
      this.fileHandle = null;
      const segmentPath = await this.nextSegmentPath();
      await rename(this.filePath, segmentPath);
      await this.pruneSegments();
      this.fileHandle = await open(this.filePath, "a", 0o600);
      this.fileBytes = 0;
    } catch (error) {
      throw new CodexBridgeWriterError("rotate", { cause: error });
    }
  }

  private async nextSegmentPath(): Promise<string> {
    const stamp = new Date().toISOString().replace(/\D/g, "");
    for (let suffix = 0; ; suffix += 1) {
      const candidate = join(
        dirname(this.filePath),
        `${basename(this.filePath, ".jsonl")}.${stamp}${suffix ? `-${suffix}` : ""}.jsonl`,
      );
      try {
        await stat(candidate);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return candidate;
        throw error;
      }
    }
  }

  private async pruneSegments(): Promise<void> {
    const entries = await readdir(dirname(this.filePath));
    const pattern = new RegExp(
      `^${escapeRegExp(basename(this.filePath, ".jsonl"))}\\.\\d{17}(?:-\\d+)?\\.jsonl$`,
    );
    const segments = entries.filter((entry) => pattern.test(entry)).sort();
    const excess = segments.length - this.keepSegments;
    for (const entry of segments.slice(0, Math.max(0, excess))) {
      await rm(join(dirname(this.filePath), entry), { force: true });
    }
  }

  private tripCircuit(code: "lease" | "open" | "write" | "rotate"): void {
    if (this.stats.circuitOpen) return;
    this.stats.circuitOpen = true;
    this.stats.flushFailures += 1;
    this.onFailure?.(code);
    this.stats.droppedRecords += this.queue.length;
    while (this.queue.length > 0) this.removeQueuedAt(0);
    void this.fileHandle?.close().catch(() => undefined);
    this.fileHandle = null;
  }
}

export function createCodexBridgeJournalRecord(input: {
  instanceId: string;
  mode: "lifecycle" | "full";
  kind: CodexBridgeJournalRecordKind;
  classification: CodexBridgeJournalRecord["classification"];
  direction: "client" | "server";
  connectionId: number;
  profile: "clear" | "light" | "full";
  method: string;
  sessionId?: string;
  turnId?: string;
  itemId?: string;
  status?: string;
  requestId?: string | number;
  requestIdFingerprint?: string;
  wireBytes: number;
}): CodexBridgeJournalRecord {
  return {
    schema: "yep.codex-bridge.lifecycle",
    version: 1,
    instanceId: input.instanceId,
    recordedAt: new Date().toISOString(),
    mode: input.mode,
    kind: input.kind,
    classification: input.classification,
    direction: input.direction,
    connectionId: input.connectionId,
    profile: input.profile,
    method: input.method,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.requestIdFingerprint
      ? { requestIdFingerprint: input.requestIdFingerprint }
      : {}),
    wireBytes: Math.max(0, Math.floor(input.wireBytes)),
    count: 1,
  };
}

function estimateRecordBytes(record: CodexBridgeJournalRecord): number {
  return Buffer.byteLength(JSON.stringify(record)) + 32;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return selected;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return selected;
}

function classifyWriterFailure(
  error: unknown,
): "lease" | "open" | "write" | "rotate" {
  if (error instanceof CodexBridgeWriterError) return error.stage;
  if (isNodeError(error) && error.code === "EEXIST") return "lease";
  return "write";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function withTimeout(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await operation;
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    operation.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return completed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

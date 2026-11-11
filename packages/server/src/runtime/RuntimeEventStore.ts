import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  type RecordIdentity,
  RuntimeEventSessionIndex,
  isJournalFileName,
  parseIdentity,
} from "./RuntimeEventSessionIndex.js";
import { forEachJournalLine } from "./journal-lines.js";
import type { RuntimeEventRecord, RuntimeReplayOptions } from "./types.js";

export interface RuntimeEventStoreOptions {
  eventsDir: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  retentionMs?: number;
}

interface ProcessFileState {
  nextSeq: number;
  size: number;
}

const CLOSE_BRACE = 0x7d;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function safeProcessId(processId: string): string {
  return processId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseRecord(line: Buffer): RuntimeEventRecord | null {
  try {
    const record = JSON.parse(line.toString("utf8")) as RuntimeEventRecord;
    return Number.isSafeInteger(record.seq) &&
      typeof record.processId === "string" &&
      typeof record.sessionId === "string" &&
      typeof record.type === "string"
      ? record
      : null;
  } catch {
    // Ignore a partial final line left by an interrupted append.
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class RuntimeEventStore {
  private readonly eventsDir: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retentionMs: number;
  private readonly states = new Map<string, Promise<ProcessFileState>>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private initializePromise: Promise<void> | null = null;
  /** Session-to-process lookup without re-parsing every retained journal. */
  private readonly sessionIndex: RuntimeEventSessionIndex;

  constructor(options: RuntimeEventStoreOptions) {
    this.eventsDir = options.eventsDir;
    this.sessionIndex = new RuntimeEventSessionIndex(options.eventsDir);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await mkdir(this.eventsDir, { recursive: true, mode: 0o700 });
        await this.pruneStoredEvents();
      })();
    }
    await this.initializePromise;
  }

  /**
   * Build the session index in the background so the first session lookup
   * after a restart (when every client reconnects at once) is not a full
   * journal scan. Errors only mean the first lookup builds it instead.
   */
  warmSessionIndex(): Promise<void> {
    return this.initialize()
      .then(() => this.sessionIndex.snapshot())
      .then(
        () => undefined,
        () => undefined,
      );
  }

  /**
   * Apply the retention and total-size budget again.
   *
   * `initialize()` only prunes at startup, which is enough for a short-lived
   * runtime worker but not for the embedded runtime inside a server that stays
   * up for weeks: every process writes its own journal file, so the directory
   * would only ever grow between restarts.
   */
  async prune(): Promise<void> {
    await this.initialize();
    await this.pruneStoredEvents();
  }

  private async pruneStoredEvents(): Promise<void> {
    const names = await readdir(this.eventsDir);
    const files = (
      await Promise.all(
        names.filter(isJournalFileName).map(async (name) => {
          const filePath = path.join(this.eventsDir, name);
          const info = await stat(filePath).catch(() => null);
          return info
            ? { filePath, size: info.size, mtimeMs: info.mtimeMs }
            : null;
        }),
      )
    ).filter(
      (file): file is { filePath: string; size: number; mtimeMs: number } =>
        file !== null,
    );

    const cutoff = Date.now() - this.retentionMs;
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const remaining: Array<{
      filePath: string;
      size: number;
      mtimeMs: number;
    }> = [];
    for (const file of files.sort(
      (left, right) => left.mtimeMs - right.mtimeMs,
    )) {
      if (file.mtimeMs < cutoff) {
        await rm(file.filePath, { force: true });
        totalBytes -= file.size;
      } else {
        remaining.push(file);
      }
    }

    for (const file of remaining) {
      if (totalBytes <= this.maxTotalBytes) break;
      await rm(file.filePath, { force: true });
      totalBytes -= file.size;
    }
  }

  private currentPath(processId: string): string {
    return path.join(this.eventsDir, `${safeProcessId(processId)}.jsonl`);
  }

  private rotatedPath(processId: string): string {
    return `${this.currentPath(processId)}.1`;
  }

  /**
   * Records of one journal file, read line by line. `accept` sees only the
   * identity prefix, so rejected lines never have their payload parsed.
   */
  private async readPath(
    filePath: string,
    accept?: (identity: RecordIdentity) => boolean,
  ): Promise<RuntimeEventRecord[]> {
    const records: RuntimeEventRecord[] = [];
    try {
      await forEachJournalLine(
        filePath,
        (line) => {
          if (accept) {
            const identity = parseIdentity(line);
            if (!identity || !accept(identity)) return;
          }
          const record = parseRecord(line);
          if (record) records.push(record);
        },
        { includeTrailing: true },
      );
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return records;
  }

  private async lastSeqIn(filePath: string): Promise<number> {
    let lastSeq = 0;
    try {
      await forEachJournalLine(
        filePath,
        (line) => {
          // A truncated final append never counts as a written record.
          if (line[line.length - 1] !== CLOSE_BRACE) return;
          const identity = parseIdentity(line);
          if (identity) lastSeq = Math.max(lastSeq, identity.seq);
        },
        { includeTrailing: true },
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return lastSeq;
  }

  private getState(processId: string): Promise<ProcessFileState> {
    let state = this.states.get(processId);
    if (!state) {
      state = (async () => {
        await this.initialize();
        const lastSeq = Math.max(
          await this.lastSeqIn(this.rotatedPath(processId)),
          await this.lastSeqIn(this.currentPath(processId)),
        );
        const currentSize = await stat(this.currentPath(processId))
          .then((value) => value.size)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return 0;
            throw error;
          });
        return { nextSeq: lastSeq + 1, size: currentSize };
      })();
      this.states.set(processId, state);
    }
    return state;
  }

  append(input: {
    processId: string;
    sessionId: string;
    type: string;
    data: unknown;
    timestamp?: string;
  }): Promise<RuntimeEventRecord> {
    const previous = this.writes.get(input.processId) ?? Promise.resolve();
    const write = previous.then(async () => {
      const state = await this.getState(input.processId);
      const record: RuntimeEventRecord = {
        seq: state.nextSeq++,
        timestamp: input.timestamp ?? new Date().toISOString(),
        processId: input.processId,
        sessionId: input.sessionId,
        type: input.type,
        data: input.data,
      };
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line);
      const currentPath = this.currentPath(input.processId);

      if (state.size > 0 && state.size + lineBytes > this.maxFileBytes) {
        await rm(this.rotatedPath(input.processId), { force: true });
        await rename(currentPath, this.rotatedPath(input.processId));
        this.sessionIndex.moved(currentPath, this.rotatedPath(input.processId));
        state.size = 0;
      }

      await appendFile(currentPath, line, { encoding: "utf8", mode: 0o600 });
      state.size += lineBytes;
      return record;
    });
    this.writes.set(
      input.processId,
      write.catch(() => {}),
    );
    return write;
  }

  async replay(options: RuntimeReplayOptions): Promise<RuntimeEventRecord[]> {
    if (
      options.allProcesses &&
      (!options.sessionId ||
        options.processId !== undefined ||
        options.afterSeq !== undefined)
    )
      throw new Error(
        "Session history replay requires sessionId without processId or afterSeq",
      );
    const types = options.types?.length ? new Set(options.types) : undefined;
    const { sessionId, processId } = options;
    if (!sessionId && processId === undefined && !types)
      throw new Error("Runtime replay requires sessionId, processId or types");
    await this.initialize();

    let files: string[];
    if (sessionId || processId !== undefined) {
      const targetProcessId =
        processId ??
        (sessionId && !options.allProcesses
          ? await this.findLatestProcessIdForSession(sessionId)
          : undefined);
      const processIds =
        options.allProcesses && sessionId
          ? await this.findProcessIdsForSession(sessionId)
          : targetProcessId !== undefined
            ? [targetProcessId]
            : [];
      files = processIds.flatMap((id) => [
        this.rotatedPath(id),
        this.currentPath(id),
      ]);
    } else {
      files = types ? await this.sessionIndex.filesWithTypes(types) : [];
    }

    const afterSeq = options.afterSeq ?? 0;
    const accept = (identity: RecordIdentity) =>
      (!sessionId || identity.sessionId === sessionId) &&
      identity.seq > afterSeq &&
      (!types || types.has(identity.type));
    const records = (
      await Promise.all(files.map((file) => this.readPath(file, accept)))
    ).flat();

    return records.sort((left, right) => {
      if (left.processId === right.processId) return left.seq - right.seq;
      const byTime = left.timestamp.localeCompare(right.timestamp);
      if (byTime !== 0) return byTime;
      return left.processId.localeCompare(right.processId);
    });
  }

  private findLatestProcessIdForSession(
    sessionId: string,
  ): Promise<string | undefined> {
    return this.sessionIndex.latestProcessIdForSession(sessionId);
  }

  private findProcessIdsForSession(sessionId: string): Promise<string[]> {
    return this.sessionIndex.processIdsForSession(sessionId);
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }
}

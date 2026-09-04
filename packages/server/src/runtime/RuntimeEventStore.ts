import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
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

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function safeProcessId(processId: string): string {
  return processId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseRecords(content: string): RuntimeEventRecord[] {
  const records: RuntimeEventRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as RuntimeEventRecord;
      if (
        Number.isSafeInteger(record.seq) &&
        typeof record.processId === "string" &&
        typeof record.sessionId === "string" &&
        typeof record.type === "string"
      ) {
        records.push(record);
      }
    } catch {
      // Ignore a partial final line left by an interrupted append.
    }
  }
  return records;
}

export class RuntimeEventStore {
  private readonly eventsDir: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retentionMs: number;
  private readonly states = new Map<string, Promise<ProcessFileState>>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private initializePromise: Promise<void> | null = null;

  constructor(options: RuntimeEventStoreOptions) {
    this.eventsDir = options.eventsDir;
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
        names
          .filter(
            (name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.1"),
          )
          .map(async (name) => {
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

  private async readPath(filePath: string): Promise<RuntimeEventRecord[]> {
    try {
      return parseRecords(await readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private getState(processId: string): Promise<ProcessFileState> {
    let state = this.states.get(processId);
    if (!state) {
      state = (async () => {
        await this.initialize();
        const records = [
          ...(await this.readPath(this.rotatedPath(processId))),
          ...(await this.readPath(this.currentPath(processId))),
        ];
        const lastSeq = records.reduce(
          (max, record) => Math.max(max, record.seq),
          0,
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
    await this.initialize();
    const processId =
      options.processId ??
      (options.sessionId
        ? await this.findLatestProcessIdForSession(options.sessionId)
        : undefined);
    const processIds = processId
      ? [processId]
      : options.sessionId
        ? []
        : await this.findProcessIdsForSession(undefined);
    const records = (
      await Promise.all(
        processIds.map(async (id) => [
          ...(await this.readPath(this.rotatedPath(id))),
          ...(await this.readPath(this.currentPath(id))),
        ]),
      )
    )
      .flat()
      .filter(
        (record) =>
          (!options.sessionId || record.sessionId === options.sessionId) &&
          record.seq > (options.afterSeq ?? 0),
      );

    return records.sort((left, right) => {
      if (left.processId === right.processId) return left.seq - right.seq;
      const byTime = left.timestamp.localeCompare(right.timestamp);
      if (byTime !== 0) return byTime;
      return left.processId.localeCompare(right.processId);
    });
  }

  private async findLatestProcessIdForSession(
    sessionId: string,
  ): Promise<string | undefined> {
    const names = await readdir(this.eventsDir).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const latestByProcess = new Map<
      string,
      { seq: number; timestamp: string }
    >();
    for (const name of names) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.1")) continue;
      const records = await this.readPath(path.join(this.eventsDir, name));
      for (const record of records) {
        if (record.sessionId !== sessionId) continue;
        const current = latestByProcess.get(record.processId);
        if (!current || record.seq > current.seq) {
          latestByProcess.set(record.processId, {
            seq: record.seq,
            timestamp: record.timestamp,
          });
        }
      }
    }

    let latest: { processId: string; timestamp: string } | undefined;
    for (const [processId, record] of latestByProcess) {
      if (
        !latest ||
        record.timestamp > latest.timestamp ||
        (record.timestamp === latest.timestamp && processId > latest.processId)
      ) {
        latest = { processId, timestamp: record.timestamp };
      }
    }
    return latest?.processId;
  }

  private async findProcessIdsForSession(
    sessionId: string | undefined,
  ): Promise<string[]> {
    const names = await readdir(this.eventsDir).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const processIds = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.1")) continue;
      const records = await this.readPath(path.join(this.eventsDir, name));
      for (const record of records) {
        if (!sessionId || record.sessionId === sessionId) {
          processIds.add(record.processId);
        }
      }
    }
    return [...processIds];
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }
}

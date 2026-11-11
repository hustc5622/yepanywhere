import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { forEachJournalLine } from "./journal-lines.js";
import type { RuntimeEventRecord } from "./types.js";

/** Latest record a journal file holds for one (session, process) pair. */
export interface RuntimeEventPosition {
  seq: number;
  timestamp: string;
}

interface FileSummary {
  ino: number;
  /** Bytes consumed so far; always ends on a complete line. */
  offset: number;
  sessions: Map<string, Map<string, RuntimeEventPosition>>;
  /** Record types present in the consumed part of the file. */
  types: Set<string>;
}

export type RuntimeEventIndexSnapshot = ReadonlyMap<
  string,
  ReadonlyMap<string, RuntimeEventPosition>
>;

const CLOSE_BRACE = 0x7d;
/**
 * `RuntimeEventStore.append` serializes records with these keys first, so the
 * identity fields sit before the (potentially huge) `data` payload. Matching
 * the prefix avoids decoding and parsing the payload of every retained line.
 */
const RECORD_PREFIX_BYTES = 1024;
/**
 * An interrupted append leaves a partial record that the next append is
 * glued onto. Such a line holds a second record start; the full parse below
 * rejects it exactly like the replay reader does.
 */
const RECORD_START = Buffer.from('{"seq":');
const RECORD_PREFIX =
  /^\{"seq":(\d+),"timestamp":("(?:[^"\\]|\\.)*"),"processId":("(?:[^"\\]|\\.)*"),"sessionId":("(?:[^"\\]|\\.)*"),"type":("(?:[^"\\]|\\.)*")/;

export interface RecordIdentity {
  seq: number;
  timestamp: string;
  processId: string;
  sessionId: string;
  type: string;
}

function validIdentity(
  value: Partial<RuntimeEventRecord>,
): value is RecordIdentity {
  return (
    Number.isSafeInteger(value.seq) &&
    typeof value.timestamp === "string" &&
    typeof value.processId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.type === "string"
  );
}

/** Identity fields of one journal line; falls back to a full parse. */
export function parseIdentity(line: Buffer): RecordIdentity | null {
  const head = line
    .subarray(0, Math.min(line.length, RECORD_PREFIX_BYTES))
    .toString("utf8");
  const match =
    line.indexOf(RECORD_START, 1) === -1 ? RECORD_PREFIX.exec(head) : null;
  if (match) {
    try {
      const value = {
        seq: Number(match[1]),
        timestamp: JSON.parse(match[2] as string),
        processId: JSON.parse(match[3] as string),
        sessionId: JSON.parse(match[4] as string),
        type: JSON.parse(match[5] as string),
      };
      if (validIdentity(value)) return value;
    } catch {
      // Fall through to the complete parse below.
    }
  }
  try {
    const value = JSON.parse(
      line.toString("utf8"),
    ) as Partial<RuntimeEventRecord>;
    return validIdentity(value)
      ? {
          seq: value.seq,
          timestamp: value.timestamp,
          processId: value.processId,
          sessionId: value.sessionId,
          type: value.type,
        }
      : null;
  } catch {
    return null;
  }
}

export function isJournalFileName(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".jsonl.1");
}

/**
 * Incremental `sessionId -> processId -> latest position` index over the
 * per-process runtime journal files.
 *
 * Finding which processes served a session used to read and JSON-parse every
 * retained journal on each lookup. Journal files are append-only between
 * rotations (`x.jsonl` is renamed to `x.jsonl.1` and a new inode starts), so
 * each file is summarized once and later lookups only stat the directory:
 * unchanged files are reused, appended files are read from their consumed
 * offset, and replaced, truncated or deleted files are rescanned or dropped.
 * Concurrent lookups share one refresh.
 */
export class RuntimeEventSessionIndex {
  private readonly files = new Map<string, FileSummary>();
  private running: Promise<RuntimeEventIndexSnapshot> | null = null;
  private queued: Promise<RuntimeEventIndexSnapshot> | null = null;
  /** Full-file or tail bytes read; exposed for tests and diagnostics. */
  scannedBytes = 0;

  constructor(private readonly eventsDir: string) {}

  /**
   * Current index. Refreshes never overlap. A lookup arriving while one is in
   * flight cannot trust it (it may have stat'ed a file before the caller's
   * append), so all such lookups share exactly one follow-up refresh.
   */
  snapshot(): Promise<RuntimeEventIndexSnapshot> {
    if (!this.running) return this.start();
    if (!this.queued)
      this.queued = this.running
        .catch(() => undefined)
        .then(() => {
          this.queued = null;
          return this.start();
        });
    return this.queued;
  }

  private start(): Promise<RuntimeEventIndexSnapshot> {
    const task: Promise<RuntimeEventIndexSnapshot> = this.refresh().finally(
      () => {
        if (this.running === task) this.running = null;
      },
    );
    this.running = task;
    return task;
  }

  /**
   * Journal file `from` was renamed to `to` by the owning store (rotation).
   * The inode is unchanged, so its summary stays valid under the new name.
   * A refresh running concurrently is harmless: it re-validates by inode.
   */
  moved(from: string, to: string): void {
    const summary = this.files.get(from);
    this.files.delete(from);
    this.files.delete(to);
    if (summary) this.files.set(to, summary);
  }

  async processIdsForSession(sessionId: string): Promise<string[]> {
    const index = await this.snapshot();
    return [...(index.get(sessionId)?.keys() ?? [])];
  }

  async allProcessIds(): Promise<string[]> {
    const index = await this.snapshot();
    const ids = new Set<string>();
    for (const processes of index.values())
      for (const processId of processes.keys()) ids.add(processId);
    return [...ids];
  }

  /** Journal files holding at least one record of the given types. */
  async filesWithTypes(types: ReadonlySet<string>): Promise<string[]> {
    await this.snapshot();
    const files: string[] = [];
    for (const [filePath, summary] of this.files) {
      for (const type of types) {
        if (summary.types.has(type)) {
          files.push(filePath);
          break;
        }
      }
    }
    return files;
  }

  async latestProcessIdForSession(
    sessionId: string,
  ): Promise<string | undefined> {
    const processes = (await this.snapshot()).get(sessionId);
    let latest: { processId: string; timestamp: string } | undefined;
    for (const [processId, position] of processes ?? []) {
      if (
        !latest ||
        position.timestamp > latest.timestamp ||
        (position.timestamp === latest.timestamp &&
          processId > latest.processId)
      )
        latest = { processId, timestamp: position.timestamp };
    }
    return latest?.processId;
  }

  private async refresh(): Promise<RuntimeEventIndexSnapshot> {
    const names = await readdir(this.eventsDir).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      },
    );
    const present = new Set<string>();
    for (const name of names) {
      if (!isJournalFileName(name)) continue;
      const filePath = path.join(this.eventsDir, name);
      present.add(filePath);
      await this.refreshFile(filePath);
    }
    for (const filePath of this.files.keys())
      if (!present.has(filePath)) this.files.delete(filePath);
    return this.merge();
  }

  private async refreshFile(filePath: string): Promise<void> {
    const info = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) {
      this.files.delete(filePath);
      return;
    }
    let summary = this.files.get(filePath);
    if (!summary || summary.ino !== info.ino || info.size < summary.offset) {
      summary = {
        ino: info.ino,
        offset: 0,
        sessions: new Map(),
        types: new Set(),
      };
      this.files.set(filePath, summary);
    }
    if (info.size === summary.offset) return;
    await this.consume(filePath, summary, info.size);
  }

  /** Read complete lines from `summary.offset` up to `size`. */
  private async consume(
    filePath: string,
    summary: FileSummary,
    size: number,
  ): Promise<void> {
    try {
      // Only complete lines advance `offset`.
      summary.offset = await forEachJournalLine(
        filePath,
        (line) => this.indexLine(summary, line),
        {
          start: summary.offset,
          end: size,
          onBytesRead: (bytes) => {
            this.scannedBytes += bytes;
          },
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.files.delete(filePath);
        return;
      }
      throw error;
    }
  }

  private indexLine(summary: FileSummary, line: Buffer): void {
    if (line.length === 0) return;
    // A whole serialized record always ends its object on this line.
    if (line[line.length - 1] !== CLOSE_BRACE) return;
    const record = parseIdentity(line);
    if (!record) return;
    summary.types.add(record.type);
    let processes = summary.sessions.get(record.sessionId);
    if (!processes) {
      processes = new Map();
      summary.sessions.set(record.sessionId, processes);
    }
    const current = processes.get(record.processId);
    if (!current || record.seq > current.seq)
      processes.set(record.processId, {
        seq: record.seq,
        timestamp: record.timestamp,
      });
  }

  private merge(): RuntimeEventIndexSnapshot {
    const merged = new Map<string, Map<string, RuntimeEventPosition>>();
    for (const summary of this.files.values()) {
      for (const [sessionId, processes] of summary.sessions) {
        let target = merged.get(sessionId);
        if (!target) {
          target = new Map();
          merged.set(sessionId, target);
        }
        for (const [processId, position] of processes) {
          const current = target.get(processId);
          if (!current || position.seq > current.seq)
            target.set(processId, position);
        }
      }
    }
    return merged;
  }
}

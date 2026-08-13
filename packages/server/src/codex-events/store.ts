import type { Stats } from "node:fs";
import {
  type FileHandle,
  appendFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  CODEX_EVENT_SCHEMA_NAME,
  CODEX_EVENT_SCHEMA_VERSION,
  type CodexEventDraft,
  type CodexEventEnvelope,
} from "./types.js";

export interface CodexEventAppendResult {
  event: CodexEventEnvelope;
  inserted: boolean;
}

export interface CodexEventReplayQuery {
  sessionId: string;
  afterSequence?: number;
  throughSequence?: number;
  /** Filter before cloning so lightweight readers do not materialize a full session journal. */
  methods?: readonly string[];
}

export interface CodexEventStore {
  append(event: CodexEventDraft): Promise<CodexEventAppendResult>;
  appendMany(
    events: readonly CodexEventDraft[],
  ): Promise<CodexEventAppendResult[]>;
  replay(query: CodexEventReplayQuery): Promise<CodexEventEnvelope[]>;
  latestSequence(sessionId: string): Promise<number>;
}

export interface InMemoryCodexEventStoreOptions {
  now?: () => number;
}

/**
 * Deterministic reference store for tests, shadow projection and embedded
 * callers. Persistent adapters can implement the same append/replay contract
 * with JSONL or a database without changing the reducer.
 */
export class InMemoryCodexEventStore implements CodexEventStore {
  private readonly now: () => number;
  private readonly eventsBySession = new Map<string, CodexEventEnvelope[]>();
  private readonly eventsBySessionMethod = new Map<
    string,
    CodexEventEnvelope[]
  >();
  private readonly eventsByIdentity = new Map<string, CodexEventEnvelope>();
  private readonly eventsByDedupeKey = new Map<string, CodexEventEnvelope>();

  constructor(options: InMemoryCodexEventStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async append(event: CodexEventDraft): Promise<CodexEventAppendResult> {
    const identityKey = this.identityKey(event.sessionId, event.eventId);
    const existingById = this.eventsByIdentity.get(identityKey);
    if (existingById) {
      return { event: structuredClone(existingById), inserted: false };
    }

    if (event.dedupeKey) {
      const existingByDedupe = this.eventsByDedupeKey.get(
        this.identityKey(event.sessionId, event.dedupeKey),
      );
      if (existingByDedupe) {
        return { event: structuredClone(existingByDedupe), inserted: false };
      }
    }

    const sessionEvents = this.eventsBySession.get(event.sessionId) ?? [];
    const persisted: CodexEventEnvelope = {
      ...structuredClone(event),
      persistedAtMs: this.now(),
      sequence: (sessionEvents.at(-1)?.sequence ?? 0) + 1,
    };
    sessionEvents.push(persisted);
    this.eventsBySession.set(event.sessionId, sessionEvents);
    const methodKey = this.methodKey(event.sessionId, event.method);
    const methodEvents = this.eventsBySessionMethod.get(methodKey) ?? [];
    methodEvents.push(persisted);
    this.eventsBySessionMethod.set(methodKey, methodEvents);
    this.eventsByIdentity.set(identityKey, persisted);
    if (event.dedupeKey) {
      this.eventsByDedupeKey.set(
        this.identityKey(event.sessionId, event.dedupeKey),
        persisted,
      );
    }
    return { event: structuredClone(persisted), inserted: true };
  }

  async appendMany(
    events: readonly CodexEventDraft[],
  ): Promise<CodexEventAppendResult[]> {
    const results: CodexEventAppendResult[] = [];
    for (const event of events) results.push(await this.append(event));
    return results;
  }

  async replay(query: CodexEventReplayQuery): Promise<CodexEventEnvelope[]> {
    const after = query.afterSequence ?? 0;
    const through = query.throughSequence ?? Number.MAX_SAFE_INTEGER;
    const methods = query.methods ? new Set(query.methods) : null;
    const events = methods
      ? [...methods]
          .flatMap(
            (method) =>
              this.eventsBySessionMethod.get(
                this.methodKey(query.sessionId, method),
              ) ?? [],
          )
          .sort(compareStoredEvents)
      : (this.eventsBySession.get(query.sessionId) ?? []);
    return events
      .filter((event) => event.sequence > after && event.sequence <= through)
      .map((event) => structuredClone(event));
  }

  async latestSequence(sessionId: string): Promise<number> {
    return this.eventsBySession.get(sessionId)?.at(-1)?.sequence ?? 0;
  }

  private identityKey(sessionId: string, identity: string): string {
    return `${sessionId}\0${identity}`;
  }

  private methodKey(sessionId: string, method: string): string {
    return `${sessionId}\0${method}`;
  }
}

export interface JsonlCodexEventStoreOptions {
  filePath: string;
  now?: () => number;
  /** Called for a malformed historical line. No raw line is exposed. */
  onCorruptLine?: (details: { lineNumber: number; reason: string }) => void;
  /** Full-load read chunk size in bytes. Overridable for tests. */
  loadChunkBytes?: number;
  /**
   * Size-based journal rotation. When the active file reaches `maxBytes`,
   * the next append first renames it to a timestamped segment and prunes
   * closed segments beyond `keepSegments`. `maxBytes <= 0` disables rotation.
   */
  rotation?: {
    maxBytes?: number;
    keepSegments?: number;
  };
  /** Called after a successful rotation with the pruned segment paths. */
  onRotate?: (details: { from: string; to: string; pruned: string[] }) => void;
}

interface CodexEventFileSnapshot {
  size: number;
  mtimeMs: number;
  identity: string;
}

/** Full-load read chunk size; keeps any single journal loadable regardless of total size. */
const DEFAULT_LOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Default rotation waterline: 256 MiB per active journal. */
const DEFAULT_ROTATE_MAX_BYTES = 256 * 1024 * 1024;

/** Default number of closed segments retained after rotation. */
const DEFAULT_ROTATE_KEEP_SEGMENTS = 3;

/**
 * Optional append-only durable store. It hydrates its indexes once, serializes
 * concurrent appends, and uses the same replay contract as the in-memory
 * implementation. The payload reaching this class must already be redacted.
 */
export class JsonlCodexEventStore implements CodexEventStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly onCorruptLine?: JsonlCodexEventStoreOptions["onCorruptLine"];
  private readonly loadChunkBytes: number;
  private readonly rotateMaxBytes: number;
  private readonly rotateKeepSegments: number;
  private readonly onRotate?: JsonlCodexEventStoreOptions["onRotate"];
  private readonly eventsBySession = new Map<string, CodexEventEnvelope[]>();
  private readonly eventsBySessionMethod = new Map<
    string,
    CodexEventEnvelope[]
  >();
  private readonly eventsByIdentity = new Map<string, CodexEventEnvelope>();
  private readonly eventsByDedupeKey = new Map<string, CodexEventEnvelope>();
  private loaded: Promise<void> | null = null;
  private appendTail: Promise<void> = Promise.resolve();
  private needsAppendSeparator = false;
  private lastKnownFileSize = 0;
  private lastKnownMtimeMs = 0;
  private lastKnownFileIdentity: string | null = null;

  constructor(options: JsonlCodexEventStoreOptions) {
    if (!options.filePath.trim()) {
      throw new Error("Codex JSONL event store requires a non-empty filePath");
    }
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.onCorruptLine = options.onCorruptLine;
    this.loadChunkBytes = Math.max(
      1,
      options.loadChunkBytes ?? DEFAULT_LOAD_CHUNK_BYTES,
    );
    this.rotateMaxBytes =
      options.rotation?.maxBytes ?? DEFAULT_ROTATE_MAX_BYTES;
    this.rotateKeepSegments = Math.max(
      0,
      options.rotation?.keepSegments ?? DEFAULT_ROTATE_KEEP_SEGMENTS,
    );
    this.onRotate = options.onRotate;
  }

  async append(event: CodexEventDraft): Promise<CodexEventAppendResult> {
    await this.ensureLoaded();
    return await this.withAppendLock(async () => {
      // A different process or store instance may have appended or replaced
      // the journal since this instance loaded it. Refresh under the same lock
      // used by local appends so sequence assignment and indexes stay current.
      await this.refreshFromDisk();
      await this.rotateIfNeeded();
      const existing = this.findExisting(event);
      if (existing) {
        return { event: structuredClone(existing), inserted: false };
      }

      const sessionEvents = this.eventsBySession.get(event.sessionId) ?? [];
      const persisted: CodexEventEnvelope = {
        ...structuredClone(event),
        persistedAtMs: this.now(),
        sequence: (sessionEvents.at(-1)?.sequence ?? 0) + 1,
      };
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(
        this.filePath,
        `${this.needsAppendSeparator ? "\n" : ""}${JSON.stringify(persisted)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      this.needsAppendSeparator = false;
      this.index(persisted);
      // Deliberately leave the file snapshot at its pre-append boundary. The
      // next refresh will read this line (and any concurrent external lines)
      // from that exact offset, deduplicating the event already indexed here.
      // A post-append stat could otherwise advance past an external append
      // that raced between our write and the stat, permanently hiding it.
      return { event: structuredClone(persisted), inserted: true };
    });
  }

  async appendMany(
    events: readonly CodexEventDraft[],
  ): Promise<CodexEventAppendResult[]> {
    const results: CodexEventAppendResult[] = [];
    for (const event of events) results.push(await this.append(event));
    return results;
  }

  async replay(query: CodexEventReplayQuery): Promise<CodexEventEnvelope[]> {
    await this.ensureLoaded();
    return await this.withAppendLock(async () => {
      await this.refreshFromDisk();
      const after = query.afterSequence ?? 0;
      const through = query.throughSequence ?? Number.MAX_SAFE_INTEGER;
      const methods = query.methods ? new Set(query.methods) : null;
      const events = methods
        ? [...methods]
            .flatMap(
              (method) =>
                this.eventsBySessionMethod.get(
                  this.methodKey(query.sessionId, method),
                ) ?? [],
            )
            .sort(compareStoredEvents)
        : (this.eventsBySession.get(query.sessionId) ?? []);
      return events
        .filter((event) => event.sequence > after && event.sequence <= through)
        .map((event) => structuredClone(event));
    });
  }

  async latestSequence(sessionId: string): Promise<number> {
    await this.ensureLoaded();
    return await this.withAppendLock(async () => {
      await this.refreshFromDisk();
      return this.eventsBySession.get(sessionId)?.at(-1)?.sequence ?? 0;
    });
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    try {
      await this.loaded;
    } catch (error) {
      // A failed cold load must not poison the store for the rest of the
      // process lifetime. Drop the cached promise so the next caller retries
      // (e.g. after an unreadable journal has been rotated away).
      this.loaded = null;
      throw error;
    }
  }

  /**
   * Check if the backing file has grown since the last load. If so, read only
   * the new tail and index it, avoiding a full-file re-read on every replay.
   *
   * Truncate/rotate detection: if the file size is smaller than what we last
   * saw, or the mtime went backwards, we fall back to a full reload.
   */
  private async refreshFromDisk(): Promise<void> {
    let snapshot: CodexEventFileSnapshot;
    try {
      snapshot = fileSnapshot(await stat(this.filePath));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        // The active journal may have been rotated away by the writer
        // process: fall back to a full load, which picks up the retained
        // segment files (or resets to empty when nothing exists).
        this.loaded = this.load();
        await this.loaded;
        return;
      }
      throw error;
    }

    // File hasn't changed since we last loaded it.
    if (
      snapshot.size === this.lastKnownFileSize &&
      snapshot.mtimeMs === this.lastKnownMtimeMs &&
      snapshot.identity === this.lastKnownFileIdentity
    ) {
      return;
    }

    // Replacement, truncation, or an in-place rewrite requires an atomic full
    // reload. Size alone cannot identify rotation because the new file may be
    // equal to or larger than the previous one.
    if (
      (this.lastKnownFileIdentity !== null &&
        snapshot.identity !== this.lastKnownFileIdentity) ||
      snapshot.size < this.lastKnownFileSize ||
      snapshot.mtimeMs < this.lastKnownMtimeMs ||
      (snapshot.size === this.lastKnownFileSize &&
        snapshot.mtimeMs !== this.lastKnownMtimeMs)
    ) {
      this.loaded = this.load();
      await this.loaded;
      return;
    }

    // File grew: read only the new tail bytes.
    if (snapshot.size > this.lastKnownFileSize) {
      await this.loadTail(snapshot);
    }
  }

  private async loadTail(
    expectedSnapshot: CodexEventFileSnapshot,
  ): Promise<void> {
    const previousSize = this.lastKnownFileSize;
    const tailLength = expectedSnapshot.size - previousSize;
    if (tailLength <= 0) return;

    let tailContents: string;
    let handle: FileHandle | null = null;
    let openedSnapshot: CodexEventFileSnapshot | null = null;
    let reloadRequired = false;
    try {
      handle = await open(this.filePath, "r");
      openedSnapshot = fileSnapshot(await handle.stat());
      if (
        openedSnapshot.identity !== expectedSnapshot.identity ||
        // A null identity baseline means the journal started empty or was
        // just rotated by this instance: the active file's whole contents are
        // exactly the tail to read, and already-indexed lines dedupe below.
        (this.lastKnownFileIdentity !== null &&
          openedSnapshot.identity !== this.lastKnownFileIdentity) ||
        openedSnapshot.size < previousSize
      ) {
        reloadRequired = true;
        tailContents = "";
      } else {
        const openedTailLength = openedSnapshot.size - previousSize;
        const buffer = Buffer.alloc(openedTailLength);
        let bytesRead = 0;
        while (bytesRead < openedTailLength) {
          const result = await handle.read(
            buffer,
            bytesRead,
            openedTailLength - bytesRead,
            previousSize + bytesRead,
          );
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        if (bytesRead !== openedTailLength) {
          reloadRequired = true;
          tailContents = "";
        } else {
          tailContents = buffer.toString("utf8");
        }
      }
    } catch {
      reloadRequired = true;
      tailContents = "";
    } finally {
      await handle?.close();
    }
    if (reloadRequired || !openedSnapshot) {
      this.loaded = this.load();
      await this.loaded;
      return;
    }

    // The previous file may have lacked a trailing newline, so the first byte
    // of the new tail could be a continuation of a partial record. We handle
    // this by skipping the first line if it doesn't parse (it's likely a
    // partial record from the previous boundary).
    const lines = tailContents.split("\n");
    let skippedFirst = false;
    const touchedSessions = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        // Partial record at the boundary; skip it.
        if (index === 0 && !skippedFirst) {
          skippedFirst = true;
          continue;
        }
        this.onCorruptLine?.({
          lineNumber: -1,
          reason: "invalid_json",
        });
        continue;
      }
      if (!isCodexEventEnvelope(parsed)) {
        this.onCorruptLine?.({ lineNumber: -1, reason: "invalid_envelope" });
        continue;
      }
      const existing = this.findExisting(parsed);
      if (!existing) {
        this.index(parsed);
        touchedSessions.add(parsed.sessionId);
      }
    }
    for (const sessionId of touchedSessions) {
      this.sortSessionEvents(sessionId);
    }
    this.lastKnownFileSize = openedSnapshot.size;
    this.lastKnownMtimeMs = openedSnapshot.mtimeMs;
    this.lastKnownFileIdentity = openedSnapshot.identity;
    this.needsAppendSeparator = !tailContents.endsWith("\n");
  }

  private async load(): Promise<void> {
    const journalFiles = await this.listJournalFiles();
    // Hydrate from a clean slate. A failed read mid-load leaves partial
    // indexes, but the error propagates and the next caller retries a full
    // load (ensureLoaded no longer caches rejections).
    this.resetLoadedState();
    if (journalFiles.length === 0) {
      return;
    }
    for (const file of journalFiles) {
      const result = await this.loadJournalFile(file);
      if (file === this.filePath && result) {
        // A valid JSONL file may omit its final newline, and a crashed writer
        // may leave a partial final record. Either way, the next append must
        // start on a fresh line or it corrupts both the old tail and the new
        // event.
        this.needsAppendSeparator =
          result.bytesRead > 0 && !result.endsWithNewline;
        this.lastKnownFileSize = result.bytesRead;
        this.lastKnownMtimeMs = result.snapshot.mtimeMs;
        this.lastKnownFileIdentity = result.snapshot.identity;
      }
    }
    for (const sessionId of this.eventsBySession.keys()) {
      this.sortSessionEvents(sessionId);
    }
  }

  /**
   * Read one journal file in bounded chunks rather than a single readFile: a
   * journal larger than the runtime's maximum string length must still load.
   * The decoder keeps multi-byte characters intact across chunks. Returns
   * null when the file vanished (e.g. a segment pruned by another process).
   */
  private async loadJournalFile(filePath: string): Promise<{
    snapshot: CodexEventFileSnapshot;
    bytesRead: number;
    endsWithNewline: boolean;
  } | null> {
    let handle: FileHandle | null = null;
    try {
      handle = await open(filePath, "r");
      const snapshot = fileSnapshot(await handle.stat());
      const decoder = new StringDecoder("utf8");
      const chunk = Buffer.allocUnsafe(this.loadChunkBytes);
      let bytesRead = 0;
      let endsWithNewline = false;
      let carry = "";
      let lineNumber = 0;
      while (true) {
        const result = await handle.read(chunk, 0, chunk.length, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
        endsWithNewline = chunk[result.bytesRead - 1] === 0x0a;
        carry += decoder.write(chunk.subarray(0, result.bytesRead));
        let newlineIndex = carry.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = carry.slice(0, newlineIndex);
          carry = carry.slice(newlineIndex + 1);
          lineNumber += 1;
          this.indexLoadedLine(line, lineNumber);
          newlineIndex = carry.indexOf("\n");
        }
      }
      carry += decoder.end();
      if (carry.length > 0) {
        lineNumber += 1;
        this.indexLoadedLine(carry, lineNumber);
      }
      return { snapshot, bytesRead, endsWithNewline };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /**
   * Rename the active journal to a timestamped segment once it reaches the
   * configured waterline, then prune closed segments beyond the retention
   * count. In-memory indexes deliberately keep the rotated events so replay,
   * dedupe, and per-session sequences stay continuous within this process.
   */
  private async rotateIfNeeded(): Promise<void> {
    if (!(this.rotateMaxBytes > 0)) return;
    if (this.lastKnownFileSize < this.rotateMaxBytes) return;
    const segmentPath = await this.nextSegmentPath();
    await rename(this.filePath, segmentPath);
    // The active journal starts over; the next append recreates it and the
    // following refresh reads the new file from offset 0, deduplicating the
    // lines this instance already indexed.
    this.lastKnownFileSize = 0;
    this.lastKnownMtimeMs = 0;
    this.lastKnownFileIdentity = null;
    this.needsAppendSeparator = false;
    const pruned = await this.pruneSegments();
    this.onRotate?.({ from: this.filePath, to: segmentPath, pruned });
  }

  /** Segment names carry a fixed-width UTC timestamp so name order is time order. */
  private async nextSegmentPath(): Promise<string> {
    const stamp = new Date(this.now()).toISOString().replace(/\D/g, "");
    for (let attempt = 1; ; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const candidate = join(
        dirname(this.filePath),
        `${this.segmentBaseName()}.${stamp}${suffix}.jsonl`,
      );
      try {
        await stat(candidate);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return candidate;
        }
        throw error;
      }
    }
  }

  private async pruneSegments(): Promise<string[]> {
    const segments = await this.listSegmentFiles();
    const excess = segments.length - this.rotateKeepSegments;
    if (excess <= 0) return [];
    const pruned: string[] = [];
    for (const segment of segments.slice(0, excess)) {
      try {
        await rm(segment);
        pruned.push(segment);
      } catch {
        // Best-effort: a locked or already-removed segment must not block appends.
      }
    }
    return pruned;
  }

  /** Closed segments in chronological order followed by the active journal. */
  private async listJournalFiles(): Promise<string[]> {
    const segments = await this.listSegmentFiles();
    try {
      await stat(this.filePath);
      return [...segments, this.filePath];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return segments;
      }
      throw error;
    }
  }

  private async listSegmentFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(dirname(this.filePath));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const pattern = new RegExp(
      `^${escapeRegExp(this.segmentBaseName())}\\.\\d{17}(-\\d+)?\\.jsonl$`,
    );
    return entries
      .filter((entry) => pattern.test(entry))
      .sort()
      .map((entry) => join(dirname(this.filePath), entry));
  }

  private segmentBaseName(): string {
    return basename(this.filePath, ".jsonl");
  }

  private indexLoadedLine(rawLine: string, lineNumber: number): void {
    const line = rawLine.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.onCorruptLine?.({
        lineNumber,
        // Modern runtimes may include a source excerpt in JSON.parse errors.
        // Keep the callback diagnostic fixed so corrupt secret-bearing lines
        // can never be copied into logs.
        reason: "invalid_json",
      });
      return;
    }
    if (!isCodexEventEnvelope(parsed)) {
      this.onCorruptLine?.({
        lineNumber,
        reason: "invalid_envelope",
      });
      return;
    }
    const existing = this.findExisting(parsed);
    if (!existing) this.index(parsed);
  }

  private resetLoadedState(): void {
    this.eventsBySession.clear();
    this.eventsBySessionMethod.clear();
    this.eventsByIdentity.clear();
    this.eventsByDedupeKey.clear();
    this.needsAppendSeparator = false;
    this.lastKnownFileSize = 0;
    this.lastKnownMtimeMs = 0;
    this.lastKnownFileIdentity = null;
  }

  private sortSessionEvents(sessionId: string): void {
    this.eventsBySession
      .get(sessionId)
      ?.sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.eventId.localeCompare(right.eventId),
      );
  }

  private findExisting(
    event: Pick<CodexEventDraft, "sessionId" | "eventId" | "dedupeKey">,
  ): CodexEventEnvelope | undefined {
    const byId = this.eventsByIdentity.get(
      this.identityKey(event.sessionId, event.eventId),
    );
    if (byId) return byId;
    return event.dedupeKey
      ? this.eventsByDedupeKey.get(
          this.identityKey(event.sessionId, event.dedupeKey),
        )
      : undefined;
  }

  private index(event: CodexEventEnvelope): void {
    const events = this.eventsBySession.get(event.sessionId) ?? [];
    events.push(event);
    this.eventsBySession.set(event.sessionId, events);
    const methodKey = this.methodKey(event.sessionId, event.method);
    const methodEvents = this.eventsBySessionMethod.get(methodKey) ?? [];
    methodEvents.push(event);
    this.eventsBySessionMethod.set(methodKey, methodEvents);
    this.eventsByIdentity.set(
      this.identityKey(event.sessionId, event.eventId),
      event,
    );
    if (event.dedupeKey) {
      this.eventsByDedupeKey.set(
        this.identityKey(event.sessionId, event.dedupeKey),
        event,
      );
    }
  }

  private async withAppendLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.appendTail;
    let release: () => void = () => undefined;
    this.appendTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private identityKey(sessionId: string, identity: string): string {
    return `${sessionId}\0${identity}`;
  }

  private methodKey(sessionId: string, method: string): string {
    return `${sessionId}\0${method}`;
  }
}

function compareStoredEvents(
  left: CodexEventEnvelope,
  right: CodexEventEnvelope,
): number {
  return (
    left.sequence - right.sequence || left.eventId.localeCompare(right.eventId)
  );
}

function isCodexEventEnvelope(value: unknown): value is CodexEventEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<CodexEventEnvelope>;
  return (
    event.schema?.name === CODEX_EVENT_SCHEMA_NAME &&
    event.schema.version === CODEX_EVENT_SCHEMA_VERSION &&
    event.provider === "codex" &&
    typeof event.eventId === "string" &&
    typeof event.sessionId === "string" &&
    typeof event.method === "string" &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    event.payload?.safety === "safe" &&
    typeof event.source?.connectionId === "string"
  );
}

function fileSnapshot(stats: Stats): CodexEventFileSnapshot {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    identity: fileIdentity(stats),
  };
}

function fileIdentity(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.birthtimeMs)}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
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
    return (this.eventsBySession.get(query.sessionId) ?? [])
      .filter((event) => event.sequence > after && event.sequence <= through)
      .map((event) => structuredClone(event));
  }

  async latestSequence(sessionId: string): Promise<number> {
    return this.eventsBySession.get(sessionId)?.at(-1)?.sequence ?? 0;
  }

  private identityKey(sessionId: string, identity: string): string {
    return `${sessionId}\0${identity}`;
  }
}

export interface JsonlCodexEventStoreOptions {
  filePath: string;
  now?: () => number;
  /** Called for a malformed historical line. No raw line is exposed. */
  onCorruptLine?: (details: { lineNumber: number; reason: string }) => void;
}

/**
 * Optional append-only durable store. It hydrates its indexes once, serializes
 * concurrent appends, and uses the same replay contract as the in-memory
 * implementation. The payload reaching this class must already be redacted.
 */
export class JsonlCodexEventStore implements CodexEventStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly onCorruptLine?: JsonlCodexEventStoreOptions["onCorruptLine"];
  private readonly eventsBySession = new Map<string, CodexEventEnvelope[]>();
  private readonly eventsByIdentity = new Map<string, CodexEventEnvelope>();
  private readonly eventsByDedupeKey = new Map<string, CodexEventEnvelope>();
  private loaded: Promise<void> | null = null;
  private appendTail: Promise<void> = Promise.resolve();
  private needsAppendSeparator = false;

  constructor(options: JsonlCodexEventStoreOptions) {
    if (!options.filePath.trim()) {
      throw new Error("Codex JSONL event store requires a non-empty filePath");
    }
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.onCorruptLine = options.onCorruptLine;
  }

  async append(event: CodexEventDraft): Promise<CodexEventAppendResult> {
    await this.ensureLoaded();
    return await this.withAppendLock(async () => {
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
    const after = query.afterSequence ?? 0;
    const through = query.throughSequence ?? Number.MAX_SAFE_INTEGER;
    return (this.eventsBySession.get(query.sessionId) ?? [])
      .filter((event) => event.sequence > after && event.sequence <= through)
      .map((event) => structuredClone(event));
  }

  async latestSequence(sessionId: string): Promise<number> {
    await this.ensureLoaded();
    return this.eventsBySession.get(sessionId)?.at(-1)?.sequence ?? 0;
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    await this.loaded;
  }

  private async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    // A valid JSONL file may omit its final newline, and a crashed writer may
    // leave a partial final record. Either way, the next append must start on
    // a fresh line or it would corrupt both the old tail and the new event.
    this.needsAppendSeparator = contents.length > 0 && !contents.endsWith("\n");

    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.onCorruptLine?.({
          lineNumber: index + 1,
          // Modern runtimes may include a source excerpt in JSON.parse errors.
          // Keep the callback diagnostic fixed so corrupt secret-bearing lines
          // can never be copied into logs.
          reason: "invalid_json",
        });
        continue;
      }
      if (!isCodexEventEnvelope(parsed)) {
        this.onCorruptLine?.({
          lineNumber: index + 1,
          reason: "invalid_envelope",
        });
        continue;
      }
      const existing = this.findExisting(parsed);
      if (!existing) this.index(parsed);
    }
    for (const events of this.eventsBySession.values()) {
      events.sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.eventId.localeCompare(right.eventId),
      );
    }
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

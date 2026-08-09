import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteText } from "../../utils/atomic-json-file.js";

export type FeishuInboxStatus =
  | "received"
  | "dispatching"
  | "dispatched"
  | "completed"
  | "failed";

export type FeishuInboxErrorCode =
  | "NORMALIZATION_FAILED"
  | "POLICY_DENIED"
  | "PROJECT_NOT_ALLOWED"
  | "SESSION_COMMAND_FAILED"
  | "RUNTIME_FAILED"
  | "TURN_INTERRUPTED"
  | "DISPATCH_FAILED"
  | "RECOVERY_FAILED"
  | "UNKNOWN";

export interface FeishuInboxRecord {
  key: string;
  accountId: string;
  eventId?: string;
  eventType: string;
  messageId?: string;
  scopeKey?: string;
  status: FeishuInboxStatus;
  sessionId?: string;
  tempId: string;
  attempts: number;
  receivedAt: string;
  updatedAt: string;
  lastErrorCode?: FeishuInboxErrorCode;
}

export interface FeishuInboxReceiveInput {
  accountId: string;
  eventId?: string;
  eventType: string;
  messageId?: string;
  scopeKey?: string;
  now?: Date;
}

export interface FeishuDurableInboxOptions {
  dataDir: string;
  maxRecords?: number;
  completedTtlMs?: number;
}

export interface FeishuInboxSummary {
  total: number;
  byStatus: Record<FeishuInboxStatus, number>;
  byAccount: Record<string, number>;
}

const InboxRecordSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  accountId: z.string().min(1).max(64),
  eventId: z.string().min(1).max(512).optional(),
  eventType: z.string().min(1).max(128),
  messageId: z.string().min(1).max(512).optional(),
  scopeKey: z.string().min(1).max(1_024).optional(),
  status: z.enum([
    "received",
    "dispatching",
    "dispatched",
    "completed",
    "failed",
  ]),
  sessionId: z.string().min(1).max(512).optional(),
  tempId: z.string().regex(/^feishu-[a-f0-9]{32}$/),
  attempts: z.number().int().nonnegative(),
  receivedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastErrorCode: z
    .enum([
      "NORMALIZATION_FAILED",
      "POLICY_DENIED",
      "PROJECT_NOT_ALLOWED",
      "SESSION_COMMAND_FAILED",
      "RUNTIME_FAILED",
      "TURN_INTERRUPTED",
      "DISPATCH_FAILED",
      "RECOVERY_FAILED",
      "UNKNOWN",
    ])
    .optional(),
});

const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class FeishuDurableInbox {
  readonly filePath: string;
  private readonly maxRecords: number;
  private readonly completedTtlMs: number;
  private readonly records = new Map<string, FeishuInboxRecord>();
  private initialized = false;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: FeishuDurableInboxOptions) {
    this.filePath = join(options.dataDir, "channels", "feishu", "inbox.jsonl");
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
  }

  async initialize(): Promise<void> {
    let content = "";
    try {
      content = await readFile(this.filePath, "utf8");
      if (process.platform !== "win32") {
        await chmod(this.filePath, 0o600);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const [index, line] of content.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const record = InboxRecordSchema.parse(
          JSON.parse(line),
        ) as FeishuInboxRecord;
        this.records.set(record.key, record);
      } catch (error) {
        throw new Error(`Invalid Feishu inbox record at line ${index + 1}`, {
          cause: error,
        });
      }
    }
    this.initialized = true;
    if (this.records.size > this.maxRecords) await this.compact();
  }

  isOperational(): boolean {
    return this.initialized;
  }

  receive(
    input: FeishuInboxReceiveInput,
  ): Promise<{ record: FeishuInboxRecord; duplicate: boolean }> {
    this.assertInitialized();
    return this.enqueueOperation(async () => {
      if (!input.eventId && !input.messageId) {
        throw new Error("Feishu inbox event requires eventId or messageId");
      }
      const sourceId = input.messageId ?? input.eventId;
      if (!sourceId) {
        throw new Error("Feishu inbox event requires eventId or messageId");
      }
      const key = createInboxKey(input);
      const existing = this.records.get(key);
      if (existing) {
        return { record: structuredClone(existing), duplicate: true };
      }
      const now = (input.now ?? new Date()).toISOString();
      const record: FeishuInboxRecord = {
        key,
        accountId: input.accountId,
        eventId: input.eventId,
        eventType: input.eventType,
        messageId: input.messageId,
        scopeKey: input.scopeKey,
        status: "received",
        tempId: createTempId(input.accountId, sourceId),
        attempts: 0,
        receivedAt: now,
        updatedAt: now,
      };
      const validated = InboxRecordSchema.parse(record) as FeishuInboxRecord;
      await this.append(validated);
      this.records.set(key, validated);
      return { record: structuredClone(validated), duplicate: false };
    });
  }

  beginDispatch(
    key: string,
    updates: { scopeKey?: string; sessionId?: string; now?: Date } = {},
  ): Promise<FeishuInboxRecord> {
    return this.transition(key, "dispatching", {
      ...updates,
      incrementAttempts: true,
    });
  }

  markDispatched(
    key: string,
    updates: { sessionId?: string; now?: Date } = {},
  ): Promise<FeishuInboxRecord> {
    return this.transition(key, "dispatched", updates);
  }

  complete(key: string, now?: Date): Promise<FeishuInboxRecord> {
    return this.transition(key, "completed", { now });
  }

  fail(
    key: string,
    errorCode: FeishuInboxErrorCode,
    now?: Date,
  ): Promise<FeishuInboxRecord> {
    return this.transition(key, "failed", { errorCode, now });
  }

  retry(key: string, now?: Date): Promise<FeishuInboxRecord> {
    return this.transition(key, "received", { now });
  }

  get(key: string): FeishuInboxRecord | undefined {
    this.assertInitialized();
    const record = this.records.get(key);
    return record ? structuredClone(record) : undefined;
  }

  /** Resolve the opaque card reference without exposing inbox keys publicly. */
  findByTempId(tempId: string): FeishuInboxRecord | undefined {
    this.assertInitialized();
    if (!/^feishu-[a-f0-9]{32}$/.test(tempId)) return undefined;
    const record = [...this.records.values()].find(
      (candidate) => candidate.tempId === tempId,
    );
    return record ? structuredClone(record) : undefined;
  }

  listRecoverable(): FeishuInboxRecord[] {
    this.assertInitialized();
    return [...this.records.values()]
      .filter((record) =>
        ["received", "dispatching", "dispatched"].includes(record.status),
      )
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
      .map((record) => structuredClone(record));
  }

  summarize(): FeishuInboxSummary {
    this.assertInitialized();
    const byStatus: Record<FeishuInboxStatus, number> = {
      received: 0,
      dispatching: 0,
      dispatched: 0,
      completed: 0,
      failed: 0,
    };
    const byAccount: Record<string, number> = {};
    for (const record of this.records.values()) {
      byStatus[record.status] += 1;
      byAccount[record.accountId] = (byAccount[record.accountId] ?? 0) + 1;
    }
    return { total: this.records.size, byStatus, byAccount };
  }

  compact(now = new Date()): Promise<void> {
    this.assertInitialized();
    return this.enqueueOperation(async () => {
      const cutoff = now.getTime() - this.completedTtlMs;
      const all = [...this.records.values()].sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt),
      );
      const active = all.filter(
        (record) => record.status !== "completed" && record.status !== "failed",
      );
      const terminal = all.filter(
        (record) =>
          (record.status === "completed" || record.status === "failed") &&
          Date.parse(record.updatedAt) >= cutoff,
      );
      const terminalLimit = Math.max(0, this.maxRecords - active.length);
      const retained = [
        ...active,
        ...terminal.slice(Math.max(0, terminal.length - terminalLimit)),
      ].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
      await atomicWriteText(
        this.filePath,
        retained.map((record) => JSON.stringify(record)).join("\n") +
          (retained.length > 0 ? "\n" : ""),
      );
      this.records.clear();
      for (const record of retained) this.records.set(record.key, record);
    });
  }

  private transition(
    key: string,
    status: FeishuInboxStatus,
    updates: {
      scopeKey?: string;
      sessionId?: string;
      errorCode?: FeishuInboxErrorCode;
      incrementAttempts?: boolean;
      now?: Date;
    },
  ): Promise<FeishuInboxRecord> {
    this.assertInitialized();
    return this.enqueueOperation(async () => {
      const current = this.records.get(key);
      if (!current) throw new Error("Feishu inbox record not found");
      if (!isAllowedTransition(current.status, status)) {
        throw new Error(
          `Invalid Feishu inbox transition: ${current.status} -> ${status}`,
        );
      }
      const next: FeishuInboxRecord = {
        ...current,
        ...(updates.scopeKey ? { scopeKey: updates.scopeKey } : {}),
        ...(updates.sessionId ? { sessionId: updates.sessionId } : {}),
        status,
        attempts: current.attempts + (updates.incrementAttempts ? 1 : 0),
        updatedAt: (updates.now ?? new Date()).toISOString(),
        lastErrorCode: status === "failed" ? updates.errorCode : undefined,
      };
      const validated = InboxRecordSchema.parse(next) as FeishuInboxRecord;
      await this.append(validated);
      this.records.set(key, validated);
      return structuredClone(validated);
    });
  }

  private async append(record: FeishuInboxRecord): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const handle = await open(this.filePath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") await chmod(this.filePath, 0o600);
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("FeishuDurableInbox is not initialized");
    }
  }
}

function createInboxKey(input: FeishuInboxReceiveInput): string {
  const source = input.eventId
    ? `event:${input.eventId}`
    : `message:${input.messageId}:${input.eventType}`;
  return createHash("sha256")
    .update(`${input.accountId}\0${source}`)
    .digest("hex");
}

function createTempId(accountId: string, sourceId: string): string {
  return `feishu-${createHash("sha256")
    .update(`${accountId}\0${sourceId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function isAllowedTransition(
  from: FeishuInboxStatus,
  to: FeishuInboxStatus,
): boolean {
  if (from === to) return true;
  const allowed: Record<FeishuInboxStatus, FeishuInboxStatus[]> = {
    received: ["dispatching", "failed"],
    dispatching: ["dispatched", "completed", "failed"],
    // A dispatched row already crossed the runtime side-effect boundary. Retry
    // must go through an explicit terminal -> received transition; allowing a
    // direct re-entry here can execute a live transport redelivery twice.
    dispatched: ["completed", "failed"],
    completed: [],
    failed: ["received", "dispatching"],
  };
  return allowed[from].includes(to);
}

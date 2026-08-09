import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  containsSensitiveText,
  redactCodexPayload,
} from "../../codex-events/redaction.js";
import { atomicWriteJson } from "../../utils/atomic-json-file.js";

export type FeishuOutboxKind =
  | "message_send"
  | "card_content_update"
  | "card_finish"
  | "input_card_update";

export type FeishuOutboxStatus =
  | "pending"
  | "attempting"
  | "delivered"
  | "dead_letter";

export interface FeishuOutboxRecord {
  version: 1;
  id: string;
  owner: string;
  idempotencyKey: string;
  kind: FeishuOutboxKind;
  payload: Record<string, unknown>;
  status: FeishuOutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  lastErrorCode?: string;
}

const RecordSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(512),
  kind: z.enum([
    "message_send",
    "card_content_update",
    "card_finish",
    "input_card_update",
  ]),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "attempting", "delivered", "dead_letter"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().optional(),
  lastErrorCode: z.string().min(1).max(128).optional(),
});

const FileSchema = z.object({
  version: z.literal(1),
  records: z.array(RecordSchema),
});

const DEFAULT_MAX_RECORDS = 5_000;
const DEFAULT_DELIVERED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_OUTBOX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OUTBOX_PAYLOAD_BYTES = 256 * 1024;
export const FEISHU_ARTIFACT_DELIVERY_EFFECT =
  "generated_artifact_send_v1" as const;

/** Durable intent store. Network execution stays in the account-bound API. */
export class FeishuDurableOutbox {
  readonly filePath: string;
  private readonly maxRecords: number;
  private readonly deliveredTtlMs: number;
  private records = new Map<string, FeishuOutboxRecord>();
  private initialized = false;
  private initialization?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: {
    dataDir: string;
    maxRecords?: number;
    deliveredTtlMs?: number;
  }) {
    this.filePath = join(options.dataDir, "channels", "feishu", "outbox.json");
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.deliveredTtlMs = options.deliveredTtlMs ?? DEFAULT_DELIVERED_TTL_MS;
  }

  initialize(now = new Date()): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initialization) {
      this.initialization = this.load(now).finally(() => {
        this.initialization = undefined;
      });
    }
    return this.initialization;
  }

  private async load(now: Date): Promise<void> {
    let parsed: z.infer<typeof FileSchema> = { version: 1, records: [] };
    try {
      const contents = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_OUTBOX_FILE_BYTES) {
        throw new Error("Feishu outbound outbox exceeds the size limit");
      }
      parsed = FileSchema.parse(JSON.parse(contents));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Parsing errors may retain source excerpts. Keep durable content out
        // of logs and public route errors.
        throw new Error("Invalid Feishu outbound outbox");
      }
    }
    const cutoff = now.getTime() - this.deliveredTtlMs;
    const retained = parsed.records
      // Re-project records written by older builds before they can be
      // recovered or written back. A secret-bearing durable identity cannot
      // be repaired without changing its idempotency semantics, so drop it.
      .filter(
        (record) =>
          !containsSensitiveText(record.owner) &&
          !containsSensitiveText(record.idempotencyKey),
      )
      .map((record) => {
        const projectedPayload = projectOutboxPayload(record.payload);
        const payload = isFeishuArtifactDeliveryPayload(projectedPayload)
          ? ArtifactDeliveryPayloadSchema.parse(projectedPayload)
          : projectedPayload;
        return {
          ...record,
          payload,
          ...(record.lastErrorCode
            ? { lastErrorCode: safeErrorCode(record.lastErrorCode) }
            : {}),
        };
      })
      .map((record) =>
        record.status === "attempting"
          ? {
              ...record,
              status: "pending" as const,
              updatedAt: now.toISOString(),
            }
          : record,
      )
      .filter(
        (record) =>
          record.status !== "delivered" ||
          Date.parse(record.deliveredAt ?? record.updatedAt) >= cutoff,
      )
      .slice(-this.maxRecords) as FeishuOutboxRecord[];
    this.records = new Map(retained.map((record) => [record.id, record]));
    await this.persist();
    this.initialized = true;
  }

  isOperational(): boolean {
    return this.initialized;
  }

  enqueue(input: {
    owner: string;
    idempotencyKey: string;
    kind: FeishuOutboxKind;
    payload: Record<string, unknown>;
    now?: Date;
  }): Promise<FeishuOutboxRecord> {
    this.assertInitialized();
    if (
      containsSensitiveText(input.owner) ||
      containsSensitiveText(input.idempotencyKey)
    ) {
      throw new Error("Invalid Feishu outbox identity");
    }
    return this.withWrite(async () => {
      const id = outboxId(input.owner, input.idempotencyKey);
      const existing = this.records.get(id);
      if (existing) return structuredClone(existing);
      const now = (input.now ?? new Date()).toISOString();
      const redactedPayload = projectOutboxPayload(input.payload);
      if (isFeishuArtifactDeliveryPayload(redactedPayload)) {
        ArtifactDeliveryPayloadSchema.parse(redactedPayload);
      }
      const record = RecordSchema.parse({
        version: 1,
        id,
        owner: input.owner,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        payload: redactedPayload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      }) as FeishuOutboxRecord;
      this.records.set(id, record);
      this.trim();
      await this.persist();
      return structuredClone(record);
    });
  }

  claim(id: string, now = new Date()): Promise<FeishuOutboxRecord | undefined> {
    this.assertInitialized();
    return this.withWrite(async () => {
      const current = this.records.get(id);
      if (
        !current ||
        current.status !== "pending" ||
        Date.parse(current.nextAttemptAt) > now.getTime()
      ) {
        return undefined;
      }
      const next: FeishuOutboxRecord = {
        ...current,
        status: "attempting",
        attempts: current.attempts + 1,
        updatedAt: now.toISOString(),
      };
      this.records.set(id, next);
      await this.persist();
      return structuredClone(next);
    });
  }

  complete(id: string, now = new Date()): Promise<void> {
    return this.transition(
      id,
      {
        status: "delivered",
        deliveredAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastErrorCode: undefined,
      },
      ["attempting", "delivered"],
    );
  }

  /**
   * Persist only the Feishu-hosted opaque media reference after upload.
   * Artifact bytes and local/managed paths never enter the durable outbox.
   */
  markArtifactUploaded(
    id: string,
    remoteKey: string,
    now = new Date(),
  ): Promise<FeishuOutboxRecord> {
    this.assertInitialized();
    return this.withWrite(async () => {
      const current = this.records.get(id);
      if (!current || !isFeishuArtifactDeliveryRecord(current)) {
        throw new Error("Invalid Feishu artifact outbox record");
      }
      if (current.status !== "attempting") {
        throw new Error("Feishu artifact upload is not claimed");
      }
      const currentPayload = ArtifactDeliveryPayloadSchema.parse(
        current.payload,
      );
      if (currentPayload.remoteKey && currentPayload.remoteKey !== remoteKey) {
        throw new Error("Feishu artifact upload identity changed");
      }
      const payload = ArtifactDeliveryPayloadSchema.parse({
        ...currentPayload,
        remoteKey,
      });
      const next = RecordSchema.parse({
        ...current,
        payload,
        updatedAt: now.toISOString(),
      }) as FeishuOutboxRecord;
      this.records.set(id, next);
      await this.persist();
      return structuredClone(next);
    });
  }

  completeArtifact(
    id: string,
    messageId: string,
    now = new Date(),
  ): Promise<void> {
    this.assertInitialized();
    return this.withWrite(async () => {
      const current = this.records.get(id);
      if (!current || !isFeishuArtifactDeliveryRecord(current)) {
        throw new Error("Invalid Feishu artifact outbox record");
      }
      const currentPayload = ArtifactDeliveryPayloadSchema.parse(
        current.payload,
      );
      if (!currentPayload.remoteKey) {
        throw new Error("Feishu artifact upload reference is missing");
      }
      if (current.status === "delivered") return;
      if (current.status !== "attempting") {
        throw new Error("Feishu artifact delivery is not claimed");
      }
      const timestamp = now.toISOString();
      const payload = ArtifactDeliveryPayloadSchema.parse({
        ...currentPayload,
        messageId,
      });
      const next = RecordSchema.parse({
        ...current,
        payload,
        status: "delivered",
        deliveredAt: timestamp,
        updatedAt: timestamp,
        lastErrorCode: undefined,
      }) as FeishuOutboxRecord;
      this.records.set(id, next);
      await this.persist();
    });
  }

  retry(
    id: string,
    input: { errorCode: string; delayMs: number; now?: Date },
  ): Promise<void> {
    const now = input.now ?? new Date();
    return this.transition(
      id,
      {
        status: "pending",
        nextAttemptAt: new Date(
          now.getTime() + Math.max(0, input.delayMs),
        ).toISOString(),
        updatedAt: now.toISOString(),
        lastErrorCode: safeErrorCode(input.errorCode),
      },
      ["attempting"],
    );
  }

  deadLetter(id: string, errorCode: string, now = new Date()): Promise<void> {
    return this.transition(
      id,
      {
        status: "dead_letter",
        updatedAt: now.toISOString(),
        lastErrorCode: safeErrorCode(errorCode),
      },
      ["attempting"],
    );
  }

  listRecoverable(owner: string, now = new Date()): FeishuOutboxRecord[] {
    this.assertInitialized();
    return [...this.records.values()]
      .filter(
        (record) =>
          record.owner === owner &&
          record.status === "pending" &&
          Date.parse(record.nextAttemptAt) <= now.getTime(),
      )
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      )
      .map((record) => structuredClone(record));
  }

  get(id: string): FeishuOutboxRecord | undefined {
    this.assertInitialized();
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  private transition(
    id: string,
    updates: Partial<FeishuOutboxRecord>,
    allowedStatuses: readonly FeishuOutboxStatus[],
  ): Promise<void> {
    this.assertInitialized();
    return this.withWrite(async () => {
      const current = this.records.get(id);
      if (!current) throw new Error("Feishu outbox record not found");
      if (current.status === "delivered" && updates.status === "delivered") {
        return;
      }
      if (!allowedStatuses.includes(current.status)) {
        throw new Error("Invalid Feishu outbox state transition");
      }
      const next = RecordSchema.parse({
        ...current,
        ...updates,
      }) as FeishuOutboxRecord;
      this.records.set(id, next);
      await this.persist();
    });
  }

  private trim(): void {
    if (this.records.size <= this.maxRecords) return;
    const ordered = [...this.records.values()].sort(
      (left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
    );
    for (const record of ordered) {
      if (this.records.size <= this.maxRecords) break;
      if (record.status === "pending" || record.status === "attempting")
        continue;
      this.records.delete(record.id);
    }
    if (this.records.size > this.maxRecords) {
      throw new Error("Feishu outbound outbox capacity exhausted");
    }
  }

  private persist(): Promise<void> {
    return atomicWriteJson(this.filePath, {
      version: 1,
      records: [...this.records.values()],
    });
  }

  private withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new Error("Feishu outbound outbox not initialized");
  }
}

function outboxId(owner: string, idempotencyKey: string): string {
  return createHash("sha256")
    .update(owner)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
}

function safeErrorCode(value: string): string {
  if (containsSensitiveText(value)) return "REDACTED_ERROR";
  return value.replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 128) || "UNKNOWN";
}

function projectOutboxPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  let jsonPayload: unknown;
  try {
    // Match the durable JSON representation before redaction. In particular,
    // omit undefined optional callback fields instead of turning them into
    // strings that could change a recovered card action.
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > MAX_OUTBOX_PAYLOAD_BYTES) {
      throw new Error("Feishu outbox payload exceeds the size limit");
    }
    jsonPayload = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid Feishu outbox payload");
  }
  const redactedPayload = redactCodexPayload("feishu/outbox", jsonPayload).data;
  if (
    !redactedPayload ||
    typeof redactedPayload !== "object" ||
    Array.isArray(redactedPayload)
  ) {
    throw new Error("Invalid Feishu outbox payload");
  }
  return redactedPayload as Record<string, unknown>;
}

const ArtifactDeliveryPayloadSchema = z
  .object({
    effect: z.literal(FEISHU_ARTIFACT_DELIVERY_EFFECT),
    target: z
      .object({
        chatId: z.string().min(1).max(512),
        replyToMessageId: z.string().min(1).max(512),
        replyInThread: z.boolean(),
      })
      .strict(),
    messageType: z.enum(["image", "file", "media"]),
    remoteKey: z.string().min(1).max(512).optional(),
    messageId: z.string().min(1).max(512).optional(),
  })
  .strict();

export function isFeishuArtifactDeliveryRecord(
  record: FeishuOutboxRecord,
): boolean {
  return (
    record.kind === "message_send" &&
    isFeishuArtifactDeliveryPayload(record.payload)
  );
}

function isFeishuArtifactDeliveryPayload(
  payload: Record<string, unknown>,
): boolean {
  return payload.effect === FEISHU_ARTIFACT_DELIVERY_EFFECT;
}

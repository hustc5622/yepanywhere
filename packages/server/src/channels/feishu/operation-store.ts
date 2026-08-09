import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  InteractionOperation,
  InteractionOperationState,
} from "@yep-anywhere/shared";
import { z } from "zod";
import { atomicWriteJson } from "../../utils/atomic-json-file.js";

export type FeishuOperationResult =
  | "approve"
  | "approve_always"
  | "deny"
  | "answered";

export type FeishuOperationTerminalReason =
  | "timeout"
  | "interrupt"
  | "process_exit"
  | "request_missing"
  | "provider_rejected"
  | "failed";

export interface FeishuNativeDecisionDescriptor {
  kind:
    | "accept"
    | "acceptForSession"
    | "acceptWithExecpolicyAmendment"
    | "applyNetworkPolicyAmendment"
    | "decline"
    | "cancel"
    | "answer";
  scope: "once" | "session" | "policy" | "none";
}

/**
 * Durable Feishu presentation metadata for one broker-owned interaction.
 *
 * This record is deliberately not a decision state machine. brokerState and
 * brokerVersion are snapshots copied from InteractionBroker. Card callbacks
 * must still win the broker CAS through SessionInteractionService.
 */
export interface FeishuOperationRecord {
  version: 1;
  projectionId: string;
  brokerOperationId: string;
  brokerVersion: number;
  brokerState: InteractionOperationState;
  accountId: string;
  chatId: string;
  threadId?: string;
  replyToMessageId: string;
  sessionId: string;
  requestId: string;
  providerRequestId: string;
  requestType: "tool-approval" | "question" | "choice";
  requesterOpenId: string;
  allowedOperatorOpenIds: string[];
  cardId?: string;
  cardMessageId?: string;
  cardSequence: number;
  cardProjectedBrokerVersion?: number;
  displayResult?: FeishuOperationResult;
  nativeDecision?: FeishuNativeDecisionDescriptor;
  terminalReason?: FeishuOperationTerminalReason;
  createdAt: string;
  expiresAt?: string;
  updatedAt: string;
}

export interface FeishuOperationUpsertInput {
  operation: InteractionOperation;
  accountId: string;
  chatId: string;
  threadId?: string;
  replyToMessageId: string;
  sessionId: string;
  requestId: string;
  providerRequestId: string;
  requestType: FeishuOperationRecord["requestType"];
  requesterOpenId: string;
  allowedOperatorOpenIds: string[];
  now?: Date;
}

export interface FeishuOperationPresentation {
  result?: FeishuOperationResult;
  nativeDecision?: FeishuNativeDecisionDescriptor;
  terminalReason?: FeishuOperationTerminalReason;
}

export type FeishuOperationAuthorizationResult =
  | { state: "authorized"; record: FeishuOperationRecord }
  | { state: "not_found" | "forbidden"; record?: FeishuOperationRecord };

const NativeDecisionSchema = z.object({
  kind: z.enum([
    "accept",
    "acceptForSession",
    "acceptWithExecpolicyAmendment",
    "applyNetworkPolicyAmendment",
    "decline",
    "cancel",
    "answer",
  ]),
  scope: z.enum(["once", "session", "policy", "none"]),
});

const RecordSchema = z.object({
  version: z.literal(1),
  projectionId: z.string().regex(/^[a-f0-9]{64}$/),
  brokerOperationId: z.string().regex(/^int_[A-Za-z0-9_-]{16,124}$/u),
  brokerVersion: z.number().int().nonnegative(),
  brokerState: z.enum([
    "open",
    "answering",
    "resolved",
    "expired",
    "cancelled",
    "failed",
  ]),
  accountId: z.string().min(1).max(128),
  chatId: z.string().min(1).max(512),
  threadId: z.string().min(1).max(512).optional(),
  replyToMessageId: z.string().min(1).max(512),
  sessionId: z.string().min(1).max(2_048),
  requestId: z.string().min(1).max(2_048),
  providerRequestId: z.string().min(1).max(2_048),
  requestType: z.enum(["tool-approval", "question", "choice"]),
  requesterOpenId: z.string().min(1).max(512),
  allowedOperatorOpenIds: z.array(z.string().min(1).max(512)).min(1).max(128),
  cardId: z.string().min(1).max(512).optional(),
  cardMessageId: z.string().min(1).max(512).optional(),
  cardSequence: z.number().int().nonnegative(),
  cardProjectedBrokerVersion: z.number().int().nonnegative().optional(),
  displayResult: z
    .enum(["approve", "approve_always", "deny", "answered"])
    .optional(),
  nativeDecision: NativeDecisionSchema.optional(),
  terminalReason: z
    .enum([
      "timeout",
      "interrupt",
      "process_exit",
      "request_missing",
      "provider_rejected",
      "failed",
    ])
    .optional(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
});

const FileSchema = z.object({
  version: z.literal(1),
  records: z.array(RecordSchema),
});

const DEFAULT_MAX_RECORDS = 2_000;
const DEFAULT_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PROJECTION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export class FeishuOperationStore {
  readonly filePath: string;
  private readonly maxRecords: number;
  private readonly terminalTtlMs: number;
  private records = new Map<string, FeishuOperationRecord>();
  private initialized = false;
  private initialization?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: {
    dataDir: string;
    maxRecords?: number;
    terminalTtlMs?: number;
  }) {
    this.filePath = join(
      options.dataDir,
      "channels",
      "feishu",
      "operation-projections.json",
    );
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
    this.terminalTtlMs = Math.max(
      0,
      options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS,
    );
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

  isOperational(): boolean {
    return this.initialized;
  }

  get(projectionId: string): FeishuOperationRecord | undefined {
    this.assertInitialized();
    return cloneRecord(this.records.get(projectionId));
  }

  findByBrokerOperation(
    accountId: string,
    brokerOperationId: string,
  ): FeishuOperationRecord | undefined {
    this.assertInitialized();
    return cloneRecord(
      [...this.records.values()].find(
        (record) =>
          record.accountId === accountId &&
          record.brokerOperationId === brokerOperationId,
      ),
    );
  }

  findForRequest(
    accountId: string,
    sessionId: string,
    providerRequestId: string,
  ): FeishuOperationRecord | undefined {
    this.assertInitialized();
    return cloneRecord(
      this.records.get(
        projectionIdFor(accountId, sessionId, providerRequestId),
      ),
    );
  }

  list(): FeishuOperationRecord[] {
    this.assertInitialized();
    return [...this.records.values()].map((record) => cloneRecord(record));
  }

  listOpen(): FeishuOperationRecord[] {
    return this.list().filter((record) => isOpenState(record.brokerState));
  }

  listTerminalAwaitingCardProjection(): FeishuOperationRecord[] {
    return this.list().filter(
      (record) =>
        !isOpenState(record.brokerState) &&
        record.cardId !== undefined &&
        (record.cardProjectedBrokerVersion ?? -1) < record.brokerVersion,
    );
  }

  upsert(input: FeishuOperationUpsertInput): Promise<FeishuOperationRecord> {
    this.assertInitialized();
    if (input.operation.sessionId !== input.sessionId) {
      throw new Error("Feishu interaction session mismatch");
    }
    return this.withWrite(async () => {
      const now = input.now ?? new Date();
      const projectionId = projectionIdFor(
        input.accountId,
        input.sessionId,
        input.providerRequestId,
      );
      const current = this.records.get(projectionId);
      if (
        current &&
        current.brokerOperationId === input.operation.operationId &&
        current.brokerVersion > input.operation.version
      ) {
        return cloneRecord(current);
      }
      const brokerChanged =
        current?.brokerOperationId !== input.operation.operationId;
      const timestamp = now.toISOString();
      const next = RecordSchema.parse({
        version: 1,
        projectionId,
        brokerOperationId: input.operation.operationId,
        brokerVersion: input.operation.version,
        brokerState: input.operation.state,
        accountId: input.accountId,
        chatId: input.chatId,
        threadId: input.threadId,
        replyToMessageId: input.replyToMessageId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        providerRequestId: input.providerRequestId,
        requestType: input.requestType,
        requesterOpenId: input.requesterOpenId,
        allowedOperatorOpenIds: normalizeActorIds(
          input.requesterOpenId,
          input.allowedOperatorOpenIds,
        ),
        cardId: current?.cardId,
        cardMessageId: current?.cardMessageId,
        cardSequence: current?.cardSequence ?? 0,
        cardProjectedBrokerVersion: brokerChanged
          ? undefined
          : current?.cardProjectedBrokerVersion,
        displayResult: brokerChanged ? undefined : current?.displayResult,
        nativeDecision: brokerChanged ? undefined : current?.nativeDecision,
        terminalReason: brokerChanged
          ? terminalReasonFromOperation(input.operation)
          : (current?.terminalReason ??
            terminalReasonFromOperation(input.operation)),
        createdAt: current?.createdAt ?? timestamp,
        expiresAt: operationExpiresAt(input.operation),
        updatedAt: timestamp,
      }) as FeishuOperationRecord;
      const records = new Map(this.records);
      records.set(projectionId, next);
      this.trim(records, now);
      await this.commit(records);
      return cloneRecord(next);
    });
  }

  attachCard(
    projectionId: string,
    input: { cardId: string; cardMessageId: string },
    now = new Date(),
  ): Promise<FeishuOperationRecord> {
    this.assertInitialized();
    return this.withWrite(async () => {
      const current = this.requireRecord(projectionId);
      if (
        (current.cardId && current.cardId !== input.cardId) ||
        (current.cardMessageId && current.cardMessageId !== input.cardMessageId)
      ) {
        throw new Error("Feishu interaction card identity changed");
      }
      const next = RecordSchema.parse({
        ...current,
        cardId: input.cardId,
        cardMessageId: input.cardMessageId,
        updatedAt: now.toISOString(),
      }) as FeishuOperationRecord;
      await this.replace(next);
      return cloneRecord(next);
    });
  }

  authorizeAction(input: {
    accountId: string;
    brokerOperationId: string;
    chatId: string;
    cardMessageId: string;
    operatorOpenId: string;
  }): FeishuOperationAuthorizationResult {
    this.assertInitialized();
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.accountId === input.accountId &&
        candidate.brokerOperationId === input.brokerOperationId,
    );
    if (!record) return { state: "not_found" };
    const authorized =
      record.chatId === input.chatId &&
      record.cardMessageId === input.cardMessageId &&
      record.allowedOperatorOpenIds.includes(input.operatorOpenId);
    return authorized
      ? { state: "authorized", record: cloneRecord(record) }
      : { state: "forbidden", record: cloneRecord(record) };
  }

  syncBrokerOperation(
    accountId: string,
    operation: InteractionOperation,
    presentation: FeishuOperationPresentation = {},
    now = new Date(),
  ): Promise<FeishuOperationRecord | undefined> {
    this.assertInitialized();
    return this.withWrite(async () => {
      const current = [...this.records.values()].find(
        (record) =>
          record.accountId === accountId &&
          record.brokerOperationId === operation.operationId,
      );
      if (!current) return undefined;
      if (operation.version < current.brokerVersion) {
        return cloneRecord(current);
      }
      const next = RecordSchema.parse({
        ...current,
        brokerVersion: operation.version,
        brokerState: operation.state,
        expiresAt: operationExpiresAt(operation),
        displayResult:
          presentation.result ??
          (isOpenState(operation.state)
            ? undefined
            : (current.displayResult ??
              displayResultFromOperation(current.requestType, operation))),
        nativeDecision:
          presentation.nativeDecision ??
          (isOpenState(operation.state) ? undefined : current.nativeDecision),
        terminalReason:
          presentation.terminalReason ??
          (isOpenState(operation.state)
            ? undefined
            : presentation.result !== undefined
              ? undefined
              : (terminalReasonFromOperation(operation) ?? "request_missing")),
        updatedAt: now.toISOString(),
      }) as FeishuOperationRecord;
      await this.replace(next);
      return cloneRecord(next);
    });
  }

  advanceCardSequence(projectionId: string, now = new Date()): Promise<number> {
    this.assertInitialized();
    return this.withWrite(async () => {
      const current = this.requireRecord(projectionId);
      const next = RecordSchema.parse({
        ...current,
        cardSequence: current.cardSequence + 1,
        updatedAt: now.toISOString(),
      }) as FeishuOperationRecord;
      await this.replace(next);
      return next.cardSequence;
    });
  }

  markCardProjected(
    projectionId: string,
    brokerOperationId: string,
    brokerVersion: number,
    now = new Date(),
  ): Promise<boolean> {
    this.assertInitialized();
    return this.withWrite(async () => {
      const current = this.requireRecord(projectionId);
      if (
        current.brokerOperationId !== brokerOperationId ||
        current.brokerVersion !== brokerVersion
      ) {
        return false;
      }
      if ((current.cardProjectedBrokerVersion ?? -1) >= brokerVersion) {
        return true;
      }
      const next = RecordSchema.parse({
        ...current,
        cardProjectedBrokerVersion: brokerVersion,
        updatedAt: now.toISOString(),
      }) as FeishuOperationRecord;
      await this.replace(next);
      return true;
    });
  }

  private async load(now: Date): Promise<void> {
    let parsed: z.infer<typeof FileSchema> = { version: 1, records: [] };
    let fileExists = false;
    try {
      const contents = await readFile(this.filePath, "utf8");
      fileExists = true;
      if (Buffer.byteLength(contents, "utf8") > MAX_PROJECTION_FILE_BYTES) {
        throw new Error("Feishu operation projection file is too large");
      }
      parsed = FileSchema.parse(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Invalid Feishu operation projection store");
      }
    }
    const cutoff = now.getTime() - this.terminalTtlMs;
    const records = new Map(
      parsed.records
        .filter(
          (record) =>
            isOpenState(record.brokerState) ||
            Date.parse(record.updatedAt) >= cutoff,
        )
        .map((record) => [
          record.projectionId,
          record as FeishuOperationRecord,
        ]),
    );
    this.trim(records, now);
    if (fileExists) await this.persist(records);
    this.records = records;
    this.initialized = true;
  }

  private requireRecord(projectionId: string): FeishuOperationRecord {
    const record = this.records.get(projectionId);
    if (!record) throw new Error("Feishu operation projection not found");
    return record;
  }

  private replace(record: FeishuOperationRecord): Promise<void> {
    const records = new Map(this.records);
    records.set(record.projectionId, record);
    return this.commit(records);
  }

  private async commit(
    records: Map<string, FeishuOperationRecord>,
  ): Promise<void> {
    await this.persist(records);
    this.records = records;
  }

  private persist(records: Map<string, FeishuOperationRecord>): Promise<void> {
    return atomicWriteJson(this.filePath, {
      version: 1,
      records: [...records.values()],
    });
  }

  private trim(records: Map<string, FeishuOperationRecord>, _now: Date): void {
    if (records.size <= this.maxRecords) return;
    const terminal = [...records.values()]
      .filter((record) => !isOpenState(record.brokerState))
      .sort(
        (left, right) =>
          Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
      );
    for (const record of terminal) {
      if (records.size <= this.maxRecords) break;
      records.delete(record.projectionId);
    }
    if (records.size > this.maxRecords) {
      throw new Error("Feishu operation projection capacity exhausted");
    }
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
    if (!this.initialized) {
      throw new Error("Feishu operation projection store not initialized");
    }
  }
}

function projectionIdFor(
  accountId: string,
  sessionId: string,
  providerRequestId: string,
): string {
  return createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(providerRequestId)
    .digest("hex");
}

function normalizeActorIds(
  requesterOpenId: string,
  allowedOperatorOpenIds: readonly string[],
): string[] {
  return [
    ...new Set(
      [requesterOpenId, ...allowedOperatorOpenIds]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, 128);
}

function operationExpiresAt(
  operation: InteractionOperation,
): string | undefined {
  return typeof operation.expiresAt === "number" &&
    Number.isFinite(operation.expiresAt)
    ? new Date(
        Math.min(MAX_DATE_TIMESTAMP_MS, Math.max(0, operation.expiresAt)),
      ).toISOString()
    : undefined;
}

function isOpenState(state: InteractionOperationState): boolean {
  return state === "open" || state === "answering";
}

function displayResultFromOperation(
  requestType: FeishuOperationRecord["requestType"],
  operation: InteractionOperation,
): FeishuOperationResult | undefined {
  const decision = operation.resolution?.decision;
  if (decision === "deny") return "deny";
  if (requestType !== "tool-approval" && operation.state === "resolved") {
    return "answered";
  }
  if (decision === "approve_always" || decision === "approve_for_session") {
    return "approve_always";
  }
  if (
    decision === "approve" ||
    decision === "approve_accept_edits" ||
    decision === "allow"
  ) {
    return "approve";
  }
  return undefined;
}

function terminalReasonFromOperation(
  operation: InteractionOperation,
): FeishuOperationTerminalReason | undefined {
  const reason =
    operation.resolution?.summary ?? operation.resolution?.decision;
  if (
    reason === "timeout" ||
    reason === "interrupt" ||
    reason === "process_exit" ||
    reason === "request_missing" ||
    reason === "provider_rejected"
  ) {
    return reason;
  }
  if (operation.state === "expired") return "timeout";
  if (operation.state === "cancelled") return "interrupt";
  if (operation.state === "failed") return "failed";
  return undefined;
}

function cloneRecord(record: FeishuOperationRecord): FeishuOperationRecord;
function cloneRecord(record: undefined): undefined;
function cloneRecord(
  record: FeishuOperationRecord | undefined,
): FeishuOperationRecord | undefined;
function cloneRecord(
  record: FeishuOperationRecord | undefined,
): FeishuOperationRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  InputRequest,
  InteractionOperation,
  InteractionOperationKind,
  InteractionOperationState,
  NativeDecisionDescriptor,
  SafeInteractionPayload,
  SafeInteractionQuestion,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { z } from "zod";
import { atomicWriteJson } from "../utils/atomic-json-file.js";

export type InteractionPendingOwner = "process" | "bridge";

export interface InteractionResolutionActor {
  id: string;
  displayName?: string;
  channel: "yep" | "feishu" | "provider" | "system";
}

export interface InteractionProviderResponse {
  response: string;
  answers?: UserQuestionAnswers;
  feedback?: string;
  /** Exact central CAS claim forwarded to an authenticated bridge adapter. */
  operationId: string;
  operationVersion: number;
  actor: InteractionResolutionActor;
}

export type InteractionProviderResolver = (
  response: InteractionProviderResponse,
) => Promise<boolean>;

export interface RegisterInteractionInput {
  request: InputRequest;
  owner: InteractionPendingOwner;
  provider: string;
  projectId?: string;
  resolveProvider: InteractionProviderResolver;
  /** Atomically make this request the session's current queue head. */
  supersedeSession?: boolean;
  now?: Date;
}

export interface ResolveInteractionInput
  extends Pick<
    InteractionProviderResponse,
    "response" | "answers" | "feedback"
  > {
  sessionId: string;
  requestId: string;
  operationId?: string;
  expectedVersion?: number;
  actor: InteractionResolutionActor;
  now?: Date;
  /** Internal terminal resolution used by the broker-owned timeout scheduler. */
  terminalReason?: "timeout";
}

export type InteractionResolveResult =
  | { state: "resolved"; operation: InteractionOperation }
  | {
      state: "not_found" | "stale" | "already_resolved" | "provider_rejected";
      operation?: InteractionOperation;
    };

export type InteractionTerminalReason =
  | "timeout"
  | "interrupt"
  | "process_exit"
  | "request_missing"
  | "provider_rejected"
  | "restart_recovery";

interface InteractionAuditEntry {
  at: string;
  event:
    | "opened"
    | "refreshed"
    | "claimed"
    | "resolved"
    | "terminated"
    | "rejected";
  version: number;
  actor?: InteractionResolutionActor;
  reason?: InteractionTerminalReason | "stale" | "already_resolved";
}

interface InteractionBrokerRecord {
  schemaVersion: 1;
  operation: InteractionOperation;
  requestFingerprint: string;
  /** Stable native turn/item coordinates when the protocol supplies them. */
  requestDiscriminator?: string;
  /** Transport-local ids that have projected this native request. */
  requestAliases: string[];
  owner: InteractionPendingOwner;
  terminalReason?: InteractionTerminalReason;
  audit: InteractionAuditEntry[];
}

interface InteractionBrokerFile {
  version: 1;
  operations: InteractionBrokerRecord[];
  /** Durable app-server lifecycle epoch keyed by provider session. */
  sessionEpochs: Record<string, { generation: number; active: boolean }>;
}

const ActorSchema = z.object({
  id: z.string().min(1).max(512),
  displayName: z.string().min(1).max(512).optional(),
  channel: z.enum(["yep", "feishu", "provider", "system"]),
});

const OperationSchema = z.object({
  operationId: z.string().min(1).max(128),
  provider: z.string().min(1).max(128),
  requestId: z.string().min(1).max(2_048),
  requestMethod: z.string().min(1).max(512),
  accountId: z.string().max(128).optional(),
  projectId: z.string().max(2_048).optional(),
  sessionId: z.string().min(1).max(2_048),
  threadId: z.string().max(2_048).optional(),
  turnId: z.string().max(2_048).optional(),
  itemId: z.string().max(2_048).optional(),
  kind: z.enum([
    "command_approval",
    "file_approval",
    "permission_approval",
    "question",
    "mcp_elicitation",
    "dynamic_tool",
    "auth_refresh",
    "attestation",
    "current_time",
    "unknown",
  ]),
  state: z.enum([
    "open",
    "answering",
    "resolved",
    "expired",
    "cancelled",
    "failed",
  ]),
  publicPayload: z.object({
    title: z.string().max(2_048).optional(),
    prompt: z.string().max(8_192),
    summary: z.string().max(8_192).optional(),
    toolName: z.string().max(512).optional(),
    cwd: z.string().max(8_192).optional(),
    command: z.string().max(8_192).optional(),
    files: z.array(z.string().max(8_192)).max(50).optional(),
    permissions: z.array(z.string().max(512)).max(50).optional(),
    questions: z
      .array(
        z.object({
          id: z.string().max(512),
          title: z.string().max(2_048).optional(),
          prompt: z.string().max(8_192),
          type: z.enum(["single_select", "multi_select", "text", "secret"]),
          required: z.boolean().optional(),
          options: z
            .array(
              z.object({
                value: z.string().max(2_048),
                label: z.string().max(2_048),
                description: z.string().max(4_096).optional(),
              }),
            )
            .max(50)
            .optional(),
        }),
      )
      .max(50)
      .optional(),
    details: z
      .array(
        z.object({
          label: z.string().max(512),
          value: z.string().max(8_192),
        }),
      )
      .max(50)
      .optional(),
  }),
  privatePayloadRef: z.string().max(512).optional(),
  allowedActors: z.object({
    mode: z.enum([
      "requester",
      "requester_or_admin",
      "session_owner",
      "any_member",
    ]),
    actorIds: z.array(z.string().max(512)).optional(),
  }),
  allowedDecisions: z
    .array(
      z.object({
        id: z.string().max(512),
        label: z.string().max(2_048).optional(),
        description: z.string().max(4_096).optional(),
        scope: z.enum(["once", "turn", "session", "persistent"]).optional(),
        tone: z.enum(["primary", "neutral", "danger"]).optional(),
        requiresConfirmation: z.boolean().optional(),
      }),
    )
    .max(50),
  createdAt: z.number().finite(),
  expiresAt: z.number().finite().optional(),
  resolvedBy: z
    .object({
      id: z.string().max(512),
      displayName: z.string().max(512).optional(),
      channel: z.string().max(128).optional(),
    })
    .optional(),
  resolution: z
    .object({
      decision: z.string().max(512),
      summary: z.string().max(2_048).optional(),
      resolvedAt: z.number().finite().optional(),
    })
    .optional(),
  version: z.number().int().nonnegative(),
});

const BrokerRecordSchema = z.object({
  schemaVersion: z.literal(1),
  operation: OperationSchema,
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestDiscriminator: z.string().max(2_048).optional(),
  requestAliases: z.array(z.string().min(1).max(2_048)).max(16).default([]),
  owner: z.enum(["process", "bridge"]),
  terminalReason: z
    .enum([
      "timeout",
      "interrupt",
      "process_exit",
      "request_missing",
      "provider_rejected",
      "restart_recovery",
    ])
    .optional(),
  audit: z
    .array(
      z.object({
        at: z.iso.datetime(),
        event: z.enum([
          "opened",
          "refreshed",
          "claimed",
          "resolved",
          "terminated",
          "rejected",
        ]),
        version: z.number().int().nonnegative(),
        actor: ActorSchema.optional(),
        reason: z
          .enum([
            "timeout",
            "interrupt",
            "process_exit",
            "request_missing",
            "provider_rejected",
            "restart_recovery",
            "stale",
            "already_resolved",
          ])
          .optional(),
      }),
    )
    .max(100),
});

const BrokerFileSchema = z.object({
  version: z.literal(1),
  operations: z.array(BrokerRecordSchema),
  sessionEpochs: z
    .record(
      z.string().min(1).max(2_048),
      z.object({
        generation: z.number().int().nonnegative(),
        active: z.boolean(),
      }),
    )
    .default({}),
});

const DEFAULT_EXPIRES_MS = 30 * 60 * 1000;
const DEFAULT_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 2_000;
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Durable, provider-neutral authority for interactive requests.
 *
 * Channel stores may project these records, but only this broker is allowed to
 * claim a request before invoking the provider. Provider callbacks and secret
 * answers are memory-only and are deliberately excluded from the JSON file.
 */
export class InteractionBroker {
  readonly filePath?: string;
  private readonly expiresMs: number;
  private readonly terminalTtlMs: number;
  private readonly maxRecords: number;
  private state: InteractionBrokerFile = {
    version: 1,
    operations: [],
    sessionEpochs: {},
  };
  private initialized: boolean;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly resolvers = new Map<string, InteractionProviderResolver>();
  private readonly terminalWaiters = new Map<
    string,
    Set<(operation: InteractionOperation) => void>
  >();
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;

  constructor(
    options: {
      dataDir?: string;
      expiresMs?: number;
      terminalTtlMs?: number;
      maxRecords?: number;
    } = {},
  ) {
    this.filePath = options.dataDir
      ? join(options.dataDir, "interactions", "operations.json")
      : undefined;
    this.expiresMs = options.expiresMs ?? DEFAULT_EXPIRES_MS;
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.initialized = !this.filePath;
  }

  async initialize(now = new Date()): Promise<void> {
    if (this.initialized) return;
    try {
      const raw = JSON.parse(await readFile(this.filePath as string, "utf8"));
      const parsed = BrokerFileSchema.parse(raw);
      this.state = parsed as InteractionBrokerFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // JSON.parse and schema errors may retain a source excerpt. Do not
        // attach them to the public initialization error because a corrupt
        // durable record can contain credentials from a crashed old writer.
        throw new Error("Invalid interaction broker store");
      }
    }
    this.initialized = true;

    // A provider callback cannot survive a server restart. Any operation that
    // was open or mid-CAS is failed closed. A never-claimed request may be
    // registered afresh when observed again; an answering request is never
    // retried because provider acceptance before the crash is unknowable.
    await this.enqueueWrite(async () => {
      let changed = false;
      const operations = this.state.operations.map((record) => {
        if (!isOpen(record.operation)) return record;
        changed = true;
        return terminateRecord(record, "restart_recovery", now);
      });
      if (changed)
        await this.save({
          version: 1,
          operations,
          sessionEpochs: this.state.sessionEpochs,
        });
    });
    this.scheduleTimeout();
  }

  async register(
    input: RegisterInteractionInput,
  ): Promise<InteractionOperation> {
    this.assertInitialized();
    const discriminator = requestDiscriminator(input.request);
    let operation!: InteractionOperation;
    await this.enqueueWrite(async () => {
      const now = input.now ?? new Date();
      const sessionId = input.request.sessionId;
      const epoch = this.state.sessionEpochs[sessionId] ?? {
        generation: 0,
        active: false,
      };
      if (!epoch.active) {
        await this.save({
          version: 1,
          operations: this.state.operations,
          sessionEpochs: {
            ...this.state.sessionEpochs,
            [sessionId]: { ...epoch, active: true },
          },
        });
      }
      const fingerprint = requestFingerprint(input.request, epoch.generation);
      const claimedTombstone = this.state.operations
        .filter(
          (record) =>
            record.audit.some((entry) => entry.event === "claimed") &&
            sameCanonicalNativeRequest(record, input.request) &&
            compatibleRequestDiscriminator(
              record.requestDiscriminator,
              discriminator,
            ),
        )
        .at(-1);
      const existing =
        claimedTombstone ??
        this.state.operations
          .filter(
            (record) =>
              record.operation.sessionId === input.request.sessionId &&
              record.requestFingerprint === fingerprint &&
              compatibleRequestDiscriminator(
                record.requestDiscriminator,
                discriminator,
              ),
          )
          .at(-1);
      if (existing && !canReopenAfterRestart(existing)) {
        operation = existing.operation;
        const requestAliases = mergeRequestAliases(
          existing.requestAliases,
          input.request.id,
        );
        const requestDiscriminator =
          existing.requestDiscriminator ?? discriminator;
        if (operation.state === "open") {
          this.resolvers.set(operation.operationId, input.resolveProvider);
          const refreshed = refreshOpenOperation(
            operation,
            input,
            now,
            this.expiresMs,
          );
          if (
            refreshed !== operation ||
            requestAliases !== existing.requestAliases ||
            requestDiscriminator !== existing.requestDiscriminator
          ) {
            const updated = appendAudit(
              {
                ...existing,
                owner: input.owner,
                operation: refreshed,
                requestAliases,
                requestDiscriminator,
              },
              {
                at: now.toISOString(),
                event: "refreshed",
                version: refreshed.version,
              },
            );
            await this.replace(
              this.state.operations.lastIndexOf(existing),
              updated,
            );
            operation = refreshed;
          }
        } else if (operation.state === "answering") {
          // The claim already captured its exact provider resolver. A later
          // duplicate transport snapshot must not retarget the in-flight call.
          operation = existing.operation;
          if (
            requestAliases !== existing.requestAliases ||
            requestDiscriminator !== existing.requestDiscriminator
          ) {
            await this.replace(this.state.operations.lastIndexOf(existing), {
              ...existing,
              requestAliases,
              requestDiscriminator,
            });
          }
        }
        if (isOpen(operation) && input.supersedeSession) {
          await this.supersedeOtherOpenOperations(
            operation.sessionId,
            operation.operationId,
            now,
            input.owner,
          );
        }
        return;
      }

      const expiresAt = interactionExpiresAt(
        input.request,
        now,
        this.expiresMs,
      );
      const createdAt = safeTimestamp(input.request.timestamp, now.getTime());
      operation = {
        operationId: `int_${randomUUID()}`,
        provider: input.provider,
        requestId: input.request.id,
        requestMethod: requestMethod(input.request),
        projectId: input.projectId,
        sessionId: input.request.sessionId,
        threadId: readString(asRecord(input.request.toolInput)?.threadId),
        turnId: readString(asRecord(input.request.toolInput)?.turnId),
        itemId:
          readString(asRecord(input.request.toolInput)?.itemId) ??
          readString(asRecord(input.request.toolInput)?.callId),
        kind: interactionKind(input.request),
        state: "open",
        publicPayload: safePublicPayload(input.request),
        allowedActors: { mode: "any_member" },
        allowedDecisions: allowedDecisions(input.request),
        createdAt,
        expiresAt,
        version: 0,
      };
      const record: InteractionBrokerRecord = {
        schemaVersion: 1,
        operation,
        requestFingerprint: fingerprint,
        requestDiscriminator: discriminator,
        requestAliases: [input.request.id],
        owner: input.owner,
        audit: [
          {
            at: now.toISOString(),
            event: "opened",
            version: 0,
          },
        ],
      };
      this.resolvers.set(operation.operationId, input.resolveProvider);
      await this.save({
        version: 1,
        operations: this.trim([...this.state.operations, record], now),
        sessionEpochs: this.state.sessionEpochs,
      });
      if (input.supersedeSession) {
        await this.supersedeOtherOpenOperations(
          operation.sessionId,
          operation.operationId,
          now,
          input.owner,
        );
      }
    });
    this.scheduleTimeout();
    return structuredClone(operation);
  }

  get(operationId: string): InteractionOperation | undefined {
    this.assertInitialized();
    const record = this.state.operations.find(
      (candidate) => candidate.operation.operationId === operationId,
    );
    return record ? structuredClone(record.operation) : undefined;
  }

  findCurrent(
    sessionId: string,
    requestId: string,
  ): InteractionOperation | undefined {
    this.assertInitialized();
    const records = this.state.operations.filter(
      (record) =>
        record.operation.sessionId === sessionId &&
        matchesRequestAlias(record, requestId),
    );
    const open = [...records]
      .reverse()
      .find((record) => isOpen(record.operation));
    const record = open ?? records.at(-1);
    return record ? structuredClone(record.operation) : undefined;
  }

  listForSession(sessionId: string): InteractionOperation[] {
    this.assertInitialized();
    return this.state.operations
      .filter((record) => record.operation.sessionId === sessionId)
      .map((record) => structuredClone(record.operation));
  }

  async resolve(
    input: ResolveInteractionInput,
  ): Promise<InteractionResolveResult> {
    this.assertInitialized();
    let claimed: InteractionBrokerRecord | undefined;
    let claimedResolver: InteractionProviderResolver | undefined;
    let expiredResolver: InteractionProviderResolver | undefined;
    let expiredProviderInput: InteractionProviderResponse | undefined;
    let earlyResult: InteractionResolveResult | undefined;
    await this.enqueueWrite(async () => {
      const index = this.resolveIndex(input);
      const current = this.state.operations[index];
      if (!current) {
        earlyResult = { state: "not_found" };
        return;
      }
      if (
        current.operation.sessionId !== input.sessionId ||
        !matchesRequestAlias(current, input.requestId)
      ) {
        earlyResult = { state: "not_found" };
        return;
      }
      if (!isOpen(current.operation)) {
        earlyResult = {
          state: "already_resolved",
          operation: structuredClone(current.operation),
        };
        return;
      }
      if (current.operation.state === "answering") {
        earlyResult = {
          state: "already_resolved",
          operation: structuredClone(current.operation),
        };
        return;
      }
      const now = input.now ?? new Date();
      if (
        typeof current.operation.expiresAt === "number" &&
        current.operation.expiresAt <= now.getTime()
      ) {
        const expired = terminateRecord(current, "timeout", now);
        expiredResolver = this.resolvers.get(current.operation.operationId);
        expiredProviderInput = {
          response: "deny",
          operationId: expired.operation.operationId,
          operationVersion: expired.operation.version,
          actor: input.actor,
        };
        this.resolvers.delete(current.operation.operationId);
        await this.replace(index, expired);
        earlyResult = {
          state: "already_resolved",
          operation: structuredClone(expired.operation),
        };
        return;
      }
      if (
        input.expectedVersion !== undefined &&
        current.operation.version !== input.expectedVersion
      ) {
        const rejected = appendAudit(current, {
          at: (input.now ?? new Date()).toISOString(),
          event: "rejected",
          version: current.operation.version,
          actor: input.actor,
          reason: "stale",
        });
        await this.replace(index, rejected);
        earlyResult = {
          state: "stale",
          operation: structuredClone(rejected.operation),
        };
        return;
      }
      if (current.operation.state !== "open") {
        earlyResult = {
          state: "already_resolved",
          operation: structuredClone(current.operation),
        };
        return;
      }
      const nextVersion = current.operation.version + 1;
      claimed = appendAudit(
        {
          ...current,
          operation: {
            ...current.operation,
            state: "answering",
            version: nextVersion,
          },
        },
        {
          at: now.toISOString(),
          event: "claimed",
          version: nextVersion,
          actor: input.actor,
        },
      );
      // Capture the callback under the same serial claim. A hard timeout or
      // process-exit write may immediately remove the registry entry, but the
      // single provider invocation owned by this claim must still occur.
      claimedResolver = this.resolvers.get(current.operation.operationId);
      await this.replace(index, claimed);
    });
    if (expiredResolver) {
      void Promise.resolve()
        .then(() =>
          expiredProviderInput
            ? expiredResolver?.(expiredProviderInput)
            : undefined,
        )
        .catch(() => undefined);
    }
    if (earlyResult) {
      this.scheduleTimeout();
      return earlyResult;
    }
    if (!claimed) return { state: "not_found" };

    const terminalWait = this.waitForTerminal(claimed.operation.operationId);
    const providerInput: InteractionProviderResponse = {
      response: input.response,
      answers: input.answers,
      feedback: input.feedback,
      operationId: claimed.operation.operationId,
      operationVersion: claimed.operation.version,
      actor: input.actor,
    };
    const providerResult = Promise.resolve()
      .then(() => (claimedResolver ? claimedResolver(providerInput) : false))
      .then(
        (accepted) => ({ kind: "provider" as const, accepted }),
        () => ({ kind: "provider" as const, accepted: false }),
      );
    const providerOutcome = await Promise.race([
      providerResult,
      terminalWait.promise.then((operation) => ({
        kind: "terminal" as const,
        operation,
      })),
    ]);
    terminalWait.cancel();
    if (providerOutcome.kind === "terminal") {
      return {
        state: "already_resolved",
        operation: providerOutcome.operation,
      };
    }
    const accepted = providerOutcome.accepted;

    let result!: InteractionResolveResult;
    await this.enqueueWrite(async () => {
      const index = this.state.operations.findIndex(
        (record) =>
          record.operation.operationId === claimed?.operation.operationId,
      );
      const current = this.state.operations[index];
      if (!current) {
        result = { state: "not_found" };
        return;
      }
      if (
        current.operation.state !== "answering" ||
        current.operation.version !== claimed?.operation.version
      ) {
        result = {
          state: "already_resolved",
          operation: structuredClone(current.operation),
        };
        return;
      }
      const now = input.now ?? new Date();
      const nextVersion = current.operation.version + 1;
      if (!accepted) {
        const terminalReason = input.terminalReason ?? "provider_rejected";
        const failed = appendAudit(
          {
            ...current,
            terminalReason,
            operation: {
              ...current.operation,
              state: terminalReason === "timeout" ? "expired" : "failed",
              version: nextVersion,
              resolvedBy: actorProjection(input.actor),
              resolution: {
                decision: input.response,
                summary: terminalReason,
                resolvedAt: now.getTime(),
              },
            },
          },
          {
            at: now.toISOString(),
            event: "terminated",
            version: nextVersion,
            actor: input.actor,
            reason: terminalReason,
          },
        );
        await this.replace(index, failed);
        result = {
          state: "provider_rejected",
          operation: structuredClone(failed.operation),
        };
        return;
      }
      if (input.terminalReason === "timeout") {
        const expired = appendAudit(
          {
            ...current,
            terminalReason: "timeout",
            operation: {
              ...current.operation,
              state: "expired",
              version: nextVersion,
              resolvedBy: actorProjection(input.actor),
              resolution: {
                decision: input.response,
                summary: "timeout",
                resolvedAt: now.getTime(),
              },
            },
          },
          {
            at: now.toISOString(),
            event: "terminated",
            version: nextVersion,
            actor: input.actor,
            reason: "timeout",
          },
        );
        await this.replace(index, expired);
        result = {
          state: "resolved",
          operation: structuredClone(expired.operation),
        };
        return;
      }
      const resolved = appendAudit(
        {
          ...current,
          operation: {
            ...current.operation,
            state: "resolved",
            version: nextVersion,
            resolvedBy: actorProjection(input.actor),
            resolution: {
              decision: input.response,
              resolvedAt: now.getTime(),
            },
          },
        },
        {
          at: now.toISOString(),
          event: "resolved",
          version: nextVersion,
          actor: input.actor,
        },
      );
      await this.replace(index, resolved);
      result = {
        state: "resolved",
        operation: structuredClone(resolved.operation),
      };
    });
    this.resolvers.delete(claimed.operation.operationId);
    this.scheduleTimeout();
    return result;
  }

  async terminateSession(
    sessionId: string,
    reason: Exclude<InteractionTerminalReason, "timeout" | "provider_rejected">,
    now = new Date(),
    keepRequestId?: string,
  ): Promise<InteractionOperation[]> {
    this.assertInitialized();
    const terminated: InteractionOperation[] = [];
    await this.enqueueWrite(async () => {
      const currentEpoch = this.state.sessionEpochs[sessionId];
      const epochChanged = reason === "process_exit" && currentEpoch?.active;
      const sessionEpochs = epochChanged
        ? {
            ...this.state.sessionEpochs,
            [sessionId]: {
              generation: currentEpoch.generation + 1,
              active: false,
            },
          }
        : this.state.sessionEpochs;
      const operations = this.state.operations.map((record) => {
        if (
          record.operation.sessionId !== sessionId ||
          !canTerminateForLifecycle(record.operation, reason) ||
          (keepRequestId && matchesRequestAlias(record, keepRequestId))
        ) {
          return record;
        }
        const next = terminateRecord(record, reason, now);
        terminated.push(structuredClone(next.operation));
        this.resolvers.delete(next.operation.operationId);
        return next;
      });
      if (terminated.length > 0 || epochChanged) {
        await this.save({ version: 1, operations, sessionEpochs });
      }
    });
    for (const operation of terminated) this.notifyTerminal(operation);
    this.scheduleTimeout();
    return terminated;
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    this.resolvers.clear();
    this.terminalWaiters.clear();
  }

  private resolveIndex(input: ResolveInteractionInput): number {
    if (input.operationId) {
      return this.state.operations.findIndex(
        (record) => record.operation.operationId === input.operationId,
      );
    }
    return this.state.operations.findIndex(
      (record) =>
        record.operation.sessionId === input.sessionId &&
        matchesRequestAlias(record, input.requestId) &&
        isOpen(record.operation),
    );
  }

  private scheduleTimeout(): void {
    if (this.shuttingDown) return;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    const now = Date.now();
    const next = this.state.operations
      .filter((record) => isOpen(record.operation))
      .map((record) => record.operation.expiresAt)
      .filter((value): value is number => typeof value === "number")
      .reduce<number | undefined>(
        (earliest, value) =>
          earliest === undefined || value < earliest ? value : earliest,
        undefined,
      );
    if (next === undefined) return;
    this.timeoutTimer = setTimeout(
      () => {
        this.timeoutTimer = undefined;
        void this.expireDue().catch(() => undefined);
      },
      Math.min(MAX_TIMEOUT_DELAY_MS, Math.max(0, next - now)),
    );
    this.timeoutTimer.unref?.();
  }

  private async expireDue(now = new Date()): Promise<void> {
    const due = this.state.operations
      .filter(
        (record) =>
          isOpen(record.operation) &&
          typeof record.operation.expiresAt === "number" &&
          record.operation.expiresAt <= now.getTime(),
      )
      .map((record) => structuredClone(record.operation));
    for (const operation of due) {
      const resolver = this.resolvers.get(operation.operationId);
      if (operation.state === "open" && resolver) {
        // The provider callback is intentionally not awaited here. The durable
        // timeout must close at its deadline even if an IPC/bridge response
        // hangs; resolve has already queued the answering claim ahead of the
        // forceTimeout write, and its eventual completion cannot reopen it.
        void this.resolve({
          sessionId: operation.sessionId,
          requestId: operation.requestId,
          operationId: operation.operationId,
          expectedVersion: operation.version,
          response: "deny",
          actor: { id: "interaction-timeout", channel: "system" },
          now,
          terminalReason: "timeout",
        }).catch(() => undefined);
      }
      await this.forceTimeout(operation.operationId, now);
    }
    this.scheduleTimeout();
  }

  private async forceTimeout(operationId: string, now: Date): Promise<void> {
    await this.enqueueWrite(async () => {
      const index = this.state.operations.findIndex(
        (record) => record.operation.operationId === operationId,
      );
      const current = this.state.operations[index];
      if (!current || !isOpen(current.operation)) return;
      const expired = terminateRecord(current, "timeout", now);
      await this.replace(index, expired);
      this.resolvers.delete(operationId);
    });
  }

  private trim(
    operations: InteractionBrokerRecord[],
    now: Date,
  ): InteractionBrokerRecord[] {
    const cutoff = now.getTime() - this.terminalTtlMs;
    const retained = operations.filter(
      (record) =>
        isOpen(record.operation) ||
        (record.operation.resolution?.resolvedAt ??
          record.operation.createdAt) >= cutoff,
    );
    if (retained.length <= this.maxRecords) return retained;
    const open = retained.filter((record) => isOpen(record.operation));
    const terminal = retained.filter((record) => !isOpen(record.operation));
    return [
      ...open,
      ...terminal.slice(
        Math.max(0, terminal.length - (this.maxRecords - open.length)),
      ),
    ];
  }

  private async replace(
    index: number,
    record: InteractionBrokerRecord,
  ): Promise<void> {
    const operations = [...this.state.operations];
    operations[index] = record;
    await this.save({
      version: 1,
      operations,
      sessionEpochs: this.state.sessionEpochs,
    });
    if (!isOpen(record.operation)) this.notifyTerminal(record.operation);
  }

  private async supersedeOtherOpenOperations(
    sessionId: string,
    keepOperationId: string,
    now: Date,
    owner: InteractionPendingOwner,
  ): Promise<void> {
    let changed = false;
    const operations = this.state.operations.map((record) => {
      if (
        record.operation.sessionId !== sessionId ||
        record.operation.operationId === keepOperationId ||
        record.owner !== owner ||
        !canTerminateForLifecycle(record.operation, "request_missing")
      ) {
        return record;
      }
      changed = true;
      this.resolvers.delete(record.operation.operationId);
      return terminateRecord(record, "request_missing", now);
    });
    if (changed)
      await this.save({
        version: 1,
        operations,
        sessionEpochs: this.state.sessionEpochs,
      });
  }

  private waitForTerminal(operationId: string): {
    promise: Promise<InteractionOperation>;
    cancel: () => void;
  } {
    let waiter: ((operation: InteractionOperation) => void) | undefined;
    const promise = new Promise<InteractionOperation>((resolve) => {
      const current = this.state.operations.find(
        (record) => record.operation.operationId === operationId,
      )?.operation;
      if (current && !isOpen(current)) {
        resolve(structuredClone(current));
        return;
      }
      waiter = resolve;
      const waiters = this.terminalWaiters.get(operationId) ?? new Set();
      waiters.add(resolve);
      this.terminalWaiters.set(operationId, waiters);
    });
    return {
      promise,
      cancel: () => {
        if (!waiter) return;
        const waiters = this.terminalWaiters.get(operationId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.terminalWaiters.delete(operationId);
      },
    };
  }

  private notifyTerminal(operation: InteractionOperation): void {
    const waiters = this.terminalWaiters.get(operation.operationId);
    if (!waiters) return;
    this.terminalWaiters.delete(operation.operationId);
    const projected = structuredClone(operation);
    for (const resolve of waiters) resolve(projected);
  }

  private async save(next: InteractionBrokerFile): Promise<void> {
    if (this.filePath) {
      // The live projection may contain command/question context needed by
      // connected clients. The durable authority only needs identity, CAS,
      // actor, and terminal metadata; raw provider text and paths can contain
      // credentials and are therefore stripped at the persistence boundary.
      await atomicWriteJson(this.filePath, durableFileProjection(next));
    }
    this.state = next;
  }

  private async enqueueWrite(action: () => Promise<void>): Promise<void> {
    const write = this.writeChain.then(action);
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new Error("InteractionBroker is not initialized");
  }
}

function isOpen(operation: InteractionOperation): boolean {
  return operation.state === "open" || operation.state === "answering";
}

function canTerminateForLifecycle(
  operation: InteractionOperation,
  reason: Exclude<InteractionTerminalReason, "timeout" | "provider_rejected">,
): boolean {
  if (operation.state === "open") return true;
  // A routine transition away from waiting-input can be emitted while the
  // provider accepts the winning response. Hard terminal signals still close
  // an in-flight operation fail-closed.
  return operation.state === "answering" && reason !== "request_missing";
}

function terminateRecord(
  record: InteractionBrokerRecord,
  reason: InteractionTerminalReason,
  now: Date,
): InteractionBrokerRecord {
  const version = record.operation.version + 1;
  const state: InteractionOperationState =
    reason === "timeout"
      ? "expired"
      : reason === "interrupt" || reason === "request_missing"
        ? "cancelled"
        : "failed";
  const actor: InteractionResolutionActor = {
    id: `interaction-${reason}`,
    channel: "system",
  };
  return appendAudit(
    {
      ...record,
      terminalReason: reason,
      operation: {
        ...record.operation,
        state,
        version,
        resolvedBy: actorProjection(actor),
        resolution: {
          decision: reason,
          summary: reason,
          resolvedAt: now.getTime(),
        },
      },
    },
    {
      at: now.toISOString(),
      event: "terminated",
      version,
      actor,
      reason,
    },
  );
}

function appendAudit(
  record: InteractionBrokerRecord,
  entry: InteractionAuditEntry,
): InteractionBrokerRecord {
  return { ...record, audit: [...record.audit, entry].slice(-100) };
}

function actorProjection(actor: InteractionResolutionActor) {
  return {
    id: actor.id,
    displayName: actor.displayName,
    channel: actor.channel,
  };
}

function canReopenAfterRestart(record: InteractionBrokerRecord): boolean {
  return (
    record.terminalReason === "restart_recovery" &&
    !record.audit.some((entry) => entry.event === "claimed")
  );
}

function matchesRequestAlias(
  record: InteractionBrokerRecord,
  requestId: string,
): boolean {
  const canonical = canonicalTransportRequestId(requestId);
  return (
    record.operation.requestId === requestId ||
    record.requestAliases.includes(requestId) ||
    canonicalTransportRequestId(record.operation.requestId) === canonical ||
    record.requestAliases.some(
      (alias) => canonicalTransportRequestId(alias) === canonical,
    )
  );
}

function sameCanonicalNativeRequest(
  record: InteractionBrokerRecord,
  request: InputRequest,
): boolean {
  if (
    record.operation.sessionId !== request.sessionId ||
    record.operation.requestMethod !== requestMethod(request)
  ) {
    return false;
  }
  const nativeId = canonicalTransportRequestId(
    request.providerRequestId?.trim() || request.id,
  );
  return [record.operation.requestId, ...record.requestAliases].some(
    (alias) => canonicalTransportRequestId(alias) === nativeId,
  );
}

function canonicalTransportRequestId(requestId: string): string {
  if (requestId.startsWith("codex:")) return requestId;
  const parts = requestId.split("|");
  if (
    parts[0]?.startsWith("connection:") &&
    /^(?:string|number):/.test(parts[1] ?? "")
  ) {
    return `codex:${parts[1]}`;
  }
  return requestId;
}

function mergeRequestAliases(existing: string[], requestId: string): string[] {
  if (existing.includes(requestId)) return existing;
  return [...existing, requestId].slice(-16);
}

function durableFileProjection(
  file: InteractionBrokerFile,
): InteractionBrokerFile {
  return {
    version: 1,
    sessionEpochs: file.sessionEpochs,
    operations: file.operations.map((record) => ({
      ...record,
      operation: {
        ...record.operation,
        publicPayload: { prompt: "Input required" },
        allowedDecisions: [],
        resolvedBy: record.operation.resolvedBy
          ? {
              id: durableActorId(record.operation.resolvedBy.id),
              channel: record.operation.resolvedBy.channel,
            }
          : undefined,
        resolution: record.operation.resolution
          ? {
              decision: record.operation.resolution.decision,
              resolvedAt: record.operation.resolution.resolvedAt,
            }
          : undefined,
      },
      audit: record.audit.map((entry) => ({
        ...entry,
        actor: entry.actor
          ? {
              id: durableActorId(entry.actor.id),
              channel: entry.actor.channel,
            }
          : undefined,
      })),
    })),
  };
}

function requestFingerprint(request: InputRequest, generation = 0): string {
  const providerRequestId =
    request.providerRequestId?.trim() || request.id.trim();
  const providerRequestMethod =
    request.providerRequestMethod?.trim() || requestMethod(request);
  const identity = [
    request.sessionId,
    providerRequestId,
    providerRequestMethod,
  ].join("\0");
  return (
    createHash("sha256")
      // Generation zero preserves fingerprints written by older broker files.
      // After a hard provider exit, the durable epoch distinguishes JSON-RPC
      // ids reused by a new app-server while every transport in the same
      // provider lifetime still converges on one identity.
      .update(generation === 0 ? identity : `${identity}\0epoch:${generation}`)
      .digest("hex")
  );
}

function durableActorId(actorId: string): string {
  if (/^sha256:[a-f0-9]{64}$/.test(actorId)) return actorId;
  return `sha256:${createHash("sha256").update(actorId).digest("hex")}`;
}

function requestDiscriminator(request: InputRequest): string | undefined {
  const input = asRecord(request.toolInput);
  const coordinates = [
    readString(input?.turnId),
    readString(input?.itemId),
    readString(input?.callId),
    readString(input?.approvalId),
    readString(input?.elicitationId),
  ].filter((value): value is string => value !== undefined);
  return coordinates.length > 0 ? coordinates.join("\0") : undefined;
}

function compatibleRequestDiscriminator(
  existing: string | undefined,
  incoming: string | undefined,
): boolean {
  return !existing || !incoming || existing === incoming;
}

function refreshOpenOperation(
  existing: InteractionOperation,
  input: RegisterInteractionInput,
  now: Date,
  defaultExpiresMs: number,
): InteractionOperation {
  const toolInput = asRecord(input.request.toolInput);
  const incomingExpiresAt = interactionExpiresAt(
    input.request,
    now,
    defaultExpiresMs,
  );
  const projected: InteractionOperation = {
    ...existing,
    provider: chooseProvider(existing.provider, input.provider),
    requestMethod:
      chooseProjectionString(
        existing.requestMethod,
        requestMethod(input.request),
      ) ?? existing.requestMethod,
    projectId: chooseProjectionString(existing.projectId, input.projectId),
    threadId: chooseProjectionString(
      existing.threadId,
      readString(toolInput?.threadId),
    ),
    turnId: chooseProjectionString(
      existing.turnId,
      readString(toolInput?.turnId),
    ),
    itemId: chooseProjectionString(
      existing.itemId,
      readString(toolInput?.itemId) ?? readString(toolInput?.callId),
    ),
    kind: chooseInteractionKind(existing.kind, interactionKind(input.request)),
    publicPayload: mergeSafePublicPayload(
      existing.publicPayload,
      safePublicPayload(input.request),
    ),
    allowedDecisions:
      chooseRicherArray(
        existing.allowedDecisions,
        allowedDecisions(input.request),
      ) ?? existing.allowedDecisions,
    createdAt: Math.min(
      existing.createdAt,
      safeTimestamp(input.request.timestamp, now.getTime()),
    ),
    expiresAt: Math.min(
      existing.expiresAt ?? incomingExpiresAt,
      incomingExpiresAt,
    ),
  };
  if (JSON.stringify(projected) === JSON.stringify(existing)) return existing;
  return { ...projected, version: existing.version + 1 };
}

function mergeSafePublicPayload(
  existing: SafeInteractionPayload,
  incoming: SafeInteractionPayload,
): SafeInteractionPayload {
  return {
    title: chooseProjectionString(existing.title, incoming.title),
    prompt:
      chooseProjectionString(existing.prompt, incoming.prompt) ??
      existing.prompt,
    summary: chooseProjectionString(existing.summary, incoming.summary),
    toolName: chooseProjectionString(existing.toolName, incoming.toolName),
    cwd: chooseProjectionString(existing.cwd, incoming.cwd),
    command: chooseProjectionString(existing.command, incoming.command),
    files: mergeStringSets(existing.files, incoming.files),
    permissions: mergeStringSets(existing.permissions, incoming.permissions),
    questions: chooseRicherArray(existing.questions, incoming.questions),
    details: chooseRicherArray(existing.details, incoming.details),
  };
}

function chooseProjectionString(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.length !== right.length) {
    return left.length > right.length ? left : right;
  }
  return left.localeCompare(right) <= 0 ? left : right;
}

function chooseProvider(left: string, right: string): string {
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  return chooseProjectionString(left, right) ?? left;
}

function chooseInteractionKind(
  left: InteractionOperationKind,
  right: InteractionOperationKind,
): InteractionOperationKind {
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  return left.localeCompare(right) <= 0 ? left : right;
}

function mergeStringSets(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])].sort();
  return merged.length > 0 ? merged.slice(0, 50) : undefined;
}

function chooseRicherArray<T>(
  left: T[] | undefined,
  right: T[] | undefined,
): T[] | undefined {
  if (!left?.length) return right;
  if (!right?.length) return left;
  const leftProjection = JSON.stringify(left);
  const rightProjection = JSON.stringify(right);
  if (leftProjection.length !== rightProjection.length) {
    return leftProjection.length > rightProjection.length ? left : right;
  }
  return leftProjection.localeCompare(rightProjection) <= 0 ? left : right;
}

function interactionExpiresAt(
  request: InputRequest,
  now: Date,
  defaultExpiresMs: number,
): number {
  const autoResolutionMs = asRecord(request.toolInput)?.autoResolutionMs;
  if (
    typeof autoResolutionMs === "number" &&
    Number.isFinite(autoResolutionMs) &&
    autoResolutionMs > 0
  ) {
    const requestedAt = Math.min(
      safeTimestamp(request.timestamp, now.getTime()),
      now.getTime(),
    );
    return requestedAt + autoResolutionMs;
  }
  return now.getTime() + defaultExpiresMs;
}

function safeTimestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function interactionKind(request: InputRequest): InteractionOperationKind {
  const input = asRecord(request.toolInput);
  const kind = readString(input?.interactionKind);
  if (
    kind === "command_approval" ||
    kind === "file_approval" ||
    kind === "permission_approval" ||
    kind === "question" ||
    kind === "mcp_elicitation" ||
    kind === "dynamic_tool" ||
    kind === "auth_refresh" ||
    kind === "attestation" ||
    kind === "current_time" ||
    kind === "unknown"
  ) {
    return kind;
  }
  const approvalKind = readString(input?.approvalKind);
  if (approvalKind === "file-change" || approvalKind === "file_change") {
    return "file_approval";
  }
  if (approvalKind === "permissions") return "permission_approval";
  if (
    approvalKind === "mcp-elicitation" ||
    approvalKind === "mcp_elicitation" ||
    approvalKind === "mcp_tool_call" ||
    approvalKind === "mcp_tool_suggestion" ||
    approvalKind === "mcp_url_action"
  ) {
    return "mcp_elicitation";
  }
  if (request.type !== "tool-approval") return "question";
  return "command_approval";
}

function requestMethod(request: InputRequest): string {
  if (request.providerRequestMethod?.trim()) {
    return request.providerRequestMethod.trim();
  }
  const input = asRecord(request.toolInput);
  const explicit = readString(input?.requestMethod);
  if (explicit) return explicit;
  const kind = interactionKind(request);
  if (kind === "file_approval") return "item/fileChange/requestApproval";
  if (kind === "permission_approval") return "item/permissions/requestApproval";
  if (kind === "question") return "item/tool/requestUserInput";
  if (kind === "mcp_elicitation") return "mcpServer/elicitation/request";
  return "item/commandExecution/requestApproval";
}

function safePublicPayload(request: InputRequest): SafeInteractionPayload {
  const input = asRecord(request.toolInput);
  const command = readString(input?.command);
  const cwd = readString(input?.cwd);
  const questions = safeQuestions(input?.questions);
  const files = safeFilePaths(input);
  const permissions = safePermissions(input?.permissions);
  return {
    title: truncate(request.toolName, 2_048),
    prompt:
      truncate(request.prompt || "Input required", 8_192) ?? "Input required",
    toolName: truncate(request.toolName, 512),
    cwd: truncate(cwd, 8_192),
    command: truncate(command, 8_192),
    files: files.length > 0 ? files : undefined,
    permissions: permissions.length > 0 ? permissions : undefined,
    questions: questions.length > 0 ? questions : undefined,
  };
}

function safeFilePaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const paths: string[] = [];
  if (Array.isArray(input.fileChanges)) {
    for (const change of input.fileChanges.slice(0, 50)) {
      const path = readString(asRecord(change)?.path);
      if (path) paths.push(truncate(path, 8_192) ?? path);
    }
  }
  const grantRoot = readString(input.grantRoot);
  if (grantRoot) paths.push(truncate(grantRoot, 8_192) ?? grantRoot);
  return [...new Set(paths)].slice(0, 50);
}

function safeQuestions(value: unknown): SafeInteractionQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry, index) => {
    const question = asRecord(entry);
    if (!question) return [];
    const prompt =
      readString(question.question) ??
      readString(question.prompt) ??
      "Question";
    const inputType = readString(question.inputType);
    const multi = question.multiSelect === true;
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 50).flatMap((option) => {
          const record = asRecord(option);
          const label = readString(record?.label) ?? readString(option);
          const optionValue = readString(record?.value) ?? label;
          return label && optionValue
            ? [
                {
                  value: truncate(optionValue, 2_048) ?? "",
                  label: truncate(label, 2_048) ?? "",
                  description: truncate(readString(record?.description), 4_096),
                },
              ]
            : [];
        })
      : undefined;
    return [
      {
        id:
          truncate(readString(question.id) ?? String(index), 512) ??
          String(index),
        title: truncate(readString(question.header), 2_048),
        prompt: truncate(prompt, 8_192) ?? "Question",
        type:
          inputType === "password"
            ? "secret"
            : options && options.length > 0
              ? multi
                ? "multi_select"
                : "single_select"
              : "text",
        required: question.required !== false,
        options: options && options.length > 0 ? options : undefined,
      },
    ];
  });
}

function safePermissions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.slice(0, 50).flatMap((entry) => {
      const category =
        readString(entry) ??
        readString(asRecord(entry)?.type) ??
        readString(asRecord(entry)?.kind);
      return category ? [truncate(category, 512) ?? category] : [];
    });
  }
  const record = asRecord(value);
  return record
    ? Object.keys(record)
        .slice(0, 50)
        .map((category) => truncate(category, 512) ?? category)
    : [];
}

function allowedDecisions(request: InputRequest): NativeDecisionDescriptor[] {
  if (request.type !== "tool-approval") {
    return [
      { id: "submit", scope: "once", tone: "primary" },
      { id: "decline", scope: "once", tone: "danger" },
    ];
  }
  const available = asRecord(request.toolInput)?.availableDecisions;
  const ids = Array.isArray(available)
    ? available.flatMap((value) => {
        const id = truncate(readString(value), 512);
        return id ? [id] : [];
      })
    : ["accept", "decline"];
  return [...new Set(ids)].slice(0, 50).map((id) => ({
    id,
    scope: id.toLowerCase().includes("session") ? "session" : "once",
    tone: /decline|deny|cancel/i.test(id) ? "danger" : "primary",
  }));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(value: string | undefined, max: number): string | undefined {
  return value && value.length > max ? value.slice(0, max) : value;
}

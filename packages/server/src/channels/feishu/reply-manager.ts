import type { FeishuReplyMode, InputRequest } from "@yep-anywhere/shared";
import type {
  RuntimeSessionSubscription,
  RuntimeSessionSubscriptionOptions,
} from "../../runtime/types.js";
import type { SessionCommandService } from "../../services/SessionCommandService.js";
import {
  MAX_GENERATED_ARTIFACT_BYTES,
  MAX_INLINE_GENERATED_IMAGE_BYTES,
  type UploadManager,
} from "../../uploads/index.js";
import type { FeishuDurableInbox } from "./inbox.js";
import type { FeishuInteractionManager } from "./interaction-manager.js";
import type { FeishuMessageApi } from "./normalization/types.js";
import {
  type FeishuStreamingReplyTarget,
  hasFeishuOutboundApi,
} from "./outbound.js";
import {
  FeishuReplyController,
  type FeishuReplyState,
} from "./reply-controller.js";
import type { FeishuStatusRegistry } from "./status.js";
import { buildYepFeishuTurnDeepLink } from "./yep-deep-link.js";

export interface FeishuReplyManagerOptions {
  sessionCommandService: SessionCommandService;
  inbox: FeishuDurableInbox;
  interactionManager?: FeishuInteractionManager;
  statusRegistry?: FeishuStatusRegistry;
  uploadManager?: UploadManager;
  /** Explicit externally reachable Yep base URL; local/default URLs are rejected. */
  publicBaseUrl?: string;
  controllerOptions?: {
    throttleMs?: number;
    maxCardChars?: number;
    maxTextChars?: number;
  };
}

export interface FeishuTurnReplyInput {
  accountId: string;
  scopeKey: string;
  projectId: string;
  sessionId: string;
  tempId: string;
  inboxKeys: string[];
  replyMode: FeishuReplyMode;
  api?: FeishuMessageApi;
  target: FeishuStreamingReplyTarget;
  threadId?: string;
  requesterOpenId?: string;
  /** Start user feedback now, then subscribe after atomic start returns its ID. */
  deferSubscription?: boolean;
  allowedOperatorOpenIds: string[];
}

export interface FeishuTurnReplyHandle {
  dispatchAccepted(
    sessionId?: string,
    runtime?: FeishuDispatchRuntimeGeneration,
  ): Promise<void>;
  dispatchFailed(): Promise<void>;
  addTerminalCleanup(cleanup: () => Promise<void>): void;
  setUsageLimitFallback(handler: FeishuUsageLimitFallbackHandler): void;
}

export interface FeishuUsageLimitFallbackResult {
  sessionId: string;
  processId: string;
}

export type FeishuUsageLimitFallbackHandler = () => Promise<
  FeishuUsageLimitFallbackResult | undefined
>;

export interface FeishuDispatchRuntimeGeneration {
  /** Process returned by the accepted SessionCommandService dispatch. */
  processId?: string;
  /** True when Supervisor replaced the process while accepting this turn. */
  restarted?: boolean;
}

interface ManagedReply {
  input: FeishuTurnReplyInput;
  controller: FeishuReplyController;
  subscription?: RuntimeSessionSubscription;
  runtimeGeneration: number;
  runtimeProcessId?: string;
  sessionId: string;
  restoring: boolean;
  dispatchConfirmed: boolean;
  sawTurnMessage: boolean;
  clientUserMessageId?: string;
  turnId?: string;
  pendingRequest?: InputRequest;
  openRequestId?: string;
  interactionChain: Promise<void>;
  terminalCleanups: Array<() => Promise<void>>;
  usageLimitFallback?: {
    handler: FeishuUsageLimitFallbackHandler;
    attempted: boolean;
  };
}

export class FeishuReplyManager {
  private readonly options: FeishuReplyManagerOptions;
  private readonly replies = new Map<string, ManagedReply>();
  private shuttingDown = false;

  constructor(options: FeishuReplyManagerOptions) {
    this.options = options;
  }

  async startTurn(input: FeishuTurnReplyInput): Promise<FeishuTurnReplyHandle> {
    if (this.shuttingDown) throw new Error("FEISHU_REPLY_MANAGER_STOPPED");
    const existing = this.replies.get(input.tempId);
    if (existing) {
      this.assertSameReplyIdentity(existing.input, input);
      mergeInboxKeys(existing.input.inboxKeys, input.inboxKeys);
      return this.createHandle(existing);
    }

    const managed = this.createManagedReply(input, false);
    this.replies.set(input.tempId, managed);
    void managed.controller.start();
    if (!input.deferSubscription) {
      await this.subscribe(managed, input.sessionId);
    }
    return this.createHandle(managed);
  }

  async restoreTurn(input: FeishuTurnReplyInput): Promise<boolean> {
    if (this.shuttingDown) return false;
    const existing = this.replies.get(input.tempId);
    if (existing) {
      this.assertSameReplyIdentity(existing.input, input);
      mergeInboxKeys(existing.input.inboxKeys, input.inboxKeys);
      return true;
    }
    const managed = this.createManagedReply(input, true);
    this.replies.set(input.tempId, managed);
    void managed.controller.start();
    await this.subscribe(managed, input.sessionId);
    if (!managed.subscription) {
      this.replies.delete(input.tempId);
      await managed.controller.detach();
      return false;
    }
    managed.controller.dispatchAccepted();
    this.confirmDispatch(managed);
    return true;
  }

  async sendCommandResult(
    api: FeishuMessageApi | undefined,
    target: FeishuStreamingReplyTarget,
    text: string,
  ): Promise<void> {
    if (!hasFeishuOutboundApi(api)) return;
    await api.sendTextReply(target, text).catch(() => undefined);
  }

  async interruptSession(sessionId: string): Promise<void> {
    const replies = [...this.replies.values()].filter(
      (reply) => reply.sessionId === sessionId,
    );
    for (const reply of replies) {
      const requestId = reply.openRequestId;
      this.enqueueInteraction(reply, () =>
        this.terminateInteractions(reply, "interrupt", requestId),
      );
    }
    await Promise.all(replies.map((reply) => reply.interactionChain));
    await Promise.all(replies.map((reply) => reply.controller.interrupt()));
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const replies = [...this.replies.values()];
    this.replies.clear();
    for (const reply of replies) reply.subscription?.cleanup();
    await Promise.allSettled(replies.map((reply) => reply.interactionChain));
    await Promise.allSettled(replies.map((reply) => reply.controller.detach()));
  }

  private createManagedReply(
    input: FeishuTurnReplyInput,
    restoring: boolean,
  ): ManagedReply {
    const uploadManager = this.options.uploadManager;
    const currentSessionId = (): string =>
      this.replies.get(input.tempId)?.sessionId ?? input.sessionId;
    this.options.statusRegistry?.recordReply(input.accountId, "started");
    const controller = new FeishuReplyController({
      ...(hasFeishuOutboundApi(input.api) ? { api: input.api } : {}),
      target: input.target,
      replyMode: input.replyMode,
      tempId: input.tempId,
      getArtifactDeliveryScope: () => ({
        accountId: input.accountId,
        sessionId:
          this.options.inbox.findByTempId(input.tempId)?.sessionId ??
          currentSessionId(),
      }),
      getYepDeepLink: () => {
        const inboxRecord = this.options.inbox.findByTempId(input.tempId);
        if (!inboxRecord?.sessionId) {
          return {
            state: "unavailable" as const,
            reason: "turn_reference_unavailable" as const,
          };
        }
        return buildYepFeishuTurnDeepLink({
          publicBaseUrl: this.options.publicBaseUrl,
          turnReference: input.tempId,
        });
      },
      ...(uploadManager
        ? {
            readGeneratedArtifact: async (artifact) => {
              const sessionId =
                this.options.inbox.findByTempId(input.tempId)?.sessionId ??
                currentSessionId();
              const result = await uploadManager.readGeneratedArtifactBytes(
                { projectId: input.projectId, sessionId },
                {
                  artifactId: artifact.id,
                  managedRef: artifact.managedRef,
                  fileName: artifact.fileName,
                  mimeType: artifact.mimeType,
                  sizeBytes: artifact.sizeBytes,
                  sha256: artifact.sha256,
                  expiresAtMs: Date.parse(artifact.retention.expiresAt),
                },
              );
              const maxBytes =
                artifact.kind === "image"
                  ? MAX_INLINE_GENERATED_IMAGE_BYTES
                  : MAX_GENERATED_ARTIFACT_BYTES;
              if (result.bytes.byteLength > maxBytes) {
                throw new Error("Generated artifact exceeds delivery limit");
              }
              return result.bytes;
            },
          }
        : {}),
      ...this.options.controllerOptions,
      onMetric: (event, durationMs) => {
        this.options.statusRegistry?.recordReply(
          input.accountId,
          event,
          durationMs,
        );
      },
      onUsageLimitFallback: () => this.attemptUsageLimitFallback(input.tempId),
      onTerminal: async (
        _state: FeishuReplyState,
        outcome: "completed" | "interrupted" | "failed",
      ) => {
        const managed = this.replies.get(input.tempId);
        if (managed) {
          try {
            managed.subscription?.cleanup();
          } catch {
            // Runtime ownership is already terminal; cleanup is best effort.
          }
          managed.subscription = undefined;
          // Invalidate callbacks and queued projections from the detached
          // runtime before resolving the central interaction authority.
          managed.runtimeGeneration += 1;
          await managed.interactionChain;
          await (outcome === "interrupted"
            ? this.terminateInteractions(
                managed,
                "interrupt",
                managed.openRequestId,
              )
            : outcome === "failed"
              ? this.terminateInteractions(
                  managed,
                  "failed",
                  managed.openRequestId,
                )
              : this.reconcileInteractions(managed, null)
          ).catch(() => undefined);
        }
        await Promise.allSettled(
          [...new Set(input.inboxKeys)].map(async (key) => {
            const record = this.options.inbox.get(key);
            if (record?.status === "dispatched") {
              if (outcome === "completed") {
                await this.options.inbox.complete(key);
              } else {
                const errorCode =
                  outcome === "interrupted"
                    ? "TURN_INTERRUPTED"
                    : "RUNTIME_FAILED";
                await this.options.inbox.fail(key, errorCode);
                // `messagesFailed` describes accepted messages that later
                // fail processing. Count only after the durable transition
                // succeeds; intentional turn interruption remains a distinct
                // terminal outcome and is not an execution failure.
                if (outcome === "failed") {
                  this.options.statusRegistry?.recordInbound(
                    record.accountId,
                    "failed",
                    errorCode,
                  );
                }
              }
            }
          }),
        );
        const cleanups = managed?.terminalCleanups.splice(0) ?? [];
        await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
        if (this.replies.get(input.tempId) === managed) {
          this.replies.delete(input.tempId);
        }
      },
    });
    return {
      input,
      controller,
      runtimeGeneration: 0,
      sessionId: input.sessionId,
      restoring,
      dispatchConfirmed: false,
      sawTurnMessage: false,
      interactionChain: Promise.resolve(),
      terminalCleanups: [],
    };
  }

  private createHandle(managed: ManagedReply): FeishuTurnReplyHandle {
    return {
      dispatchAccepted: async (sessionId, runtime) => {
        const priorSessionId = managed.sessionId;
        if (sessionId && sessionId !== managed.sessionId) {
          managed.sessionId = sessionId;
        }
        const acceptedSessionId = managed.sessionId;
        const runtimeProcessChanged = Boolean(
          runtime?.processId &&
            managed.runtimeProcessId &&
            runtime.processId !== managed.runtimeProcessId,
        );
        const mustRebind =
          runtime?.restarted === true ||
          runtimeProcessChanged ||
          priorSessionId !== acceptedSessionId;
        if (mustRebind && managed.subscription) {
          managed.subscription.cleanup();
          managed.subscription = undefined;
          managed.runtimeProcessId = undefined;
          managed.sawTurnMessage = false;
          managed.clientUserMessageId = undefined;
          managed.turnId = undefined;
          managed.pendingRequest = undefined;
        }
        if (!managed.subscription) {
          await this.subscribe(managed, managed.sessionId);
        }
        if (!managed.subscription) {
          await managed.controller.dispatchFailed();
          return;
        }
        managed.controller.dispatchAccepted();
        this.confirmDispatch(managed);
      },
      dispatchFailed: async () => {
        await managed.controller.dispatchFailed();
      },
      addTerminalCleanup: (cleanup) => {
        if (
          managed.controller.state === "completed" ||
          managed.controller.state === "interrupted" ||
          managed.controller.state === "failed"
        ) {
          void cleanup().catch(() => undefined);
          return;
        }
        managed.terminalCleanups.push(cleanup);
      },
      setUsageLimitFallback: (handler) => {
        managed.usageLimitFallback = { handler, attempted: false };
      },
    };
  }

  private async attemptUsageLimitFallback(tempId: string): Promise<boolean> {
    const managed = this.replies.get(tempId);
    const fallback = managed?.usageLimitFallback;
    if (
      !managed ||
      !fallback ||
      fallback.attempted ||
      managed.pendingRequest ||
      managed.openRequestId ||
      [...this.replies.values()].some(
        (candidate) =>
          candidate !== managed &&
          (candidate.input.scopeKey === managed.input.scopeKey ||
            candidate.sessionId === managed.sessionId),
      )
    ) {
      return false;
    }
    fallback.attempted = true;

    try {
      managed.subscription?.cleanup();
    } catch {
      // The failed turn is already terminal; replacement remains safe.
    }
    managed.subscription = undefined;
    managed.runtimeGeneration += 1;
    managed.controller.activateRuntimeGeneration(managed.runtimeGeneration);
    managed.runtimeProcessId = undefined;
    managed.sawTurnMessage = false;
    managed.clientUserMessageId = undefined;
    managed.turnId = undefined;

    const result = await fallback.handler().catch(() => undefined);
    if (!result) return false;
    managed.sessionId = result.sessionId;
    await this.subscribe(managed, result.sessionId);
    managed.runtimeProcessId = result.processId;
    return Boolean(managed.subscription);
  }

  private async subscribe(
    managed: ManagedReply,
    sessionId: string,
  ): Promise<void> {
    if (this.shuttingDown || managed.subscription) return;
    const runtimeGeneration = managed.runtimeGeneration + 1;
    managed.runtimeGeneration = runtimeGeneration;
    managed.runtimeProcessId = undefined;
    managed.controller.activateRuntimeGeneration(runtimeGeneration);
    const options: RuntimeSessionSubscriptionOptions = {
      logLabel: `feishu:${managed.input.accountId}`,
      onError: () => {
        if (runtimeGeneration !== managed.runtimeGeneration) return;
        void managed.controller.handleRuntimeEvent(
          "error",
          undefined,
          runtimeGeneration,
        );
        const requestId = managed.openRequestId;
        this.enqueueInteraction(
          managed,
          () => this.terminateInteractions(managed, "failed", requestId),
          runtimeGeneration,
        );
      },
    };
    const subscription = await this.options.sessionCommandService.subscribe(
      sessionId,
      (eventType, data) => {
        if (runtimeGeneration !== managed.runtimeGeneration) return;
        if (eventType === "connected") {
          const processId = stringValue(objectValue(data)?.processId);
          if (processId) managed.runtimeProcessId = processId;
        }
        void managed.controller.handleRuntimeEvent(
          eventType,
          data,
          runtimeGeneration,
        );
        this.trackAndProjectPendingInput(
          managed,
          eventType,
          data,
          runtimeGeneration,
        );
      },
      options,
    );
    if (runtimeGeneration !== managed.runtimeGeneration) {
      subscription?.cleanup();
      return;
    }
    managed.subscription = subscription ?? undefined;
  }

  private trackAndProjectPendingInput(
    managed: ManagedReply,
    eventType: string,
    data: unknown,
    runtimeGeneration = managed.runtimeGeneration,
  ): void {
    if (!this.options.interactionManager) return;
    if (eventType === "message") {
      const message = objectValue(data);
      if (message?.type === "user") {
        const tempMatches = message.tempId === managed.input.tempId;
        const clientUserMessageId =
          stringValue(message.clientUserMessageId) ?? stringValue(message.uuid);
        if (tempMatches && clientUserMessageId) {
          managed.clientUserMessageId = clientUserMessageId;
        }
        const clientMatches = Boolean(
          clientUserMessageId &&
            clientUserMessageId === managed.clientUserMessageId,
        );
        if (tempMatches || clientMatches) {
          const turnId = runtimeTurnId(message);
          if (turnId && (!managed.turnId || managed.turnId === turnId)) {
            managed.turnId = turnId;
            managed.sawTurnMessage = true;
          }
        }
      }
      if (message?.type === "error") {
        const turnId = runtimeTurnId(message);
        // A scoped SDK error belongs to exactly one Codex turn. Until B's
        // provider echo establishes managed.turnId, or when the IDs differ,
        // it may be A's late terminal and must not close B's interaction.
        // An unscoped error remains process-fatal for the live subscription.
        if (turnId && turnId !== managed.turnId) return;
        const requestId = managed.openRequestId;
        this.enqueueInteraction(
          managed,
          () => this.terminateInteractions(managed, "failed", requestId),
          runtimeGeneration,
        );
      } else if (
        message?.type === "system" &&
        message.subtype === "turn_complete"
      ) {
        const turnId = runtimeTurnId(message);
        if (!turnId || turnId !== managed.turnId) return;
        const turnStatus = stringValue(message.turnStatus);
        const requestId = managed.openRequestId;
        if (turnStatus === "interrupted") {
          this.enqueueInteraction(
            managed,
            () => this.terminateInteractions(managed, "interrupt", requestId),
            runtimeGeneration,
          );
        } else if (turnStatus === "failed") {
          this.enqueueInteraction(
            managed,
            () => this.terminateInteractions(managed, "failed", requestId),
            runtimeGeneration,
          );
        } else {
          this.enqueueInteraction(
            managed,
            () => this.reconcileInteractions(managed, null, requestId),
            runtimeGeneration,
          );
        }
      }
      return;
    }
    if (eventType === "error") {
      const requestId = managed.openRequestId;
      this.enqueueInteraction(
        managed,
        () => this.terminateInteractions(managed, "failed", requestId),
        runtimeGeneration,
      );
      return;
    }
    // `complete` closes the subscription stream, but does not by itself prove
    // that the provider process exited. FeishuReplyController correlates it
    // with the turn echo and reports completed/failed through onTerminal; that
    // outcome performs the matching reconcile/fail operation above.
    if (eventType === "complete") return;
    if (eventType !== "status" && eventType !== "connected") return;
    const status = objectValue(data);
    if (status?.state !== "waiting-input") {
      if (status?.state === "terminated") {
        const requestId = managed.openRequestId;
        this.enqueueInteraction(
          managed,
          () => this.terminateInteractions(managed, "process_exit", requestId),
          runtimeGeneration,
        );
      } else if (
        managed.dispatchConfirmed &&
        managed.sawTurnMessage &&
        managed.turnId &&
        managed.openRequestId
      ) {
        const requestId = managed.openRequestId;
        this.enqueueInteraction(
          managed,
          () => this.reconcileInteractions(managed, null, requestId),
          runtimeGeneration,
        );
      }
      return;
    }
    const request = inputRequestValue(status.request);
    if (!request || request.sessionId !== managed.sessionId) return;
    // Status events do not carry a turn ID. Do not adopt a request until the
    // matching provider user echo has bound this reply to B's real turn;
    // otherwise A's waiting-input state can be reconciled as if it were B.
    if (!managed.sawTurnMessage || !managed.turnId) return;
    const priorRequestId = managed.openRequestId;
    managed.openRequestId = request.id;
    if (priorRequestId && priorRequestId !== request.id) {
      this.enqueueInteraction(
        managed,
        () => this.reconcileInteractions(managed, request.id, priorRequestId),
        runtimeGeneration,
      );
    }
    if (!managed.dispatchConfirmed) {
      managed.pendingRequest = request;
      return;
    }
    this.projectPendingInput(managed, request, runtimeGeneration);
  }

  private confirmDispatch(managed: ManagedReply): void {
    managed.dispatchConfirmed = true;
    const request = managed.pendingRequest;
    if (!request || !managed.sawTurnMessage) return;
    managed.pendingRequest = undefined;
    this.projectPendingInput(managed, request);
  }

  private projectPendingInput(
    managed: ManagedReply,
    request: InputRequest,
    runtimeGeneration = managed.runtimeGeneration,
  ): void {
    const interactionManager = this.options.interactionManager;
    if (!interactionManager) return;
    this.enqueueInteraction(
      managed,
      () =>
        interactionManager.projectPendingInput(
          {
            accountId: managed.input.accountId,
            sessionId: managed.sessionId,
            chatId: managed.input.target.chatId,
            replyToMessageId: managed.input.target.replyToMessageId,
            threadId: managed.input.threadId,
            requesterOpenId: managed.input.requesterOpenId,
            allowedOperatorOpenIds: managed.input.allowedOperatorOpenIds,
            api: managed.input.api,
          },
          request,
        ),
      runtimeGeneration,
    );
  }

  private assertSameReplyIdentity(
    current: FeishuTurnReplyInput,
    candidate: FeishuTurnReplyInput,
  ): void {
    if (
      current.accountId !== candidate.accountId ||
      current.scopeKey !== candidate.scopeKey ||
      current.projectId !== candidate.projectId ||
      current.replyMode !== candidate.replyMode ||
      current.target.chatId !== candidate.target.chatId ||
      current.target.replyToMessageId !== candidate.target.replyToMessageId ||
      current.target.replyInThread !== candidate.target.replyInThread
    ) {
      throw new Error("FEISHU_REPLY_IDENTITY_CONFLICT");
    }
  }

  private enqueueInteraction(
    managed: ManagedReply,
    operation: () => Promise<void>,
    runtimeGeneration?: number,
  ): void {
    managed.interactionChain = managed.interactionChain
      .then(() => {
        if (
          runtimeGeneration !== undefined &&
          runtimeGeneration !== managed.runtimeGeneration
        ) {
          return;
        }
        return operation();
      })
      .catch(() => undefined);
  }

  private async terminateInteractions(
    managed: ManagedReply,
    reason: "interrupt" | "process_exit" | "failed",
    requestId: string | undefined,
  ): Promise<void> {
    const interactionManager = this.options.interactionManager;
    if (!interactionManager) return;
    if (managed.openRequestId === requestId) {
      managed.openRequestId = undefined;
    }
    await interactionManager.terminateOpenOperations(
      this.interactionScope(managed, requestId),
      reason,
    );
  }

  private async reconcileInteractions(
    managed: ManagedReply,
    pendingRequestId: string | null,
    requestId = managed.openRequestId,
  ): Promise<void> {
    const interactionManager = this.options.interactionManager;
    if (!interactionManager || !requestId) return;
    if (managed.openRequestId === requestId) {
      managed.openRequestId = pendingRequestId ?? undefined;
    }
    await interactionManager.reconcileOpenOperations(
      this.interactionScope(managed, requestId),
      pendingRequestId,
    );
  }

  private interactionScope(managed: ManagedReply, requestId?: string) {
    return {
      accountId: managed.input.accountId,
      sessionId: managed.sessionId,
      requestId,
      api: managed.input.api,
    };
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function inputRequestValue(value: unknown): InputRequest | undefined {
  const request = objectValue(value);
  if (
    !request ||
    typeof request.id !== "string" ||
    typeof request.sessionId !== "string" ||
    !["tool-approval", "question", "choice"].includes(String(request.type)) ||
    typeof request.prompt !== "string" ||
    typeof request.timestamp !== "string"
  ) {
    return undefined;
  }
  return request as unknown as InputRequest;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function runtimeTurnId(message: Record<string, unknown>): string | undefined {
  return stringValue(message.turnId) ?? stringValue(message.codexTurnId);
}

function mergeInboxKeys(target: string[], additions: readonly string[]): void {
  const seen = new Set(target);
  for (const key of additions) {
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(key);
  }
}

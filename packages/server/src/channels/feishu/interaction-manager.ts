import type { InputRequest, InteractionOperation } from "@yep-anywhere/shared";
import type { SessionCommandService } from "../../services/SessionCommandService.js";
import {
  type FeishuCardActionEvent,
  type FeishuInputActionValue,
  buildFeishuInputCard,
  buildFeishuQuestionAnswers,
  buildFeishuResolvedInputCard,
  parseFeishuInputActionValue,
} from "./input-request.js";
import type { FeishuMessageApi } from "./normalization/types.js";
import type {
  FeishuNativeDecisionDescriptor,
  FeishuOperationPresentation,
  FeishuOperationRecord,
  FeishuOperationResult,
  FeishuOperationStore,
} from "./operation-store.js";
import {
  type FeishuStreamingReplyTarget,
  hasFeishuInteractionApi,
} from "./outbound.js";
import type { FeishuStatusRegistry } from "./status.js";

export interface FeishuInteractionTurnContext {
  accountId: string;
  sessionId: string;
  chatId: string;
  threadId?: string;
  replyToMessageId: string;
  requesterOpenId?: string;
  allowedOperatorOpenIds: string[];
  api?: FeishuMessageApi;
}

export interface FeishuCardActionEnvelope {
  accountId: string;
  event: FeishuCardActionEvent;
  api?: FeishuMessageApi;
}

export type FeishuCardActionAcceptResult =
  | "ignored"
  | "claimed"
  | "forbidden"
  | "expired"
  | "stale"
  | "already_processed";

export interface FeishuInteractionOperationScope {
  accountId: string;
  sessionId: string;
  requestId?: string;
  api?: FeishuMessageApi;
}

export type FeishuInteractionTerminateReason =
  | "timeout"
  | "interrupt"
  | "process_exit"
  | "failed";

type FeishuInteractionAccountContext = {
  api?: FeishuMessageApi;
  adminUsers: string[];
};

type FeishuInteractionContextResolver = (
  accountId: string,
) => FeishuInteractionAccountContext | undefined;

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Feishu adapter for broker-owned interactions.
 *
 * The projection store performs authorization and remembers card coordinates,
 * but never claims or resolves a request. Every competing callback reaches the
 * same SessionInteractionService and only InteractionBroker can win the CAS.
 */
export class FeishuInteractionManager {
  private readonly sessionCommandService: SessionCommandService;
  private readonly operationStore: FeishuOperationStore;
  private readonly statusRegistry?: FeishuStatusRegistry;
  private readonly now: () => Date;
  private readonly projectionTasks = new Map<string, Promise<void>>();
  private readonly actionTasks = new Set<Promise<void>>();
  private readonly cardProjectionTasks = new Map<string, Promise<void>>();
  private readonly accountApis = new Map<string, FeishuMessageApi>();
  private contextResolver?: FeishuInteractionContextResolver;
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  private timeoutTask?: Promise<void>;
  private shutdownTask?: Promise<void>;
  private shuttingDown = false;

  constructor(options: {
    sessionCommandService: SessionCommandService;
    operationStore: FeishuOperationStore;
    statusRegistry?: FeishuStatusRegistry;
    now?: () => Date;
  }) {
    this.sessionCommandService = options.sessionCommandService;
    this.operationStore = options.operationStore;
    this.statusRegistry = options.statusRegistry;
    this.now = options.now ?? (() => new Date());
  }

  projectPendingInput(
    context: FeishuInteractionTurnContext,
    request: InputRequest,
  ): Promise<void> {
    if (
      this.shuttingDown ||
      !context.requesterOpenId ||
      request.sessionId !== context.sessionId
    ) {
      return Promise.resolve();
    }
    this.rememberApi(context.accountId, context.api);
    const key = [
      context.accountId,
      context.sessionId,
      canonicalProviderRequestId(request.providerRequestId ?? request.id),
    ].join("\0");
    const previous = this.projectionTasks.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.doProjectPendingInput(context, request))
      .finally(() => {
        if (this.projectionTasks.get(key) === task) {
          this.projectionTasks.delete(key);
        }
      });
    this.projectionTasks.set(key, task);
    return task;
  }

  async acceptCardAction(
    envelope: FeishuCardActionEnvelope,
  ): Promise<FeishuCardActionAcceptResult> {
    if (this.shuttingDown) return "ignored";
    this.rememberApi(envelope.accountId, envelope.api);
    const value = parseFeishuInputActionValue(envelope.event.value);
    if (!value) return "ignored";
    const authorization = this.operationStore.authorizeAction({
      accountId: envelope.accountId,
      brokerOperationId: value.operationId,
      chatId: envelope.event.chatId,
      cardMessageId: envelope.event.messageId,
      operatorOpenId: envelope.event.operatorOpenId,
    });
    if (authorization.state !== "authorized") {
      if (authorization.state === "forbidden") {
        this.statusRegistry?.recordInput(envelope.accountId, "rejected");
      }
      return authorization.state === "forbidden" ? "forbidden" : "ignored";
    }

    const live = this.sessionCommandService.getInteractionOperation(
      value.operationId,
    );
    if (!live || live.sessionId !== authorization.record.sessionId) {
      return "ignored";
    }
    if (live.state !== "open") {
      const synced = await this.operationStore.syncBrokerOperation(
        envelope.accountId,
        live,
      );
      if (synced) await this.updateResolvedCard(synced, envelope.api);
      this.refreshPendingMetric(envelope.accountId);
      return live.state === "expired" ? "expired" : "already_processed";
    }
    if (live.version !== value.operationVersion) {
      await this.operationStore.syncBrokerOperation(envelope.accountId, live);
      const pending = await this.sessionCommandService
        .getPendingInput(authorization.record.sessionId)
        .catch(() => null);
      if (pending && matchesProjectedRequest(authorization.record, pending)) {
        await this.updatePendingCard(
          authorization.record.projectionId,
          pending,
          envelope.api,
        );
      }
      this.statusRegistry?.recordInput(envelope.accountId, "rejected");
      return "stale";
    }

    const task = this.processAuthorizedAction(
      authorization.record,
      value,
      envelope.event,
      envelope.api,
    )
      .catch(() => undefined)
      .finally(() => {
        this.actionTasks.delete(task);
        this.scheduleNextTimeout();
      });
    this.actionTasks.add(task);
    return "claimed";
  }

  async terminateOpenOperations(
    scope: FeishuInteractionOperationScope,
    reason: FeishuInteractionTerminateReason,
  ): Promise<number> {
    if (this.shuttingDown) return 0;
    if (reason === "timeout") {
      return this.expireScopeThroughBroker(scope);
    }
    await this.sessionCommandService.terminateInteractionOperations(
      scope.sessionId,
      reason === "failed" ? "process_exit" : reason,
    );
    return this.syncScope(scope);
  }

  async reconcileOpenOperations(
    scope: FeishuInteractionOperationScope,
    pendingRequestId: string | null,
  ): Promise<number> {
    if (this.shuttingDown) return 0;
    await this.sessionCommandService.terminateInteractionOperations(
      scope.sessionId,
      "request_missing",
      pendingRequestId ?? undefined,
    );
    return this.syncScope(scope);
  }

  async recover(getContext: FeishuInteractionContextResolver): Promise<void> {
    this.contextResolver = getContext;
    for (const record of this.operationStore.list()) {
      const context = getContext(record.accountId);
      this.rememberApi(record.accountId, context?.api);
      let live = this.sessionCommandService.getInteractionOperation(
        record.brokerOperationId,
      );
      if (live && isBrokerOpen(live)) {
        const pending = await this.sessionCommandService
          .getPendingInput(record.sessionId)
          .catch(() => null);
        if (pending && matchesProjectedRequest(record, pending)) {
          await this.projectPendingInput(
            {
              accountId: record.accountId,
              sessionId: record.sessionId,
              chatId: record.chatId,
              threadId: record.threadId,
              replyToMessageId: record.replyToMessageId,
              requesterOpenId: record.requesterOpenId,
              allowedOperatorOpenIds: [
                record.requesterOpenId,
                ...(context?.adminUsers ?? []),
              ],
              api: context?.api,
            },
            pending,
          );
          continue;
        }
        await this.sessionCommandService.terminateInteractionOperations(
          record.sessionId,
          "request_missing",
        );
        live = this.sessionCommandService.getInteractionOperation(
          record.brokerOperationId,
        );
      }
      if (!live) continue;
      const synced = await this.operationStore.syncBrokerOperation(
        record.accountId,
        live,
      );
      if (synced && !isBrokerOpen(live)) {
        await this.updateResolvedCard(synced, context?.api);
      }
    }
    this.refreshAllPendingMetrics();
    this.scheduleNextTimeout();
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shuttingDown = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    const task = (async () => {
      await Promise.allSettled([
        ...this.projectionTasks.values(),
        ...this.actionTasks,
        ...this.cardProjectionTasks.values(),
        ...(this.timeoutTask ? [this.timeoutTask] : []),
      ]);
      this.projectionTasks.clear();
      this.actionTasks.clear();
      this.cardProjectionTasks.clear();
      this.accountApis.clear();
    })();
    this.shutdownTask = task;
    return task;
  }

  private async doProjectPendingInput(
    context: FeishuInteractionTurnContext,
    request: InputRequest,
  ): Promise<void> {
    const pending = await this.sessionCommandService
      .getPendingInput(context.sessionId)
      .catch(() => null);
    if (!pending || !pending.interaction) return;
    if (
      pending.id !== request.id &&
      canonicalProviderRequestId(pending.providerRequestId ?? pending.id) !==
        canonicalProviderRequestId(request.providerRequestId ?? request.id)
    ) {
      return;
    }
    const providerRequestId = canonicalProviderRequestId(
      pending.providerRequestId ?? pending.id,
    );
    const previous = this.operationStore.findForRequest(
      context.accountId,
      context.sessionId,
      providerRequestId,
    );
    const record = await this.operationStore.upsert({
      operation: pending.interaction,
      accountId: context.accountId,
      chatId: context.chatId,
      threadId: context.threadId,
      replyToMessageId: context.replyToMessageId,
      sessionId: context.sessionId,
      requestId: pending.id,
      providerRequestId,
      requestType: pending.type,
      requesterOpenId: context.requesterOpenId ?? "",
      allowedOperatorOpenIds: context.allowedOperatorOpenIds,
      now: this.now(),
    });
    this.refreshPendingMetric(context.accountId);
    this.scheduleNextTimeout();

    if (!isBrokerOpen(pending.interaction)) {
      await this.updateResolvedCard(record, context.api);
      return;
    }
    if (record.cardId && record.cardMessageId) {
      if (
        !previous ||
        previous.brokerOperationId !== record.brokerOperationId ||
        previous.brokerVersion !== record.brokerVersion
      ) {
        await this.updatePendingCard(record.projectionId, pending, context.api);
      }
      return;
    }
    if (!hasFeishuInteractionApi(context.api)) return;
    const created = await context.api.createInputCard(
      createTarget(record),
      buildFeishuInputCard(pending, cardActionIdentity(record)),
    );
    const attached = await this.operationStore.attachCard(
      record.projectionId,
      {
        cardId: created.cardId,
        cardMessageId: created.messageId,
      },
      this.now(),
    );
    if (!isOpenProjection(attached)) {
      await this.updateResolvedCard(attached, context.api);
    }
  }

  private async processAuthorizedAction(
    record: FeishuOperationRecord,
    value: FeishuInputActionValue,
    event: FeishuCardActionEvent,
    api: FeishuMessageApi | undefined,
  ): Promise<void> {
    const pending = await this.sessionCommandService
      .getPendingInput(record.sessionId)
      .catch(() => null);
    if (
      !pending ||
      !pending.interaction ||
      !matchesProjectedRequest(record, pending)
    ) {
      await this.syncCurrentBroker(record, api);
      this.statusRegistry?.recordInput(record.accountId, "expired");
      return;
    }
    if (
      pending.interaction.operationId !== value.operationId ||
      pending.interaction.version !== value.operationVersion
    ) {
      const synced = await this.operationStore.syncBrokerOperation(
        record.accountId,
        pending.interaction,
      );
      if (synced)
        await this.updatePendingCard(synced.projectionId, pending, api);
      this.statusRegistry?.recordInput(record.accountId, "rejected");
      return;
    }

    const response =
      value.action === "deny"
        ? "deny"
        : value.action === "approve_always"
          ? "approve_always"
          : "approve";
    const answers =
      pending.type === "tool-approval"
        ? undefined
        : buildFeishuQuestionAnswers(pending, event, value);
    if (
      !isActionAllowed(pending, value.action) ||
      (pending.type !== "tool-approval" && response !== "deny" && !answers)
    ) {
      this.statusRegistry?.recordInput(record.accountId, "rejected");
      await this.updatePendingCard(record.projectionId, pending, api);
      return;
    }

    const result = await this.sessionCommandService.respondToInput(
      record.sessionId,
      {
        requestId: pending.id,
        response,
        answers,
        operationId: value.operationId,
        operationVersion: value.operationVersion,
        actor: { id: event.operatorOpenId, channel: "feishu" },
      },
    );
    const operation =
      readBrokerOperation(result.body.operation) ??
      this.sessionCommandService.getInteractionOperation(value.operationId);
    if (!operation) {
      this.statusRegistry?.recordInput(record.accountId, "rejected");
      return;
    }

    const presentation = result.ok ? actionPresentation(pending, response) : {};
    const synced = await this.operationStore.syncBrokerOperation(
      record.accountId,
      operation,
      presentation,
      this.now(),
    );
    if (!synced) return;
    if (result.ok) {
      this.statusRegistry?.recordInput(record.accountId, "accepted");
      await this.updateResolvedCard(synced, api);
    } else if (isBrokerOpen(operation)) {
      this.statusRegistry?.recordInput(record.accountId, "rejected");
      const currentPending = await this.sessionCommandService
        .getPendingInput(record.sessionId)
        .catch(() => null);
      if (currentPending && matchesProjectedRequest(synced, currentPending)) {
        await this.updatePendingCard(synced.projectionId, currentPending, api);
      }
    } else {
      this.statusRegistry?.recordInput(
        record.accountId,
        operation.state === "expired" ? "expired" : "rejected",
      );
      await this.updateResolvedCard(synced, api);
    }
    this.refreshPendingMetric(record.accountId);
  }

  private async syncCurrentBroker(
    record: FeishuOperationRecord,
    api: FeishuMessageApi | undefined,
  ): Promise<void> {
    const operation = this.sessionCommandService.getInteractionOperation(
      record.brokerOperationId,
    );
    if (!operation) return;
    const synced = await this.operationStore.syncBrokerOperation(
      record.accountId,
      operation,
    );
    if (synced && !isBrokerOpen(operation)) {
      await this.updateResolvedCard(synced, api);
    }
    this.refreshPendingMetric(record.accountId);
  }

  private async updatePendingCard(
    projectionId: string,
    request: InputRequest,
    api: FeishuMessageApi | undefined,
  ): Promise<void> {
    const record = this.operationStore.get(projectionId);
    if (
      !record?.cardId ||
      !request.interaction ||
      !isOpenProjection(record) ||
      !hasFeishuInteractionApi(api)
    ) {
      return;
    }
    const sequence = await this.operationStore.advanceCardSequence(
      projectionId,
      this.now(),
    );
    await api.updateInputCard(
      record.cardId,
      buildFeishuInputCard(request, {
        operationId: request.interaction.operationId,
        operationVersion: request.interaction.version,
      }),
      sequence,
    );
  }

  private updateResolvedCard(
    record: FeishuOperationRecord,
    api: FeishuMessageApi | undefined,
  ): Promise<void> {
    if (
      !record.cardId ||
      isOpenProjection(record) ||
      !hasFeishuInteractionApi(api)
    ) {
      return Promise.resolve();
    }
    const previous =
      this.cardProjectionTasks.get(record.projectionId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.doUpdateResolvedCard(record.projectionId, api))
      .finally(() => {
        if (this.cardProjectionTasks.get(record.projectionId) === task) {
          this.cardProjectionTasks.delete(record.projectionId);
        }
      });
    this.cardProjectionTasks.set(record.projectionId, task);
    return task;
  }

  private async doUpdateResolvedCard(
    projectionId: string,
    api: FeishuMessageApi & {
      updateInputCard(
        cardId: string,
        card: object,
        sequence: number,
      ): Promise<void>;
    },
  ): Promise<void> {
    const record = this.operationStore.get(projectionId);
    if (
      !record?.cardId ||
      isOpenProjection(record) ||
      (record.cardProjectedBrokerVersion ?? -1) >= record.brokerVersion
    ) {
      return;
    }
    const sequence = await this.operationStore.advanceCardSequence(
      projectionId,
      this.now(),
    );
    try {
      await api.updateInputCard(
        record.cardId,
        buildFeishuResolvedInputCard({
          requestType: record.requestType,
          status:
            record.brokerState === "resolved"
              ? "completed"
              : record.brokerState === "expired"
                ? "expired"
                : record.brokerState === "cancelled"
                  ? "cancelled"
                  : "failed",
          terminalReason: record.terminalReason,
          result: record.displayResult,
          nativeDecision: record.nativeDecision,
        }),
        sequence,
      );
      await this.operationStore.markCardProjected(
        projectionId,
        record.brokerOperationId,
        record.brokerVersion,
        this.now(),
      );
    } catch {
      // LarkSdkFeishuApi owns durable retry. Leaving the marker unset lets a
      // restart retry custom APIs that do not expose an outbox.
    }
  }

  private async syncScope(
    scope: FeishuInteractionOperationScope,
  ): Promise<number> {
    let changed = 0;
    for (const record of this.operationStore.list()) {
      if (
        record.accountId !== scope.accountId ||
        record.sessionId !== scope.sessionId ||
        (scope.requestId &&
          record.requestId !== scope.requestId &&
          record.providerRequestId !==
            canonicalProviderRequestId(scope.requestId))
      ) {
        continue;
      }
      const operation = this.sessionCommandService.getInteractionOperation(
        record.brokerOperationId,
      );
      if (!operation) continue;
      const wasOpen = isOpenProjection(record);
      const synced = await this.operationStore.syncBrokerOperation(
        record.accountId,
        operation,
      );
      if (!synced) continue;
      if (wasOpen && !isOpenProjection(synced)) changed += 1;
      if (!isOpenProjection(synced)) {
        await this.updateResolvedCard(synced, scope.api);
      }
    }
    this.refreshPendingMetric(scope.accountId);
    this.scheduleNextTimeout();
    return changed;
  }

  private async expireScopeThroughBroker(
    scope: FeishuInteractionOperationScope,
  ): Promise<number> {
    let transitioned = 0;
    for (const record of this.operationStore.listOpen()) {
      if (
        record.accountId !== scope.accountId ||
        record.sessionId !== scope.sessionId ||
        (scope.requestId &&
          record.requestId !== scope.requestId &&
          record.providerRequestId !==
            canonicalProviderRequestId(scope.requestId))
      ) {
        continue;
      }
      await this.expireRecordThroughBroker(record);
      const current = this.operationStore.get(record.projectionId);
      if (current && !isOpenProjection(current)) transitioned += 1;
    }
    return transitioned + (await this.syncScope(scope));
  }

  private async expireRecordThroughBroker(
    record: FeishuOperationRecord,
  ): Promise<void> {
    const live = this.sessionCommandService.getInteractionOperation(
      record.brokerOperationId,
    );
    if (!live || live.state !== "open") {
      if (live) {
        const synced = await this.operationStore.syncBrokerOperation(
          record.accountId,
          live,
        );
        if (synced && !isBrokerOpen(live)) {
          await this.updateResolvedCard(
            synced,
            this.apiForAccount(record.accountId),
          );
        }
      }
      return;
    }
    const pending = await this.sessionCommandService
      .getPendingInput(record.sessionId)
      .catch(() => null);
    if (!pending || !matchesProjectedRequest(record, pending)) {
      await this.sessionCommandService.terminateInteractionOperations(
        record.sessionId,
        "request_missing",
      );
    } else {
      await this.sessionCommandService.respondToInput(
        record.sessionId,
        {
          requestId: pending.id,
          response: "deny",
          operationId: live.operationId,
          operationVersion: live.version,
          actor: { id: "feishu-timeout", channel: "system" },
        },
        { terminalReason: "timeout" },
      );
    }
    const terminal = this.sessionCommandService.getInteractionOperation(
      record.brokerOperationId,
    );
    if (!terminal) return;
    const synced = await this.operationStore.syncBrokerOperation(
      record.accountId,
      terminal,
      { terminalReason: terminal.state === "expired" ? "timeout" : undefined },
      this.now(),
    );
    if (synced) {
      await this.updateResolvedCard(
        synced,
        this.apiForAccount(record.accountId),
      );
    }
  }

  private scheduleNextTimeout(): void {
    if (this.shuttingDown || this.timeoutTask) return;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    const now = this.now().getTime();
    const next = this.operationStore
      .listOpen()
      .flatMap((record) =>
        record.expiresAt ? [Date.parse(record.expiresAt)] : [],
      )
      .filter(Number.isFinite)
      .reduce<number | undefined>(
        (earliest, value) =>
          earliest === undefined || value < earliest ? value : earliest,
        undefined,
      );
    if (next === undefined) return;
    this.timeoutTimer = setTimeout(
      () => {
        this.timeoutTimer = undefined;
        const task = this.runTimeoutSweep()
          .catch(() => undefined)
          .finally(() => {
            if (this.timeoutTask === task) this.timeoutTask = undefined;
            this.scheduleNextTimeout();
          });
        this.timeoutTask = task;
      },
      Math.min(MAX_TIMEOUT_DELAY_MS, Math.max(1_000, next - now)),
    );
    this.timeoutTimer.unref?.();
  }

  private async runTimeoutSweep(): Promise<void> {
    const now = this.now().getTime();
    const due = this.operationStore
      .listOpen()
      .filter(
        (record) =>
          record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now,
      );
    for (const record of due) {
      await this.expireRecordThroughBroker(record);
    }
    this.refreshAllPendingMetrics();
  }

  private rememberApi(
    accountId: string,
    api: FeishuMessageApi | undefined,
  ): void {
    if (api) this.accountApis.set(accountId, api);
  }

  private apiForAccount(accountId: string): FeishuMessageApi | undefined {
    const api = this.contextResolver?.(accountId)?.api;
    this.rememberApi(accountId, api);
    return api ?? this.accountApis.get(accountId);
  }

  private refreshPendingMetric(accountId: string): void {
    if (!this.statusRegistry) return;
    const count = this.operationStore
      .listOpen()
      .filter((record) => record.accountId === accountId).length;
    this.statusRegistry.setPendingApprovals(accountId, count);
  }

  private refreshAllPendingMetrics(): void {
    if (!this.statusRegistry) return;
    const counts = new Map<string, number>();
    for (const record of this.operationStore.listOpen()) {
      counts.set(record.accountId, (counts.get(record.accountId) ?? 0) + 1);
    }
    for (const status of this.statusRegistry.list()) {
      this.statusRegistry.setPendingApprovals(
        status.accountId,
        counts.get(status.accountId) ?? 0,
      );
    }
  }
}

function createTarget(
  record: FeishuOperationRecord,
): FeishuStreamingReplyTarget {
  return {
    chatId: record.chatId,
    replyToMessageId: record.replyToMessageId,
    replyInThread: Boolean(record.threadId),
  };
}

function cardActionIdentity(record: FeishuOperationRecord) {
  return {
    operationId: record.brokerOperationId,
    operationVersion: record.brokerVersion,
  };
}

function canonicalProviderRequestId(requestId: string): string {
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

function matchesProjectedRequest(
  record: FeishuOperationRecord,
  request: InputRequest,
): boolean {
  return (
    request.interaction?.operationId === record.brokerOperationId ||
    request.id === record.requestId ||
    canonicalProviderRequestId(request.providerRequestId ?? request.id) ===
      record.providerRequestId
  );
}

function isActionAllowed(
  request: InputRequest,
  action: FeishuInputActionValue["action"],
): boolean {
  if (request.type === "tool-approval") {
    if (action === "approve_always") {
      return persistentDecisionKind(request.toolInput) !== undefined;
    }
    return action === "approve" || action === "deny";
  }
  return action === "answer" || action === "submit" || action === "deny";
}

function actionPresentation(
  request: InputRequest,
  response: "approve" | "approve_always" | "deny",
): FeishuOperationPresentation {
  const result: FeishuOperationResult =
    response === "deny"
      ? "deny"
      : request.type !== "tool-approval"
        ? "answered"
        : response === "approve_always"
          ? "approve_always"
          : "approve";
  return {
    result,
    nativeDecision: nativeDecisionDescriptor(request, response),
  };
}

function nativeDecisionDescriptor(
  request: InputRequest,
  response: "approve" | "approve_always" | "deny",
): FeishuNativeDecisionDescriptor {
  if (request.type !== "tool-approval") {
    return { kind: "answer", scope: "none" };
  }
  if (response === "deny") return { kind: "decline", scope: "none" };
  if (response === "approve") return { kind: "accept", scope: "once" };
  const persistent = persistentDecisionKind(request.toolInput);
  if (
    persistent === "acceptWithExecpolicyAmendment" ||
    persistent === "applyNetworkPolicyAmendment"
  ) {
    return { kind: persistent, scope: "policy" };
  }
  return { kind: "acceptForSession", scope: "session" };
}

function persistentDecisionKind(
  toolInput: unknown,
):
  | "acceptForSession"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment"
  | undefined {
  const decisions = asRecord(toolInput)?.availableDecisions;
  if (!Array.isArray(decisions)) return undefined;
  for (const decision of decisions) {
    if (decision === "acceptForSession") return decision;
    const value = asRecord(decision);
    if (asRecord(value?.acceptWithExecpolicyAmendment)) {
      return "acceptWithExecpolicyAmendment";
    }
    if (asRecord(value?.applyNetworkPolicyAmendment)) {
      return "applyNetworkPolicyAmendment";
    }
  }
  return undefined;
}

function readBrokerOperation(value: unknown): InteractionOperation | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.operationId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.version !== "number" ||
    !Number.isSafeInteger(record.version) ||
    ![
      "open",
      "answering",
      "resolved",
      "expired",
      "cancelled",
      "failed",
    ].includes(String(record.state))
  ) {
    return undefined;
  }
  return record as unknown as InteractionOperation;
}

function isBrokerOpen(operation: InteractionOperation): boolean {
  return operation.state === "open" || operation.state === "answering";
}

function isOpenProjection(record: FeishuOperationRecord): boolean {
  return record.brokerState === "open" || record.brokerState === "answering";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

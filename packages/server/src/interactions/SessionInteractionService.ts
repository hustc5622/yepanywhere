import type { InputRequest, UserQuestionAnswers } from "@yep-anywhere/shared";
import type { BridgeController } from "../bridge-common/types.js";
import type { BridgeInputResponse } from "../bridge-common/types.js";
import type { CodexBridgeController } from "../codex-bridge/types.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type {
  RuntimeController,
  RuntimeProcessSnapshot,
} from "../runtime/types.js";
import type { PermissionMode, ProviderApprovalDecision } from "../sdk/types.js";
import { validateQuestionAnswers } from "../sessions/question-answers.js";
import type { EventBus } from "../watcher/index.js";
import {
  InteractionBroker,
  type InteractionResolutionActor,
  type InteractionTerminalReason,
} from "./InteractionBroker.js";

export interface SessionInteractionServiceDeps {
  runtimeController: RuntimeController;
  codexBridgeService?: CodexBridgeController;
  sessionMetadataService?: SessionMetadataService;
  eventBus?: EventBus;
  interactionBroker?: InteractionBroker;
}

export interface SessionInputResponseBody {
  requestId: string;
  response: "approve" | "approve_accept_edits" | "deny" | string;
  answers?: UserQuestionAnswers;
  feedback?: string;
  /** Current operation identity/version. Legacy clients may omit both. */
  operationId?: string;
  operationVersion?: number;
  actor?: {
    id: string;
    displayName?: string;
    channel?: "yep" | "feishu" | "provider" | "system";
  };
}

export interface RespondToInputOptions {
  /** Broker-owned terminal semantics for internal timeout reconciliation. */
  terminalReason?: "timeout";
}

export type SessionInteractionStatus = 200 | 400 | 404 | 409 | 502 | 503;

export type SessionInteractionResult<T extends Record<string, unknown>> =
  | { ok: true; status: 200; body: T }
  | {
      ok: false;
      status: Exclude<SessionInteractionStatus, 200>;
      body: { error: string } & Record<string, unknown>;
    };

type PendingInputOwner = "process" | "bridge";

interface ResolvedPendingInput {
  owner: PendingInputOwner;
  request: InputRequest;
  provider?: string;
  bridgeController?: BridgeController;
}

interface RegisteredPendingInput {
  target: ResolvedPendingInput;
  request: InputRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidActor(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const { id, displayName, channel } = value;
  return (
    typeof id === "string" &&
    id.trim().length > 0 &&
    id.length <= 512 &&
    (displayName === undefined ||
      (typeof displayName === "string" && displayName.length <= 512)) &&
    (channel === undefined ||
      channel === "yep" ||
      channel === "feishu" ||
      channel === "provider" ||
      channel === "system")
  );
}

function commandSuccess<T extends Record<string, unknown>>(
  body: T,
): SessionInteractionResult<T> {
  return { ok: true, status: 200, body };
}

function commandFailure(
  error: string,
  status: Exclude<SessionInteractionStatus, 200>,
  details: Record<string, unknown> = {},
): SessionInteractionResult<Record<string, unknown>> {
  return { ok: false, status, body: { error, ...details } };
}

function normalizeProcessInputResponse(
  response: string,
): ProviderApprovalDecision {
  if (
    response === "approve" ||
    response === "approve_accept_edits" ||
    response === "approve_for_session" ||
    response === "approve_strict_auto_review" ||
    response === "approve_always"
  ) {
    return response;
  }
  if (response === "allow") return "approve";
  return "deny";
}

function normalizeProviderProcessInputResponse(
  response: string,
  provider: string | undefined,
  request: InputRequest,
): ProviderApprovalDecision {
  const normalized = normalizeProcessInputResponse(response);
  if (
    provider === "kimi" &&
    request.toolName === "ExitPlanMode" &&
    normalized === "approve_accept_edits"
  ) {
    return "approve";
  }
  return normalized;
}

function normalizeBridgeInputResponse(response: string): BridgeInputResponse {
  return response === "approve" ||
    response === "approve_accept_edits" ||
    response === "approve_for_session" ||
    response === "approve_strict_auto_review" ||
    response === "approve_always"
    ? response
    : "deny";
}

function normalizeInteractionActor(
  actor: SessionInputResponseBody["actor"],
): InteractionResolutionActor {
  const id = actor?.id?.trim();
  const displayName = actor?.displayName?.trim();
  const channel = actor?.channel;
  return {
    id: (id || "yep-authenticated-user").slice(0, 512),
    displayName: displayName ? displayName.slice(0, 512) : undefined,
    channel:
      channel === "feishu" ||
      channel === "provider" ||
      channel === "system" ||
      channel === "yep"
        ? channel
        : "yep",
  };
}

function providerFromPendingRequest(request: InputRequest): string {
  if (request.source === "codex-bridge") return "codex";
  return "unknown";
}

function normalizePendingInputRequest(
  request: InputRequest,
  sessionId: string,
): InputRequest {
  return {
    ...request,
    sessionId: request.sessionId || sessionId,
    timestamp: request.timestamp || new Date().toISOString(),
  };
}

/**
 * Provider-neutral application authority for pending input.
 *
 * Reads register the current provider queue head with the durable broker;
 * writes can only invoke the provider after winning the broker CAS. HTTP,
 * Feishu, and future channel adapters must share one instance.
 */
export class SessionInteractionService {
  private readonly interactionBroker: InteractionBroker;
  private readonly interactionRegistrationChains = new Map<
    string,
    Promise<void>
  >();
  private readonly unsubscribe?: () => void;

  constructor(private readonly deps: SessionInteractionServiceDeps) {
    this.interactionBroker = deps.interactionBroker ?? new InteractionBroker();
    this.unsubscribe = deps.eventBus?.subscribe((event) => {
      if (event.type === "session-id-changed") {
        void this.interactionBroker
          .terminateSession(event.oldSessionId, "request_missing")
          .catch(() => undefined);
        return;
      }
      if (
        event.type === "session-status-changed" &&
        event.ownership.owner === "none"
      ) {
        void this.interactionBroker
          .terminateSession(event.sessionId, "process_exit")
          .catch(() => undefined);
        return;
      }
      if (event.type === "process-state-changed") {
        if (event.activity === "terminated") {
          void this.interactionBroker
            .terminateSession(event.sessionId, "process_exit")
            .catch(() => undefined);
        } else {
          // Re-read both process and bridge queue heads. This avoids a racing
          // process activity update invalidating a bridge-held request.
          void this.getPendingInput(event.sessionId).catch(() => undefined);
        }
        return;
      }
      if (event.type === "process-terminated") {
        void this.interactionBroker
          .terminateSession(event.sessionId, "process_exit")
          .catch(() => undefined);
        return;
      }
      if (event.type === "session-aborted") {
        void this.interactionBroker
          .terminateSession(event.sessionId, "interrupt")
          .catch(() => undefined);
      }
    });
  }

  async getPendingInput(
    sessionId: string,
    options?: { processSnapshot: RuntimeProcessSnapshot | null },
  ): Promise<InputRequest | null> {
    const snapshot = options
      ? options.processSnapshot
      : await this.deps.runtimeController.getProcessSnapshotForSession(
          sessionId,
        );
    const resolved = await this.resolvePendingInputRequest(
      sessionId,
      snapshot?.pendingInputRequest,
      snapshot?.provider,
    );
    const registered = await this.registerPendingInteraction(
      sessionId,
      resolved ?? undefined,
    );
    return registered?.request ?? null;
  }

  async respondToInput(
    sessionId: string,
    body: SessionInputResponseBody,
    options?: RespondToInputOptions,
  ): Promise<SessionInteractionResult<Record<string, unknown>>> {
    if (
      !isRecord(body) ||
      typeof body.requestId !== "string" ||
      body.requestId.trim().length === 0 ||
      typeof body.response !== "string" ||
      body.response.trim().length === 0
    ) {
      return commandFailure("requestId and response are required", 400);
    }
    const hasOperationId = body.operationId !== undefined;
    const hasOperationVersion = body.operationVersion !== undefined;
    if (hasOperationId !== hasOperationVersion) {
      return commandFailure(
        "operationId and operationVersion must be provided together",
        400,
        { code: "interaction_identity_incomplete" },
      );
    }
    if (
      (body.operationId !== undefined &&
        (typeof body.operationId !== "string" ||
          !/^int_[A-Za-z0-9_-]{16,124}$/u.test(body.operationId) ||
          !Number.isSafeInteger(body.operationVersion) ||
          (body.operationVersion as number) < 0)) ||
      !isValidActor(body.actor) ||
      (body.feedback !== undefined && typeof body.feedback !== "string")
    ) {
      return commandFailure("Interaction identity is invalid", 400, {
        code: "interaction_identity_invalid",
      });
    }
    const process =
      await this.deps.runtimeController.getProcessSnapshotForSession(sessionId);
    const processPending = process?.pendingInputRequest ?? null;
    const canonicalSessionId =
      processPending?.sessionId || process?.sessionId || sessionId;
    let target = await this.selectPendingInputOwner(
      sessionId,
      processPending,
      body.requestId,
      process?.provider,
    );
    let registered: RegisteredPendingInput | undefined;

    // An identified client may race a provider transport that has replaced
    // the request id while retaining the same native interaction identity.
    if (!target && body.operationId) {
      const activeTarget = await this.resolvePendingInputRequest(
        sessionId,
        processPending,
        process?.provider,
      );
      if (activeTarget) {
        const active = await this.registerPendingInteraction(
          sessionId,
          activeTarget,
        );
        if (active?.request.interaction?.operationId === body.operationId) {
          target = active.target;
          registered = active;
        }
      }
    }

    if (!target) {
      const current = body.operationId
        ? this.interactionBroker.get(body.operationId)
        : this.interactionBroker.findCurrent(
            canonicalSessionId,
            body.requestId,
          );
      if (
        current &&
        (current.sessionId === sessionId ||
          current.sessionId === canonicalSessionId) &&
        (body.operationId || current.requestId === body.requestId)
      ) {
        return commandFailure("Interaction already resolved", 409, {
          code: "interaction_already_resolved",
          operation: current,
        });
      }
      return process
        ? commandFailure("Invalid request ID or no pending request", 400)
        : commandFailure("No active process for session", 404);
    }

    registered ??=
      (await this.registerPendingInteraction(sessionId, target)) ?? undefined;
    if (!registered) {
      return commandFailure("Invalid request ID or no pending request", 400);
    }
    target = registered.target;
    const registeredRequest = registered.request;
    const operation = registeredRequest.interaction;
    if (!operation) {
      return commandFailure("Interaction broker unavailable", 503, {
        code: "interaction_broker_unavailable",
      });
    }

    const processResponse = normalizeProviderProcessInputResponse(
      body.response,
      target.provider,
      registeredRequest,
    );
    const bridgeResponse = normalizeBridgeInputResponse(body.response);
    const approving =
      target.owner === "process"
        ? processResponse !== "deny"
        : bridgeResponse !== "deny";
    if (approving) {
      const validation = validateQuestionAnswers(
        registeredRequest,
        body.answers,
      );
      if (!validation.valid) {
        return commandFailure(
          `Question response is missing ${validation.missingAnswerCount} required answer${validation.missingAnswerCount === 1 ? "" : "s"}`,
          400,
        );
      }
    }

    const actor = normalizeInteractionActor(body.actor);
    const resolution = await this.interactionBroker.resolve({
      sessionId: operation.sessionId,
      requestId: body.requestId,
      operationId: body.operationId ?? operation.operationId,
      expectedVersion: body.operationVersion ?? operation.version,
      response: target.owner === "process" ? processResponse : bridgeResponse,
      answers: body.answers,
      feedback: body.feedback,
      actor,
      terminalReason: options?.terminalReason,
    });

    if (resolution.state !== "resolved") {
      if (resolution.state === "already_resolved") {
        return commandFailure("Interaction already resolved", 409, {
          code: "interaction_already_resolved",
          operation: resolution.operation,
        });
      }
      if (resolution.state === "stale") {
        return commandFailure("Interaction version is stale", 409, {
          code: "interaction_stale_version",
          operation: resolution.operation,
        });
      }
      if (resolution.state === "provider_rejected") {
        if (!body.operationId) {
          return commandFailure(
            "Invalid request ID or no pending request",
            400,
          );
        }
        return commandFailure(
          "Provider rejected the interaction response",
          502,
          {
            code: "interaction_provider_rejected",
            operation: resolution.operation,
          },
        );
      }
      return commandFailure("Invalid request ID or no pending request", 400, {
        ...(body.operationId ? { code: "interaction_not_found" } : {}),
      });
    }

    if (processResponse === "approve_accept_edits" && process) {
      await this.persistAcceptEdits(sessionId, body.requestId);
    }

    return commandSuccess(
      body.operationId
        ? { accepted: true, operation: resolution.operation }
        : { accepted: true },
    );
  }

  terminateInteractionOperations(
    sessionId: string,
    reason: Exclude<
      InteractionTerminalReason,
      "timeout" | "provider_rejected" | "restart_recovery"
    >,
    keepRequestId?: string,
  ) {
    return this.interactionBroker.terminateSession(
      sessionId,
      reason,
      new Date(),
      keepRequestId,
    );
  }

  getInteractionOperation(operationId: string) {
    return this.interactionBroker.get(operationId);
  }

  getInteractionOperations(sessionId: string) {
    return this.interactionBroker.listForSession(sessionId);
  }

  getInteractionBroker(): InteractionBroker {
    return this.interactionBroker;
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  private async persistAcceptEdits(
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    try {
      const modeResult = await this.deps.runtimeController.setPermissionMode({
        sessionId,
        mode: "acceptEdits",
      });
      const confirmedMode: PermissionMode =
        modeResult.permissionMode ?? "acceptEdits";
      await this.deps.sessionMetadataService?.setPermissionMode?.(
        sessionId,
        confirmedMode,
      );
    } catch (error) {
      getLogger().warn(
        {
          event: "session_input_accept_edits_mode_failed",
          sessionId,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Approval accepted but switching to acceptEdits failed",
      );
    }
  }

  private bridgeControllers(): ReadonlyArray<BridgeController | undefined> {
    return [this.deps.codexBridgeService];
  }

  private async resolvePendingInputRequest(
    sessionId: string,
    processPending: InputRequest | null | undefined,
    processProvider?: string,
  ): Promise<ResolvedPendingInput | null> {
    if (processPending) {
      return {
        owner: "process",
        request: normalizePendingInputRequest(processPending, sessionId),
        provider: processProvider,
      };
    }
    const bridgePending = await this.findBridgePendingInput(sessionId);
    return bridgePending
      ? {
          owner: "bridge",
          request: normalizePendingInputRequest(
            bridgePending.request,
            sessionId,
          ),
          provider: bridgePending.provider,
          bridgeController: bridgePending.controller,
        }
      : null;
  }

  private async selectPendingInputOwner(
    sessionId: string,
    processPending: InputRequest | null | undefined,
    requestId: string,
    processProvider?: string,
  ): Promise<ResolvedPendingInput | null> {
    if (processPending?.id === requestId) {
      return {
        owner: "process",
        request: normalizePendingInputRequest(processPending, sessionId),
        provider: processProvider,
      };
    }
    const bridgePending = await this.findBridgePendingInput(sessionId);
    return bridgePending?.request.id === requestId
      ? {
          owner: "bridge",
          request: normalizePendingInputRequest(
            bridgePending.request,
            sessionId,
          ),
          provider: bridgePending.provider,
          bridgeController: bridgePending.controller,
        }
      : null;
  }

  private async findBridgePendingInput(sessionId: string): Promise<{
    controller: BridgeController;
    provider: string;
    request: InputRequest;
  } | null> {
    for (const controller of this.bridgeControllers()) {
      if (!controller) continue;
      const request = await controller.getPendingInputRequest(sessionId);
      if (!request) continue;
      return {
        controller,
        provider:
          controller === this.deps.codexBridgeService
            ? "codex"
            : providerFromPendingRequest(request),
        request,
      };
    }
    return null;
  }

  private async registerPendingInteraction(
    sessionId: string,
    observed?: ResolvedPendingInput,
  ): Promise<RegisteredPendingInput | null> {
    return this.serializeInteractionRegistration(sessionId, async () => {
      // Re-read under a per-session lock: a slow observation of request A may
      // not supersede a newer queue head B merely because it finishes later.
      const snapshot =
        await this.deps.runtimeController.getProcessSnapshotForSession(
          sessionId,
        );
      const target =
        (observed
          ? await this.selectPendingInputOwner(
              sessionId,
              snapshot?.pendingInputRequest,
              observed.request.id,
              snapshot?.provider,
            )
          : null) ??
        (await this.resolvePendingInputRequest(
          sessionId,
          snapshot?.pendingInputRequest,
          snapshot?.provider,
        ));

      if (!target) {
        const canonicalSessionId = snapshot?.sessionId || sessionId;
        await Promise.all(
          [...new Set([sessionId, canonicalSessionId])].map((candidate) =>
            this.interactionBroker.terminateSession(
              candidate,
              snapshot?.state === "terminated"
                ? "process_exit"
                : "request_missing",
            ),
          ),
        );
        return null;
      }

      const operation = await this.interactionBroker.register({
        request: target.request,
        owner: target.owner,
        provider: target.provider ?? providerFromPendingRequest(target.request),
        supersedeSession: true,
        resolveProvider: async (input) => {
          if (target.owner === "process") {
            const { accepted } =
              await this.deps.runtimeController.respondToInput({
                sessionId: target.request.sessionId,
                requestId: target.request.id,
                response: normalizeProcessInputResponse(input.response),
                answers: input.answers,
                feedback: input.feedback,
              });
            return accepted;
          }
          return (
            (await target.bridgeController?.respondToInput(
              target.request.sessionId,
              target.request.id,
              normalizeBridgeInputResponse(input.response),
              input.answers,
              {
                operationId: input.operationId,
                operationVersion: input.operationVersion,
                actor: input.actor,
              },
            )) ?? false
          );
        },
      });

      if (target.owner === "bridge" && operation.state === "open") {
        const bind = target.bridgeController?.bindPendingInputInteraction;
        if (
          bind &&
          !(await bind.call(
            target.bridgeController,
            target.request.sessionId,
            target.request.id,
            {
              operationId: operation.operationId,
              operationVersion: operation.version,
            },
          ))
        ) {
          return null;
        }
      }

      return {
        target,
        request: { ...target.request, interaction: operation },
      };
    });
  }

  private async serializeInteractionRegistration<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.interactionRegistrationChains.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.interactionRegistrationChains.set(sessionId, tail);
    try {
      return await run;
    } finally {
      if (this.interactionRegistrationChains.get(sessionId) === tail) {
        this.interactionRegistrationChains.delete(sessionId);
      }
    }
  }
}

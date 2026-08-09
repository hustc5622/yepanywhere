import type {
  RespondToInputOptions,
  SessionInputResponseBody,
  SessionInteractionService,
} from "../interactions/SessionInteractionService.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type {
  RuntimeController,
  RuntimeProcessSnapshot,
  RuntimeSessionEventEmitter,
  RuntimeSessionSubscription,
  RuntimeSessionSubscriptionOptions,
} from "../runtime/types.js";
import type {
  CodexNativeControlRequest,
  CodexNativeControlResult,
} from "../sdk/providers/codex-controls.js";
import type { PermissionMode } from "../sdk/types.js";

export interface SessionCommandServiceDeps {
  runtimeController: RuntimeController;
  /** Sole pending-input/CAS authority shared by HTTP and channel adapters. */
  sessionInteractionService: SessionInteractionService;
  /** Persists permission mode when no resident process exists. */
  sessionMetadataService?: SessionMetadataService;
}

export interface ExecuteCodexControlCommandInput {
  sessionId: string;
  request: CodexNativeControlRequest;
}

export type SessionCommandStatus =
  | 200
  | 202
  | 400
  | 404
  | 409
  | 410
  | 502
  | 503;

export type SessionCommandResult<T extends Record<string, unknown>> =
  | { ok: true; status: 200 | 202; body: T }
  | {
      ok: false;
      status: Exclude<SessionCommandStatus, 200 | 202>;
      body: { error: string } & Record<string, unknown>;
    };

function commandSuccess<T extends Record<string, unknown>>(
  body: T,
  status: 200 | 202 = 200,
): SessionCommandResult<T> {
  return { ok: true, status, body };
}

function commandFailure(
  error: string,
  status: Exclude<SessionCommandStatus, 200 | 202>,
  details: Record<string, unknown> = {},
): SessionCommandResult<never> {
  return { ok: false, status, body: { error, ...details } };
}

/**
 * Provider-neutral application boundary for session commands.
 *
 * Pending-input operations deliberately delegate to SessionInteractionService
 * so every caller shares one durable broker and one provider-resolution path.
 */
export class SessionCommandService {
  constructor(private readonly deps: SessionCommandServiceDeps) {}

  async interrupt(
    sessionId: string,
  ): Promise<SessionCommandResult<Record<string, unknown>>> {
    const process =
      await this.deps.runtimeController.getProcessSnapshotForSession(sessionId);
    if (!process) {
      return commandFailure("No active process for session", 404);
    }

    const result = await this.deps.runtimeController.interruptProcess(
      process.id,
    );
    if (!result.success && !result.supported) {
      return commandFailure("Interrupt not supported for this process", 400);
    }
    if (result.success) {
      await this.terminateInteractionAliases(sessionId, process);
    }
    return commandSuccess({
      interrupted: result.success,
      supported: result.supported,
      processId: process.id,
    });
  }

  /** Release runtime ownership without deleting persisted provider history. */
  async releaseSession(
    sessionId: string,
  ): Promise<SessionCommandResult<Record<string, unknown>>> {
    const process =
      await this.deps.runtimeController.getProcessSnapshotForSession(sessionId);
    if (!process) {
      await this.deps.sessionInteractionService.terminateInteractionOperations(
        sessionId,
        "interrupt",
      );
      return commandSuccess({ released: true, hadProcess: false });
    }

    const result = await this.deps.runtimeController.abortProcess(process.id);
    if (!result.aborted) {
      const remaining =
        await this.deps.runtimeController.getProcessSnapshotForSession(
          sessionId,
        );
      if (remaining) {
        return commandFailure("Session process could not be released", 409, {
          code: "session_release_failed",
        });
      }
    }

    await this.terminateInteractionAliases(sessionId, process);
    return commandSuccess({
      released: true,
      hadProcess: true,
      processId: process.id,
    });
  }

  async executeCodexControl(input: ExecuteCodexControlCommandInput): Promise<
    SessionCommandResult<{
      control: CodexNativeControlResult["control"];
      data: unknown;
    }>
  > {
    const snapshot =
      await this.deps.runtimeController.getProcessSnapshotForSession(
        input.sessionId,
      );
    if (!snapshot) {
      return commandFailure("No active process for session", 404);
    }
    if (snapshot.provider !== "codex") {
      return commandFailure("Session is not backed by Codex app-server", 400, {
        code: "unsupported_provider",
        control: input.request.control,
      });
    }

    const result = await this.deps.runtimeController.executeCodexControl(input);
    if (result.ok) {
      return commandSuccess({ control: result.control, data: result.data });
    }

    const status =
      result.error.code === "provider_error"
        ? 502
        : result.error.code === "not_ready"
          ? 410
          : 400;
    return commandFailure(result.error.message, status, {
      code: result.error.code,
      control: result.control,
      retryable: result.error.retryable,
    });
  }

  getSessionSnapshot(
    sessionId: string,
  ): Promise<RuntimeProcessSnapshot | null> {
    return this.deps.runtimeController.getProcessSnapshotForSession(sessionId);
  }

  getRuntimeStatus() {
    return this.deps.runtimeController.getStatus();
  }

  async setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
  ): Promise<SessionCommandResult<Record<string, unknown>>> {
    if (!mode) return commandFailure("mode is required", 400);

    try {
      const result = await this.deps.runtimeController.setPermissionMode({
        sessionId,
        mode,
      });
      if (!result.ok) {
        if (!this.deps.sessionMetadataService) {
          return commandFailure("No active process for session", 404);
        }
        await this.deps.sessionMetadataService.setPermissionMode(
          sessionId,
          mode,
        );
        return commandSuccess({ permissionMode: mode, modeVersion: 0 });
      }

      const confirmedMode = result.permissionMode ?? mode;
      await this.deps.sessionMetadataService?.setPermissionMode(
        sessionId,
        confirmedMode,
      );
      return commandSuccess({
        permissionMode: confirmedMode,
        modeVersion: result.modeVersion ?? 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn(
        {
          event: "session_permission_mode_sync_failed",
          sessionId,
          mode,
          error: message,
        },
        "Provider rejected the permission mode change",
      );
      return commandFailure(`Failed to apply permission mode: ${message}`, 502);
    }
  }

  getPendingInput(
    sessionId: string,
    options?: { processSnapshot: RuntimeProcessSnapshot | null },
  ) {
    return this.deps.sessionInteractionService.getPendingInput(
      sessionId,
      options,
    );
  }

  respondToInput(
    sessionId: string,
    body: SessionInputResponseBody,
    options?: RespondToInputOptions,
  ) {
    return this.deps.sessionInteractionService.respondToInput(
      sessionId,
      body,
      options,
    );
  }

  terminateInteractionOperations(
    sessionId: string,
    reason: Parameters<
      SessionInteractionService["terminateInteractionOperations"]
    >[1],
    keepRequestId?: string,
  ) {
    return this.deps.sessionInteractionService.terminateInteractionOperations(
      sessionId,
      reason,
      keepRequestId,
    );
  }

  getInteractionOperation(operationId: string) {
    return this.deps.sessionInteractionService.getInteractionOperation(
      operationId,
    );
  }

  getInteractionOperations(sessionId: string) {
    return this.deps.sessionInteractionService.getInteractionOperations(
      sessionId,
    );
  }

  getInteractionBroker() {
    return this.deps.sessionInteractionService.getInteractionBroker();
  }

  subscribe(
    sessionId: string,
    emit: RuntimeSessionEventEmitter,
    options?: RuntimeSessionSubscriptionOptions,
  ): Promise<RuntimeSessionSubscription | null> {
    return this.deps.runtimeController.subscribeSession(
      sessionId,
      emit,
      options,
    );
  }

  private async terminateInteractionAliases(
    requestedSessionId: string,
    process: RuntimeProcessSnapshot,
  ): Promise<void> {
    const canonicalSessionId =
      process.pendingInputRequest?.sessionId || process.sessionId;
    await Promise.all(
      [...new Set([requestedSessionId, canonicalSessionId])].map((sessionId) =>
        this.deps.sessionInteractionService.terminateInteractionOperations(
          sessionId,
          "interrupt",
        ),
      ),
    );
  }
}

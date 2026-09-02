import type {
  ContextStatusSdkPayload,
  InputRequest,
  ModelInfo,
  PermissionMode,
  SlashCommand,
} from "@yep-anywhere/shared";
import { createStreamAugmenter, markSubagent } from "../augments/index.js";
import {
  type CodexNativeCapabilities,
  codexControlFailure,
} from "../sdk/providers/codex-controls.js";
import { configureClaudeRemoteExecutors } from "../sdk/providers/index.js";
import type { UserMessage } from "../sdk/types.js";
import {
  createSessionSubscription,
  normalizeStreamMessage,
} from "../subscriptions.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { ProcessEvent, ProcessInfo } from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";
import type { RuntimeEventStore } from "./RuntimeEventStore.js";
import {
  type CreateRuntimeSessionRequest,
  type QueueRuntimeMessageRequest,
  RUNTIME_CONTROLLER_PROTOCOL_VERSION,
  type ResumeRuntimeSessionRequest,
  type RuntimeActivityEventListener,
  type RuntimeCodexControlRequest,
  type RuntimeController,
  type RuntimeEventRecord,
  type RuntimeHoldProcessRequest,
  type RuntimeInputResponseRequest,
  type RuntimePermissionModeRequest,
  type RuntimeProcessSnapshot,
  type RuntimeProviderSettings,
  type RuntimeQueueMessageResponse,
  type RuntimeQueueStatus,
  type RuntimeReplayOptions,
  type RuntimeSessionEventEmitter,
  type RuntimeSessionStartResponse,
  type RuntimeSessionSubscription,
  type RuntimeSessionSubscriptionOptions,
  type RuntimeStatus,
  type RuntimeWorkerActivity,
  type StartRuntimeSessionRequest,
} from "./types.js";

function immediateAdmissionArgs(
  requireImmediate: boolean | undefined,
  allowMissingRolloutReplacement?: boolean,
):
  | []
  | [
      {
        requireImmediate?: true;
        allowMissingRolloutReplacement?: true;
      },
    ] {
  if (!requireImmediate && !allowMissingRolloutReplacement) return [];
  return [
    {
      ...(requireImmediate ? { requireImmediate: true as const } : {}),
      ...(allowMissingRolloutReplacement
        ? { allowMissingRolloutReplacement: true as const }
        : {}),
    },
  ];
}

function queueAdmissionArgs(input: {
  requireImmediate?: boolean;
  allowSteer?: boolean;
}): [] | [{ requireImmediate?: true; allowSteer?: false }] {
  if (!input.requireImmediate && input.allowSteer !== false) return [];
  return [
    {
      ...(input.requireImmediate ? { requireImmediate: true as const } : {}),
      ...(input.allowSteer === false ? { allowSteer: false as const } : {}),
    },
  ];
}

export class EmbeddedRuntimeController implements RuntimeController {
  readonly mode = "embedded" as const;
  private readonly journalSubscriptions = new Map<string, () => void>();

  constructor(
    private readonly supervisor: Supervisor,
    private readonly eventBus?: EventBus,
    private readonly eventStore?: RuntimeEventStore,
  ) {}

  async start(): Promise<void> {
    if (!this.eventStore) return;
    await this.eventStore.initialize();
    await Promise.all(
      this.supervisor
        .getAllProcesses()
        .map((process) => this.ensureJournalSubscription(process.sessionId)),
    );
  }

  async updateProviderSettings(
    settings: RuntimeProviderSettings,
  ): Promise<void> {
    if (settings.claudeRemoteExecutors) {
      configureClaudeRemoteExecutors(settings.claudeRemoteExecutors);
    }
  }

  async shutdown(options: { abortActive?: boolean } = {}): Promise<void> {
    if (!options.abortActive) {
      await this.eventStore?.flush();
      return;
    }

    await this.supervisor.shutdown();
    for (const cleanup of this.journalSubscriptions.values()) cleanup();
    this.journalSubscriptions.clear();
    await this.eventStore?.flush();
  }

  async getStatus(): Promise<RuntimeStatus> {
    const activity = await this.getWorkerActivity();
    return {
      ...activity,
      mode: this.mode,
      protocolVersion: RUNTIME_CONTROLLER_PROTOCOL_VERSION,
      processCount: this.supervisor.getProcessInfoList().length,
    };
  }

  async getWorkerActivity(): Promise<RuntimeWorkerActivity> {
    return this.supervisor.getWorkerActivity();
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    return this.supervisor.getProcessInfoList();
  }

  async listProcessSnapshots(): Promise<RuntimeProcessSnapshot[]> {
    const snapshots = await Promise.all(
      this.supervisor
        .getProcessInfoList()
        .map((process) => this.getProcessSnapshotForSession(process.sessionId)),
    );
    return snapshots.filter(
      (snapshot): snapshot is RuntimeProcessSnapshot => snapshot !== null,
    );
  }

  async listRecentlyTerminatedProcesses(): Promise<ProcessInfo[]> {
    return this.supervisor.getRecentlyTerminatedProcesses();
  }

  async getProcess(processId: string): Promise<ProcessInfo | null> {
    return this.supervisor.getProcess(processId)?.getInfo() ?? null;
  }

  async getProcessForSession(sessionId: string): Promise<ProcessInfo | null> {
    return this.supervisor.getProcessForSession(sessionId)?.getInfo() ?? null;
  }

  async getProcessSnapshotForSession(
    sessionId: string,
  ): Promise<RuntimeProcessSnapshot | null> {
    const process = this.supervisor.getProcessForSession(sessionId);
    if (!process) return null;

    // Route unit tests historically provide small Supervisor/Process fakes.
    // Keep that compatibility path while real runtime instances always use
    // Process.getInfo().
    const compatibleProcess = process as unknown as {
      id?: string;
      sessionId?: string;
      projectId?: string;
      projectPath?: string;
      provider?: RuntimeProcessSnapshot["provider"];
      model?: string;
      resolvedModel?: string;
      reasoningEffort?: string;
      requestedReasoningEffort?: string;
      resolvedReasoningEffort?: string;
      serviceTier?: string;
      executor?: string;
      state?: {
        type?: RuntimeProcessSnapshot["state"];
        request?: InputRequest;
      };
      permissionMode?: PermissionMode;
      modeVersion?: number;
      contextWindow?: number;
      terminationReason?: string | null;
      supportsDynamicModels?: boolean;
      supportsDynamicCommands?: boolean;
      supportsSetModel?: boolean;
      codexNativeCapabilities?: CodexNativeCapabilities;
      getInfo?: () => ProcessInfo;
      getPendingInputRequest?: () => InputRequest | null;
      getMessageHistory?: () => RuntimeProcessSnapshot["messageHistory"];
    };
    const projectPath = compatibleProcess.projectPath ?? "";
    const info = compatibleProcess.getInfo?.() ?? {
      id: compatibleProcess.id ?? "",
      sessionId: compatibleProcess.sessionId ?? sessionId,
      projectId: (compatibleProcess.projectId ??
        "") as ProcessInfo["projectId"],
      projectPath,
      projectName: projectPath.split("/").filter(Boolean).at(-1) ?? "",
      sessionTitle: null,
      state: compatibleProcess.state?.type ?? "in-turn",
      startedAt: new Date(0).toISOString(),
      queueDepth: 0,
      provider: compatibleProcess.provider ?? "claude",
      model: compatibleProcess.resolvedModel ?? compatibleProcess.model,
      reasoningEffort:
        compatibleProcess.resolvedReasoningEffort ??
        compatibleProcess.reasoningEffort,
      requestedReasoningEffort: compatibleProcess.requestedReasoningEffort,
      serviceTier: compatibleProcess.serviceTier,
      executor: compatibleProcess.executor,
      terminationReason: compatibleProcess.terminationReason ?? undefined,
    };

    return {
      ...info,
      permissionMode: compatibleProcess.permissionMode,
      modeVersion: compatibleProcess.modeVersion ?? 0,
      pendingInputRequest:
        compatibleProcess.getPendingInputRequest?.() ??
        compatibleProcess.state?.request ??
        null,
      messageHistory: compatibleProcess.getMessageHistory?.() ?? [],
      contextWindow: compatibleProcess.contextWindow,
      supportsDynamicModels: compatibleProcess.supportsDynamicModels ?? false,
      supportsDynamicCommands:
        compatibleProcess.supportsDynamicCommands ?? false,
      supportsSetModel: compatibleProcess.supportsSetModel ?? false,
      codexNativeCapabilities: compatibleProcess.codexNativeCapabilities,
    };
  }

  async wasEverOwned(sessionId: string): Promise<boolean> {
    return this.supervisor.wasEverOwned(sessionId);
  }

  async startSession(
    input: StartRuntimeSessionRequest,
  ): Promise<RuntimeSessionStartResponse> {
    const result = await this.supervisor.startSession(
      input.projectPath,
      input.message,
      input.permissionMode,
      input.modelSettings,
      ...immediateAdmissionArgs(input.requireImmediate),
    );
    if ("id" in result) await this.ensureJournalSubscription(result.sessionId);
    return this.toStartResponse(result);
  }

  async createSession(
    input: CreateRuntimeSessionRequest,
  ): Promise<RuntimeSessionStartResponse> {
    const result = await this.supervisor.createSession(
      input.projectPath,
      input.permissionMode,
      input.modelSettings,
      ...immediateAdmissionArgs(input.requireImmediate),
    );
    if ("id" in result) await this.ensureJournalSubscription(result.sessionId);
    return this.toStartResponse(result);
  }

  async resumeSession(
    input: ResumeRuntimeSessionRequest,
  ): Promise<RuntimeSessionStartResponse> {
    const result = await this.supervisor.resumeSession(
      input.sessionId,
      input.projectPath,
      input.message,
      input.permissionMode,
      input.modelSettings,
      ...immediateAdmissionArgs(
        input.requireImmediate,
        input.allowMissingRolloutReplacement,
      ),
    );
    if ("id" in result) await this.ensureJournalSubscription(result.sessionId);
    return this.toStartResponse(result);
  }

  async queueMessage(
    input: QueueRuntimeMessageRequest,
  ): Promise<RuntimeQueueMessageResponse> {
    const result = await this.supervisor.queueMessageToSession(
      input.sessionId,
      input.projectPath,
      input.message,
      input.permissionMode,
      input.modelSettings,
      ...queueAdmissionArgs(input),
    );
    if (!result.success) return result;
    await this.ensureJournalSubscription(result.process.sessionId);
    return {
      success: true,
      process: { id: result.process.id },
      restarted: result.restarted,
    };
  }

  private toStartResponse(
    result: Awaited<ReturnType<Supervisor["startSession"]>>,
  ): RuntimeSessionStartResponse {
    if (!("id" in result)) return result;
    return {
      id: result.id,
      sessionId: result.sessionId,
      provider: result.provider,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
    };
  }

  async abortProcess(processId: string): Promise<{ aborted: boolean }> {
    return { aborted: await this.supervisor.abortProcess(processId) };
  }

  async interruptProcess(
    processId: string,
  ): Promise<{ success: boolean; supported: boolean }> {
    return this.supervisor.interruptProcess(processId);
  }

  async getQueueStatus(): Promise<RuntimeQueueStatus> {
    return {
      queue: this.supervisor.getQueueInfo(),
      ...this.supervisor.getWorkerPoolStatus(),
    };
  }

  async getQueuePosition(queueId: string): Promise<number | undefined> {
    return this.supervisor.getQueuePosition(queueId);
  }

  async cancelQueuedRequest(queueId: string): Promise<{ cancelled: boolean }> {
    return { cancelled: this.supervisor.cancelQueuedRequest(queueId) };
  }

  async getPendingInputRequest(
    sessionId: string,
  ): Promise<InputRequest | null> {
    return (
      this.supervisor
        .getProcessForSession(sessionId)
        ?.getPendingInputRequest() ?? null
    );
  }

  async respondToInput(
    input: RuntimeInputResponseRequest,
  ): Promise<{ accepted: boolean }> {
    const process = this.supervisor.getProcessForSession(input.sessionId);
    if (!process) return { accepted: false };

    return {
      accepted: process.respondToInput(
        input.requestId,
        input.response,
        input.answers,
        input.feedback,
      ),
    };
  }

  async setPermissionMode(input: RuntimePermissionModeRequest): Promise<{
    ok: boolean;
    permissionMode?: PermissionMode;
    modeVersion?: number;
  }> {
    const process = this.supervisor.getProcessForSession(input.sessionId);
    if (!process) return { ok: false };

    await process.syncPermissionMode(input.mode);
    return {
      ok: true,
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    };
  }

  async executeCodexControl(input: RuntimeCodexControlRequest) {
    const process = this.supervisor.getProcessForSession(input.sessionId);
    if (!process) {
      return codexControlFailure(
        input.request.control,
        "not_ready",
        "No active process for session",
      );
    }
    return process.executeCodexControl(input.request);
  }

  async setHold(input: RuntimeHoldProcessRequest): Promise<{
    ok: boolean;
    isHeld?: boolean;
    holdSince?: string | null;
    state?: string;
  }> {
    const process = this.supervisor.getProcessForSession(input.sessionId);
    if (!process) return { ok: false };

    process.setHold(input.hold);
    return {
      ok: true,
      isHeld: process.isHeld,
      holdSince: process.holdSince?.toISOString() ?? null,
      state: process.state.type,
    };
  }

  async deferMessage(
    sessionId: string,
    message: UserMessage,
  ): Promise<{ queued: boolean }> {
    const process = this.supervisor.getProcessForSession(sessionId);
    if (!process) return { queued: false };
    process.deferMessage(message);
    return { queued: true };
  }

  async cancelDeferredMessage(
    sessionId: string,
    tempId: string,
  ): Promise<{ cancelled: boolean }> {
    return {
      cancelled:
        this.supervisor
          .getProcessForSession(sessionId)
          ?.cancelDeferredMessage(tempId) ?? false,
    };
  }

  async getSupportedModels(processId: string): Promise<ModelInfo[] | null> {
    return this.supervisor.getProcess(processId)?.supportedModels() ?? null;
  }

  async getSupportedCommands(
    processId: string,
  ): Promise<SlashCommand[] | null> {
    return this.supervisor.getProcess(processId)?.supportedCommands() ?? null;
  }

  async setModel(
    processId: string,
    model?: string,
  ): Promise<{ success: boolean }> {
    const process = this.supervisor.getProcess(processId);
    return { success: process ? await process.setModel(model) : false };
  }

  async compact(processId: string): Promise<{ success: boolean }> {
    const process = this.supervisor.getProcess(processId);
    return { success: process ? await process.compact() : false };
  }

  async setReasoningEffort(
    processId: string,
    effort: string,
  ): Promise<{ success: boolean }> {
    const process = this.supervisor.getProcess(processId);
    return {
      success: process ? await process.setReasoningEffort(effort) : false,
    };
  }

  async getGoal(
    processId: string,
  ): Promise<import("@yep-anywhere/shared").ProviderGoalState | null> {
    const process = this.supervisor.getProcess(processId);
    return process ? await process.getGoal() : null;
  }

  async goalAction(
    processId: string,
    action: import("@yep-anywhere/shared").ProviderGoalAction,
    objective?: string,
  ): Promise<import("@yep-anywhere/shared").ProviderGoalState | null> {
    const process = this.supervisor.getProcess(processId);
    return process ? await process.goalAction(action, objective) : null;
  }

  async getContextUsage(
    sessionId: string,
  ): Promise<ContextStatusSdkPayload | null> {
    return (
      (await this.supervisor
        .getProcessForSession(sessionId)
        ?.getContextUsage()) ?? null
    );
  }

  async probeInitializationResult(sessionId: string): Promise<{
    models: Array<{ id: string; contextWindow?: number }>;
  } | null> {
    const process = this.supervisor.getProcessForSession(sessionId);
    if (!process || process.initializationResultProbed) return null;
    process.markInitializationResultProbed();
    return process.initializationResult();
  }

  async subscribeSession(
    sessionId: string,
    emit: RuntimeSessionEventEmitter,
    options?: RuntimeSessionSubscriptionOptions,
  ): Promise<RuntimeSessionSubscription | null> {
    if (options?.signal?.aborted) return null;
    const process = this.supervisor.getProcessForSession(sessionId);

    const replay = this.eventStore
      ? await this.eventStore.replay({
          ...(process ? { processId: process.id } : { sessionId }),
          afterSeq: options?.afterSeq,
        })
      : [];
    const replayRecords = replay.slice(
      this.findReplayStart(replay, options?.replayAfterMessageId),
    );
    const lastReplayMessageId = [...replayRecords]
      .reverse()
      .map((record) => this.getRecordMessageId(record))
      .find((messageId): messageId is string => Boolean(messageId));
    if (options?.signal?.aborted) return null;

    // After a web/runtime restart there is no live Process to attach to, but a
    // durable turn terminal is still authoritative. Replaying it lets every
    // shell converge on the same final state instead of treating an already
    // finished task as unrecoverable. Resident providers can stay idle after a
    // turn terminal, so the journal may not have a transport-level `complete`.
    if (!process) {
      const transportCompleteIndex = replayRecords.findIndex(
        (record) => record.type === "complete",
      );
      const turnTerminal =
        transportCompleteIndex < 0
          ? this.findAuthoritativeTurnTerminal(replayRecords)
          : null;
      if (transportCompleteIndex < 0 && !turnTerminal) return null;
      const terminalRecords =
        transportCompleteIndex >= 0
          ? replayRecords.slice(0, transportCompleteIndex + 1)
          : replayRecords;
      let closed = false;
      emit("connected", {
        processId: terminalRecords.at(-1)?.processId,
        sessionId,
        state: "idle",
        replayOnly: true,
      });
      const replayAugmenter = await createStreamAugmenter({
        onMarkdownAugment: (data) => {
          if (!closed) emit("markdown-augment", data);
        },
        onPending: (data) => {
          if (!closed) emit("pending", data);
        },
        onError: (error) => options?.onError?.(error),
      });
      for (const record of terminalRecords) {
        // A historical process completion is terminal only when there is no
        // newer live process. The active-process branch intentionally omits it.
        if (closed || options?.signal?.aborted) {
          closed = true;
          continue;
        }
        if (
          record.type === "message" &&
          record.data !== null &&
          typeof record.data === "object" &&
          !Array.isArray(record.data)
        ) {
          const message = normalizeStreamMessage({
            ...(record.data as Record<string, unknown>),
            isReplay: true,
          });
          await replayAugmenter.processMessage(message, { mode: "replay" });
          if (!closed && !options?.signal?.aborted) {
            emit("message", markSubagent(message));
          }
          continue;
        }
        emit(record.type, record.data);
      }
      if (closed || options?.signal?.aborted) return null;
      if (transportCompleteIndex < 0 && turnTerminal) {
        // This closes only the replay transport. The correlated result/error
        // above remains the sole authority for the turn outcome.
        emit("complete", {
          timestamp: turnTerminal.timestamp,
          replayOnly: true,
          synthetic: true,
          reason: "journal-turn-terminal",
        });
      }
      return {
        cleanup: () => {
          closed = true;
        },
      };
    }

    const subscription = createSessionSubscription(process, emit, {
      ...options,
      replayAfterMessageId:
        lastReplayMessageId ?? options?.replayAfterMessageId,
      replayEvents: replayRecords
        .filter((record) => this.isReplayableRecord(record))
        .map((record) => ({
          eventType: record.type,
          data: record.data,
        })),
    });
    const abort = () => subscription.cleanup();
    options?.signal?.addEventListener("abort", abort, { once: true });
    await subscription.ready;
    if (options?.signal?.aborted) {
      options.signal.removeEventListener("abort", abort);
      subscription.cleanup();
      return null;
    }
    return {
      cleanup: () => {
        options?.signal?.removeEventListener("abort", abort);
        subscription.cleanup();
      },
    };
  }

  async subscribeActivity(
    listener: RuntimeActivityEventListener,
  ): Promise<RuntimeSessionSubscription | null> {
    if (!this.eventBus) return null;
    return { cleanup: this.eventBus.subscribe(listener) };
  }

  async replay(options: RuntimeReplayOptions): Promise<RuntimeEventRecord[]> {
    return this.eventStore?.replay(options) ?? [];
  }

  private async ensureJournalSubscription(sessionId: string): Promise<void> {
    const store = this.eventStore;
    if (!store) return;
    const process = this.supervisor.getProcessForSession(sessionId);
    if (!process || this.journalSubscriptions.has(process.id)) return;

    const cleanup = process.subscribe((event) => {
      const normalized = this.normalizeJournalEvent(event, process);
      if (!normalized) return;
      void store
        .append({
          processId: process.id,
          sessionId: process.sessionId,
          type: normalized.type,
          data: normalized.data,
        })
        .catch((error) => {
          console.error(
            `[AgentRuntime] Failed to journal ${normalized.type} for ${process.id}:`,
            error,
          );
        })
        .finally(() => {
          if (normalized.type === "complete") {
            cleanup();
            this.journalSubscriptions.delete(process.id);
          }
        });
    });
    this.journalSubscriptions.set(process.id, cleanup);
  }

  private normalizeJournalEvent(
    event: ProcessEvent,
    process: Process,
  ): { type: string; data: unknown } | null {
    switch (event.type) {
      case "message":
        return {
          type: "message",
          data: markSubagent(
            normalizeStreamMessage(event.message as Record<string, unknown>),
          ),
        };
      case "state-change":
        return {
          type: "status",
          data: {
            state: event.state.type,
            ...(event.state.type === "waiting-input"
              ? { request: event.state.request }
              : {}),
          },
        };
      case "mode-change":
        return {
          type: "mode-change",
          data: { permissionMode: event.mode, modeVersion: event.version },
        };
      case "error":
        return { type: "error", data: { message: event.error.message } };
      case "session-id-changed":
        return {
          type: "session-id-changed",
          data: {
            oldSessionId: event.oldSessionId,
            newSessionId: event.newSessionId,
            projectId: process.projectId,
            executor: process.executor,
          },
        };
      case "deferred-queue":
        return { type: "deferred-queue", data: { messages: event.messages } };
      case "complete":
        return {
          type: "complete",
          data: { timestamp: new Date().toISOString() },
        };
      case "terminated":
        return {
          type: "error",
          data: { message: event.error?.message ?? event.reason },
        };
      case "retry-status":
        // Transient backoff state, broadcast to clients through the event bus
        // instead. Journaled records are replayed to late joiners, and a stale
        // "retrying" replayed after the turn finished would be misleading.
        return null;
    }
  }

  private isReplayableRecord(record: RuntimeEventRecord): boolean {
    return record.type !== "complete";
  }

  private findAuthoritativeTurnTerminal(
    records: RuntimeEventRecord[],
  ): RuntimeEventRecord | null {
    let latestTurnId: string | undefined;
    for (const record of records) {
      const message = this.getRecordMessage(record);
      const turnId = message ? this.getMessageTurnId(message) : undefined;
      if (turnId) latestTurnId = turnId;
    }
    if (!latestTurnId) return null;

    let terminal: RuntimeEventRecord | null = null;
    let terminalIndex = -1;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      const message = this.getRecordMessage(record);
      if (
        !message ||
        this.getMessageTurnId(message) !== latestTurnId ||
        !this.isAuthoritativeTurnTerminalMessage(message)
      ) {
        continue;
      }
      terminal = record;
      terminalIndex = index;
    }
    if (!terminal) return null;

    // A later unscoped user/delta or active status can be a new turn whose
    // terminal was never journaled. Do not let the prior turn close it.
    for (const record of records.slice(terminalIndex + 1)) {
      const message = this.getRecordMessage(record);
      if (message) {
        const turnId = this.getMessageTurnId(message);
        if (!turnId && message.type !== "result") return null;
      }
      if (
        record.type === "status" &&
        record.data !== null &&
        typeof record.data === "object"
      ) {
        const state = (record.data as { state?: unknown }).state;
        if (
          state === "in-turn" ||
          state === "waiting-input" ||
          state === "hold"
        ) {
          return null;
        }
      }
    }
    return terminal;
  }

  private getRecordMessage(
    record: RuntimeEventRecord,
  ): Record<string, unknown> | null {
    return record.type === "message" &&
      record.data !== null &&
      typeof record.data === "object" &&
      !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  }

  private getMessageTurnId(
    message: Record<string, unknown>,
  ): string | undefined {
    if (typeof message.turnId === "string" && message.turnId) {
      return message.turnId;
    }
    return typeof message.codexTurnId === "string" && message.codexTurnId
      ? message.codexTurnId
      : undefined;
  }

  private isAuthoritativeTurnTerminalMessage(
    message: Record<string, unknown>,
  ): boolean {
    if (message.type === "result") return true;
    if (message.type === "error") return message.willRetry === false;
    return message.type === "system" && message.subtype === "turn_complete";
  }

  private getRecordMessageId(record: RuntimeEventRecord): string | null {
    const message = this.getRecordMessage(record);
    if (!message) return null;
    if (typeof message.uuid === "string") return message.uuid;
    return typeof message.id === "string" ? message.id : null;
  }

  private findReplayStart(
    records: RuntimeEventRecord[],
    replayAfterMessageId: string | undefined,
  ): number {
    if (!replayAfterMessageId) return 0;
    let index = -1;
    for (let cursor = 0; cursor < records.length; cursor += 1) {
      const record = records[cursor];
      if (record && this.getRecordMessageId(record) === replayAfterMessageId) {
        index = cursor;
      }
    }
    return index >= 0 ? index + 1 : 0;
  }
}

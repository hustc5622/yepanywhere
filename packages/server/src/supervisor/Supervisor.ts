import { randomUUID } from "node:crypto";
import {
  type CodexMcpMode,
  DEFAULT_PERMISSION_MODE,
  type EffortLevel,
  type OpenCodeSessionConfig,
  type PermissionRules,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type ThinkingConfig,
  type UrlProjectId,
  stripBridgeMetadata,
  stripIdeMetadata,
} from "@yep-anywhere/shared";
import type { AgentActivity, PendingInputType } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { getProvider } from "../sdk/providers/index.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { ClaudeSDK, PermissionMode, UserMessage } from "../sdk/types.js";
import type {
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
  SessionAbortedEvent,
  SessionCreatedEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
  WorkerActivityEvent,
} from "../watcher/EventBus.js";
import { Process, type ProcessConstructorOptions } from "./Process.js";
import {
  type QueuedRequest,
  type QueuedRequestInfo,
  type QueuedResponse,
  WorkerQueue,
  isQueueFullError,
} from "./WorkerQueue.js";
import {
  DEFAULT_IDLE_PREEMPT_THRESHOLD_MS,
  type ProcessInfo,
  type ProcessOptions,
  type SessionOwnership,
  type SessionSummary,
  encodeProjectId,
} from "./types.js";

/** Maximum number of terminated processes to retain */
const MAX_TERMINATED_PROCESSES = 50;

/** How long to retain terminated process info (10 minutes) */
const TERMINATED_RETENTION_MS = 10 * 60 * 1000;

/** How often to check for stale processes (60 seconds) */
const STALE_CHECK_INTERVAL_MS = 60 * 1000;

/** Default in-turn stale threshold for providers with frequent heartbeat/tool events. */
const DEFAULT_STALE_IN_TURN_THRESHOLD_MS = 5 * 60 * 1000;
/** Codex sessions can be silent for long periods during backend retries/reconnects. */
const CODEX_STALE_IN_TURN_THRESHOLD_MS = 60 * 60 * 1000;

export function getStaleInTurnThresholdMs(provider: ProviderName): number {
  return provider === "codex" || provider === "codex-oss"
    ? CODEX_STALE_IN_TURN_THRESHOLD_MS
    : DEFAULT_STALE_IN_TURN_THRESHOLD_MS;
}

/**
 * Model and thinking settings for a session.
 */
export interface ModelSettings {
  /** Model to use (e.g., "sonnet", "opus", "haiku"). undefined = use CLI default */
  model?: string;
  /** Thinking configuration. undefined = thinking disabled */
  thinking?: ThinkingConfig;
  /** Effort level for response quality. undefined = SDK default */
  effort?: EffortLevel;
  /** Exact provider reasoning effort. Currently consumed by Codex. */
  reasoningEffort?: string;
  /** Codex MCP profile. Only consumed by the Codex provider. */
  codexMcpMode?: CodexMcpMode;
  /** Managed OpenCode provider/model configuration. */
  opencodeConfig?: OpenCodeSessionConfig;
  /** Provider to use for this session. undefined = use the runtime default. */
  providerName?: ProviderName;
  /** Configured SSH host for Claude remote execution. */
  executor?: string;
  /** Global instructions to append to system prompt (from server settings) */
  globalInstructions?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /**
   * Provider-native edit boundary. Claude resumes through an ancestor UUID;
   * OpenCode forks before the native user message ID supplied here.
   */
  resumeSessionAt?: string;
  /**
   * Provider-native same-thread rollback count. Currently Codex-only, mapping
   * to app-server `thread/rollback` before the edited turn starts.
   */
  rollbackNumTurns?: number;
}

function getRewindSettings(modelSettings?: ModelSettings): {
  hasRewind: boolean;
  resumeSessionAt: string | null;
  rollbackNumTurns: number | null;
} {
  const resumeSessionAt = modelSettings?.resumeSessionAt ?? null;
  const rollbackNumTurns = modelSettings?.rollbackNumTurns ?? null;
  return {
    hasRewind: Boolean(resumeSessionAt || rollbackNumTurns),
    resumeSessionAt,
    rollbackNumTurns,
  };
}

/** Error response when queue is full */
export interface QueueFullResponse {
  error: "queue_full";
  maxQueueSize: number;
}

/** Optional callback to persist executor when session ID is received */
export type OnSessionExecutorCallback = (
  sessionId: string,
  executor: string | undefined,
) => Promise<void>;

/** Optional callback to migrate state when a temporary provider ID is replaced. */
export type OnSessionIdChangedCallback = (
  oldSessionId: string,
  newSessionId: string,
  projectId: UrlProjectId,
) => Promise<void>;

/** Optional callback to fetch authoritative session summary for reconciliation */
export type OnSessionSummaryCallback = (
  sessionId: string,
  projectId: UrlProjectId,
) => Promise<SessionSummary | null>;

/** Delays for initial title/messageCount reconciliation after session creation */
const INITIAL_RECONCILE_DELAYS_MS = [1000, 3000] as const;
/**
 * OpenCode emits its fork ID only after server startup, configuration, native
 * fork creation, and lineage metadata persistence have all completed.
 */
const DEFAULT_OPENCODE_FORK_SESSION_ID_TIMEOUT_MS = 60_000;

export interface SupervisorOptions {
  /** Agent provider interface (preferred for new code) */
  provider?: AgentProvider;
  /** Legacy SDK interface for mock SDK */
  sdk?: ClaudeSDK;
  idleTimeoutMs?: number;
  /** Default permission mode for new sessions */
  defaultPermissionMode?: PermissionMode;
  /** EventBus for emitting session status changes */
  eventBus?: EventBus;
  /** Maximum concurrent workers. 0 = unlimited (default for backward compat) */
  maxWorkers?: number;
  /** Idle threshold in milliseconds for preemption. Workers idle longer than this can be preempted. */
  idlePreemptThresholdMs?: number;
  /** Maximum queue size. 0 = unlimited (default) */
  maxQueueSize?: number;
  /** Callback to persist executor when session ID is received (for remote execution resume) */
  onSessionExecutor?: OnSessionExecutorCallback;
  /** Callback to migrate metadata from a temporary ID to the durable ID. */
  onSessionIdChanged?: OnSessionIdChangedCallback;
  /** Callback to fetch session summary for initial metadata reconciliation */
  onSessionSummary?: OnSessionSummaryCallback;
  /** Strict OpenCode edit-fork initialization budget. Primarily configurable for tests. */
  opencodeForkSessionIdTimeoutMs?: number;
}

export class Supervisor {
  private processes: Map<string, Process> = new Map();
  private sessionToProcess: Map<string, string> = new Map(); // sessionId -> processId
  private everOwnedSessions: Set<string> = new Set(); // Sessions we've ever owned (for orphan detection)
  private terminatedProcesses: ProcessInfo[] = []; // Recently terminated processes
  private provider: AgentProvider | null;
  private sdk: ClaudeSDK | null;
  private idleTimeoutMs?: number;
  private defaultPermissionMode: PermissionMode;
  private eventBus?: EventBus;
  private maxWorkers: number;
  private idlePreemptThresholdMs: number;
  private workerQueue: WorkerQueue;
  private onSessionExecutor?: OnSessionExecutorCallback;
  private onSessionIdChanged?: OnSessionIdChangedCallback;
  private onSessionSummary?: OnSessionSummaryCallback;
  private opencodeForkSessionIdTimeoutMs: number;
  private staleCheckTimer: ReturnType<typeof setInterval>;
  private isShuttingDown = false;
  private queueProcessingPromise: Promise<void> | null = null;

  constructor(options: SupervisorOptions) {
    this.provider = options.provider ?? null;
    this.sdk = options.sdk ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.defaultPermissionMode =
      options.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
    this.eventBus = options.eventBus;
    this.maxWorkers = options.maxWorkers ?? 0; // 0 = unlimited
    this.idlePreemptThresholdMs =
      options.idlePreemptThresholdMs ?? DEFAULT_IDLE_PREEMPT_THRESHOLD_MS;
    this.workerQueue = new WorkerQueue({
      eventBus: options.eventBus,
      maxQueueSize: options.maxQueueSize,
    });
    this.onSessionExecutor = options.onSessionExecutor;
    this.onSessionIdChanged = options.onSessionIdChanged;
    this.onSessionSummary = options.onSessionSummary;
    this.opencodeForkSessionIdTimeoutMs = Math.max(
      1,
      Math.floor(
        options.opencodeForkSessionIdTimeoutMs ??
          DEFAULT_OPENCODE_FORK_SESSION_ID_TIMEOUT_MS,
      ),
    );
    this.staleCheckTimer = setInterval(
      () => this.terminateStaleProcesses(),
      STALE_CHECK_INTERVAL_MS,
    );
    this.staleCheckTimer.unref(); // Don't keep process alive for cleanup

    if (!this.provider && !this.sdk) {
      throw new Error("Either provider or sdk must be provided");
    }
  }

  private resolveProvider(modelSettings?: ModelSettings): AgentProvider | null {
    if (modelSettings?.providerName) {
      // Explicit SDK injection is the legacy unit-test seam. Production does
      // not provide it and therefore always resolves Claude to the SSH-only
      // provider below.
      if (
        this.sdk &&
        (modelSettings.providerName === "claude" ||
          modelSettings.providerName === "claude-ollama")
      ) {
        return null;
      }
      const provider = getProvider(modelSettings.providerName);
      if (!provider) {
        throw new Error(
          `Provider \"${modelSettings.providerName}\" is not available in this server.`,
        );
      }
      if (modelSettings.executor && provider.name !== "claude") {
        throw new Error(
          "SSH executors are supported only by the Claude provider.",
        );
      }
      return provider;
    }

    if (modelSettings?.executor && this.provider?.name !== "claude") {
      throw new Error(
        "SSH executors are supported only by the Claude provider.",
      );
    }

    return this.provider;
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    this.assertAcceptingWork();
    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to start session normally
      } else {
        // Queue the request
        const result = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          message,
          permissionMode,
          modelSettings,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    const provider = this.resolveProvider(modelSettings);

    // Use provider if available (preferred)
    if (provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
        modelSettings,
        provider,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      undefined,
      permissionMode,
    );
  }

  /**
   * Create a session without sending an initial message.
   * Used for two-phase flow: create session first, upload files, then send message.
   * The agent will wait for a message to be pushed to the queue.
   */
  async createSession(
    projectPath: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    this.assertAcceptingWork();
    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to create session normally
      } else {
        // Queue the request - use empty message placeholder
        const result = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          message: { text: "" }, // Placeholder, will be replaced when first message sent
          permissionMode,
          modelSettings,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    const provider = this.resolveProvider(modelSettings);

    // Use provider if available (preferred)
    if (provider) {
      return this.createProviderSession(
        projectPath,
        projectId,
        permissionMode,
        modelSettings,
        provider,
      );
    }

    // Fall back to legacy mock SDK - not supported for create-only
    throw new Error(
      "createSession requires a provider - legacy mock SDK does not support create-only sessions",
    );
  }

  /**
   * Create a session using the provider interface without an initial message.
   * The session is created and waits for a message to be queued.
   */
  private async createProviderSession(
    projectPath: string,
    projectId: UrlProjectId,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    provider?: AgentProvider,
  ): Promise<Process> {
    const activeProvider = provider ?? this.provider;
    if (!activeProvider) {
      throw new Error("provider is not available");
    }

    const processHolder: { process: Process | null } = { process: null };
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const tempSessionId = randomUUID();
    const startupId =
      activeProvider.name === "claude" ? randomUUID() : undefined;
    const startupStartedAtMs = Date.now();

    if (startupId) {
      getLogger().info(
        {
          event: "provider_session_create_requested",
          startupId,
          tempSessionId,
          providerName: activeProvider.name,
          projectId,
          projectPath,
          executor: modelSettings?.executor,
        },
        "Provider session creation requested",
      );
    }

    // Start session WITHOUT an initial message - agent will wait
    const result = await activeProvider.startSession({
      startupId,
      cwd: projectPath,
      // No initialMessage - queue will block until one is pushed
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      reasoningEffort: modelSettings?.reasoningEffort,
      codexMcpMode: modelSettings?.codexMcpMode,
      opencodeConfig: modelSettings?.opencodeConfig,
      executor: modelSettings?.executor,
      globalInstructions: modelSettings?.globalInstructions,
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });
    if (startupId) {
      getLogger().info(
        {
          event: "provider_session_handle_created",
          startupId,
          tempSessionId,
          providerName: activeProvider.name,
          projectId,
          executor: modelSettings?.executor,
          requestElapsedMs: Date.now() - startupStartedAtMs,
        },
        "Provider returned a session handle",
      );
    }

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      setMaxThinkingTokens,
      interrupt,
      steer,
      supportedModels,
      supportedCommands,
      setModel,
      setPermissionMode: setProviderPermissionMode,
      getContextUsage,
      initializationResult,
    } = result;

    const options: ProcessConstructorOptions = {
      startupId,
      startupStartedAtMs,
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      steerFn: steer,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      setPermissionModeFn: setProviderPermissionMode,
      getContextUsageFn: getContextUsage,
      initializationResultFn: initializationResult,
      permissionMode: effectiveMode,
      provider: activeProvider.name,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      reasoningEffort: modelSettings?.reasoningEffort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;

    // Wait for the real session ID from the provider
    await process.waitForSessionId();

    // Register as a new session
    this.registerProcess(process, true);

    return process;
  }

  /**
   * Start a session using the provider interface with full features.
   */
  private async startProviderSession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    provider?: AgentProvider,
  ): Promise<Process> {
    const activeProvider = provider ?? this.provider;
    if (!activeProvider) {
      throw new Error("provider is not available");
    }

    const tempSessionId = resumeSessionId ?? randomUUID();
    const startupId =
      activeProvider.name === "claude" ? randomUUID() : undefined;
    const startupStartedAtMs = Date.now();

    // We need to reference process in the callback before it's assigned
    const processHolder: { process: Process | null } = { process: null };

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    // Generate UUID for the initial message so SDK and SSE use the same ID.
    const messageUuid = randomUUID();
    const messageWithUuid: UserMessage = { ...message, uuid: messageUuid };
    const rewind = getRewindSettings(modelSettings);

    getLogger().info(
      {
        event: "provider_session_start_requested",
        startupId,
        tempSessionId,
        providerName: activeProvider.name,
        projectId,
        projectPath,
        resumeSessionId: resumeSessionId ?? null,
        permissionMode: effectiveMode,
        model: modelSettings?.model ?? null,
        codexMcpMode: modelSettings?.codexMcpMode ?? null,
        resumeSessionAt: rewind.resumeSessionAt,
        rollbackNumTurns: rewind.rollbackNumTurns,
      },
      "Provider session start requested",
    );

    const result = await activeProvider.startSession({
      startupId,
      cwd: projectPath,
      initialMessage: messageWithUuid,
      resumeSessionId,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      reasoningEffort: modelSettings?.reasoningEffort,
      codexMcpMode: modelSettings?.codexMcpMode,
      opencodeConfig: modelSettings?.opencodeConfig,
      executor: modelSettings?.executor,
      globalInstructions: modelSettings?.globalInstructions,
      resumeSessionAt: modelSettings?.resumeSessionAt,
      rollbackNumTurns: modelSettings?.rollbackNumTurns,
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });
    if (startupId) {
      getLogger().info(
        {
          event: "provider_session_handle_created",
          startupId,
          tempSessionId,
          providerName: activeProvider.name,
          projectId,
          executor: modelSettings?.executor,
          requestElapsedMs: Date.now() - startupStartedAtMs,
        },
        "Provider returned a session handle",
      );
    }

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      setMaxThinkingTokens,
      interrupt,
      steer,
      supportedModels,
      supportedCommands,
      setModel,
      setPermissionMode: setProviderPermissionMode,
      getContextUsage,
      initializationResult,
    } = result;

    const options: ProcessConstructorOptions = {
      startupId,
      startupStartedAtMs,
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      steerFn: steer,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      setPermissionModeFn: setProviderPermissionMode,
      getContextUsageFn: getContextUsage,
      initializationResultFn: initializationResult,
      permissionMode: effectiveMode,
      provider: activeProvider.name,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      reasoningEffort: modelSettings?.reasoningEffort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;

    // Add the initial user message to history with the same UUID we passed to provider.
    process.addInitialUserMessage(message.text, messageUuid, message.tempId);

    const isForkedResume =
      activeProvider.name === "opencode" &&
      Boolean(resumeSessionId && modelSettings?.resumeSessionAt);

    // Wait for the real session ID from the provider before registering
    if (!resumeSessionId || isForkedResume) {
      let resolvedSessionId: string;
      try {
        resolvedSessionId = await process.waitForSessionId(
          isForkedResume ? this.opencodeForkSessionIdTimeoutMs : 5000,
          {
            strict: isForkedResume,
          },
        );
      } catch (error) {
        await process.abort();
        throw error;
      }
      if (isForkedResume && resolvedSessionId === resumeSessionId) {
        await process.abort();
        throw new Error(
          "OpenCode edit fork did not return a new native session ID",
        );
      }
    }

    this.registerProcess(process, !resumeSessionId || isForkedResume);

    return process;
  }

  /**
   * Start a session using the legacy mock SDK.
   */
  private startLegacySession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
  ): Process {
    // sdk is guaranteed to exist here (checked in startSession)
    if (!this.sdk) {
      throw new Error("sdk is not available");
    }
    const iterator = this.sdk.startSession({
      cwd: projectPath,
      resume: resumeSessionId,
    });

    const sessionId = resumeSessionId ?? randomUUID();

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    const options: ProcessOptions = {
      projectPath,
      projectId,
      sessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      permissionMode: effectiveMode,
      provider: "claude", // Legacy mock SDK simulates Claude
    };

    const process = new Process(iterator, options);

    this.registerProcess(process, !resumeSessionId);

    // Queue the initial message
    process.queueMessage(message);

    return process;
  }

  async resumeSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    this.assertAcceptingWork();
    const rewind = getRewindSettings(modelSettings);

    // Check if already have a process for this session
    const existingProcessId = this.sessionToProcess.get(sessionId);
    if (existingProcessId) {
      const existingProcess = this.processes.get(existingProcessId);
      if (existingProcess) {
        // Check if process is terminated - if so, start a fresh one
        if (existingProcess.isTerminated) {
          this.unregisterProcess(existingProcess);
        } else if (rewind.hasRewind) {
          getLogger().info(
            {
              event: "session_rewind_existing_process_restart",
              sessionId,
              processId: existingProcess.id,
              projectId: existingProcess.projectId,
              projectPath,
              providerName: modelSettings?.providerName ?? null,
              resumeSessionAt: rewind.resumeSessionAt,
              rollbackNumTurns: rewind.rollbackNumTurns,
            },
            "Restarting existing session process to apply rewind",
          );
          await existingProcess.abort();
          this.unregisterProcess(existingProcess);
        } else {
          // Check if thinking/effort settings changed
          const thinkingChanged =
            existingProcess.thinking?.type !==
            (modelSettings?.thinking?.type ?? undefined);
          const effortChanged =
            existingProcess.effort !== modelSettings?.effort;
          const reasoningEffortChanged =
            existingProcess.requestedReasoningEffort !==
            modelSettings?.reasoningEffort;

          if (thinkingChanged || effortChanged || reasoningEffortChanged) {
            if (
              thinkingChanged &&
              !effortChanged &&
              !reasoningEffortChanged &&
              existingProcess.supportsThinkingModeChange
            ) {
              // Toggle adaptive/disabled dynamically via deprecated API
              const tokens =
                modelSettings?.thinking?.type === "disabled" ? 0 : 1;
              const changed = await existingProcess.setMaxThinkingTokens(
                tokens === 0 ? undefined : tokens,
              );
              if (changed) {
                existingProcess.updateThinkingConfig(
                  modelSettings?.thinking,
                  modelSettings?.effort,
                );
              } else {
                const log = getLogger();
                log.warn(
                  {
                    event: "thinking_mode_change_failed",
                    sessionId,
                    processId: existingProcess.id,
                  },
                  "Failed to change thinking mode dynamically",
                );
              }
            } else {
              // Effort changed or no dynamic support: restart process
              const log = getLogger();
              log.info(
                {
                  event: "thinking_mode_changed_restart",
                  sessionId,
                  processId: existingProcess.id,
                  oldThinking: existingProcess.thinking?.type,
                  oldEffort: existingProcess.effort,
                  oldReasoningEffort: existingProcess.requestedReasoningEffort,
                  newThinking: modelSettings?.thinking?.type,
                  newEffort: modelSettings?.effort,
                  newReasoningEffort: modelSettings?.reasoningEffort,
                },
                "Thinking or reasoning effort changed, restarting process",
              );
              await existingProcess.abort();
              this.unregisterProcess(existingProcess);
              // Fall through to start a new session with the updated settings
            }
          }
          // Update permission mode if specified
          if (permissionMode) {
            await existingProcess.syncPermissionMode(permissionMode);
          }
          // Queue message to existing process (if we didn't fall through to restart)
          if (!existingProcess.isTerminated) {
            const result = existingProcess.queueMessage(message);
            if (result.success) {
              return existingProcess;
            }
            // Failed to queue - process likely terminated, clean up and start fresh
            this.unregisterProcess(existingProcess);
          }
        }
      }
    }

    // Check if there's already a queued request for this session
    const existingQueued = this.workerQueue.findBySessionId(sessionId);
    if (existingQueued) {
      if (rewind.hasRewind) {
        getLogger().info(
          {
            event: "session_rewind_cancelled_existing_queue",
            sessionId,
            queueId: existingQueued.id,
            resumeSessionAt: rewind.resumeSessionAt,
            rollbackNumTurns: rewind.rollbackNumTurns,
          },
          "Cancelling existing queued resume request to apply rewind",
        );
        this.workerQueue.cancel(existingQueued.id);
      } else {
        // Already queued - return current position
        const position = this.workerQueue.getPosition(existingQueued.id);
        return {
          queued: true,
          queueId: existingQueued.id,
          position: position ?? 1,
        };
      }
    }

    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to start session normally
      } else {
        // Queue the request
        const result = this.workerQueue.enqueue({
          type: "resume-session",
          projectPath,
          projectId,
          sessionId,
          message,
          permissionMode,
          modelSettings,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    const provider = this.resolveProvider(modelSettings);

    // Use provider if available (preferred)
    if (provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        sessionId,
        permissionMode,
        modelSettings,
        provider,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      sessionId,
      permissionMode,
    );
  }

  getProcess(processId: string): Process | undefined {
    return this.processes.get(processId);
  }

  getProcessForSession(sessionId: string): Process | undefined {
    const processId = this.sessionToProcess.get(sessionId);
    if (!processId) return undefined;
    return this.processes.get(processId);
  }

  /**
   * Queue a message to an existing session, handling thinking mode changes.
   * If the thinking mode differs from the process's current setting, this will:
   * 1. Abort the existing process
   * 2. Start a new process with the new thinking settings
   * 3. Queue the message to the new process
   *
   * @returns The process (possibly new), or an error object
   */
  async queueMessageToSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<
    | { success: true; process: Process; restarted: boolean }
    | { success: false; error: string }
  > {
    if (this.isShuttingDown) {
      return { success: false, error: "Runtime is shutting down" };
    }
    const process = this.getProcessForSession(sessionId);
    if (!process) {
      return { success: false, error: "No active process for session" };
    }

    if (process.isTerminated) {
      return { success: false, error: "Process terminated" };
    }

    // Check if thinking/effort settings changed
    const thinkingChanged =
      process.thinking?.type !== (modelSettings?.thinking?.type ?? undefined);
    const effortChanged = process.effort !== modelSettings?.effort;
    const reasoningEffortChanged =
      process.requestedReasoningEffort !== modelSettings?.reasoningEffort;

    if (thinkingChanged || effortChanged || reasoningEffortChanged) {
      if (
        thinkingChanged &&
        !effortChanged &&
        !reasoningEffortChanged &&
        process.supportsThinkingModeChange
      ) {
        // Toggle thinking dynamically via deprecated API (works for auto↔off)
        const tokens = modelSettings?.thinking?.type === "disabled" ? 0 : 1;
        const changed = await process.setMaxThinkingTokens(
          tokens === 0 ? undefined : tokens,
        );
        if (changed) {
          process.updateThinkingConfig(
            modelSettings?.thinking,
            modelSettings?.effort,
          );
        } else {
          const log = getLogger();
          log.warn(
            {
              event: "thinking_mode_change_failed_queue",
              sessionId,
              processId: process.id,
            },
            "Failed to change thinking mode dynamically on queue",
          );
        }
      } else {
        // Effort changed or no dynamic support: restart process
        const log = getLogger();
        log.info(
          {
            event: "thinking_mode_changed_queue_restart",
            sessionId,
            processId: process.id,
            oldThinking: process.thinking?.type,
            oldEffort: process.effort,
            oldReasoningEffort: process.requestedReasoningEffort,
            newThinking: modelSettings?.thinking?.type,
            newEffort: modelSettings?.effort,
            newReasoningEffort: modelSettings?.reasoningEffort,
          },
          "Thinking or reasoning effort changed on queue, restarting process",
        );

        await process.abort();
        this.unregisterProcess(process);

        const result = await this.resumeSession(
          sessionId,
          projectPath,
          message,
          permissionMode,
          modelSettings,
        );

        if ("id" in result) {
          return { success: true, process: result, restarted: true };
        }
        return { success: false, error: "Request was queued or failed" };
      }
    }

    // Queue to existing process (dynamic thinking change already applied if needed)
    if (permissionMode) {
      await process.syncPermissionMode(permissionMode);
    }

    const result = process.queueMessage(message);
    if (result.success) {
      return { success: true, process, restarted: false };
    }

    return { success: false, error: result.error ?? "Failed to queue message" };
  }

  getAllProcesses(): Process[] {
    return Array.from(this.processes.values());
  }

  getProcessInfoList(): ProcessInfo[] {
    return this.getAllProcesses().map((p) => p.getInfo());
  }

  /**
   * Check if a session was ever owned by this server instance.
   * Used to determine if orphaned tool detection should be trusted.
   * For sessions we never owned (external), we can't know if tools were interrupted.
   */
  wasEverOwned(sessionId: string): boolean {
    return this.everOwnedSessions.has(sessionId);
  }

  async abortProcess(processId: string): Promise<boolean> {
    const process = this.processes.get(processId);
    if (!process) return false;

    const log = getLogger();
    log.info(
      {
        event: "session_abort_requested",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session abort requested: ${process.sessionId}`,
    );

    // Emit session-aborted event BEFORE aborting, so ExternalSessionTracker
    // can set up the grace period before any file changes arrive
    this.emitSessionAborted(process.sessionId, process.projectId);

    await process.abort();
    this.unregisterProcess(process);
    return true;
  }

  /**
   * Interrupt the current turn of a running process gracefully.
   * Unlike abort, this stops the current turn but keeps the process alive.
   *
   * @returns Object with success status and whether interrupt is supported
   */
  async interruptProcess(
    processId: string,
  ): Promise<{ success: boolean; supported: boolean }> {
    const process = this.processes.get(processId);
    if (!process) return { success: false, supported: false };

    // Check if the process supports interrupt
    if (!process.supportsInterrupt) {
      return { success: false, supported: false };
    }

    const log = getLogger();
    log.info(
      {
        event: "session_interrupt_requested",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session interrupt requested: ${process.sessionId}`,
    );

    const interrupted = await process.interrupt();
    return { success: interrupted, supported: true };
  }

  private emitSessionAborted(sessionId: string, projectId: UrlProjectId): void {
    if (!this.eventBus) return;

    const event: SessionAbortedEvent = {
      type: "session-aborted",
      sessionId,
      projectId,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private registerProcess(process: Process, isNewSession: boolean): void {
    const log = getLogger();
    log.info(
      {
        event: "session_registered",
        startupId: process.startupId,
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        projectPath: process.projectPath,
        isNewSession,
        permissionMode: process.permissionMode,
      },
      `Session registered: ${process.sessionId} (process: ${process.id})`,
    );

    this.processes.set(process.id, process);
    this.sessionToProcess.set(process.sessionId, process.id);
    this.everOwnedSessions.add(process.sessionId);

    const ownership: SessionOwnership = {
      owner: "self",
      processId: process.id,
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    };

    // Emit session created event for new sessions
    if (isNewSession) {
      this.emitSessionCreated(process, ownership);
      this.scheduleInitialSessionReconciliation(
        process.sessionId,
        process.projectId,
      );
    }

    // Emit ownership change event
    this.emitOwnershipChange(process.sessionId, process.projectId, ownership);

    // Emit initial agent activity (process starts in in-turn state)
    const initialState = process.state;
    if (
      initialState.type === "in-turn" ||
      initialState.type === "waiting-input"
    ) {
      // Convert InputRequest.type to PendingInputType if waiting for input at start
      let pendingInputType: PendingInputType | undefined;
      if (initialState.type === "waiting-input") {
        const requestType = initialState.request.type;
        pendingInputType =
          requestType === "tool-approval" ? "tool-approval" : "user-question";
      }
      this.emitAgentActivityChange(
        process.sessionId,
        process.projectId,
        initialState.type,
        pendingInputType,
      );
    }

    // Emit worker activity after registering (new worker added)
    this.emitWorkerActivity();

    // Listen for completion to auto-cleanup, and state changes for process state events
    process.subscribe((event) => {
      if (event.type === "complete") {
        this.unregisterProcess(process);
      } else if (event.type === "session-id-changed") {
        // Update session→process mapping when temp ID is replaced by real ID from SDK
        // This is critical for ExternalSessionTracker to correctly identify owned sessions
        const log = getLogger();
        log.info(
          {
            event: "session_id_mapping_updated",
            startupId: process.startupId,
            oldSessionId: event.oldSessionId,
            newSessionId: event.newSessionId,
            processId: process.id,
            projectId: process.projectId,
            executor: process.executor,
          },
          `Session ID mapping updated: ${event.oldSessionId} → ${event.newSessionId}`,
        );

        // Keep both temp and real session ID mappings to support lookups by either ID
        // Clients might still be using the temp ID when the real ID arrives
        // The old temp ID mapping is retained (no delete)
        this.sessionToProcess.set(event.newSessionId, process.id);
        this.everOwnedSessions.add(event.newSessionId);

        this.eventBus?.emit({
          type: "session-id-changed",
          oldSessionId: event.oldSessionId,
          newSessionId: event.newSessionId,
          projectId: process.projectId,
          executor: process.executor,
          timestamp: new Date().toISOString(),
        });

        // Session creation can return after Process.waitForSessionId() times
        // out, leaving Yep metadata stored under the temporary UUID. Migrate
        // that state as soon as the provider later supplies its durable ID.
        if (this.onSessionIdChanged) {
          this.onSessionIdChanged(
            event.oldSessionId,
            event.newSessionId,
            process.projectId,
          ).catch((error) => {
            log.warn(
              {
                event: "session_id_metadata_migration_failed",
                oldSessionId: event.oldSessionId,
                newSessionId: event.newSessionId,
                projectId: process.projectId,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to migrate metadata to the durable session ID",
            );
          });
        }

        // Persist executor for remote execution resume support
        // This saves which SSH host was used so resume can reconnect to the same remote
        if (this.onSessionExecutor && process.executor) {
          this.onSessionExecutor(event.newSessionId, process.executor).catch(
            (error) => {
              log.warn(
                {
                  event: "executor_save_failed",
                  sessionId: event.newSessionId,
                  executor: process.executor,
                  error: error instanceof Error ? error.message : String(error),
                },
                `Failed to save executor for session: ${event.newSessionId}`,
              );
            },
          );
        }

        // Emit ownership change for new session ID so clients can update
        const ownership: SessionOwnership = {
          owner: "self",
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        };
        this.emitOwnershipChange(
          event.newSessionId,
          process.projectId,
          ownership,
        );

        // Retry early metadata reconciliation with authoritative session ID.
        this.scheduleInitialSessionReconciliation(
          event.newSessionId,
          process.projectId,
        );
      } else if (event.type === "state-change") {
        // Emit agent activity change for all states that clients need to track
        // This includes in-turn/waiting-input (active) and idle (inactive)
        if (
          event.state.type === "in-turn" ||
          event.state.type === "waiting-input" ||
          event.state.type === "idle" ||
          event.state.type === "hold" ||
          event.state.type === "terminated"
        ) {
          // Convert InputRequest.type to PendingInputType when waiting for input
          // "tool-approval" stays as-is, "question" or "choice" becomes "user-question"
          let pendingInputType: PendingInputType | undefined;
          if (event.state.type === "waiting-input") {
            const requestType = event.state.request.type;
            pendingInputType =
              requestType === "tool-approval"
                ? "tool-approval"
                : "user-question";
          }
          this.emitAgentActivityChange(
            process.sessionId,
            process.projectId,
            event.state.type,
            pendingInputType,
          );
        }
        // Emit worker activity on any state change (affects hasActiveWork)
        this.emitWorkerActivity();
      } else if (event.type === "terminated") {
        this.emitProcessTerminated(
          process.sessionId,
          process.projectId,
          process.id,
          process.provider,
          event.reason,
        );
      }
    });
  }

  private unregisterProcess(process: Process): void {
    if (!this.processes.has(process.id)) {
      return;
    }

    const log = getLogger();
    const durationMs = Date.now() - process.startedAt.getTime();
    log.info(
      {
        event: "session_unregistered",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        durationMs,
        finalState: process.state.type,
        terminationReason: process.terminationReason,
      },
      `Session unregistered: ${process.sessionId} after ${durationMs}ms (reason: ${process.terminationReason ?? process.state.type})`,
    );

    // Capture process info for terminated list before deleting
    const terminatedInfo = process.getInfo();
    terminatedInfo.state = "terminated"; // Override state since process may have been forcefully aborted
    terminatedInfo.terminatedAt = new Date().toISOString();
    if (process.terminationReason) {
      terminatedInfo.terminationReason = process.terminationReason;
    }
    this.addTerminatedProcess(terminatedInfo);

    this.processes.delete(process.id);

    // Delete all session ID mappings that point to this process
    // This handles both temp and real session IDs
    for (const [sessionId, processId] of this.sessionToProcess.entries()) {
      if (processId === process.id) {
        this.sessionToProcess.delete(sessionId);
      }
    }

    // Emit ownership change event (back to none)
    this.emitOwnershipChange(process.sessionId, process.projectId, {
      owner: "none",
    });

    // Emit agent activity change to notify clients that this session is no longer running
    // This is needed for real-time updates (e.g., AgentsNavItem indicator)
    this.emitAgentActivityChange(process.sessionId, process.projectId, "idle");

    // Emit worker activity after unregistering (worker removed)
    this.emitWorkerActivity();

    // Runtime shutdown must not start replacement work after the control
    // server begins closing.
    if (!this.isShuttingDown) {
      this.scheduleProcessQueue();
    }
  }

  /**
   * Add a terminated process to the tracking list.
   * Prunes old entries and caps at MAX_TERMINATED_PROCESSES.
   */
  private addTerminatedProcess(info: ProcessInfo): void {
    this.terminatedProcesses.push(info);

    // Cap at max entries
    if (this.terminatedProcesses.length > MAX_TERMINATED_PROCESSES) {
      this.terminatedProcesses = this.terminatedProcesses.slice(
        -MAX_TERMINATED_PROCESSES,
      );
    }
  }

  /**
   * Get recently terminated processes (within retention window).
   * Prunes expired entries before returning.
   */
  getRecentlyTerminatedProcesses(): ProcessInfo[] {
    const now = Date.now();
    const cutoff = now - TERMINATED_RETENTION_MS;

    // Prune old entries
    this.terminatedProcesses = this.terminatedProcesses.filter((p) => {
      if (!p.terminatedAt) return false;
      return new Date(p.terminatedAt).getTime() > cutoff;
    });

    return [...this.terminatedProcesses];
  }

  private emitOwnershipChange(
    sessionId: string,
    projectId: UrlProjectId,
    ownership: SessionOwnership,
  ): void {
    if (!this.eventBus) return;

    const event: SessionStatusEvent = {
      type: "session-status-changed",
      sessionId,
      projectId,
      ownership,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitSessionCreated(
    process: Process,
    ownership: SessionOwnership,
  ): void {
    if (!this.eventBus) return;

    const now = new Date().toISOString();
    const optimistic = this.buildOptimisticSessionSeed(process);
    const session: SessionSummary = {
      id: process.sessionId,
      projectId: process.projectId,
      title: optimistic.title,
      fullTitle: optimistic.fullTitle,
      createdAt: now,
      updatedAt: now,
      messageCount: optimistic.messageCount,
      ownership,
      provider: process.provider,
      model: process.resolvedModel,
      reasoningEffort: process.resolvedReasoningEffort,
      serviceTier: process.serviceTier,
    };

    const event: SessionCreatedEvent = {
      type: "session-created",
      session,
      timestamp: now,
    };
    this.eventBus.emit(event);
  }

  private buildOptimisticSessionSeed(process: Process): {
    title: string | null;
    fullTitle: string | null;
    messageCount: number;
  } {
    const history = process.getMessageHistory();
    const firstUser = history.find(
      (msg) => msg.type === "user" && typeof msg.message?.content === "string",
    );
    const firstContent = firstUser?.message?.content;
    const fullTitle =
      typeof firstContent === "string"
        ? stripBridgeMetadata(stripIdeMetadata(firstContent))
        : "";
    if (!fullTitle) {
      return { title: null, fullTitle: null, messageCount: 0 };
    }

    const title =
      fullTitle.length <= SESSION_TITLE_MAX_LENGTH
        ? fullTitle
        : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;

    return { title, fullTitle, messageCount: 1 };
  }

  private scheduleInitialSessionReconciliation(
    sessionId: string,
    projectId: UrlProjectId,
  ): void {
    if (!this.eventBus || !this.onSessionSummary) return;

    for (const delayMs of INITIAL_RECONCILE_DELAYS_MS) {
      const timer = setTimeout(() => {
        void this.emitReconciledSessionUpdate(sessionId, projectId);
      }, delayMs);
      timer.unref();
    }
  }

  private async emitReconciledSessionUpdate(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<void> {
    if (!this.eventBus || !this.onSessionSummary) return;

    const summary = await this.onSessionSummary(sessionId, projectId);
    if (!summary) return;

    const event: SessionUpdatedEvent = {
      type: "session-updated",
      sessionId,
      projectId,
      title: summary.title,
      messageCount: summary.messageCount,
      updatedAt: summary.updatedAt,
      contextUsage: summary.contextUsage,
      cumulativeUsage: summary.cumulativeUsage,
      compactCount: summary.compactCount,
      compactEvents: summary.compactEvents,
      model: summary.model,
      reasoningEffort: summary.reasoningEffort,
      serviceTier: summary.serviceTier,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitAgentActivityChange(
    sessionId: string,
    projectId: UrlProjectId,
    activity: AgentActivity,
    pendingInputType?: PendingInputType,
  ): void {
    if (!this.eventBus) return;

    const event: ProcessStateEvent = {
      type: "process-state-changed",
      sessionId,
      projectId,
      activity,
      pendingInputType,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitProcessTerminated(
    sessionId: string,
    projectId: UrlProjectId,
    processId: string,
    provider: ProviderName,
    reason: string,
  ): void {
    if (!this.eventBus) return;

    const event: ProcessTerminatedEvent = {
      type: "process-terminated",
      sessionId,
      projectId,
      processId,
      provider,
      reason,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  /**
   * Emit worker activity event for safe restart indicator.
   * Called when workers are added, removed, or change state.
   */
  private emitWorkerActivity(): void {
    if (!this.eventBus) return;

    const hasActiveWork = Array.from(this.processes.values()).some(
      (p) =>
        p.state.type === "in-turn" ||
        p.state.type === "waiting-input" ||
        p.state.type === "hold",
    );

    const event: WorkerActivityEvent = {
      type: "worker-activity-changed",
      activeWorkers: this.processes.size,
      queueLength: this.workerQueue.length,
      hasActiveWork,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  // ============ Staleness Detection ============

  /**
   * Terminate processes stuck in "in-turn" with no SDK messages for too long.
   * This catches phantom processes where the underlying Claude process died
   * without the SDK iterator returning done or throwing.
   *
   * When process liveness checking is available (via spawn wrapper), we use
   * it to distinguish "process died silently" from "process is busy with a
   * long tool call". Only dead processes are terminated.
   */
  private terminateStaleProcesses(): void {
    const now = Date.now();

    for (const process of this.processes.values()) {
      if (process.state.type !== "in-turn") continue;
      if (process.isHeld) continue;

      const staleThresholdMs = getStaleInTurnThresholdMs(process.provider);
      const silentMs = now - process.lastMessageTime.getTime();
      if (silentMs < staleThresholdMs) continue;

      // If we can check process liveness, only terminate actually-dead processes.
      // A long-running tool call (e.g., CI wait) will be silent but the process
      // is still alive — don't kill it.
      const alive = process.isProcessAlive;
      if (alive === true) {
        // Process is alive but silent — likely executing a long tool call. Skip.
        continue;
      }

      const log = getLogger();

      if (alive === undefined) {
        // Liveness check unavailable — fall back to time-based heuristic
        log.warn(
          {
            event: "stale_process_detected",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            provider: process.provider,
            silentMs,
            staleThresholdMs,
            startedAt: process.startedAt.toISOString(),
            lastMessageTime: process.lastMessageTime.toISOString(),
            livenessAvailable: false,
          },
          `Terminating stale process (no liveness check): ${process.sessionId} (no messages for ${Math.round(silentMs / 1000)}s)`,
        );
      } else {
        // alive === false — process is confirmed dead
        log.warn(
          {
            event: "stale_process_dead",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            provider: process.provider,
            silentMs,
            staleThresholdMs,
            startedAt: process.startedAt.toISOString(),
            lastMessageTime: process.lastMessageTime.toISOString(),
          },
          `Terminating dead process: ${process.sessionId} (exited, silent for ${Math.round(silentMs / 1000)}s)`,
        );
      }

      process.terminate(
        `stale: no SDK messages for ${Math.round(silentMs / 1000)}s`,
      );
    }
  }

  // ============ Worker Pool Methods ============

  /**
   * Check if we're at worker capacity.
   */
  private isAtCapacity(): boolean {
    if (this.maxWorkers <= 0) return false; // 0 = unlimited
    return this.processes.size >= this.maxWorkers;
  }

  /**
   * Find a preemptable worker (idle longer than threshold).
   * Returns the worker that has been idle longest.
   * Does not preempt workers waiting for input.
   */
  private findPreemptableWorker(): Process | undefined {
    let oldest: Process | undefined;
    let oldestIdleTime = 0;
    const now = Date.now();

    for (const process of this.processes.values()) {
      // Only preempt idle processes, not waiting-input
      if (process.state.type !== "idle") continue;

      const idleMs = now - process.state.since.getTime();
      if (idleMs >= this.idlePreemptThresholdMs && idleMs > oldestIdleTime) {
        oldest = process;
        oldestIdleTime = idleMs;
      }
    }

    return oldest;
  }

  /**
   * Preempt an idle worker to make room for a new request.
   */
  private async preemptWorker(process: Process): Promise<void> {
    await process.abort();
    this.unregisterProcess(process);
  }

  /**
   * Process the queue - called when a worker becomes available.
   */
  private async processQueue(): Promise<void> {
    while (
      !this.isShuttingDown &&
      !this.workerQueue.isEmpty &&
      !this.isAtCapacity()
    ) {
      const request = this.workerQueue.dequeue();
      if (!request) break;

      try {
        let process: Process;

        if (request.type === "new-session") {
          const result = await this.startSessionInternal(
            request.projectPath,
            request.projectId,
            request.message,
            undefined,
            request.permissionMode,
            request.modelSettings,
          );
          process = result;
        } else {
          const result = await this.startSessionInternal(
            request.projectPath,
            request.projectId,
            request.message,
            request.sessionId,
            request.permissionMode,
            request.modelSettings,
          );
          process = result;
        }

        if (this.isShuttingDown) {
          await process.abort();
          this.unregisterProcess(process);
          request.resolve({
            status: "cancelled",
            reason: "Runtime shutting down",
          });
          continue;
        }

        // Emit queue removed event
        this.eventBus?.emit({
          type: "queue-request-removed",
          queueId: request.id,
          sessionId: request.sessionId,
          reason: "started",
          timestamp: new Date().toISOString(),
        });

        request.resolve({ status: "started", processId: process.id });
      } catch (error) {
        // On error, resolve with cancelled status
        request.resolve({
          status: "cancelled",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private scheduleProcessQueue(): void {
    if (this.isShuttingDown || this.queueProcessingPromise) return;
    const work = this.processQueue().finally(() => {
      if (this.queueProcessingPromise === work) {
        this.queueProcessingPromise = null;
      }
      if (
        !this.isShuttingDown &&
        !this.workerQueue.isEmpty &&
        !this.isAtCapacity()
      ) {
        this.scheduleProcessQueue();
      }
    });
    this.queueProcessingPromise = work;
  }

  /**
   * Internal session start that always starts immediately.
   * Used by queue processing.
   */
  private async startSessionInternal(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process> {
    const provider = this.resolveProvider(modelSettings);

    // Use provider if available (preferred)
    if (provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        resumeSessionId,
        permissionMode,
        modelSettings,
        provider,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      resumeSessionId,
      permissionMode,
    );
  }

  // ============ Public Queue Methods ============

  /**
   * Stop accepting work, cancel queued requests, and terminate all processes.
   * Process completion can race with explicit aborts, so this is idempotent.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    clearInterval(this.staleCheckTimer);
    this.workerQueue.cancelAll();
    await this.queueProcessingPromise?.catch(() => {});

    while (this.processes.size > 0) {
      const processIds = [...this.processes.keys()];
      await Promise.all(
        processIds.map((processId) => this.abortProcess(processId)),
      );
    }
    this.emitWorkerActivity();
  }

  private assertAcceptingWork(): void {
    if (this.isShuttingDown) {
      throw new Error("Runtime is shutting down");
    }
  }

  /**
   * Cancel a queued request.
   * @returns true if cancelled, false if not found
   */
  cancelQueuedRequest(queueId: string): boolean {
    return this.workerQueue.cancel(queueId);
  }

  /**
   * Get info about all queued requests.
   */
  getQueueInfo(): QueuedRequestInfo[] {
    return this.workerQueue.getQueueInfo();
  }

  /**
   * Get position for a specific queue entry.
   */
  getQueuePosition(queueId: string): number | undefined {
    return this.workerQueue.getPosition(queueId);
  }

  /**
   * Get current worker count and capacity info.
   */
  getWorkerPoolStatus(): {
    activeWorkers: number;
    maxWorkers: number;
    queueLength: number;
  } {
    return {
      activeWorkers: this.processes.size,
      maxWorkers: this.maxWorkers,
      queueLength: this.workerQueue.length,
    };
  }

  /**
   * Get worker activity status for safe restart indicator.
   * Returns whether any workers are actively processing or waiting for input.
   */
  getWorkerActivity(): {
    activeWorkers: number;
    queueLength: number;
    hasActiveWork: boolean;
  } {
    const hasActiveWork =
      this.workerQueue.length > 0 ||
      Array.from(this.processes.values()).some(
        (p) =>
          p.state.type === "in-turn" ||
          p.state.type === "waiting-input" ||
          p.state.type === "hold",
      );
    return {
      activeWorkers: this.processes.size,
      queueLength: this.workerQueue.length,
      hasActiveWork,
    };
  }
}

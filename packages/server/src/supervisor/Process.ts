import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_PERMISSION_MODE } from "@yep-anywhere/shared";
import type {
  ContextStatusSdkPayload,
  EffortLevel,
  ModelInfo,
  PermissionRules,
  ProviderName,
  SlashCommand,
  ThinkingConfig,
  UrlProjectId,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { MessageQueue } from "../sdk/messageQueue.js";
import type {
  PermissionMode,
  SDKMessage,
  TimestampedSDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../sdk/types.js";
import { validateQuestionAnswers } from "../sessions/question-answers.js";
import type {
  AgentActivity,
  InputRequest,
  ProcessEvent,
  ProcessInfo,
  ProcessOptions,
  ProcessState,
} from "./types.js";
import { DEFAULT_IDLE_TIMEOUT_MS } from "./types.js";

type Listener = (event: ProcessEvent) => void;

/**
 * IMPORTANT: Never filter out messages by type before emitting to SSE!
 *
 * Tool results are user-type messages containing tool_result content blocks.
 * If you filter out user messages, tool calls will appear stuck in "pending"
 * state until the page is refreshed (when JSONL is fetched from disk).
 *
 * The client-side mergeMessages handles deduplication by UUID, so duplicate
 * emissions are safe and expected (queueMessage emits user messages, and
 * the iterator also yields them).
 *
 * @returns true - always emit the message
 */
export function shouldEmitMessage(_message: SDKMessage): boolean {
  // Always emit. DO NOT add filtering here!
  // See docstring above for why this is critical.
  return true;
}

/**
 * Pending tool approval request.
 * The SDK's canUseTool callback creates this and waits for respondToInput.
 */
interface PendingToolApproval {
  request: InputRequest;
  resolve: (result: ToolApprovalResult) => void;
}

interface SessionIdWaiter {
  resolve: (id: string) => void;
  reject: (error: Error) => void;
  strict: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}

export interface ProcessConstructorOptions extends ProcessOptions {
  /** Correlates the request, provider transport, and first-output logs. */
  startupId?: string;
  /** Wall-clock start of the provider request, before preflight work. */
  startupStartedAtMs?: number;
  /** MessageQueue for real SDK, undefined for mock SDK */
  queue?: MessageQueue;
  /** Abort function from real SDK */
  abortFn?: () => void;
  /** Check if underlying CLI process is still alive (for stale detection) */
  isProcessAlive?: () => boolean;
  /** Function to change max thinking tokens at runtime (SDK 0.2.7+) */
  setMaxThinkingTokensFn?: (tokens: number | null) => Promise<void>;
  /** Function to interrupt current turn gracefully (SDK 0.2.7+) */
  interruptFn?: () => Promise<void>;
  /**
   * Function to steer an active turn with additional user input.
   * Returns false when steering is unavailable and caller should enqueue.
   */
  steerFn?: (message: UserMessage) => Promise<boolean>;
  /** Function to get supported models (SDK 0.2.7+) */
  supportedModelsFn?: () => Promise<ModelInfo[]>;
  /** Function to get supported slash commands (SDK 0.2.7+) */
  supportedCommandsFn?: () => Promise<SlashCommand[]>;
  /** Function to change model mid-session (SDK 0.2.7+) */
  setModelFn?: (model?: string) => Promise<void>;
  /** Function to change the provider-native permission/session mode */
  setPermissionModeFn?: (mode: PermissionMode) => Promise<void>;
  /**
   * Function returning a structured breakdown of current context-window usage
   * (system prompt, tools, skills, MCP servers, memory files...). SDK 0.2.7+.
   */
  getContextUsageFn?: () => Promise<ContextStatusSdkPayload | null>;
  /**
   * Function returning the SDK initialization result. Used by Process to
   * learn the resolved model's true context window on startup. SDK 0.2.7+.
   */
  initializationResultFn?: () => Promise<{
    models: Array<{ id: string; contextWindow?: number }>;
  } | null>;
}

export class Process {
  readonly id: string;
  readonly startupId: string | undefined;
  private _sessionId: string;
  readonly projectPath: string;
  readonly projectId: UrlProjectId;
  readonly startedAt: Date;
  readonly provider: ProviderName;
  readonly model: string | undefined;
  /** Exact provider reasoning effort requested when the process started. */
  readonly requestedReasoningEffort: string | undefined;
  /** SSH host for remote execution (undefined = local) */
  readonly executor: string | undefined;
  private readonly startupStartedAtMs: number;
  private firstProviderMessageLogged = false;
  private firstProviderOutputLogged = false;

  private legacyQueue: UserMessage[] = [];
  private messageQueue: MessageQueue | null;
  private abortFn: (() => void) | null;
  private _state: ProcessState = { type: "in-turn" };
  private listeners: Set<Listener> = new Set();
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private iteratorDone = false;

  /** Set synchronously when transport/spawn fails to prevent race with queueMessage */
  private transportFailed = false;

  /**
   * Two-bucket message buffer for SSE replay to late-joining clients.
   * Buckets swap every 15 seconds, giving 15-30s of history.
   * This bounds memory while covering the JSONL persistence gap.
   */
  private currentBucket: SDKMessage[] = [];
  private previousBucket: SDKMessage[] = [];
  private bucketSwapTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BUCKET_SWAP_INTERVAL_MS = 15_000;

  /** Accumulated streaming text for catch-up when clients connect mid-stream */
  private _streamingText = "";
  /** Message ID for current streaming response */
  private _streamingMessageId: string | null = null;

  /** Pending tool approval requests (from canUseTool callback) - supports concurrent approvals */
  private pendingToolApprovals: Map<string, PendingToolApproval> = new Map();
  /** Order of pending approval request IDs for FIFO processing */
  private pendingToolApprovalQueue: string[] = [];

  /** Current permission mode for tool approvals */
  private _permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE;

  /** Permission rules for tool filtering (deny/allow patterns from API caller) */
  private _permissions: PermissionRules | undefined;

  /** Version counter for permission mode changes (for multi-tab sync) */
  private _modeVersion = 0;

  /** Thinking configuration (undefined = thinking disabled) */
  private _thinking: ThinkingConfig | undefined;
  /** Effort level for response quality */
  private _effort: EffortLevel | undefined;

  /** Function to change max thinking tokens at runtime (SDK 0.2.7+) */
  private setMaxThinkingTokensFn:
    | ((tokens: number | null) => Promise<void>)
    | null;

  /** Function to interrupt current turn gracefully (SDK 0.2.7+) */
  private interruptFn: (() => Promise<void>) | null;
  /** Function to steer an active turn (provider-specific, currently Codex app-server) */
  private steerFn: ((message: UserMessage) => Promise<boolean>) | null;

  /** Function to get supported models (SDK 0.2.7+) */
  private supportedModelsFn: (() => Promise<ModelInfo[]>) | null;

  /** Function to get supported slash commands (SDK 0.2.7+) */
  private supportedCommandsFn: (() => Promise<SlashCommand[]>) | null;

  /** Function to change model mid-session (SDK 0.2.7+) */
  private setModelFn: ((model?: string) => Promise<void>) | null;

  /** Function to change the provider-native permission/session mode */
  private setPermissionModeFn: ((mode: PermissionMode) => Promise<void>) | null;

  /** Function returning structured live context-window breakdown (SDK 0.2.7+) */
  private getContextUsageFn:
    | (() => Promise<ContextStatusSdkPayload | null>)
    | null;

  /** Function returning SDK initialization result (SDK 0.2.7+) */
  private initializationResultFn:
    | (() => Promise<{
        models: Array<{ id: string; contextWindow?: number }>;
      } | null>)
    | null;

  /** Set after the first time we successfully probe initializationResult() */
  private _initializationResultProbed = false;

  /** Waiters for the real session ID emitted by the provider init message. */
  private sessionIdWaiters: SessionIdWaiter[] = [];
  private sessionIdResolved = false;
  private sessionIdInitializationError: Error | null = null;

  /** Timestamp of last SDK message received (for staleness detection) */
  private _lastMessageTime: Date;

  /** Check if underlying CLI process is still alive (undefined = not available, fall back to time heuristic) */
  private _isProcessAlive: (() => boolean) | null;

  /** OS PID of the spawned agent child process (supports deferred resolution) */
  private _pidResolver: number | (() => number | undefined) | undefined;

  /** Resolved model name from the first assistant message (e.g., "claude-sonnet-4-5-20250929") */
  private _resolvedModel: string | undefined;
  /** Provider-specific resolved reasoning effort from init/session metadata. */
  private _resolvedReasoningEffort: string | undefined;
  /** Provider-specific service tier / speed label from init/session metadata. */
  private _serviceTier: string | undefined;
  /** Context window size reported by SDK in result messages' modelUsage */
  private _contextWindow: number | undefined;

  /** Deferred message queue — messages queued while agent is in-turn, auto-sent when turn ends */
  private deferredQueue: { message: UserMessage; timestamp: string }[] = [];

  /** Whether the process is held (soft pause) */
  private _isHeld = false;
  /** When hold mode was activated */
  private _holdSince: Date | null = null;
  /** Resolver to wake up the iterator loop when resumed */
  private _holdResolve: (() => void) | null = null;

  /** Promise that resolves when the process fully terminates (CLI exits) */
  private _exitPromise: Promise<void>;
  private _exitResolve: (() => void) | null = null;

  constructor(
    private sdkIterator: AsyncIterator<SDKMessage>,
    options: ProcessConstructorOptions,
  ) {
    this.id = randomUUID();
    this.startupId = options.startupId;
    this._sessionId = options.sessionId;
    this.projectPath = options.projectPath;
    this.projectId = options.projectId;
    this.startedAt = new Date();
    this.startupStartedAtMs =
      options.startupStartedAtMs ?? this.startedAt.getTime();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    // Real SDK provides these, mock SDK doesn't
    this.messageQueue = options.queue ?? null;
    this.abortFn = options.abortFn ?? null;
    this._permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this._permissions = options.permissions;
    this.provider = options.provider;
    this.model = options.model;
    this.requestedReasoningEffort = options.reasoningEffort;
    this.executor = options.executor;
    this._thinking = options.thinking;
    this._effort = options.effort;
    this.setMaxThinkingTokensFn = options.setMaxThinkingTokensFn ?? null;
    this.interruptFn = options.interruptFn ?? null;
    this.steerFn = options.steerFn ?? null;
    this.supportedModelsFn = options.supportedModelsFn ?? null;
    this.supportedCommandsFn = options.supportedCommandsFn ?? null;
    this._pidResolver = options.pid;
    this.setModelFn = options.setModelFn ?? null;
    this.setPermissionModeFn = options.setPermissionModeFn ?? null;
    this.getContextUsageFn = options.getContextUsageFn ?? null;
    this.initializationResultFn = options.initializationResultFn ?? null;
    this._isProcessAlive = options.isProcessAlive ?? null;
    this._lastMessageTime = new Date();

    // Exit promise resolves when the CLI process fully terminates
    this._exitPromise = new Promise((resolve) => {
      this._exitResolve = resolve;
    });

    // Start bucket swap timer for bounded message history
    this.startBucketSwapTimer();

    // Start processing messages from the SDK
    this.processMessages();
  }

  /**
   * Start the timer that swaps message buckets.
   * This bounds memory by discarding messages older than ~30 seconds.
   */
  private startBucketSwapTimer(): void {
    this.bucketSwapTimer = setInterval(() => {
      this.previousBucket = this.currentBucket;
      this.currentBucket = [];
    }, Process.BUCKET_SWAP_INTERVAL_MS);
  }

  /**
   * Stop the bucket swap timer.
   */
  private stopBucketSwapTimer(): void {
    if (this.bucketSwapTimer) {
      clearInterval(this.bucketSwapTimer);
      this.bucketSwapTimer = null;
    }
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * The actual model used by the API, extracted from the first assistant message.
   * Falls back to the requested model if no assistant message has been received yet.
   */
  get resolvedModel(): string | undefined {
    return this._resolvedModel ?? this.model;
  }

  get resolvedReasoningEffort(): string | undefined {
    return (
      this._resolvedReasoningEffort ??
      this.requestedReasoningEffort ??
      this._effort
    );
  }

  get serviceTier(): string | undefined {
    return this._serviceTier;
  }

  /** Context window size reported by SDK (from result message modelUsage) */
  get contextWindow(): number | undefined {
    return this._contextWindow;
  }

  get state(): ProcessState {
    return this._state;
  }

  /** When the last SDK message was received (for staleness detection) */
  get lastMessageTime(): Date {
    return this._lastMessageTime;
  }

  /**
   * Check if the underlying CLI process is still alive.
   * Returns true if alive, false if dead, undefined if liveness check is unavailable.
   */
  get isProcessAlive(): boolean | undefined {
    return this._isProcessAlive?.();
  }

  /** OS PID of the spawned agent child process */
  get pid(): number | undefined {
    if (typeof this._pidResolver === "function") {
      return this._pidResolver();
    }
    return this._pidResolver;
  }

  get queueDepth(): number {
    if (this.messageQueue) {
      return this.messageQueue.depth;
    }
    return this.legacyQueue.length;
  }

  get permissionMode(): PermissionMode {
    return this._permissionMode;
  }

  get modeVersion(): number {
    return this._modeVersion;
  }

  /**
   * Thinking configuration for this process.
   * undefined means thinking is disabled.
   */
  get thinking(): ThinkingConfig | undefined {
    return this._thinking;
  }

  /**
   * Effort level for this process.
   */
  get effort(): EffortLevel | undefined {
    return this._effort;
  }

  /**
   * Update thinking config and effort after a dynamic change.
   */
  updateThinkingConfig(thinking?: ThinkingConfig, effort?: EffortLevel): void {
    this._thinking = thinking;
    this._effort = effort;
  }

  /**
   * Whether this process supports dynamic thinking mode changes.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsThinkingModeChange(): boolean {
    return this.setMaxThinkingTokensFn !== null;
  }

  /**
   * Whether this process supports graceful interrupt.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsInterrupt(): boolean {
    return this.interruptFn !== null;
  }

  /**
   * Interrupt the current turn gracefully without killing the process.
   * The query will stop processing the current turn and return control.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns true if the interrupt was triggered, false if not supported
   */
  async interrupt(): Promise<boolean> {
    if (!this.interruptFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "process_interrupt",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        currentState: this._state.type,
      },
      `Interrupting process: ${this._sessionId}`,
    );

    await this.interruptFn();
    return true;
  }

  /**
   * Change thinking mode at runtime via the deprecated setMaxThinkingTokens API.
   * On Opus 4.6, 0 = disabled, any non-zero = adaptive.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @param tokens - Non-zero to enable adaptive thinking, undefined/0 to disable
   * @returns true if the change was applied, false if not supported
   */
  async setMaxThinkingTokens(tokens: number | undefined): Promise<boolean> {
    if (!this.setMaxThinkingTokensFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "thinking_mode_change",
        sessionId: this._sessionId,
        processId: this.id,
        oldThinking: this._thinking?.type,
        newThinking: tokens ? "adaptive" : "disabled",
      },
      `Changing thinking mode: ${this._thinking?.type ?? "disabled"} → ${tokens ? "adaptive" : "disabled"}`,
    );

    // SDK uses null to disable, we use undefined for consistency with our types
    await this.setMaxThinkingTokensFn(tokens ?? null);
    return true;
  }

  /**
   * Whether this process supports dynamic model listing.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsDynamicModels(): boolean {
    return this.supportedModelsFn !== null;
  }

  /**
   * Whether this process supports dynamic command listing.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsDynamicCommands(): boolean {
    return this.supportedCommandsFn !== null;
  }

  /**
   * Whether this process supports model switching mid-session.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsSetModel(): boolean {
    return this.setModelFn !== null;
  }

  /**
   * Get the list of available models from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns Array of available models, or null if not supported
   */
  async supportedModels(): Promise<ModelInfo[] | null> {
    if (!this.supportedModelsFn) {
      return null;
    }
    return this.supportedModelsFn();
  }

  /**
   * Get the list of available slash commands from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns Array of available commands, or null if not supported
   */
  async supportedCommands(): Promise<SlashCommand[] | null> {
    if (!this.supportedCommandsFn) {
      return null;
    }
    return this.supportedCommandsFn();
  }

  /**
   * Change the model mid-session without restarting.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @param model - New model to use, or undefined to use default
   * @returns true if the change was applied, false if not supported
   */
  async setModel(model?: string): Promise<boolean> {
    if (!this.setModelFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "model_change",
        sessionId: this._sessionId,
        processId: this.id,
        oldModel: this.model,
        newModel: model,
      },
      `Changing model: ${this.model} → ${model}`,
    );

    await this.setModelFn(model);
    // Update resolved model so subsequent API responses reflect the switch
    if (model) {
      this._resolvedModel = model;
    }
    return true;
  }

  /**
   * Live, structured context-window breakdown from the SDK
   * (Query.getContextUsage()). Returns null if the provider does not
   * support it (e.g. codex / gemini) or the call fails.
   */
  async getContextUsage(): Promise<ContextStatusSdkPayload | null> {
    if (!this.getContextUsageFn) return null;
    return this.getContextUsageFn();
  }

  /**
   * SDK initialization result — used to learn the resolved model's true
   * context window on startup, before any result message arrives.
   * Returns null when unsupported.
   */
  async initializationResult(): Promise<{
    models: Array<{ id: string; contextWindow?: number }>;
  } | null> {
    if (!this.initializationResultFn) return null;
    return this.initializationResultFn();
  }

  /** Mark that we've already probed initializationResult once. */
  get initializationResultProbed(): boolean {
    return this._initializationResultProbed;
  }
  markInitializationResultProbed(): void {
    this._initializationResultProbed = true;
  }

  /**
   * Whether the process has been terminated (either manually or due to error).
   * A terminated process cannot accept new messages.
   */
  get isTerminated(): boolean {
    return this._state.type === "terminated";
  }

  /**
   * Get the termination reason if the process was terminated.
   */
  get terminationReason(): string | null {
    if (this._state.type === "terminated") {
      return this._state.reason;
    }
    return null;
  }

  /**
   * Whether the process is currently held (soft pause).
   */
  get isHeld(): boolean {
    return this._isHeld;
  }

  /**
   * When the hold started, if currently held.
   */
  get holdSince(): Date | null {
    return this._holdSince;
  }

  /**
   * Set hold mode (soft pause) for this process.
   * When held, the iterator loop will pause before calling next().
   * When resumed, it continues from where it left off.
   */
  setHold(enabled: boolean): void {
    if (enabled === this._isHeld) {
      return; // No change
    }

    const log = getLogger();
    this._isHeld = enabled;

    if (enabled) {
      // Entering hold mode
      this._holdSince = new Date();
      this.clearIdleTimer(); // Don't auto-complete while held
      this.setState({ type: "hold", since: this._holdSince });
      log.info(
        {
          event: "process_hold_enabled",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
        },
        `Process held: ${this._sessionId}`,
      );
    } else {
      // Resuming from hold
      log.info(
        {
          event: "process_hold_disabled",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          holdDurationMs: this._holdSince
            ? Date.now() - this._holdSince.getTime()
            : 0,
        },
        `Process resumed: ${this._sessionId}`,
      );
      this._holdSince = null;

      // Wake up the iterator loop
      if (this._holdResolve) {
        this._holdResolve();
        this._holdResolve = null;
      }

      // Transition back to running (or idle if iterator is done)
      if (this.iteratorDone) {
        this.transitionToIdle();
      } else {
        this.setState({ type: "in-turn" });
      }
    }
  }

  /**
   * Wait until hold mode is disabled.
   * Called by processMessages() when held.
   */
  private waitUntilResumed(): Promise<void> {
    return new Promise((resolve) => {
      this._holdResolve = resolve;
    });
  }

  /**
   * Update the permission mode for this process.
   * Increments modeVersion and emits a mode-change event for multi-tab sync.
   */
  setPermissionMode(mode: PermissionMode): void {
    this._permissionMode = mode;
    this._modeVersion++;
    this.emit({ type: "mode-change", mode, version: this._modeVersion });
  }

  /**
   * Apply a mode to the provider first, then publish the confirmed local state.
   * Providers without a native mode API keep the existing Yep-only behavior.
   */
  async syncPermissionMode(mode: PermissionMode): Promise<void> {
    await this.setPermissionModeFn?.(mode);
    this.setPermissionMode(mode);
  }

  /**
   * Mark the process as terminated due to an error or external termination.
   * Emits a terminated event and cleans up resources.
   */
  private markTerminated(reason: string, error?: Error): void {
    if (this._state.type === "terminated") {
      return; // Already terminated
    }

    const log = getLogger();
    const durationMs = Date.now() - this.startedAt.getTime();
    const pendingApprovalCount = this.pendingToolApprovals.size;

    log.warn(
      {
        event: "process_terminated",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        reason,
        errorMessage: error?.message,
        errorStack: error?.stack,
        durationMs,
        pendingApprovalCount,
        previousState: this._state.type,
      },
      `Process terminated: ${this._sessionId} - ${reason}`,
    );

    this.clearIdleTimer();
    this.stopBucketSwapTimer();
    this.iteratorDone = true;

    // Wake up hold wait if held (so processMessages loop can exit)
    if (this._holdResolve) {
      this._holdResolve();
      this._holdResolve = null;
    }
    this._isHeld = false;

    // Resolve all pending tool approvals with denial
    for (const pending of this.pendingToolApprovals.values()) {
      pending.resolve({
        behavior: "deny",
        message: `Process terminated: ${reason}`,
        interrupt: true,
      });
    }
    this.pendingToolApprovals.clear();
    this.pendingToolApprovalQueue = [];

    this.setState({ type: "terminated", reason, error });
    this.emit({ type: "terminated", reason, error });
    this.emit({ type: "complete" });

    // Resolve exit promise so abort() callers can wait for full termination
    if (this._exitResolve) {
      this._exitResolve();
      this._exitResolve = null;
    }
  }

  /**
   * Wait for the real session ID from the SDK's init message.
   * Returns immediately if already received, or waits with a timeout.
   */
  waitForSessionId(
    timeoutMs = 5000,
    options?: { strict?: boolean },
  ): Promise<string> {
    if (this.sessionIdResolved) {
      return Promise.resolve(this._sessionId);
    }

    const strict = options?.strict === true;
    const existingError = strict
      ? (this.sessionIdInitializationError ??
        this.getProviderInitializationError())
      : null;
    if (existingError) return Promise.reject(existingError);

    return new Promise((resolve, reject) => {
      const waiter: SessionIdWaiter = {
        resolve,
        reject,
        strict,
        timeout: null,
      };
      this.sessionIdWaiters.push(waiter);

      const boundedTimeoutMs = Number.isFinite(timeoutMs)
        ? Math.max(0, timeoutMs)
        : 5000;
      waiter.timeout = setTimeout(() => {
        const index = this.sessionIdWaiters.indexOf(waiter);
        if (index >= 0) {
          this.sessionIdWaiters.splice(index, 1);
          waiter.timeout = null;
          if (strict) {
            reject(
              new Error(
                `Provider initialization timed out after ${boundedTimeoutMs}ms before returning a session ID`,
              ),
            );
          } else {
            // Backwards-compatible fallback for providers that can report
            // their durable ID after the initial request has returned.
            resolve(this._sessionId);
          }
        }
      }, boundedTimeoutMs);
    });
  }

  private getProviderInitializationError(): Error | null {
    const history = this.getMessageHistory();
    let providerError: SDKMessage | undefined;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message?.type === "error") {
        providerError = message;
        break;
      }
    }
    if (!providerError) return null;
    const detail =
      typeof providerError.error === "string"
        ? providerError.error
        : "Provider failed before returning a session ID";
    return new Error(detail);
  }

  private rejectSessionIdWaiters(error: Error): void {
    this.sessionIdInitializationError ??= error;
    const remaining: SessionIdWaiter[] = [];
    for (const waiter of this.sessionIdWaiters) {
      if (waiter.strict) {
        if (waiter.timeout) clearTimeout(waiter.timeout);
        waiter.timeout = null;
        waiter.reject(error);
      } else {
        remaining.push(waiter);
      }
    }
    this.sessionIdWaiters = remaining;
  }

  getInfo(): ProcessInfo {
    let activity: AgentActivity;
    if (this._state.type === "terminated") {
      activity = "terminated";
    } else if (this._state.type === "waiting-input") {
      activity = "waiting-input";
    } else if (this._state.type === "idle") {
      activity = "idle";
    } else if (this._state.type === "hold") {
      activity = "hold";
    } else {
      activity = "in-turn";
    }

    const info: ProcessInfo = {
      id: this.id,
      sessionId: this._sessionId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      projectName: path.basename(this.projectPath),
      sessionTitle: null, // Will be populated by Supervisor with session data
      state: activity,
      startedAt: this.startedAt.toISOString(),
      queueDepth: this.queueDepth,
      provider: this.provider,
      model: this._resolvedModel ?? this.model,
      reasoningEffort: this.resolvedReasoningEffort,
      requestedReasoningEffort: this.requestedReasoningEffort,
      serviceTier: this._serviceTier,
      thinking: this._thinking,
      effort: this._effort,
      executor: this.executor,
      pid: this.pid,
    };

    // Add idleSince if idle
    if (this._state.type === "idle") {
      info.idleSince = this._state.since.toISOString();
    }

    // Add holdSince if held
    if (this._state.type === "hold") {
      info.holdSince = this._state.since.toISOString();
    }

    return info;
  }

  /**
   * Get recent message history (15-30 seconds) for SSE replay.
   * Returns messages from both buckets for late-joining clients.
   */
  getMessageHistory(): SDKMessage[] {
    return [...this.previousBucket, ...this.currentBucket];
  }

  /**
   * Get accumulated streaming text for catch-up when clients connect mid-stream.
   * Returns the message ID and accumulated text, or null if not streaming.
   */
  getStreamingContent(): { messageId: string; text: string } | null {
    if (!this._streamingMessageId || !this._streamingText) {
      return null;
    }
    return {
      messageId: this._streamingMessageId,
      text: this._streamingText,
    };
  }

  /**
   * Accumulate streaming text from a delta.
   * Called by stream routes when processing stream_event messages.
   */
  accumulateStreamingText(messageId: string, text: string): void {
    if (this._streamingMessageId !== messageId) {
      // New streaming message, reset accumulator
      this._streamingMessageId = messageId;
      this._streamingText = text;
    } else {
      this._streamingText += text;
    }
  }

  /**
   * Clear streaming text accumulator (called when stream ends).
   */
  clearStreamingText(): void {
    this._streamingText = "";
    this._streamingMessageId = null;
  }

  /**
   * Ensure every emitted/replayed message has a timestamp.
   * Some providers (notably Codex stream messages) omit this field.
   */
  private withTimestamp<T extends SDKMessage>(
    message: T,
  ): TimestampedSDKMessage<T> {
    if (
      typeof message.timestamp === "string" &&
      message.timestamp.trim().length > 0
    ) {
      return message as TimestampedSDKMessage<T>;
    }
    return {
      ...message,
      timestamp: new Date().toISOString(),
    } as TimestampedSDKMessage<T>;
  }

  /**
   * Add initial user message to history without queuing to SDK.
   * Used for real SDK sessions where the initial message is passed directly
   * to the SDK but needs to be in history for SSE replay to late-joining clients.
   *
   * @param text - The message text
   * @param uuid - The UUID to use (should match what was passed to SDK)
   * @param tempId - Optional client temp ID for optimistic UI tracking
   */
  addInitialUserMessage(text: string, uuid: string, tempId?: string): void {
    const sdkMessage = this.withTimestamp({
      type: "user",
      uuid,
      tempId,
      message: { role: "user", content: text },
    } as SDKMessage);

    this.currentBucket.push(sdkMessage);
    this.emit({ type: "message", message: sdkMessage });
  }

  /**
   * Format file size for display.
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  /**
   * Build user message content that matches what MessageQueue sends to the SDK.
   * This ensures SSE/history messages can be deduplicated against JSONL.
   */
  private buildUserMessageContent(message: UserMessage): string {
    let text = message.text;

    // Append attachment paths (same format as MessageQueue.toSDKMessage)
    if (message.attachments?.length) {
      const lines = message.attachments.map(
        (f) =>
          `- ${f.originalName} (${this.formatSize(f.size)}, ${f.mimeType}): ${f.path}`,
      );
      text += `\n\nUser uploaded files:\n${lines.join("\n")}`;
    }

    return text;
  }

  /**
   * Queue a message to be sent to the SDK.
   * For real SDK, pushes to MessageQueue.
   * For mock SDK, uses legacy queue behavior.
   *
   * @returns Object with success status and queue position or error
   */
  queueMessage(message: UserMessage): {
    success: boolean;
    position?: number;
    error?: string;
  } {
    // Check if process is terminated or transport failed
    if (this._state.type === "terminated") {
      return {
        success: false,
        error: `Process terminated: ${this._state.reason}`,
      };
    }

    // Check if transport failed (spawn error, etc.) - this flag is set synchronously
    // to prevent race conditions where queueMessage is called before markTerminated completes
    if (this.transportFailed) {
      return {
        success: false,
        error: "Process transport failed",
      };
    }

    // Create user message with UUID - this UUID will be used by both SSE and SDK
    const uuid = randomUUID();
    const messageWithUuid: UserMessage = { ...message, uuid };

    // Build content that matches what the SDK will write to JSONL.
    // This ensures SSE/history messages can be deduplicated against JSONL.
    const content = this.buildUserMessageContent(message);

    const sdkMessage = this.withTimestamp({
      type: "user",
      uuid,
      tempId: message.tempId,
      message: { role: "user", content },
    } as SDKMessage);

    // Add to history for SSE replay to late-joining clients.
    // The client-side deduplication (mergeSSEMessage, mergeJSONLMessages) handles
    // any duplicates when JSONL is later fetched. This is especially important
    // for the two-phase flow (createSession + queueMessage) where the client
    // may connect before the JSONL is written.
    if (shouldEmitMessage(sdkMessage)) {
      // Check for duplicates in both buckets before adding
      // This prevents duplicates if the provider echoes the message back with the same UUID
      const isDuplicate =
        this.currentBucket.some((m) => m.uuid && m.uuid === sdkMessage.uuid) ||
        this.previousBucket.some((m) => m.uuid && m.uuid === sdkMessage.uuid);
      if (!isDuplicate) {
        this.currentBucket.push(sdkMessage);
      }
    }

    // Emit to current SSE subscribers so other clients see it immediately
    // Include the session ID so client can associate it correctly
    // The provider will echo this message back, but if we ensure UUIDs match,
    // the client will merge them.
    if (shouldEmitMessage(sdkMessage)) {
      this.emit({
        type: "message",
        message: { ...sdkMessage, session_id: this._sessionId },
      });
    }

    if (this.messageQueue) {
      // If provider supports in-turn steering, prefer that over queue-after-turn behavior.
      if (this._state.type === "in-turn" && this.steerFn) {
        const steerMessage: UserMessage = {
          ...messageWithUuid,
          // Mirror MessageQueue's attachment expansion for steer payloads.
          text: content,
          attachments: undefined,
        };
        void this.steerFn(steerMessage)
          .then((steered) => {
            if (!steered) {
              this.messageQueue?.push(messageWithUuid);
            }
          })
          .catch((error) => {
            const log = getLogger();
            log.warn(
              {
                event: "process_steer_failed",
                sessionId: this._sessionId,
                processId: this.id,
                provider: this.provider,
                error: error instanceof Error ? error.message : String(error),
              },
              "Steer failed; falling back to queued message",
            );
            this.messageQueue?.push(messageWithUuid);
          });
        return { success: true, position: 0 };
      }

      // Transition to running if we were idle
      if (this._state.type === "idle") {
        this.clearIdleTimer();
        this.setState({ type: "in-turn" });
      }
      // Pass message with UUID so SDK uses the same UUID we emitted via SSE
      const position = this.messageQueue.push(messageWithUuid);
      return { success: true, position };
    }

    // Legacy behavior for mock SDK
    this.legacyQueue.push(message);
    if (this._state.type === "idle") {
      this.processNextInQueue();
    }
    return { success: true, position: this.legacyQueue.length };
  }

  /**
   * Add a message to the deferred queue.
   * Deferred messages are held server-side and auto-sent when the agent's current turn ends.
   */
  deferMessage(message: UserMessage): { success: true } {
    this.deferredQueue.push({
      message,
      timestamp: new Date().toISOString(),
    });
    this.emitDeferredQueueChange();
    return { success: true };
  }

  /**
   * Cancel a deferred message by its tempId.
   */
  cancelDeferredMessage(tempId: string): boolean {
    const index = this.deferredQueue.findIndex(
      (entry) => entry.message.tempId === tempId,
    );
    if (index === -1) return false;
    this.deferredQueue.splice(index, 1);
    this.emitDeferredQueueChange();
    return true;
  }

  /**
   * Get a summary of the deferred queue for SSE events and client sync.
   */
  getDeferredQueueSummary(): {
    tempId?: string;
    content: string;
    timestamp: string;
  }[] {
    return this.deferredQueue.map((entry) => ({
      tempId: entry.message.tempId,
      content: entry.message.text,
      timestamp: entry.timestamp,
    }));
  }

  /**
   * Emit a deferred-queue event with the current queue state.
   */
  private emitDeferredQueueChange(): void {
    this.emit({
      type: "deferred-queue",
      messages: this.getDeferredQueueSummary(),
    });
  }

  /**
   * Convert a simple glob pattern (with * wildcards) to a RegExp.
   * Only supports * as wildcard (matches any characters).
   */
  private static globToRegex(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`);
  }

  /**
   * Check if a tool invocation matches a permission pattern like "Bash(curl *)".
   * Returns true if the pattern matches the tool name and input.
   */
  private static matchesPermissionPattern(
    pattern: string,
    toolName: string,
    input: unknown,
  ): boolean {
    // Parse "ToolName(glob)" pattern
    const match = pattern.match(/^(\w+)\((.+)\)$/);
    if (!match) return false;
    const patternTool = match[1];
    const glob = match[2];
    if (!patternTool || !glob || patternTool !== toolName) return false;

    // Extract the string to match against from the tool input
    let commandStr = "";
    if (toolName === "Bash") {
      commandStr = (input as { command?: string })?.command ?? "";
    } else {
      // For non-Bash tools, match against JSON-stringified input
      commandStr = typeof input === "string" ? input : JSON.stringify(input);
    }

    return Process.globToRegex(glob).test(commandStr);
  }

  /**
   * Check permission rules (deny/allow patterns) against a tool invocation.
   * Returns a ToolApprovalResult if a rule matches, or undefined to fall through.
   * Evaluation order: deny first, then allow.
   */
  private checkPermissionRules(
    toolName: string,
    input: unknown,
  ): ToolApprovalResult | undefined {
    if (!this._permissions) return undefined;

    // Check deny rules first
    if (this._permissions.deny) {
      for (const pattern of this._permissions.deny) {
        if (Process.matchesPermissionPattern(pattern, toolName, input)) {
          const command =
            toolName === "Bash"
              ? ((input as { command?: string })?.command ?? "")
              : "";
          getLogger().warn(
            `[permissions] Denied ${toolName}: "${command}" matched deny pattern "${pattern}"`,
          );
          return {
            behavior: "deny",
            message: `Blocked by permission rule: ${pattern}`,
          };
        }
      }
    }

    // Check allow rules
    if (this._permissions.allow) {
      for (const pattern of this._permissions.allow) {
        if (Process.matchesPermissionPattern(pattern, toolName, input)) {
          return { behavior: "allow" };
        }
      }
    }

    return undefined;
  }

  /**
   * Handle tool approval request from SDK's canUseTool callback.
   * This is called by the Supervisor when creating the session.
   * Behavior depends on current permission mode:
   * - default: Ask user for approval
   * - acceptEdits: Auto-approve Edit/Write tools, ask for others
   * - plan: Auto-approve read-only tools (Read, Glob, Grep, etc.), prompt for others
   * - bypassPermissions: Auto-approve all tools except AskUserQuestion and ExitPlanMode
   */
  async handleToolApproval(
    toolName: string,
    input: unknown,
    options: {
      signal: AbortSignal;
      requestId?: string;
      respectProviderDecision?: boolean;
    },
  ): Promise<ToolApprovalResult> {
    console.log(
      `[handleToolApproval] toolName=${toolName}, permissionMode=${this._permissionMode}`,
    );

    // Check if aborted
    if (options.signal.aborted) {
      return {
        behavior: "deny",
        message: "Operation aborted",
        interrupt: true,
      };
    }

    // Check permission rules (deny/allow patterns) before mode-based logic
    const permissionResult = this.checkPermissionRules(toolName, input);
    if (permissionResult) {
      return permissionResult;
    }

    // Skip Yep's mode policy when the provider already applied its native
    // policy and explicitly decided this request still needs a human.
    const localPermissionMode = options.respectProviderDecision
      ? undefined
      : this._permissionMode;
    switch (localPermissionMode) {
      case undefined:
        break;
      case "bypassPermissions": {
        // Always prompt for user questions and plan approval, even in bypass mode
        // These are inherently interactive and shouldn't be auto-answered
        if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") {
          break; // Fall through to ask user
        }
        // Auto-approve all other tools
        return { behavior: "allow" };
      }

      case "plan": {
        // Read-only tools are auto-allowed - essential for creating good plans
        const readOnlyTools = [
          "Read",
          "Glob",
          "Grep",
          "LSP",
          "WebFetch",
          "WebSearch",
          "Task", // Subagent exploration (legacy)
          "Agent", // Subagent exploration (SDK 0.2.76+)
          "TaskOutput", // Reading subagent results
        ];
        if (readOnlyTools.includes(toolName)) {
          return { behavior: "allow" };
        }

        // Allow Write to .claude/plans/ directory for saving plans
        if (toolName === "Write") {
          const filePath = (input as { file_path?: string })?.file_path ?? "";
          if (filePath.includes(".claude/plans/")) {
            return { behavior: "allow" };
          }
        }

        // ExitPlanMode and AskUserQuestion should prompt the user
        // ExitPlanMode: user must approve the plan before exiting plan mode
        // AskUserQuestion: clarifying questions are valid during planning
        if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") {
          break; // Fall through to ask user for approval
        }

        // Other tools (Bash, Edit, Write to non-plan files, etc.) - prompt user
        // Agent typically won't use these in plan mode, but if they have a good
        // reason (e.g., checking git log, verifying dependencies), let them ask
        break; // Fall through to ask user for approval
      }

      case "acceptEdits": {
        // Auto-approve file editing tools AND read-only tools
        // acceptEdits should be strictly more permissive than default mode
        const editTools = ["Edit", "Write", "NotebookEdit"];
        if (editTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Read-only tools are also auto-allowed (same as default mode)
        const readOnlyTools = [
          "Read",
          "Glob",
          "Grep",
          "LSP",
          "WebFetch",
          "WebSearch",
          "Task", // Subagent exploration (legacy)
          "Agent", // Subagent exploration (SDK 0.2.76+)
          "TaskOutput", // Reading subagent results
        ];
        if (readOnlyTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Fall through to ask user for other tools (Bash, etc.)
        break;
      }

      default: {
        // Read-only tools are auto-allowed - no need to prompt for reads
        // "Ask before edits" means ask before WRITES, not reads
        const readOnlyTools = [
          "Read",
          "Glob",
          "Grep",
          "LSP",
          "WebFetch",
          "WebSearch",
          "Task", // Subagent exploration (legacy)
          "Agent", // Subagent exploration (SDK 0.2.76+)
          "TaskOutput", // Reading subagent results
        ];
        if (readOnlyTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Fall through to ask user for mutating tools
        break;
      }
    }

    // Default behavior: ask user for approval
    const isQuestion = toolName === "AskUserQuestion";
    const questionInput =
      isQuestion && input && typeof input === "object"
        ? (input as { questions?: Array<{ question?: unknown }> })
        : undefined;
    const firstQuestion = questionInput?.questions?.find(
      (question) => typeof question?.question === "string",
    )?.question;
    const request: InputRequest = {
      // Preserve a provider-native id when available. OpenCode's bridge sees
      // the same approval independently, so inventing a second UUID here can
      // make notification actions look stale even though both ids represent
      // the same request.
      id: options.requestId?.trim() || randomUUID(),
      sessionId: this._sessionId,
      type: isQuestion ? "question" : "tool-approval",
      prompt:
        typeof firstQuestion === "string" && firstQuestion.trim()
          ? firstQuestion
          : isQuestion
            ? "Question requires your answer"
            : `Allow ${toolName}?`,
      toolName,
      toolInput: input,
      timestamp: new Date().toISOString(),
    };

    // Add to the pending approvals map and queue
    // The first pending approval is shown to the user, others wait in queue
    const isFirstPending = this.pendingToolApprovals.size === 0;

    // Create a promise that will be resolved by respondToInput
    return new Promise<ToolApprovalResult>((resolve) => {
      this.pendingToolApprovals.set(request.id, { request, resolve });
      this.pendingToolApprovalQueue.push(request.id);

      // Handle abort signal
      const onAbort = () => {
        if (this.pendingToolApprovals.has(request.id)) {
          this.pendingToolApprovals.delete(request.id);
          this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
            (id) => id !== request.id,
          );
          // If this was the current request being shown, emit the next one
          if (isFirstPending) {
            this.emitNextPendingApproval();
          }
          resolve({
            behavior: "deny",
            message: "Operation aborted",
            interrupt: true,
          });
        }
      };

      options.signal.addEventListener("abort", onAbort, { once: true });

      // Only emit state change for the first pending approval
      // Subsequent approvals wait in queue until the first is resolved
      if (isFirstPending) {
        this.setState({ type: "waiting-input", request });
      }
    });
  }

  /**
   * Emit the next pending approval to the client, or transition to running if none left.
   */
  private emitNextPendingApproval(): void {
    const nextId = this.pendingToolApprovalQueue[0];
    if (nextId !== undefined) {
      const next = this.pendingToolApprovals.get(nextId);
      if (next) {
        this.setState({ type: "waiting-input", request: next.request });
        return;
      }
    }
    // No more pending approvals
    this.setState({ type: "in-turn" });
  }

  /**
   * Respond to a pending input request (tool approval).
   * Called from the API when user approves/denies a tool.
   * For AskUserQuestion, answers can be passed to update the tool input.
   * For deny with feedback, the feedback message is passed to the SDK.
   * Works for both real SDK (canUseTool callback) and mock SDK (input_request message).
   */
  respondToInput(
    requestId: string,
    response: "approve" | "approve_always" | "deny",
    answers?: UserQuestionAnswers,
    feedback?: string,
  ): boolean {
    const pending = this.pendingToolApprovals.get(requestId);

    // For mock SDK: check if requestId matches the state's request
    if (!pending) {
      if (
        this._state.type === "waiting-input" &&
        this._state.request.id === requestId
      ) {
        // Mock SDK case - just transition back to idle/running
        this.setState({ type: "in-turn" });
        return true;
      }
      return false;
    }

    const approved = response !== "deny";
    if (approved) {
      const validation = validateQuestionAnswers(pending.request, answers);
      if (!validation.valid) {
        getLogger().warn(
          {
            sessionId: this._sessionId,
            requestId,
            missingAnswerCount: validation.missingAnswerCount,
          },
          "Question approval rejected because required answers were missing",
        );
        return false;
      }
    }

    // Build the result with optional updated input for AskUserQuestion.
    // If deny has feedback, use that as the message.
    const trimmedFeedback = feedback?.trim();
    const denyMessage = trimmedFeedback || "User denied permission";
    // If user just clicked "No" without feedback, set interrupt: true to stop retrying.
    // If user provided feedback, set interrupt: false so Claude can incorporate the guidance.
    const shouldInterrupt = response === "deny" && !trimmedFeedback;
    const result: ToolApprovalResult = {
      behavior: approved ? "allow" : "deny",
      message: !approved ? denyMessage : undefined,
      interrupt: !approved ? shouldInterrupt : undefined,
      // Providers with persistent grants (OpenCode `always` reply) honor
      // this; others ignore it and treat the approval as one-shot.
      approvalScope: response === "approve_always" ? "always" : undefined,
    };

    // If answers provided (AskUserQuestion), pass them as updatedInput
    if (answers && approved) {
      const originalInput = pending.request.toolInput as {
        questions?: unknown[];
      };
      result.updatedInput = {
        ...originalInput,
        answers,
      };
    }

    // If EnterPlanMode is approved, switch to plan mode
    if (approved && pending.request.toolName === "EnterPlanMode") {
      this.setPermissionMode("plan");
    }

    // If ExitPlanMode is approved, switch back to the app's default mode.
    if (approved && pending.request.toolName === "ExitPlanMode") {
      this.setPermissionMode(DEFAULT_PERMISSION_MODE);
    }

    // Resolve the promise and remove from tracking
    pending.resolve(result);
    this.pendingToolApprovals.delete(requestId);
    this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
      (id) => id !== requestId,
    );

    // Codex app-server decline decisions do not currently include a rejection
    // reason in-protocol. Queue the feedback as a follow-up user message.
    if (response === "deny" && trimmedFeedback && this.provider === "codex") {
      const queued = this.queueMessage({
        text: `I denied that request. Instead: ${trimmedFeedback}`,
      });
      if (!queued.success) {
        getLogger().warn(
          {
            sessionId: this._sessionId,
            processId: this.id,
            error: queued.error,
          },
          "Failed to queue Codex deny feedback follow-up message",
        );
      }
    }

    // Emit the next pending approval, or transition to running if none left
    this.emitNextPendingApproval();

    return true;
  }

  /**
   * Get the current pending input request (first in queue), if any.
   * Works for both real SDK (canUseTool callback) and mock SDK (input_request message).
   */
  getPendingInputRequest(): InputRequest | null {
    // Check real SDK pending approvals queue first
    const firstId = this.pendingToolApprovalQueue[0];
    if (firstId !== undefined) {
      return this.pendingToolApprovals.get(firstId)?.request ?? null;
    }
    // For mock SDK, check state directly
    if (this._state.type === "waiting-input") {
      return this._state.request;
    }
    return null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Terminate the process with a reason (e.g., staleness detection).
   * Unlike abort(), this records the reason for logging/debugging.
   * Also calls abortFn to kill the underlying CLI process, preventing
   * orphaned processes that continue running after Yep stops tracking them.
   */
  terminate(reason: string): void {
    // Kill the underlying CLI process first (if available), so it doesn't
    // continue running as an orphan after we unregister from the Supervisor.
    if (this.abortFn) {
      this.abortFn();
    }
    this.markTerminated(reason);
  }

  async abort(): Promise<void> {
    this.clearIdleTimer();
    this.stopBucketSwapTimer();

    // Call the SDK's abort function if available
    if (this.abortFn) {
      this.abortFn();
    }

    // Wait for CLI process to fully exit (with timeout to avoid hanging)
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([this._exitPromise, timeout]);

    // Signal completion to subscribers (skip if already terminated —
    // markTerminated() already emitted "complete")
    if (this._state.type !== "terminated") {
      this.emit({ type: "complete" });
    }
    this.listeners.clear();
  }

  private async processMessages(): Promise<void> {
    if (this.startupId) {
      getLogger().info(
        {
          event: "provider_first_message_wait_started",
          startupId: this.startupId,
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          provider: this.provider,
          executor: this.executor,
          requestElapsedMs: Date.now() - this.startupStartedAtMs,
        },
        "Waiting for first provider message",
      );
    }

    try {
      while (!this.iteratorDone) {
        // Check if held - pause before calling iterator.next()
        if (this._isHeld) {
          await this.waitUntilResumed();
          // After resuming, check if we should continue or if terminated while held
          if (this.iteratorDone || this._state.type === "terminated") {
            break;
          }
        }

        const result = await this.sdkIterator.next();

        if (result.done) {
          this.iteratorDone = true;
          if (this.startupId && !this.firstProviderMessageLogged) {
            getLogger().warn(
              {
                event: "provider_ended_before_first_message",
                startupId: this.startupId,
                sessionId: this._sessionId,
                processId: this.id,
                projectId: this.projectId,
                provider: this.provider,
                executor: this.executor,
                requestElapsedMs: Date.now() - this.startupStartedAtMs,
              },
              "Provider ended before emitting its first message",
            );
          }
          if (!this.sessionIdResolved) {
            this.rejectSessionIdWaiters(
              new Error("Provider ended before returning a session ID"),
            );
          }
          // Don't transition to idle if we're waiting for input
          if (this._state.type !== "waiting-input") {
            this.transitionToIdle();
          }
          break;
        }

        const message = this.withTimestamp(result.value);
        this._lastMessageTime = new Date();

        const isProviderOutput =
          message.type === "assistant" || message.type === "stream_event";
        if (
          !this.firstProviderMessageLogged ||
          (!this.firstProviderOutputLogged && isProviderOutput)
        ) {
          const messageRecord = message as unknown as Record<string, unknown>;
          const streamEvent =
            messageRecord.event && typeof messageRecord.event === "object"
              ? (messageRecord.event as Record<string, unknown>)
              : undefined;
          const milestoneFields = {
            startupId: this.startupId,
            sessionId: this._sessionId,
            processId: this.id,
            projectId: this.projectId,
            provider: this.provider,
            executor: this.executor,
            messageType: message.type,
            messageSubtype:
              typeof messageRecord.subtype === "string"
                ? messageRecord.subtype
                : undefined,
            streamEventType:
              typeof streamEvent?.type === "string"
                ? streamEvent.type
                : undefined,
            requestElapsedMs: Date.now() - this.startupStartedAtMs,
            processElapsedMs: Date.now() - this.startedAt.getTime(),
          };

          if (!this.firstProviderMessageLogged) {
            this.firstProviderMessageLogged = true;
            if (this.startupId) {
              getLogger().info(
                {
                  event: "provider_first_message_received",
                  ...milestoneFields,
                },
                "Received first provider message",
              );
            }
          }

          if (!this.firstProviderOutputLogged && isProviderOutput) {
            this.firstProviderOutputLogged = true;
            if (this.startupId) {
              getLogger().info(
                {
                  event: "provider_first_output_received",
                  ...milestoneFields,
                },
                "Received first provider output",
              );
            }
          }
        }

        if (!this.sessionIdResolved && message.type === "error") {
          const detail =
            typeof message.error === "string"
              ? message.error
              : "Provider failed before returning a session ID";
          this.rejectSessionIdWaiters(new Error(detail));
        }

        // Store message in history for replay to late-joining clients.
        // Exclude stream_event messages - they're transient streaming deltas that
        // are redundant once the final assistant message arrives. Replaying them
        // causes flickering as the last message appears to stream in again.
        if (shouldEmitMessage(message) && message.type !== "stream_event") {
          // Check for duplicates before adding to history
          // This handles the case where queueMessage added the optimistic message
          // and now the provider is echoing it back with the same UUID
          const isDuplicate =
            message.type === "user" &&
            message.uuid &&
            (this.currentBucket.some((m) => m.uuid === message.uuid) ||
              this.previousBucket.some((m) => m.uuid === message.uuid));

          if (!isDuplicate) {
            this.currentBucket.push(message);
          }
        }

        // Extract session ID from init message
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.session_id
        ) {
          const log = getLogger();
          const oldSessionId = this._sessionId;
          this._sessionId = message.session_id;
          this.sessionIdResolved = true;
          if (typeof message.model === "string" && message.model) {
            this._resolvedModel = message.model;
          }
          if (
            typeof message.reasoningEffort === "string" &&
            message.reasoningEffort
          ) {
            this._resolvedReasoningEffort = message.reasoningEffort;
          }
          if (typeof message.serviceTier === "string" && message.serviceTier) {
            this._serviceTier = message.serviceTier;
          }

          log.info(
            {
              event: "session_id_received",
              sessionId: this._sessionId,
              previousTempId: oldSessionId,
              processId: this.id,
              projectId: this.projectId,
              startupId: this.startupId,
              requestToInitializationDurationMs:
                this.startupId === undefined
                  ? undefined
                  : Date.now() - this.startupStartedAtMs,
              initializationDurationMs: Date.now() - this.startedAt.getTime(),
            },
            `Session ID received from SDK: ${this._sessionId}`,
          );

          // Emit session-id-changed event so Supervisor can update its mapping
          // This is critical for ExternalSessionTracker to correctly identify owned sessions
          if (oldSessionId !== this._sessionId) {
            this.emit({
              type: "session-id-changed",
              oldSessionId,
              newSessionId: this._sessionId,
            });
          }

          // Resolve any waiters
          for (const waiter of this.sessionIdWaiters) {
            if (waiter.timeout) clearTimeout(waiter.timeout);
            waiter.timeout = null;
            waiter.resolve(this._sessionId);
          }
          this.sessionIdWaiters = [];
        }

        // Capture resolved model from first assistant message
        if (
          !this._resolvedModel &&
          message.type === "assistant" &&
          message.message?.model &&
          message.message.model !== "<synthetic>"
        ) {
          this._resolvedModel = message.message.model;
        }

        // Emit to SSE subscribers
        // See shouldEmitMessage() for why we never filter messages
        if (shouldEmitMessage(message)) {
          this.emit({ type: "message", message });
        }

        if (message.type === "system" && message.subtype === "turn_complete") {
          const usage = message.usage as
            | { model_context_window?: unknown }
            | undefined;
          if (
            typeof usage?.model_context_window === "number" &&
            usage.model_context_window > 0
          ) {
            this._contextWindow = Math.max(
              this._contextWindow ?? 0,
              usage.model_context_window,
            );
          }
        }

        // Handle special message types
        if (message.type === "system" && message.subtype === "input_request") {
          // Legacy mock SDK behavior - handle input_request message
          this.handleInputRequest(message);
        } else if (message.type === "result") {
          // Capture context window from modelUsage in result messages.
          // Keys may include suffixes like "[1m]" (e.g. "claude-opus-4-6[1m]"),
          // so we take the max contextWindow across all model entries.
          if (message.modelUsage) {
            const mu = message.modelUsage as Record<
              string,
              { contextWindow?: number }
            >;
            for (const entry of Object.values(mu)) {
              if (entry.contextWindow && entry.contextWindow > 0) {
                this._contextWindow = Math.max(
                  this._contextWindow ?? 0,
                  entry.contextWindow,
                );
              }
            }
          }
          this.transitionToIdle();
        }
      }
    } catch (error) {
      const err = error as Error;
      const log = getLogger();

      log.error(
        {
          event: "process_error",
          startupId: this.startupId,
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          errorMessage: err.message,
          errorStack: err.stack,
          currentState: this._state.type,
          requestElapsedMs:
            this.startupId === undefined
              ? undefined
              : Date.now() - this.startupStartedAtMs,
        },
        `Process error: ${this._sessionId} - ${err.message}`,
      );

      this.emit({ type: "error", error: err });
      if (!this.sessionIdResolved) {
        this.rejectSessionIdWaiters(err);
      }

      // Detect process termination errors - set flag synchronously BEFORE markTerminated
      // to prevent race where queueMessage is called before state changes to terminated
      if (this.isProcessTerminationError(err)) {
        this.transportFailed = true;
        this.markTerminated("underlying process terminated", err);
        return;
      }

      // Don't transition to idle if we're waiting for input
      if (this._state.type !== "waiting-input") {
        this.transitionToIdle();
      }
    } finally {
      // Resolve exit promise on both normal completion and non-terminating errors
      // so abort() doesn't hang waiting for it. (markTerminated already resolves
      // it for termination errors, and guards against double-resolve.)
      if (this._exitResolve) {
        this._exitResolve();
        this._exitResolve = null;
      }
    }
  }

  /**
   * Check if an error indicates the underlying Claude process was terminated.
   */
  private isProcessTerminationError(error: Error): boolean {
    const message = error.message || "";
    return (
      message.includes("ProcessTransport is not ready") ||
      message.includes("not ready for writing") ||
      message.includes("process exited") ||
      message.includes("SIGTERM") ||
      message.includes("SIGKILL") ||
      // SDK wraps spawn errors as "Failed to spawn Claude Code process: spawn <cmd> ENOENT"
      // where <cmd> varies (e.g., "node", "claude"), so check for ENOENT broadly
      message.includes("ENOENT")
    );
  }

  /**
   * Handle input_request message from mock SDK.
   * Real SDK uses canUseTool callback instead.
   */
  private handleInputRequest(message: SDKMessage): void {
    if (!message.input_request) return;

    const request: InputRequest = {
      id: message.input_request.id,
      sessionId: this._sessionId,
      type: message.input_request.type as InputRequest["type"],
      prompt: message.input_request.prompt,
      options: message.input_request.options,
      timestamp: new Date().toISOString(),
    };

    this.setState({ type: "waiting-input", request });
  }

  private transitionToIdle(): void {
    this.clearIdleTimer();
    // Feed next deferred message before transitioning to idle
    const next = this.deferredQueue.shift();
    if (next) {
      this.emitDeferredQueueChange();
      this.queueMessage(next.message); // stays in-turn, SDK picks it up
      return;
    }
    this.setState({ type: "idle", since: new Date() });
    this.startIdleTimer();
    this.processNextInQueue();
  }

  /**
   * Process next message in legacy queue (for mock SDK).
   */
  private processNextInQueue(): void {
    if (this.legacyQueue.length === 0) return;

    const nextMessage = this.legacyQueue.shift();
    if (nextMessage) {
      // In real implementation with MessageQueue, this happens automatically
      // For mock SDK, we just transition back to running
      this.setState({ type: "in-turn" });
    }
  }

  private startIdleTimer(): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;

      // State may have changed while the timer was pending.
      if (this._state.type !== "idle") {
        return;
      }

      // Keep ownership while the underlying process is still alive. This lets
      // long-lived Claude sessions remain reusable instead of decaying into
      // "external" after the idle timeout.
      if (this.isProcessAlive === true) {
        getLogger().debug(
          {
            event: "idle_cleanup_deferred",
            sessionId: this._sessionId,
            processId: this.id,
            projectId: this.projectId,
            idleTimeoutMs: this.idleTimeoutMs,
          },
          `Idle cleanup deferred: ${this._sessionId} is still alive`,
        );
        this.startIdleTimer();
        return;
      }

      // Emit completion - Supervisor will clean up
      this.emit({ type: "complete" });
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private setState(state: ProcessState): void {
    this._state = state;
    this.emit({ type: "state-change", state });
  }

  private emit(event: ProcessEvent): void {
    if (event.type === "state-change") {
      getLogger().debug(
        {
          component: "process",
          sessionId: this._sessionId,
          eventType: "state-change",
          listenerCount: this.listeners.size,
          newState: event.state.type,
        },
        `Emitting state-change to ${this.listeners.size} listeners`,
      );
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }
}

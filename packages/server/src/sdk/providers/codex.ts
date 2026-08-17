/**
 * Codex Provider implementation using codex app-server JSON-RPC.
 *
 * Uses JSON-RPC over either a resident 4510 bridge WebSocket (when resuming a
 * bridge-owned thread) or an isolated `stdio://` app-server. Both transports
 * handle server-initiated permission requests (command/file approval).
 */

import { type ChildProcess, exec, spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  CodexRetryStatus,
  ModelInfo,
  ProviderGoalAction,
  ProviderGoalState,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { WebSocket } from "ws";
import {
  buildCodexInteractiveResponse,
  toCodexInteractiveRequestView,
} from "../../codex-bridge/interactions.js";
import {
  CODEX_EVENT_RUNTIME_IDENTITY,
  type CodexEventEnvelope,
  CodexEventIngress,
  type CodexEventProjectionMode,
  type CodexEventRolloutConfig,
  type CodexEventStore,
  InMemoryCodexEventStore,
  JsonlCodexEventStore,
  classifyCodexNotification,
  codexEventRolloutConfigFromEnv,
  resolveCodexEventProjectionMode,
} from "../../codex-events/index.js";
import {
  isCodexCorrelationDebugEnabled,
  logCodexCorrelationDebug,
  summarizeCodexNormalizedMessage,
} from "../../codex/correlationDebugLogger.js";
import {
  type CanonicalCodexError,
  classifyCodexError,
  formatCodexRetryWarning,
} from "../../codex/error-taxonomy.js";
import {
  type CodexFileChangeStatus,
  type NormalizedCodexFileChange,
  buildCodexEditInput,
  formatCodexFileChangeResult,
  isCodexFileChangeError,
  normalizeCodexFileChangeStatus,
  normalizeCodexFileChanges,
  publicCodexFileChanges,
  publicCodexFilePath,
} from "../../codex/file-change.js";
import {
  buildCodexImageGenerationResultText,
  isCodexImageGenerationRecord,
  normalizeCodexImageGenerationRecord,
  summarizeCodexImageGenerationResult,
} from "../../codex/image-generation.js";
import {
  getCodexMcpAppServerArgs,
  resolveCodexMcpThreadProfile,
} from "../../codex/mcp-profile.js";
import {
  type CodexToolCallContext,
  canonicalizeCodexToolName,
  deriveCodexWebRunInvocation,
  extractCodexExecUpdatePlan,
  normalizeCodexCommandExecutionOutput,
  normalizeCodexToolInvocation,
  normalizeCodexToolOutputWithContext,
  parseCodexToolArguments,
} from "../../codex/normalization.js";
import { getDataDir } from "../../config.js";
import { getLogger } from "../../logging/logger.js";
import { encodeProjectId } from "../../projects/paths.js";
import { ensureRuntimeToken } from "../../runtime/token.js";
import {
  GeneratedArtifactMaterializer,
  UploadManager,
} from "../../uploads/index.js";
import { findCodexCliPath, whichCommand } from "../cli-detection.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue, getUserPromptProjection } from "../messageQueue.js";
import type {
  CodexStructuredUserInput,
  ProviderApprovalDecision,
  SDKMessage,
  TimestampedSDKMessage,
  ToolApprovalResult,
} from "../types.js";
import {
  CODEX_NATIVE_CAPABILITIES,
  type CodexNativeControlDataMap,
  type CodexNativeControlRequest,
  type CodexNativeControlResult,
  codexControlFailure,
} from "./codex-controls.js";
import {
  type CodexModelSourceDefinition,
  DEFAULT_CODEX_MODEL_SOURCE,
  getCodexModelSourceRegistry,
} from "./codex-model-sources.js";
import type { ThreadGoal as CodexThreadGoal } from "./codex-protocol/generated/v2/ThreadGoal.js";
import type { ThreadGoalStatus as CodexThreadGoalStatus } from "./codex-protocol/generated/v2/ThreadGoalStatus.js";
import type { ThreadReadResponse } from "./codex-protocol/generated/v2/ThreadReadResponse.js";
import type { TurnInterruptParams } from "./codex-protocol/generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./codex-protocol/generated/v2/TurnInterruptResponse.js";
import type { TurnSteerParams } from "./codex-protocol/generated/v2/TurnSteerParams.js";
import type { TurnSteerResponse } from "./codex-protocol/generated/v2/TurnSteerResponse.js";
import type {
  AskForApproval as CodexAskForApproval,
  ErrorNotification as CodexErrorNotification,
  ItemCompletedNotification as CodexItemCompletedNotification,
  ItemStartedNotification as CodexItemStartedNotification,
  SandboxMode as CodexSandboxMode,
  ThreadItem as CodexThreadItem,
  UserInput as CodexUserInput,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
} from "./codex-protocol/index.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

const log = getLogger().child({ component: "codex-provider" });
const execAsync = promisify(exec);

function logSdkCorrelationDebug(
  sessionId: string,
  message: SDKMessage,
  metadata: {
    eventKind?: string;
    turnId?: string;
    itemId?: string;
    callId?: string;
    phase?: string;
    sourceEvent?: string;
    status?: string;
  } = {},
): void {
  if (!isCodexCorrelationDebugEnabled()) return;
  logCodexCorrelationDebug({
    sessionId,
    channel: "sdk",
    authority: "transient",
    ...metadata,
    ...summarizeCodexNormalizedMessage(message),
  });
}

function withCodexTimestamp<T extends SDKMessage>(
  message: T,
  timestamp = new Date().toISOString(),
): TimestampedSDKMessage<T> {
  if (
    typeof message.timestamp === "string" &&
    message.timestamp.trim().length > 0
  ) {
    return message as TimestampedSDKMessage<T>;
  }
  return {
    ...message,
    timestamp,
  } as TimestampedSDKMessage<T>;
}

function normalizeCodexModelOption(model: string | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "default") {
    return null;
  }
  if (CODEX_MODEL_PROVIDER_NAMES.has(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

// Keep the cache short enough that a one-off fallback (slow cold start, codex
// upgrade in progress) does not pin a stale/incorrect model list for an hour.
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
// Codex app-server cold start can take a few seconds; give model/list enough
// time so we use the live list instead of silently dropping to the fallback.
const MODEL_LIST_TIMEOUT_MS = 15000;
const APP_SERVER_INIT_REQUEST_ID = 1;
const APP_SERVER_MODEL_LIST_REQUEST_ID = 2;
const APP_SERVER_SHUTDOWN_GRACE_MS = 1500;
const MAX_APP_SERVER_STDERR_LENGTH = 64 * 1024;
const APP_SERVER_OVERLOAD_MAX_ATTEMPTS = 4;
const APP_SERVER_OVERLOAD_BASE_DELAY_MS = 50;
/** Max characters of live command output kept for the streaming preview. */
const CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT = 16_000;
const DEFAULT_CODEX_MODEL_PROVIDER = DEFAULT_CODEX_MODEL_SOURCE;
const CODEX_MODEL_PROVIDER_NAMES = new Set(["openai", "azure"]);
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/**
 * Local debug knobs for Codex app-server policy behavior.
 *
 * Set `approvalPolicy` to `"untrusted"` to force Codex to request approval for
 * command/file actions more aggressively, even when `"on-request"` would not.
 * Leave as `null` for normal behavior.
 */
const CODEX_POLICY_OVERRIDES: {
  approvalPolicy: CodexAskForApproval | null;
  sandbox: CodexSandboxMode | null;
} = {
  approvalPolicy: null,
  sandbox: null,
};

/**
 * When enabled, declare Codex session originator as "Codex Desktop"
 * when initializing app-server sessions.
 */
const DECLARE_CODEX_ORIGINATOR = true;
const DECLARED_CODEX_ORIGINATOR = "Codex Desktop";

// Static fallback used only when the live `model/list` query fails. Keep this in
// sync with the models Codex actually offers, and list a ChatGPT-account-safe
// default first: `-codex` models are rejected by OpenAI for ChatGPT-account auth
// ("model is not supported when using Codex with a ChatGPT account"), so they
// must never be the default the picker preselects.
const PREFERRED_MODEL_ORDER = [
  DEFAULT_CODEX_MODEL,
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.1-codex-mini",
] as const;

const CODEX_REASONING_EFFORTS = [
  {
    reasoningEffort: "low",
    description: "Fast responses with lighter reasoning",
  },
  {
    reasoningEffort: "medium",
    description: "Balances speed and reasoning depth for everyday tasks",
  },
  {
    reasoningEffort: "high",
    description: "Greater reasoning depth for complex problems",
  },
  {
    reasoningEffort: "xhigh",
    description: "Extra high reasoning depth for complex problems",
  },
  {
    reasoningEffort: "max",
    description: "Maximum reasoning depth for the hardest problems",
  },
] as const;

const CODEX_ULTRA_REASONING_EFFORT = {
  reasoningEffort: "ultra",
  description: "Maximum reasoning with automatic task delegation",
} as const;

const FALLBACK_CODEX_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      ...CODEX_REASONING_EFFORTS,
      CODEX_ULTRA_REASONING_EFFORT,
    ],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    description: "Balanced agentic coding model for everyday work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      ...CODEX_REASONING_EFFORTS,
      CODEX_ULTRA_REASONING_EFFORT,
    ],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [...CODEX_REASONING_EFFORTS],
  },
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.4-mini", name: "GPT-5.4-Mini" },
];

type JsonRpcId = string | number;

interface JsonRpcError {
  message?: string;
  code?: number;
  data?: unknown;
}

class CodexJsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly requestId?: JsonRpcId,
  ) {
    super(message);
    this.name = "CodexJsonRpcError";
  }
}

interface JsonRpcResponse {
  id?: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
  emittedAtMs?: number;
  canonicalEvent?: CodexEventEnvelope;
}

interface TurnPlanUpdatedNotificationParams {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: Array<{
    step: string;
    status: string;
  }>;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

interface AppServerModel {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  upgrade?: string | null;
  /** Models hidden from the default picker (e.g. deprecated/internal). */
  hidden?: boolean;
  /** The model Codex itself selects by default for this account. */
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{
    reasoningEffort?: string;
    description?: string;
  }>;
  defaultReasoningEffort?: string;
}

interface TokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelContextWindow?: number | null;
}

interface CodexTurnRuntimeState {
  threadId: string;
  activeTurnId: string | null;
  ready: boolean;
}

type CodexMessagePhase = "commentary" | "final_answer";

const GOAL_STATUS_LABELS: Record<CodexThreadGoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTokens(used: number, budget: number | null): string {
  const fmt = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };
  return budget !== null && budget > 0
    ? `${fmt(used)} / ${fmt(budget)}`
    : fmt(used);
}

/**
 * Format a Codex `ThreadGoal` as a human-readable status string, mirroring
 * the Codex TUI `goal_display.rs` `goal_usage_summary` output.
 */
function formatCodexGoal(goal: CodexThreadGoal | null): string {
  if (!goal) return "No goal set.";
  const lines: string[] = [
    `Objective: ${goal.objective}`,
    `Status: ${GOAL_STATUS_LABELS[goal.status] ?? goal.status}`,
  ];
  if (goal.timeUsedSeconds > 0) {
    lines.push(`Time: ${formatDuration(goal.timeUsedSeconds)}`);
  }
  lines.push(`Tokens: ${formatTokens(goal.tokensUsed, goal.tokenBudget)}`);
  return lines.join("\n");
}

async function terminateChildProcess(
  child: ChildProcess | null | undefined,
  graceMs = APP_SERVER_SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (!child?.pid || child.killed || child.exitCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  const killTarget =
    process.platform !== "win32" && child.pid > 0 ? -child.pid : child.pid;

  try {
    process.kill(killTarget, "SIGTERM");
  } catch {
    return;
  }

  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    try {
      process.kill(killTarget, "SIGKILL");
    } catch {
      // Ignore escalation failures during shutdown.
    }
  }, graceMs);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

type NormalizedThreadItem =
  | { id: string; type: "reasoning"; text: string }
  | {
      id: string;
      type: "agent_message";
      text: string;
      phase?: CodexMessagePhase;
    }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output: string;
      exit_code?: number;
      status: string;
    }
  | {
      id: string;
      type: "file_change";
      changes: NormalizedCodexFileChange[];
      status: CodexFileChangeStatus;
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server: string;
      tool: string;
      arguments: unknown;
      result?: unknown;
      error?: { message: string };
      status: string;
    }
  | { id: string; type: "web_search"; query: string }
  | {
      id: string;
      type: "todo_list";
      items: Array<{ text: string; completed: boolean }>;
    }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "image_view"; path: string }
  | {
      id: string;
      type: "image_generation";
      status: string;
      revised_prompt?: string;
      result?: string;
      path?: string;
      url?: string;
    };

/**
 * Configuration for Codex provider.
 */
export interface CodexProviderConfig {
  /** Path to codex binary (auto-detected if not specified) */
  codexPath?: string;
  /** API base URL override */
  baseUrl?: string;
  /** API key override (normally read from ~/.codex/auth.json) */
  apiKey?: string;
  /** Canonical event-spine rollout/store overrides. */
  eventSpine?: CodexEventRolloutConfig;
  /** Managed generated-artifact storage override for tests and embedders. */
  generatedArtifactUploadManager?: UploadManager;
  /** Optional 4510 execution route used to rejoin bridge-owned threads. */
  bridgeExecution?: CodexBridgeExecutionConfig;
}

export interface CodexBridgeExecutionConfig {
  mode: "embedded" | "external" | "disabled";
  controlUrl: string;
  /** Optional bearer accepted by a remotely exposed bridge. */
  authToken?: string;
  /** Runtime token shared by the main server and a local bridge sidecar. */
  authTokenFile?: string;
  requestTimeoutMs?: number;
}

interface CodexBridgeExecutionTarget {
  url: string;
  headers?: Record<string, string>;
}

interface CodexAppServerWebSocketTransport {
  kind: "websocket";
  url: string;
  headers?: Record<string, string>;
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private closedError: Error | null = null;

  push(item: T): void {
    if (this.closedError) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(error?: Error): void {
    if (this.closedError) return;
    this.closedError = error ?? new Error("Queue closed");
    for (const waiter of this.waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(this.closedError);
    }
    this.waiters = [];
    this.items = [];
  }

  async shift(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      const item = this.items.shift();
      if (item === undefined) {
        throw new Error("Queue underflow");
      }
      return item;
    }

    if (this.closedError) {
      throw this.closedError;
    }

    return await new Promise<T>((resolve, reject) => {
      const waiter: {
        resolve: (value: T) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("Operation aborted"));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }
}

type AppServerRequestHandler = (
  request: JsonRpcServerRequest,
) => Promise<unknown>;

interface AppServerRequestMetadata {
  clientMessageId?: string;
}

interface AppServerRetryUpdate {
  requestId: JsonRpcId;
  method: string;
  retryStatus: CodexRetryStatus;
  metadata?: AppServerRequestMetadata;
}

type AppServerRetryHandler = (
  update: AppServerRetryUpdate,
) => void | Promise<void>;

interface AppServerEventObserver {
  onClientRequest(input: {
    requestId: JsonRpcId;
    method: string;
    params?: unknown;
    metadata?: AppServerRequestMetadata;
  }): Promise<void>;
  onClientResponse(input: {
    requestId: JsonRpcId;
    method: string;
    result?: unknown;
    error?: unknown;
    metadata?: AppServerRequestMetadata;
  }): Promise<void>;
  onServerRequest(request: JsonRpcServerRequest): Promise<void>;
  onServerNotification(
    notification: JsonRpcNotification,
  ): Promise<CodexEventEnvelope>;
}

class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closeError: Error | null = null;

  /** OS PID of the spawned app-server child process */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  isAlive(): boolean {
    if (this.socket) return this.socket.readyState === WebSocket.OPEN;
    const child = this.process;
    return Boolean(child?.pid && child.exitCode === null && !child.killed);
  }
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    JsonRpcId,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      method: string;
      params?: unknown;
      metadata?: AppServerRequestMetadata;
    }
  >();
  private readonly notifications = new AsyncQueue<JsonRpcNotification>();
  private onServerRequest: AppServerRequestHandler | null = null;
  private eventObserver: AppServerEventObserver | null = null;
  private inboundObservationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly appServerArgs: string[] = [],
    private readonly transport?: CodexAppServerWebSocketTransport,
  ) {}

  setServerRequestHandler(handler: AppServerRequestHandler): void {
    this.onServerRequest = handler;
  }

  async setEventObserver(observer: AppServerEventObserver): Promise<void> {
    await this.inboundObservationTail;
    this.eventObserver = observer;
    const buffered = this.notifications.drain();
    if (buffered.length === 0) return;
    const canonicalizeBuffered = async () => {
      for (const notification of buffered) {
        const canonicalEvent =
          await observer.onServerNotification(notification);
        this.notifications.push({ ...notification, canonicalEvent });
      }
    };
    this.inboundObservationTail = this.inboundObservationTail
      .then(canonicalizeBuffered)
      .catch((error: unknown) => {
        this.handleProcessClose(
          error instanceof Error
            ? error
            : new Error("Codex app-server event observation failed"),
        );
      });
    await this.inboundObservationTail;
  }

  async connect(): Promise<void> {
    if (this.process || this.socket) {
      throw new Error("Codex app-server already connected");
    }

    if (this.transport?.kind === "websocket") {
      await this.connectWebSocket(this.transport);
      return;
    }

    const child = spawn(
      this.command,
      ["app-server", ...this.appServerArgs, "--listen", "stdio://"],
      {
        cwd: this.cwd,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
        shell: process.platform === "win32",
      },
    );

    this.process = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf-8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        this.handleJsonRpcLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const stderr = chunk.toString("utf-8").trim();
      if (stderr) {
        this.stderrBuffer = `${this.stderrBuffer}${stderr}\n`.slice(
          -MAX_APP_SERVER_STDERR_LENGTH,
        );
        log.debug({ stderr }, "codex app-server stderr");
      }
    });

    child.on("error", (error) => {
      this.handleProcessClose(error);
    });

    child.on("exit", (code, signal) => {
      this.handleProcessClose(
        new Error(
          `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(this.closeError ?? error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private async connectWebSocket(
    transport: CodexAppServerWebSocketTransport,
  ): Promise<void> {
    const socket = new WebSocket(transport.url, {
      ...(transport.headers ? { headers: transport.headers } : {}),
    });
    this.socket = socket;

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        log.debug("Ignoring binary Codex app-server WebSocket frame");
        return;
      }
      this.handleJsonRpcLine(data.toString());
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanupHandshake = () => {
        socket.off("open", onOpen);
        socket.off("error", onHandshakeError);
        socket.off("close", onHandshakeClose);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        resolve();
      };
      const onHandshakeError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        this.socket = null;
        socket.terminate();
        reject(error);
      };
      const onHandshakeClose = (code: number) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        this.socket = null;
        reject(
          new Error(
            `Codex bridge WebSocket closed during connection (code=${code})`,
          ),
        );
      };
      socket.once("open", onOpen);
      socket.once("error", onHandshakeError);
      socket.once("close", onHandshakeClose);
    });

    socket.on("error", (error) => this.handleProcessClose(error));
    socket.on("close", (code, reason) => {
      this.handleProcessClose(
        new Error(
          `Codex bridge WebSocket closed (code=${code}, reason=${reason.toString() || "none"})`,
        ),
      );
    });
  }

  private handleJsonRpcLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.debug({ line }, "Ignoring non-JSON app-server line");
      return;
    }

    const method =
      typeof message.method === "string" ? (message.method as string) : null;
    const hasId =
      typeof message.id === "string" || typeof message.id === "number";

    // Server request/notification
    if (method) {
      if (hasId) {
        const request: JsonRpcServerRequest = {
          id: message.id as JsonRpcId,
          method,
          params: message.params,
        };
        const observer = this.eventObserver;
        this.enqueueInboundObservation(async () => {
          await observer?.onServerRequest(request);
          this.handleServerRequest(request);
        });
        return;
      }

      const notification: JsonRpcNotification = {
        method,
        params: message.params,
        ...(typeof message.emittedAtMs === "number" &&
        Number.isFinite(message.emittedAtMs)
          ? { emittedAtMs: message.emittedAtMs }
          : {}),
      };
      const observer = this.eventObserver;
      this.enqueueInboundObservation(async () => {
        const canonicalEvent =
          await observer?.onServerNotification(notification);
        this.notifications.push({
          ...notification,
          ...(canonicalEvent ? { canonicalEvent } : {}),
        });
      });
      return;
    }

    // Response to our request
    if (hasId) {
      const id = message.id as JsonRpcId;
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      const observer = this.eventObserver;
      this.enqueueInboundObservation(async () => {
        if (this.pendingRequests.get(id) !== pending) return;
        this.pendingRequests.delete(id);
        if (message.error && typeof message.error === "object") {
          const error = message.error as JsonRpcError;
          await observer?.onClientResponse({
            requestId: id,
            method: pending.method,
            error,
            ...(pending.metadata ? { metadata: pending.metadata } : {}),
          });
          pending.reject(
            new CodexJsonRpcError(
              typeof error.code === "number" ? error.code : -32000,
              error.message ?? "JSON-RPC request failed",
              error.data,
              id,
            ),
          );
          return;
        }
        await observer?.onClientResponse({
          requestId: id,
          method: pending.method,
          result: message.result,
          ...(pending.metadata ? { metadata: pending.metadata } : {}),
        });
        pending.resolve(message.result);
      });
    }
  }

  private enqueueInboundObservation(operation: () => Promise<void>): void {
    this.inboundObservationTail = this.inboundObservationTail
      .then(operation)
      .catch((error: unknown) => {
        this.handleProcessClose(
          error instanceof Error
            ? error
            : new Error("Codex app-server event observation failed"),
        );
      });
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const respond = (payload: Record<string, unknown>) => {
      this.sendRaw({
        jsonrpc: "2.0",
        id: request.id,
        ...payload,
      });
    };

    if (!this.onServerRequest) {
      respond({
        error: {
          code: -32601,
          message: `Unhandled server request: ${request.method}`,
        },
      });
      return;
    }

    void this.onServerRequest(request)
      .then((result) => {
        respond({ result: result ?? {} });
      })
      .catch((error) => {
        const rpcError = error instanceof CodexJsonRpcError ? error : undefined;
        respond({
          error: {
            code: rpcError?.code ?? -32000,
            message:
              error instanceof Error ? error.message : "Server request failed",
            ...(rpcError?.data === undefined ? {} : { data: rpcError.data }),
          },
        });
      });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    return (await this.requestTracked<T>(method, params)).result;
  }

  async requestTracked<T>(
    method: string,
    params?: unknown,
    metadata?: AppServerRequestMetadata,
    onRetry?: AppServerRetryHandler,
  ): Promise<{ requestId: JsonRpcId; result: T }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.requestOnceTracked<T>(method, params, metadata);
      } catch (error) {
        if (
          !(error instanceof CodexJsonRpcError) ||
          error.code !== -32001 ||
          attempt >= APP_SERVER_OVERLOAD_MAX_ATTEMPTS
        ) {
          throw error;
        }

        const exponentialDelay =
          APP_SERVER_OVERLOAD_BASE_DELAY_MS * 2 ** (attempt - 1);
        const jitter = Math.floor(
          Math.random() * APP_SERVER_OVERLOAD_BASE_DELAY_MS,
        );
        const delayMs = exponentialDelay + jitter;
        if (error.requestId !== undefined) {
          await onRetry?.({
            requestId: error.requestId,
            method,
            retryStatus: {
              state: attempt === 1 ? "queued" : "retrying",
              category: "overloaded",
              retryable: true,
              attempt,
              nextAttempt: attempt + 1,
              maxAttempts: APP_SERVER_OVERLOAD_MAX_ATTEMPTS,
              retryInMs: delayMs,
            },
            ...(metadata ? { metadata } : {}),
          });
        }
        log.warn(
          { method, attempt, delayMs, errorCode: error.code },
          "Codex app-server overloaded; retrying request",
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async requestOnceTracked<T>(
    method: string,
    params?: unknown,
    metadata?: AppServerRequestMetadata,
  ): Promise<{ requestId: JsonRpcId; result: T }> {
    if (this.closed) {
      throw this.closeError ?? new Error("Codex app-server client is closed");
    }

    const id = this.nextRequestId++;
    await this.eventObserver?.onClientRequest({
      requestId: id,
      method,
      params,
      ...(metadata ? { metadata } : {}),
    });

    const resultPromise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        method,
        params,
        ...(metadata ? { metadata } : {}),
      });
    });

    this.sendRaw({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return { requestId: id, result: await resultPromise };
  }

  notify(method: string, params?: unknown): void {
    this.sendRaw({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async nextNotification(signal?: AbortSignal): Promise<JsonRpcNotification> {
    return await this.notifications.shift(signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    const closeError = new Error("Codex app-server client closed");
    this.closeError = closeError;
    for (const pending of this.pendingRequests.values()) {
      pending.reject(closeError);
    }
    this.pendingRequests.clear();
    this.notifications.close(closeError);

    const child = this.process;
    this.process = null;
    const socket = this.socket;
    this.socket = null;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000, "Yep session detached");
    }
    void terminateChildProcess(child);
  }

  private handleProcessClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const capturedStderr = this.stderrBuffer.trim();
    const processError = capturedStderr
      ? new Error(
          `${error.message}\nCodex app-server stderr:\n${capturedStderr}`,
          { cause: error },
        )
      : error;
    this.closeError = processError;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(processError);
    }
    this.pendingRequests.clear();

    // Emit a terminal error notification so consumers can surface it.
    this.notifications.push({
      method: "error",
      params: {
        error: { message: processError.message },
        willRetry: false,
      },
    });
    this.notifications.close(processError);
    this.process = null;
    this.socket = null;
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }

    try {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(payload));
        return;
      }
      if (!this.process?.stdin) return;
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.handleProcessClose(
        error instanceof Error
          ? error
          : new Error("Failed to write to codex app-server stdin"),
      );
    }
  }
}

/**
 * Codex Provider implementation using app-server JSON-RPC.
 */
export class CodexProvider implements AgentProvider {
  readonly name = "codex" as const;
  readonly displayName = "Codex";
  readonly supportsPermissionMode = true;
  // auto/default/acceptEdits currently share the same cf-style thread policy.
  // Expose only one representative so clients do not promise a distinction
  // that Codex app-server cannot enforce.
  readonly permissionModes = ["auto", "plan", "bypassPermissions"] as const;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = false;

  private readonly config: CodexProviderConfig;
  private bridgeExecution?: CodexBridgeExecutionConfig;
  private readonly eventSpineConfig: CodexEventRolloutConfig;
  private readonly eventStore: CodexEventStore;
  /** Per-source model list cache (keyed by Codex model source id). */
  private readonly modelCacheBySource = new Map<
    string,
    { models: ModelInfo[]; expiresAt: number }
  >();

  constructor(config: CodexProviderConfig = {}) {
    this.config = config;
    this.bridgeExecution = normalizeCodexBridgeExecutionConfig(
      config.bridgeExecution,
    );
    this.eventSpineConfig = {
      ...codexEventRolloutConfigFromEnv(),
      ...config.eventSpine,
    };
    this.eventStore =
      config.eventSpine?.store ??
      (this.eventSpineConfig.durableStorePath
        ? new JsonlCodexEventStore({
            filePath: this.eventSpineConfig.durableStorePath,
            onCorruptLine: ({ lineNumber, reason }) => {
              log.warn(
                { lineNumber, reason },
                "Skipped malformed canonical Codex event-store line",
              );
            },
            ...(this.eventSpineConfig.storeRotation
              ? { rotation: this.eventSpineConfig.storeRotation }
              : {}),
            ...(this.eventSpineConfig.onStoreRotate
              ? { onRotate: this.eventSpineConfig.onStoreRotate }
              : {}),
            ...(this.eventSpineConfig.onStoreJournalGaps
              ? { onJournalGaps: this.eventSpineConfig.onStoreJournalGaps }
              : {}),
          })
        : new InMemoryCodexEventStore());
  }

  /** Configure the production singleton after environment config is loaded. */
  configureBridgeExecution(
    config: CodexBridgeExecutionConfig | null | undefined,
  ): void {
    this.bridgeExecution = normalizeCodexBridgeExecutionConfig(config);
  }

  private async resolveBridgeExecutionTarget(
    options: StartSessionOptions,
  ): Promise<CodexBridgeExecutionTarget | null> {
    const config = this.bridgeExecution;
    const sessionId = options.resumeSessionId;
    if (!config || config.mode === "disabled" || !sessionId) return null;

    const timeoutMs = config.requestTimeoutMs ?? 3_000;
    try {
      const authToken =
        config.authToken?.trim() ||
        (config.authTokenFile
          ? await ensureRuntimeToken(config.authTokenFile)
          : undefined);
      const headers = {
        accept: "application/json",
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      };
      const activeResponse = await fetch(
        `${config.controlUrl}/sessions/${encodeURIComponent(sessionId)}/active`,
        {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!activeResponse.ok) {
        throw new Error(
          `Codex bridge active probe returned ${activeResponse.status}`,
        );
      }
      const activePayload = (await activeResponse.json()) as {
        active?: unknown;
        mcpProfile?: unknown;
      };
      if (activePayload.active !== true) return null;

      const statusResponse = await fetch(`${config.controlUrl}/status`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!statusResponse.ok) {
        throw new Error(
          `Codex bridge status returned ${statusResponse.status}`,
        );
      }
      const status = (await statusResponse.json()) as {
        listening?: unknown;
        url?: unknown;
      };
      if (status.listening !== true || typeof status.url !== "string") {
        throw new Error("Codex bridge is not accepting WebSocket clients");
      }
      const url = new URL(status.url);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        throw new Error(
          `Codex bridge returned unsupported transport ${url.protocol}`,
        );
      }
      const controlUrl = new URL(config.controlUrl);
      if (isWildcardBridgeHostname(url.hostname)) {
        // A listener may advertise its bind-all address, which is not a
        // routable or trustworthy credential destination. Reuse the host the
        // configured control endpoint was actually reached through.
        url.hostname = controlUrl.hostname;
      } else if (!isSameTrustedBridgeHost(controlUrl.hostname, url.hostname)) {
        throw new Error(
          "Codex bridge returned a WebSocket endpoint on a different host",
        );
      }
      const mcpProfile =
        activePayload.mcpProfile === "clear" ||
        activePayload.mcpProfile === "light" ||
        activePayload.mcpProfile === "full"
          ? activePayload.mcpProfile
          : undefined;
      if (
        mcpProfile === "clear" ||
        (!mcpProfile && options.codexMcpMode === "clear")
      ) {
        url.searchParams.set("mcp", "clear");
      } else if (
        mcpProfile === "full" ||
        (!mcpProfile && options.codexMcpMode === "full")
      ) {
        url.searchParams.set("mcp", "full");
      }

      return {
        url: url.toString(),
        ...(authToken
          ? { headers: { authorization: `Bearer ${authToken}` } }
          : {}),
      };
    } catch (error) {
      throw new Error(
        "Codex bridge is unavailable; refusing to start a competing app-server for an external session",
        { cause: error },
      );
    }
  }

  /**
   * Check if the Codex CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    return this.isCodexCliInstalled();
  }

  /**
   * Check if Codex CLI is installed by looking in PATH and common locations.
   */
  private async isCodexCliInstalled(): Promise<boolean> {
    if (this.config.codexPath) {
      return true;
    }
    return (await findCodexCliPath()) !== null;
  }

  /**
   * Resolve the codex command: explicit config, PATH, or common install locations.
   */
  private async resolveCodexCommand(): Promise<string> {
    if (this.config.codexPath) return this.config.codexPath;
    return (await findCodexCliPath()) ?? "codex";
  }

  private getCodexClientName(): string {
    return DECLARE_CODEX_ORIGINATOR
      ? DECLARED_CODEX_ORIGINATOR
      : "yep-anywhere";
  }

  /**
   * Build environment overrides for Codex subprocesses.
   */
  private getCodexEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.config.baseUrl) {
      env.OPENAI_BASE_URL = this.config.baseUrl;
    }
    if (this.config.apiKey) {
      env.OPENAI_API_KEY = this.config.apiKey;
    }
    return env;
  }

  /**
   * Check if Codex is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status.
   * If Codex CLI is installed, assume it's authenticated.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isCodexCliInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
    };
  }

  /**
   * Get available models for Codex, aggregated across all available model
   * sources (OpenAI live list + any configured custom sources such as
   * DeepSeek). A single source failing (e.g. missing DeepSeek key) never blanks
   * out the others.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const registry = getCodexModelSourceRegistry();
    const installed = await this.isCodexCliInstalled();
    const aggregated: ModelInfo[] = [];

    for (const source of registry.list()) {
      const availability = registry.getAvailability(source.id);
      if (!availability.available) continue;
      try {
        const models = await this.getModelsForSource(source, installed);
        aggregated.push(...models);
      } catch (error) {
        log.warn(
          { source: source.id, error },
          "Failed to load Codex models for source; skipping",
        );
      }
    }

    return aggregated;
  }

  private async getModelsForSource(
    source: CodexModelSourceDefinition,
    installed: boolean,
  ): Promise<ModelInfo[]> {
    const now = Date.now();
    const cached = this.modelCacheBySource.get(source.id);
    if (cached && cached.expiresAt > now) {
      return cached.models;
    }

    let models: ModelInfo[];
    if (source.catalog) {
      // Custom sources ship a managed catalog; model/list has no provider
      // filter so we surface the catalog's allowlisted models directly.
      models = getCodexModelSourceRegistry().getCatalogModelInfos(source);
    } else {
      // Built-in OpenAI: query a short-lived app-server for the live list,
      // falling back to the static list when the query fails.
      models = installed ? await this.getModelsFromAppServer(source) : [];
      if (models.length === 0) {
        models = FALLBACK_CODEX_MODELS.map((model) => ({
          ...model,
          modelProvider: source.id,
          providerModelId: model.id,
        }));
      }
    }

    this.modelCacheBySource.set(source.id, {
      models,
      expiresAt: now + MODEL_CACHE_TTL_MS,
    });
    return models;
  }

  private async getModelsFromAppServer(
    source: CodexModelSourceDefinition,
  ): Promise<ModelInfo[]> {
    try {
      const appServerModels = await this.requestAppServerModelList(source);
      return this.normalizeModelList(appServerModels, source);
    } catch (error) {
      log.debug(
        { source: source.id, error },
        "Failed to query Codex app-server model list, using fallback models",
      );
      return [];
    }
  }

  private async requestAppServerModelList(
    source: CodexModelSourceDefinition,
  ): Promise<AppServerModel[]> {
    const codexCommand = await this.resolveCodexCommand();
    const sourceArgs = getCodexModelSourceRegistry().buildAppServerArgs(source);
    const codexEnv = this.getCodexEnv();
    return new Promise((resolve, reject) => {
      const child = spawn(
        codexCommand,
        [
          "app-server",
          ...sourceArgs,
          ...getCodexMcpAppServerArgs("standard"),
          "--listen",
          "stdio://",
        ],
        {
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: codexEnv,
          shell: process.platform === "win32",
        },
      );

      let settled = false;
      let stdoutBuffer = "";
      const stderrChunks: string[] = [];

      const finish = (handler: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        void terminateChildProcess(child);
        handler();
      };

      const parseAndHandleLine = (line: string) => {
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          return;
        }

        if (message.id === APP_SERVER_INIT_REQUEST_ID) {
          if (message.error) {
            const errorMessage =
              message.error.message ?? "Codex app-server initialize failed";
            finish(() => reject(new Error(errorMessage)));
            return;
          }

          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: APP_SERVER_MODEL_LIST_REQUEST_ID,
              method: "model/list",
              params: { limit: 100 },
            })}\n`,
          );
          return;
        }

        if (message.id !== APP_SERVER_MODEL_LIST_REQUEST_ID) {
          return;
        }

        if (message.error) {
          const errorMessage =
            message.error.message ?? "Codex app-server model/list failed";
          finish(() => reject(new Error(errorMessage)));
          return;
        }

        const result = message.result as { data?: unknown[] } | undefined;
        const data = Array.isArray(result?.data) ? result.data : [];
        const models: AppServerModel[] = [];

        for (const item of data) {
          if (!item || typeof item !== "object") continue;
          const model = item as AppServerModel;
          if (typeof model.id !== "string") continue;
          models.push(model);
        }

        finish(() => resolve(models));
      };

      const timeoutHandle = setTimeout(() => {
        const stderr = stderrChunks.join("").trim();
        finish(() =>
          reject(
            new Error(
              stderr
                ? `Timed out querying Codex app-server model list: ${stderr}`
                : "Timed out querying Codex app-server model list",
            ),
          ),
        );
      }, MODEL_LIST_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf-8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          parseAndHandleLine(line);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString("utf-8"));
      });

      child.on("error", (error) => {
        finish(() => reject(error));
      });

      child.on("exit", (code, signal) => {
        if (settled) return;
        const stderr = stderrChunks.join("").trim();
        const details = stderr ? ` stderr: ${stderr}` : "";
        finish(() =>
          reject(
            new Error(
              `Codex app-server exited before model/list response (code=${code ?? "null"}, signal=${signal ?? "null"}).${details}`,
            ),
          ),
        );
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: APP_SERVER_INIT_REQUEST_ID,
          method: "initialize",
          params: {
            clientInfo: {
              name: this.getCodexClientName(),
              version: "dev",
            },
            capabilities: null,
          },
        })}\n`,
      );
    });
  }

  private normalizeModelList(
    models: AppServerModel[],
    source: CodexModelSourceDefinition,
  ): ModelInfo[] {
    const orderLookup = new Map<string, number>(
      PREFERRED_MODEL_ORDER.map((id, idx) => [id, idx]),
    );
    // Track the account's own default so it sorts to the front of the picker
    // (it is guaranteed to be valid for the current auth mode).
    const defaultIds = new Set<string>();
    const deduped = new Map<string, ModelInfo>();

    for (const model of models) {
      // Skip models Codex hides from its own picker (deprecated/internal).
      if (model.hidden === true) continue;

      const modelId = (model.model || model.id || "").trim();
      if (!modelId) continue;

      if (model.isDefault === true) {
        defaultIds.add(modelId);
      }

      deduped.set(modelId, {
        id: modelId,
        modelProvider: source.id,
        providerModelId: modelId,
        name: this.formatModelName(model.displayName || modelId),
        description: model.description,
        supportedReasoningEfforts: model.supportedReasoningEfforts
          ?.filter(
            (
              option,
            ): option is { reasoningEffort: string; description?: string } =>
              typeof option.reasoningEffort === "string" &&
              option.reasoningEffort.trim().length > 0,
          )
          .map((option) => ({
            reasoningEffort: option.reasoningEffort.trim(),
            description: option.description,
          })),
        defaultReasoningEffort:
          model.defaultReasoningEffort?.trim() || undefined,
      });

      const upgradeId = model.upgrade?.trim();
      if (upgradeId && !deduped.has(upgradeId)) {
        deduped.set(upgradeId, {
          id: upgradeId,
          modelProvider: source.id,
          providerModelId: upgradeId,
          name: this.formatModelName(upgradeId),
        });
      }
    }

    return [...deduped.values()]
      .map((model, index) => ({
        model,
        index,
        rank: defaultIds.has(model.id)
          ? -2
          : model.id === DEFAULT_CODEX_MODEL
            ? -1
            : (orderLookup.get(model.id) ??
              PREFERRED_MODEL_ORDER.length + index),
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.model);
  }

  private formatModelName(value: string): string {
    return value
      .trim()
      .split("-")
      .map((part) => {
        const lower = part.toLowerCase();
        if (lower === "gpt") return "GPT";
        if (lower === "codex") return "Codex";
        if (lower === "mini") return "Mini";
        if (lower === "max") return "Max";
        if (lower.length === 0) return "";
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("-");
  }

  private mapEffortToReasoningEffort(
    reasoningEffort?: string,
    effort?: import("@yep-anywhere/shared").EffortLevel,
    thinking?: import("@yep-anywhere/shared").ThinkingConfig,
    modelSource?: CodexModelSourceDefinition,
    modelSlug?: string,
  ): string | undefined {
    const exactReasoningEffort = reasoningEffort?.trim();
    let mapped: string | undefined;
    if (exactReasoningEffort) {
      mapped = exactReasoningEffort;
    } else if (thinking?.type === "disabled") {
      mapped = "low";
    } else if (effort) {
      switch (effort) {
        case "low":
          mapped = "low";
          break;
        case "medium":
          mapped = "medium";
          break;
        case "high":
          mapped = "high";
          break;
        case "xhigh":
          mapped = "xhigh";
          break;
        case "max":
          mapped = "xhigh";
          break;
      }
    }
    // Clamp GPT-only tiers (xhigh/max/ultra) to a custom source's advertised
    // reasoning set (e.g. low/medium/high for DeepSeek). OpenAI is untouched.
    if (mapped && modelSource) {
      return getCodexModelSourceRegistry().resolveReasoningEffort(
        modelSource.id,
        modelSlug,
        mapped,
      );
    }
    return mapped;
  }

  private mapPermissionModeToThreadPolicy(
    permissionMode?: StartSessionOptions["permissionMode"],
  ): {
    approvalPolicy: CodexAskForApproval;
    sandbox: CodexSandboxMode;
  } {
    const applyOverrides = (policy: {
      approvalPolicy: CodexAskForApproval;
      sandbox: CodexSandboxMode;
    }) => ({
      approvalPolicy:
        CODEX_POLICY_OVERRIDES.approvalPolicy ?? policy.approvalPolicy,
      sandbox: CODEX_POLICY_OVERRIDES.sandbox ?? policy.sandbox,
    });

    if (permissionMode === "bypassPermissions") {
      return applyOverrides({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    }

    if (permissionMode === "plan") {
      return applyOverrides({
        approvalPolicy: "on-request",
        sandbox: "read-only",
      });
    }

    return applyOverrides({
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
  }

  private normalizeCodexForkExcludedTurnCount(value?: number): number | null {
    if (value === undefined) return null;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        "Codex edit fork requires rollbackNumTurns to be a positive safe integer",
      );
    }
    return value;
  }

  /**
   * Start a new Codex session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue({
      preserveAttachments: true,
      preserveCodexInputs: true,
      preserveClientMetadata: true,
    });
    const abortController = new AbortController();
    const runtimeState: CodexTurnRuntimeState = {
      threadId: options.resumeSessionId ?? "",
      activeTurnId: null,
      ready: false,
    };

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    let activeClient: CodexAppServerClient | null = null;
    const iterator = this.runSession(
      options,
      queue,
      abortController.signal,
      runtimeState,
      (client) => {
        activeClient = client;
      },
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        activeClient?.close();
      },
      isProcessAlive: () => activeClient?.isAlive() ?? false,
      get pid() {
        return activeClient?.pid;
      },
      interrupt: async () => {
        const client = activeClient;
        const threadId = runtimeState.threadId;
        const turnId = runtimeState.activeTurnId;
        if (
          !client ||
          !client.isAlive() ||
          !runtimeState.ready ||
          !threadId ||
          !turnId
        ) {
          throw new Error("Codex turn interrupt requires an active turn");
        }
        const params: TurnInterruptParams = { threadId, turnId };
        await client.request<TurnInterruptResponse>("turn/interrupt", params);
      },
      codexControls: {
        capabilities: CODEX_NATIVE_CAPABILITIES,
        invoke: (request) =>
          this.invokeCodexNativeControl({
            getClient: () => activeClient,
            runtimeState,
            cwd: options.cwd,
            request,
          }),
      },
      getGoal: async () => {
        return this.codexGoalToProviderState(
          () => activeClient,
          runtimeState,
          options.cwd,
          "show",
        );
      },
      goalAction: async (action, objective) => {
        return this.codexGoalToProviderState(
          () => activeClient,
          runtimeState,
          options.cwd,
          action,
          objective,
        );
      },
      steer: async (message) => {
        if (!activeClient) return false;
        if (!runtimeState.threadId || !runtimeState.activeTurnId) return false;

        const { internalPrompt } = getUserPromptProjection(message);
        if (!internalPrompt) return false;

        try {
          const expectedTurnId = runtimeState.activeTurnId;
          const params: TurnSteerParams = {
            threadId: runtimeState.threadId,
            clientUserMessageId: message.uuid,
            input: buildCodexUserInput(message, internalPrompt),
            expectedTurnId,
          };
          const result = await activeClient.request<TurnSteerResponse>(
            "turn/steer",
            params,
          );
          const acceptedTurnId = this.getOptionalString(result?.turnId);
          if (!acceptedTurnId || acceptedTurnId !== expectedTurnId) {
            log.warn(
              {
                threadId: runtimeState.threadId,
                expectedTurnId,
                acceptedTurnId: acceptedTurnId ?? null,
              },
              "Codex turn/steer returned an invalid turn identity; caller should queue instead",
            );
            return false;
          }
          return { accepted: true, turnId: acceptedTurnId };
        } catch (error) {
          log.warn(
            {
              threadId: runtimeState.threadId,
              turnId: runtimeState.activeTurnId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Codex turn/steer failed; caller should queue message instead",
          );
          return false;
        }
      },
    };
  }

  /**
   * Adapt the provider-neutral goal lifecycle (`ProviderGoalAction`) to Codex's
   * native `thread/goal/*` controls and format the structured `ThreadGoal`
   * response as a `ProviderGoalState` text summary.
   *
   * Action mapping:
   * - "show" → `thread/goal/get` (read-only)
   * - "set" → `thread/goal/set` with an active objective
   * - "replace" → `thread/goal/clear`, then `thread/goal/set` with an active
   *   objective so usage and budget state do not leak from the old goal
   * - "pause" → `thread/goal/set` with `status: "paused"`
   * - "resume" → `thread/goal/set` with `status: "active"`
   * - "clear" → `thread/goal/clear`
   */
  private async codexGoalToProviderState(
    getClient: () => CodexAppServerClient | null,
    runtimeState: CodexTurnRuntimeState,
    cwd: string,
    action: ProviderGoalAction | "show",
    objective?: string,
  ): Promise<ProviderGoalState> {
    const client = getClient();
    if (!client?.isAlive() || !runtimeState.ready || !runtimeState.threadId) {
      throw new Error("Codex goal requires an active session");
    }

    if (action === "clear") {
      const result = await this.invokeCodexNativeControl({
        getClient,
        runtimeState,
        cwd,
        request: { control: "thread/goal/clear" },
      });
      if (!result.ok) {
        throw new Error(result.error?.message ?? "Goal clear failed");
      }
      const cleared =
        result.control === "thread/goal/clear" && result.data.cleared;
      return {
        response: cleared ? "Goal cleared." : "No goal to clear.",
        startedTurn: false,
      };
    }

    if (action === "show") {
      const result = await this.invokeCodexNativeControl({
        getClient,
        runtimeState,
        cwd,
        request: { control: "thread/goal/get" },
      });
      if (!result.ok) {
        throw new Error(result.error?.message ?? "Goal fetch failed");
      }
      const goal =
        result.control === "thread/goal/get" ? result.data.goal : null;
      return {
        response: formatCodexGoal(goal),
        startedTurn: false,
      };
    }

    if (action === "replace") {
      const clearResult = await this.invokeCodexNativeControl({
        getClient,
        runtimeState,
        cwd,
        request: { control: "thread/goal/clear" },
      });
      if (!clearResult.ok) {
        throw new Error(clearResult.error?.message ?? "Goal clear failed");
      }
    }

    const setStatus: CodexThreadGoalStatus | undefined =
      action === "pause"
        ? "paused"
        : action === "resume" || action === "set" || action === "replace"
          ? "active"
          : undefined;
    const result = await this.invokeCodexNativeControl({
      getClient,
      runtimeState,
      cwd,
      request: {
        control: "thread/goal/set",
        ...(objective !== undefined ? { objective } : {}),
        ...(setStatus !== undefined ? { status: setStatus } : {}),
      },
    });
    if (!result.ok) {
      throw new Error(result.error?.message ?? "Goal set failed");
    }
    const goal = result.control === "thread/goal/set" ? result.data.goal : null;
    return {
      response: formatCodexGoal(goal),
      // `thread/goal/set` returns before its runtime effects are authoritative:
      // an active goal may subsequently start an automatic continuation. The
      // current neutral response cannot observe that notification, so this
      // compatibility field must not be used as Codex turn-lifecycle truth.
      startedTurn: false,
    };
  }

  private async invokeCodexNativeControl(input: {
    getClient: () => CodexAppServerClient | null;
    runtimeState: CodexTurnRuntimeState;
    cwd: string;
    request: CodexNativeControlRequest;
  }): Promise<CodexNativeControlResult> {
    const { request, runtimeState } = input;
    if (!CODEX_NATIVE_CAPABILITIES.methods[request.control]) {
      return codexControlFailure(
        request.control,
        "experimental_api_disabled",
        `${request.control} requires Codex experimentalApi, which is disabled for this session`,
      );
    }

    const client = input.getClient();
    if (!client || !runtimeState.ready || !runtimeState.threadId) {
      return codexControlFailure(
        request.control,
        "not_ready",
        "Codex app-server session is not ready",
        true,
      );
    }

    try {
      switch (request.control) {
        case "skills/list": {
          const data = await client.request<
            CodexNativeControlDataMap["skills/list"]
          >("skills/list", {
            cwds: [input.cwd],
            forceReload: request.forceReload ?? false,
          });
          return { ok: true, control: request.control, data };
        }

        case "review/start": {
          const data = await client.request<
            CodexNativeControlDataMap["review/start"]
          >("review/start", {
            threadId: runtimeState.threadId,
            target: request.target,
            ...(request.delivery === undefined
              ? {}
              : { delivery: request.delivery }),
          });
          return { ok: true, control: request.control, data };
        }

        case "thread/compact/start": {
          const data = await client.request<
            CodexNativeControlDataMap["thread/compact/start"]
          >("thread/compact/start", { threadId: runtimeState.threadId });
          return { ok: true, control: request.control, data };
        }

        case "thread/goal/get": {
          const data = await client.request<
            CodexNativeControlDataMap["thread/goal/get"]
          >("thread/goal/get", { threadId: runtimeState.threadId });
          return { ok: true, control: request.control, data };
        }

        case "thread/goal/set": {
          const objective = request.objective;
          if (
            typeof objective === "string" &&
            (objective.trim().length === 0 || objective.length > 4_000)
          ) {
            return codexControlFailure(
              request.control,
              "invalid_request",
              "Goal objective must contain 1 to 4000 characters",
            );
          }
          if (
            request.tokenBudget !== undefined &&
            request.tokenBudget !== null &&
            (!Number.isSafeInteger(request.tokenBudget) ||
              request.tokenBudget <= 0)
          ) {
            return codexControlFailure(
              request.control,
              "invalid_request",
              "Goal tokenBudget must be a positive safe integer or null",
            );
          }
          const data = await client.request<
            CodexNativeControlDataMap["thread/goal/set"]
          >("thread/goal/set", {
            threadId: runtimeState.threadId,
            ...(request.objective === undefined
              ? {}
              : { objective: request.objective }),
            ...(request.status === undefined ? {} : { status: request.status }),
            ...(request.tokenBudget === undefined
              ? {}
              : { tokenBudget: request.tokenBudget }),
          });
          return { ok: true, control: request.control, data };
        }

        case "thread/goal/clear": {
          const data = await client.request<
            CodexNativeControlDataMap["thread/goal/clear"]
          >("thread/goal/clear", { threadId: runtimeState.threadId });
          return { ok: true, control: request.control, data };
        }

        case "thread/shellCommand": {
          if (!request.confirmed) {
            return codexControlFailure(
              request.control,
              "invalid_request",
              "thread/shellCommand requires explicit confirmation because it runs unsandboxed",
            );
          }
          if (request.command.trim().length === 0) {
            return codexControlFailure(
              request.control,
              "invalid_request",
              "Shell command must not be empty",
            );
          }
          const data = await client.request<
            CodexNativeControlDataMap["thread/shellCommand"]
          >("thread/shellCommand", {
            threadId: runtimeState.threadId,
            command: request.command,
          });
          return { ok: true, control: request.control, data };
        }

        case "thread/backgroundTerminals/list":
        case "thread/backgroundTerminals/terminate":
        case "thread/backgroundTerminals/clean":
          return codexControlFailure(
            request.control,
            "experimental_api_disabled",
            `${request.control} requires Codex experimentalApi, which is disabled for this session`,
          );
      }
    } catch (error) {
      log.warn(
        {
          control: request.control,
          threadId: runtimeState.threadId,
          errorCode:
            error instanceof CodexJsonRpcError ? error.code : undefined,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "Codex native control request failed",
      );
      if (error instanceof CodexJsonRpcError) {
        if (error.code === -32601) {
          return codexControlFailure(
            request.control,
            "unsupported_method",
            `Codex app-server does not support ${request.control}`,
          );
        }
        if (error.code === -32602) {
          return codexControlFailure(
            request.control,
            "invalid_request",
            "Codex app-server rejected invalid control parameters",
          );
        }
        return codexControlFailure(
          request.control,
          "provider_error",
          error.code === -32001
            ? "Codex app-server is overloaded; retry the control request"
            : "Codex app-server control request failed",
          error.code === -32001,
        );
      }
      return codexControlFailure(
        request.control,
        "provider_error",
        "Codex app-server control request failed",
      );
    }
  }

  /**
   * Await one JSON-RPC request while yielding only the client's safe overload
   * decision. Raw JSON-RPC error messages/data never enter the UI projection.
   */
  private async *requestTrackedWithRetryProjection<T>(input: {
    appServer: CodexAppServerClient;
    method: string;
    params?: unknown;
    metadata?: AppServerRequestMetadata;
    sessionId?: () => string | undefined;
    onRetry?: (
      update: AppServerRetryUpdate,
    ) => Promise<CodexEventEnvelope | undefined>;
  }): AsyncGenerator<
    SDKMessage,
    { requestId: JsonRpcId; result: T },
    undefined
  > {
    const updates = new AsyncQueue<{
      update: AppServerRetryUpdate;
      canonicalEvent?: CodexEventEnvelope;
    }>();
    const request = input.appServer.requestTracked<T>(
      input.method,
      input.params,
      input.metadata,
      async (update) => {
        const canonicalEvent = await input.onRetry?.(update);
        updates.push({
          update,
          ...(canonicalEvent ? { canonicalEvent } : {}),
        });
      },
    );
    const settled = request.then(
      (result) => ({ kind: "result" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    let nextUpdate = updates.shift().then(
      (value) => ({ kind: "retry" as const, value }),
      () => ({ kind: "closed" as const }),
    );

    try {
      for (;;) {
        const outcome = await Promise.race([settled, nextUpdate]);
        if (outcome.kind === "retry") {
          yield buildCodexRetryWarning(
            outcome.value.update,
            input.sessionId?.(),
            outcome.value.canonicalEvent,
          );
          nextUpdate = updates.shift().then(
            (value) => ({ kind: "retry" as const, value }),
            () => ({ kind: "closed" as const }),
          );
          continue;
        }
        if (outcome.kind === "result") return outcome.result;
        if (outcome.kind === "error") throw outcome.error;
        throw new Error("Codex retry status channel closed unexpectedly");
      }
    } finally {
      updates.close(new Error("Codex request settled"));
    }
  }

  /**
   * Main session loop using codex app-server.
   */
  private async *runSession(
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
    runtimeState: CodexTurnRuntimeState,
    setActiveClient: (client: CodexAppServerClient) => void,
  ): AsyncIterableIterator<SDKMessage> {
    // Resolve the session's Codex model source and start the app-server with
    // its provider/catalog overrides so model discovery, catalog, auth, and the
    // thread `modelProvider` all point at the same source.
    const registry = getCodexModelSourceRegistry();
    const modelSource = registry.require(
      options.codexModelProvider ?? DEFAULT_CODEX_MODEL_PROVIDER,
    );
    const codexEnv = this.getCodexEnv();
    let appServer: CodexAppServerClient | undefined;
    let startupStage = "transport-selection";
    let transportKind: "stdio" | "bridge-websocket" = "stdio";

    let sessionId = options.resumeSessionId ?? "";
    let eventIngress: CodexEventIngress | null = null;
    const startupRetryUpdates: AppServerRetryUpdate[] = [];
    const captureStartupRetry = async (update: AppServerRetryUpdate) => {
      startupRetryUpdates.push(update);
      return undefined;
    };
    let projectionMode: CodexEventProjectionMode = "shadow";
    const usageByTurnId = new Map<string, TokenUsageSnapshot>();
    const customToolContexts = new Map<string, CodexToolCallContext>();
    const shadowToolContexts = new Map<string, CodexToolCallContext>();
    // Accumulated live stdout/stderr per command item (itemId-turnId), so the
    // UI can stream command output like the Codex TUI does.
    const commandOutputBuffers = new Map<string, string>();
    const shadowCommandOutputBuffers = new Map<string, string>();
    const canonicalRetryableErrorsByTurnId = new Map<
      string,
      CanonicalCodexError
    >();
    const legacyRetryableErrorsByTurnId = new Map<
      string,
      CanonicalCodexError
    >();
    let generatedArtifactRuntime:
      | {
          uploadManager: UploadManager;
          materializer: GeneratedArtifactMaterializer;
        }
      | undefined;
    const getGeneratedArtifactRuntime = async () => {
      if (generatedArtifactRuntime) return generatedArtifactRuntime;
      const uploadManager =
        this.config.generatedArtifactUploadManager ?? new UploadManager();
      generatedArtifactRuntime = {
        uploadManager,
        materializer: new GeneratedArtifactMaterializer({ uploadManager }),
      };
      await uploadManager
        .cleanupExpiredTaskAttachments({ limit: 25 })
        .catch(() => {
          log.warn(
            { sessionId: sessionId || undefined },
            "Generated artifact retention cleanup failed safely",
          );
        });
      return generatedArtifactRuntime;
    };
    const logMessage = (message: SDKMessage): SDKMessage => {
      const messageSessionId =
        typeof (message as { session_id?: unknown }).session_id === "string"
          ? ((message as { session_id: string }).session_id ?? "unknown")
          : sessionId || "unknown";
      logSDKMessage(messageSessionId, message, { provider: "codex" });
      return message;
    };

    try {
      const bridgeTarget = await this.resolveBridgeExecutionTarget(options);
      transportKind = bridgeTarget ? "bridge-websocket" : "stdio";
      const codexCommand = bridgeTarget
        ? "codex-bridge"
        : await this.resolveCodexCommand();
      startupStage = "transport-connect";
      appServer = new CodexAppServerClient(
        codexCommand,
        options.cwd,
        codexEnv,
        [
          ...registry.buildAppServerArgs(modelSource),
          ...getCodexMcpAppServerArgs(options.codexMcpMode),
        ],
        bridgeTarget
          ? {
              kind: "websocket",
              url: bridgeTarget.url,
              ...(bridgeTarget.headers
                ? { headers: bridgeTarget.headers }
                : {}),
            }
          : undefined,
      );
      setActiveClient(appServer);
      appServer.setServerRequestHandler(async (request) => {
        const ingress = eventIngress;
        try {
          const result = await this.handleServerRequestApproval(
            request,
            options,
            signal,
          );
          if (ingress) {
            await ingress.ingestServerRequestResolution({
              requestId: request.id,
              method: request.method,
              result,
            });
          }
          return result;
        } catch (error) {
          if (ingress) {
            await ingress.ingestServerRequestResolution({
              requestId: request.id,
              method: request.method,
              error,
            });
          }
          throw error;
        }
      });

      await appServer.connect();

      startupStage = "initialize";
      yield* this.requestTrackedWithRetryProjection<{ userAgent: string }>({
        appServer,
        method: "initialize",
        params: {
          clientInfo: {
            name: this.getCodexClientName(),
            version: "dev",
          },
          capabilities: null,
        },
        sessionId: () => sessionId || options.resumeSessionId,
        onRetry: captureStartupRetry,
      });
      appServer.notify("initialized");

      // Read the same app-server's effective config for this cwd. This is both
      // substantially faster than spawning `codex mcp list --json` and keeps
      // project-level .codex/config.toml layers aligned with the thread.
      startupStage = "config-read";
      const configRead = (yield* this.requestTrackedWithRetryProjection<{
        config?: unknown;
      }>({
        appServer,
        method: "config/read",
        params: {
          includeLayers: false,
          cwd: options.cwd,
        },
        sessionId: () => sessionId || options.resumeSessionId,
        onRetry: captureStartupRetry,
      })).result;
      const mcpProfile = resolveCodexMcpThreadProfile(
        options.codexMcpMode,
        configRead.config,
      );

      const policy = this.mapPermissionModeToThreadPolicy(
        options.permissionMode,
      );
      const requestedModel = normalizeCodexModelOption(options.model);
      if (options.model && !requestedModel) {
        log.warn(
          {
            sessionId: options.resumeSessionId ?? null,
            requestedModel: options.model,
            modelProvider: modelSource.id,
          },
          "Ignoring Codex model option that looks like a model provider",
        );
      }

      const threadResumeParams: ThreadResumeParams = {
        threadId: options.resumeSessionId ?? sessionId,
        model: requestedModel,
        modelProvider: modelSource.id,
        cwd: options.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        config: mcpProfile.threadConfig,
      };
      const threadStartParams: ThreadStartParams = {
        model: requestedModel,
        modelProvider: modelSource.id,
        cwd: options.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        config: mcpProfile.threadConfig,
      };
      const forkExcludedTurnCount = this.normalizeCodexForkExcludedTurnCount(
        options.rollbackNumTurns,
      );
      if (forkExcludedTurnCount !== null && !options.resumeSessionId) {
        throw new Error("Codex edit fork requires a source session ID");
      }

      let threadResult:
        | ThreadResumeResponse
        | ThreadStartResponse
        | ThreadForkResponse;
      let threadExchange: {
        requestId: JsonRpcId;
        method: "thread/resume" | "thread/start";
        params: ThreadResumeParams | ThreadStartParams;
        result: ThreadResumeResponse | ThreadStartResponse;
      };
      if (options.resumeSessionId) {
        try {
          startupStage = "thread-resume";
          const tracked =
            yield* this.requestTrackedWithRetryProjection<ThreadResumeResponse>(
              {
                appServer,
                method: "thread/resume",
                params: threadResumeParams,
                sessionId: () => sessionId || options.resumeSessionId,
                onRetry: captureStartupRetry,
              },
            );
          threadResult = tracked.result;
          threadExchange = {
            requestId: tracked.requestId,
            method: "thread/resume",
            params: threadResumeParams,
            result: tracked.result,
          };
        } catch (error) {
          if (
            !options.allowMissingRolloutReplacement ||
            !isNoRolloutFoundError(error, options.resumeSessionId)
          ) {
            throw error;
          }
          if (forkExcludedTurnCount !== null) {
            throw new Error(
              `Cannot fork Codex thread ${options.resumeSessionId}: the source has no persisted rollout`,
            );
          }
          log.warn(
            {
              event: "codex_provisional_thread_replaced",
              previousSessionId: options.resumeSessionId,
            },
            "Codex provisional thread had no rollout; starting replacement thread",
          );
          startupStage = "thread-start-replacement";
          const tracked =
            yield* this.requestTrackedWithRetryProjection<ThreadStartResponse>({
              appServer,
              method: "thread/start",
              params: threadStartParams,
              sessionId: () => sessionId || options.resumeSessionId,
              onRetry: captureStartupRetry,
            });
          threadResult = tracked.result;
          threadExchange = {
            requestId: tracked.requestId,
            method: "thread/start",
            params: threadStartParams,
            result: tracked.result,
          };
        }
      } else {
        startupStage = "thread-start";
        const tracked =
          yield* this.requestTrackedWithRetryProjection<ThreadStartResponse>({
            appServer,
            method: "thread/start",
            params: threadStartParams,
            sessionId: () => sessionId || options.resumeSessionId,
            onRetry: captureStartupRetry,
          });
        threadResult = tracked.result;
        threadExchange = {
          requestId: tracked.requestId,
          method: "thread/start",
          params: threadStartParams,
          result: tracked.result,
        };
      }

      sessionId = threadResult.thread.id;
      runtimeState.threadId = sessionId;
      startupStage = "thread-ready";
      if (
        forkExcludedTurnCount !== null &&
        sessionId !== options.resumeSessionId
      ) {
        throw new Error(
          `Cannot fork Codex thread ${options.resumeSessionId}: thread/resume returned unexpected source ID ${sessionId}`,
        );
      }

      let historyForkPending = forkExcludedTurnCount !== null;
      let forkParentSessionId: string | undefined;
      let forkStartedFresh = false;
      let forkExchange:
        | {
            requestId: JsonRpcId;
            method: "thread/fork";
            params: ThreadForkParams;
            result: ThreadForkResponse;
          }
        | {
            requestId: JsonRpcId;
            method: "thread/start";
            params: ThreadStartParams;
            result: ThreadStartResponse;
          }
        | undefined;
      if (forkExcludedTurnCount !== null) {
        const sourceThreadId = sessionId;
        forkParentSessionId = sourceThreadId;
        if (!Array.isArray(threadResult.thread.turns)) {
          throw new Error(
            `Cannot fork Codex thread ${sourceThreadId}: thread/resume did not return its turn history`,
          );
        }
        const sourceTurns = threadResult.thread.turns;
        if (forkExcludedTurnCount > sourceTurns.length) {
          throw new Error(
            `Cannot fork Codex thread ${sourceThreadId}: requested exclusion of ${forkExcludedTurnCount} trailing turns, but the source contains ${sourceTurns.length}`,
          );
        }

        const retainedTurnCount = sourceTurns.length - forkExcludedTurnCount;
        if (retainedTurnCount === 0) {
          // Stable 0.147 has no stable "fork before the first turn" boundary.
          // Start an empty child and persist its lineage in Yep metadata.
          log.info(
            {
              event: "codex_thread_fork_fresh_start_requested",
              sourceThreadId,
              excludedTurnCount: forkExcludedTurnCount,
            },
            "Starting an empty Codex child for a first-prompt edit fork",
          );
          const tracked =
            yield* this.requestTrackedWithRetryProjection<ThreadStartResponse>({
              appServer,
              method: "thread/start",
              params: threadStartParams,
              sessionId: () => sessionId || options.resumeSessionId,
              onRetry: captureStartupRetry,
            });
          threadResult = tracked.result;
          forkStartedFresh = true;
          forkExchange = {
            requestId: tracked.requestId,
            method: "thread/start",
            params: threadStartParams,
            result: tracked.result,
          };
        } else {
          const boundaryTurn = sourceTurns[retainedTurnCount - 1];
          if (
            !boundaryTurn ||
            typeof boundaryTurn.id !== "string" ||
            boundaryTurn.id.length === 0 ||
            boundaryTurn.status === "inProgress"
          ) {
            throw new Error(
              `Cannot fork Codex thread ${sourceThreadId}: the retained turn boundary is missing or still in progress`,
            );
          }

          // Use only the stable inclusive boundary. Keep the current-main MCP
          // enablement in thread config; never send experimental beforeTurnId.
          const forkParams: ThreadForkParams = {
            threadId: sourceThreadId,
            lastTurnId: boundaryTurn.id,
            model: requestedModel,
            modelProvider: modelSource.id,
            cwd: options.cwd,
            approvalPolicy: policy.approvalPolicy,
            sandbox: policy.sandbox,
            config: mcpProfile.threadConfig,
          };
          log.info(
            {
              event: "codex_thread_fork_requested",
              sourceThreadId,
              lastTurnId: boundaryTurn.id,
              retainedTurnCount,
              excludedTurnCount: forkExcludedTurnCount,
            },
            "Requesting a source-preserving Codex history fork",
          );
          const tracked =
            yield* this.requestTrackedWithRetryProjection<ThreadForkResponse>({
              appServer,
              method: "thread/fork",
              params: forkParams,
              sessionId: () => sessionId || options.resumeSessionId,
              onRetry: captureStartupRetry,
            });
          threadResult = tracked.result;
          forkExchange = {
            requestId: tracked.requestId,
            method: "thread/fork",
            params: forkParams,
            result: tracked.result,
          };
        }

        sessionId = threadResult.thread.id;
        if (!sessionId || sessionId === sourceThreadId) {
          throw new Error(
            `Codex edit fork did not return a new thread ID for source ${sourceThreadId}`,
          );
        }
        runtimeState.threadId = sessionId;
        log.info(
          {
            event: "codex_thread_fork_completed",
            sourceThreadId,
            sessionId,
            excludedTurnCount: forkExcludedTurnCount,
            lastTurnId:
              forkExchange?.method === "thread/fork"
                ? forkExchange.params.lastTurnId
                : null,
            fallback: forkExchange?.method === "thread/start",
          },
          "Created source-preserving Codex history fork",
        );
      }

      projectionMode = resolveCodexEventProjectionMode(
        {
          sessionId,
          accountId: options.codexEventAccountId,
        },
        this.eventSpineConfig,
      );
      eventIngress = await CodexEventIngress.create({
        store: this.eventStore,
        runtime: CODEX_EVENT_RUNTIME_IDENTITY,
        sessionId,
        ...(options.codexEventProjectId
          ? { projectId: options.codexEventProjectId }
          : {}),
        ...(options.codexEventAccountId
          ? { accountId: options.codexEventAccountId }
          : {}),
      });
      const activeEventIngress = eventIngress;
      for (const update of startupRetryUpdates) {
        await activeEventIngress.ingestClientRetry({
          requestId: update.requestId,
          method: update.method,
          retryStatus: update.retryStatus,
          threadId: sessionId,
          ...(update.metadata?.clientMessageId
            ? { clientMessageId: update.metadata.clientMessageId }
            : {}),
        });
      }
      await activeEventIngress.ingestClientExchange({
        ...threadExchange,
        result: threadExchange.result,
      });
      if (forkExchange) {
        await activeEventIngress.ingestClientExchange({
          requestId: forkExchange.requestId,
          method: forkExchange.method,
          params: forkExchange.params,
          result: forkExchange.result,
        });
      }
      await appServer.setEventObserver({
        onClientRequest: async (input) => {
          await activeEventIngress.ingestClientRequest({
            requestId: input.requestId,
            method: input.method,
            params: input.params,
            ...(input.metadata?.clientMessageId
              ? { clientMessageId: input.metadata.clientMessageId }
              : {}),
          });
        },
        onClientResponse: async (input) => {
          await activeEventIngress.ingestClientResponse({
            requestId: input.requestId,
            method: input.method,
            ...(input.result === undefined ? {} : { result: input.result }),
            ...(input.error === undefined ? {} : { error: input.error }),
            ...(input.metadata?.clientMessageId
              ? { clientMessageId: input.metadata.clientMessageId }
              : {}),
          });
        },
        onServerRequest: async (request) => {
          await activeEventIngress.ingestServerRequest({
            requestId: request.id,
            method: request.method,
            params: request.params,
          });
        },
        onServerNotification: async (notification) =>
          await activeEventIngress.ingestNotification(notification),
      });

      runtimeState.ready = true;

      // The app-server returns the provider it actually bound the thread to;
      // trust that effective value over the requested one for logs/metadata.
      const effectiveModelProvider =
        threadResult.modelProvider || modelSource.id;

      log.info(
        {
          sessionId,
          permissionMode: options.permissionMode ?? "default",
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          codexMcpMode: options.codexMcpMode ?? "standard",
          codexEventProjectionMode: projectionMode,
          codexEventConnectionId: eventIngress.connectionId,
          policyOverrides: {
            approvalPolicy: CODEX_POLICY_OVERRIDES.approvalPolicy,
            sandbox: CODEX_POLICY_OVERRIDES.sandbox,
          },
          model: requestedModel,
          codexModelProvider: effectiveModelProvider,
          transport: transportKind,
          credentialPresent: Boolean(
            modelSource.providerConfig?.envKey
              ? process.env[modelSource.providerConfig.envKey]
              : true,
          ),
        },
        "Started Codex app-server session thread",
      );

      // Emit init immediately with the real session ID.
      yield logMessage(
        withCodexTimestamp({
          type: "system",
          subtype: "init",
          session_id: sessionId,
          cwd: options.cwd,
          model: threadResult.model,
          modelProvider: effectiveModelProvider,
          reasoningEffort: threadResult.reasoningEffort,
          serviceTier: threadResult.serviceTier,
          ...(forkParentSessionId ? { forkParentSessionId } : {}),
        } as SDKMessage),
      );

      const messageGen = queue.generator();
      let isFirstMessage = !options.resumeSessionId || forkStartedFresh;
      let resumedActiveTurnId =
        transportKind === "bridge-websocket" && options.resumeSessionId
          ? findLastInProgressCodexTurnId(threadResult.thread.turns)
          : undefined;
      startupStage = "turn-runtime";

      for await (const message of messageGen) {
        if (signal.aborted) {
          break;
        }

        let { internalPrompt, publicPrompt } = getUserPromptProjection(message);
        if (!internalPrompt) {
          continue;
        }

        // Prepend global instructions to the first message of new sessions
        if (isFirstMessage && options.globalInstructions) {
          const prefix = `[Global context]\n${options.globalInstructions}\n\n---\n\n`;
          internalPrompt = `${prefix}${internalPrompt}`;
          publicPrompt = `${prefix}${publicPrompt}`;
          isFirstMessage = false;
        } else {
          isFirstMessage = false;
        }

        const turnStartParams: TurnStartParams = {
          threadId: sessionId,
          clientUserMessageId: message.uuid,
          input: buildCodexUserInput(message, internalPrompt),
          effort: this.mapEffortToReasoningEffort(
            options.reasoningEffort,
            options.effort,
            options.thinking,
            modelSource,
            options.model,
          ),
        };
        const retryObserver = async (update: AppServerRetryUpdate) =>
          await activeEventIngress.ingestClientRetry({
            requestId: update.requestId,
            method: update.method,
            retryStatus: update.retryStatus,
            threadId: sessionId,
            ...(update.metadata?.clientMessageId
              ? { clientMessageId: update.metadata.clientMessageId }
              : {}),
          });
        let turnResult: TurnStartResponse | undefined;
        let activeTurnId: string;
        let sourceEvent: "turn/start" | "turn/steer" = "turn/start";
        if (resumedActiveTurnId) {
          const expectedTurnId = resumedActiveTurnId;
          resumedActiveTurnId = undefined;
          const steerParams: TurnSteerParams = {
            threadId: sessionId,
            clientUserMessageId: message.uuid,
            input: buildCodexUserInput(message, internalPrompt),
            expectedTurnId,
          };
          try {
            const steer =
              yield* this.requestTrackedWithRetryProjection<TurnSteerResponse>({
                appServer,
                method: "turn/steer",
                params: steerParams,
                metadata: message.uuid
                  ? { clientMessageId: message.uuid }
                  : undefined,
                sessionId: () => sessionId,
                onRetry: retryObserver,
              });
            if (steer.result.turnId !== expectedTurnId) {
              throw new Error(
                "Codex turn/steer returned an unexpected active turn ID",
              );
            }
            activeTurnId = steer.result.turnId;
            sourceEvent = "turn/steer";
          } catch (error) {
            if (
              !(error instanceof CodexJsonRpcError) ||
              error.code !== -32602
            ) {
              throw error;
            }
            const latest = await appServer.request<ThreadReadResponse>(
              "thread/read",
              { threadId: sessionId, includeTurns: true },
            );
            const stillActiveTurnId = findLastInProgressCodexTurnId(
              latest.thread.turns,
            );
            if (stillActiveTurnId) {
              throw new Error(
                `Bridge-owned Codex active turn ${stillActiveTurnId} cannot accept direct input yet`,
                { cause: error },
              );
            }
            log.info(
              { sessionId, expectedTurnId },
              "Bridge-owned Codex turn completed before steer; starting a new turn",
            );
            turnResult =
              (yield* this.requestTrackedWithRetryProjection<TurnStartResponse>(
                {
                  appServer,
                  method: "turn/start",
                  params: turnStartParams,
                  metadata: message.uuid
                    ? { clientMessageId: message.uuid }
                    : undefined,
                  sessionId: () => sessionId,
                  onRetry: retryObserver,
                },
              )).result;
            activeTurnId = turnResult.turn.id;
          }
        } else {
          turnResult =
            (yield* this.requestTrackedWithRetryProjection<TurnStartResponse>({
              appServer,
              method: "turn/start",
              params: turnStartParams,
              metadata: message.uuid
                ? { clientMessageId: message.uuid }
                : undefined,
              sessionId: () => sessionId,
              onRetry: retryObserver,
            })).result;
          activeTurnId = turnResult.turn.id;
        }

        runtimeState.activeTurnId = activeTurnId;
        // Publish the provider-accepted echo only after turn/start returns the
        // authoritative turn identity. Process separately publishes the
        // optimistic admission echo with the same UUID.
        const userMessage = withCodexTimestamp({
          type: "user",
          uuid: message.uuid,
          tempId: message.tempId,
          session_id: sessionId,
          clientUserMessageId: message.uuid,
          turnId: activeTurnId,
          codexTurnId: activeTurnId,
          isOptimistic: false,
          message: {
            role: "user",
            content: publicPrompt,
          },
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, userMessage, {
          eventKind: "user_message",
          turnId: activeTurnId,
          phase: "accepted",
          sourceEvent,
        });
        yield logMessage(userMessage);
        if (historyForkPending) {
          historyForkPending = false;
          yield logMessage(
            withCodexTimestamp({
              type: "system",
              subtype: "history_fork_complete",
              uuid: `codex-history-fork-${activeTurnId}`,
              session_id: sessionId,
              forkParentSessionId,
              turnId: activeTurnId,
              messageUuid: message.uuid,
            } as SDKMessage),
          );
        }
        log.info(
          {
            sessionId,
            turnId: activeTurnId,
            turnStatus: turnResult?.turn.status ?? "inProgress",
            sourceEvent,
          },
          sourceEvent === "turn/steer"
            ? "Steered bridge-owned Codex turn"
            : "Started Codex app-server turn",
        );
        let turnComplete =
          turnResult !== undefined && turnResult.turn.status !== "inProgress";
        let emittedTurnError = false;

        while (!turnComplete && !signal.aborted) {
          const rawNotification = await appServer.nextNotification(signal);
          const canonicalEvent =
            rawNotification.canonicalEvent ??
            (await activeEventIngress.ingestNotification(rawNotification));
          const canonicalNotification =
            activeEventIngress.notificationFromEvent(canonicalEvent);

          if (canonicalNotification.method === "thread/tokenUsage/updated") {
            const usage = this.extractTurnUsage(canonicalNotification.params);
            if (usage) {
              usageByTurnId.set(usage.turnId, usage.snapshot);
            }
          }

          let messages: SDKMessage[];
          if (projectionMode === "legacy") {
            messages = this.convertNotificationToSDKMessages(
              rawNotification,
              sessionId,
              usageByTurnId,
              customToolContexts,
              commandOutputBuffers,
              true,
              false,
              legacyRetryableErrorsByTurnId,
            );
          } else {
            const canonicalMessages = this.convertNotificationToSDKMessages(
              canonicalNotification,
              sessionId,
              usageByTurnId,
              projectionMode === "primary"
                ? customToolContexts
                : shadowToolContexts,
              projectionMode === "primary"
                ? commandOutputBuffers
                : shadowCommandOutputBuffers,
              projectionMode === "primary",
              true,
              canonicalRetryableErrorsByTurnId,
            );
            const legacyMessages = this.convertNotificationToSDKMessages(
              rawNotification,
              sessionId,
              usageByTurnId,
              projectionMode === "shadow"
                ? customToolContexts
                : shadowToolContexts,
              projectionMode === "shadow"
                ? commandOutputBuffers
                : shadowCommandOutputBuffers,
              projectionMode === "shadow",
              false,
              legacyRetryableErrorsByTurnId,
            );
            const parity = activeEventIngress.recordProjectionParity(
              canonicalEvent,
              legacyMessages,
              canonicalMessages,
            );
            if (
              parity.lastMismatch?.eventId === canonicalEvent.eventId &&
              parity.mismatched > 0
            ) {
              log.warn(
                {
                  sessionId,
                  method: parity.lastMismatch.method,
                  eventId: canonicalEvent.eventId,
                  projectionMode,
                  legacyHash: parity.lastMismatch.legacyHash,
                  canonicalHash: parity.lastMismatch.canonicalHash,
                  mismatchCount: parity.mismatched,
                  comparedCount: parity.compared,
                },
                "Canonical Codex projection differs from legacy projection",
              );
            }
            messages =
              projectionMode === "primary"
                ? this.attachCanonicalCodexItem(
                    canonicalMessages,
                    canonicalEvent,
                    sessionId,
                  )
                : legacyMessages;
          }
          if (
            canonicalEvent.method === "item/completed" &&
            canonicalEvent.threadId &&
            canonicalEvent.turnId
          ) {
            const materializationItem =
              selectCanonicalGeneratedArtifactSourceItem(
                rawNotification,
                canonicalEvent,
              );
            if (materializationItem) {
              const { materializer } = await getGeneratedArtifactRuntime();
              const generated = await materializer.materialize(
                {
                  lifecycle: "completed",
                  item: materializationItem,
                  threadId: canonicalEvent.threadId,
                  turnId: canonicalEvent.turnId,
                  replay: canonicalEvent.source.replay,
                },
                {
                  projectId:
                    options.codexEventProjectId ?? encodeProjectId(options.cwd),
                  sessionId,
                  taskId: message.uuid ?? activeTurnId,
                  workspaceRoot: options.cwd,
                  threadId: canonicalEvent.threadId,
                  turnId: canonicalEvent.turnId,
                  canonicalEventId: canonicalEvent.eventId,
                  canonicalEventSequence: canonicalEvent.sequence,
                },
              );
              if (
                generated.artifacts.length > 0 ||
                generated.warnings.length > 0
              ) {
                messages = this.attachCanonicalCodexItem(
                  messages,
                  canonicalEvent,
                  sessionId,
                ).map(
                  (sdkMessage) =>
                    ({
                      ...sdkMessage,
                      ...(generated.artifacts.length > 0
                        ? { codexGeneratedArtifacts: generated.artifacts }
                        : {}),
                      ...(generated.warnings.length > 0
                        ? {
                            codexGeneratedArtifactWarnings: generated.warnings,
                          }
                        : {}),
                    }) as SDKMessage,
                );
              }
            }
          }
          for (const msg of messages) {
            yield logMessage(msg);
          }

          if (
            this.isTurnTerminalNotification(canonicalNotification, activeTurnId)
          ) {
            if (canonicalNotification.method === "error") {
              emittedTurnError = true;
            }
            turnComplete = true;
          }
        }
        runtimeState.activeTurnId = null;

        // If turn failed without an emitted error notification, surface start response error.
        if (
          !emittedTurnError &&
          turnResult?.turn.status === "failed" &&
          turnResult.turn.error?.message
        ) {
          const codexError = classifyCodexError(turnResult.turn.error, {
            correlationId: activeTurnId,
          });
          yield logMessage({
            type: "error",
            session_id: sessionId,
            error: codexError.publicMessage,
            codexError,
            turnId: activeTurnId,
            codexTurnId: activeTurnId,
            clientUserMessageId: message.uuid,
          } as SDKMessage);
        }

        yield logMessage({
          type: "result",
          session_id: sessionId,
          turnId: activeTurnId,
          codexTurnId: activeTurnId,
          clientUserMessageId: message.uuid,
        } as SDKMessage);
      }
    } catch (error) {
      const classifiedError =
        transportKind === "bridge-websocket"
          ? new Error("Codex bridge execution failed", { cause: error })
          : error;
      const codexError = classifyCodexError(classifiedError);
      log.error(
        {
          code: codexError.code,
          category: codexError.category,
          retryable: codexError.retryable,
          startupStage,
          transport: transportKind,
          errorType: error instanceof Error ? error.name : typeof error,
          rpcCode: error instanceof CodexJsonRpcError ? error.code : undefined,
        },
        "Error in codex app-server session",
      );
      if (!signal.aborted) {
        yield logMessage({
          type: "error",
          session_id: sessionId,
          error: codexError.publicMessage,
          codexError,
        } as SDKMessage);
      }
    } finally {
      runtimeState.activeTurnId = null;
      runtimeState.ready = false;
      appServer?.close();
    }

    yield logMessage({
      type: "result",
      session_id: sessionId,
    } as SDKMessage);
  }

  private isTurnTerminalNotification(
    notification: JsonRpcNotification,
    turnId: string,
  ): boolean {
    if (notification.method === "turn/completed") {
      const params = this.asTurnCompletedNotification(notification.params);
      return params?.turn.id === turnId;
    }

    if (notification.method === "error") {
      const params = this.asErrorNotification(notification.params);
      return params?.turnId === turnId && !params.willRetry;
    }

    return false;
  }

  private extractTurnUsage(params: unknown): {
    turnId: string;
    snapshot: TokenUsageSnapshot;
  } | null {
    const notification = this.asThreadTokenUsageUpdatedNotification(params);
    if (!notification) return null;

    const freshInputTokens = notification.tokenUsage.last.inputTokens;
    const compactedContextTokens =
      typeof notification.tokenUsage.last.totalTokens === "number"
        ? notification.tokenUsage.last.totalTokens
        : 0;

    return {
      turnId: notification.turnId,
      snapshot: {
        // Immediately after compaction Codex reports inputTokens=0 and puts
        // the compacted summary size in last.totalTokens. Keep this aligned
        // with the persisted reader and bridge-owned session path.
        inputTokens:
          freshInputTokens > 0 ? freshInputTokens : compactedContextTokens,
        outputTokens: notification.tokenUsage.last.outputTokens,
        cachedInputTokens: notification.tokenUsage.last.cachedInputTokens,
        modelContextWindow: notification.tokenUsage.modelContextWindow,
      },
    };
  }

  private async handleServerRequestApproval(
    request: JsonRpcServerRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<unknown> {
    log.info(
      {
        method: request.method,
        requestId: request.id,
        permissionMode: options.permissionMode ?? "default",
      },
      "Codex app-server sent server request",
    );

    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};

    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const commandParams = this.asCommandExecutionRequestApprovalParams(
          request.params,
        );
        if (!commandParams) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex command approval params invalid; declining",
          );
          return { decision: "decline" as CommandExecutionApprovalDecision };
        }
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: commandParams.threadId,
            turnId: commandParams.turnId,
            itemId: commandParams.itemId,
            command: commandParams.command,
            cwd: commandParams.cwd,
          },
          "Handling Codex command approval request",
        );
        const availableDecisions = getEffectiveCommandApprovalDecisions(
          commandParams as unknown as Record<string, unknown>,
        );
        const toolInput = {
          requestMethod: request.method,
          approvalKind: "command_execution",
          command: commandParams.command,
          cwd: commandParams.cwd,
          reason: commandParams.reason,
          commandActions: commandParams.commandActions ?? [],
          additionalPermissions: commandParams.additionalPermissions ?? null,
          networkApprovalContext: commandParams.networkApprovalContext ?? null,
          proposedExecpolicyAmendment:
            commandParams.proposedExecpolicyAmendment ?? null,
          proposedNetworkPolicyAmendments:
            commandParams.proposedNetworkPolicyAmendments ?? null,
          availableDecisions,
          approvalId: commandParams.approvalId ?? null,
          threadId: commandParams.threadId,
          turnId: commandParams.turnId,
          itemId: commandParams.itemId,
        };
        const sessionDecision = availableDecisions.includes("acceptForSession")
          ? ("acceptForSession" as const)
          : undefined;
        const alwaysDecision =
          availableDecisions.find(isPolicyAmendmentCommandApprovalDecision) ??
          sessionDecision;
        const decision: CommandExecutionApprovalDecision =
          await this.resolveApprovalDecision<CommandExecutionApprovalDecision>(
            options,
            "Bash",
            toolInput,
            signal,
            "accept",
            "decline",
            request.id,
            sessionDecision,
            "cancel",
            alwaysDecision,
          );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: commandParams.threadId,
            turnId: commandParams.turnId,
            itemId: commandParams.itemId,
            decision,
          },
          "Resolved Codex command approval request",
        );
        return { decision };
      }

      case "item/fileChange/requestApproval": {
        const fileParams = this.asFileChangeRequestApprovalParams(
          request.params,
        );
        if (!fileParams) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex file-change approval params invalid; declining",
          );
          return { decision: "decline" as FileChangeApprovalDecision };
        }
        const grantRoot = fileParams.grantRoot ?? null;
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: fileParams.threadId,
            turnId: fileParams.turnId,
            itemId: fileParams.itemId,
            grantRoot,
          },
          "Handling Codex file-change approval request",
        );
        const toolInput = {
          requestMethod: request.method,
          approvalKind: "file_change",
          file_path: grantRoot ?? undefined,
          reason: fileParams.reason ?? null,
          grantRoot,
          availableDecisions: [
            "accept",
            "acceptForSession",
            "decline",
            "cancel",
          ],
          threadId: fileParams.threadId,
          turnId: fileParams.turnId,
          itemId: fileParams.itemId,
        };
        const decision: FileChangeApprovalDecision =
          await this.resolveApprovalDecision(
            options,
            "Edit",
            toolInput,
            signal,
            "accept",
            "decline",
            request.id,
            "acceptForSession",
            "cancel",
            "acceptForSession",
          );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: fileParams.threadId,
            turnId: fileParams.turnId,
            itemId: fileParams.itemId,
            decision,
          },
          "Resolved Codex file-change approval request",
        );
        return { decision };
      }

      case "item/permissions/requestApproval": {
        const threadId = this.getOptionalString(params.threadId);
        const turnId = this.getOptionalString(params.turnId);
        const itemId = this.getOptionalString(params.itemId);
        if (!threadId || !turnId || !itemId || !asRecord(params.permissions)) {
          throw new CodexJsonRpcError(
            -32602,
            "Invalid item/permissions/requestApproval params",
          );
        }

        const requestView = toCodexInteractiveRequestView(
          codexServerRequestId(request.id),
          "item/permissions/requestApproval",
          threadId,
          params,
          new Date().toISOString(),
        );
        const result = await this.requestToolApprovalResult(
          options,
          requestView.inputRequest.toolName ?? "Permissions",
          {
            ...(asRecord(requestView.inputRequest.toolInput) ?? {}),
            approvalPrompt: requestView.inputRequest.prompt,
            requestMethod: request.method,
          },
          signal,
          request.id,
        );
        const providerDecision = getProviderApprovalDecision(result);
        const response = buildCodexInteractiveResponse(
          "item/permissions/requestApproval",
          params,
          providerDecision,
        );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId,
            turnId,
            itemId,
            providerDecision,
          },
          "Resolved Codex permissions approval request",
        );
        return response;
      }

      case "mcpServer/elicitation/request": {
        const threadId = this.getOptionalString(params.threadId);
        const serverName = this.getOptionalString(params.serverName);
        const mode = this.getOptionalString(params.mode);
        const message = this.getOptionalString(params.message);
        if (
          !threadId ||
          !serverName ||
          !message ||
          (mode !== "form" && mode !== "openai/form" && mode !== "url") ||
          (mode === "url" &&
            (!this.getOptionalString(params.url) ||
              !this.getOptionalString(params.elicitationId))) ||
          (mode !== "url" && !("requestedSchema" in params))
        ) {
          throw new CodexJsonRpcError(
            -32602,
            "Invalid mcpServer/elicitation/request params",
          );
        }

        const requestView = toCodexInteractiveRequestView(
          codexServerRequestId(request.id),
          "mcpServer/elicitation/request",
          threadId,
          params,
          new Date().toISOString(),
        );
        const result = await this.requestToolApprovalResult(
          options,
          requestView.inputRequest.toolName ?? "MCP",
          {
            ...(asRecord(requestView.inputRequest.toolInput) ?? {}),
            approvalPrompt: requestView.inputRequest.prompt,
            requestMethod: request.method,
          },
          signal,
          request.id,
        );
        const providerDecision = getProviderApprovalDecision(result);
        const updatedInput = asRecord(result.updatedInput);
        const answers = updatedInput?.answers as
          | UserQuestionAnswers
          | undefined;
        const response = buildCodexInteractiveResponse(
          "mcpServer/elicitation/request",
          params,
          providerDecision,
          answers,
        ) as Record<string, unknown>;
        if (
          result.behavior === "deny" &&
          result.interrupt === true &&
          response.action === "decline"
        ) {
          response.action = "cancel";
        }
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId,
            turnId: this.getOptionalString(params.turnId),
            serverName,
            mode,
            providerDecision,
            action: response.action,
          },
          "Resolved Codex MCP elicitation request",
        );
        return response;
      }

      // Backward-compatible protocol variants.
      case "execCommandApproval": {
        const commandParts = Array.isArray(params.command)
          ? params.command.filter(
              (part): part is string => typeof part === "string",
            )
          : [];
        const toolInput = {
          requestMethod: request.method,
          approvalKind: "legacy_command_execution",
          command: commandParts.join(" "),
          cwd: this.getOptionalString(params.cwd),
          reason: this.getOptionalString(params.reason),
          parsedCmd: Array.isArray(params.parsedCmd) ? params.parsedCmd : [],
          callId: this.getOptionalString(params.callId),
        };
        const decision = await this.resolveApprovalDecision(
          options,
          "Bash",
          toolInput,
          signal,
          "approved",
          "denied",
          request.id,
        );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            decision,
            command: toolInput.command,
            cwd: toolInput.cwd,
          },
          "Resolved legacy Codex command approval request",
        );
        return { decision };
      }

      case "applyPatchApproval": {
        const fileChanges =
          params.fileChanges && typeof params.fileChanges === "object"
            ? (params.fileChanges as Record<string, unknown>)
            : {};
        const paths = Object.keys(fileChanges);
        const toolInput = {
          requestMethod: request.method,
          approvalKind: "legacy_file_change",
          changes: paths.map((path) => ({ path, kind: "update" })),
          reason: this.getOptionalString(params.reason),
          grantRoot: this.getOptionalString(params.grantRoot),
          callId: this.getOptionalString(params.callId),
        };
        const decision = await this.resolveApprovalDecision(
          options,
          "Edit",
          toolInput,
          signal,
          "approved",
          "denied",
          request.id,
        );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            decision,
            changedPathCount: paths.length,
            grantRoot: toolInput.grantRoot,
          },
          "Resolved legacy Codex apply-patch approval request",
        );
        return { decision };
      }

      case "item/tool/requestUserInput": {
        const requestInput = this.asToolRequestUserInputParams(request.params);
        if (!requestInput) {
          throw new CodexJsonRpcError(
            -32602,
            "Invalid item/tool/requestUserInput params",
          );
        }
        if (!options.onToolApproval) {
          throw new CodexJsonRpcError(
            -32601,
            "No interactive input handler is available",
          );
        }

        const requestView = toCodexInteractiveRequestView(
          codexServerRequestId(request.id),
          "item/tool/requestUserInput",
          requestInput.threadId,
          params,
          new Date().toISOString(),
        );
        const toolInput = {
          ...(asRecord(requestView.inputRequest.toolInput) ?? {}),
          requestMethod: request.method,
          isBlocking: requestInput.isBlocking,
          threadId: requestInput.threadId,
          turnId: requestInput.turnId,
          itemId: requestInput.itemId,
        };
        const timeoutMs = normalizeAutoResolutionMs(
          requestInput.autoResolutionMs,
        );
        const timeoutController =
          timeoutMs === null ? null : new AbortController();
        const approvalSignal = timeoutController
          ? AbortSignal.any([signal, timeoutController.signal])
          : signal;
        const timeout =
          timeoutController && timeoutMs !== null
            ? setTimeout(() => timeoutController.abort(), timeoutMs)
            : undefined;
        timeout?.unref?.();

        let result: ToolApprovalResult;
        try {
          result = await this.requestToolApprovalResult(
            options,
            requestView.inputRequest.toolName ?? "AskUserQuestion",
            toolInput,
            approvalSignal,
            request.id,
          );
        } finally {
          if (timeout) clearTimeout(timeout);
        }

        if (result.behavior !== "allow") {
          throw new CodexJsonRpcError(
            -32000,
            "Codex tool user input request was declined",
          );
        }
        const updatedInput = asRecord(result.updatedInput);
        const answers = updatedInput?.answers as
          | UserQuestionAnswers
          | undefined;
        const response = buildCodexInteractiveResponse(
          "item/tool/requestUserInput",
          params,
          getProviderApprovalDecision(result),
          answers,
        ) as ToolRequestUserInputResponse;
        log.info(
          {
            method: request.method,
            requestId: request.id,
            questionCount: requestInput.questions.length,
            threadId: requestInput.threadId,
            turnId: requestInput.turnId,
            itemId: requestInput.itemId,
            resolution: "answered",
          },
          "Resolved Codex tool user input request",
        );
        return response;
      }

      case "item/tool/call":
        return this.rejectUnownedServerCapability(
          request,
          "dynamic tools are not registered by this client",
        );

      case "account/chatgptAuthTokens/refresh":
        return this.rejectUnownedServerCapability(
          request,
          "ChatGPT auth-token refresh is not owned by this client",
        );

      case "attestation/generate":
        return this.rejectUnownedServerCapability(
          request,
          "attestation generation was not requested during initialization",
        );

      case "currentTime/read":
        return this.rejectUnownedServerCapability(
          request,
          "the experimental external-clock capability is disabled",
        );

      default: {
        log.warn(
          { method: request.method, requestId: request.id },
          "Unhandled codex server request",
        );
        throw new CodexJsonRpcError(
          -32601,
          `Unsupported Codex server request: ${request.method}`,
        );
      }
    }
  }

  private rejectUnownedServerCapability(
    request: JsonRpcServerRequest,
    reason: string,
  ): never {
    log.warn(
      {
        method: request.method,
        requestId: request.id,
        owner: "app-server-client",
        outcome: "rejected",
      },
      "Rejected disabled Codex server-request capability",
    );
    throw new CodexJsonRpcError(
      -32601,
      `Unsupported Codex server request: ${request.method} (${reason})`,
    );
  }

  private async requestToolApprovalResult(
    options: StartSessionOptions,
    toolName: string,
    toolInput: unknown,
    signal: AbortSignal,
    requestId?: JsonRpcId,
  ): Promise<ToolApprovalResult> {
    if (signal.aborted) {
      return {
        behavior: "deny",
        message: "Interactive approval request was aborted",
        interrupt: true,
      };
    }
    if (!options.onToolApproval) {
      log.warn(
        { toolName },
        "No onToolApproval handler available; denying Codex approval request",
      );
      return {
        behavior: "deny",
        message: "No interactive approval handler is available",
      };
    }

    let result: ToolApprovalResult;
    try {
      const requestMethod = asRecord(toolInput)?.requestMethod;
      result = await options.onToolApproval(toolName, toolInput, {
        signal,
        requestId:
          requestId === undefined ? undefined : codexServerRequestId(requestId),
        requestMethod:
          typeof requestMethod === "string" ? requestMethod : undefined,
        respectProviderDecision: true,
      });
    } catch (error) {
      const aborted =
        signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      log.warn(
        {
          toolName,
          errorName: error instanceof Error ? error.name : "UnknownError",
          aborted,
        },
        "onToolApproval threw; denying Codex approval request",
      );
      return {
        behavior: "deny",
        message: aborted
          ? "Interactive approval request was aborted"
          : "Interactive approval handler failed",
        ...(aborted ? { interrupt: true } : {}),
      };
    }

    log.info(
      {
        toolName,
        behavior: result.behavior,
        approvalScope: result.approvalScope ?? "once",
        providerDecision: result.providerDecision ?? null,
        interrupt: result.interrupt ?? false,
      },
      "Resolved tool approval callback result",
    );
    return result;
  }

  private async resolveApprovalDecision<TDecision>(
    options: StartSessionOptions,
    toolName: string,
    toolInput: unknown,
    signal: AbortSignal,
    allowDecision: TDecision,
    denyDecision: TDecision,
    requestId?: JsonRpcId,
    sessionDecision?: TDecision,
    cancelDecision?: TDecision,
    alwaysDecision?: TDecision,
  ): Promise<TDecision> {
    const result = await this.requestToolApprovalResult(
      options,
      toolName,
      toolInput,
      signal,
      requestId,
    );

    if (result.behavior === "allow" && result.providerDecision !== "deny") {
      if (
        result.providerDecision === "approve_always" ||
        (!result.providerDecision && result.approvalScope === "always")
      ) {
        return alwaysDecision ?? sessionDecision ?? allowDecision;
      }
      if (
        result.providerDecision === "approve_accept_edits" ||
        result.providerDecision === "approve_for_session"
      ) {
        return sessionDecision ?? allowDecision;
      }
      return allowDecision;
    }
    // An explicit user denial means native `decline`; `cancel` is reserved for
    // transport abort/cancellation paths without a selected native decision.
    if (result.providerDecision === "deny") return denyDecision;
    return result.interrupt && cancelDecision !== undefined
      ? cancelDecision
      : denyDecision;
  }

  private convertNotificationToSDKMessages(
    notification: JsonRpcNotification,
    sessionId: string,
    usageByTurnId: Map<string, TokenUsageSnapshot>,
    customToolContexts: Map<string, CodexToolCallContext> = new Map(),
    commandOutputBuffers: Map<string, string> = new Map(),
    emitProjectionDiagnostics = true,
    emitUnknownCompatibilityMessage = false,
    retryableErrorsByTurnId: Map<string, CanonicalCodexError> = new Map(),
  ): SDKMessage[] {
    switch (notification.method) {
      case "thread/tokenUsage/updated": {
        const usage = this.extractTurnUsage(notification.params);
        if (!usage) return [];
        return [
          withCodexTimestamp({
            type: "system",
            subtype: "turn_usage",
            session_id: sessionId,
            turnId: usage.turnId,
            codexTurnId: usage.turnId,
            usage: {
              input_tokens: usage.snapshot.inputTokens,
              output_tokens: usage.snapshot.outputTokens,
              cached_input_tokens: usage.snapshot.cachedInputTokens,
              model_context_window: usage.snapshot.modelContextWindow,
            },
          } as SDKMessage),
        ];
      }

      case "turn/completed": {
        const params = this.asTurnCompletedNotification(notification.params);
        const turnId = params?.turn.id ?? null;
        const turnStatus = params?.turn.status ?? "completed";
        if (turnId) {
          const keyPrefix = `${turnId}\0`;
          for (const key of commandOutputBuffers.keys()) {
            if (key.startsWith(keyPrefix)) commandOutputBuffers.delete(key);
          }
        }
        const usage = turnId ? usageByTurnId.get(turnId) : undefined;
        const message = withCodexTimestamp({
          type: "system",
          subtype: "turn_complete",
          session_id: sessionId,
          turnId,
          turnStatus,
          usage: usage
            ? {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cached_input_tokens: usage.cachedInputTokens,
                model_context_window: usage.modelContextWindow,
              }
            : undefined,
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "turn_complete",
          ...(turnId ? { turnId } : {}),
          phase: "completed",
          sourceEvent: notification.method,
        });
        if (turnStatus === "failed") {
          const classifiedError = classifyCodexError(
            params?.turn.error ?? notification.params,
            turnId ? { correlationId: turnId } : {},
          );
          const retryCause = turnId
            ? retryableErrorsByTurnId.get(turnId)
            : undefined;
          const retryExhausted =
            classifiedError.category === "unknown" && retryCause !== undefined;
          const codexError = retryExhausted ? retryCause : classifiedError;
          if (turnId) retryableErrorsByTurnId.delete(turnId);
          return [
            {
              type: "error",
              session_id: sessionId,
              error: codexError.publicMessage,
              codexError,
              ...(retryExhausted ? { codexRetryExhausted: true } : {}),
              ...(turnId ? { turnId } : {}),
            } as SDKMessage,
            message,
          ];
        }
        if (turnId) retryableErrorsByTurnId.delete(turnId);
        return [message];
      }

      case "error": {
        const params = this.asErrorNotification(notification.params);
        const codexError = classifyCodexError(
          params ?? notification.params,
          params?.turnId ? { correlationId: params.turnId } : {},
        );

        if (params?.willRetry) {
          if (params.turnId) {
            retryableErrorsByTurnId.set(params.turnId, codexError);
          }
          const warning = formatCodexRetryWarning(codexError);
          return [
            {
              type: "system",
              subtype: "warning",
              session_id: sessionId,
              content: warning,
              warning,
              codexError,
              willRetry: true,
              threadId: params.threadId,
              turnId: params.turnId,
            } as SDKMessage,
          ];
        }

        const retryCause = params?.turnId
          ? retryableErrorsByTurnId.get(params.turnId)
          : undefined;
        const retryExhausted =
          codexError.category === "unknown" && retryCause !== undefined;
        const effectiveError = retryExhausted ? retryCause : codexError;
        if (params?.turnId) retryableErrorsByTurnId.delete(params.turnId);

        const errorEvent = {
          type: "error",
          session_id: sessionId,
          error: effectiveError.publicMessage,
          codexError: effectiveError,
          ...(retryExhausted ? { codexRetryExhausted: true } : {}),
          willRetry: false,
          threadId: params?.threadId,
          turnId: params?.turnId,
        } as SDKMessage;
        logSdkCorrelationDebug(sessionId, errorEvent, {
          eventKind: "error",
          phase: "emitted",
          sourceEvent: notification.method,
        });
        return [errorEvent];
      }

      case "item/started":
      case "item/completed": {
        const params =
          notification.method === "item/started"
            ? this.asItemStartedNotification(notification.params)
            : this.asItemCompletedNotification(notification.params);
        if (!params) return [];

        const normalized = this.normalizeThreadItem(params.item);
        if (!normalized) {
          return [];
        }

        const turnId = params.turnId;
        if (notification.method === "item/completed") {
          commandOutputBuffers.delete(`${turnId}\0${normalized.id}`);
        }

        return this.convertItemToSDKMessages(
          normalized,
          sessionId,
          turnId,
          notification.method,
        ).map((message) => ({
          ...message,
          turnId,
          codexTurnId: turnId,
        }));
      }

      case "rawResponseItem/completed":
        return this.convertRawResponseItemToSDKMessages(
          notification.params,
          sessionId,
          customToolContexts,
        );

      case "turn/plan/updated": {
        const params = this.asTurnPlanUpdatedNotification(notification.params);
        if (!params || params.threadId !== sessionId) return [];
        const toolUseId = `codex-plan-${params.turnId}`;
        return [
          withCodexTimestamp({
            type: "assistant",
            session_id: sessionId,
            uuid: toolUseId,
            turnId: params.turnId,
            codexTurnId: params.turnId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: "UpdatePlan",
                  input: {
                    ...(params.explanation
                      ? { explanation: params.explanation }
                      : {}),
                    plan: params.plan.map((item) => ({
                      step: item.step,
                      status:
                        item.status === "inProgress"
                          ? "in_progress"
                          : item.status,
                    })),
                  },
                  status: "completed",
                },
              ],
            },
          } as unknown as SDKMessage),
        ];
      }

      case "item/commandExecution/outputDelta": {
        // Live command output streaming - mirror the Codex TUI's scrolling
        // exec cell. The delta merges into the pending tool_use block via the
        // shared block-merge path (same message uuid, same tool_use id).
        const params = notification.params as
          | {
              threadId?: string;
              turnId?: string;
              itemId?: string;
              delta?: string;
            }
          | undefined;
        const itemId = this.getOptionalString(params?.itemId);
        const turnId = this.getOptionalString(params?.turnId);
        const delta =
          typeof params?.delta === "string" ? params.delta : undefined;
        if (!itemId || !turnId || !delta) return [];

        const bufferKey = `${turnId}\0${itemId}`;
        const combined = (commandOutputBuffers.get(bufferKey) ?? "") + delta;
        // Keep the streaming preview bounded; the complete output arrives
        // with the item/completed tool_result.
        const bounded =
          combined.length > CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT
            ? combined.slice(-CODEX_COMMAND_OUTPUT_PREVIEW_LIMIT)
            : combined;
        commandOutputBuffers.set(bufferKey, bounded);

        return [
          withCodexTimestamp({
            type: "assistant",
            session_id: sessionId,
            uuid: `${itemId}-${turnId}`,
            turnId,
            codexTurnId: turnId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: itemId,
                  partialOutput: bounded,
                },
              ],
            },
          } as unknown as SDKMessage),
        ];
      }

      case "warning":
      case "guardianWarning":
      case "deprecationNotice":
      case "configWarning": {
        const params = notification.params as
          | {
              message?: string;
              summary?: string;
              details?: string | null;
            }
          | undefined;
        const summary =
          this.getOptionalString(params?.message) ??
          this.getOptionalString(params?.summary);
        if (!summary) return [];
        const details = this.getOptionalString(params?.details ?? undefined);
        return [
          withCodexTimestamp({
            type: "system",
            subtype: "warning",
            session_id: sessionId,
            content: details ? `${summary}\n${details}` : summary,
            warningKind: notification.method,
          } as SDKMessage),
        ];
      }

      case "account/rateLimits/updated": {
        // account/rateLimits/updated is telemetry, not a terminal turn error.
        // Real usage-limit/quota failures arrive via the `error` notification.
        return [];
      }

      default: {
        const classification = classifyCodexNotification(notification.method);
        if (!classification.known) {
          if (emitProjectionDiagnostics) {
            log.warn(
              { sessionId },
              "Recorded unknown Codex notification for compatibility",
            );
          }
          return emitUnknownCompatibilityMessage
            ? [
                withCodexTimestamp({
                  type: "system",
                  subtype: "warning",
                  session_id: sessionId,
                  content:
                    "Codex sent a newer event; Yep preserved it but this version cannot display its details yet.",
                  warningKind: "unknown_codex_notification",
                } as SDKMessage),
              ]
            : [];
        }
        if (emitProjectionDiagnostics) {
          log.debug(
            {
              sessionId,
              method: notification.method,
              domain: classification.domain,
              disposition: classification.disposition,
            },
            "Canonical Codex notification recorded without a legacy UI projection",
          );
        }
        return [];
      }
    }
  }

  private attachCanonicalCodexItem(
    messages: SDKMessage[],
    event: CodexEventEnvelope,
    sessionId: string,
  ): SDKMessage[] {
    if (event.method !== "item/started" && event.method !== "item/completed") {
      return messages;
    }
    const payload = asRecord(event.payload.data);
    const item = asRecord(payload?.item);
    if (!item || typeof item.type !== "string") return messages;

    const extensions = {
      codexThreadItem: publicCodexThreadItem(item),
      codexThreadItemLifecycle:
        event.method === "item/completed"
          ? ("completed" as const)
          : ("started" as const),
      ...(event.threadId ? { codexThreadId: event.threadId } : {}),
      ...(event.turnId ? { codexTurnId: event.turnId } : {}),
      codexEventSequence: event.sequence,
      codexRawReasoningAllowed: false,
    };
    if (messages.length === 0) {
      return [
        withCodexTimestamp(
          {
            type: "system",
            subtype: "codex_native_item",
            session_id: sessionId,
            uuid: `codex-native-${event.itemId ?? event.eventId}-${event.sequence}`,
            ...extensions,
          } as SDKMessage,
          new Date(event.receivedAtMs).toISOString(),
        ),
      ];
    }
    return messages.map(
      (message) =>
        ({
          ...message,
          ...extensions,
        }) as SDKMessage,
    );
  }

  private convertRawResponseItemToSDKMessages(
    params: unknown,
    sessionId: string,
    customToolContexts: Map<string, CodexToolCallContext>,
  ): SDKMessage[] {
    if (!params || typeof params !== "object") return [];
    const record = params as Record<string, unknown>;
    const turnId = this.getOptionalString(record.turnId);
    if (!turnId || !record.item || typeof record.item !== "object") return [];

    const item = record.item as Record<string, unknown>;
    const type = this.getOptionalString(item.type);
    const callId = this.getOptionalString(item.call_id);
    if (!callId) return [];

    const contextKey = `${sessionId}:${callId}`;
    const observedAt = new Date().toISOString();
    const itemId = this.getOptionalString(item.id) ?? callId;

    if (type === "custom_tool_call") {
      const rawToolName = this.getOptionalString(item.name);
      if (!rawToolName) return [];
      const namespace = this.getOptionalString(item.namespace) ?? undefined;
      const toolName = canonicalizeCodexToolName(rawToolName, namespace);
      const rawInput =
        item.input !== undefined
          ? item.input
          : parseCodexToolArguments(
              this.getOptionalString(item.arguments) ?? undefined,
            );
      const normalized =
        deriveCodexWebRunInvocation(rawToolName, namespace, rawInput) ??
        normalizeCodexToolInvocation(toolName, rawInput);
      customToolContexts.set(contextKey, {
        toolName: normalized.toolName,
        input: normalized.input,
        readShellInfo: normalized.readShellInfo,
        writeShellInfo: normalized.writeShellInfo,
      });

      const content: Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: unknown;
        status?: "completed";
      }> = [
        {
          type: "tool_use",
          id: callId,
          name: normalized.toolName,
          input: normalized.input,
        },
      ];
      const nestedPlan =
        normalized.toolName === "CodexExec"
          ? extractCodexExecUpdatePlan(normalized.input)
          : null;
      if (nestedPlan) {
        content.push({
          type: "tool_use",
          id: `${callId}-update-plan`,
          name: "UpdatePlan",
          input: nestedPlan,
          status: "completed",
        });
      }

      const message = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid: `${itemId}-${turnId}-custom-call`,
          turnId,
          codexTurnId: turnId,
          message: {
            role: "assistant",
            content,
          },
          codexToolName: rawToolName,
          ...(namespace ? { codexToolNamespace: namespace } : {}),
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "custom_tool_call",
        turnId,
        itemId,
        callId,
        phase: "completed",
        sourceEvent: "rawResponseItem/completed",
      });
      return [message];
    }

    if (type === "custom_tool_call_output") {
      const context = customToolContexts.get(contextKey);
      const normalized = normalizeCodexToolOutputWithContext(
        item.output,
        context,
      );
      customToolContexts.delete(contextKey);
      const toolResult = {
        type: "tool_result",
        tool_use_id: callId,
        content: normalized.content,
        ...(normalized.isError ? { is_error: true } : {}),
      };
      const message = withCodexTimestamp(
        {
          type: "user",
          session_id: sessionId,
          uuid: `${itemId}-${turnId}-custom-result`,
          turnId,
          codexTurnId: turnId,
          message: {
            role: "user",
            content: [toolResult],
          },
          ...(normalized.structured !== undefined
            ? { toolUseResult: normalized.structured }
            : {}),
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "custom_tool_result",
        turnId,
        itemId,
        callId,
        phase: "completed",
        sourceEvent: "rawResponseItem/completed",
      });
      return [message];
    }

    return [];
  }

  private normalizeThreadItem(
    item: CodexThreadItem | Record<string, unknown>,
  ): NormalizedThreadItem | null {
    const itemRecord = item as Record<string, unknown>;
    const id = this.getOptionalString(itemRecord.id);
    const type = this.getOptionalString(itemRecord.type);
    if (!id || !type) {
      return null;
    }

    const normalizedType = type.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

    switch (normalizedType) {
      case "reasoning": {
        const text = this.getReasoningText(itemRecord);
        if (!text) return null;
        return { id, type: "reasoning", text };
      }

      case "agent_message":
      case "plan": {
        const text = this.getOptionalString(itemRecord.text) ?? "";
        return {
          id,
          type: "agent_message",
          text,
          ...(normalizedType === "agent_message"
            ? { phase: this.getCodexMessagePhase(itemRecord.phase) }
            : {}),
        };
      }

      case "command_execution": {
        return {
          id,
          type: "command_execution",
          command: this.getOptionalString(itemRecord.command) ?? "",
          aggregated_output:
            this.getOptionalString(itemRecord.aggregated_output) ??
            this.getOptionalString(itemRecord.aggregatedOutput) ??
            "",
          exit_code:
            this.getOptionalNumber(itemRecord.exit_code) ??
            this.getOptionalNumber(itemRecord.exitCode) ??
            undefined,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "file_change": {
        return {
          id,
          type: "file_change",
          changes: normalizeCodexFileChanges(itemRecord.changes),
          status: normalizeCodexFileChangeStatus(itemRecord.status),
        };
      }

      case "mcp_tool_call": {
        const errorObj =
          itemRecord.error && typeof itemRecord.error === "object"
            ? (itemRecord.error as Record<string, unknown>)
            : null;

        return {
          id,
          type: "mcp_tool_call",
          server: this.getOptionalString(itemRecord.server) ?? "unknown",
          tool: this.getOptionalString(itemRecord.tool) ?? "unknown",
          arguments: itemRecord.arguments,
          result: itemRecord.result,
          error:
            this.getOptionalString(errorObj?.message) !== null
              ? { message: this.getOptionalString(errorObj?.message) ?? "" }
              : undefined,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "web_search": {
        return {
          id,
          type: "web_search",
          query: this.getOptionalString(itemRecord.query) ?? "",
        };
      }

      case "todo_list": {
        const items = Array.isArray(itemRecord.items)
          ? itemRecord.items
              .map((entry: unknown) => {
                if (!entry || typeof entry !== "object") return null;
                const record = entry as Record<string, unknown>;
                const text = this.getOptionalString(record.text);
                if (!text) return null;
                return {
                  text,
                  completed: record.completed === true,
                };
              })
              .filter(
                (
                  entry: unknown,
                ): entry is { text: string; completed: boolean } =>
                  entry !== null,
              )
          : [];
        return {
          id,
          type: "todo_list",
          items,
        };
      }

      case "image_view": {
        const imagePath = this.getOptionalString(itemRecord.path) ?? "";
        if (!imagePath) return null;
        return { id, type: "image_view", path: imagePath };
      }

      case "image_generation":
      case "image_generation_call":
      case "image_generation_end": {
        const image = normalizeCodexImageGenerationRecord(itemRecord, {
          defaultStatus: "completed",
        });
        const publicUrl = publicCodexImageUrl(image.url);

        return {
          id,
          type: "image_generation",
          status: image.status ?? "completed",
          ...(image.revisedPrompt
            ? { revised_prompt: image.revisedPrompt }
            : {}),
          ...(image.result && !isLocalImagePathValue(image.result)
            ? { result: image.result }
            : {}),
          // Provider-local paths are materialization hints, not client
          // capabilities. Only the managed artifact manifest is public.
          ...(publicUrl ? { url: publicUrl } : {}),
        };
      }

      case "error": {
        const message =
          this.getOptionalString(itemRecord.message) ?? "Codex error";
        return {
          id,
          type: "error",
          message,
        };
      }

      default:
        return null;
    }
  }

  private getReasoningText(item: Record<string, unknown>): string {
    const text = this.getOptionalString(item.text);
    if (text) return text;

    const content = Array.isArray(item.content)
      ? item.content.filter((part): part is string => typeof part === "string")
      : [];
    if (content.length > 0) {
      return content.join("\n");
    }

    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string")
      : [];
    if (summary.length > 0) {
      return summary.join("\n");
    }

    return "";
  }

  private normalizeStatus(status: unknown): string {
    if (typeof status !== "string") return "unknown";
    return status.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  }

  private asTurnCompletedNotification(
    params: unknown,
  ): TurnCompletedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      !record.turn ||
      typeof record.turn !== "object" ||
      typeof (record.turn as { id?: unknown }).id !== "string"
    ) {
      return null;
    }
    return params as TurnCompletedNotification;
  }

  private asTurnPlanUpdatedNotification(
    params: unknown,
  ): TurnPlanUpdatedNotificationParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !Array.isArray(record.plan)
    ) {
      return null;
    }

    const plan: TurnPlanUpdatedNotificationParams["plan"] = [];
    for (const item of record.plan) {
      if (!item || typeof item !== "object") return null;
      const step = (item as Record<string, unknown>).step;
      const status = (item as Record<string, unknown>).status;
      if (typeof step !== "string" || typeof status !== "string") return null;
      plan.push({ step, status });
    }

    return {
      threadId: record.threadId,
      turnId: record.turnId,
      explanation:
        typeof record.explanation === "string" ? record.explanation : null,
      plan,
    };
  }

  private asErrorNotification(params: unknown): CodexErrorNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.willRetry !== "boolean" ||
      !record.error ||
      typeof record.error !== "object" ||
      typeof (record.error as { message?: unknown }).message !== "string"
    ) {
      return null;
    }
    return params as CodexErrorNotification;
  }

  private asThreadTokenUsageUpdatedNotification(
    params: unknown,
  ): ThreadTokenUsageUpdatedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    const tokenUsage =
      record.tokenUsage && typeof record.tokenUsage === "object"
        ? (record.tokenUsage as Record<string, unknown>)
        : null;
    const last =
      tokenUsage?.last && typeof tokenUsage.last === "object"
        ? (tokenUsage.last as Record<string, unknown>)
        : null;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !last ||
      typeof last.inputTokens !== "number" ||
      typeof last.outputTokens !== "number" ||
      typeof last.cachedInputTokens !== "number"
    ) {
      return null;
    }
    return params as ThreadTokenUsageUpdatedNotification;
  }

  private asCommandExecutionRequestApprovalParams(
    params: unknown,
  ): CommandExecutionRequestApprovalParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string"
    ) {
      return null;
    }
    return params as CommandExecutionRequestApprovalParams;
  }

  private asFileChangeRequestApprovalParams(
    params: unknown,
  ): FileChangeRequestApprovalParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string"
    ) {
      return null;
    }
    return params as FileChangeRequestApprovalParams;
  }

  private asToolRequestUserInputParams(
    params: unknown,
  ): ToolRequestUserInputParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      !Array.isArray(record.questions)
    ) {
      return null;
    }
    return params as ToolRequestUserInputParams;
  }

  private asItemStartedNotification(
    params: unknown,
  ): CodexItemStartedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !record.item ||
      typeof record.item !== "object"
    ) {
      return null;
    }
    return params as CodexItemStartedNotification;
  }

  private asItemCompletedNotification(
    params: unknown,
  ): CodexItemCompletedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !record.item ||
      typeof record.item !== "object"
    ) {
      return null;
    }
    return params as CodexItemCompletedNotification;
  }

  /**
   * Convert a normalized thread item to SDKMessage(s).
   */
  private convertItemToSDKMessages(
    item: NormalizedThreadItem,
    sessionId: string,
    turnId: string,
    sourceEvent: "item/started" | "item/completed",
  ): SDKMessage[] {
    const isComplete = sourceEvent === "item/completed";
    const observedAt = new Date().toISOString();
    // Create unique UUID by combining item.id with turn ID.
    const uuid = `${item.id}-${turnId}`;

    switch (item.type) {
      case "reasoning": {
        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            codexCorrelationKey: `codex:${turnId}:reasoning:${item.id}`,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: item.text,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "reasoning",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "agent_message": {
        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            codexCorrelationKey: `codex:${turnId}:agent-message:${item.id}`,
            ...(item.phase ? { codexMessagePhase: item.phase } : {}),
            message: {
              role: "assistant",
              content: item.text,
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "agent_message",
          turnId,
          itemId: item.id,
          phase: item.phase ?? (isComplete ? "completed" : "started"),
          sourceEvent,
        });
        return [message];
      }

      case "command_execution": {
        const messages: SDKMessage[] = [];
        const normalizedInvocation = normalizeCodexToolInvocation("Bash", {
          command: item.command,
        });
        const toolContext: CodexToolCallContext = {
          toolName: normalizedInvocation.toolName,
          input: normalizedInvocation.input,
          readShellInfo: normalizedInvocation.readShellInfo,
          writeShellInfo: normalizedInvocation.writeShellInfo,
        };

        // Emit tool_use for the command
        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                  status: item.status,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "command_execution",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolUseMessage);

        // If completed, emit tool_result
        if (isComplete && item.status !== "in_progress") {
          const normalizedResult = normalizeCodexCommandExecutionOutput(
            {
              aggregatedOutput: item.aggregated_output,
              exitCode: item.exit_code,
              status: item.status,
            },
            toolContext,
          );
          const toolResultBlock: {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          } = {
            type: "tool_result",
            tool_use_id: item.id,
            content: normalizedResult.content,
          };
          if (normalizedResult.isError) {
            toolResultBlock.is_error = true;
          }

          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [toolResultBlock],
              },
              ...(normalizedResult.structured !== undefined
                ? { toolUseResult: normalizedResult.structured }
                : {}),
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "file_change": {
        const publicChanges = publicCodexFileChanges(item.changes);
        const editInput = buildCodexEditInput(publicChanges);

        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "Edit",
                  input: editInput,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "file_change",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });

        const messages = [toolUseMessage];

        if (isComplete) {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content: formatCodexFileChangeResult(
                      publicChanges,
                      item.status,
                    ),
                    ...(isCodexFileChangeError(item.status)
                      ? { is_error: true }
                      : {}),
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "mcp_tool_call": {
        const messages: SDKMessage[] = [];

        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: `${item.server}:${item.tool}`,
                  input: item.arguments,
                  status: item.status,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "mcp_tool_call",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolUseMessage);

        if (isComplete && item.status !== "in_progress") {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content:
                      item.status === "completed"
                        ? JSON.stringify(item.result)
                        : item.error?.message || "MCP tool call failed",
                    ...(item.status === "completed" ? {} : { is_error: true }),
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "web_search": {
        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "WebSearch",
                  input: { query: item.query },
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "web_search",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });

        const messages = [toolUseMessage];
        if (isComplete) {
          const query = item.query.trim() || "Codex web search";
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content: `Codex web search completed: ${query}`,
                  },
                ],
              },
              toolUseResult: {
                query,
                results: [],
                codexActionLabel: `Search: ${query}`,
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "todo_list": {
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: "todo_list",
            session_id: sessionId,
            uuid,
            items: item.items,
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "todo_list",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "image_view": {
        // Represent as a ViewImage tool_use + tool_result pair
        const publicPath = publicCodexFilePath(item.path);
        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "ViewImage",
                  input: { path: publicPath },
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "image_view",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        const messages: SDKMessage[] = [toolUseMessage];

        if (isComplete) {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content: `Viewed image: ${publicPath}`,
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "image_generation": {
        const input: Record<string, unknown> = {
          title: "Generated image",
          ...(item.path ? { path: item.path } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.status ? { status: item.status } : {}),
          ...(item.revised_prompt
            ? { revised_prompt: item.revised_prompt }
            : {}),
          ...(!item.path && !item.url && item.result
            ? { result: summarizeCodexImageGenerationResult(item.result) }
            : {}),
        };

        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "ViewImage",
                  input,
                },
              ],
            },
            codexToolName: "imageGeneration",
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "image_generation",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });

        const messages: SDKMessage[] = [toolUseMessage];
        if (isComplete && item.status !== "in_progress") {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content: buildCodexImageGenerationResultText({
                      path: item.path,
                      url: item.url,
                      status: item.status,
                      result: item.result,
                    }),
                  },
                ],
              },
              toolUseResult: {
                type: "image",
                ...(item.path ? { path: item.path } : {}),
                ...(item.url ? { url: item.url } : {}),
                ...(item.status ? { status: item.status } : {}),
                ...(item.revised_prompt
                  ? { revisedPrompt: item.revised_prompt }
                  : {}),
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "error": {
        const message = withCodexTimestamp(
          {
            type: "error",
            session_id: sessionId,
            uuid,
            error: item.message,
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "error",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }
    }

    const exhaustiveItem: never = item;
    return exhaustiveItem;
  }

  private getOptionalString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private getCodexMessagePhase(value: unknown): CodexMessagePhase | undefined {
    return value === "commentary" || value === "final_answer"
      ? value
      : undefined;
  }

  private getOptionalNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
}

function codexServerRequestId(id: JsonRpcId): string {
  return `codex:${typeof id}:${String(id)}`;
}

function getProviderApprovalDecision(
  result: ToolApprovalResult,
): ProviderApprovalDecision {
  if (result.behavior === "deny") return "deny";
  if (result.providerDecision) return result.providerDecision;
  return result.approvalScope === "always" ? "approve_always" : "approve";
}

function isNoRolloutFoundError(
  error: unknown,
  expectedThreadId: string,
): boolean {
  return (
    error instanceof CodexJsonRpcError &&
    error.code === -32600 &&
    error.message === `no rollout found for thread id ${expectedThreadId}`
  );
}

function normalizeAutoResolutionMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(Math.floor(value), 2_147_483_647);
}

function isCommandApprovalDecision(
  value: unknown,
): value is CommandExecutionApprovalDecision {
  if (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  ) {
    return true;
  }
  const decision = asRecord(value);
  return Boolean(
    decision &&
      (asRecord(decision.acceptWithExecpolicyAmendment) ||
        asRecord(decision.applyNetworkPolicyAmendment)),
  );
}

function isPolicyAmendmentCommandApprovalDecision(
  decision: CommandExecutionApprovalDecision,
): boolean {
  if (typeof decision !== "object") return false;
  if ("acceptWithExecpolicyAmendment" in decision) return true;
  const amendment = asRecord(decision.applyNetworkPolicyAmendment);
  const networkPolicy = asRecord(amendment?.network_policy_amendment);
  return networkPolicy?.action === "allow";
}

/** Mirrors Codex TUI's stable-protocol fallback when availableDecisions is absent. */
function getEffectiveCommandApprovalDecisions(
  params: Record<string, unknown>,
): CommandExecutionApprovalDecision[] {
  if (Array.isArray(params.availableDecisions)) {
    return params.availableDecisions.filter(isCommandApprovalDecision);
  }

  if (params.networkApprovalContext != null) {
    const decisions: CommandExecutionApprovalDecision[] = [
      "accept",
      "acceptForSession",
    ];
    const amendment = Array.isArray(params.proposedNetworkPolicyAmendments)
      ? params.proposedNetworkPolicyAmendments.find(
          (candidate) => asRecord(candidate)?.action === "allow",
        )
      : undefined;
    if (amendment) {
      decisions.push({
        applyNetworkPolicyAmendment: {
          network_policy_amendment: amendment as {
            host: string;
            action: "allow" | "deny";
          },
        },
      });
    }
    decisions.push("cancel");
    return decisions;
  }

  if (params.additionalPermissions != null) {
    return ["accept", "cancel"];
  }

  const decisions: CommandExecutionApprovalDecision[] = ["accept"];
  if (Array.isArray(params.proposedExecpolicyAmendment)) {
    decisions.push({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: params.proposedExecpolicyAmendment.filter(
          (part): part is string => typeof part === "string",
        ),
      },
    });
  }
  decisions.push("cancel");
  return decisions;
}

function buildCodexRetryWarning(
  update: AppServerRetryUpdate,
  sessionId: string | undefined,
  canonicalEvent: CodexEventEnvelope | undefined,
): SDKMessage {
  const status = update.retryStatus;
  const content =
    status.state === "queued"
      ? `Codex is busy. The request is queued for bounded attempt ${status.nextAttempt}/${status.maxAttempts}.`
      : `Codex is busy. Retrying with bounded attempt ${status.nextAttempt}/${status.maxAttempts}.`;
  return withCodexTimestamp({
    type: "system",
    subtype: "warning",
    uuid: `codex-retry-${String(update.requestId)}-${status.attempt}`,
    ...(sessionId ? { session_id: sessionId } : {}),
    content,
    warning: content,
    warningKind: "codex_app_server_overloaded",
    willRetry: true,
    codexRetryStatus: { ...status },
    ...(canonicalEvent
      ? {
          codexEventSequence: canonicalEvent.sequence,
          codexEventId: canonicalEvent.eventId,
        }
      : {}),
  } as SDKMessage);
}

export function buildCodexUserInput(
  message: {
    attachments?: Array<{ path: string; mimeType: string }>;
    codexInputs?: CodexStructuredUserInput[];
    message?: { content?: unknown };
  },
  text: string,
): CodexUserInput[] {
  const input: CodexUserInput[] = [{ type: "text", text, text_elements: [] }];

  const content = message.message?.content;
  if (Array.isArray(content)) {
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      const source = asRecord(block?.source);
      if (
        block?.type !== "image" ||
        source?.type !== "base64" ||
        typeof source.data !== "string" ||
        typeof source.media_type !== "string"
      ) {
        continue;
      }
      input.push({
        type: "image",
        url: `data:${source.media_type};base64,${source.data}`,
      });
    }
  }

  for (const attachment of message.attachments ?? []) {
    if (!isAbsolute(attachment.path)) continue;
    const mimeType = attachment.mimeType.toLowerCase();
    if (mimeType.startsWith("image/")) {
      input.push({ type: "localImage", path: attachment.path });
    } else if (mimeType.startsWith("audio/")) {
      input.push({ type: "localAudio", path: attachment.path });
    }
  }

  for (const structuredInput of message.codexInputs ?? []) {
    if (!structuredInput.name || !structuredInput.path) continue;
    input.push({ ...structuredInput });
  }

  return input;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function publicCodexThreadItem(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(item);
  if (clone.type === "fileChange" || clone.type === "file_change") {
    return {
      ...clone,
      changes: publicCodexFileChanges(clone.changes),
    };
  }
  if (clone.type === "imageView" || clone.type === "image_view") {
    return {
      ...clone,
      ...(typeof clone.path === "string"
        ? { path: publicCodexFilePath(clone.path) }
        : {}),
    };
  }
  if (!isCodexImageGenerationRecord(clone)) return clone;
  return Object.fromEntries(
    Object.entries(clone).filter(
      ([key]) =>
        key !== "savedPath" &&
        key !== "saved_path" &&
        key !== "path" &&
        key !== "result",
    ),
  );
}

function isLocalImagePathValue(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}

function publicCodexImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * The canonical envelope proves that this is the completed item for the
 * active thread/turn. Materialization still uses the matching live payload so
 * a valid inline image is not destroyed by bounded journal redaction.
 */
function selectCanonicalGeneratedArtifactSourceItem(
  notification: JsonRpcNotification,
  event: CodexEventEnvelope,
): Record<string, unknown> | null {
  if (
    notification.method !== "item/completed" ||
    event.method !== "item/completed" ||
    event.source.replay === true ||
    !event.threadId ||
    !event.turnId
  ) {
    return null;
  }
  const livePayload = asRecord(notification.params);
  const canonicalPayload = asRecord(event.payload.data);
  const liveItem = asRecord(livePayload?.item);
  const canonicalItem = asRecord(canonicalPayload?.item);
  if (
    !liveItem ||
    !canonicalItem ||
    livePayload?.threadId !== event.threadId ||
    livePayload?.turnId !== event.turnId ||
    liveItem.id !== canonicalItem.id ||
    (event.itemId !== undefined && liveItem.id !== event.itemId) ||
    liveItem.type !== canonicalItem.type ||
    liveItem.status !== "completed" ||
    canonicalItem.status !== "completed" ||
    (liveItem.type !== "imageGeneration" && liveItem.type !== "fileChange")
  ) {
    return null;
  }
  return liveItem;
}

function normalizeCodexBridgeExecutionConfig(
  config: CodexBridgeExecutionConfig | null | undefined,
): CodexBridgeExecutionConfig | undefined {
  if (!config || config.mode === "disabled") return undefined;
  const controlUrl = config.controlUrl.trim().replace(/\/+$/, "");
  if (!controlUrl) return undefined;
  return {
    ...config,
    controlUrl,
    ...(config.authToken?.trim()
      ? { authToken: config.authToken.trim() }
      : { authToken: undefined }),
  };
}

function normalizeBridgeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isWildcardBridgeHostname(hostname: string): boolean {
  const normalized = normalizeBridgeHostname(hostname);
  return normalized === "0.0.0.0" || normalized === "::";
}

function isLoopbackBridgeHostname(hostname: string): boolean {
  const normalized = normalizeBridgeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function isSameTrustedBridgeHost(left: string, right: string): boolean {
  const normalizedLeft = normalizeBridgeHostname(left);
  const normalizedRight = normalizeBridgeHostname(right);
  return (
    normalizedLeft === normalizedRight ||
    (isLoopbackBridgeHostname(normalizedLeft) &&
      isLoopbackBridgeHostname(normalizedRight))
  );
}

function findLastInProgressCodexTurnId(
  turns: ThreadResumeResponse["thread"]["turns"],
): string | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.status === "inProgress") return turn.id;
  }
  return undefined;
}

/**
 * Parse a positive-integer env override, ignoring unset or malformed values.
 */
function parsePositiveIntegerEnv(
  value: string | undefined,
): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Default Codex provider instance.
 */
export const codexProvider = new CodexProvider({
  eventSpine: {
    // The process-wide provider is the production path. Keep ad-hoc provider
    // instances in-memory for tests/embedders, while making the real path
    // restart-safe without requiring an opt-in environment variable.
    durableStorePath:
      process.env.YEP_CODEX_EVENT_STORE_PATH?.trim() ||
      join(getDataDir(), "codex-events", "events.jsonl"),
    storeRotation: {
      maxBytes: parsePositiveIntegerEnv(
        process.env.YEP_CODEX_EVENT_STORE_ROTATE_BYTES,
      ),
      keepSegments: parsePositiveIntegerEnv(
        process.env.YEP_CODEX_EVENT_STORE_KEEP_SEGMENTS,
      ),
    },
    onStoreRotate: ({ from, to, pruned, prunedSummary }) => {
      log.info(
        {
          event: "codex_event_store_rotated",
          from,
          to,
          prunedCount: pruned.length,
          pruned,
          // Pruning permanently deletes the earliest events of every session the
          // segment held. Naming them is the difference between a recoverable
          // question ("was this session's canonical history cut?") and an
          // unanswerable one.
          prunedSessions: prunedSummary.map((segment) => ({
            path: segment.path,
            known: segment.known,
            eventCount: segment.eventCount,
            sessionCount: segment.sessions.length,
            topSessions: segment.sessions.slice(0, 10),
          })),
        },
        pruned.length > 0
          ? "Rotated canonical Codex event journal and pruned closed segments"
          : "Rotated canonical Codex event journal",
      );
    },
    onStoreJournalGaps: ({ gaps, sessionCount, journalFiles }) => {
      log.warn(
        {
          event: "codex_event_store_journal_truncated",
          sessionCount,
          journalFiles,
          truncatedSessionCount: gaps.length,
          missingLeadingEventsTotal: gaps.reduce(
            (sum, gap) => sum + gap.missingLeadingEvents,
            0,
          ),
          topGaps: gaps.slice(0, 10),
        },
        "Canonical Codex journal no longer contains the start of some sessions; their projections are incomplete",
      );
    },
  },
});

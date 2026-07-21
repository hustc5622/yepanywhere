/**
 * OpenCode Provider implementation using the 4520-managed OpenCode server,
 * with a dedicated `opencode serve` fallback when the bridge is unavailable.
 *
 * This provider enables using OpenCode as an agent backend.
 * It communicates with OpenCode via HTTP/SSE.
 *
 * Architecture:
 * - Yep-created sessions prefer the same shared server used by `of`
 *   (`opencode attach` through the 4520 bridge)
 * - A per-session `opencode serve` process remains the compatibility fallback
 * - Messages are started via HTTP POST to /session/:id/prompt_async
 * - Responses are streamed via SSE from /event
 * - Server is killed when session is aborted or times out
 */

import { type ChildProcess, exec, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  ModelInfo,
  OpenCodeMessagePartDeltaEvent,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodePart,
  OpenCodeRequestProtocol,
  OpenCodeSSEEvent,
  OpenCodeSessionConfig,
  PermissionMode,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { parseOpenCodeSSEEvent } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import {
  buildManagedOpenCodeEnv,
  buildUserConfiguredOpenCodeEnv,
  fetchOpenCodeGatewayModels,
  getManagedOpenCodeModelRef,
  resolveOpenCodeGatewayConfig,
  resolveOpenCodeOpenAICompatibleBaseURL,
} from "../../opencode-bridge/gateway-config.js";
import {
  OPENCODE_ACTIVE_RECONCILE_INTERVAL_MS,
  OPENCODE_IDLE_QUIET_WINDOW_MS,
  OPENCODE_STATUS_FAILURE_GRACE_MS,
  createOpenCodeLifecycleState,
  isOpenCodeToolPartPending,
  parseOpenCodeUpstreamStatus,
  readOpenCodeAssistantTerminalEvidence,
  readOpenCodeSessionStatus,
  reduceOpenCodeLifecycle,
} from "../../opencode-lifecycle/index.js";
import type {
  OpenCodeLifecycleAction,
  OpenCodeLifecycleState,
} from "../../opencode-lifecycle/index.js";
import {
  getOpenCodeAttachmentLabel,
  hasYepUploadMetadataForFile,
} from "../../opencode/attachments.js";
import {
  type OpenCodeQuestion,
  buildOpenCodeQuestionAnswers,
  normalizeOpenCodeQuestions,
} from "../../opencode/questions.js";
import { whichCommand } from "../cli-detection.js";
import { MessageQueue } from "../messageQueue.js";
import type {
  QueuedUserMessage,
  SDKMessage,
  ToolApprovalResult,
} from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * How long a fetched gateway model catalog (used to backfill context windows)
 * stays fresh. `getAvailableModels` is called on every provider listing, so a
 * short TTL keeps the picker responsive without hammering the gateway.
 */
const GATEWAY_MODEL_WINDOWS_TTL_MS = 60_000;

/**
 * Configuration for OpenCode provider.
 */
export interface OpenCodeProviderConfig {
  /** Path to opencode binary (auto-detected if not specified) */
  opencodePath?: string;
  /** Request timeout in ms (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Base port to start from (auto-selects if not specified) */
  basePort?: number;
  /** 4520 bridge control URL. Null disables shared-server discovery. */
  bridgeControlUrl?: string | null;
  /** Injectable lifecycle timing knobs used by focused tests. */
  lifecycle?: {
    quietWindowMs?: number;
    reconcileIntervalMs?: number;
    statusFailureGraceMs?: number;
  };
}

type OpenCodePermissionAction = "allow" | "ask" | "deny";
type OpenCodePermissionConfig = Record<string, OpenCodePermissionAction>;

interface OpenCodePermissionAskedEvent {
  type: "permission.asked";
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns?: string[];
    metadata?: unknown;
    always?: string[];
    tool?: {
      messageID?: string;
      callID?: string;
    };
  };
}

interface OpenCodePermissionRepliedEvent {
  type: "permission.replied";
  properties?: {
    id?: string;
    sessionID?: string;
  };
}

interface OpenCodeQuestionAskedEvent {
  type: "question.asked";
  properties: {
    id: string;
    sessionID: string;
    questions: unknown;
    tool?: {
      messageID?: string;
      callID?: string;
    };
  };
}

interface OpenCodeQuestionResolvedEvent {
  type: "question.replied" | "question.rejected";
  properties?: {
    sessionID?: string;
    requestID?: string;
  };
}

interface OpenCodeSessionErrorEvent {
  type: "session.error";
  properties: {
    sessionID?: string;
    error?: unknown;
  };
}

interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

interface OpenCodeRuntimeRef {
  baseUrl?: string;
  currentModel?: string | null;
  currentVariant?: string;
  cwd?: string;
  sharedServer?: boolean;
  alive?: boolean;
  sessionId?: string;
}

interface OpenCodeConfigProvidersResponse {
  providers?: Array<{
    id?: string;
    models?: Record<
      string,
      {
        variants?: Record<string, unknown>;
      }
    >;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openCodeRuntimeEventSessionId(
  event: OpenCodeRuntimeEvent,
): string | undefined {
  const rawProperties = (event as unknown as { properties?: unknown })
    .properties;
  const properties = isRecord(rawProperties) ? rawProperties : undefined;
  if (typeof properties?.sessionID === "string") {
    return properties.sessionID;
  }
  const info = isRecord(properties?.info) ? properties.info : undefined;
  if (typeof info?.sessionID === "string") return info.sessionID;
  const part = isRecord(properties?.part) ? properties.part : undefined;
  return typeof part?.sessionID === "string" ? part.sessionID : undefined;
}

function buildOpenCodeQuestionAnswersFromUpdatedInput(
  questions: OpenCodeQuestion[],
  updatedInput: unknown,
): string[][] {
  const input = isRecord(updatedInput) ? updatedInput : null;
  const answers = isRecord(input?.answers)
    ? (input.answers as UserQuestionAnswers)
    : undefined;
  return buildOpenCodeQuestionAnswers(questions, answers);
}

type ReasoningEffortsByProtocol = NonNullable<
  ModelInfo["supportedReasoningEffortsByProtocol"]
>;

function parseOpenCodeModelHeader(
  line: string,
): { catalogId: string; modelId: string } | null {
  const trimmed = line.trim();
  if (line !== trimmed || !/^[a-zA-Z0-9._-]+\/\S+$/.test(trimmed)) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    catalogId: trimmed,
    modelId: trimmed.slice(slash + 1),
  };
}

function extractFirstJsonObject(value: string): Record<string, unknown> | null {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const start = value.indexOf("{", searchFrom);
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(value.slice(start, index + 1)) as unknown;
            if (isRecord(parsed)) return parsed;
          } catch {
            // A non-JSON brace block may precede the verbose model payload.
          }
          searchFrom = start + 1;
          break;
        }
      }
    }

    if (depth > 0) return null;
  }
  return null;
}

function requestProtocolForOpenCodeNpm(
  npm: unknown,
): OpenCodeRequestProtocol | null {
  if (npm === "@ai-sdk/openai-compatible") return "openai-compatible";
  if (npm === "@ai-sdk/anthropic") return "anthropic";
  return null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

/**
 * Read a model's real context/output limits from `opencode models --verbose`.
 *
 * OpenCode resolves every model's `limit` from models.dev or the user's
 * provider config, so these values are the authoritative window for the
 * catalog entry. Surfacing them lets Yep display and meter the correct window
 * instead of falling back to the Claude-centric 200K heuristic.
 */
function extractOpenCodeModelLimits(metadata: Record<string, unknown> | null): {
  contextWindow?: number;
  maxOutputTokens?: number;
} {
  const limit = isRecord(metadata?.limit) ? metadata.limit : undefined;
  if (!limit) return {};
  return {
    ...(positiveInteger(limit.context) !== undefined
      ? { contextWindow: positiveInteger(limit.context) }
      : {}),
    ...(positiveInteger(limit.output) !== undefined
      ? { maxOutputTokens: positiveInteger(limit.output) }
      : {}),
  };
}

interface OpenCodeSessionCreatePayload {
  title: string;
  location?: {
    directory: string;
  };
  model?: {
    providerID: string;
    id: string;
  };
  metadata?: Record<string, unknown>;
  permission?: OpenCodePermissionRule[];
}

interface OpenCodePermissionRule {
  permission: string;
  pattern: "*";
  action: OpenCodePermissionAction;
}

interface OpenCodeTextPartInput {
  type: "text";
  text: string;
}

interface OpenCodeFilePartInput {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

interface OpenCodeMessagePayload {
  parts: Array<OpenCodeTextPartInput | OpenCodeFilePartInput>;
  model?: OpenCodeModelRef;
  /** OpenCode-native model variant (for example high or max). */
  variant?: string;
}

interface OpenCodeSessionResponse {
  id: string;
  metadata?: Record<string, unknown>;
}

interface YepOpenCodeForkMetadata {
  schemaVersion: 1;
  kind: "edit-fork";
  parentSessionId: string;
  forkMessageId: string;
  createdAt: string;
}

interface OpenCodeStreamBlockState {
  index: number;
  type: "text" | "thinking";
  text: string;
}

interface OpenCodeAssistantStreamState {
  messageId: string | null;
  started: boolean;
  stopped: boolean;
  nextBlockIndex: number;
  partBlocks: Map<string, OpenCodeStreamBlockState>;
}

interface OpenCodeEmissionState {
  toolUseIds: Set<string>;
  toolResultIds: Set<string>;
  /**
   * Last emitted input fingerprint per tool call. OpenCode streams tool parts
   * through pending (often empty input) -> running (full input); when the
   * input materializes we re-emit the tool_use so the UI shows real
   * arguments instead of `{}`.
   */
  toolUseInputs: Map<string, string>;
  /** Part ids already emitted as standalone marker messages (subtask/file/compaction). */
  markerPartIds: Set<string>;
  /** Part kind learned from message.part.updated before standalone deltas. */
  streamingPartTypes: Map<string, "text" | "reasoning">;
  /**
   * Permission ids already dispatched to the approval handler this stream.
   * OpenCode can re-emit `permission.asked` for the same id (replay / multiple
   * approvals in one turn); without dedup each event queues a fresh pending
   * approval, so the popup reappears after the user already approved.
   */
  permissionAskedIds: Set<string>;
  assistantStream?: OpenCodeAssistantStreamState;
  latestUsage?: Record<string, unknown>;
  latestCost?: number;
  latestModel?: string;
  latestFinish?: string;
}

type OpenCodeRuntimeEvent =
  | OpenCodeSSEEvent
  | OpenCodePermissionAskedEvent
  | OpenCodePermissionRepliedEvent
  | OpenCodeQuestionAskedEvent
  | OpenCodeQuestionResolvedEvent
  | OpenCodeSessionErrorEvent;

/**
 * OpenCode Provider implementation.
 *
 * Prefers the 4520 bridge's shared server and falls back to a per-session
 * `opencode serve` process, communicating with either via the same HTTP/SSE
 * protocol.
 */
export class OpenCodeProvider implements AgentProvider {
  readonly name = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly supportsPermissionMode = true;
  // auto and plan both resolve to the default session rules. OpenCode's real
  // plan mode is an agent choice, not a permission preset.
  readonly permissionModes = [
    "default",
    "acceptEdits",
    "bypassPermissions",
  ] as const;
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly opencodePath?: string;
  private readonly timeout: number;
  private bridgeControlUrl?: string;
  private readonly lifecycleQuietWindowMs: number;
  private readonly lifecycleReconcileIntervalMs: number;
  private readonly lifecycleStatusFailureGraceMs: number;
  /** Cached gateway `context_window` values, keyed by gateway model id. */
  private gatewayModelWindowsCache?: {
    fetchedAt: number;
    byModelId: Map<string, number>;
  };
  constructor(config: OpenCodeProviderConfig = {}) {
    this.opencodePath = config.opencodePath;
    this.timeout = config.timeout ?? 300000; // 5 minutes default
    this.bridgeControlUrl = config.bridgeControlUrl?.replace(/\/+$/, "");
    this.lifecycleQuietWindowMs =
      config.lifecycle?.quietWindowMs ?? OPENCODE_IDLE_QUIET_WINDOW_MS;
    this.lifecycleReconcileIntervalMs =
      config.lifecycle?.reconcileIntervalMs ??
      OPENCODE_ACTIVE_RECONCILE_INTERVAL_MS;
    this.lifecycleStatusFailureGraceMs =
      config.lifecycle?.statusFailureGraceMs ??
      OPENCODE_STATUS_FAILURE_GRACE_MS;
  }

  /** Configure the production singleton after the server config is loaded. */
  configureBridgeControlUrl(value: string | null | undefined): void {
    this.bridgeControlUrl = value?.replace(/\/+$/, "");
  }

  /**
   * Check if the OpenCode CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    const path = await this.findOpenCodePath();
    return path !== null;
  }

  /**
   * Check if OpenCode is authenticated.
   * OpenCode handles auth internally via `opencode auth`.
   */
  async isAuthenticated(): Promise<boolean> {
    // OpenCode is authenticated if installed - it has built-in free models
    return this.isInstalled();
  }

  /**
   * Get detailed authentication status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        enabled: false,
      };
    }

    // OpenCode is always authenticated if installed (has free models)
    return {
      installed: true,
      authenticated: true,
      enabled: true,
    };
  }

  /**
   * Get available OpenCode models.
   * Queries the OpenCode CLI for available models.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const opencodePath = await this.findOpenCodePath();
    if (!opencodePath) {
      return [];
    }

    // Yep and terminal clients must see the same catalog resolved by the
    // user's OpenCode configuration. A synthetic default entry deliberately
    // omits a model override so new Yep sessions inherit config.model exactly
    // like `opencode` / `opencode attach`.
    const configuredDefault: ModelInfo = {
      id: "default",
      name: "Default (OpenCode config)",
    };
    const cliModels = await this.loadOpenCodeCliModels(opencodePath);
    if (cliModels.length > 0) {
      const enriched = await this.enrichWithGatewayContextWindows(cliModels);
      return [
        configuredDefault,
        ...enriched.filter((model) => model.id !== "default"),
      ];
    }

    // Return default models if both CLI catalog commands fail.
    return [
      configuredDefault,
      { id: "opencode/big-pickle", name: "Big Pickle (Free)" },
    ];
  }

  /**
   * Backfill each model's context window from the LLM gateway's `/v1/models`
   * catalog when `opencode models --verbose` did not report one. Custom
   * providers frequently expose a blank/zero `limit`, so this recovers the
   * gateway's real `context_window` (matched by gateway model id, then by the
   * bare id after any `provider/` prefix). Best-effort: the CLI-reported window
   * always wins, and any failure leaves the catalog untouched.
   */
  private async enrichWithGatewayContextWindows(
    models: ModelInfo[],
  ): Promise<ModelInfo[]> {
    if (models.every((model) => model.contextWindow !== undefined)) {
      return models;
    }
    const gatewayWindows = await this.getGatewayModelWindows();
    if (gatewayWindows.size === 0) return models;

    return models.map((model) => {
      if (model.contextWindow !== undefined) return model;
      const bareId = model.id.slice(model.id.lastIndexOf("/") + 1);
      const contextWindow =
        gatewayWindows.get(model.id) ?? gatewayWindows.get(bareId);
      return contextWindow ? { ...model, contextWindow } : model;
    });
  }

  private async getGatewayModelWindows(): Promise<Map<string, number>> {
    const now = Date.now();
    if (
      this.gatewayModelWindowsCache &&
      now - this.gatewayModelWindowsCache.fetchedAt <
        GATEWAY_MODEL_WINDOWS_TTL_MS
    ) {
      return this.gatewayModelWindowsCache.byModelId;
    }

    const byModelId = new Map<string, number>();
    const config = resolveOpenCodeGatewayConfig(process.env);
    if (config) {
      try {
        const gatewayModels = await fetchOpenCodeGatewayModels(config);
        for (const model of gatewayModels) {
          if (model.contextWindow && model.contextWindow > 0) {
            byModelId.set(model.id, model.contextWindow);
          }
        }
      } catch (error) {
        getLogger().debug(
          { error },
          "Failed to fetch OpenCode gateway catalog for context windows",
        );
      }
    }

    this.gatewayModelWindowsCache = { fetchedAt: now, byModelId };
    return byModelId;
  }

  private async loadOpenCodeCliModels(
    opencodePath: string,
  ): Promise<ModelInfo[]> {
    try {
      const { stdout } = await execFileAsync(
        opencodePath,
        ["models", "--verbose"],
        {
          encoding: "utf-8",
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return this.parseOpenCodeVerboseModels(stdout);
    } catch {
      // Older OpenCode versions do not expose --verbose. Keep their model
      // catalog usable, just without per-model variant metadata.
      try {
        const { stdout } = await execFileAsync(opencodePath, ["models"], {
          encoding: "utf-8",
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return this.parseOpenCodeVerboseModels(stdout);
      } catch {
        return [];
      }
    }
  }

  private parseOpenCodeVerboseModels(result: string): ModelInfo[] {
    const lines = result.split(/\r?\n/);
    const models: ModelInfo[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const header = parseOpenCodeModelHeader(lines[index] ?? "");
      if (!header) continue;

      let nextHeaderIndex = index + 1;
      while (
        nextHeaderIndex < lines.length &&
        !parseOpenCodeModelHeader(lines[nextHeaderIndex] ?? "")
      ) {
        nextHeaderIndex += 1;
      }

      const metadata = extractFirstJsonObject(
        lines.slice(index + 1, nextHeaderIndex).join("\n"),
      );
      const api = isRecord(metadata?.api) ? metadata.api : undefined;
      const protocol = requestProtocolForOpenCodeNpm(api?.npm);
      const variants = isRecord(metadata?.variants)
        ? Object.keys(metadata.variants).map((reasoningEffort) => ({
            reasoningEffort,
          }))
        : [];
      const byProtocol: ReasoningEffortsByProtocol = {};
      if (protocol && variants.length > 0) byProtocol[protocol] = variants;

      const limits = extractOpenCodeModelLimits(metadata);

      models.push({
        id: header.catalogId,
        name: this.formatModelName(header.catalogId),
        ...(limits.contextWindow !== undefined
          ? { contextWindow: limits.contextWindow }
          : {}),
        ...(limits.maxOutputTokens !== undefined
          ? { maxOutputTokens: limits.maxOutputTokens }
          : {}),
        ...(variants.length > 0
          ? {
              supportedReasoningEfforts: variants,
              ...(protocol
                ? { supportedReasoningEffortsByProtocol: byProtocol }
                : {}),
            }
          : {}),
      });
      index = nextHeaderIndex - 1;
    }

    return models;
  }

  /**
   * Start a new OpenCode session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue({ preserveAttachments: true });
    const abortController = new AbortController();
    const pidRef: { value?: number } = {};
    const processRef: { value?: ChildProcess } = {};
    const runtimeRef: OpenCodeRuntimeRef = {};

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(
      options.cwd,
      queue,
      abortController.signal,
      options,
      pidRef,
      processRef,
      runtimeRef,
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
      get pid() {
        return pidRef.value;
      },
      isProcessAlive: () => {
        if (runtimeRef.sharedServer) return runtimeRef.alive === true;
        const child = processRef.value;
        return child
          ? child.exitCode === null && child.signalCode === null
          : false;
      },
      ...(options.opencodeConfig
        ? {}
        : {
            supportedModels: () => this.getAvailableModels(),
            setModel: async (model?: string) => {
              if (!runtimeRef.baseUrl) return;
              const normalizedModel =
                await this.resolveOpenCodeModelOption(model);
              // Model selection is carried by each prompt. Updating /config
              // would persist a Yep-only override into the project and also
              // change the model observed by attached `of` clients.
              runtimeRef.currentModel = normalizedModel;
              runtimeRef.currentVariant = await this.resolveOpenCodeVariant(
                runtimeRef.baseUrl,
                runtimeRef.cwd,
                normalizedModel,
                options.reasoningEffort,
              );
            },
          }),
    };
  }

  /**
   * Main session loop. Resolves the bridge-managed shared server (the same
   * server used by `of`) and falls back to a dedicated OpenCode server.
   */
  private async *runSession(
    cwd: string,
    queue: MessageQueue,
    signal: AbortSignal,
    options: StartSessionOptions,
    pidRef: { value?: number },
    processRef: { value?: ChildProcess },
    runtimeRef: OpenCodeRuntimeRef,
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    // Explicit legacy managed configs require an isolated env overlay. Normal
    // Yep sessions use the 4520-managed server and the user's global config,
    // exactly like `of`.
    const sharedBaseUrl = options.opencodeConfig
      ? null
      : await this.resolveBridgeManagedServer();
    const opencodePath = sharedBaseUrl ? null : await this.findOpenCodePath();

    if (!sharedBaseUrl && !opencodePath) {
      yield {
        type: "error",
        error: "OpenCode CLI not found",
      } as SDKMessage;
      return;
    }

    const selectedModel = options.opencodeConfig
      ? getManagedOpenCodeModelRef(options.opencodeConfig)
      : await this.resolveOpenCodeModelOption(options.model);

    if (options.opencodeConfig && !resolveOpenCodeGatewayConfig(process.env)) {
      yield {
        type: "error",
        error:
          "Managed OpenCode configuration requires OPENCODE_LLM_API_KEY or LLM_API_KEY",
      } as SDKMessage;
      return;
    }

    let port: number | undefined;
    let serverProcess: ChildProcess | undefined;
    let baseUrl = sharedBaseUrl;
    if (!baseUrl) {
      // A stale dedicated server must not impersonate the freshly spawned
      // child, so let the OS reserve a free port instead of reusing a counter.
      try {
        port = await this.getAvailablePort();
      } catch (error) {
        yield {
          type: "error",
          error: `Failed to allocate an OpenCode server port: ${error instanceof Error ? error.message : String(error)}`,
        } as SDKMessage;
        return;
      }
      baseUrl = `http://127.0.0.1:${port}`;
    }
    runtimeRef.baseUrl = baseUrl;
    runtimeRef.cwd = cwd;
    runtimeRef.sharedServer = Boolean(sharedBaseUrl);

    if (!sharedBaseUrl && opencodePath && port !== undefined) {
      try {
        serverProcess = spawn(
          opencodePath,
          [
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            String(port),
            "--print-logs",
          ],
          {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: this.getOpenCodeEnv(options.opencodeConfig),
            shell: process.platform === "win32",
          },
        );
        pidRef.value = serverProcess.pid;
        processRef.value = serverProcess;
      } catch (error) {
        yield {
          type: "error",
          error: `Failed to spawn OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
        } as SDKMessage;
        return;
      }
    }

    // Handle abort
    const abortHandler = () => {
      runtimeRef.alive = false;
      if (serverProcess) {
        log.info({ port }, "Aborting dedicated OpenCode server");
        serverProcess.kill("SIGTERM");
        return;
      }
      if (runtimeRef.sessionId) {
        log.info(
          { sessionId: runtimeRef.sessionId, baseUrl },
          "Aborting shared OpenCode session",
        );
        void this.abortOpenCodeSession(baseUrl, runtimeRef.sessionId, cwd);
      }
    };
    signal.addEventListener("abort", abortHandler);

    // Wait for server to be ready
    const serverReady = await this.waitForServer(
      baseUrl,
      10000,
      cwd,
      serverProcess,
    );
    if (!serverReady) {
      serverProcess?.kill("SIGTERM");
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: `OpenCode server failed to start${serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined ? ` (exit code ${serverProcess.exitCode})` : ""}`,
      } as SDKMessage;
      return;
    }

    runtimeRef.alive = true;
    log.info(
      { port, cwd, baseUrl, sharedServer: Boolean(sharedBaseUrl) },
      "OpenCode server ready",
    );

    const configApplied = await this.configureServer(
      baseUrl,
      options,
      cwd,
      selectedModel,
    );
    if (!configApplied.ok) {
      serverProcess?.kill("SIGTERM");
      runtimeRef.alive = false;
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: configApplied.error,
      } as SDKMessage;
      return;
    }
    runtimeRef.currentModel = configApplied.model;
    runtimeRef.currentVariant = await this.resolveOpenCodeVariant(
      baseUrl,
      cwd,
      configApplied.model,
      options.reasoningEffort,
    );
    const sessionPermission = this.buildOpenCodeSessionPermission(
      options.permissionMode,
    );

    // Create, resume, or fork a session on the server.
    let opencodeSessionId: string;
    let shouldTagSessionCreatedByYep = false;
    let preparedSessionMetadata: Record<string, unknown> | undefined;
    try {
      const sessionData = await this.prepareOpenCodeSession(
        baseUrl,
        options,
        cwd,
        configApplied.model,
        sessionPermission,
      );
      opencodeSessionId = sessionData.id;
      preparedSessionMetadata = sessionData.metadata;
      // New sessions are already created with Yep metadata in the POST body,
      // but keep the compatibility PATCH for OpenCode versions that ignored
      // create-time metadata. Edit forks are patched synchronously inside
      // prepareOpenCodeSession because lineage is correctness data there.
      shouldTagSessionCreatedByYep = !options.resumeSessionId;
      runtimeRef.sessionId = opencodeSessionId;
      log.info(
        {
          opencodeSessionId,
          resumeSessionId: options.resumeSessionId ?? null,
          resumeSessionAt: options.resumeSessionAt ?? null,
        },
        "OpenCode session prepared",
      );
    } catch (error) {
      serverProcess?.kill("SIGTERM");
      runtimeRef.alive = false;
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`,
      } as SDKMessage;
      return;
    }

    if (shouldTagSessionCreatedByYep) {
      await this.markOpenCodeSessionCreatedByYep(
        baseUrl,
        opencodeSessionId,
        cwd,
        preparedSessionMetadata,
      );
    }

    // Use OpenCode's persisted session ID so Yep process ownership lines up
    // with the session stored in ~/.local/share/opencode/opencode.db.
    const sessionId = opencodeSessionId;

    // Emit init message
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd,
      model: runtimeRef.currentModel ?? undefined,
      // Expose the user's model-independent preference to Yep so it survives
      // later messages and live model switches. The effective variant remains
      // runtimeRef.currentVariant and is the only value sent to OpenCode.
      reasoningEffort: options.reasoningEffort ?? "default",
    } as SDKMessage;

    try {
      // Process messages from the queue
      const messageGen = queue.generator();
      let isFirstNewMessage = true;
      for await (const message of messageGen) {
        if (signal.aborted) break;

        // Extract text from the user message
        let userPrompt = this.extractTextFromMessage(message);
        const fileParts = this.buildOpenCodeFileParts(message);

        // Prepend global instructions to the first message of new sessions
        if (isFirstNewMessage && options.globalInstructions) {
          userPrompt = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userPrompt}`;
        }
        isFirstNewMessage = false;

        // Emit user message
        yield {
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userPrompt,
          },
        } as SDKMessage;

        // Send message to OpenCode server and stream response
        yield* this.sendMessageAndStream(
          baseUrl,
          opencodeSessionId,
          sessionId,
          userPrompt,
          signal,
          options.onToolApproval,
          runtimeRef.currentModel,
          runtimeRef.currentVariant,
          cwd,
          fileParts,
        );
      }
    } finally {
      log.info(
        { port, sessionId, sharedServer: Boolean(sharedBaseUrl) },
        sharedBaseUrl
          ? "Detaching from shared OpenCode server"
          : "Shutting down dedicated OpenCode server",
      );
      signal.removeEventListener("abort", abortHandler);

      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill("SIGTERM");
      }
      runtimeRef.alive = false;
      runtimeRef.baseUrl = undefined;
      runtimeRef.cwd = undefined;
      runtimeRef.sessionId = undefined;
      runtimeRef.sharedServer = undefined;
    }
  }

  private async prepareOpenCodeSession(
    baseUrl: string,
    options: StartSessionOptions,
    cwd: string,
    model: string | null,
    permission: OpenCodePermissionRule[],
  ): Promise<OpenCodeSessionResponse> {
    if (!options.resumeSessionId) {
      return this.createOpenCodeSession(baseUrl, cwd, model, permission);
    }

    if (options.resumeSessionAt) {
      const forked = await this.forkOpenCodeSession(
        baseUrl,
        options.resumeSessionId,
        options.resumeSessionAt,
        cwd,
      );
      const metadata = await this.patchOpenCodeForkMetadata(
        baseUrl,
        forked,
        {
          schemaVersion: 1,
          kind: "edit-fork",
          parentSessionId: options.resumeSessionId,
          forkMessageId: options.resumeSessionAt,
          createdAt: new Date().toISOString(),
        },
        cwd,
      );
      await this.patchOpenCodeSessionPermission(
        baseUrl,
        forked.id,
        cwd,
        permission,
      );
      return { ...forked, metadata };
    }

    await this.getOpenCodeSession(baseUrl, options.resumeSessionId, cwd);
    await this.patchOpenCodeSessionPermission(
      baseUrl,
      options.resumeSessionId,
      cwd,
      permission,
    );
    return { id: options.resumeSessionId };
  }

  private async createOpenCodeSession(
    baseUrl: string,
    cwd: string,
    model: string | null,
    permission: OpenCodePermissionRule[],
  ): Promise<OpenCodeSessionResponse> {
    const response = await fetch(this.openCodeUrl(baseUrl, "/session", cwd), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...this.openCodeDirectoryHeaders(cwd),
      },
      body: JSON.stringify(
        this.buildOpenCodeSessionCreatePayload(cwd, model, permission),
      ),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status}`);
    }

    return (await response.json()) as OpenCodeSessionResponse;
  }

  private async patchOpenCodeSessionPermission(
    baseUrl: string,
    sessionId: string,
    cwd: string,
    permission: OpenCodePermissionRule[],
  ): Promise<void> {
    const response = await fetch(
      this.openCodeUrl(
        baseUrl,
        `/session/${encodeURIComponent(sessionId)}`,
        cwd,
      ),
      {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...this.openCodeDirectoryHeaders(cwd),
        },
        body: JSON.stringify({ permission }),
      },
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Failed to configure session permissions: ${response.status}${errorText ? ` ${errorText}` : ""}`,
      );
    }
  }

  private async markOpenCodeSessionCreatedByYep(
    baseUrl: string,
    sessionId: string,
    cwd: string,
    existingMetadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await fetch(
        this.openCodeUrl(
          baseUrl,
          `/session/${encodeURIComponent(sessionId)}`,
          cwd,
        ),
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...this.openCodeDirectoryHeaders(cwd),
          },
          body: JSON.stringify({
            metadata: {
              ...(existingMetadata ?? {}),
              ...this.buildYepOpenCodeSessionMetadata(),
            },
          }),
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        getLogger().warn(
          {
            sessionId,
            status: response.status,
            error: errorText || undefined,
          },
          "Failed to mark OpenCode session creation source",
        );
      }
    } catch (error) {
      getLogger().warn(
        {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to mark OpenCode session creation source",
      );
    }
  }

  private async patchOpenCodeForkMetadata(
    baseUrl: string,
    forkedSession: OpenCodeSessionResponse,
    yepFork: YepOpenCodeForkMetadata,
    cwd?: string,
  ): Promise<Record<string, unknown>> {
    const log = getLogger();
    let existingMetadata = forkedSession.metadata;

    // Current OpenCode returns the complete forked session, including the
    // metadata cloned from its parent. Fall back to GET for older/alternate
    // HTTP surfaces so the replacement-style PATCH never discards fields.
    if (!existingMetadata) {
      try {
        const loaded = await this.getOpenCodeSession(
          baseUrl,
          forkedSession.id,
          cwd,
        );
        existingMetadata = loaded.metadata;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn(
          {
            event: "opencode_session_fork_metadata_patch_failed",
            parentSessionId: yepFork.parentSessionId,
            forkSessionId: forkedSession.id,
            forkMessageId: yepFork.forkMessageId,
            error: detail,
          },
          "OpenCode edit fork was created but existing metadata could not be loaded",
        );
        throw new Error(
          `OpenCode fork ${forkedSession.id} was created, but Yep fork lineage metadata could not be persisted because existing metadata could not be loaded: ${detail}`,
        );
      }
    }

    const metadata = {
      ...(existingMetadata ?? {}),
      ...this.buildYepOpenCodeSessionMetadata(),
      // Override any yepFork cloned from the parent. This relation must point
      // from the new child to its direct source session.
      yepFork,
    };

    let response: Response;
    try {
      response = await fetch(
        this.openCodeUrl(
          baseUrl,
          `/session/${encodeURIComponent(forkedSession.id)}`,
          cwd,
        ),
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...this.openCodeDirectoryHeaders(cwd),
          },
          body: JSON.stringify({ metadata }),
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn(
        {
          event: "opencode_session_fork_metadata_patch_failed",
          parentSessionId: yepFork.parentSessionId,
          forkSessionId: forkedSession.id,
          forkMessageId: yepFork.forkMessageId,
          error: detail,
        },
        "OpenCode edit fork was created but lineage metadata could not be persisted",
      );
      throw new Error(
        `OpenCode fork ${forkedSession.id} was created, but Yep fork lineage metadata could not be persisted: ${detail}`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      log.warn(
        {
          event: "opencode_session_fork_metadata_patch_failed",
          parentSessionId: yepFork.parentSessionId,
          forkSessionId: forkedSession.id,
          forkMessageId: yepFork.forkMessageId,
          status: response.status,
          error: errorText || undefined,
        },
        "OpenCode edit fork was created but lineage metadata could not be persisted",
      );
      throw new Error(
        `OpenCode fork ${forkedSession.id} was created, but Yep fork lineage metadata could not be persisted (${response.status}${errorText ? `: ${errorText}` : ""})`,
      );
    }

    log.info(
      {
        event: "opencode_session_fork_metadata_patched",
        parentSessionId: yepFork.parentSessionId,
        forkSessionId: forkedSession.id,
        forkMessageId: yepFork.forkMessageId,
        schemaVersion: yepFork.schemaVersion,
        kind: yepFork.kind,
      },
      "OpenCode edit fork lineage metadata persisted",
    );
    return metadata;
  }

  private async getOpenCodeSession(
    baseUrl: string,
    sessionId: string,
    cwd?: string,
  ): Promise<OpenCodeSessionResponse> {
    const response = await fetch(
      this.openCodeUrl(
        baseUrl,
        `/session/${encodeURIComponent(sessionId)}`,
        cwd,
      ),
      {
        headers: {
          Accept: "application/json",
          ...this.openCodeDirectoryHeaders(cwd),
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to load session ${sessionId}: ${response.status}`,
      );
    }

    return (await response.json()) as OpenCodeSessionResponse;
  }

  private async forkOpenCodeSession(
    baseUrl: string,
    sessionId: string,
    messageId: string,
    cwd?: string,
  ): Promise<OpenCodeSessionResponse> {
    const log = getLogger();
    log.info(
      {
        event: "opencode_session_fork_requested",
        parentSessionId: sessionId,
        forkMessageId: messageId,
      },
      "OpenCode edit fork requested",
    );
    const response = await fetch(
      this.openCodeUrl(
        baseUrl,
        `/session/${encodeURIComponent(sessionId)}/fork`,
        cwd,
      ),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...this.openCodeDirectoryHeaders(cwd),
        },
        body: JSON.stringify({ messageID: messageId }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Failed to fork session ${sessionId} at ${messageId}: ${response.status}${errorText ? ` ${errorText}` : ""}`,
      );
    }

    const forked = (await response.json()) as OpenCodeSessionResponse;
    log.info(
      {
        event: "opencode_session_fork_completed",
        parentSessionId: sessionId,
        forkSessionId: forked.id,
        forkMessageId: messageId,
      },
      "OpenCode edit fork created",
    );
    return forked;
  }

  /**
   * Send a message to OpenCode and stream the response via SSE.
   */
  private async *sendMessageAndStream(
    baseUrl: string,
    opencodeSessionId: string,
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onToolApproval?: StartSessionOptions["onToolApproval"],
    model?: string | null,
    variant?: string,
    cwd?: string,
    fileParts: readonly OpenCodeFilePartInput[] = [],
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();

    const sseUrl = this.openCodeUrl(baseUrl, "/event", cwd);
    const sseController = new AbortController();
    let sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let sseReaderCancellation: Promise<void> | null = null;
    const abortSse = () => {
      if (sseReader && !sseReaderCancellation) {
        sseReaderCancellation = sseReader.cancel().catch(() => undefined);
      }
      sseController.abort();
    };
    if (signal.aborted) {
      abortSse();
    } else {
      signal.addEventListener("abort", abortSse, { once: true });
    }
    const emissionState: OpenCodeEmissionState = {
      toolUseIds: new Set(),
      toolResultIds: new Set(),
      toolUseInputs: new Map(),
      markerPartIds: new Set(),
      streamingPartTypes: new Map(),
      permissionAskedIds: new Set(),
    };

    // Event buffer and signaling for producer/consumer pattern
    // Using an object to avoid TypeScript control flow issues across async boundaries
    const state = {
      eventBuffer: [] as SDKMessage[],
      sseError: null as Error | null,
      sseConnected: false,
      postComplete: false,
      postError: null as Error | null,
      responseError: null as string | null,
      resolveWaiting: null as (() => void) | null,
    };
    let lifecycle: OpenCodeLifecycleState = reduceOpenCodeLifecycle(
      createOpenCodeLifecycleState(),
      { type: "start-turn", now: Date.now() },
    );
    const unsettledToolParts = new Set<string>();
    let resultReady = false;
    let nextSafetyReconcileAt = Date.now() + this.lifecycleReconcileIntervalMs;
    const transitionLifecycle = (action: OpenCodeLifecycleAction) => {
      const previous = lifecycle;
      const next = reduceOpenCodeLifecycle(previous, action);
      if (
        next === previous &&
        action.type === "terminal" &&
        previous.phase === "terminal"
      ) {
        log.debug(
          {
            event: "opencode_terminal_duplicate_ignored",
            sessionId: opencodeSessionId,
            turnGeneration: previous.generation,
            eventSequence: previous.sequence,
          },
          "Ignored duplicate OpenCode terminal signal",
        );
      }
      lifecycle = next;
      if (
        next.idleCandidate &&
        next.idleCandidate.startedAt !== previous.idleCandidate?.startedAt
      ) {
        nextSafetyReconcileAt = Math.min(
          nextSafetyReconcileAt,
          next.idleCandidate.startedAt + this.lifecycleQuietWindowMs,
        );
      }
      if (
        next.phase !== previous.phase ||
        next.waitingInput !== previous.waitingInput
      ) {
        log.info(
          {
            event: "opencode_lifecycle_transition",
            sessionId: opencodeSessionId,
            turnGeneration: next.generation,
            previousPhase: previous.phase,
            nextPhase: next.phase,
            eventSequence: next.sequence,
            source: action.type,
          },
          "OpenCode lifecycle transition",
        );
      }
      if (!previous.idleCandidate && next.idleCandidate) {
        log.debug(
          {
            event: "opencode_idle_candidate_created",
            sessionId: opencodeSessionId,
            turnGeneration: next.generation,
            eventSequence: next.sequence,
          },
          "OpenCode idle candidate created",
        );
      } else if (
        previous.idleCandidate &&
        !next.idleCandidate &&
        next.phase !== "terminal"
      ) {
        const upstreamStatus =
          action.type === "status-event" || action.type === "status-reconciled"
            ? action.status.type
            : undefined;
        log.debug(
          {
            event:
              upstreamStatus === "busy" || upstreamStatus === "retry"
                ? "opencode_idle_suppressed_by_busy"
                : "opencode_idle_candidate_cancelled",
            sessionId: opencodeSessionId,
            turnGeneration: next.generation,
            eventSequence: next.sequence,
            upstreamStatus,
            candidateAgeMs: action.now - previous.idleCandidate.startedAt,
          },
          "OpenCode idle candidate cancelled by newer activity",
        );
      }
      state.resolveWaiting?.();
    };
    let resolveSseReady: () => void = () => undefined;
    const sseReady = new Promise<void>((resolve) => {
      resolveSseReady = resolve;
    });
    const waitForSseReconnect = (): Promise<void> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sseController.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 500);
        sseController.signal.addEventListener("abort", finish, { once: true });
        if (sseController.signal.aborted) finish();
      });

    // Start SSE immediately and keep reconnecting while the turn is active.
    // Status reconciliation preserves lifecycle truth during the gap; the
    // reconnected stream resumes incremental content and input events.
    const consumeSseConnection = async (): Promise<void> => {
      try {
        const response = await fetch(sseUrl, {
          headers: {
            Accept: "text/event-stream",
            ...this.openCodeDirectoryHeaders(cwd),
          },
          signal: sseController.signal,
        });

        if (!response.ok || !response.body) {
          log.error({ status: response.status }, "Failed to connect to SSE");
          state.sseError = new Error(
            `SSE connection failed: ${response.status}`,
          );
          resolveSseReady();
          return;
        }

        log.debug({ sseUrl }, "SSE connected");
        state.sseConnected = true;
        resolveSseReady();

        const reader = response.body.getReader();
        sseReader = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        let currentAssistantMessageId: string | null = null;
        const messageRoles = new Map<string, "user" | "assistant">();

        while (!sseController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.slice(6);
            const event = parseOpenCodeSSEEvent(
              data,
            ) as OpenCodeRuntimeEvent | null;
            if (!event) continue;

            log.trace({ event }, "SSE event received");

            // A shared OpenCode instance can stream several sessions in the
            // same directory. Nested info/part payloads must be filtered too.
            const eventSessionId = openCodeRuntimeEventSessionId(event);
            if (eventSessionId && eventSessionId !== opencodeSessionId) {
              continue;
            }

            if (event.type === "session.error") {
              const errorEvent = event as OpenCodeSessionErrorEvent;
              if (errorEvent.properties.sessionID !== opencodeSessionId) {
                continue;
              }
              const runtimeError = this.formatOpenCodeError(
                errorEvent.properties.error,
              );
              if (runtimeError) {
                state.responseError = runtimeError;
                transitionLifecycle({
                  type: "terminal",
                  now: Date.now(),
                  kind: "failed",
                });
                state.resolveWaiting?.();
              }
              continue;
            }

            if (event.type === "message.updated") {
              const info = (event as OpenCodeMessageUpdatedEvent).properties
                .info;
              messageRoles.set(info.id, info.role);
              const evidence = readOpenCodeAssistantTerminalEvidence({ info });
              if (evidence) {
                transitionLifecycle({
                  type: "assistant-evidence",
                  now: Date.now(),
                  evidence,
                });
              }
            }

            if (
              event.type === "message.part.updated" ||
              event.type === "message.part.delta"
            ) {
              transitionLifecycle({ type: "activity", now: Date.now() });
            }

            if (event.type === "message.part.updated") {
              const part = (event as OpenCodeMessagePartUpdatedEvent).properties
                .part;
              const pending = isOpenCodeToolPartPending(part);
              if (pending !== null) {
                if (pending) unsettledToolParts.add(part.id);
                else unsettledToolParts.delete(part.id);
                transitionLifecycle({
                  type: "unsettled-tools",
                  now: Date.now(),
                  count: unsettledToolParts.size,
                });
              }
            }

            if (event.type === "session.idle") {
              transitionLifecycle({
                type: "status-event",
                now: Date.now(),
                status: { type: "idle" },
              });
            }
            if (event.type === "session.status") {
              const status = parseOpenCodeUpstreamStatus(
                (event as { properties?: { status?: unknown } }).properties
                  ?.status,
              );
              if (status) {
                transitionLifecycle({
                  type: "status-event",
                  now: Date.now(),
                  status,
                });
              }
            }

            const inputAsked =
              event.type === "permission.asked" ||
              event.type === "question.asked";
            if (inputAsked) {
              transitionLifecycle({
                type: "pending-input",
                now: Date.now(),
                pending: true,
              });
            } else if (
              event.type === "permission.replied" ||
              event.type === "question.replied" ||
              event.type === "question.rejected"
            ) {
              transitionLifecycle({
                type: "pending-input",
                now: Date.now(),
                pending: false,
              });
              nextSafetyReconcileAt = Date.now();
            }

            // Convert to SDK message
            const sdkMessages = await this.convertSSEEventToSDKMessages(
              event,
              baseUrl,
              sessionId,
              currentAssistantMessageId,
              signal,
              messageRoles,
              emissionState,
              text,
              onToolApproval,
              cwd,
            );

            // The converter waits for Yep's answer and posts it upstream. Do
            // not depend on a replied event that may have raced the callback.
            if (inputAsked) {
              transitionLifecycle({
                type: "pending-input",
                now: Date.now(),
                pending: false,
              });
              nextSafetyReconcileAt = Date.now();
            }

            for (const sdkMessage of sdkMessages) {
              // Track assistant message ID for consistent streaming
              if (
                sdkMessage.type === "assistant" &&
                "uuid" in sdkMessage &&
                sdkMessage.uuid
              ) {
                currentAssistantMessageId = sdkMessage.uuid as string;
              }
              state.eventBuffer.push(sdkMessage);
            }
            // Wake up consumer if waiting
            if (sdkMessages.length > 0) state.resolveWaiting?.();
          }
        }
      } catch (error) {
        if (!sseController.signal.aborted) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          if (!state.sseConnected) {
            log.error({ error }, "SSE connection error");
            state.sseError = normalized;
          } else {
            log.warn(
              { error },
              "OpenCode SSE disconnected; lifecycle status polling remains active",
            );
            nextSafetyReconcileAt = Date.now();
          }
        }
      } finally {
        resolveSseReady();
        if (!sseController.signal.aborted && state.sseConnected) {
          nextSafetyReconcileAt = Date.now();
        }
        state.resolveWaiting?.();
      }
    };
    const ssePromise = (async () => {
      while (!sseController.signal.aborted && !state.sseError) {
        await consumeSseConnection();
        if (sseController.signal.aborted || state.sseError) break;
        await waitForSseReconnect();
      }
    })();

    // Subscribe before starting the async prompt so fast turns cannot finish
    // before Yep is listening for their terminal session.idle event.
    const sseHandshakeTimeoutMs = Math.max(1, Math.min(this.timeout, 10_000));
    const sseHandshakeTimeout = setTimeout(() => {
      state.sseError = new Error("Timed out connecting to OpenCode SSE");
      abortSse();
      resolveSseReady();
    }, sseHandshakeTimeoutMs);
    await sseReady;
    clearTimeout(sseHandshakeTimeout);

    // Start the prompt asynchronously so long-running turns cannot hit
    // undici's response-header timeout while content streams over SSE.
    const messagePromise = state.sseError
      ? Promise.resolve()
      : (async () => {
          log.debug(
            {
              opencodeSessionId,
              textLength: text.length,
              filePartCount: fileParts.length,
            },
            "Sending message to OpenCode",
          );
          const response = await fetch(
            this.openCodeUrl(
              baseUrl,
              `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
              cwd,
            ),
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                ...this.openCodeDirectoryHeaders(cwd),
              },
              body: JSON.stringify(
                this.buildOpenCodeMessagePayload(
                  text,
                  model,
                  variant,
                  fileParts,
                ),
              ),
              signal,
            },
          );

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
              `Failed to send message: ${response.status} ${errorText}`,
            );
          }
          log.debug({ opencodeSessionId }, "OpenCode prompt accepted");
          // Bootstrap from the authoritative status map in case a very fast
          // turn completed before its first incremental event was observed.
          nextSafetyReconcileAt = Date.now();
        })()
          .catch((error) => {
            if (signal.aborted) return;
            state.postError =
              error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            state.postComplete = true;
            state.resolveWaiting?.();
          });
    if (state.sseError) state.postComplete = true;

    const reconcileLifecycle = async (): Promise<void> => {
      const expectedSequence = lifecycle.sequence;
      try {
        const response = await fetch(
          this.openCodeUrl(baseUrl, "/session/status", cwd),
          {
            headers: {
              Accept: "application/json",
              ...this.openCodeDirectoryHeaders(cwd),
            },
            signal: AbortSignal.timeout(3_000),
          },
        );
        if (!response.ok) {
          throw new Error(`OpenCode status returned ${response.status}`);
        }
        const statusMap = await response.json();
        if (lifecycle.sequence !== expectedSequence) return;
        const status = readOpenCodeSessionStatus(statusMap, opencodeSessionId);

        if (status.type === "idle") {
          const evidence = await this.loadOpenCodeTerminalEvidence(
            baseUrl,
            opencodeSessionId,
            cwd,
          );
          if (lifecycle.sequence !== expectedSequence) return;
          if (evidence?.assistantEvidence) {
            transitionLifecycle({
              type: "assistant-evidence",
              now: Date.now(),
              evidence: evidence.assistantEvidence,
            });
          }
          if (evidence) {
            transitionLifecycle({
              type: "unsettled-tools",
              now: Date.now(),
              count: evidence.unsettledTools,
            });
          }
        }

        transitionLifecycle({
          type: "status-reconciled",
          now: Date.now(),
          status,
          expectedSequence: lifecycle.sequence,
          quietWindowMs: this.lifecycleQuietWindowMs,
        });
        if (
          lifecycle.phase === "terminal" &&
          lifecycle.terminalKind === "completed"
        ) {
          resultReady = true;
          log.info(
            {
              event: "opencode_idle_confirmed",
              sessionId: opencodeSessionId,
              turnGeneration: lifecycle.generation,
              eventSequence: lifecycle.sequence,
            },
            "OpenCode turn terminal idle confirmed",
          );
        }
      } catch (error) {
        if (signal.aborted || lifecycle.sequence !== expectedSequence) return;
        transitionLifecycle({
          type: "reconcile-failed",
          now: Date.now(),
          expectedSequence,
          graceMs: this.lifecycleStatusFailureGraceMs,
        });
        log.warn(
          {
            event: "opencode_status_reconcile_failed",
            sessionId: opencodeSessionId,
            turnGeneration: lifecycle.generation,
            eventSequence: lifecycle.sequence,
            error: error instanceof Error ? error.message : String(error),
          },
          "OpenCode lifecycle status reconciliation failed",
        );
        if (
          lifecycle.phase === "terminal" &&
          lifecycle.terminalKind === "interrupted"
        ) {
          state.responseError =
            "OpenCode lifecycle status remained unavailable after the active grace period";
        }
      }
    };

    // Yield events from buffer as they arrive
    try {
      while (!signal.aborted) {
        // Yield any buffered events
        while (state.eventBuffer.length > 0) {
          const event = state.eventBuffer.shift();
          if (event) yield event;
        }

        if (state.postError) {
          abortSse();
          const error = state.postError;
          log.error({ error }, "Failed to send message to OpenCode");
          await this.abortOpenCodeSession(baseUrl, opencodeSessionId, cwd);
          yield {
            type: "error",
            session_id: sessionId,
            error: error.message,
          } as SDKMessage;
          break;
        }

        if (state.responseError) {
          abortSse();
          await this.abortOpenCodeSession(baseUrl, opencodeSessionId, cwd);
          yield {
            type: "error",
            session_id: sessionId,
            error: state.responseError,
          } as SDKMessage;
          break;
        }

        if (state.sseError) {
          await this.abortOpenCodeSession(baseUrl, opencodeSessionId, cwd);
          yield {
            type: "error",
            session_id: sessionId,
            error: state.sseError.message,
          } as SDKMessage;
          break;
        }

        if (resultReady) break;

        const now = Date.now();
        if (state.postComplete && now >= nextSafetyReconcileAt) {
          await reconcileLifecycle();
          nextSafetyReconcileAt =
            Date.now() + this.lifecycleReconcileIntervalMs;
          if (resultReady || state.responseError) continue;
        }

        // Wait for more events
        await new Promise<void>((resolve) => {
          state.resolveWaiting = resolve;
          // Also resolve after a short timeout to check conditions
          setTimeout(resolve, 100);
        });
        state.resolveWaiting = null;
      }
    } finally {
      abortSse();
      signal.removeEventListener("abort", abortSse);
      const shutdownPromises = [ssePromise, messagePromise];
      if (sseReaderCancellation) {
        shutdownPromises.push(sseReaderCancellation);
      }
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const shutdownResult = await Promise.race([
        Promise.allSettled(shutdownPromises).then(() => "settled" as const),
        new Promise<"timeout">((resolve) => {
          shutdownTimer = setTimeout(() => resolve("timeout"), 2_000);
        }),
      ]);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (shutdownResult === "timeout") {
        log.warn(
          {
            event: "opencode_sse_shutdown_timeout",
            sessionId: opencodeSessionId,
          },
          "OpenCode SSE shutdown exceeded the bounded drain window",
        );
      }
    }

    // Process transitions to idle on any result. Emit exactly once, and only
    // after the projector confirmed stable terminal idle.
    if (resultReady && !signal.aborted) {
      yield this.createResultMessage(sessionId, emissionState.latestUsage);
    }
  }

  private async loadOpenCodeTerminalEvidence(
    baseUrl: string,
    sessionId: string,
    cwd?: string,
  ): Promise<{
    assistantEvidence?: "terminal" | "nonterminal" | "unknown";
    unsettledTools: number;
  } | null> {
    try {
      const url = this.openCodeUrl(
        baseUrl,
        `/session/${encodeURIComponent(sessionId)}/message`,
        cwd,
      );
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.set("limit", "20");
      const response = await fetch(parsedUrl, {
        headers: {
          Accept: "application/json",
          ...this.openCodeDirectoryHeaders(cwd),
        },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!Array.isArray(payload)) return null;

      for (let index = payload.length - 1; index >= 0; index -= 1) {
        const message = payload[index];
        const assistantEvidence =
          readOpenCodeAssistantTerminalEvidence(message);
        if (!assistantEvidence) continue;
        const record = isRecord(message) ? message : undefined;
        const parts = Array.isArray(record?.parts) ? record.parts : [];
        const unsettledTools = parts.reduce((count, part) => {
          return count + (isOpenCodeToolPartPending(part) === true ? 1 : 0);
        }, 0);
        return { assistantEvidence, unsettledTools };
      }
      return { unsettledTools: 0 };
    } catch (error) {
      getLogger().debug(
        {
          event: "opencode_terminal_evidence_unavailable",
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "OpenCode terminal message evidence unavailable; using stable-idle fallback",
      );
      return null;
    }
  }

  /**
   * Convert an OpenCode SSE event to SDK messages.
   */
  private async convertSSEEventToSDKMessages(
    event: OpenCodeRuntimeEvent,
    baseUrl: string,
    sessionId: string,
    currentMessageId: string | null,
    signal: AbortSignal,
    messageRoles: ReadonlyMap<string, "user" | "assistant">,
    emissionState: OpenCodeEmissionState,
    submittedText: string,
    onToolApproval?: StartSessionOptions["onToolApproval"],
    cwd?: string,
  ): Promise<SDKMessage[]> {
    switch (event.type) {
      case "permission.asked": {
        const permissionEvent = event as OpenCodePermissionAskedEvent;
        const permissionId = permissionEvent.properties.id;
        if (permissionId) {
          if (emissionState.permissionAskedIds.has(permissionId)) {
            getLogger().debug(
              {
                event: "opencode_permission_asked_duplicate",
                sessionId,
                permissionId,
              },
              "Ignoring duplicate OpenCode permission.asked event",
            );
            return [];
          }
          emissionState.permissionAskedIds.add(permissionId);
        }
        await this.handlePermissionAsked(
          baseUrl,
          permissionEvent,
          signal,
          onToolApproval,
          cwd,
        );
        return [];
      }

      case "question.asked": {
        await this.handleQuestionAsked(
          baseUrl,
          event as OpenCodeQuestionAskedEvent,
          signal,
          onToolApproval,
          cwd,
        );
        return [];
      }

      case "message.part.updated": {
        const partEvent = event as OpenCodeMessagePartUpdatedEvent;
        const part = partEvent.properties.part;
        const delta = partEvent.properties.delta;
        if (part.type === "text" || part.type === "reasoning") {
          emissionState.streamingPartTypes.set(part.id, part.type);
        }

        return this.convertPartToSDKMessages(
          part,
          sessionId,
          delta,
          currentMessageId,
          messageRoles.get(part.messageID),
          emissionState,
          submittedText,
        );
      }

      case "message.part.delta": {
        const deltaEvent = event as OpenCodeMessagePartDeltaEvent;
        const { properties } = deltaEvent;
        if (properties.field !== "text") return [];
        const partType =
          emissionState.streamingPartTypes.get(properties.partID) ?? "text";
        const part = {
          id: properties.partID,
          sessionID: properties.sessionID,
          messageID: properties.messageID,
          type: partType,
          text: "",
        } as OpenCodePart;
        return this.convertPartToSDKMessages(
          part,
          sessionId,
          properties.delta,
          currentMessageId,
          messageRoles.get(properties.messageID),
          emissionState,
          submittedText,
        );
      }

      case "session.idle":
        return this.flushAssistantStreamMessages(emissionState, sessionId);

      case "message.updated": {
        const info = (event as OpenCodeMessageUpdatedEvent).properties.info;
        if (info.role === "assistant") {
          this.updateEmissionUsageFromMessageInfo(emissionState, info);
        }
        return [];
      }

      case "session.status":
      case "session.created":
      case "session.updated":
      case "session.diff":
      case "server.connected":
      case "permission.replied":
      case "question.replied":
      case "question.rejected":
        // These are status events, not content - skip
        return [];

      default:
        return [];
    }
  }

  private updateEmissionUsageFromMessageInfo(
    emissionState: OpenCodeEmissionState,
    info: OpenCodeMessageUpdatedEvent["properties"]["info"],
  ): void {
    const usage = this.createUsageSummary(info.tokens, info.cost);
    if (usage) {
      emissionState.latestUsage = usage;
    }
    if (typeof info.cost === "number") {
      emissionState.latestCost = info.cost;
    }
    const model =
      info.modelID ??
      info.model?.modelID ??
      (info.providerID && info.model?.modelID
        ? `${info.providerID}/${info.model.modelID}`
        : undefined);
    if (model) {
      emissionState.latestModel = model;
    }
    if (info.finish) {
      emissionState.latestFinish = info.finish;
    }
  }

  private createUsageSummary(
    tokens: OpenCodePart["tokens"] | undefined,
    cost: number | undefined,
  ): Record<string, unknown> | undefined {
    if (!tokens && cost === undefined) return undefined;

    const usage: Record<string, unknown> = {};
    const inputTokens = tokens?.input;
    const outputTokens = tokens?.output;
    const reasoningTokens = tokens?.reasoning;
    const cacheReadTokens = tokens?.cache?.read;
    const cacheWriteTokens = tokens?.cache?.write;

    if (inputTokens !== undefined) usage.input_tokens = inputTokens;
    if (outputTokens !== undefined) usage.output_tokens = outputTokens;
    if (reasoningTokens !== undefined) usage.reasoning_tokens = reasoningTokens;
    if (cacheReadTokens !== undefined) {
      usage.cache_read_input_tokens = cacheReadTokens;
    }
    if (cacheWriteTokens !== undefined) {
      usage.cache_creation_input_tokens = cacheWriteTokens;
    }
    if (cost !== undefined) usage.cost_usd = cost;

    return Object.keys(usage).length > 0 ? usage : undefined;
  }

  private createResultMessage(
    sessionId: string,
    usage?: Record<string, unknown>,
  ): SDKMessage {
    return {
      type: "result",
      session_id: sessionId,
      ...(usage ? { usage } : {}),
    } as SDKMessage;
  }

  /**
   * Convert an OpenCode part to SDK messages.
   */
  private convertPartToSDKMessages(
    part: OpenCodePart,
    sessionId: string,
    delta: string | undefined,
    currentMessageId: string | null,
    role: "user" | "assistant" | undefined,
    emissionState: OpenCodeEmissionState,
    submittedText?: string,
  ): SDKMessage[] {
    switch (part.type) {
      case "text": {
        // Synthetic text is internal model context added by OpenCode while it
        // resolves files and other prompt parts. Match the native OpenCode UI
        // by keeping it out of the user-visible transcript.
        if (part.synthetic) return [];
        if (role === "user") return [];
        if (
          !role &&
          submittedText &&
          (delta ?? part.text ?? "").trim() === submittedText.trim()
        ) {
          return [];
        }
        return this.convertStreamingTextPartToSDKMessages(
          part,
          sessionId,
          delta,
          currentMessageId,
          emissionState,
          "text",
        );
      }

      case "reasoning": {
        if (role === "user") return [];
        return this.convertStreamingTextPartToSDKMessages(
          part,
          sessionId,
          delta,
          currentMessageId,
          emissionState,
          "thinking",
        );
      }

      case "step-start":
        // Start of a processing step - no content to emit
        return [];

      case "step-finish": {
        const messages = this.flushAssistantStreamMessages(
          emissionState,
          sessionId,
        );

        // A step can end because OpenCode is about to execute tools and start
        // another loop iteration. Preserve usage for the eventual turn result
        // without emitting a provider-level result here: Process treats every
        // result as the whole turn becoming idle and would drain its queue.
        const usage = this.createUsageSummary(part.tokens, part.cost);
        if (usage) {
          emissionState.latestUsage = usage;
        }
        return messages;
      }

      case "tool": {
        const toolUseId = part.callID ?? part.id;
        // Flush any accumulated reasoning/text stream before emitting the
        // tool_use. The client clears every `_isStreaming` placeholder when any
        // assistant message (tool_use included) arrives, so without flushing
        // here the streamed reasoning/text disappears until the eventual
        // step-finish re-emits it. Landing it as a permanent message first
        // keeps the intermediate content visible across the tool boundary.
        const messages: SDKMessage[] = this.flushAssistantStreamMessages(
          emissionState,
          sessionId,
        );
        const toolName = this.canonicalizeOpenCodeToolName(
          part.tool ?? "unknown",
        );
        const input = this.normalizeOpenCodeToolInput(
          toolName,
          part.state?.input ?? part.input ?? {},
          part.state?.metadata,
        );
        const status = part.state?.status;

        // OpenCode tool state flows pending (input often empty) -> running
        // (full input) -> completed/error. Re-emit the tool_use whenever the
        // input materially changes and no result exists yet, so the UI shows
        // real arguments instead of the initial `{}` snapshot.
        const inputFingerprint = JSON.stringify(input) ?? "";
        const previousFingerprint = emissionState.toolUseInputs.get(toolUseId);
        const isNewToolUse = !emissionState.toolUseIds.has(toolUseId);
        const inputChanged =
          !isNewToolUse &&
          !emissionState.toolResultIds.has(toolUseId) &&
          previousFingerprint !== undefined &&
          previousFingerprint !== inputFingerprint &&
          inputFingerprint !== "{}";

        if (isNewToolUse || inputChanged) {
          emissionState.toolUseIds.add(toolUseId);
          emissionState.toolUseInputs.set(toolUseId, inputFingerprint);
          messages.push({
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: toolName,
                  input,
                  opencodeStatus: status,
                  opencodeTitle: part.state?.title,
                  opencodeMetadata: part.state?.metadata,
                  opencodeTime: part.state?.time ?? part.time,
                },
              ],
            },
          } as unknown as SDKMessage);
        }

        if (
          (status === "completed" || status === "error") &&
          !emissionState.toolResultIds.has(toolUseId)
        ) {
          emissionState.toolResultIds.add(toolUseId);
          messages.push({
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content:
                    part.state?.error ??
                    part.error ??
                    this.formatToolOutput(part.state?.output ?? part.output),
                  is_error: status === "error" || !!part.state?.error,
                  opencodeStatus: status,
                  opencodeTitle: part.state?.title,
                  opencodeMetadata: part.state?.metadata,
                  opencodeTime: part.state?.time ?? part.time,
                },
              ],
            },
          } as unknown as SDKMessage);
        }

        return messages;
      }

      case "tool-use": {
        const toolName = this.canonicalizeOpenCodeToolName(
          part.tool ?? "unknown",
        );
        // Tool invocation
        return [
          {
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: part.id,
                  name: toolName,
                  input: this.normalizeOpenCodeToolInput(
                    toolName,
                    part.input ?? {},
                    part.state?.metadata,
                  ),
                  opencodeTime: part.time,
                },
              ],
            },
          } as unknown as SDKMessage,
        ];
      }

      case "tool-result": {
        // Tool result
        return [
          {
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: part.id,
                  content: part.error ?? this.formatToolOutput(part.output),
                  is_error: !!part.error,
                  opencodeTime: part.time,
                },
              ],
            },
          } as unknown as SDKMessage,
        ];
      }

      case "subtask": {
        // Subagent launch. Emit once as a visible marker so subagent work is
        // not silently dropped from the transcript.
        if (emissionState.markerPartIds.has(part.id)) return [];
        emissionState.markerPartIds.add(part.id);
        const subtask = part as unknown as {
          prompt?: string;
          description?: string;
          agent?: string;
        };
        const description =
          subtask.description?.trim() || subtask.prompt?.trim() || "";
        const agentName = subtask.agent?.trim() || "subagent";
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid: `opencode-subtask-${part.id}`,
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `**Subagent (${agentName})**: ${description}`,
                },
              ],
            },
          } as unknown as SDKMessage,
        ];
      }

      case "file": {
        // User attachment (or tool-produced file). Surface as a marker so
        // attachments are visible in the transcript.
        if (emissionState.markerPartIds.has(part.id)) return [];
        emissionState.markerPartIds.add(part.id);
        const file = part as unknown as {
          filename?: string;
          mime?: string;
          url?: string;
        };
        // Process already emitted the Yep user message with structured upload
        // metadata. Do not add a second standalone attachment bubble when
        // OpenCode echoes that same native file part back over SSE.
        if (
          role === "user" &&
          hasYepUploadMetadataForFile(submittedText, file.filename)
        ) {
          return [];
        }
        const label = getOpenCodeAttachmentLabel(file);
        const roleForFile = role === "user" ? "user" : "assistant";
        return [
          {
            type: roleForFile,
            session_id: sessionId,
            uuid: `opencode-file-${part.id}`,
            message: {
              role: roleForFile,
              content: [
                {
                  type: "text",
                  text: `📎 ${label}${file.mime ? ` (${file.mime})` : ""}`,
                },
              ],
            },
          } as unknown as SDKMessage,
        ];
      }

      case "compaction": {
        // Context compaction boundary - align with the Claude/Codex
        // compact_boundary system marker the client already renders.
        if (emissionState.markerPartIds.has(part.id)) return [];
        emissionState.markerPartIds.add(part.id);
        return [
          {
            type: "system",
            subtype: "compact_boundary",
            session_id: sessionId,
            uuid: `opencode-compaction-${part.id}`,
            content: "Context compacted",
          } as unknown as SDKMessage,
        ];
      }

      case "retry":
      case "patch":
      case "snapshot":
      case "agent":
        // retry: surfaced via session.status; patch/snapshot: internal VCS
        // bookkeeping; agent: @-mention reference already present in text.
        return [];

      default:
        return [];
    }
  }

  private canonicalizeOpenCodeToolName(toolName: string): string {
    switch (toolName.toLowerCase()) {
      case "bash":
      case "shell":
        return "Bash";
      case "read":
        return "Read";
      case "write":
        return "Write";
      case "edit":
      case "apply_patch":
        return "Edit";
      case "glob":
        return "Glob";
      case "grep":
        return "Grep";
      case "todowrite":
      case "todo":
        return "TodoWrite";
      default:
        return toolName;
    }
  }

  private normalizeOpenCodeToolInput(
    toolName: string,
    input: unknown,
    metadata?: unknown,
  ): unknown {
    const baseInput =
      input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const normalized = { ...(baseInput as Record<string, unknown>) };
    const lowerToolName = toolName.toLowerCase();
    const metadataRecord =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;

    if (
      (lowerToolName === "read" ||
        lowerToolName === "write" ||
        lowerToolName === "edit") &&
      typeof normalized.filePath === "string" &&
      typeof normalized.file_path !== "string"
    ) {
      normalized.file_path = normalized.filePath;
    }

    if (
      lowerToolName === "edit" &&
      typeof normalized.oldString === "string" &&
      typeof normalized.old_string !== "string"
    ) {
      normalized.old_string = normalized.oldString;
    }

    if (
      lowerToolName === "edit" &&
      typeof normalized.newString === "string" &&
      typeof normalized.new_string !== "string"
    ) {
      normalized.new_string = normalized.newString;
    }

    if (
      lowerToolName === "edit" &&
      typeof normalized.replaceAll === "boolean" &&
      typeof normalized.replace_all !== "boolean"
    ) {
      normalized.replace_all = normalized.replaceAll;
    }

    if (
      lowerToolName === "edit" &&
      typeof metadataRecord?.diff === "string" &&
      metadataRecord.diff.trim() &&
      typeof normalized._rawPatch !== "string"
    ) {
      normalized._rawPatch = metadataRecord.diff;
    }

    if (
      lowerToolName === "grep" &&
      typeof normalized.include === "string" &&
      typeof normalized.glob !== "string"
    ) {
      normalized.glob = normalized.include;
    }

    return normalized;
  }

  private createAssistantStreamState(): OpenCodeAssistantStreamState {
    return {
      messageId: null,
      started: false,
      stopped: false,
      nextBlockIndex: 0,
      partBlocks: new Map(),
    };
  }

  private getAssistantStreamState(
    emissionState: OpenCodeEmissionState,
  ): OpenCodeAssistantStreamState {
    if (!emissionState.assistantStream?.stopped) {
      emissionState.assistantStream ??= this.createAssistantStreamState();
      return emissionState.assistantStream;
    }

    emissionState.assistantStream = this.createAssistantStreamState();
    return emissionState.assistantStream;
  }

  private convertStreamingTextPartToSDKMessages(
    part: OpenCodePart,
    sessionId: string,
    delta: string | undefined,
    currentMessageId: string | null,
    emissionState: OpenCodeEmissionState,
    blockType: "text" | "thinking",
  ): SDKMessage[] {
    const streamState = this.getAssistantStreamState(emissionState);
    const messageId =
      streamState.messageId ?? currentMessageId ?? part.messageID;

    if (
      streamState.messageId &&
      streamState.messageId !== messageId &&
      !streamState.stopped
    ) {
      return [
        ...this.flushAssistantStreamMessages(emissionState, sessionId),
        ...this.convertStreamingTextPartToSDKMessages(
          part,
          sessionId,
          delta,
          currentMessageId,
          emissionState,
          blockType,
        ),
      ];
    }

    streamState.messageId = messageId;

    let block = streamState.partBlocks.get(part.id);
    let isNewBlock = false;
    if (!block) {
      block = {
        index: streamState.nextBlockIndex,
        type: blockType,
        text: "",
      };
      streamState.nextBlockIndex += 1;
      streamState.partBlocks.set(part.id, block);
      isNewBlock = true;
    }

    let deltaText = "";
    if (delta !== undefined) {
      deltaText = delta;
      block.text += delta;
    } else {
      const fullText = part.text ?? "";
      if (fullText.startsWith(block.text)) {
        deltaText = fullText.slice(block.text.length);
      } else {
        deltaText = fullText;
      }
      block.text = fullText;
    }

    if (!deltaText && !isNewBlock) return [];
    if (!deltaText && isNewBlock && !block.text) {
      streamState.partBlocks.delete(part.id);
      streamState.nextBlockIndex -= 1;
      return [];
    }

    const messages: SDKMessage[] = [];

    if (!streamState.started) {
      streamState.started = true;
      messages.push(
        this.createStreamEventMessage(sessionId, {
          type: "message_start",
          message: {
            id: messageId,
            role: "assistant",
            content: [],
          },
        }),
      );
    }

    if (isNewBlock) {
      messages.push(
        this.createStreamEventMessage(sessionId, {
          type: "content_block_start",
          index: block.index,
          content_block:
            block.type === "thinking"
              ? { type: "thinking", thinking: "" }
              : { type: "text", text: "" },
        }),
      );
    }

    if (deltaText) {
      messages.push(
        this.createStreamEventMessage(sessionId, {
          type: "content_block_delta",
          index: block.index,
          delta:
            block.type === "thinking"
              ? { type: "thinking_delta", thinking: deltaText }
              : { type: "text_delta", text: deltaText },
        }),
      );
    }

    return messages;
  }

  private flushAssistantStreamMessages(
    emissionState: OpenCodeEmissionState,
    sessionId: string,
  ): SDKMessage[] {
    const streamState = emissionState.assistantStream;
    if (
      !streamState?.started ||
      streamState.stopped ||
      !streamState.messageId
    ) {
      return [];
    }

    streamState.stopped = true;

    const messages: SDKMessage[] = [
      this.createStreamEventMessage(sessionId, {
        type: "message_stop",
      }),
    ];

    const contentBlocks = Array.from(streamState.partBlocks.values())
      .sort((a, b) => a.index - b.index)
      .filter((block) => block.text.length > 0)
      .map((block) =>
        block.type === "thinking"
          ? { type: "thinking" as const, thinking: block.text }
          : { type: "text" as const, text: block.text },
      );

    if (contentBlocks.length > 0) {
      const content =
        contentBlocks.length === 1 && contentBlocks[0]?.type === "text"
          ? contentBlocks[0].text
          : contentBlocks;

      messages.push({
        type: "assistant",
        session_id: sessionId,
        uuid: streamState.messageId,
        message: {
          role: "assistant",
          content,
        },
      } as SDKMessage);
    }

    return messages;
  }

  private createStreamEventMessage(
    sessionId: string,
    event: Record<string, unknown>,
  ): SDKMessage {
    return {
      type: "stream_event",
      session_id: sessionId,
      event,
    } as SDKMessage;
  }

  /** Resolve session settings without mutating OpenCode's project config. */
  private async configureServer(
    _baseUrl: string,
    options: StartSessionOptions,
    _cwd?: string,
    resolvedModel?: string | null,
  ): Promise<
    { ok: true; model: string | null } | { ok: false; error: string }
  > {
    const model =
      resolvedModel ?? (await this.resolveOpenCodeModelOption(options.model));
    // PATCH /config writes <cwd>/config.json in OpenCode. Model selection is
    // carried by session/message payloads and permission by the session record;
    // legacy managed provider definitions live only in OPENCODE_CONFIG_CONTENT
    // on their isolated process.
    getLogger().info(
      {
        permissionMode: options.permissionMode ?? "default",
        model,
        managedOpenCode: options.opencodeConfig
          ? {
              model: options.opencodeConfig.model,
              requestProtocol: options.opencodeConfig.requestProtocol,
              limits: options.opencodeConfig.limits,
            }
          : undefined,
      },
      "Configured OpenCode session without mutating project config",
    );
    return { ok: true, model };
  }

  private async resolveOpenCodeVariant(
    baseUrl: string,
    cwd: string | undefined,
    model: string | null | undefined,
    requestedVariant: string | undefined,
  ): Promise<string | undefined> {
    if (!requestedVariant || requestedVariant === "default") return undefined;
    const parsedModel = this.parseOpenCodeModelOption(model);
    if (!parsedModel) return undefined;

    try {
      const response = await fetch(
        this.openCodeUrl(baseUrl, "/config/providers", cwd),
        {
          headers: {
            Accept: "application/json",
            ...this.openCodeDirectoryHeaders(cwd),
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) {
        throw new Error(`OpenCode returned ${response.status}`);
      }

      const catalog =
        (await response.json()) as OpenCodeConfigProvidersResponse;
      const provider = catalog.providers?.find(
        (item) => item.id === parsedModel.providerID,
      );
      const variants = provider?.models?.[parsedModel.modelID]?.variants;
      if (variants && Object.hasOwn(variants, requestedVariant)) {
        return requestedVariant;
      }

      getLogger().info(
        {
          model,
          requestedVariant,
        },
        "OpenCode model does not advertise the requested variant; using Default",
      );
      return undefined;
    } catch (error) {
      getLogger().warn(
        {
          model,
          requestedVariant,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to verify OpenCode model variant; using Default",
      );
      return undefined;
    }
  }

  private mapPermissionModeToOpenCode(
    mode: PermissionMode | undefined,
  ): OpenCodePermissionConfig {
    switch (mode) {
      case "bypassPermissions":
        return { "*": "allow" };

      case "acceptEdits":
        return {
          "*": "ask",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          edit: "allow",
          write: "allow",
          webfetch: "allow",
          websearch: "allow",
          bash: "ask",
        };

      case "plan":
        return {
          "*": "ask",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          webfetch: "allow",
          websearch: "allow",
          edit: "ask",
          write: "ask",
          bash: "ask",
        };

      default:
        return {
          "*": "ask",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          webfetch: "allow",
          websearch: "allow",
          edit: "ask",
          write: "ask",
          bash: "ask",
        };
    }
  }

  private buildOpenCodeSessionPermission(
    mode: PermissionMode | undefined,
  ): OpenCodePermissionRule[] {
    // OpenCode applies the last matching permission rule. Keep the wildcard
    // fallback first so later tool-specific rules retain their intended
    // precedence.
    return Object.entries(this.mapPermissionModeToOpenCode(mode)).map(
      ([permission, action]) => ({ permission, pattern: "*", action }),
    );
  }

  private normalizeOpenCodeModelOption(
    model: string | undefined,
  ): string | null {
    const trimmed = model?.trim();
    if (!trimmed || trimmed === "default" || trimmed === "auto") {
      return null;
    }
    return trimmed;
  }

  private async resolveOpenCodeModelOption(
    model: string | undefined,
  ): Promise<string | null> {
    const normalized = this.normalizeOpenCodeModelOption(model);
    if (!normalized || normalized.includes("/")) return normalized;

    const models = await this.getAvailableModels();
    const suffixMatches = models
      .map((item) => item.id)
      .filter((id) => id.split("/").at(-1) === normalized);
    if (suffixMatches.length === 1) {
      return suffixMatches[0] ?? normalized;
    }

    const anthropicMatch = suffixMatches.find((id) =>
      id.startsWith("anthropic/"),
    );
    if (anthropicMatch) return anthropicMatch;

    const openaiMatch = suffixMatches.find((id) => id.startsWith("openai/"));
    if (openaiMatch) return openaiMatch;

    return normalized;
  }

  private parseOpenCodeModelOption(
    model: string | null | undefined,
  ): OpenCodeModelRef | null {
    if (!model) return null;
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) return null;
    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    };
  }

  private buildOpenCodeSessionCreatePayload(
    cwd: string,
    model: string | null | undefined,
    permission: OpenCodePermissionRule[] = [],
  ): OpenCodeSessionCreatePayload {
    const payload: OpenCodeSessionCreatePayload = {
      title: "Yep Anywhere Session",
      location: { directory: cwd },
      metadata: this.buildYepOpenCodeSessionMetadata(),
      ...(permission.length > 0 ? { permission } : {}),
    };
    const parsed = this.parseOpenCodeModelOption(model);
    if (parsed) {
      payload.model = {
        providerID: parsed.providerID,
        id: parsed.modelID,
      };
    }
    return payload;
  }

  private buildYepOpenCodeSessionMetadata(): Record<string, unknown> {
    return {
      createdBy: "yep",
      source: "yep-anywhere",
    };
  }

  private openCodeUrl(baseUrl: string, path: string, cwd?: string): string {
    const url = new URL(path, baseUrl);
    if (cwd) url.searchParams.set("directory", cwd);
    return url.toString();
  }

  private openCodeDirectoryHeaders(cwd?: string): Record<string, string> {
    return cwd ? { "x-opencode-directory": cwd } : {};
  }

  private buildOpenCodeMessagePayload(
    text: string,
    model: string | null | undefined,
    variant?: string,
    fileParts: readonly OpenCodeFilePartInput[] = [],
  ): OpenCodeMessagePayload {
    const payload: OpenCodeMessagePayload = {
      parts: [...fileParts, { type: "text", text }],
    };
    const parsed = this.parseOpenCodeModelOption(model);
    if (parsed) payload.model = parsed;
    if (variant && variant !== "default") payload.variant = variant;
    return payload;
  }

  /**
   * Convert Yep uploads and legacy inline image blocks into OpenCode-native
   * file parts. OpenCode resolves local file URLs and forwards their bytes to
   * multimodal models; a path embedded in prompt text does not do that.
   */
  private buildOpenCodeFileParts(
    message: QueuedUserMessage,
  ): OpenCodeFilePartInput[] {
    const parts: OpenCodeFilePartInput[] = (message.attachments ?? []).map(
      (attachment) => ({
        type: "file",
        mime: attachment.mimeType || "application/octet-stream",
        filename: attachment.originalName || attachment.name,
        url: pathToFileURL(attachment.path).href,
      }),
    );

    const content = message.message.content;
    if (!Array.isArray(content)) return parts;

    for (const block of content) {
      if (block.type !== "image" || block.source.type !== "base64") continue;
      parts.push({
        type: "file",
        mime: block.source.media_type || "image/png",
        url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`,
      });
    }

    return parts;
  }

  private async handleQuestionAsked(
    baseUrl: string,
    event: OpenCodeQuestionAskedEvent,
    signal: AbortSignal,
    onToolApproval?: StartSessionOptions["onToolApproval"],
    cwd?: string,
  ): Promise<void> {
    const questions = normalizeOpenCodeQuestions(event.properties.questions);
    if (questions.length === 0) {
      getLogger().warn(
        { questionId: event.properties.id },
        "OpenCode question request did not contain any valid questions",
      );
    }

    let result: ToolApprovalResult = {
      behavior: "deny",
      message: "No question handler available",
      interrupt: true,
    };

    if (questions.length > 0 && onToolApproval) {
      try {
        result = await onToolApproval(
          "AskUserQuestion",
          {
            questions,
            messageID: event.properties.tool?.messageID,
            callID: event.properties.tool?.callID,
          },
          { signal, requestId: event.properties.id },
        );
      } catch (error) {
        getLogger().warn(
          { questionId: event.properties.id, error },
          "OpenCode question callback failed; rejecting question",
        );
      }
    }

    const orderedAnswers = buildOpenCodeQuestionAnswersFromUpdatedInput(
      questions,
      result.updatedInput,
    );
    const allowed =
      result.behavior === "allow" &&
      questions.length > 0 &&
      orderedAnswers.every((answer) => answer.length > 0);
    if (result.behavior === "allow" && !allowed) {
      getLogger().warn(
        { questionId: event.properties.id },
        "OpenCode question approval did not contain every answer; rejecting question",
      );
    }
    const path = allowed
      ? `/question/${encodeURIComponent(event.properties.id)}/reply`
      : `/question/${encodeURIComponent(event.properties.id)}/reject`;
    const body = allowed
      ? {
          answers: orderedAnswers,
        }
      : {};
    const response = await fetch(this.openCodeUrl(baseUrl, path, cwd), {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(allowed ? { "Content-Type": "application/json" } : {}),
        ...this.openCodeDirectoryHeaders(cwd),
      },
      body: allowed ? JSON.stringify(body) : undefined,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Failed to respond to OpenCode question ${event.properties.id}: ${response.status}${errorText ? ` ${errorText}` : ""}`,
      );
    }
  }

  private async abortOpenCodeSession(
    baseUrl: string,
    sessionId: string,
    cwd?: string,
  ): Promise<void> {
    try {
      const response = await fetch(
        this.openCodeUrl(
          baseUrl,
          `/session/${encodeURIComponent(sessionId)}/abort`,
          cwd,
        ),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            ...this.openCodeDirectoryHeaders(cwd),
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) {
        getLogger().warn(
          { sessionId, status: response.status },
          "Failed to abort OpenCode session after a turn error",
        );
      }
    } catch (error) {
      getLogger().warn(
        { sessionId, error },
        "Failed to abort OpenCode session after a turn error",
      );
    }
  }

  private async handlePermissionAsked(
    baseUrl: string,
    event: OpenCodePermissionAskedEvent,
    signal: AbortSignal,
    onToolApproval?: StartSessionOptions["onToolApproval"],
    cwd?: string,
  ): Promise<void> {
    const permission = event.properties.permission;
    const toolName = this.mapOpenCodePermissionToToolName(permission);
    const toolInput = {
      permission,
      patterns: event.properties.patterns ?? [],
      metadata: event.properties.metadata ?? {},
      always: event.properties.always ?? [],
      messageID: event.properties.tool?.messageID,
      callID: event.properties.tool?.callID,
    };

    let result: ToolApprovalResult = {
      behavior: "deny",
      message: "No approval handler available",
      interrupt: true,
    };

    if (onToolApproval) {
      try {
        result = await onToolApproval(toolName, toolInput, {
          signal,
          requestId: event.properties.id,
        });
      } catch (error) {
        getLogger().warn(
          { permissionId: event.properties.id, toolName, error },
          "OpenCode approval callback failed; denying permission",
        );
      }
    }

    const reply =
      result.behavior === "allow"
        ? result.approvalScope === "always"
          ? "always"
          : "once"
        : "reject";
    const response = await fetch(
      this.openCodeUrl(
        baseUrl,
        `/permission/${encodeURIComponent(event.properties.id)}/reply`,
        cwd,
      ),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...this.openCodeDirectoryHeaders(cwd),
        },
        body: JSON.stringify({ reply }),
        signal,
      },
    );

    if (!response.ok) {
      getLogger().warn(
        {
          permissionId: event.properties.id,
          status: response.status,
          reply,
        },
        "Failed to reply to OpenCode permission request",
      );
    }
  }

  private mapOpenCodePermissionToToolName(permission: string): string {
    switch (permission.toLowerCase()) {
      case "bash":
        return "Bash";
      case "edit":
      case "write":
        return "Edit";
      case "read":
        return "Read";
      case "glob":
        return "Glob";
      case "grep":
        return "Grep";
      case "webfetch":
        return "WebFetch";
      case "websearch":
        return "WebSearch";
      default:
        return permission;
    }
  }

  private formatModelName(model: string): string {
    const [provider, modelId] = model.split("/", 2);
    if (!provider || !modelId) return model;
    return `${provider} / ${modelId}`;
  }

  private formatToolOutput(output: unknown): string {
    if (typeof output === "string") return output;
    if (output === undefined || output === null) return "";
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  private getOpenCodeEnv(
    sessionConfig?: OpenCodeSessionConfig,
  ): NodeJS.ProcessEnv {
    const gatewayConfig = resolveOpenCodeGatewayConfig(process.env);
    const env = sessionConfig
      ? buildManagedOpenCodeEnv(process.env, gatewayConfig, {
          openAICompatibleBaseURL: resolveOpenCodeOpenAICompatibleBaseURL(
            process.env,
          ),
          sessionConfig,
        })
      : buildUserConfiguredOpenCodeEnv(process.env, gatewayConfig);
    return {
      ...env,
      // Keep the global Yep forwarder plugin inert inside Yep-managed
      // per-session servers; the provider consumes their events directly.
      YEP_MANAGED_OPENCODE: "1",
    };
  }

  private formatOpenCodeError(error: unknown): string | null {
    if (!error) return null;

    if (typeof error === "string") return error;
    if (!isRecord(error)) return String(error);

    const data = error.data;
    if (isRecord(data)) {
      const message = data.message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }

    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }

    if (typeof error.name === "string" && error.name.trim()) {
      return error.name;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "OpenCode message failed";
    }
  }

  /**
   * Resolve the bridge-managed OpenCode server. `GET /status` also asks the
   * 4520 sidecar to ensure its paired server is ready, mirroring the health
   * check performed by the local `of` shell wrapper before it attaches.
   */
  private async resolveBridgeManagedServer(): Promise<string | null> {
    if (!this.bridgeControlUrl) return null;
    try {
      const response = await fetch(`${this.bridgeControlUrl}/status`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        throw new Error(`bridge returned ${response.status}`);
      }
      const payload = (await response.json()) as {
        opencodeServerUrl?: unknown;
      };
      if (
        typeof payload.opencodeServerUrl !== "string" ||
        !payload.opencodeServerUrl.trim()
      ) {
        throw new Error("bridge status omitted opencodeServerUrl");
      }
      const url = new URL(payload.opencodeServerUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`unsupported OpenCode server URL: ${url.protocol}`);
      }
      getLogger().info(
        {
          event: "opencode_shared_server_selected",
          bridgeControlUrl: this.bridgeControlUrl,
          opencodeServerUrl: url.toString(),
        },
        "Using 4520 bridge-managed OpenCode server",
      );
      return url.toString().replace(/\/+$/, "");
    } catch (error) {
      getLogger().warn(
        {
          event: "opencode_shared_server_unavailable",
          bridgeControlUrl: this.bridgeControlUrl,
          error: error instanceof Error ? error.message : String(error),
        },
        "OpenCode bridge unavailable; falling back to a dedicated server",
      );
      return null;
    }
  }

  /** Get an ephemeral localhost port that is currently available. */
  private async getAvailablePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = createServer();
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          cleanup();
          server.close();
          reject(new Error("Could not determine the OpenCode server port"));
          return;
        }

        const { port } = address;
        server.close((error) => {
          cleanup();
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
  }

  private async didChildProcessRemainRunning(
    process: ChildProcess,
    durationMs: number,
  ): Promise<boolean> {
    if (process.exitCode !== null || process.signalCode !== null) return false;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (running: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.off("exit", onExit);
        process.off("error", onError);
        resolve(running);
      };
      const onExit = () => settle(false);
      const onError = () => settle(false);
      const timer = setTimeout(
        () => settle(process.exitCode === null && process.signalCode === null),
        durationMs,
      );

      process.once("exit", onExit);
      process.once("error", onError);
    });
  }

  /** Wait for the spawned OpenCode server to be ready. */
  private async waitForServer(
    baseUrl: string,
    timeoutMs: number,
    cwd?: string,
    process?: ChildProcess,
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (
        process &&
        (process.exitCode !== null || process.signalCode !== null)
      ) {
        return false;
      }
      try {
        const response = await fetch(
          this.openCodeUrl(baseUrl, "/session", cwd),
          {
            headers: {
              Accept: "application/json",
              ...this.openCodeDirectoryHeaders(cwd),
            },
            signal: AbortSignal.timeout(1000),
          },
        );
        if (response.ok) {
          return process
            ? await this.didChildProcessRemainRunning(process, 150)
            : true;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return false;
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: QueuedUserMessage): string {
    const content = message.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      // Extract text from content blocks
      return content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" && block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }

  /**
   * Find the OpenCode CLI path.
   */
  private async findOpenCodePath(): Promise<string | null> {
    // Use configured path if provided
    if (this.opencodePath && existsSync(this.opencodePath)) {
      return this.opencodePath;
    }

    // Check common locations
    const commonPaths = [
      join(homedir(), ".local", "bin", "opencode"),
      "/usr/local/bin/opencode",
      join(homedir(), "bin", "opencode"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    // Try to find in PATH using which
    try {
      const { stdout } = await execAsync(whichCommand("opencode"), {
        encoding: "utf-8",
      });
      const result = stdout.trim();
      if (result && existsSync(result)) {
        return result;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }
}

/**
 * Default OpenCode provider instance.
 */
export const opencodeProvider = new OpenCodeProvider();

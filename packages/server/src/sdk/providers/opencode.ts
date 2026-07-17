/**
 * OpenCode Provider implementation using `opencode serve`.
 *
 * This provider enables using OpenCode as an agent backend.
 * It spawns a per-session OpenCode server and communicates via HTTP/SSE.
 *
 * Architecture:
 * - Each session gets its own `opencode serve` process on a unique port
 * - Messages are started via HTTP POST to /session/:id/prompt_async
 * - Responses are streamed via SSE from /event
 * - Server is killed when session is aborted or times out
 */

import { type ChildProcess, exec, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ModelInfo,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodePart,
  OpenCodeRequestProtocol,
  OpenCodeSSEEvent,
  OpenCodeSessionConfig,
  PermissionMode,
  ReasoningEffortInfo,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import {
  ALL_OPENCODE_REQUEST_PROTOCOLS,
  parseOpenCodeSSEEvent,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import {
  buildManagedOpenCodeEnv,
  fetchOpenCodeGatewayModels,
  getManagedOpenCodeModelRef,
  resolveOpenCodeGatewayConfig,
  resolveOpenCodeOpenAICompatibleBaseURL,
} from "../../opencode-bridge/gateway-config.js";
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
 * Configuration for OpenCode provider.
 */
export interface OpenCodeProviderConfig {
  /** Path to opencode binary (auto-detected if not specified) */
  opencodePath?: string;
  /** Request timeout in ms (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Base port to start from (auto-selects if not specified) */
  basePort?: number;
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

function mergeReasoningEfforts(
  ...lists: Array<ReasoningEffortInfo[] | undefined>
): ReasoningEffortInfo[] {
  const merged: ReasoningEffortInfo[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const effort of list ?? []) {
      if (!effort.reasoningEffort || seen.has(effort.reasoningEffort)) continue;
      seen.add(effort.reasoningEffort);
      merged.push(effort);
    }
  }
  return merged;
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
}

interface OpenCodeMessagePayload {
  parts: Array<{ type: "text"; text: string }>;
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
  assistantStream?: OpenCodeAssistantStreamState;
  latestUsage?: Record<string, unknown>;
  latestCost?: number;
  latestModel?: string;
  latestFinish?: string;
  emittedUsageResult?: boolean;
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
 * Uses `opencode serve` to run a per-session server, communicating via HTTP/SSE.
 */
export class OpenCodeProvider implements AgentProvider {
  readonly name = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly opencodePath?: string;
  private readonly timeout: number;
  private gatewayModelCache?: {
    cacheKey: string;
    expiresAt: number;
    models: ModelInfo[];
  };

  constructor(config: OpenCodeProviderConfig = {}) {
    this.opencodePath = config.opencodePath;
    this.timeout = config.timeout ?? 300000; // 5 minutes default
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

    const gatewayConfig = resolveOpenCodeGatewayConfig(process.env);
    if (gatewayConfig) {
      const cacheKey = `${gatewayConfig.apiBase}:${gatewayConfig.apiKey}`;
      if (
        this.gatewayModelCache?.cacheKey === cacheKey &&
        this.gatewayModelCache.expiresAt > Date.now()
      ) {
        return this.gatewayModelCache.models;
      }
    }

    const cliModelsPromise = this.loadOpenCodeCliModels(opencodePath);
    if (gatewayConfig) {
      const cacheKey = `${gatewayConfig.apiBase}:${gatewayConfig.apiKey}`;
      try {
        const models = await fetchOpenCodeGatewayModels(gatewayConfig);
        if (models.length > 0) {
          const mergedModels = this.mergeGatewayModelReasoningMetadata(
            models,
            await cliModelsPromise,
          );
          this.gatewayModelCache = {
            cacheKey,
            expiresAt: Date.now() + 60_000,
            models: mergedModels,
          };
          return mergedModels;
        }
      } catch (error) {
        getLogger().warn(
          {
            apiBase: gatewayConfig.apiBase,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to load OpenCode gateway model catalog; falling back to CLI models",
        );
      }
    }

    const cliModels = await cliModelsPromise;
    if (cliModels.length > 0) return cliModels;

    // Return default models if both CLI catalog commands fail.
    return [
      { id: "opencode/big-pickle", name: "Big Pickle (Free)" },
      { id: "auto", name: "Auto (recommended)" },
    ];
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

      models.push({
        id: header.catalogId,
        name: this.formatModelName(header.catalogId),
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

  private mergeGatewayModelReasoningMetadata(
    gatewayModels: ModelInfo[],
    cliModels: ModelInfo[],
  ): ModelInfo[] {
    const discoveredByModel = new Map<string, ReasoningEffortsByProtocol>();
    for (const cliModel of cliModels) {
      const modelId = parseOpenCodeModelHeader(cliModel.id)?.modelId;
      if (!modelId || !cliModel.supportedReasoningEffortsByProtocol) continue;

      const discovered = discoveredByModel.get(modelId) ?? {};
      for (const protocol of ALL_OPENCODE_REQUEST_PROTOCOLS) {
        discovered[protocol] = mergeReasoningEfforts(
          discovered[protocol],
          cliModel.supportedReasoningEffortsByProtocol[protocol],
        );
        if (discovered[protocol]?.length === 0) {
          delete discovered[protocol];
        }
      }
      discoveredByModel.set(modelId, discovered);
    }

    return gatewayModels.map((model) => {
      const protocols = model.supportedRequestProtocols?.length
        ? model.supportedRequestProtocols
        : [...ALL_OPENCODE_REQUEST_PROTOCOLS];
      const discovered = discoveredByModel.get(model.id);
      const byProtocol: ReasoningEffortsByProtocol = {};

      for (const protocol of protocols) {
        const efforts = mergeReasoningEfforts(
          model.supportedReasoningEffortsByProtocol?.[protocol],
          discovered?.[protocol],
        );
        if (efforts.length > 0) byProtocol[protocol] = efforts;
      }

      const protocolEfforts = protocols.map((protocol) => byProtocol[protocol]);
      const supportedReasoningEfforts = mergeReasoningEfforts(
        ...protocolEfforts,
        model.supportedReasoningEfforts,
      );
      if (supportedReasoningEfforts.length === 0) return model;

      return {
        ...model,
        supportedReasoningEfforts,
        supportedReasoningEffortsByProtocol: byProtocol,
      };
    });
  }

  /**
   * Start a new OpenCode session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
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
              await this.patchServerConfig(
                runtimeRef.baseUrl,
                {
                  model: normalizedModel ?? undefined,
                },
                runtimeRef.cwd,
              );
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
   * Main session loop.
   * Spawns an OpenCode server and manages HTTP/SSE communication.
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
    const opencodePath = await this.findOpenCodePath();

    if (!opencodePath) {
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

    // Ask the OS for a free port instead of reusing a counter that resets when
    // Yep restarts. A stale OpenCode server can otherwise impersonate the
    // freshly spawned child on the old counter port.
    let port: number;
    try {
      port = await this.getAvailablePort();
    } catch (error) {
      yield {
        type: "error",
        error: `Failed to allocate an OpenCode server port: ${error instanceof Error ? error.message : String(error)}`,
      } as SDKMessage;
      return;
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    runtimeRef.baseUrl = baseUrl;
    runtimeRef.cwd = cwd;

    // Start the OpenCode server
    let serverProcess: ChildProcess;
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

    // Handle abort
    const abortHandler = () => {
      log.info({ port }, "Aborting OpenCode server");
      serverProcess.kill("SIGTERM");
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
      serverProcess.kill("SIGTERM");
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: `OpenCode server failed to start${serverProcess.exitCode !== null ? ` (exit code ${serverProcess.exitCode})` : ""}`,
      } as SDKMessage;
      return;
    }

    log.info({ port, cwd }, "OpenCode server ready");

    const configApplied = await this.configureServer(
      baseUrl,
      options,
      cwd,
      selectedModel,
    );
    if (!configApplied.ok) {
      serverProcess.kill("SIGTERM");
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
      );
      opencodeSessionId = sessionData.id;
      preparedSessionMetadata = sessionData.metadata;
      // New sessions are already created with Yep metadata in the POST body,
      // but keep the compatibility PATCH for OpenCode versions that ignored
      // create-time metadata. Edit forks are patched synchronously inside
      // prepareOpenCodeSession because lineage is correctness data there.
      shouldTagSessionCreatedByYep = !options.resumeSessionId;
      log.info(
        {
          opencodeSessionId,
          resumeSessionId: options.resumeSessionId ?? null,
          resumeSessionAt: options.resumeSessionAt ?? null,
        },
        "OpenCode session prepared",
      );
    } catch (error) {
      serverProcess.kill("SIGTERM");
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
        );
      }
    } finally {
      // Clean up server
      log.info({ port, sessionId }, "Shutting down OpenCode server");
      signal.removeEventListener("abort", abortHandler);

      if (!serverProcess.killed) {
        serverProcess.kill("SIGTERM");
      }
      runtimeRef.baseUrl = undefined;
      runtimeRef.cwd = undefined;
    }
  }

  private async prepareOpenCodeSession(
    baseUrl: string,
    options: StartSessionOptions,
    cwd: string,
    model: string | null,
  ): Promise<OpenCodeSessionResponse> {
    if (!options.resumeSessionId) {
      return this.createOpenCodeSession(baseUrl, cwd, model);
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
      return { ...forked, metadata };
    }

    await this.getOpenCodeSession(baseUrl, options.resumeSessionId, cwd);
    return { id: options.resumeSessionId };
  }

  private async createOpenCodeSession(
    baseUrl: string,
    cwd: string,
    model: string | null,
  ): Promise<OpenCodeSessionResponse> {
    const response = await fetch(this.openCodeUrl(baseUrl, "/session", cwd), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...this.openCodeDirectoryHeaders(cwd),
      },
      body: JSON.stringify(this.buildOpenCodeSessionCreatePayload(cwd, model)),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status}`);
    }

    return (await response.json()) as OpenCodeSessionResponse;
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
    };

    // Event buffer and signaling for producer/consumer pattern
    // Using an object to avoid TypeScript control flow issues across async boundaries
    const state = {
      eventBuffer: [] as SDKMessage[],
      sseError: null as Error | null,
      sseComplete: false,
      postComplete: false,
      postError: null as Error | null,
      responseError: null as string | null,
      sawSessionIdle: false,
      resolveWaiting: null as (() => void) | null,
    };
    let resolveSseReady: () => void = () => undefined;
    const sseReady = new Promise<void>((resolve) => {
      resolveSseReady = resolve;
    });

    // Start SSE connection immediately (runs in background)
    const ssePromise = (async () => {
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

            // Filter to only events for our session
            if (
              "properties" in event &&
              event.properties &&
              "sessionID" in event.properties
            ) {
              if (event.properties.sessionID !== opencodeSessionId) continue;
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
                state.resolveWaiting?.();
              }
              continue;
            }

            if (event.type === "message.updated") {
              const info = (event as OpenCodeMessageUpdatedEvent).properties
                .info;
              messageRoles.set(info.id, info.role);
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

            // Terminal signal: session.status(type=idle) is the current
            // upstream contract; session.idle is deprecated but still emitted
            // by older servers.
            if (event.type === "session.idle") {
              state.sawSessionIdle = true;
              log.debug({ opencodeSessionId }, "Session idle, stopping SSE");
              return;
            }
            if (event.type === "session.status") {
              const statusType = (
                event as { properties?: { status?: { type?: string } } }
              ).properties?.status?.type;
              if (statusType === "idle") {
                state.sawSessionIdle = true;
                log.debug(
                  { opencodeSessionId },
                  "Session status idle, stopping SSE",
                );
                return;
              }
            }
          }
        }
      } catch (error) {
        if (!sseController.signal.aborted) {
          log.error({ error }, "SSE connection error");
          state.sseError =
            error instanceof Error ? error : new Error(String(error));
        }
      } finally {
        resolveSseReady();
        if (
          !sseController.signal.aborted &&
          !state.sawSessionIdle &&
          !state.responseError &&
          !state.sseError
        ) {
          state.sseError = new Error("OpenCode SSE ended before session.idle");
        }
        state.sseComplete = true;
        state.resolveWaiting?.();
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
            { opencodeSessionId, textLength: text.length },
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
                this.buildOpenCodeMessagePayload(text, model, variant),
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

        // session.idle closes our SSE reader; also wait for prompt_async to be
        // accepted so immediate HTTP failures are not lost at turn end.
        if (state.sseComplete && state.postComplete) break;

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
      await sseReaderCancellation;
      await Promise.allSettled([ssePromise, messagePromise]);
    }

    // Emit result message
    yield this.createResultMessage(
      sessionId,
      emissionState.emittedUsageResult ? undefined : emissionState.latestUsage,
    );
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
        await this.handlePermissionAsked(
          baseUrl,
          event as OpenCodePermissionAskedEvent,
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

        // End of processing step - emit usage info if available
        const usage = this.createUsageSummary(part.tokens, part.cost);
        if (usage) {
          emissionState.latestUsage = usage;
          emissionState.emittedUsageResult = true;
          messages.push(this.createResultMessage(sessionId, usage));
        }
        return messages;
      }

      case "tool": {
        const toolUseId = part.callID ?? part.id;
        const messages: SDKMessage[] = [];
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
        const label = file.filename ?? file.url ?? "attachment";
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

  /**
   * Apply per-session OpenCode config to the dedicated server process.
   */
  private async configureServer(
    baseUrl: string,
    options: StartSessionOptions,
    cwd?: string,
    resolvedModel?: string | null,
  ): Promise<
    { ok: true; model: string | null } | { ok: false; error: string }
  > {
    const config: Record<string, unknown> = {
      permission: this.mapPermissionModeToOpenCode(options.permissionMode),
    };
    const model =
      resolvedModel ?? (await this.resolveOpenCodeModelOption(options.model));
    if (model) {
      config.model = model;
    }
    try {
      await this.patchServerConfig(baseUrl, config, cwd);

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
        "Configured OpenCode server",
      );
      return { ok: true, model };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to configure OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async patchServerConfig(
    baseUrl: string,
    config: Record<string, unknown>,
    cwd?: string,
  ): Promise<void> {
    const response = await fetch(this.openCodeUrl(baseUrl, "/config", cwd), {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...this.openCodeDirectoryHeaders(cwd),
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Failed to configure OpenCode server: ${response.status}${errorText ? ` ${errorText}` : ""}`,
      );
    }
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
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          edit: "allow",
          write: "allow",
          webfetch: "allow",
          websearch: "allow",
          bash: "ask",
          "*": "ask",
        };

      case "plan":
        return {
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          webfetch: "allow",
          websearch: "allow",
          edit: "ask",
          write: "ask",
          bash: "ask",
          "*": "ask",
        };

      default:
        return {
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          webfetch: "allow",
          websearch: "allow",
          edit: "ask",
          write: "ask",
          bash: "ask",
          "*": "ask",
        };
    }
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
  ): OpenCodeSessionCreatePayload {
    const payload: OpenCodeSessionCreatePayload = {
      title: "Yep Anywhere Session",
      location: { directory: cwd },
      metadata: this.buildYepOpenCodeSessionMetadata(),
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
  ): OpenCodeMessagePayload {
    const payload: OpenCodeMessagePayload = {
      parts: [{ type: "text", text }],
    };
    const parsed = this.parseOpenCodeModelOption(model);
    if (parsed) payload.model = parsed;
    if (variant && variant !== "default") payload.variant = variant;
    return payload;
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
          { signal },
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
        result = await onToolApproval(toolName, toolInput, { signal });
      } catch (error) {
        getLogger().warn(
          { permissionId: event.properties.id, toolName, error },
          "OpenCode approval callback failed; denying permission",
        );
      }
    }

    const reply = result.behavior === "allow" ? "once" : "reject";
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
    return {
      ...buildManagedOpenCodeEnv(process.env, gatewayConfig, {
        openAICompatibleBaseURL: resolveOpenCodeOpenAICompatibleBaseURL(
          process.env,
        ),
        sessionConfig,
      }),
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

import {
  type ChildProcessWithoutNullStreams,
  exec,
  spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ContextStatusSdkPayload,
  LlmGatewayRequestProtocol,
  LlmGatewaySessionConfig,
  ModelInfo,
  SessionRetryStatus,
  SlashCommand,
  ThinkingConfig,
} from "@yep-anywhere/shared";
import { getDataDir } from "../../config.js";
import {
  LLM_GATEWAYS_ENV,
  type LlmGatewayChannel,
  fetchLlmGatewayModels,
  isVisibleGatewayModel,
  resolveLlmGatewayChannels,
  resolveLlmGatewayProxyBaseUrl,
} from "../../llm-gateways/index.js";
import { getLogger } from "../../logging/logger.js";
import {
  PI_SESSIONS_DIR,
  PI_SESSION_DIR_IS_EXACT,
  findPiSessionFile,
  getPiProjectSessionDir,
} from "../../sessions/pi-files.js";
import {
  piProviderId,
  qualifyPiModelId,
} from "../../sessions/pi-model-refs.js";
import {
  canonicalizePiToolName,
  normalizePiToolInput,
} from "../../sessions/pi-tools.js";
import { whichCommand } from "../cli-detection.js";
import {
  MessageQueue,
  buildUserPromptProjection,
  getUserPromptProjection,
} from "../messageQueue.js";
import type {
  ContentBlock,
  QueuedUserMessage,
  SDKMessage,
  UserMessage,
} from "../types.js";
import { filterEnvForChildProcess } from "./env-filter.js";
import {
  type PiAnthropicModelTraits,
  type PiThinkingLevelMap,
  piAnthropicModelTraits,
} from "./pi-model-compat.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

const execAsync = promisify(exec);
const PI_APPROVAL_TITLE_PREFIX = "__YEP_PI_TOOL_APPROVAL__:";
const PI_MODEL_CATALOG_TTL_MS = 60_000;
const PI_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const PI_PICKER_REASONING_EFFORTS = ["low", "medium", "high"] as const;

/**
 * Pi's detectCompat targets api.openai.com by default: it promotes the system
 * prompt to the "developer" role and sends `store`/`max_completion_tokens`.
 * Generic OpenAI-compatible gateways (LiteLLM/one-api style, including the
 * shared aggregator gateways) reject the developer role with a 400, so pin the
 * strictly portable request shape for every dynamically registered model.
 */
const PI_OPENAI_COMPLETIONS_COMPAT = {
  supportsDeveloperRole: false,
  supportsStore: false,
  maxTokensField: "max_tokens",
} as const;

export interface PiProviderConfig {
  /** Path to the Pi executable (auto-detected when omitted). */
  piPath?: string;
  /** Pi native session root. */
  sessionsDir?: string;
  /** Isolated Pi config/settings directory for Yep-owned processes. */
  agentDir?: string;
  /** Bundled Yep extension path (test seam). */
  extensionPath?: string;
  /** RPC command timeout. */
  timeout?: number;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface PiRpcResponse extends JsonRecord {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PiModelRoute {
  /** Gateway channel this model is served by. */
  channel: LlmGatewayChannel;
  /** Model id as the gateway (and therefore Pi) knows it. */
  bareModelId: string;
  protocols: LlmGatewayRequestProtocol[];
}

/** Route metadata retained at catalog-fetch time, before ids are flattened. */
interface PiCatalogRoute {
  channelId: string;
  bareModelId: string;
  protocols: LlmGatewayRequestProtocol[];
}

interface PiModelCatalog {
  models: ModelInfo[];
  /** Yep-facing model id -> unambiguous source route. */
  routes: Map<string, PiCatalogRoute>;
}

interface PiRuntimeRef {
  client?: PiRpcClient;
  models: ModelInfo[];
  /** Yep-facing (channel-qualified) model id -> routing information. */
  routes: Map<string, PiModelRoute>;
  currentProtocol?: LlmGatewayRequestProtocol;
  currentModel?: string;
  sessionId?: string;
  contextWindow?: number;
}

interface PiStreamState {
  assistantId: string | null;
  blocks: Map<number, ContentBlock>;
  sequence: number;
}

interface PiExtensionProviderConfig {
  globalInstructions?: string;
  providers: Array<{
    id: string;
    config: {
      name: string;
      baseUrl: string;
      api: "openai-completions" | "anthropic-messages";
      headers?: Record<string, string>;
      models: Array<{
        id: string;
        name: string;
        reasoning: boolean;
        input: Array<"text" | "image">;
        cost: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
        };
        contextWindow: number;
        maxTokens: number;
        thinkingLevelMap?: PiThinkingLevelMap;
        compat?:
          | typeof PI_OPENAI_COMPLETIONS_COMPAT
          | NonNullable<PiAnthropicModelTraits["compat"]>;
      }>;
    };
  }>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Map Pi's `auto_retry_start` payload onto Yep's provider-neutral retry status.
 *
 * `delayMs` is a duration; the UI renders a wall-clock deadline, so it is
 * resolved against the moment the event arrived.
 */
function piRetryStatus(event: JsonRecord): SessionRetryStatus {
  const attempt = numberValue(event.attempt);
  const maxAttempts = numberValue(event.maxAttempts);
  const delayMs = numberValue(event.delayMs);
  const errorMessage = stringValue(event.errorMessage);
  const message =
    errorMessage && maxAttempts
      ? `${errorMessage} (attempt ${attempt ?? 1}/${maxAttempts})`
      : errorMessage;
  return {
    ...(attempt !== undefined ? { attempt } : {}),
    ...(message ? { message } : {}),
    ...(delayMs !== undefined ? { next: Date.now() + delayMs } : {}),
  };
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function protocolApi(
  protocol: LlmGatewayRequestProtocol,
): "openai-completions" | "anthropic-messages" {
  return protocol === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function anthropicGatewayBaseUrl(apiBase: string): string {
  return apiBase.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function normalizePiThinkingLevel(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "default" || normalized === "auto") {
    return "medium";
  }
  if (normalized === "on") return "medium";
  if (PI_THINKING_LEVELS.has(normalized)) return normalized;
  throw new Error(`Pi does not support thinking level "${value}"`);
}

function initialPiThinkingLevel(
  thinking: ThinkingConfig | undefined,
  effort: string | undefined,
): string {
  if (thinking?.type === "disabled" || !thinking) return "off";
  return normalizePiThinkingLevel(effort);
}

function cloneModels(models: readonly ModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    ...model,
    supportedRequestProtocols: model.supportedRequestProtocols
      ? [...model.supportedRequestProtocols]
      : undefined,
    supportedReasoningEfforts: model.supportedReasoningEfforts?.map(
      (effort) => ({ ...effort }),
    ),
  }));
}

function clonePiModelCatalog(catalog: PiModelCatalog): PiModelCatalog {
  return {
    models: cloneModels(catalog.models),
    routes: new Map(
      Array.from(
        catalog.routes,
        ([modelId, route]): [string, PiCatalogRoute] => [
          modelId,
          { ...route, protocols: [...route.protocols] },
        ],
      ),
    ),
  };
}

/**
 * Dynamically registered Pi models have no thinkingLevelMap, so upstream Pi
 * exposes off/minimal/low/medium/high and clamps xhigh/max. Yep's shared picker
 * has no minimal preset; advertise only the three lossless named levels.
 */
function withPiReasoningCapabilities(models: ModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    ...model,
    supportedReasoningEfforts: PI_PICKER_REASONING_EFFORTS.map(
      (reasoningEffort) => ({ reasoningEffort }),
    ),
    defaultReasoningEffort: "medium",
    supportsEffort: true,
  }));
}

function modelProtocols(model: ModelInfo): LlmGatewayRequestProtocol[] {
  return model.supportedRequestProtocols?.length
    ? [...model.supportedRequestProtocols]
    : ["openai-compatible", "anthropic"];
}

function applyPiSessionModelConfig(
  models: ModelInfo[],
  sessionConfig: LlmGatewaySessionConfig | undefined,
): ModelInfo[] {
  if (!sessionConfig) return models;
  return models.map((model) => {
    if (model.id !== sessionConfig.model) return model;
    return {
      ...model,
      name: sessionConfig.name ?? model.name,
      contextWindow: sessionConfig.limits?.context ?? model.contextWindow,
      maxOutputTokens: sessionConfig.limits?.output ?? model.maxOutputTokens,
    };
  });
}

/**
 * Build the process-local Pi provider catalog: one generated provider per
 * (gateway channel x request protocol) that has at least one model.
 *
 * Models are registered under their bare gateway id because Pi identifies a
 * model as a (provider, modelId) pair; the channel namespace only exists on
 * Yep's side.
 */
function buildPiExtensionConfig(
  routes: Map<string, PiModelRoute>,
  models: ModelInfo[],
  globalInstructions?: string,
): PiExtensionProviderConfig {
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const providers: PiExtensionProviderConfig["providers"] = [];
  const byProvider = new Map<
    string,
    {
      channel: LlmGatewayChannel;
      protocol: LlmGatewayRequestProtocol;
      models: PiExtensionProviderConfig["providers"][number]["config"]["models"];
    }
  >();

  for (const [qualifiedId, route] of routes) {
    const model = modelsById.get(qualifiedId);
    if (!model) continue;
    for (const protocol of route.protocols) {
      const id = piProviderId(protocol, route.channel);
      const entry = byProvider.get(id) ?? {
        channel: route.channel,
        protocol,
        models: [],
      };
      entry.models.push({
        id: route.bareModelId,
        name: model.name || route.bareModelId,
        // The gateway catalog does not expose a universal reasoning flag.
        // Register reasoning support; the session starts with thinking off
        // unless the user opts in through Yep's Codex-style control.
        reasoning: true,
        input: ["text", "image"] as Array<"text" | "image">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow ?? 200_000,
        maxTokens:
          model.maxOutputTokens ??
          Math.min(32_768, Math.max(4_096, model.contextWindow ?? 32_768)),
        ...(protocol === "openai-compatible"
          ? { compat: PI_OPENAI_COMPLETIONS_COMPAT }
          : // Current Claude releases reject the legacy budget-based thinking
            // payload, which is all Pi sends for a model registered without
            // these traits.
            piAnthropicModelTraits(route.bareModelId)),
      });
      byProvider.set(id, entry);
    }
  }

  for (const [id, entry] of byProvider) {
    if (entry.models.length === 0) continue;
    const { channel, protocol } = entry;
    const headers = channel.subModule
      ? { "X-Sub-Module": channel.subModule }
      : undefined;
    const baseUrl =
      protocol === "anthropic"
        ? // @anthropic-ai/sdk appends /v1/messages itself; a gateway base
          // already ends in /v1.
          anthropicGatewayBaseUrl(channel.apiBase)
        : // Only the default channel can use the bridge's gateway proxy: that
          // proxy has one hardcoded upstream (the default gateway) and injects
          // its sub-module header, so routing another channel through it would
          // silently send the request to the wrong gateway.
          ((channel.isDefault
            ? resolveLlmGatewayProxyBaseUrl(process.env)
            : undefined) ?? channel.apiBase);
    providers.push({
      id,
      config: {
        name: `${channel.label} (${
          protocol === "anthropic" ? "Anthropic" : "OpenAI-compatible"
        })`,
        baseUrl,
        api: protocolApi(protocol),
        headers,
        models: entry.models,
      },
    });
  }

  return {
    providers,
    ...(globalInstructions?.trim()
      ? { globalInstructions: globalInstructions.trim() }
      : {}),
  };
}

/** Map every catalog model back to the channel and protocols that serve it. */
function buildPiModelRoutes(
  channels: readonly LlmGatewayChannel[],
  catalogRoutes: ReadonlyMap<string, PiCatalogRoute>,
): Map<string, PiModelRoute> {
  const channelsById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const routes = new Map<string, PiModelRoute>();
  for (const [modelId, catalogRoute] of catalogRoutes) {
    const channel = channelsById.get(catalogRoute.channelId);
    if (!channel) continue;
    routes.set(modelId, {
      channel,
      bareModelId: catalogRoute.bareModelId,
      protocols: [...catalogRoute.protocols],
    });
  }
  return routes;
}

/**
 * Resolve a requested model id against the active catalog.
 *
 * Sessions and saved defaults created before multi-gateway support store a
 * bare id, and a channel can also be renamed or removed, so an unqualified id
 * falls back to any channel that serves that bare model (preferring the
 * default channel) instead of failing the session start.
 */
function resolvePiModelRoute(
  routes: Map<string, PiModelRoute>,
  requested: string,
): { modelId: string; route: PiModelRoute } | null {
  const exact = routes.get(requested);
  if (exact) return { modelId: requested, route: exact };

  const candidates = Array.from(routes.entries()).filter(
    ([, route]) => route.bareModelId === requested,
  );
  const preferred =
    candidates.find(([, route]) => route.channel.isDefault) ?? candidates[0];
  if (!preferred) return null;
  return { modelId: preferred[0], route: preferred[1] };
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T | null) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  next(): Promise<T | null> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Minimal strict-LF client for Pi's documented JSONL RPC protocol. */
class PiRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private readonly events = new AsyncEventQueue<JsonRecord>();
  private readonly pending = new Map<
    string,
    {
      command: string;
      resolve: (response: PiRpcResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;

  constructor(private readonly timeoutMs: number) {}

  start(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): void {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.acceptStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (chunk.trim()) {
        // Provider stderr may include request headers or prompt fragments.
        getLogger().debug(
          { bytes: Buffer.byteLength(chunk) },
          "Pi RPC emitted stderr",
        );
      }
    });
    child.once("error", (error) => this.finish(error));
    child.once("close", (code, signal) => {
      const error =
        code === 0 || this.pending.size === 0
          ? undefined
          : new Error(
              `Pi RPC exited before responding (code=${code ?? "null"}, signal=${signal ?? "none"})`,
            );
      this.finish(error);
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  isAlive(): boolean {
    return Boolean(
      this.child && this.child.exitCode === null && !this.child.killed,
    );
  }

  async send(command: JsonRecord): Promise<PiRpcResponse> {
    const id = `yep-pi-${this.nextId++}`;
    const type = stringValue(command.type) ?? "unknown";
    const child = this.child;
    if (!child || !this.isAlive() || !child.stdin.writable) {
      throw new Error("Pi RPC process is not running");
    }

    const response = new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC command "${type}" timed out`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { command: type, resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    return response;
  }

  sendExtensionResponse(response: JsonRecord): void {
    const child = this.child;
    if (!child || !this.isAlive() || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  nextEvent(): Promise<JsonRecord | null> {
    return this.events.next();
  }

  close(): void {
    this.events.end();
    const child = this.child;
    if (!child) return;
    if (child.stdin.writable) child.stdin.end();
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  private acceptStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.acceptLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      getLogger().warn("Pi RPC emitted malformed JSONL; record ignored");
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      const response = value as PiRpcResponse;
      if (response.success) pending.resolve(response);
      else {
        pending.reject(
          new Error(
            response.error ||
              `Pi RPC command "${pending.command}" was rejected`,
          ),
        );
      }
      return;
    }
    this.events.push(value);
  }

  private finish(error?: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("Pi RPC process exited"));
    }
    this.pending.clear();
    this.events.end();
  }
}

/** Pi coding-agent provider backed by its native `--mode rpc` transport. */
export class PiProvider implements AgentProvider {
  readonly name = "pi" as const;
  readonly displayName = "Pi";
  readonly supportsPermissionMode = true;
  readonly permissionModes = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
  ] as const;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;

  private readonly configuredPath?: string;
  private readonly sessionsDir: string;
  private readonly agentDir: string;
  private readonly extensionPath: string;
  private readonly timeout: number;
  private modelCache?: { catalog: PiModelCatalog; at: number };
  /** Last successful catalog per channel, used when one gateway is failing. */
  private readonly channelModelCache = new Map<string, ModelInfo[]>();

  constructor(config: PiProviderConfig = {}) {
    this.configuredPath = config.piPath;
    this.sessionsDir = config.sessionsDir ?? PI_SESSIONS_DIR;
    this.agentDir = config.agentDir ?? join(getDataDir(), "pi-agent");
    this.extensionPath =
      config.extensionPath ??
      resolve(import.meta.dirname, "../../../resources/pi-yep-extension.mjs");
    this.timeout = config.timeout ?? 300_000;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.findPiPath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getAuthStatus()).authenticated;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    const authenticated = resolveLlmGatewayChannels(process.env).length > 0;
    return {
      installed,
      authenticated: installed && authenticated,
      enabled: installed && authenticated,
    };
  }

  /**
   * Pi mirrors Yep's executable gateway catalogs.
   *
   * Every configured channel is fetched concurrently and merged, with models
   * from non-default channels namespaced as `<channelId>/<modelId>` because
   * gateways commonly expose the same model id. A channel that fails keeps its
   * last successful catalog instead of disappearing, so one unreachable gateway
   * cannot empty the picker.
   *
   * Superseded families and non-chat endpoints are filtered out here only.
   * Session start and mid-session routing use {@link loadRoutableCatalog}, so a
   * session already pinned to a filtered-out model still resumes.
   */
  async getAvailableModels(options?: {
    waitForRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    const catalog = await this.loadRoutableCatalog(options);
    return catalog.models.filter((model) => {
      const bareModelId = catalog.routes.get(model.id)?.bareModelId ?? model.id;
      return isVisibleGatewayModel(bareModelId);
    });
  }

  /** The full catalog, including models a picker does not offer. */
  private async loadRoutableCatalog(options?: {
    waitForRefresh?: boolean;
  }): Promise<PiModelCatalog> {
    const cached = this.modelCache;
    const cacheFresh =
      cached !== undefined && Date.now() - cached.at < PI_MODEL_CATALOG_TTL_MS;
    if (cached && (cacheFresh || options?.waitForRefresh === false)) {
      return clonePiModelCatalog(cached.catalog);
    }
    const channels = resolveLlmGatewayChannels(process.env);
    if (channels.length === 0) return { models: [], routes: new Map() };

    const results = await Promise.allSettled(
      channels.map((channel) => fetchLlmGatewayModels(channel)),
    );

    const merged: ModelInfo[] = [];
    const routes = new Map<string, PiCatalogRoute>();
    let anyFresh = false;
    for (const [index, channel] of channels.entries()) {
      const result = results[index];
      let channelModels: ModelInfo[] | undefined;
      if (result?.status === "fulfilled") {
        anyFresh = true;
        // Keep the raw ids in the per-channel cache. Their source channel is
        // the only unambiguous way to distinguish a default model such as
        // `openai/gpt-5` from `gpt-5` on an extra channel named `openai`.
        channelModels = cloneModels(result.value);
        this.channelModelCache.set(channel.id, channelModels);
      } else {
        channelModels = this.channelModelCache.get(channel.id);
        getLogger().warn(
          {
            channel: channel.id,
            reusedCachedModels: channelModels?.length ?? 0,
            error:
              result?.reason instanceof Error
                ? result.reason.message
                : String(result?.reason),
          },
          "Unable to load a Pi model catalog from an LLM gateway channel",
        );
      }
      for (const rawModel of channelModels ?? []) {
        const modelId = qualifyPiModelId(channel, rawModel.id);
        const retained = routes.get(modelId);
        if (retained) {
          // The public slash-qualified id cannot represent both routes. Keep
          // the first channel (default is ordered first) and, crucially, keep
          // its original route instead of reparsing the ambiguous display id.
          getLogger().warn(
            {
              modelId,
              retainedChannel: retained.channelId,
              skippedChannel: channel.id,
              skippedBareModelId: rawModel.id,
            },
            "Ignoring an ambiguous Pi model id from an LLM gateway channel",
          );
          continue;
        }
        routes.set(modelId, {
          channelId: channel.id,
          bareModelId: rawModel.id,
          protocols: modelProtocols(rawModel),
        });
        merged.push({
          ...rawModel,
          id: modelId,
          name: channel.isDefault
            ? rawModel.name
            : `${rawModel.name} (${channel.label})`,
        });
      }
    }

    // Drop caches for channels that are no longer configured.
    const configured = new Set(channels.map((channel) => channel.id));
    for (const channelId of this.channelModelCache.keys()) {
      if (!configured.has(channelId)) this.channelModelCache.delete(channelId);
    }

    if (!anyFresh && merged.length === 0) {
      return cached
        ? clonePiModelCatalog(cached.catalog)
        : { models: [], routes: new Map() };
    }

    const models = withPiReasoningCapabilities(merged);
    const catalog = { models, routes };
    this.modelCache = { catalog: clonePiModelCatalog(catalog), at: Date.now() };
    return clonePiModelCatalog(catalog);
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue({
      preserveAttachments: true,
      preserveClientMetadata: true,
    });
    if (options.initialMessage) queue.push(options.initialMessage);

    const abortController = new AbortController();
    const runtime: PiRuntimeRef = { models: [], routes: new Map() };
    const iterator = this.runSession(
      options,
      queue,
      runtime,
      abortController.signal,
    );
    const requireClient = (): PiRpcClient => {
      if (!runtime.client) throw new Error("Pi RPC is not initialized yet");
      return runtime.client;
    };
    const routeModel = async (
      requestedModelId: string,
      preferredProtocol?: LlmGatewayRequestProtocol,
    ) => {
      const resolved = resolvePiModelRoute(runtime.routes, requestedModelId);
      if (!resolved) {
        throw new Error(
          `Pi model "${requestedModelId}" is not in the active catalog`,
        );
      }
      const { modelId, route } = resolved;
      const protocols = route.protocols;
      const protocol =
        preferredProtocol && protocols.includes(preferredProtocol)
          ? preferredProtocol
          : runtime.currentProtocol &&
              protocols.includes(runtime.currentProtocol)
            ? runtime.currentProtocol
            : protocols[0];
      if (!protocol) throw new Error(`Pi model "${modelId}" has no endpoint`);
      await requireClient().send({
        type: "set_model",
        provider: piProviderId(protocol, route.channel),
        // Pi knows the model under its bare gateway id; the channel namespace
        // only exists on Yep's side.
        modelId: route.bareModelId,
      });
      runtime.currentModel = modelId;
      runtime.currentProtocol = protocol;
      runtime.contextWindow = runtime.models.find(
        (model) => model.id === modelId,
      )?.contextWindow;
    };

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        queue.close();
        const client = runtime.client;
        if (client?.isAlive()) {
          void client.send({ type: "abort" }).catch(() => undefined);
        }
        client?.close();
      },
      isProcessAlive: () => runtime.client?.isAlive() ?? false,
      get pid() {
        return runtime.client?.pid;
      },
      steer: async (message) => {
        const projection = buildUserPromptProjection(message);
        await requireClient().send({
          type: "steer",
          message: projection.internalPrompt,
          images: this.imagesFromUserMessage(message),
        });
        return true;
      },
      interrupt: async () => {
        await requireClient().send({ type: "abort" });
      },
      supportedModels: async () => this.getAvailableModels(),
      supportedCommands: async (): Promise<SlashCommand[]> => {
        const response = await requireClient().send({ type: "get_commands" });
        const data = isRecord(response.data) ? response.data : {};
        const commands = Array.isArray(data.commands) ? data.commands : [];
        return commands.flatMap((command): SlashCommand[] => {
          if (!isRecord(command) || typeof command.name !== "string") return [];
          return [
            {
              name: command.name,
              description:
                typeof command.description === "string"
                  ? command.description
                  : "",
            },
          ];
        });
      },
      setModel: async (model) => {
        if (!model) throw new Error("Pi requires an explicit model");
        await routeModel(model);
      },
      setMaxThinkingTokens: async (tokens) => {
        const level = tokens && tokens > 0 ? "medium" : "off";
        await requireClient().send({ type: "set_thinking_level", level });
      },
      setReasoningEffort: async (effort) => {
        await requireClient().send({
          type: "set_thinking_level",
          level: normalizePiThinkingLevel(effort),
        });
      },
      compact: async () => {
        await requireClient().send({ type: "compact" });
      },
      getContextUsage: async (): Promise<ContextStatusSdkPayload | null> => {
        const response = await requireClient().send({
          type: "get_session_stats",
        });
        const data = isRecord(response.data) ? response.data : {};
        const context = isRecord(data.contextUsage)
          ? data.contextUsage
          : undefined;
        const tokens = numberValue(context?.tokens);
        const contextWindow = numberValue(context?.contextWindow);
        const percentage = numberValue(context?.percent);
        const model = runtime.currentModel;
        if (!model || tokens === undefined || contextWindow === undefined) {
          return null;
        }
        return {
          source: "sdk",
          model,
          totalTokens: tokens,
          maxTokens: contextWindow,
          rawMaxTokens: contextWindow,
          percentage: percentage ?? (tokens / contextWindow) * 100,
          categories: [],
          mcpTools: [],
          memoryFiles: [],
          agents: [],
        };
      },
      initializationResult: async () => ({
        models: runtime.models.map((model) => ({
          id: model.id,
          contextWindow: model.contextWindow,
        })),
      }),
    };
  }

  private async *runSession(
    options: StartSessionOptions,
    queue: MessageQueue,
    runtime: PiRuntimeRef,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const piPath = await this.findPiPath();
    if (!piPath) {
      yield {
        type: "error",
        error:
          "Pi CLI not found. Install @earendil-works/pi-coding-agent and ensure `pi` is on PATH.",
      };
      return;
    }
    if (!existsSync(this.extensionPath)) {
      yield {
        type: "error",
        error: `Yep's Pi extension is missing: ${this.extensionPath}`,
      };
      return;
    }

    const channels = resolveLlmGatewayChannels(process.env);
    if (channels.length === 0) {
      yield {
        type: "error",
        error:
          "Pi requires an LLM gateway (YEP_LLM_GATEWAY_API_KEY or a compatible legacy alias, plus any extra channels in YEP_LLM_GATEWAYS).",
      };
      return;
    }

    try {
      const catalog = await this.loadRoutableCatalog();
      const gatewaySessionConfig = options.llmGatewayConfig;
      const models = applyPiSessionModelConfig(
        catalog.models,
        gatewaySessionConfig,
      );
      if (models.length === 0) {
        throw new Error("No LLM gateway channel returned any model for Pi");
      }
      runtime.models = models;
      runtime.routes = buildPiModelRoutes(channels, catalog.routes);

      const requestedModelId =
        gatewaySessionConfig?.model ?? options.model ?? models[0]?.id;
      if (!requestedModelId) throw new Error("No Pi model is available");
      // Sessions created before multi-gateway support stored bare model ids,
      // so an unqualified id resolves against any serving channel instead of
      // failing the resume.
      const resolvedModel = resolvePiModelRoute(
        runtime.routes,
        requestedModelId,
      );
      if (!resolvedModel) {
        throw new Error(`Pi model "${requestedModelId}" is not available`);
      }
      const requestedModel = resolvedModel.modelId;
      const requestedRoute = resolvedModel.route;
      if (requestedModel !== requestedModelId) {
        getLogger().info(
          {
            requestedModel: requestedModelId,
            resolvedModel: requestedModel,
            channel: requestedRoute.channel.id,
          },
          "Resolved a Pi model id without a channel prefix to a gateway channel",
        );
      }
      const requestedProtocols = requestedRoute.protocols;
      const requestedProtocol =
        gatewaySessionConfig?.requestProtocol &&
        requestedProtocols.includes(gatewaySessionConfig.requestProtocol)
          ? gatewaySessionConfig.requestProtocol
          : requestedProtocols[0];
      if (!requestedProtocol) {
        throw new Error(`Pi model "${requestedModel}" has no usable endpoint`);
      }
      const requestedProviderId = piProviderId(
        requestedProtocol,
        requestedRoute.channel,
      );

      const existing = options.resumeSessionId
        ? await findPiSessionFile(options.resumeSessionId, this.sessionsDir)
        : null;
      if (options.resumeSessionId && !existing) {
        throw new Error(
          `Pi session "${options.resumeSessionId}" was not found`,
        );
      }
      const activeSessionDir = existing
        ? dirname(existing.filePath)
        : PI_SESSION_DIR_IS_EXACT
          ? this.sessionsDir
          : getPiProjectSessionDir(options.cwd, this.sessionsDir);
      const args = [
        "--mode",
        "rpc",
        // Pin startup to the generated provider so a stale default persisted
        // in Yep's isolated Pi settings cannot block a later catalog change.
        "--provider",
        requestedProviderId,
        "--model",
        requestedRoute.bareModelId,
        "--session-dir",
        activeSessionDir,
        "--no-extensions",
        "--extension",
        this.extensionPath,
      ];
      if (existing) {
        args.push("--session", existing.filePath);
      }

      const childEnv = filterEnvForChildProcess(process.env);
      // Pi's bash tool inherits this environment, so every gateway credential
      // and the channel declaration itself are removed. The extension receives
      // the keys through YEP_PI_LLM_API_KEYS and deletes them once captured.
      // Scrub retired aliases too so a stale operator environment cannot leak
      // an unused credential into Pi tools.
      for (const key of [
        "YEP_LLM_GATEWAY_API_KEY",
        "YEP_LLM_GATEWAY_API_BASE",
        "YEP_LLM_GATEWAY_SUB_MODULE",
        "YEP_LLM_GATEWAY_PROXY_URL",
        "LLM_GATEWAY_PROXY_URL",
        "OPENCODE_LLM_API_KEY",
        "OPENCODE_LLM_API_BASE",
        "OPENCODE_LLM_SUB_MODULE",
        "LLM_API_KEY",
        "LLM_API_BASE",
        "LLM_SUB_MODULE",
        LLM_GATEWAYS_ENV,
        ...channels.flatMap((channel) =>
          channel.apiKeyEnv ? [channel.apiKeyEnv] : [],
        ),
      ]) {
        delete childEnv[key];
      }
      const extensionConfig = buildPiExtensionConfig(
        runtime.routes,
        models,
        options.globalInstructions,
      );
      childEnv.YEP_PI_LLM_API_KEYS = JSON.stringify(
        Object.fromEntries(
          extensionConfig.providers.flatMap((provider) => {
            const channel = channels.find(
              (candidate) =>
                piProviderId("anthropic", candidate) === provider.id ||
                piProviderId("openai-compatible", candidate) === provider.id,
            );
            return channel ? [[provider.id, channel.apiKey]] : [];
          }),
        ),
      );
      childEnv.YEP_PI_PROVIDER_CONFIG = JSON.stringify(extensionConfig);
      // Pi persists every RPC set_model/set_thinking_level call to its global
      // settings.json. Keep that managed state out of the user's ~/.pi tree;
      // sessions still use the explicit native session directory above.
      childEnv.PI_CODING_AGENT_DIR = this.agentDir;
      childEnv.PI_SKIP_VERSION_CHECK = "1";

      const client = new PiRpcClient(this.timeout);
      runtime.client = client;
      client.start(piPath, args, options.cwd, childEnv);

      if (options.resumeSessionAt) {
        const fork = await client.send({
          type: "fork",
          entryId: options.resumeSessionAt,
        });
        const data = isRecord(fork.data) ? fork.data : {};
        if (data.cancelled === true) {
          throw new Error("Pi cancelled the requested session fork");
        }
      }

      // A native fork replaces Pi's AgentSession and replays the source
      // branch's model/thinking entries. Apply Yep's requested values after
      // that replacement so the edited turn uses the current form settings.
      await client.send({
        type: "set_model",
        provider: requestedProviderId,
        modelId: requestedRoute.bareModelId,
      });
      runtime.currentModel = requestedModel;
      runtime.currentProtocol = requestedProtocol;
      runtime.contextWindow = models.find(
        (model) => model.id === requestedModel,
      )?.contextWindow;

      const thinkingLevel = initialPiThinkingLevel(
        options.thinking,
        options.reasoningEffort ?? options.effort,
      );
      await client.send({ type: "set_thinking_level", level: thinkingLevel });

      const stateResponse = await client.send({ type: "get_state" });
      const state = isRecord(stateResponse.data) ? stateResponse.data : {};
      const sessionId = stringValue(state.sessionId);
      if (!sessionId) throw new Error("Pi RPC state omitted the session ID");
      const activeThinkingLevel =
        stringValue(state.thinkingLevel) ?? thinkingLevel;
      runtime.sessionId = sessionId;

      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
        model: requestedModel,
        reasoningEffort: activeThinkingLevel,
      };

      for await (const message of queue.generator()) {
        if (signal.aborted) break;
        const projection = getUserPromptProjection(message);
        const userId = message.uuid ?? `pi-user-${Date.now()}`;
        yield {
          type: "user",
          uuid: userId,
          session_id: sessionId,
          message: { role: "user", content: projection.publicPrompt },
        };

        await client.send({
          type: "prompt",
          message: projection.internalPrompt,
          images: this.imagesFromQueuedMessage(message),
        });

        const stream: PiStreamState = {
          assistantId: null,
          blocks: new Map(),
          sequence: 0,
        };
        let settled = false;
        while (!signal.aborted && !settled) {
          const event = await client.nextEvent();
          if (!event) {
            throw new Error("Pi RPC exited before the turn settled");
          }
          if (event.type === "agent_settled") {
            settled = true;
            // A settled turn cannot still be backing off. Clear defensively in
            // case the provider skipped `auto_retry_end` (an aborted turn does).
            options.onRetryStatus?.(undefined);
            yield {
              type: "result",
              session_id: runtime.sessionId ?? sessionId,
            };
            continue;
          }
          const emitted = await this.convertEvent(
            event,
            runtime.sessionId ?? sessionId,
            stream,
            options,
            client,
            signal,
          );
          for (const sdkMessage of emitted) yield sdkMessage;
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        getLogger().error({ error }, "Pi RPC session failed");
        yield {
          type: "error",
          session_id: runtime.sessionId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      queue.close();
      runtime.client?.close();
    }
  }

  private async convertEvent(
    event: JsonRecord,
    sessionId: string,
    stream: PiStreamState,
    options: StartSessionOptions,
    client: PiRpcClient,
    signal: AbortSignal,
  ): Promise<SDKMessage[]> {
    if (event.type === "extension_ui_request") {
      await this.handleExtensionUiRequest(event, options, client, signal);
      return [];
    }
    if (event.type === "extension_error") {
      return [
        {
          type: "error",
          session_id: sessionId,
          error: stringValue(event.error) ?? "Pi extension failed",
        },
      ];
    }
    // Pi retries a failed request inside the turn, so without these the UI
    // shows an ordinary thinking pulse for the whole backoff and the user
    // cannot tell a slow model from a rate-limited one.
    if (event.type === "auto_retry_start") {
      options.onRetryStatus?.(piRetryStatus(event));
      return [];
    }
    if (event.type === "auto_retry_end") {
      options.onRetryStatus?.(undefined);
      return [];
    }
    if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : {};
      if (message.role === "assistant") {
        stream.assistantId = `pi-assistant-${Date.now()}-${stream.sequence++}`;
        stream.blocks.clear();
      }
      return [];
    }
    if (event.type === "message_update") {
      return this.applyAssistantUpdate(event, sessionId, stream);
    }
    if (event.type === "message_end") {
      const message = isRecord(event.message) ? event.message : undefined;
      if (!message) return [];
      if (message.role === "assistant") {
        const id =
          stream.assistantId ??
          `pi-assistant-${Date.now()}-${stream.sequence++}`;
        const result = this.assistantSdkMessage(message, id, sessionId);
        stream.assistantId = null;
        stream.blocks.clear();
        const errorMessage = stringValue(message.errorMessage);
        return errorMessage && message.stopReason === "error"
          ? [
              result,
              {
                type: "error",
                session_id: sessionId,
                error: errorMessage,
              },
            ]
          : [result];
      }
      if (message.role === "toolResult") {
        return [this.toolResultSdkMessage(message, sessionId)];
      }
      return [];
    }
    return [];
  }

  private applyAssistantUpdate(
    event: JsonRecord,
    sessionId: string,
    stream: PiStreamState,
  ): SDKMessage[] {
    const update = isRecord(event.assistantMessageEvent)
      ? event.assistantMessageEvent
      : undefined;
    if (!update) return [];
    const index = numberValue(update.contentIndex);
    const contentIndex = index === undefined ? 0 : Math.trunc(index);
    const type = stringValue(update.type);

    if (type === "text_start") {
      stream.blocks.set(contentIndex, { type: "text", text: "" });
    } else if (type === "text_delta") {
      const delta = typeof update.delta === "string" ? update.delta : "";
      const current = stream.blocks.get(contentIndex);
      stream.blocks.set(contentIndex, {
        type: "text",
        text: `${current?.type === "text" ? (current.text ?? "") : ""}${delta}`,
      });
    } else if (type === "thinking_start") {
      stream.blocks.set(contentIndex, { type: "thinking", thinking: "" });
    } else if (type === "thinking_delta") {
      const delta = typeof update.delta === "string" ? update.delta : "";
      const current = stream.blocks.get(contentIndex);
      stream.blocks.set(contentIndex, {
        type: "thinking",
        thinking: `${current?.type === "thinking" ? (current.thinking ?? "") : ""}${delta}`,
      });
    } else if (type === "toolcall_end" && isRecord(update.toolCall)) {
      const call = update.toolCall;
      const id = stringValue(call.id);
      const name = stringValue(call.name);
      if (id && name) {
        stream.blocks.set(contentIndex, {
          type: "tool_use",
          id,
          name: canonicalizePiToolName(name),
          input: normalizePiToolInput(name, call.arguments),
        });
      }
    } else if (!type?.endsWith("_end")) {
      return [];
    }

    stream.assistantId ??= `pi-assistant-${Date.now()}-${stream.sequence++}`;
    return [
      {
        type: "assistant",
        uuid: stream.assistantId,
        session_id: sessionId,
        message: {
          role: "assistant",
          content: Array.from(stream.blocks.entries())
            .sort(([a], [b]) => a - b)
            .map(([, block]) => block),
        },
        usage: event.usage,
      },
    ];
  }

  private assistantSdkMessage(
    message: JsonRecord,
    id: string,
    sessionId: string,
  ): SDKMessage {
    const content = Array.isArray(message.content) ? message.content : [];
    const blocks: ContentBlock[] = [];
    for (const raw of content) {
      if (!isRecord(raw)) continue;
      if (raw.type === "text" && typeof raw.text === "string") {
        blocks.push({ type: "text", text: raw.text });
      } else if (raw.type === "thinking" && typeof raw.thinking === "string") {
        blocks.push({ type: "thinking", thinking: raw.thinking });
      } else if (raw.type === "toolCall") {
        const callId = stringValue(raw.id);
        const name = stringValue(raw.name);
        if (callId && name) {
          blocks.push({
            type: "tool_use",
            id: callId,
            name: canonicalizePiToolName(name),
            input: normalizePiToolInput(name, raw.arguments),
          });
        }
      }
    }
    return {
      type: "assistant",
      uuid: id,
      session_id: sessionId,
      timestamp: toIsoTimestamp(message.timestamp),
      message: {
        role: "assistant",
        content: blocks,
        ...(typeof message.model === "string" ? { model: message.model } : {}),
      },
      usage: message.usage,
      stopReason: message.stopReason,
    };
  }

  private toolResultSdkMessage(
    message: JsonRecord,
    sessionId: string,
  ): SDKMessage {
    const toolCallId = stringValue(message.toolCallId) ?? "pi-tool";
    const content = Array.isArray(message.content) ? message.content : [];
    const output = content
      .flatMap((block): string[] => {
        if (!isRecord(block)) return [];
        if (block.type === "text" && typeof block.text === "string") {
          return [block.text];
        }
        if (block.type === "image") return ["[Image]"];
        return [];
      })
      .join("\n");
    return {
      type: "user",
      uuid: `pi-tool-result-${toolCallId}-${Date.now()}`,
      session_id: sessionId,
      tool_use_id: toolCallId,
      timestamp: toIsoTimestamp(message.timestamp),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: output,
          },
        ],
      },
      is_error: message.isError === true,
    };
  }

  private async handleExtensionUiRequest(
    event: JsonRecord,
    options: StartSessionOptions,
    client: PiRpcClient,
    signal: AbortSignal,
  ): Promise<void> {
    const id = stringValue(event.id);
    const method = stringValue(event.method);
    if (!id) return;

    // notify/status/widget/title methods are explicitly fire-and-forget in Pi.
    if (
      method === "notify" ||
      method === "setStatus" ||
      method === "setWidget" ||
      method === "setTitle" ||
      method === "set_editor_text"
    ) {
      return;
    }

    let approved = false;
    const title = stringValue(event.title) ?? "";
    if (
      method === "confirm" &&
      title.startsWith(PI_APPROVAL_TITLE_PREFIX) &&
      options.onToolApproval
    ) {
      let payload: JsonRecord = {};
      try {
        const parsed = JSON.parse(String(event.message ?? "{}")) as unknown;
        if (isRecord(parsed)) payload = parsed;
      } catch {
        // Fail closed below with an empty, denied approval payload.
      }
      const nativeName =
        stringValue(payload.toolName) ||
        title.slice(PI_APPROVAL_TITLE_PREFIX.length) ||
        "PiTool";
      try {
        const result = await options.onToolApproval(
          canonicalizePiToolName(nativeName),
          normalizePiToolInput(nativeName, payload.input),
          {
            signal,
            requestId: id,
            requestMethod: "pi/tool_call",
            // Pi has no native permission policy. Yep must apply the current
            // default/accept-edits/plan/bypass mode itself.
            respectProviderDecision: false,
          },
        );
        approved = result.behavior === "allow";
      } catch (error) {
        getLogger().warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Pi tool approval callback failed; denying tool",
        );
      }
    }

    client.sendExtensionResponse(
      method === "confirm"
        ? { type: "extension_ui_response", id, confirmed: approved }
        : { type: "extension_ui_response", id, cancelled: true },
    );
  }

  private imagesFromQueuedMessage(
    message: QueuedUserMessage,
  ): Array<{ type: "image"; data: string; mimeType: string }> {
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) =>
      block.type === "image" && block.source.type === "base64"
        ? [
            {
              type: "image" as const,
              data: block.source.data,
              mimeType: block.source.media_type || "image/png",
            },
          ]
        : [],
    );
  }

  private imagesFromUserMessage(
    message: UserMessage,
  ): Array<{ type: "image"; data: string; mimeType: string }> {
    return (message.images ?? []).map((image) => {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(image);
      return {
        type: "image" as const,
        data: match?.[2] ?? image,
        mimeType: match?.[1] ?? "image/png",
      };
    });
  }

  private async findPiPath(): Promise<string | null> {
    if (this.configuredPath && existsSync(this.configuredPath)) {
      return this.configuredPath;
    }
    for (const path of [
      process.env.YEP_PI_PATH,
      "/opt/homebrew/bin/pi",
      "/usr/local/bin/pi",
      join(homedir(), ".local", "bin", "pi"),
      join(homedir(), "bin", "pi"),
    ]) {
      if (path && existsSync(path)) return path;
    }
    try {
      const { stdout } = await execAsync(whichCommand("pi"), {
        encoding: "utf8",
      });
      const path = stdout.split("\n")[0]?.trim();
      return path && existsSync(path) ? path : null;
    } catch {
      return null;
    }
  }
}

export const piProvider = new PiProvider();

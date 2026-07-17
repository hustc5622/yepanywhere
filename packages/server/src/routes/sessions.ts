import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ALL_CODEX_MCP_MODES,
  type CodexMcpMode,
  type ContextCompactEvent,
  type ContextCumulativeUsage,
  type ContextStatusResponse,
  type ContextUsage,
  type OpenCodeJsonObject,
  type OpenCodeModelCapabilities,
  type OpenCodeModelLimits,
  type OpenCodeRequestProtocol,
  type OpenCodeSessionConfig,
  type PermissionRules,
  type ProviderName,
  type ThinkingOption,
  type UploadedFile,
  type UrlProjectId,
  type UserQuestionAnswers,
  escalateContextWindow,
  getModelContextWindow,
  isUrlProjectId,
  thinkingOptionToConfig,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  ArchiveError,
  type ArchivedSessionRecord,
  type SessionArchiveService,
} from "../archive/index.js";
import { augmentTextBlocks } from "../augments/markdown-augments.js";
import {
  type BridgeControllers,
  getAnyBridgePendingInputRequest,
  getAnyBridgeSessionView,
  isAnyBridgeSessionActive,
  respondToAnyBridgeInput,
} from "../bridge-common/multi.js";
import { isLiveBridgeSessionView } from "../bridge-common/session-state.js";
import type { BridgeInputResponse } from "../bridge-common/types.js";
import type { CodexBridgeController } from "../codex-bridge/types.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { OpenCodeBridgeController } from "../opencode-bridge/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { OpenCodeSessionScanner } from "../projects/opencode-scanner.js";
import {
  encodeProjectId,
  resolveResumeCwd,
  resolveStartCwd,
} from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RecentsService } from "../recents/index.js";
import { EmbeddedRuntimeController } from "../runtime/EmbeddedRuntimeController.js";
import type {
  RuntimeController,
  RuntimeStartResponse,
} from "../runtime/types.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { computeCodexRollbackNumTurns } from "../sessions/codex-rollback.js";
import { cloneClaudeSession, cloneCodexSession } from "../sessions/fork.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { normalizeSession } from "../sessions/normalization.js";
import { OpenCodeSessionReader } from "../sessions/opencode-reader.js";
import {
  type PaginationInfo,
  sliceAfterMessage,
  sliceAroundMessage,
  sliceAtCompactBoundaries,
} from "../sessions/pagination.js";
import { augmentPersistedSessionMessages } from "../sessions/persisted-augments.js";
import { getPersistedAskUserQuestionInputRequest } from "../sessions/persisted-pending-input.js";
import { normalizeProviderGroup } from "../sessions/provider-groups.js";
import {
  type ProviderResolutionDeps,
  findSessionSummaryAcrossProviders,
  resolveSessionSources,
} from "../sessions/provider-resolution.js";
import {
  deriveSessionRuntime,
  pendingInputTypeFromProcess,
} from "../sessions/session-runtime.js";
import type { ISessionReader } from "../sessions/types.js";
import { isUserPromptMessage } from "../sessions/user-prompt-message.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type {
  QueueFullResponse,
  Supervisor,
} from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import type {
  ContentBlock,
  Message,
  Project,
  SessionSummary,
} from "../supervisor/types.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";
import type { EventBus } from "../watcher/index.js";
import { resolveSessionModel } from "./session-model.js";

/**
 * Type guard to check if a result is a QueuedResponse
 */
function isQueuedResponse(
  result: RuntimeStartResponse,
): result is QueuedResponse {
  return "queued" in result && result.queued === true;
}

/**
 * Type guard to check if a result is a QueueFullResponse
 */
function isQueueFullResponse(
  result: RuntimeStartResponse,
): result is QueueFullResponse {
  return "error" in result && result.error === "queue_full";
}

function parseOptionalExecutor(rawExecutor: unknown): {
  executor: string | undefined;
  error?: string;
} {
  if (rawExecutor === undefined || rawExecutor === null) {
    return { executor: undefined };
  }
  if (typeof rawExecutor !== "string") {
    return { executor: undefined, error: "executor must be a string" };
  }

  const executor = normalizeSshHostAlias(rawExecutor);
  if (!executor) {
    return { executor: undefined };
  }
  if (!isValidSshHostAlias(executor)) {
    return {
      executor: undefined,
      error: "executor must be a valid SSH host alias",
    };
  }

  return { executor };
}

function parseOptionalCodexMcpMode(rawMode: unknown): {
  codexMcpMode: CodexMcpMode | undefined;
  error?: string;
} {
  if (rawMode === undefined || rawMode === null || rawMode === "") {
    return { codexMcpMode: undefined };
  }
  if (
    typeof rawMode === "string" &&
    ALL_CODEX_MCP_MODES.includes(rawMode as CodexMcpMode)
  ) {
    return { codexMcpMode: rawMode as CodexMcpMode };
  }
  return { codexMcpMode: undefined, error: "codexMcpMode is invalid" };
}

function isCodexProviderName(
  provider: ProviderName | string | undefined,
): provider is "codex" | "codex-oss" {
  return provider === "codex" || provider === "codex-oss";
}

function supportsResumeSessionAt(
  provider: ProviderName | string | undefined,
): boolean {
  return provider === "claude" || provider === "opencode";
}

function parseOptionalPositiveInteger(
  value: unknown,
  fieldName: string,
): { value: number | undefined; error?: string } {
  if (value === undefined || value === null) {
    return { value: undefined };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { value: undefined, error: `${fieldName} must be a number` };
  }

  if (!Number.isInteger(value) || value < 1) {
    return {
      value: undefined,
      error: `${fieldName} must be a positive integer`,
    };
  }

  return { value };
}

function parseOpenCodeModelLimits(rawLimits: unknown): {
  limits: OpenCodeModelLimits | undefined;
  error?: string;
} {
  if (rawLimits === undefined || rawLimits === null || rawLimits === "") {
    return { limits: undefined };
  }
  if (!isPlainObject(rawLimits)) {
    return {
      limits: undefined,
      error: "opencodeConfig.limits must be an object",
    };
  }

  const input = rawLimits;
  const hasContext = input.context !== undefined && input.context !== null;
  const hasOutput = input.output !== undefined && input.output !== null;
  if (!hasContext && !hasOutput) {
    return { limits: undefined };
  }
  if (!hasContext || !hasOutput) {
    return {
      limits: undefined,
      error: "opencodeConfig.limits requires both context and output",
    };
  }

  const context = parseOptionalPositiveInteger(
    input.context,
    "opencodeConfig.limits.context",
  );
  if (context.error) {
    return { limits: undefined, error: context.error };
  }
  const output = parseOptionalPositiveInteger(
    input.output,
    "opencodeConfig.limits.output",
  );
  if (output.error) {
    return { limits: undefined, error: output.error };
  }
  if (context.value === undefined || output.value === undefined) {
    return {
      limits: undefined,
      error: "opencodeConfig.limits requires both context and output",
    };
  }

  const parsedInput = parseOptionalPositiveInteger(
    input.input,
    "opencodeConfig.limits.input",
  );
  if (parsedInput.error) return { limits: undefined, error: parsedInput.error };

  return {
    limits: {
      context: context.value,
      ...(parsedInput.value === undefined ? {} : { input: parsedInput.value }),
      output: output.value,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateOpenCodeJson(
  value: unknown,
  fieldName: string,
  depth = 0,
): string | undefined {
  if (depth > 12) return `${fieldName} is nested too deeply`;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `${fieldName} must be JSON`;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateOpenCodeJson(
        value[index],
        `${fieldName}[${index}]`,
        depth + 1,
      );
      if (error) return error;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return `${fieldName} must be JSON`;

  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      return `${fieldName} contains a reserved key`;
    }
    const error = validateOpenCodeJson(item, `${fieldName}.${key}`, depth + 1);
    if (error) return error;
  }
  return undefined;
}

function parseOpenCodeAdvancedObject(
  value: unknown,
  fieldName: string,
): { value?: OpenCodeJsonObject; error?: string } {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return { error: `${fieldName} must be an object` };
  const error = validateOpenCodeJson(value, fieldName);
  if (error) return { error };
  if (JSON.stringify(value).length > 65_536) {
    return { error: `${fieldName} is too large` };
  }
  return { value: value as OpenCodeJsonObject };
}

export function parseOptionalOpenCodeConfig(raw: unknown): {
  opencodeConfig: OpenCodeSessionConfig | undefined;
  error?: string;
} {
  if (raw === undefined || raw === null || raw === "") {
    return { opencodeConfig: undefined };
  }
  if (!isPlainObject(raw)) {
    return {
      opencodeConfig: undefined,
      error: "opencodeConfig must be an object",
    };
  }

  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (
    !model ||
    model.length > 512 ||
    model === "__proto__" ||
    model === "prototype" ||
    model === "constructor" ||
    Array.from(model).some((character) => character.charCodeAt(0) < 32)
  ) {
    return {
      opencodeConfig: undefined,
      error: "opencodeConfig.model must be a valid model ID",
    };
  }
  const requestProtocol = raw.requestProtocol;
  if (
    requestProtocol !== "openai-compatible" &&
    requestProtocol !== "anthropic"
  ) {
    return {
      opencodeConfig: undefined,
      error: "opencodeConfig.requestProtocol is invalid",
    };
  }

  const parsedLimits = parseOpenCodeModelLimits(raw.limits);
  if (parsedLimits.error) {
    return { opencodeConfig: undefined, error: parsedLimits.error };
  }

  let capabilities: OpenCodeModelCapabilities | undefined;
  if (raw.capabilities !== undefined && raw.capabilities !== null) {
    if (!isPlainObject(raw.capabilities)) {
      return {
        opencodeConfig: undefined,
        error: "opencodeConfig.capabilities must be an object",
      };
    }
    capabilities = {};
    for (const key of [
      "attachment",
      "reasoning",
      "temperature",
      "toolCall",
    ] as const) {
      const value = raw.capabilities[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") {
        return {
          opencodeConfig: undefined,
          error: `opencodeConfig.capabilities.${key} must be a boolean`,
        };
      }
      capabilities[key] = value;
    }
  }

  let advanced: OpenCodeSessionConfig["advanced"];
  if (raw.advanced !== undefined && raw.advanced !== null) {
    if (!isPlainObject(raw.advanced)) {
      return {
        opencodeConfig: undefined,
        error: "opencodeConfig.advanced must be an object",
      };
    }
    const provider = parseOpenCodeAdvancedObject(
      raw.advanced.provider,
      "opencodeConfig.advanced.provider",
    );
    if (provider.error) {
      return { opencodeConfig: undefined, error: provider.error };
    }
    const modelPatch = parseOpenCodeAdvancedObject(
      raw.advanced.model,
      "opencodeConfig.advanced.model",
    );
    if (modelPatch.error) {
      return { opencodeConfig: undefined, error: modelPatch.error };
    }
    if (provider.value || modelPatch.value) {
      advanced = { provider: provider.value, model: modelPatch.value };
    }
  }

  let name: string | undefined;
  if (raw.name !== undefined && raw.name !== null && raw.name !== "") {
    if (typeof raw.name !== "string" || raw.name.trim().length > 200) {
      return {
        opencodeConfig: undefined,
        error: "opencodeConfig.name must be a string up to 200 characters",
      };
    }
    name = raw.name.trim();
  }

  return {
    opencodeConfig: {
      model,
      requestProtocol: requestProtocol as OpenCodeRequestProtocol,
      ...(name ? { name } : {}),
      ...(parsedLimits.limits ? { limits: parsedLimits.limits } : {}),
      ...(capabilities && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {}),
      ...(advanced ? { advanced } : {}),
    },
  };
}

export function parseOptionalReasoningEffort(rawEffort: unknown): {
  reasoningEffort?: string;
  error?: string;
} {
  if (rawEffort === undefined || rawEffort === null || rawEffort === "") {
    return {};
  }
  if (typeof rawEffort !== "string") {
    return { error: "reasoningEffort must be a string" };
  }

  const reasoningEffort = rawEffort.trim();
  if (
    reasoningEffort.length === 0 ||
    reasoningEffort.length > 64 ||
    Array.from(reasoningEffort).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return { error: "Invalid reasoningEffort" };
  }

  return { reasoningEffort };
}

export function normalizeReasoningEffortForProvider(
  provider: ProviderName | undefined,
  reasoningEffort: string | undefined,
): string | undefined {
  return provider === "opencode" && reasoningEffort === "default"
    ? undefined
    : reasoningEffort;
}

export interface SessionsDeps {
  runtimeController?: RuntimeController;
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  eventBus?: EventBus;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  opencodeScanner?: OpenCodeSessionScanner;
  opencodeDbPath?: string;
  /** Optional shared OpenCode reader factory for cross-provider session lookups */
  opencodeReaderFactory?: (projectPath: string) => OpenCodeSessionReader;
  /** ServerSettingsService for reading global instructions */
  serverSettingsService?: ServerSettingsService;
  /** ModelInfoService for context window lookups */
  modelInfoService?: ModelInfoService;
  /** RecentsService for repairing stale projectId entries on resume */
  recentsService?: RecentsService;
  /** Codex bridge for externally launched `codex --remote` TUI sessions. */
  codexBridgeService?: CodexBridgeController;
  /** OpenCode bridge for OpenCode CLI sessions. */
  opencodeBridgeService?: OpenCodeBridgeController;
  /** Physical cold-archive service for moving old provider JSONL files away from hot scan paths. */
  sessionArchiveService?: SessionArchiveService;
  /** Claude projects directory, used to synthesize file-change invalidation events after moves. */
  claudeProjectsDir?: string;
}

type BridgeSessionView = Awaited<
  ReturnType<CodexBridgeController["getSessionView"]>
>;

function bridgeControllers(
  deps: Pick<SessionsDeps, "codexBridgeService" | "opencodeBridgeService">,
): BridgeControllers {
  return [deps.codexBridgeService, deps.opencodeBridgeService];
}

async function getBridgeSessionView(
  deps: Pick<SessionsDeps, "codexBridgeService" | "opencodeBridgeService">,
  sessionId: string,
): Promise<NonNullable<BridgeSessionView> | null> {
  return getAnyBridgeSessionView(bridgeControllers(deps), sessionId);
}

async function isBridgeSessionActive(
  deps: Pick<SessionsDeps, "codexBridgeService" | "opencodeBridgeService">,
  sessionId: string,
): Promise<boolean> {
  return isAnyBridgeSessionActive(bridgeControllers(deps), sessionId);
}

async function getBridgePendingInputRequest(
  deps: Pick<SessionsDeps, "codexBridgeService" | "opencodeBridgeService">,
  sessionId: string,
) {
  return getAnyBridgePendingInputRequest(bridgeControllers(deps), sessionId);
}

async function respondToBridgeInput(
  deps: Pick<SessionsDeps, "codexBridgeService" | "opencodeBridgeService">,
  sessionId: string,
  requestId: string,
  response: BridgeInputResponse,
  answers?: UserQuestionAnswers,
): Promise<boolean> {
  return respondToAnyBridgeInput(
    bridgeControllers(deps),
    sessionId,
    requestId,
    response,
    answers,
  );
}

function isLiveAnyBridgeSessionView(
  view: NonNullable<BridgeSessionView>,
): boolean {
  return isLiveBridgeSessionView(view);
}

interface StartSessionBody {
  message: string;
  images?: string[];
  documents?: string[];
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  model?: string;
  thinking?: ThinkingOption;
  /** Exact provider reasoning effort / OpenCode model variant. */
  reasoningEffort?: string;
  provider?: ProviderName;
  /** Codex MCP profile. Only used when provider resolves to Codex. */
  codexMcpMode?: CodexMcpMode;
  /** OpenCode-only managed provider/model configuration. */
  opencodeConfig?: OpenCodeSessionConfig;
  /** Client-generated temp ID for optimistic UI tracking */
  tempId?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /**
   * Provider-native edit boundary. Claude receives the edited prompt's
   * parentUuid and rewinds in-place; OpenCode receives the edited persisted
   * user message's own native ID and forks before that message.
   */
  resumeSessionAt?: string;
  /**
   * Rewind/edit for Codex app-server: drop this many trailing user turns via
   * `thread/rollback` before sending the edited prompt in the same session.
   * Used as a fallback when `rollbackTarget` cannot be resolved server-side.
   */
  rollbackNumTurns?: number;
  /**
   * Identity of the edited user turn for Codex rewind. When present the
   * server recomputes the authoritative rollback count from the persisted
   * turn tree instead of trusting the client-rendered prompt count.
   */
  rollbackTarget?: {
    /** Entry timestamp of the edited user turn, when known. */
    timestamp?: string;
    /** Original prompt text of the edited user turn. */
    text?: string;
  };
}

interface CreateSessionBody {
  mode?: PermissionMode;
  model?: string;
  thinking?: ThinkingOption;
  /** Exact provider reasoning effort / OpenCode model variant. */
  reasoningEffort?: string;
  provider?: ProviderName;
  /** Codex MCP profile. Only used when provider resolves to Codex. */
  codexMcpMode?: CodexMcpMode;
  /** OpenCode-only managed provider/model configuration. */
  opencodeConfig?: OpenCodeSessionConfig;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
}

interface InputResponseBody {
  requestId: string;
  response: "approve" | "approve_accept_edits" | "deny" | string;
  answers?: UserQuestionAnswers;
  feedback?: string;
}

/**
 * Convert SDK messages to client Message format.
 * Used for mock SDK sessions where messages aren't persisted to disk.
 */
function sdkMessagesToClientMessages(
  sdkMessages: SDKMessage[],
  options: { model?: string; provider?: ProviderName } = {},
): Message[] {
  const messages: Message[] = [];
  let pendingUserMessage: Message | null = null;

  for (const msg of sdkMessages) {
    // Only include user and assistant messages with content
    if (
      (msg.type === "user" || msg.type === "assistant") &&
      msg.message?.content
    ) {
      const rawContent = msg.message.content;
      // Both user and assistant messages can have string or array content.
      // User messages with tool_result blocks have array content that must be preserved.
      // Assistant messages need ContentBlock[] format for preprocessMessages to render.
      let content: string | ContentBlock[];
      if (typeof rawContent === "string") {
        // String content: keep as-is for user messages, wrap in text block for assistant
        content =
          msg.type === "user"
            ? rawContent
            : [{ type: "text" as const, text: rawContent }];
      } else if (Array.isArray(rawContent)) {
        // Array content: pass through as ContentBlock[] for both user and assistant
        content = rawContent as ContentBlock[];
      } else {
        // Unknown content type - skip this message
        continue;
      }

      messages.push({
        id: msg.uuid ?? `msg-${Date.now()}-${messages.length}`,
        type: msg.type,
        role: msg.type as "user" | "assistant",
        content,
        timestamp:
          typeof msg.timestamp === "string" && msg.timestamp.trim().length > 0
            ? msg.timestamp
            : new Date().toISOString(),
      });

      const latest = messages[messages.length - 1];
      if (latest && isUserPromptMessage(latest)) {
        pendingUserMessage = latest;
      }
      continue;
    }

    const contextUsage = extractCodexTurnCompleteContextUsage(msg, options);
    if (contextUsage && pendingUserMessage) {
      pendingUserMessage.contextBefore = contextUsage;
      pendingUserMessage = null;
    }
  }
  return messages;
}

function extractCodexTurnCompleteContextUsage(
  msg: SDKMessage,
  options: { model?: string; provider?: ProviderName },
): ContextUsage | undefined {
  if (
    (options.provider !== "codex" && options.provider !== "codex-oss") ||
    msg.type !== "system" ||
    msg.subtype !== "turn_complete"
  ) {
    return undefined;
  }

  const usage = msg.usage as
    | {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cached_input_tokens?: unknown;
        model_context_window?: unknown;
      }
    | undefined;
  if (typeof usage?.input_tokens !== "number" || usage.input_tokens <= 0) {
    return undefined;
  }

  const contextWindow =
    typeof usage.model_context_window === "number" &&
    usage.model_context_window > 0
      ? usage.model_context_window
      : getModelContextWindow(options.model, options.provider);
  const result: ContextUsage = {
    inputTokens: usage.input_tokens,
    percentage: Math.min(
      100,
      Math.round((usage.input_tokens / contextWindow) * 100),
    ),
    contextWindow,
  };

  if (typeof usage.output_tokens === "number" && usage.output_tokens > 0) {
    result.outputTokens = usage.output_tokens;
  }
  if (
    typeof usage.cached_input_tokens === "number" &&
    usage.cached_input_tokens > 0
  ) {
    result.cacheReadTokens = usage.cached_input_tokens;
  }

  return result;
}

/**
 * Compute compaction overhead from SDK messages.
 * Same logic as computeCompactionOverhead in reader.ts but for SDKMessage type.
 */
function computeSDKCompactionOverhead(sdkMessages: SDKMessage[]): number {
  // Find the last compact_boundary with compactMetadata
  let lastCompactIdx = -1;
  let preTokens = 0;

  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg?.type === "system" && msg.subtype === "compact_boundary") {
      const metadata = (msg as { compactMetadata?: { preTokens?: number } })
        .compactMetadata;
      if (metadata?.preTokens) {
        lastCompactIdx = i;
        preTokens = metadata.preTokens;
        break;
      }
    }
  }

  if (lastCompactIdx === -1) return 0;

  // Find last assistant message before compaction with non-zero usage
  for (let i = lastCompactIdx - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg?.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      const total =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (total > 0) {
        const overhead = preTokens - total;
        return overhead > 0 ? overhead : 0;
      }
    }
  }

  return 0;
}

/**
 * Extract context usage from SDK messages.
 * Finds the last assistant message with usage data.
 *
 * @param sdkMessages - SDK messages to search
 * @param model - Model ID for determining context window size
 * @param provider - Provider for model-less context-window fallback
 */
function extractContextUsageFromSDKMessages(
  sdkMessages: SDKMessage[],
  model: string | undefined,
  provider?: ProviderName,
  resolveContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number,
): ContextUsage | undefined {
  const contextWindowSize = resolveContextWindow
    ? resolveContextWindow(model, provider)
    : getModelContextWindow(model, provider);

  const isCodexProvider = provider === "codex" || provider === "codex-oss";

  // Compute compaction overhead for Claude sessions
  const overhead = isCodexProvider
    ? 0
    : computeSDKCompactionOverhead(sdkMessages);

  // Find the last assistant message with usage data (iterate backwards)
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg && msg.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      // Codex context meter is based on fresh input tokens from the latest turn.
      // Claude/OpenCode/Gemini paths continue to include cached+creation tokens.
      const rawInputTokens = isCodexProvider
        ? (usage.input_tokens ?? 0)
        : (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);

      // Skip messages with zero input tokens (incomplete streaming messages)
      if (rawInputTokens === 0) {
        continue;
      }

      // Apply compaction overhead correction
      const inputTokens = rawInputTokens + overhead;

      const percentage = Math.round((inputTokens / contextWindowSize) * 100);

      const result: ContextUsage = {
        inputTokens,
        percentage,
        contextWindow: contextWindowSize,
      };

      // Add optional fields if available
      if (usage.output_tokens !== undefined && usage.output_tokens > 0) {
        result.outputTokens = usage.output_tokens;
      }
      if (isCodexProvider) {
        if (
          usage.cached_input_tokens !== undefined &&
          usage.cached_input_tokens > 0
        ) {
          result.cacheReadTokens = usage.cached_input_tokens;
        }
      } else if (
        usage.cache_read_input_tokens !== undefined &&
        usage.cache_read_input_tokens > 0
      ) {
        result.cacheReadTokens = usage.cache_read_input_tokens;
      }
      if (
        usage.cache_creation_input_tokens !== undefined &&
        usage.cache_creation_input_tokens > 0
      ) {
        result.cacheCreationTokens = usage.cache_creation_input_tokens;
      }

      return result;
    }
  }
  return undefined;
}

interface ArchiveTarget {
  project: Project;
  summary: SessionSummary | null;
  provider: ProviderName | string | undefined;
  sessionFilePath: string;
}

function toProviderResolutionDeps(deps: SessionsDeps): ProviderResolutionDeps {
  return {
    readerFactory: deps.readerFactory,
    codexSessionsDir: deps.codexSessionsDir,
    codexReaderFactory: deps.codexReaderFactory,
    geminiSessionsDir: deps.geminiSessionsDir,
    geminiReaderFactory: deps.geminiReaderFactory,
    geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
    opencodeDbPath: deps.opencodeDbPath,
    opencodeReaderFactory: deps.opencodeReaderFactory,
  };
}

async function resolveArchiveTarget(
  deps: SessionsDeps,
  sessionId: string,
): Promise<ArchiveTarget | null> {
  const projects = await deps.scanner.listProjects();
  const preferredProvider = deps.sessionMetadataService?.getProvider(sessionId);

  for (const project of projects) {
    const resolved = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      project.id,
      toProviderResolutionDeps(deps),
      preferredProvider,
    );
    if (!resolved) continue;

    const sessionFilePath = await findArchiveSessionFilePath(
      project,
      resolved.source.reader,
      resolved.source.sessionDir,
      sessionId,
    );
    if (!sessionFilePath) continue;

    return {
      project,
      summary: resolved.summary,
      provider: resolved.summary.provider ?? resolved.source.provider,
      sessionFilePath,
    };
  }

  return null;
}

async function findArchiveSessionFilePath(
  project: Project,
  reader: ISessionReader,
  sourceSessionDir: string,
  sessionId: string,
): Promise<string | null> {
  const direct = await reader.getSessionFilePath?.(sessionId);
  if (direct) return direct;

  const dirs = [
    sourceSessionDir,
    project.sessionDir,
    ...(project.mergedSessionDirs ?? []),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, `${sessionId}.jsonl`);
    try {
      const stats = await stat(candidate);
      if (stats.isFile()) return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function archiveHttpStatus(error: ArchiveError): 400 | 404 | 409 | 500 {
  switch (error.code) {
    case "unsupported_provider":
      return 400;
    case "session_not_found":
    case "not_archived":
      return 404;
    case "already_archived":
    case "restore_conflict":
      return 409;
    case "archive_failed":
    case "restore_failed":
      return 500;
  }
}

function emitArchiveFileEvents(
  deps: SessionsDeps,
  record: ArchivedSessionRecord,
  changeType: "create" | "delete",
): void {
  if (!deps.eventBus) return;

  const providerRoot =
    record.provider === "codex"
      ? deps.codexSessionsDir
      : deps.claudeProjectsDir;
  if (!providerRoot) return;

  for (const file of record.files) {
    if (file.kind !== "session") continue;
    deps.eventBus.emit({
      type: "file-change",
      provider: record.provider,
      path: file.originalPath,
      relativePath: relative(providerRoot, file.originalPath),
      changeType,
      timestamp: new Date().toISOString(),
      fileType: "session",
    });
  }
}

async function markSessionCreatedByYep(
  deps: SessionsDeps,
  sessionId: string,
  projectId: string,
): Promise<void> {
  if (!deps.sessionMetadataService) return;

  await deps.sessionMetadataService.setCreatedBy(sessionId, "yep");
  deps.eventBus?.emit({
    type: "session-metadata-changed",
    sessionId,
    projectId: projectId as UrlProjectId,
    timestamp: new Date().toISOString(),
  });
}

function recordOpenCodeContextWindowOverride(
  deps: SessionsDeps,
  input: {
    provider?: ProviderName;
    model?: string;
    sessionId?: string;
    limits?: OpenCodeModelLimits;
  },
): void {
  if (
    input.provider !== "opencode" ||
    !input.limits ||
    input.limits.context <= 0
  ) {
    return;
  }

  if (input.model) {
    deps.modelInfoService?.recordContextWindow(
      input.model,
      input.limits.context,
      "opencode",
    );
  }
  if (input.sessionId) {
    deps.modelInfoService?.recordSessionContextWindow(
      input.sessionId,
      input.limits.context,
      "opencode",
    );
  }
}

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const routes = new Hono();
  const runtimeController =
    deps.runtimeController ?? new EmbeddedRuntimeController(deps.supervisor);
  const getCodexReader = (projectPath: string): CodexSessionReader | null =>
    deps.codexReaderFactory?.(projectPath) ??
    (deps.codexSessionsDir
      ? new CodexSessionReader({
          sessionsDir: deps.codexSessionsDir,
          projectPath,
        })
      : null);
  const getOpenCodeReader = (projectPath: string): OpenCodeSessionReader => {
    const mis = deps.modelInfoService;
    return (
      deps.opencodeReaderFactory?.(projectPath) ??
      new OpenCodeSessionReader({
        dbPath: deps.opencodeDbPath,
        projectPath,
        getContextWindow: mis
          ? (model, provider, sessionId) =>
              mis.getCachedContextWindow(model, provider, sessionId)
          : undefined,
      })
    );
  };

  // GET /api/archive/sessions - List physically archived sessions.
  routes.get("/archive/sessions", (c) => {
    if (!deps.sessionArchiveService) {
      return c.json({ error: "Session archive service not available" }, 503);
    }
    return c.json({
      archiveDir: deps.sessionArchiveService.getArchiveDir(),
      sessions: deps.sessionArchiveService.listArchivedSessions(),
    });
  });

  // GET /api/archive/sessions/:sessionId - Get one archived session manifest record.
  routes.get("/archive/sessions/:sessionId", (c) => {
    if (!deps.sessionArchiveService) {
      return c.json({ error: "Session archive service not available" }, 503);
    }
    const record = deps.sessionArchiveService.getArchivedSession(
      c.req.param("sessionId"),
    );
    if (!record) {
      return c.json({ error: "Archived session not found" }, 404);
    }
    return c.json({ session: record });
  });

  // GET /api/projects/:projectId/sessions/:sessionId/agents - Get agent mappings
  // Used to find agent sessions for pending Tasks on page reload
  routes.get("/projects/:projectId/sessions/:sessionId/agents", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const reader = deps.readerFactory(project);
    const mappings = await reader.getAgentMappings();

    return c.json({ mappings });
  });

  // GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId - Get agent session content
  // Used for lazy-loading completed Tasks
  routes.get(
    "/projects/:projectId/sessions/:sessionId/agents/:agentId",
    async (c) => {
      const projectId = c.req.param("projectId");
      const agentId = c.req.param("agentId");

      // Validate projectId format at API boundary
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json({ error: "Project not found" }, 404);
      }

      const reader = deps.readerFactory(project);
      const agentSession = await reader.getAgentSession(agentId);

      if (!agentSession) {
        return c.json({ error: "Agent session not found" }, 404);
      }

      // Add server-rendered HTML to text blocks for markdown display
      await augmentTextBlocks(agentSession.messages);

      return c.json(agentSession);
    },
  );

  // GET /api/projects/:projectId/sessions/:sessionId/metadata - Get session metadata only (no messages)
  // Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages
  routes.get("/projects/:projectId/sessions/:sessionId/metadata", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check if session is actively owned by a process
    const process =
      await runtimeController.getProcessSnapshotForSession(sessionId);
    const bridgeView = await getBridgeSessionView(deps, sessionId);
    const bridgedSession =
      bridgeView?.session.projectId === projectId ? bridgeView : null;
    const bridgeSessionActive = bridgedSession
      ? await isBridgeSessionActive(deps, sessionId)
      : false;
    const isBridgeSessionLive =
      bridgedSession !== null && isLiveAnyBridgeSessionView(bridgedSession);

    // Check if session is being controlled by an external program
    const isExternal =
      (deps.externalTracker?.isExternal(sessionId) ?? false) ||
      (isBridgeSessionLive && bridgeSessionActive);

    const runtime = deriveSessionRuntime({
      process,
      externalActive: isExternal,
      externalActivity: bridgedSession?.activity,
    });
    const ownership = runtime.ownership;

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;

    // Get pending input request from active process
    const activePendingInputRequest =
      process?.pendingInputRequest ??
      (await getBridgePendingInputRequest(deps, sessionId));
    const pendingInputType =
      pendingInputTypeFromProcess(process) ??
      bridgedSession?.pendingInputType ??
      (activePendingInputRequest
        ? activePendingInputRequest.type === "tool-approval"
          ? "tool-approval"
          : "user-question"
        : undefined);

    // Get available slash commands from active process
    const slashCommands = process?.supportsDynamicCommands
      ? await runtimeController.getSupportedCommands(process.id)
      : null;

    // Read minimal session info from disk (just for title/timestamps, no messages)
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const sessionSummaryResult = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      projectId as UrlProjectId,
      toProviderResolutionDeps(deps),
      metadataProvider ?? process?.provider,
    );
    const sessionSummary =
      sessionSummaryResult?.summary ?? bridgedSession?.session ?? null;

    if (!sessionSummary && !process) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Calculate hasUnread if we have session summary
    const hasUnread =
      deps.notificationService && sessionSummary
        ? deps.notificationService.hasUnread(
            sessionId,
            sessionSummary.updatedAt,
          )
        : undefined;

    return c.json({
      session: {
        id: sessionId,
        projectId,
        title: sessionSummary?.title ?? null,
        fullTitle: sessionSummary?.fullTitle ?? null,
        createdAt: sessionSummary?.createdAt ?? new Date().toISOString(),
        updatedAt: sessionSummary?.updatedAt ?? new Date().toISOString(),
        messageCount: sessionSummary?.messageCount ?? 0,
        userQuestions: sessionSummary?.userQuestions,
        ownership,
        provider:
          sessionSummary?.provider ??
          metadataProvider ??
          process?.provider ??
          project.provider,
        model: sessionSummary?.model,
        reasoningEffort:
          sessionSummary?.reasoningEffort ?? process?.reasoningEffort,
        serviceTier: sessionSummary?.serviceTier ?? process?.serviceTier,
        originator: sessionSummary?.originator,
        createdBy: metadata?.createdBy ?? sessionSummary?.createdBy,
        cliVersion: sessionSummary?.cliVersion,
        source: sessionSummary?.source,
        approvalPolicy: sessionSummary?.approvalPolicy,
        sandboxPolicy: sessionSummary?.sandboxPolicy,
        contextUsage: sessionSummary?.contextUsage,
        cumulativeUsage: sessionSummary?.cumulativeUsage,
        compactCount: sessionSummary?.compactCount,
        compactEvents: sessionSummary?.compactEvents,
        lastTurnStatus: bridgedSession
          ? bridgedSession.session.lastTurnStatus
          : sessionSummary?.lastTurnStatus,
        lastErrorMessage: bridgedSession
          ? bridgedSession.session.lastErrorMessage
          : sessionSummary?.lastErrorMessage,
        retryStatus: bridgedSession
          ? bridgedSession.session.retryStatus
          : sessionSummary?.retryStatus,
        customTitle: metadata?.customTitle,
        aiTitle: metadata?.aiTitle ?? sessionSummary?.aiTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        pendingInputType,
        activity: runtime.activity,
        runtime,
        lastSeenAt,
        hasUnread,
      },
      ownership,
      runtime,
      pendingInputRequest: activePendingInputRequest,
      slashCommands,
    });
  });

  // GET /api/projects/:projectId/sessions/:sessionId/context-status
  // Structured context-window breakdown. When a live SDK Process exists we
  // call the SDK's getContextUsage() for the full category/MCP/skills/memory
  // breakdown. Otherwise we fall back to the coarse estimate read from JSONL.
  routes.get(
    "/projects/:projectId/sessions/:sessionId/context-status",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");

      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json({ error: "Project not found" }, 404);
      }

      const process =
        await runtimeController.getProcessSnapshotForSession(sessionId);

      // Live path — SDK-backed breakdown.
      if (process) {
        // Opportunistically probe initializationResult() once per process so
        // ModelInfoService learns the real context window (and persists it),
        // even if the user never opens this modal again.
        if (deps.modelInfoService) {
          // Fire and forget; the runtime guarantees this probe only runs once
          // for each live process.
          void runtimeController
            .probeInitializationResult(sessionId)
            .then((init) => {
              if (!init || !init.models) return;
              for (const m of init.models) {
                if (m.contextWindow && m.contextWindow > 0) {
                  deps.modelInfoService?.recordContextWindow(
                    m.id,
                    m.contextWindow,
                    process.provider,
                  );
                }
              }
            })
            .catch(() => {
              // Already logged inside provider; nothing to do here.
            });
        }

        try {
          const usage = await runtimeController.getContextUsage(sessionId);
          // Validate shape: an empty {} from a not-yet-initialized SDK is
          // truthy but would crash the client when it iterates over
          // `categories`. Only accept fully-formed SDK payloads; otherwise
          // fall through to the JSONL estimate.
          if (usage && Array.isArray(usage.categories)) {
            // Persist the live max-tokens against the resolved model so the
            // fallback path stays accurate after this process exits.
            const modelForCache = process.model ?? usage.model;
            if (modelForCache && usage.rawMaxTokens > 0) {
              deps.modelInfoService?.recordContextWindow(
                modelForCache,
                usage.rawMaxTokens,
                process.provider,
              );
            }
            if (usage.rawMaxTokens > 0) {
              deps.modelInfoService?.recordSessionContextWindow(
                sessionId,
                usage.rawMaxTokens,
                process.provider,
              );
            }

            // The SDK breakdown describes the *current turn*'s context-window
            // fill — categories/MCP tools/skills/etc. It does not surface
            // session-level cumulative usage (input/output/cache totals
            // across every turn). Read those from the persisted JSONL so the
            // modal can show Claude Code's `/status`-style numbers even
            // while the agent is live.
            let cumulativeUsage: ContextCumulativeUsage | undefined;
            let compactEvents: ContextCompactEvent[] | undefined;
            try {
              const summaryResult = await findSessionSummaryAcrossProviders(
                project,
                sessionId,
                projectId as UrlProjectId,
                toProviderResolutionDeps(deps),
                process.provider,
              );
              cumulativeUsage = summaryResult?.summary?.cumulativeUsage;
              compactEvents = summaryResult?.summary?.compactEvents;
            } catch {
              // Cumulative is best-effort; never block the SDK breakdown.
            }

            const payload: ContextStatusResponse = {
              ...usage,
              cumulativeUsage,
              compactEvents,
            };
            return c.json(payload);
          }
        } catch {
          // fall through to estimate
        }
      }

      // Estimate path — derive from JSONL via the session reader.
      const metadataProvider = deps.sessionMetadataService?.getProvider(
        sessionId,
      ) as ProviderName | undefined;
      const sessionSummaryResult = await findSessionSummaryAcrossProviders(
        project,
        sessionId,
        projectId as UrlProjectId,
        toProviderResolutionDeps(deps),
        metadataProvider ?? process?.provider,
      );
      const sessionSummary = sessionSummaryResult?.summary ?? null;
      const providerName: ProviderName | undefined =
        sessionSummary?.provider ??
        metadataProvider ??
        process?.provider ??
        project.provider;
      const model = sessionSummary?.model;

      const summaryWindow = sessionSummary?.contextUsage?.contextWindow;
      const cachedWindow = deps.modelInfoService?.getCachedContextWindow(
        model,
        providerName,
        sessionId,
      );
      const baseContextWindow =
        summaryWindow ??
        cachedWindow ??
        deps.modelInfoService?.getContextWindow(
          model,
          providerName,
          sessionId,
        ) ??
        getModelContextWindow(model, providerName);

      // Re-derive percentage with the (possibly cached) contextWindow so the
      // estimate isn't pinned to the reader's heuristic. Also escalate
      // upward when usage exceeds the resolved window — covers 1M sessions
      // whose [1m] suffix was stripped before being written to JSONL.
      let contextUsage = sessionSummary?.contextUsage;
      const escalatedWindow =
        contextUsage && contextUsage.inputTokens > 0
          ? escalateContextWindow(
              baseContextWindow,
              contextUsage.inputTokens,
              providerName,
            )
          : baseContextWindow;

      if (contextUsage && escalatedWindow > 0) {
        contextUsage = {
          ...contextUsage,
          percentage: Math.round(
            (contextUsage.inputTokens / escalatedWindow) * 100,
          ),
          contextWindow: escalatedWindow,
        };
      }

      const payload: ContextStatusResponse = {
        source: "jsonl",
        model,
        contextWindow: escalatedWindow,
        contextWindowFromCache:
          summaryWindow !== undefined || cachedWindow !== undefined,
        contextUsage,
        cumulativeUsage: sessionSummary?.cumulativeUsage,
        compactEvents: sessionSummary?.compactEvents,
      };
      return c.json(payload);
    },
  );

  // GET /api/projects/:projectId/sessions/:sessionId - Get session detail
  // Optional query params:
  //   ?afterMessageId=<id> - incremental forward-fetch (append new messages)
  //   ?tailCompactions=<n> - return only last N compact boundaries worth of messages
  //   ?beforeMessageId=<id> - cursor for loading older chunks (used with tailCompactions)
  //   ?aroundMessageId=<id> - return a bounded window centered on a target message
  //   ?afterWindowMessageId=<id> - return the next bounded window after a cursor
  //   ?branchId=<id> - derived branch id to render
  routes.get("/projects/:projectId/sessions/:sessionId", async (c) => {
    const projectId = c.req.param("projectId");
    const requestedSessionId = c.req.param("sessionId");
    const afterMessageId = c.req.query("afterMessageId");
    const tailCompactionsParam = c.req.query("tailCompactions");
    const beforeMessageId = c.req.query("beforeMessageId");
    const aroundMessageId = c.req.query("aroundMessageId");
    const afterWindowMessageId = c.req.query("afterWindowMessageId");
    const branchId = c.req.query("branchId");
    const maxMessagesParam = c.req.query("maxMessages");
    const tailCompactions =
      tailCompactionsParam !== undefined
        ? Number.parseInt(tailCompactionsParam, 10)
        : undefined;
    const maxMessages =
      maxMessagesParam !== undefined
        ? Number.parseInt(maxMessagesParam, 10)
        : undefined;

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to support Codex projects that may not be in the scan cache yet
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check if session is actively owned by a process
    let process =
      await runtimeController.getProcessSnapshotForSession(requestedSessionId);
    const sessionId =
      process?.sessionId ??
      deps.sessionMetadataService?.getCanonicalSessionId?.(
        requestedSessionId,
      ) ??
      requestedSessionId;
    if (!process && sessionId !== requestedSessionId) {
      process = await runtimeController.getProcessSnapshotForSession(sessionId);
    }
    const bridgeView = await getBridgeSessionView(deps, sessionId);
    const bridgedSession =
      bridgeView?.session.projectId === projectId ? bridgeView : null;
    const bridgeSessionActive = bridgedSession
      ? await isBridgeSessionActive(deps, sessionId)
      : false;
    const isBridgeSessionLive =
      bridgedSession !== null && isLiveAnyBridgeSessionView(bridgedSession);

    // Check if session is being controlled by an external program
    const isExternal =
      (deps.externalTracker?.isExternal(sessionId) ?? false) ||
      (isBridgeSessionLive && bridgeSessionActive);

    // Check if we've ever owned this session (for orphan detection)
    // Only mark tools as "aborted" if we owned the session and know it terminated
    const wasEverOwned = await runtimeController.wasEverOwned(sessionId);

    // Always try to read from disk first (even for owned sessions)
    const reader = deps.readerFactory(project);
    const usesWindowPagination =
      !afterMessageId && Boolean(aroundMessageId || afterWindowMessageId);
    const readerAfterMessageId = usesWindowPagination
      ? undefined
      : afterMessageId;
    let loadedSession = await reader.getSession(
      sessionId,
      project.id,
      readerAfterMessageId,
      {
        // Only include orphaned tool info if:
        // 1. We previously owned this session (not external)
        // 2. No active process (tools aren't potentially in progress)
        // When we own the session, tools without results might be pending approval
        includeOrphans: wasEverOwned && !process,
        branchId,
      },
    );

    // For mixed projects, fall back to the other providers' session stores if
    // the primary reader didn't find the session. Candidate ordering and
    // reader construction are shared with findSessionSummaryAcrossProviders.
    if (!loadedSession) {
      const projectGroup = normalizeProviderGroup(project.provider);
      for (const source of resolveSessionSources(
        project,
        toProviderResolutionDeps(deps),
      )) {
        if (normalizeProviderGroup(source.provider) === projectGroup) continue;
        // The opencode fallback keeps the route-level reader so cached
        // context-window lookups stay attached.
        const sourceReader =
          source.kind === "opencode"
            ? getOpenCodeReader(project.path)
            : source.reader;
        loadedSession = await sourceReader.getSession(
          sessionId,
          project.id,
          readerAfterMessageId,
          { includeOrphans: wasEverOwned && !process, branchId },
        );
        if (loadedSession) break;
      }
    }

    let session = loadedSession ? normalizeSession(loadedSession) : null;

    const runtime = deriveSessionRuntime({
      process,
      externalActive: isExternal,
      externalActivity: bridgedSession?.activity,
      fallbackOwnership: session?.ownership,
    });
    const ownership = runtime.ownership;

    // Get pending input request from active process (for tool approval prompts)
    // This ensures clients get pending requests immediately without waiting for SSE
    const activePendingInputRequest =
      process?.pendingInputRequest ??
      (await getBridgePendingInputRequest(deps, sessionId));
    const livePendingInputType =
      pendingInputTypeFromProcess(process) ??
      bridgedSession?.pendingInputType ??
      (activePendingInputRequest
        ? activePendingInputRequest.type === "tool-approval"
          ? "tool-approval"
          : "user-question"
        : undefined);

    // Get available slash commands from active process (for "/" button in toolbar)
    // The init message that normally carries these gets discarded from the SSE buffer
    // after ~30s, so we attach them to the REST response for reliable delivery.
    const slashCommands = process?.supportsDynamicCommands
      ? await runtimeController.getSupportedCommands(process.id)
      : null;

    if (!session) {
      // Session file doesn't exist yet - only valid if we own the process
      if (process) {
        // Get raw messages from process memory
        const sdkMessages = process.messageHistory;
        // Convert to client format
        const processMessages = sdkMessagesToClientMessages(sdkMessages, {
          model: process.model,
          provider: process.provider,
        });
        // Extract context usage from raw SDK messages (has usage field)
        // Use process.contextWindow (captured from result messages) as primary source
        const mis = deps.modelInfoService;
        const sdkContextWindow = process.contextWindow;
        const contextUsage = extractContextUsageFromSDKMessages(
          sdkMessages,
          process.model,
          process.provider,
          sdkContextWindow
            ? () => sdkContextWindow
            : mis
              ? (m, p) => mis.getContextWindow(m, p, sessionId)
              : undefined,
        );
        // Cache SDK-reported context window for future JSONL reads
        if (mis && sdkContextWindow && process.model) {
          mis.recordContextWindow(
            process.model,
            sdkContextWindow,
            process.provider,
          );
        }
        if (mis && sdkContextWindow) {
          mis.recordSessionContextWindow(
            sessionId,
            sdkContextWindow,
            process.provider,
          );
        }
        // Get metadata even for new sessions (in case it was set before file was written)
        const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
        // Get notification data for new sessions too
        const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
        const newSessionUpdatedAt = new Date().toISOString();
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(sessionId, newSessionUpdatedAt)
          : undefined;
        return c.json({
          session: {
            id: sessionId,
            projectId,
            title: null,
            createdAt: new Date().toISOString(),
            updatedAt: newSessionUpdatedAt,
            messageCount: processMessages.length,
            ownership,
            pendingInputType: livePendingInputType,
            activity: runtime.activity,
            runtime,
            messages: processMessages,
            customTitle: metadata?.customTitle,
            aiTitle: metadata?.aiTitle,
            isArchived: metadata?.isArchived,
            isStarred: metadata?.isStarred,
            createdBy: metadata?.createdBy,
            lastSeenAt: lastSeenEntry?.timestamp,
            hasUnread,
            provider: process.provider,
            model: process.model,
            reasoningEffort: process.reasoningEffort,
            serviceTier: process.serviceTier,
            contextUsage,
          },
          messages: processMessages,
          ownership,
          runtime,
          pendingInputRequest: activePendingInputRequest,
          slashCommands,
        });
      }
      if (bridgedSession) {
        const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
        const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(
              sessionId,
              bridgedSession.session.updatedAt,
            )
          : undefined;
        return c.json({
          session: {
            ...bridgedSession.session,
            messages: [],
            customTitle: metadata?.customTitle,
            aiTitle: metadata?.aiTitle ?? bridgedSession.session.aiTitle,
            isArchived: metadata?.isArchived,
            isStarred: metadata?.isStarred,
            createdBy: metadata?.createdBy ?? bridgedSession.session.createdBy,
            ownership,
            pendingInputType: livePendingInputType,
            activity: runtime.activity,
            runtime,
            lastSeenAt: lastSeenEntry?.timestamp,
            hasUnread,
          },
          messages: [],
          ownership,
          runtime,
          pendingInputRequest: activePendingInputRequest,
          slashCommands,
        });
      }
      return c.json({ error: "Session not found" }, 404);
    }

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;
    const hasUnread = deps.notificationService
      ? deps.notificationService.hasUnread(sessionId, session.updatedAt)
      : undefined;

    // Apply compact-boundary pagination if requested (BEFORE expensive augmentation)
    // tailCompactions slices to last N compact boundaries; skip when afterMessageId is
    // present since that's a different use case (incremental forward-fetch)
    let paginationInfo: PaginationInfo | undefined;
    const boundedMaxMessages =
      maxMessages !== undefined && !Number.isNaN(maxMessages) && maxMessages > 0
        ? maxMessages
        : undefined;
    if (aroundMessageId && !afterMessageId) {
      const sliced = sliceAroundMessage(
        session.messages,
        aroundMessageId,
        boundedMaxMessages ?? 100,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    } else if (afterWindowMessageId && !afterMessageId) {
      const sliced = sliceAfterMessage(
        session.messages,
        afterWindowMessageId,
        boundedMaxMessages ?? 100,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    } else if (
      tailCompactions !== undefined &&
      !Number.isNaN(tailCompactions) &&
      tailCompactions > 0 &&
      !afterMessageId
    ) {
      const sliced = sliceAtCompactBoundaries(
        session.messages,
        tailCompactions,
        beforeMessageId,
        boundedMaxMessages,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    }

    // Keep persisted rendering in lockstep with stream augmentation behavior.
    await augmentPersistedSessionMessages(session.messages);

    const persistedPendingInputRequest =
      activePendingInputRequest === null &&
      (session.provider === "claude" ||
        session.provider === "claude-ollama" ||
        session.provider === "opencode")
        ? getPersistedAskUserQuestionInputRequest(session.messages, sessionId)
        : null;
    const pendingInputRequest =
      activePendingInputRequest ?? persistedPendingInputRequest;
    const pendingInputType = pendingInputRequest
      ? pendingInputRequest.type === "tool-approval"
        ? "tool-approval"
        : "user-question"
      : livePendingInputType;

    // Override context usage with SDK-reported context window from live process
    // The reader uses hardcoded defaults; the process captures the real value at runtime
    let { contextUsage } = session;
    if (process?.contextWindow && contextUsage) {
      const cw = process.contextWindow;
      contextUsage = {
        ...contextUsage,
        percentage: Math.round((contextUsage.inputTokens / cw) * 100),
        contextWindow: cw,
      };
      // Cache for future reads without a live process
      deps.modelInfoService?.recordContextWindow(
        process.model ?? session.model ?? "",
        cw,
        process.provider,
      );
      deps.modelInfoService?.recordSessionContextWindow(
        sessionId,
        cw,
        process.provider,
      );
    }

    return c.json({
      session: {
        ...session,
        ownership,
        pendingInputType,
        activity: runtime.activity,
        runtime,
        contextUsage,
        customTitle: metadata?.customTitle,
        aiTitle: metadata?.aiTitle ?? session.aiTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        createdBy: metadata?.createdBy ?? session.createdBy,
        // Model comes from the session reader (extracted from JSONL)
        model: session.model,
        lastTurnStatus: bridgedSession
          ? bridgedSession.session.lastTurnStatus
          : session.lastTurnStatus,
        lastErrorMessage: bridgedSession
          ? bridgedSession.session.lastErrorMessage
          : session.lastErrorMessage,
        retryStatus: bridgedSession
          ? bridgedSession.session.retryStatus
          : session.retryStatus,
        lastSeenAt,
        hasUnread,
      },
      messages: session.messages,
      ownership,
      runtime,
      pendingInputRequest,
      slashCommands,
      ...(paginationInfo && { pagination: paginationInfo }),
    });
  });

  // POST /api/projects/:projectId/sessions - Start new session
  routes.post("/projects/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow starting sessions in new directories
    let project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    // Self-heal stale projectId: same problem as resume, but for a new
    // session we can't read the named session's jsonl (it doesn't exist
    // yet) — scan the project's session directory instead. Any existing
    // jsonl carries the SDK-written cwd, which is the source of truth.
    const recoverySessionDir = project.sessionDir;
    const recoveredCwd = await resolveStartCwd(
      project.path,
      recoverySessionDir,
      (cwd) => deps.scanner.mapSessionCwdToLocal(cwd, recoverySessionDir),
    );
    if (recoveredCwd) {
      const recoveredId = encodeProjectId(recoveredCwd);
      const fresh = await deps.scanner.getOrCreateProject(recoveredId);
      if (!fresh) {
        return c.json(
          {
            error: `Project directory ${project.path} no longer exists and recovered path ${recoveredCwd} is also invalid`,
          },
          404,
        );
      }
      console.warn(
        `[startSession] Stale projectId: ${project.path} no longer exists; recovered cwd=${recoveredCwd}`,
      );
      project = fresh;
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const parsedCodexMcpMode = parseOptionalCodexMcpMode(body.codexMcpMode);
    if (parsedCodexMcpMode.error) {
      return c.json({ error: parsedCodexMcpMode.error }, 400);
    }
    const parsedOpenCodeConfig = parseOptionalOpenCodeConfig(
      body.opencodeConfig,
    );
    if (parsedOpenCodeConfig.error) {
      return c.json({ error: parsedOpenCodeConfig.error }, 400);
    }
    const parsedReasoningEffort = parseOptionalReasoningEffort(
      body.reasoningEffort,
    );
    if (parsedReasoningEffort.error) {
      return c.json({ error: parsedReasoningEffort.error }, 400);
    }

    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
    };

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Claude advertises "default" as Sonnet 5, so keep execution aligned
    // with the picker instead of inheriting the remote VM's user setting.
    const model = resolveSessionModel(
      body.model,
      body.provider ?? project.provider,
    );

    // Debug: log what we received
    console.log("[startSession] Request body:", {
      provider: body.provider,
      executor,
      model: body.model,
      opencodeConfig: parsedOpenCodeConfig.opencodeConfig
        ? {
            model: parsedOpenCodeConfig.opencodeConfig.model,
            requestProtocol:
              parsedOpenCodeConfig.opencodeConfig.requestProtocol,
            limits: parsedOpenCodeConfig.opencodeConfig.limits,
          }
        : undefined,
    });

    const globalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;

    const result = await runtimeController.startSession({
      projectPath: project.path,
      message: userMessage,
      permissionMode: body.mode,
      modelSettings: {
        model,
        thinking,
        effort,
        reasoningEffort: normalizeReasoningEffortForProvider(
          body.provider ?? project.provider,
          parsedReasoningEffort.reasoningEffort,
        ),
        providerName: body.provider,
        codexMcpMode: parsedCodexMcpMode.codexMcpMode,
        opencodeConfig: parsedOpenCodeConfig.opencodeConfig,
        executor,
        globalInstructions,
        permissions: body.permissions,
      },
    });

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    recordOpenCodeContextWindowOverride(deps, {
      provider: result.provider,
      model: parsedOpenCodeConfig.opencodeConfig?.model ?? model,
      sessionId: result.sessionId,
      limits: parsedOpenCodeConfig.opencodeConfig?.limits,
    });

    // Save provider and executor to session metadata for resume
    if (deps.sessionMetadataService) {
      if (body.provider) {
        await deps.sessionMetadataService.setProvider(
          result.sessionId,
          body.provider,
        );
      }
      if (executor) {
        await deps.sessionMetadataService.setExecutor(
          result.sessionId,
          executor,
        );
      }
      if (parsedOpenCodeConfig.opencodeConfig) {
        await deps.sessionMetadataService.setOpenCodeConfig(
          result.sessionId,
          parsedOpenCodeConfig.opencodeConfig,
        );
      }
      if (result.provider === "codex" && parsedCodexMcpMode.codexMcpMode) {
        await deps.sessionMetadataService.setCodexMcpMode?.(
          result.sessionId,
          parsedCodexMcpMode.codexMcpMode,
        );
      }
    }
    await markSessionCreatedByYep(deps, result.sessionId, project.id);

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
    });
  });

  // POST /api/projects/:projectId/sessions/create - Create session without starting agent
  // Used for two-phase flow: create session first, upload files, then send first message
  routes.post("/projects/:projectId/sessions/create", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow starting sessions in new directories
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: CreateSessionBody = {};
    try {
      body = await c.req.json<CreateSessionBody>();
    } catch {
      // Body is optional for this endpoint
    }

    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const parsedCodexMcpMode = parseOptionalCodexMcpMode(body.codexMcpMode);
    if (parsedCodexMcpMode.error) {
      return c.json({ error: parsedCodexMcpMode.error }, 400);
    }
    const parsedOpenCodeConfig = parseOptionalOpenCodeConfig(
      body.opencodeConfig,
    );
    if (parsedOpenCodeConfig.error) {
      return c.json({ error: parsedOpenCodeConfig.error }, 400);
    }
    const parsedReasoningEffort = parseOptionalReasoningEffort(
      body.reasoningEffort,
    );
    if (parsedReasoningEffort.error) {
      return c.json({ error: parsedReasoningEffort.error }, 400);
    }

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Claude advertises "default" as Sonnet 5, so keep execution aligned
    // with the picker instead of inheriting the remote VM's user setting.
    const model = resolveSessionModel(
      body.model,
      body.provider ?? project.provider,
    );

    const globalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;

    const result = await runtimeController.createSession({
      projectPath: project.path,
      permissionMode: body.mode,
      modelSettings: {
        model,
        thinking,
        effort,
        reasoningEffort: normalizeReasoningEffortForProvider(
          body.provider ?? project.provider,
          parsedReasoningEffort.reasoningEffort,
        ),
        providerName: body.provider,
        codexMcpMode: parsedCodexMcpMode.codexMcpMode,
        opencodeConfig: parsedOpenCodeConfig.opencodeConfig,
        executor,
        globalInstructions,
        permissions: body.permissions,
      },
    });

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    recordOpenCodeContextWindowOverride(deps, {
      provider: result.provider,
      model: parsedOpenCodeConfig.opencodeConfig?.model ?? model,
      sessionId: result.sessionId,
      limits: parsedOpenCodeConfig.opencodeConfig?.limits,
    });

    // Save provider and executor to session metadata for resume
    if (deps.sessionMetadataService) {
      if (body.provider) {
        await deps.sessionMetadataService.setProvider(
          result.sessionId,
          body.provider,
        );
      }
      if (executor) {
        await deps.sessionMetadataService.setExecutor(
          result.sessionId,
          executor,
        );
      }
      if (parsedOpenCodeConfig.opencodeConfig) {
        await deps.sessionMetadataService.setOpenCodeConfig(
          result.sessionId,
          parsedOpenCodeConfig.opencodeConfig,
        );
      }
      if (result.provider === "codex" && parsedCodexMcpMode.codexMcpMode) {
        await deps.sessionMetadataService.setCodexMcpMode?.(
          result.sessionId,
          parsedCodexMcpMode.codexMcpMode,
        );
      }
    }
    await markSessionCreatedByYep(deps, result.sessionId, project.id);

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/resume - Resume session
  routes.post("/projects/:projectId/sessions/:sessionId/resume", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow resuming in directories that may have been moved
    let project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }
    let resolvedProjectId: UrlProjectId = projectId as UrlProjectId;

    // Self-heal stale projectId: cached projectId may encode an old absolute
    // path if the user moved or deleted the project directory. spawn() would
    // then fail with ENOENT, which the SDK mis-renders as "binary exists but
    // failed to launch". Recover the real cwd from the session's jsonl (the
    // SDK rewrites it on every turn) and re-resolve the project.
    const recoverySessionDir = project.sessionDir;
    const recoveredCwd = await resolveResumeCwd(
      project.path,
      recoverySessionDir,
      sessionId,
      (cwd) => deps.scanner.mapSessionCwdToLocal(cwd, recoverySessionDir),
    );
    if (recoveredCwd) {
      const recoveredId = encodeProjectId(recoveredCwd);
      const fresh = await deps.scanner.getOrCreateProject(recoveredId);
      if (!fresh) {
        return c.json(
          {
            error: `Project directory ${project.path} no longer exists and recovered path ${recoveredCwd} is also invalid`,
          },
          404,
        );
      }
      console.warn(
        `[resume] Stale projectId for session ${sessionId}: ${project.path} no longer exists; recovered cwd=${recoveredCwd}`,
      );
      project = fresh;
      resolvedProjectId = recoveredId;
      if (deps.recentsService) {
        await deps.recentsService.recordVisit(sessionId, recoveredId);
      }
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }
    const parsedRollbackNumTurns = parseOptionalPositiveInteger(
      body.rollbackNumTurns,
      "rollbackNumTurns",
    );
    if (parsedRollbackNumTurns.error) {
      return c.json({ error: parsedRollbackNumTurns.error }, 400);
    }
    const parsedCodexMcpMode = parseOptionalCodexMcpMode(body.codexMcpMode);
    if (parsedCodexMcpMode.error) {
      return c.json({ error: parsedCodexMcpMode.error }, 400);
    }
    const parsedOpenCodeConfig = parseOptionalOpenCodeConfig(
      body.opencodeConfig,
    );
    if (parsedOpenCodeConfig.error) {
      return c.json({ error: parsedOpenCodeConfig.error }, 400);
    }
    const parsedReasoningEffort = parseOptionalReasoningEffort(
      body.reasoningEffort,
    );
    if (parsedReasoningEffort.error) {
      return c.json({ error: parsedReasoningEffort.error }, 400);
    }

    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
    };

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Use client-provided executor, falling back to saved executor from metadata.
    let executor = parsedBodyExecutor.executor;
    if (!executor) {
      const parsedSavedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService?.getExecutor(sessionId),
      );
      if (parsedSavedExecutor.error) {
        return c.json({ error: parsedSavedExecutor.error }, 400);
      }
      executor = parsedSavedExecutor.executor;
    }

    if (executor) {
      // Persist only the selected executor. Shared mode reads the VM-authored
      // JSONL in place; compatibility mode updates a local replica after turns.
      if (deps.sessionMetadataService) {
        await deps.sessionMetadataService.setExecutor(sessionId, executor);
      }
    }

    const globalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;

    // Look up the session's original provider so we resume with the correct one
    // (e.g., claude-ollama sessions need the Ollama provider, not default Claude).
    // Check metadata first (explicitly saved on creation), then fall back to reader.
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const opencodeConfig =
      parsedOpenCodeConfig.opencodeConfig ??
      deps.sessionMetadataService?.getOpenCodeConfig?.(sessionId);

    let sessionSummary: SessionSummary | null = null;
    let providerName = metadataProvider ?? body.provider;
    if (!providerName || !parsedReasoningEffort.reasoningEffort) {
      const sessionSummaryResult = await findSessionSummaryAcrossProviders(
        project,
        sessionId,
        resolvedProjectId,
        toProviderResolutionDeps(deps),
        metadataProvider ?? body.provider,
      );
      sessionSummary = sessionSummaryResult?.summary ?? null;
      providerName =
        providerName ??
        sessionSummary?.provider ??
        metadataProvider ??
        body.provider ??
        project.provider;
    }

    const model = resolveSessionModel(body.model, providerName);

    // Codex rewind: the client's rollbackNumTurns is derived from rendered
    // prompt items, which can drift from the app-server turn count (setup
    // folding, dedupe, viewing an older branch). When the edited turn's
    // identity is provided, recompute the count from the persisted turn tree.
    let effectiveRollbackNumTurns = parsedRollbackNumTurns.value;
    if (
      providerName === "codex" &&
      typeof body.rollbackTarget?.text === "string" &&
      body.rollbackTarget.text.trim().length > 0
    ) {
      const codexReader = getCodexReader(project.path);
      if (codexReader) {
        try {
          const loaded = await codexReader.getSession(
            sessionId,
            resolvedProjectId,
          );
          const branchState = loaded?.codexBranchState ?? loaded?.branchState;
          const computed = branchState
            ? computeCodexRollbackNumTurns(branchState, {
                timestamp: body.rollbackTarget.timestamp,
                prompt: body.rollbackTarget.text,
              })
            : null;
          getLogger().info(
            {
              event: "codex_rollback_numturns_resolved",
              sessionId,
              clientRollbackNumTurns: parsedRollbackNumTurns.value ?? null,
              computedRollbackNumTurns: computed,
              rollbackTargetTimestamp: body.rollbackTarget.timestamp ?? null,
            },
            "Resolved Codex rollback turn count from persisted turn tree",
          );
          if (computed !== null) {
            effectiveRollbackNumTurns = computed;
          }
        } catch (error) {
          getLogger().warn(
            {
              event: "codex_rollback_numturns_resolution_failed",
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Falling back to client-provided rollbackNumTurns",
          );
        }
      }
    }

    getLogger().info(
      {
        event: "session_resume_requested",
        sessionId,
        projectId: resolvedProjectId,
        projectPath: project.path,
        providerName,
        bodyProvider: body.provider ?? null,
        metadataProvider: metadataProvider ?? null,
        executor: executor ?? null,
        codexMcpMode:
          parsedCodexMcpMode.codexMcpMode ??
          deps.sessionMetadataService?.getCodexMcpMode?.(sessionId) ??
          null,
        resumeSessionAt: supportsResumeSessionAt(providerName)
          ? (body.resumeSessionAt ?? null)
          : null,
        rollbackNumTurns:
          providerName === "codex" ? (effectiveRollbackNumTurns ?? null) : null,
        ignoredResumeSessionAt: !supportsResumeSessionAt(providerName)
          ? (body.resumeSessionAt ?? null)
          : null,
        ignoredRollbackNumTurns:
          providerName !== "codex"
            ? (parsedRollbackNumTurns.value ?? null)
            : null,
        tempId: body.tempId ?? null,
        messageLength: body.message.length,
        opencodeConfig: opencodeConfig
          ? {
              model: opencodeConfig.model,
              requestProtocol: opencodeConfig.requestProtocol,
              limits: opencodeConfig.limits,
            }
          : undefined,
      },
      "Session resume requested",
    );

    const resumeReasoningEffort =
      parsedReasoningEffort.reasoningEffort ??
      (providerName === "codex" || providerName === "opencode"
        ? sessionSummary?.reasoningEffort
        : undefined);

    const result = await runtimeController.resumeSession({
      sessionId,
      projectPath: project.path,
      message: userMessage,
      permissionMode: body.mode,
      modelSettings: {
        model,
        thinking,
        effort,
        reasoningEffort: normalizeReasoningEffortForProvider(
          providerName,
          resumeReasoningEffort,
        ),
        providerName,
        codexMcpMode:
          providerName === "codex"
            ? (parsedCodexMcpMode.codexMcpMode ??
              deps.sessionMetadataService?.getCodexMcpMode?.(sessionId))
            : undefined,
        opencodeConfig,
        executor,
        globalInstructions,
        permissions: body.permissions,
        // Rewind/edit: Claude rewinds the same session; OpenCode forks a native
        // session from this boundary and reports the forked id through init.
        resumeSessionAt: supportsResumeSessionAt(providerName)
          ? body.resumeSessionAt
          : undefined,
        // Codex app-server models Codex CLI Esc Esc backtrack as a
        // same-thread rollback count, not as a message UUID.
        rollbackNumTurns:
          providerName === "codex" ? effectiveRollbackNumTurns : undefined,
      },
    });

    if (
      deps.sessionMetadataService &&
      providerName === "codex" &&
      parsedCodexMcpMode.codexMcpMode
    ) {
      await deps.sessionMetadataService.setCodexMcpMode?.(
        sessionId,
        parsedCodexMcpMode.codexMcpMode,
      );
    }
    if (deps.sessionMetadataService && parsedOpenCodeConfig.opencodeConfig) {
      await deps.sessionMetadataService.setOpenCodeConfig(
        sessionId,
        parsedOpenCodeConfig.opencodeConfig,
      );
    }

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      getLogger().info(
        {
          event: "session_resume_queued",
          sessionId,
          projectId: resolvedProjectId,
          providerName,
          queueId: result.queueId,
          position: result.position,
        },
        "Session resume queued",
      );
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    const actualSessionId = result.sessionId ?? sessionId;

    if (deps.sessionMetadataService && actualSessionId !== sessionId) {
      if (providerName) {
        await deps.sessionMetadataService.setProvider(
          actualSessionId,
          providerName as ProviderName,
        );
      }
      if (executor) {
        await deps.sessionMetadataService.setExecutor(
          actualSessionId,
          executor,
        );
      }
      if (opencodeConfig) {
        await deps.sessionMetadataService.setOpenCodeConfig(
          actualSessionId,
          opencodeConfig,
        );
      }
    }
    if (actualSessionId !== sessionId) {
      await markSessionCreatedByYep(deps, actualSessionId, project.id);
    }

    recordOpenCodeContextWindowOverride(deps, {
      provider: providerName as ProviderName | undefined,
      model: opencodeConfig?.model ?? model,
      sessionId: actualSessionId,
      limits: opencodeConfig?.limits,
    });

    getLogger().info(
      {
        event: "session_resume_process_started",
        sessionId,
        actualSessionId,
        projectId: resolvedProjectId,
        providerName,
        processId: result.id,
        permissionMode: result.permissionMode,
        modeVersion: result.modeVersion,
      },
      "Session resume process started",
    );

    return c.json({
      sessionId: actualSessionId,
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      reasoningEffort: resumeReasoningEffort,
    });
  });

  // POST /api/sessions/:sessionId/messages - Queue message
  routes.post("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process =
      await runtimeController.getProcessSnapshotForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    let body: StartSessionBody & { deferred?: boolean };
    try {
      body = await c.req.json<StartSessionBody & { deferred?: boolean }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const parsedCodexMcpMode = parseOptionalCodexMcpMode(body.codexMcpMode);
    if (parsedCodexMcpMode.error) {
      return c.json({ error: parsedCodexMcpMode.error }, 400);
    }
    const parsedOpenCodeConfig = parseOptionalOpenCodeConfig(
      body.opencodeConfig,
    );
    if (parsedOpenCodeConfig.error) {
      return c.json({ error: parsedOpenCodeConfig.error }, 400);
    }
    const parsedReasoningEffort = parseOptionalReasoningEffort(
      body.reasoningEffort,
    );
    if (parsedReasoningEffort.error) {
      return c.json({ error: parsedReasoningEffort.error }, 400);
    }

    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
    };

    // Check if process is terminated
    if (process.state === "terminated") {
      return c.json(
        {
          error: "Process terminated",
          reason: process.terminationReason,
        },
        410,
      ); // 410 Gone
    }

    // Deferred messages are held server-side and auto-sent when the agent finishes
    if (body.deferred) {
      const deferred = await runtimeController.deferMessage(
        sessionId,
        userMessage,
      );
      if (!deferred.queued) {
        return c.json({ error: "No active process for session" }, 410);
      }
      return c.json({ queued: true, deferred: true });
    }

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const metadataExecutor = parseOptionalExecutor(
      deps.sessionMetadataService?.getExecutor(sessionId),
    );
    if (metadataExecutor.error) {
      return c.json({ error: metadataExecutor.error }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }

    const providerName = metadataProvider ?? body.provider ?? process.provider;
    const model =
      body.model === undefined
        ? process.model
        : resolveSessionModel(body.model, providerName);
    const opencodeConfig =
      parsedOpenCodeConfig.opencodeConfig ??
      deps.sessionMetadataService?.getOpenCodeConfig?.(sessionId);

    // Use queueMessageToSession which handles thinking mode changes
    // If thinking mode changed, it will restart the process automatically
    const queueGlobalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;
    const result = await runtimeController.queueMessage({
      sessionId,
      projectPath: process.projectPath,
      message: userMessage,
      permissionMode: body.mode,
      modelSettings: {
        model,
        thinking,
        effort,
        reasoningEffort:
          parsedReasoningEffort.reasoningEffort !== undefined
            ? normalizeReasoningEffortForProvider(
                providerName,
                parsedReasoningEffort.reasoningEffort,
              )
            : (process.requestedReasoningEffort ?? process.reasoningEffort),
        providerName,
        codexMcpMode:
          providerName === "codex"
            ? (parsedCodexMcpMode.codexMcpMode ??
              deps.sessionMetadataService?.getCodexMcpMode?.(sessionId))
            : undefined,
        opencodeConfig,
        executor:
          executor ??
          metadataExecutor.executor ??
          process.executor ??
          undefined,
        globalInstructions: queueGlobalInstructions,
        permissions: body.permissions,
      },
    });

    if (!result.success) {
      return c.json(
        {
          error: "Failed to queue message",
          reason: result.error,
        },
        410,
      ); // 410 Gone - process is no longer available
    }

    recordOpenCodeContextWindowOverride(deps, {
      provider: providerName,
      model: opencodeConfig?.model ?? model,
      sessionId,
      limits: opencodeConfig?.limits,
    });

    return c.json({
      queued: true,
      restarted: result.restarted,
      processId: result.process.id,
    });
  });

  // DELETE /api/sessions/:sessionId/deferred/:tempId - Cancel a deferred message
  routes.delete("/sessions/:sessionId/deferred/:tempId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process =
      await runtimeController.getProcessSnapshotForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const { cancelled } = await runtimeController.cancelDeferredMessage(
      sessionId,
      tempId,
    );
    if (!cancelled) {
      return c.json({ error: "Deferred message not found" }, 404);
    }

    return c.json({ cancelled: true });
  });

  // PUT /api/sessions/:sessionId/mode - Update permission mode without sending a message
  routes.put("/sessions/:sessionId/mode", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ mode: PermissionMode }>();

    if (!body.mode) {
      return c.json({ error: "mode is required" }, 400);
    }

    const modeResult = await runtimeController.setPermissionMode({
      sessionId,
      mode: body.mode,
    });
    if (!modeResult.ok) {
      return c.json({ error: "No active process for session" }, 404);
    }

    return c.json({
      permissionMode: modeResult.permissionMode,
      modeVersion: modeResult.modeVersion,
    });
  });

  // PUT /api/sessions/:sessionId/hold - Set hold (soft pause) mode
  routes.put("/sessions/:sessionId/hold", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ hold: boolean }>();

    if (typeof body.hold !== "boolean") {
      return c.json({ error: "hold is required (boolean)" }, 400);
    }

    const holdResult = await runtimeController.setHold({
      sessionId,
      hold: body.hold,
    });
    if (!holdResult.ok) {
      return c.json({ error: "No active process for session" }, 404);
    }

    return c.json({
      isHeld: holdResult.isHeld,
      holdSince: holdResult.holdSince,
      state: holdResult.state,
    });
  });

  // GET /api/sessions/:sessionId/pending-input - Get pending input request
  routes.get("/sessions/:sessionId/pending-input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process =
      await runtimeController.getProcessSnapshotForSession(sessionId);
    if (!process) {
      return c.json({
        request: await getBridgePendingInputRequest(deps, sessionId),
      });
    }

    // Use getPendingInputRequest which works for both mock and real SDK
    const request = await runtimeController.getPendingInputRequest(sessionId);
    return c.json({ request });
  });

  // GET /api/sessions/:sessionId/process - Get process info for a session
  routes.get("/sessions/:sessionId/process", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = await runtimeController.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ process: null });
    }

    return c.json({ process });
  });

  // POST /api/sessions/:sessionId/input - Respond to input request
  routes.post("/sessions/:sessionId/input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process =
      await runtimeController.getProcessSnapshotForSession(sessionId);
    if (!process) {
      let bridgeBody: InputResponseBody;
      try {
        bridgeBody = await c.req.json<InputResponseBody>();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      if (!bridgeBody.requestId || !bridgeBody.response) {
        return c.json({ error: "requestId and response are required" }, 400);
      }
      const bridgeResponse =
        bridgeBody.response === "approve" ||
        bridgeBody.response === "approve_accept_edits" ||
        bridgeBody.response === "approve_for_session" ||
        bridgeBody.response === "approve_strict_auto_review" ||
        bridgeBody.response === "approve_always"
          ? bridgeBody.response
          : "deny";

      const accepted = await respondToBridgeInput(
        deps,
        sessionId,
        bridgeBody.requestId,
        bridgeResponse,
        bridgeBody.answers,
      );
      if (!accepted) {
        return c.json({ error: "No active process for session" }, 404);
      }
      return c.json({ accepted: true });
    }

    if (!process.pendingInputRequest) {
      return c.json({ error: "No pending input request" }, 400);
    }

    let body: InputResponseBody;
    try {
      body = await c.req.json<InputResponseBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.requestId || !body.response) {
      return c.json({ error: "requestId and response are required" }, 400);
    }

    // Handle approve_accept_edits: approve and switch permission mode
    const isApproveAcceptEdits = body.response === "approve_accept_edits";

    // Normalize response to approve/deny
    const normalizedResponse =
      body.response === "approve" ||
      body.response === "allow" ||
      body.response === "approve_accept_edits"
        ? "approve"
        : "deny";

    // Call respondToInput which resolves the SDK's canUseTool promise
    const { accepted } = await runtimeController.respondToInput({
      sessionId,
      requestId: body.requestId,
      response: normalizedResponse,
      answers: body.answers,
      feedback: body.feedback,
    });

    if (!accepted) {
      return c.json({ error: "Invalid request ID or no pending request" }, 400);
    }

    // If approve_accept_edits, switch the permission mode
    if (isApproveAcceptEdits) {
      await runtimeController.setPermissionMode({
        sessionId,
        mode: "acceptEdits",
      });
    }

    return c.json({ accepted: true });
  });

  // POST /api/sessions/:sessionId/mark-seen - Mark session as seen (read)
  routes.post("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    let body: { timestamp?: string; messageId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    await deps.notificationService.markSeen(
      sessionId,
      body.timestamp,
      body.messageId,
    );

    return c.json({ marked: true });
  });

  // DELETE /api/sessions/:sessionId/mark-seen - Mark session as unread
  routes.delete("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    await deps.notificationService.clearSession(sessionId);

    // Emit event so other tabs/clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-seen",
        sessionId,
        timestamp: "", // Empty timestamp signals "unread"
      });
    }

    return c.json({ marked: false });
  });

  // GET /api/notifications/last-seen - Get all last seen entries
  routes.get("/notifications/last-seen", async (c) => {
    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    return c.json({ lastSeen: deps.notificationService.getAllLastSeen() });
  });

  // GET /api/debug/metadata - Debug endpoint to inspect metadata service state
  routes.get("/debug/metadata", (c) => {
    if (!deps.sessionMetadataService) {
      return c.json(
        { error: "Session metadata service not available", available: false },
        503,
      );
    }

    const allMetadata = deps.sessionMetadataService.getAllMetadata();
    const sessionCount = Object.keys(allMetadata).length;
    const starredCount = Object.values(allMetadata).filter(
      (m) => m.isStarred,
    ).length;
    const archivedCount = Object.values(allMetadata).filter(
      (m) => m.isArchived,
    ).length;
    const filePath = deps.sessionMetadataService.getFilePath();

    return c.json({
      available: true,
      filePath,
      sessionCount,
      starredCount,
      archivedCount,
    });
  });

  // PUT /api/sessions/:sessionId/metadata - Update session metadata (title, archived, starred)
  routes.put("/sessions/:sessionId/metadata", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service not available" }, 503);
    }

    let body: { title?: string; archived?: boolean; starred?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // At least one field must be provided
    if (
      body.title === undefined &&
      body.archived === undefined &&
      body.starred === undefined
    ) {
      return c.json(
        { error: "At least title, archived, or starred must be provided" },
        400,
      );
    }

    let archiveResult:
      | {
          physical: boolean;
          action: "archive" | "restore" | "already_archived";
          record?: ArchivedSessionRecord;
        }
      | undefined;

    if (body.archived === true && deps.sessionArchiveService) {
      const activeProcess =
        await runtimeController.getProcessSnapshotForSession(sessionId);
      const bridgeView = await getBridgeSessionView(deps, sessionId);
      const bridgeSessionActive = bridgeView
        ? await isBridgeSessionActive(deps, sessionId)
        : false;
      const isBridgeSessionLive =
        bridgeView !== null && isLiveAnyBridgeSessionView(bridgeView);
      const runtime = deriveSessionRuntime({
        process: activeProcess,
        externalActive:
          (deps.externalTracker?.isExternal(sessionId) ?? false) ||
          (isBridgeSessionLive && bridgeSessionActive),
        externalActivity: bridgeView?.activity,
      });

      if (!runtime.canArchive) {
        return c.json(
          {
            error:
              runtime.archiveBlockReason ??
              "This session cannot be archived right now.",
            code: runtime.archiveBlockCode,
            runtime,
          },
          409,
        );
      }

      if (activeProcess) {
        await runtimeController.abortProcess(activeProcess.id);
      }

      const target = await resolveArchiveTarget(deps, sessionId);
      if (!target) {
        return c.json({ error: "Session file not found for archive" }, 404);
      }

      try {
        const record = await deps.sessionArchiveService.archiveSession({
          sessionId,
          provider: target.provider,
          project: target.project,
          summary: target.summary,
          sessionFilePath: target.sessionFilePath,
          reason: "manual",
        });
        deps.scanner.invalidateCache();
        deps.codexScanner?.invalidateCache();
        deps.opencodeScanner?.invalidateCache();
        emitArchiveFileEvents(deps, record, "delete");
        archiveResult = { physical: true, action: "archive", record };
      } catch (error) {
        if (
          error instanceof ArchiveError &&
          error.code === "already_archived"
        ) {
          archiveResult = {
            physical: true,
            action: "already_archived",
            record: deps.sessionArchiveService.getArchivedSession(sessionId),
          };
        } else if (error instanceof ArchiveError) {
          return c.json(
            { error: error.message, code: error.code },
            archiveHttpStatus(error),
          );
        } else {
          return c.json({ error: "Failed to archive session" }, 500);
        }
      }
    }

    if (body.archived === false && deps.sessionArchiveService) {
      try {
        const { record } =
          await deps.sessionArchiveService.restoreSession(sessionId);
        deps.scanner.invalidateCache();
        deps.codexScanner?.invalidateCache();
        deps.opencodeScanner?.invalidateCache();
        emitArchiveFileEvents(deps, record, "create");
        archiveResult = { physical: true, action: "restore", record };
      } catch (error) {
        if (error instanceof ArchiveError && error.code === "not_archived") {
          // Existing metadata-only archives still unarchive normally.
        } else if (error instanceof ArchiveError) {
          return c.json(
            { error: error.message, code: error.code },
            archiveHttpStatus(error),
          );
        } else {
          return c.json({ error: "Failed to restore archived session" }, 500);
        }
      }
    }

    await deps.sessionMetadataService.updateMetadata(sessionId, {
      title: body.title,
      archived: body.archived,
      starred: body.starred,
    });

    // Emit SSE event so sidebar and other clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-metadata-changed",
        sessionId,
        title: body.title,
        archived: body.archived,
        starred: body.starred,
        timestamp: new Date().toISOString(),
      });
    }

    return c.json({ updated: true, archive: archiveResult });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/clone - Clone a session
  routes.post("/projects/:projectId/sessions/:sessionId/clone", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check provider supports cloning
    const supportedProviders = ["claude", "codex", "codex-oss"];
    if (!supportedProviders.includes(project.provider)) {
      return c.json(
        { error: `Clone is not supported for ${project.provider} sessions` },
        400,
      );
    }

    let body: { title?: string; provider?: ProviderName } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    try {
      // Get session directory from project
      const sessionDir = project.sessionDir;
      if (!sessionDir) {
        return c.json({ error: "Session directory not found" }, 500);
      }

      // Get original session to extract title for the clone
      const reader = deps.readerFactory(project);
      let originalSession = await reader.getSessionSummary(
        sessionId,
        projectId,
      );
      let cloneProvider: ProviderName = project.provider;

      let result: { newSessionId: string; entries: number };

      const shouldCloneFromCodex =
        isCodexProviderName(body.provider) ||
        isCodexProviderName(project.provider) ||
        (!originalSession && project.provider === "claude");

      if (shouldCloneFromCodex) {
        const codexReader = getCodexReader(project.path);
        if (!codexReader) {
          return c.json({ error: "Codex session reader not available" }, 500);
        }
        const filePath = await codexReader.getSessionFilePath(sessionId);
        if (!filePath) {
          return c.json({ error: "Session file not found" }, 404);
        }

        originalSession =
          originalSession ??
          (await codexReader.getSessionSummary(sessionId, projectId)) ??
          null;
        cloneProvider =
          originalSession?.provider ??
          body.provider ??
          (isCodexProviderName(project.provider) ? project.provider : "codex");
        result = await cloneCodexSession(filePath);
        codexReader.invalidateCache();
        deps.codexScanner?.invalidateCache();
      } else {
        result = await cloneClaudeSession(sessionDir, sessionId);
      }

      // Build clone title: use provided title, or derive from original
      let cloneTitle = body.title;
      if (!cloneTitle && deps.sessionMetadataService) {
        // Check for custom title first, then fall back to auto-generated title
        const originalMetadata =
          deps.sessionMetadataService.getMetadata(sessionId);
        const originalTitle =
          originalMetadata?.customTitle ??
          originalMetadata?.aiTitle ??
          originalSession?.aiTitle ??
          originalSession?.title;
        if (originalTitle) {
          cloneTitle = `${originalTitle} [cloned]`;
        }
      }

      // Set the clone title
      if (cloneTitle && deps.sessionMetadataService) {
        await deps.sessionMetadataService.updateMetadata(result.newSessionId, {
          title: cloneTitle,
        });
      }

      return c.json({
        sessionId: result.newSessionId,
        messageCount: result.entries,
        clonedFrom: sessionId,
        provider: cloneProvider,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clone session";
      return c.json({ error: message }, 500);
    }
  });

  // ============ Worker Queue Endpoints ============

  // GET /api/status/workers - Get worker activity for safe restart indicator
  routes.get("/status/workers", async (c) => {
    const activity = await runtimeController.getWorkerActivity();
    return c.json({ ...activity, runtimeMode: runtimeController.mode });
  });

  // GET /api/queue - Get all queued requests
  routes.get("/queue", async (c) => {
    const queueStatus = await runtimeController.getQueueStatus();
    return c.json(queueStatus);
  });

  // GET /api/queue/:queueId - Get specific queue entry position
  routes.get("/queue/:queueId", async (c) => {
    const queueId = c.req.param("queueId");
    const position = await runtimeController.getQueuePosition(queueId);

    if (position === undefined) {
      return c.json({ error: "Queue entry not found" }, 404);
    }

    return c.json({ queueId, position });
  });

  // DELETE /api/queue/:queueId - Cancel a queued request
  routes.delete("/queue/:queueId", async (c) => {
    const queueId = c.req.param("queueId");

    const { cancelled } = await runtimeController.cancelQueuedRequest(queueId);
    if (!cancelled) {
      return c.json(
        { error: "Queue entry not found or already processed" },
        404,
      );
    }

    return c.json({ cancelled: true });
  });

  return routes;
}

import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ALL_PERMISSION_MODES,
  type ContextCompactEvent,
  type ContextCumulativeUsage,
  type ContextStatusResponse,
  type ContextUsage,
  type GeneratedArtifactManifest,
  type OpenCodeModelLimits,
  type ProviderName,
  type UrlProjectId,
  escalateContextWindow,
  getModelContextWindow,
  isUrlProjectId,
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
  getAnyBridgeSessionView,
} from "../bridge-common/multi.js";
import {
  isActiveBridgeSessionView,
  isLiveBridgeSessionView,
} from "../bridge-common/session-state.js";
import type { FeishuDurableInbox } from "../channels/feishu/inbox.js";
import type { CodexBridgeController } from "../codex-bridge/types.js";
import {
  type CodexEventStoreSource,
  CodexOverlayBudgetExceededError,
  CodexProjectionCache,
  normalizeCodexEventStoreSources,
  overlayCanonicalCodexSessionMessages,
  overlayCodexProviderErrorMessages,
  selectCodexEventSourceWithCache,
  selectCodexProviderErrorEventSource,
} from "../codex-events/index.js";
import {
  type SessionInputResponseBody,
  SessionInteractionService,
} from "../interactions/SessionInteractionService.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { OpenCodeBridgeController } from "../opencode-bridge/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { KimiSessionScanner } from "../projects/kimi-scanner.js";
import type { OpenCodeSessionScanner } from "../projects/opencode-scanner.js";
import { encodeProjectId } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RecentsService } from "../recents/index.js";
import { EmbeddedRuntimeController } from "../runtime/EmbeddedRuntimeController.js";
import type { RuntimeController } from "../runtime/types.js";
import {
  type CodexNativeControlRequest,
  isCodexNativeControlMethod,
} from "../sdk/providers/codex-controls.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import {
  type CreateSessionBody,
  type QueueSessionMessageBody,
  SessionCommandService,
  type StartSessionBody,
} from "../services/SessionCommandService.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { cloneClaudeSession, cloneCodexSession } from "../sessions/fork.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { KimiSessionReader } from "../sessions/kimi-reader.js";
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
import { locateSession } from "../sessions/session-locator.js";
import {
  deriveSessionRuntime,
  pendingInputTypeFromProcess,
} from "../sessions/session-runtime.js";
import type { ISessionReader } from "../sessions/types.js";
import { isUserPromptMessage } from "../sessions/user-prompt-message.js";
import type { ZCodeSessionReader } from "../sessions/zcode-reader.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  ContentBlock,
  Message,
  Project,
  SessionSummary,
} from "../supervisor/types.js";
import { UploadManager } from "../uploads/index.js";
import type { EventBus } from "../watcher/index.js";
function isCodexProviderName(
  provider: ProviderName | string | undefined,
): provider is "codex" | "codex-oss" {
  return provider === "codex" || provider === "codex-oss";
}

export interface SessionsDeps {
  runtimeController?: RuntimeController;
  /** Shared pending-input authority used by HTTP and channel adapters. */
  sessionInteractionService?: SessionInteractionService;
  /** Shared application boundary used by HTTP and channel adapters. */
  sessionCommandService?: SessionCommandService;
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  /** Resolves authenticated, opaque Feishu card links to provider sessions. */
  feishuInbox?: Pick<FeishuDurableInbox, "findByTempId">;
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
  zcodeDbPath?: string;
  /** Optional shared OpenCode reader factory for cross-provider session lookups */
  opencodeReaderFactory?: (projectPath: string) => OpenCodeSessionReader;
  zcodeReaderFactory?: (projectPath: string) => ZCodeSessionReader;
  kimiScanner?: KimiSessionScanner;
  kimiSessionsDir?: string;
  /** Optional shared Kimi reader factory for cross-provider session lookups */
  kimiReaderFactory?: (projectPath: string) => KimiSessionReader;
  /** ServerSettingsService for reading global instructions */
  serverSettingsService?: ServerSettingsService;
  /** ModelInfoService for context window lookups */
  modelInfoService?: ModelInfoService;
  /** RecentsService for repairing stale projectId entries on resume */
  recentsService?: RecentsService;
  /** Codex bridge for externally launched `codex --remote` TUI sessions. */
  codexBridgeService?: CodexBridgeController;
  /** Ordered, independently sequenced canonical journals for persisted refresh. */
  codexEventStoreSources?: readonly CodexEventStoreSource[];
  /** Process-level projection cache for incremental canonical replay. */
  codexProjectionCache?: CodexProjectionCache;
  /** Reads restart-safe generated manifests from the managed upload root. */
  generatedArtifactUploadManager?: Pick<
    UploadManager,
    "listReplayableGeneratedArtifacts"
  >;
  /** OpenCode bridge for OpenCode CLI sessions. */
  opencodeBridgeService?: OpenCodeBridgeController;
  /** Physical cold-archive service for moving old provider JSONL files away from hot scan paths. */
  sessionArchiveService?: SessionArchiveService;
  /** Claude projects directory, used to synthesize file-change invalidation events after moves. */
  claudeProjectsDir?: string;
}

function getSessionPermissionModeState(
  deps: SessionsDeps,
  sessionId: string,
  process:
    | {
        permissionMode?: PermissionMode;
        modeVersion?: number;
      }
    | null
    | undefined,
): { permissionMode?: PermissionMode; modeVersion?: number } {
  const processMode = process?.permissionMode;
  const permissionMode =
    processMode ?? deps.sessionMetadataService?.getPermissionMode?.(sessionId);
  if (!permissionMode) return {};

  return {
    permissionMode,
    modeVersion: processMode ? (process?.modeVersion ?? 0) : 0,
  };
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    ALL_PERMISSION_MODES.includes(value as PermissionMode)
  );
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

function isLiveAnyBridgeSessionView(
  view: NonNullable<BridgeSessionView>,
): boolean {
  return isLiveBridgeSessionView(view);
}

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

/**
 * Resolve the reader that actually owns `sessionId`.
 *
 * A project id is derived purely from the working directory, so a single path
 * can host sessions from several providers (e.g. Claude + Codex + Kimi under
 * the same repo). `readerFactory(project)` only yields the project's primary
 * provider reader, which returns nothing for a session owned by a different
 * provider — this is why the subagent (Agent/AgentSwarm) endpoints returned an
 * empty result for Kimi sessions living under a Claude-primary project. Resolve
 * the owning provider's reader by session instead, falling back to the primary.
 */
async function resolveReaderForSession(
  deps: SessionsDeps,
  project: Project,
  sessionId: string,
): Promise<ISessionReader> {
  const preferredProvider = deps.sessionMetadataService?.getProvider(sessionId);
  const resolved = await findSessionSummaryAcrossProviders(
    project,
    sessionId,
    project.id,
    toProviderResolutionDeps(deps),
    preferredProvider,
  );
  return resolved?.source.reader ?? deps.readerFactory(project);
}

function toProviderResolutionDeps(deps: SessionsDeps): ProviderResolutionDeps {
  return {
    readerFactory: deps.readerFactory,
    sessionMetadataService: deps.sessionMetadataService,
    codexSessionsDir: deps.codexSessionsDir,
    codexReaderFactory: deps.codexReaderFactory,
    geminiSessionsDir: deps.geminiSessionsDir,
    geminiReaderFactory: deps.geminiReaderFactory,
    geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
    opencodeDbPath: deps.opencodeDbPath,
    opencodeReaderFactory: deps.opencodeReaderFactory,
    kimiSessionsDir: deps.kimiSessionsDir,
    kimiReaderFactory: deps.kimiReaderFactory,
    zcodeDbPath: deps.zcodeDbPath,
    zcodeReaderFactory: deps.zcodeReaderFactory,
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

/**
 * Record that Yep started this session, and where.
 *
 * The project is persisted as the reverse index behind
 * `GET /api/sessions/:sessionId/locate`: without it, resolving a bare session
 * id means scanning every project with every provider reader. This is the only
 * point in the request where the session id and its project are both known for
 * certain, and `project` is already post-recovery, so a stale projectId from
 * the URL never gets persisted.
 */
async function recordYepSessionOrigin(
  deps: SessionsDeps,
  sessionId: string,
  project: Project,
): Promise<void> {
  if (!deps.sessionMetadataService) return;

  await deps.sessionMetadataService.setCreatedBy(sessionId, "yep");
  await deps.sessionMetadataService.setProjectLocation(
    sessionId,
    project.id,
    project.path,
  );
  deps.eventBus?.emit({
    type: "session-metadata-changed",
    sessionId,
    projectId: project.id,
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
  const codexEventStoreSources = normalizeCodexEventStoreSources(
    deps.codexEventStoreSources ?? [],
  );
  const codexProjectionCache =
    deps.codexProjectionCache ?? new CodexProjectionCache();
  const generatedArtifactUploadManager =
    deps.generatedArtifactUploadManager ?? new UploadManager();
  const runtimeController =
    deps.runtimeController ?? new EmbeddedRuntimeController(deps.supervisor);
  const sessionInteractionService =
    deps.sessionInteractionService ??
    new SessionInteractionService({
      runtimeController,
      codexBridgeService: deps.codexBridgeService,
      opencodeBridgeService: deps.opencodeBridgeService,
      sessionMetadataService: deps.sessionMetadataService,
      eventBus: deps.eventBus,
    });
  const sessionCommandService =
    deps.sessionCommandService ??
    new SessionCommandService({
      runtimeController,
      scanner: deps.scanner,
      readerFactory: deps.readerFactory,
      sessionInteractionService,
      sessionMetadataService: deps.sessionMetadataService,
      eventBus: deps.eventBus,
      serverSettingsService: deps.serverSettingsService,
      modelInfoService: deps.modelInfoService,
      recentsService: deps.recentsService,
      codexSessionsDir: deps.codexSessionsDir,
      codexReaderFactory: deps.codexReaderFactory,
      geminiScanner: deps.geminiScanner,
      geminiSessionsDir: deps.geminiSessionsDir,
      geminiReaderFactory: deps.geminiReaderFactory,
      opencodeDbPath: deps.opencodeDbPath,
      opencodeReaderFactory: deps.opencodeReaderFactory,
      kimiSessionsDir: deps.kimiSessionsDir,
      kimiReaderFactory: deps.kimiReaderFactory,
    });
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

  // GET /api/sessions/:sessionId/locate - Resolve a bare session id to its
  // owning project.
  //
  // Every other read path is keyed by projectId + sessionId, so an id on its
  // own (copied from the UI, pasted into an agent running elsewhere, quoted in
  // a bug report) is not addressable. This is the one route that turns one
  // back into a location.
  routes.get("/sessions/:sessionId/locate", async (c) => {
    const requestedSessionId = c.req.param("sessionId");
    const opaqueFeishuReference = /^feishu-[a-f0-9]{32}$/.test(
      requestedSessionId,
    );
    const inboxRecord = opaqueFeishuReference
      ? deps.feishuInbox?.findByTempId(requestedSessionId)
      : undefined;
    if (opaqueFeishuReference && !inboxRecord?.sessionId) {
      return c.json({ error: "Session not found" }, 404);
    }
    const sessionId = inboxRecord?.sessionId ?? requestedSessionId;
    const location = await locateSession(deps, sessionId);
    if (!location) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({
      session: {
        ...location,
        requestedSessionId,
      },
    });
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

    const sessionId = c.req.param("sessionId");
    const reader = await resolveReaderForSession(deps, project, sessionId);
    const mappings = await reader.getAgentMappings(sessionId);

    return c.json({ mappings });
  });

  // GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId - Get agent session content
  // Used for lazy-loading completed Tasks
  routes.get(
    "/projects/:projectId/sessions/:sessionId/agents/:agentId",
    async (c) => {
      const projectId = c.req.param("projectId");
      const agentId = c.req.param("agentId");
      const sessionId = c.req.param("sessionId");

      // Validate projectId format at API boundary
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json({ error: "Project not found" }, 404);
      }

      const reader = await resolveReaderForSession(deps, project, sessionId);
      const agentSession = await reader.getAgentSession(agentId, sessionId);

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
    // The view already carries the sidecar's liveness verdict, so no extra
    // `/sessions/:id/active` round-trip is needed on every session open.
    const isBridgeSessionLive =
      bridgedSession !== null && isActiveBridgeSessionView(bridgedSession);

    // Check if session is being controlled by an external program
    const isExternal =
      (deps.externalTracker?.isExternal(sessionId) ?? false) ||
      isBridgeSessionLive;

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
      await sessionCommandService.getPendingInput(sessionId, {
        processSnapshot: process,
      });
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
        parentSessionId: sessionSummary?.parentSessionId,
        forkParentSessionId:
          metadata?.forkParentSessionId ?? sessionSummary?.forkParentSessionId,
        model: sessionSummary?.model,
        reasoningEffort:
          sessionSummary?.reasoningEffort ?? process?.reasoningEffort,
        serviceTier: sessionSummary?.serviceTier ?? process?.serviceTier,
        originator: sessionSummary?.originator,
        createdBy: metadata?.createdBy ?? sessionSummary?.createdBy,
        originChannel: metadata?.originChannel ?? sessionSummary?.originChannel,
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
      ...getSessionPermissionModeState(deps, sessionId, process),
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
  //   ?view=canonical - explicitly request canonical overlay; default is legacy
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
    const viewParam = c.req.query("view");
    const canonicalViewRequested = viewParam === "canonical";
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
    // The view already carries the sidecar's liveness verdict, so no extra
    // `/sessions/:id/active` round-trip is needed on every session open.
    const isBridgeSessionLive =
      bridgedSession !== null && isActiveBridgeSessionView(bridgedSession);

    // Check if session is being controlled by an external program
    const isExternal =
      (deps.externalTracker?.isExternal(sessionId) ?? false) ||
      isBridgeSessionLive;

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

    // Compute maxMessages early so the canonical overlay can window its
    // candidate construction.
    const boundedMaxMessages =
      maxMessages !== undefined && !Number.isNaN(maxMessages) && maxMessages > 0
        ? maxMessages
        : undefined;

    if (
      session &&
      canonicalViewRequested &&
      isCodexProviderName(session.provider) &&
      codexEventStoreSources.length > 0
    ) {
      const canonicalStartedMs = Date.now();
      try {
        const canonicalBudgetMs = 2_000;
        const selectStartedMs = Date.now();
        const selected = await selectCodexEventSourceWithCache(
          codexEventStoreSources,
          sessionId,
          codexProjectionCache,
        );
        const journalReplayMs = Date.now() - selectStartedMs;
        if (selected) {
          let generatedArtifacts: GeneratedArtifactManifest[] = [];
          try {
            generatedArtifacts =
              await generatedArtifactUploadManager.listReplayableGeneratedArtifacts(
                { projectId: project.id, sessionId },
                selected.events,
              );
          } catch {
            // Artifact recovery is fail-closed and must not suppress the rest
            // of the canonical refresh projection.
            getLogger().warn(
              { sessionId },
              "Canonical Codex generated artifacts unavailable on refresh",
            );
          }
          const overlayStartedMs = Date.now();
          const canWindowCanonicalTail =
            boundedMaxMessages !== undefined &&
            afterMessageId === undefined &&
            beforeMessageId === undefined &&
            aroundMessageId === undefined &&
            afterWindowMessageId === undefined &&
            branchId === undefined;
          const overlay = overlayCanonicalCodexSessionMessages(
            sessionId,
            session.messages,
            selected.events,
            {
              appendUnmatched: afterMessageId === undefined,
              ...(afterMessageId === undefined ? {} : { afterMessageId }),
              generatedArtifacts,
              sourceId: selected.sourceId,
              projectionCache: codexProjectionCache,
              startedMs: canonicalStartedMs,
              budgetMs: canonicalBudgetMs,
              ...(!canWindowCanonicalTail
                ? {}
                : { maxCandidateCount: boundedMaxMessages }),
            },
          );
          session = {
            ...session,
            messages: overlay.messages,
            ...(overlay.turnHealth ?? {}),
          };
          getLogger().debug(
            {
              sessionId,
              sourceId: selected.sourceId,
              warm: selected.warm,
              eventCount: overlay.eventCount,
              projectedMessageCount: overlay.projectedMessageCount,
              journalReplayMs,
              overlayMs: Date.now() - overlayStartedMs,
              totalMs: Date.now() - canonicalStartedMs,
              cacheSize: codexProjectionCache.size,
            },
            "Canonical Codex overlay completed",
          );
        }
      } catch (error) {
        const isBudgetExceeded =
          error instanceof CodexOverlayBudgetExceededError;
        // Refresh remains available from the provider rollout if a canonical
        // journal is temporarily unreadable, exceeds its safety bound, or
        // blows the soft time budget.
        getLogger().warn(
          {
            sessionId,
            eventCount:
              error instanceof CodexOverlayBudgetExceededError
                ? error.eventCount
                : undefined,
            budgetExceeded: isBudgetExceeded,
            totalMs: Date.now() - canonicalStartedMs,
          },
          "Canonical Codex session overlay unavailable; using legacy normalization",
        );
      }
    }

    if (
      session &&
      !canonicalViewRequested &&
      afterMessageId === undefined &&
      isCodexProviderName(session.provider) &&
      codexEventStoreSources.length > 0
    ) {
      const errorOverlayStartedMs = Date.now();
      try {
        const selected = await selectCodexProviderErrorEventSource(
          codexEventStoreSources,
          sessionId,
        );
        if (selected) {
          const overlay = overlayCodexProviderErrorMessages(
            sessionId,
            session.messages,
            selected.events,
          );
          session = {
            ...session,
            messages: overlay.messages,
            ...(overlay.turnHealth ?? {}),
          };
          getLogger().debug(
            {
              sessionId,
              sourceId: selected.sourceId,
              eventCount: overlay.eventCount,
              projectedMessageCount: overlay.projectedMessageCount,
              totalMs: Date.now() - errorOverlayStartedMs,
            },
            "Codex provider error overlay completed",
          );
        }
      } catch {
        // The rollout remains the compatibility baseline. A journal read or
        // validation failure must not make the normal session endpoint fail.
        getLogger().warn(
          {
            sessionId,
            totalMs: Date.now() - errorOverlayStartedMs,
          },
          "Codex provider error overlay unavailable; using legacy normalization",
        );
      }
    }

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
      await sessionCommandService.getPendingInput(sessionId, {
        processSnapshot: process,
      });
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
            originChannel: metadata?.originChannel,
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
          ...getSessionPermissionModeState(deps, sessionId, process),
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
            originChannel:
              metadata?.originChannel ?? bridgedSession.session.originChannel,
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
          ...getSessionPermissionModeState(deps, sessionId, process),
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
        originChannel: metadata?.originChannel ?? session.originChannel,
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
      ...getSessionPermissionModeState(deps, sessionId, process),
      ...(paginationInfo && { pagination: paginationInfo }),
    });
  });

  // POST /api/projects/:projectId/sessions - Start new session
  routes.post("/projects/:projectId/sessions", async (c) => {
    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = await sessionCommandService.start({
      projectId: c.req.param("projectId"),
      body,
    });
    return c.json(result.body, result.status);
  });

  // POST /api/projects/:projectId/sessions/create - Create session without
  // starting the agent. This supports the upload-first two-phase flow.
  routes.post("/projects/:projectId/sessions/create", async (c) => {
    let body: CreateSessionBody = {};
    try {
      body = await c.req.json<CreateSessionBody>();
    } catch {
      // Body is optional for this endpoint.
    }

    const result = await sessionCommandService.create({
      projectId: c.req.param("projectId"),
      body,
    });
    return c.json(result.body, result.status);
  });

  // POST /api/projects/:projectId/sessions/:sessionId/resume - Resume session
  routes.post("/projects/:projectId/sessions/:sessionId/resume", async (c) => {
    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = await sessionCommandService.resume({
      projectId: c.req.param("projectId"),
      sessionId: c.req.param("sessionId"),
      body,
    });
    return c.json(result.body, result.status);
  });

  // POST /api/sessions/:sessionId/messages - Queue message
  routes.post("/sessions/:sessionId/messages", async (c) => {
    let body: QueueSessionMessageBody;
    try {
      body = await c.req.json<QueueSessionMessageBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = await sessionCommandService.queue({
      sessionId: c.req.param("sessionId"),
      body,
    });
    return c.json(result.body, result.status);
  });

  // POST /api/sessions/:sessionId/codex-control - Execute a bounded,
  // capability-gated Codex app-server control through the authenticated API.
  routes.post("/sessions/:sessionId/codex-control", async (c) => {
    let request: CodexNativeControlRequest;
    try {
      request = await c.req.json<CodexNativeControlRequest>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (
      !request ||
      typeof request !== "object" ||
      !isCodexNativeControlMethod((request as { control?: unknown }).control)
    ) {
      return c.json({ error: "Supported Codex control is required" }, 400);
    }

    const result = await sessionCommandService.executeCodexControl({
      sessionId: c.req.param("sessionId"),
      request,
    });
    return c.json(result.body, result.status);
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

    if (!isPermissionMode(body.mode)) {
      return c.json({ error: "Invalid or missing permission mode" }, 400);
    }

    const result = await sessionCommandService.setPermissionMode(
      sessionId,
      body.mode,
    );
    return c.json(result.body, result.status);
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

    // Same owner priority as session detail and POST /input: an owned process
    // that reports no pending request must still surface a bridge-held one,
    // otherwise the client polls a null it can never resolve.
    // The snapshot's pendingInputRequest is Process.getPendingInputRequest()
    // (queue head, mock `waiting-input` state included), so no second runtime
    // round-trip is needed here.
    const process =
      await runtimeController.getProcessSnapshotForSession(sessionId);
    const request = await sessionCommandService.getPendingInput(sessionId, {
      processSnapshot: process,
    });

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

    // Parse and validate the body exactly once, before any owner lookup, so
    // the two paths cannot diverge on validation order or error wording.
    let body: SessionInputResponseBody;
    try {
      body = await c.req.json<SessionInputResponseBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const result = await sessionCommandService.respondToInput(sessionId, body);
    return c.json(result.body, result.status);
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
      const isBridgeSessionLive =
        bridgeView !== null && isActiveBridgeSessionView(bridgeView);
      const runtime = deriveSessionRuntime({
        process: activeProcess,
        externalActive:
          (deps.externalTracker?.isExternal(sessionId) ?? false) ||
          isBridgeSessionLive,
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

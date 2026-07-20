/**
 * App-specific types that extend SDK types with runtime/computed fields.
 *
 * These types are used by the client and server to work with messages
 * that may have additional metadata added during processing.
 *
 * Key principle: SDK types (UserEntry, AssistantEntry) represent what's in JSONL files.
 * App types extend these with runtime fields that are computed or added during processing.
 */

import type {
  AssistantEntry,
  SessionEntry,
  SummaryEntry,
  SystemEntry,
  UserEntry,
} from "./claude-sdk-schema/types.js";
import type {
  ContextCompactEvent,
  ContextCumulativeUsage,
} from "./context-status.js";
import type { UrlProjectId } from "./projectId.js";
import type { PermissionMode, ProviderName } from "./types.js";

// =============================================================================
// App Message Extensions
// =============================================================================

/**
 * Content block type for app messages.
 * Loosely typed to preserve all fields from JSONL without stripping.
 */
export interface AppContentBlock {
  type: string;
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  /** Live streaming output preview for a still-running tool (Codex exec). */
  partialOutput?: string;
  // tool_result block
  tool_use_id?: string;
  content?: string | AppContentBlock[];
  is_error?: boolean;
  // Allow any additional fields
  [key: string]: unknown;
}

/**
 * Runtime fields added to messages by our application.
 * These are computed or added during processing, not stored in JSONL.
 *
 * Includes convenience fields added by SessionReader.convertMessage():
 * - id: copied from uuid (or fallback to index-based)
 * - content: copied to top level from message.content
 * - role: added based on message type
 */
export interface AppMessageExtensions {
  /**
   * Message identifier - copied from uuid by SessionReader.
   * Fallback: "msg-{index}" when uuid is not available.
   */
  id?: string;

  /**
   * Message content copied to top level for convenience.
   * Original is in message.content for user/assistant entries.
   */
  content?: string | AppContentBlock[];

  /**
   * Role derived from message type (user/assistant).
   * Added by SessionReader for convenience.
   */
  role?: "user" | "assistant" | "system";

  /**
   * IDs of tool_use blocks that don't have a matching tool_result in the message history.
   * Computed by SessionReader via DAG analysis.
   *
   * NOTE: This is a misnomer. These aren't necessarily "orphaned" (abandoned) - they may be
   * actively pending (awaiting approval or currently executing). The client should check
   * process state to determine if tools are truly orphaned vs just pending.
   *
   * TODO: Consider renaming to `toolUsesWithoutResults` for clarity.
   */
  orphanedToolUseIds?: string[];

  /**
   * Source of this message data.
   * - "sdk": Message came from real-time SDK streaming
   * - "jsonl": Message was read from disk (authoritative)
   */
  _source?: "sdk" | "jsonl";

  /**
   * True if this message is still being streamed (incomplete).
   * Only set during active streaming; cleared when message is complete.
   */
  _isStreaming?: boolean;

  /**
   * True if this message is from a Task subagent.
   * Used for UI grouping and lazy-loading of subagent content.
   */
  isSubagent?: boolean;

  /** Provider-agnostic branch metadata for editable conversation history. */
  branch?: SessionBranchMetadata;

  /** Codex-only compatibility alias for branch metadata. */
  codexBranch?: SessionBranchMetadata;

  /**
   * Context-window usage snapshot for the model request associated with this
   * message. Codex uses this on user prompts to show the turn's input context.
   */
  contextBefore?: ContextUsage;

  /**
   * Codex app-server phase for assistant text, when available.
   * Values map to Codex protocol MessagePhase: "commentary" or "final_answer".
   */
  codexMessagePhase?: "commentary" | "final_answer";

  /**
   * Allow any additional fields from JSONL.
   * This makes the type compatible with pass-through of unknown fields.
   */
  [key: string]: unknown;
}

// =============================================================================
// App Message Types
// =============================================================================

/**
 * User message with app extensions.
 */
export type AppUserMessage = UserEntry & AppMessageExtensions;

/**
 * Assistant message with app extensions.
 */
export type AppAssistantMessage = AssistantEntry & AppMessageExtensions;

/**
 * System message with app extensions.
 */
export type AppSystemMessage = SystemEntry & AppMessageExtensions;

/**
 * Summary message with app extensions.
 */
export type AppSummaryMessage = SummaryEntry & AppMessageExtensions;

/**
 * Any JSONL entry type with app extensions.
 * This is the main message type used throughout the app.
 */
export type AppMessage = (SessionEntry | SummaryEntry) & AppMessageExtensions;

/**
 * Conversation messages only (user/assistant/system).
 * Excludes file_history_snapshot and queue_operation entries.
 */
export type AppConversationMessage =
  | AppUserMessage
  | AppAssistantMessage
  | AppSystemMessage
  | AppSummaryMessage;

// =============================================================================
// Session Types
// =============================================================================

export type SessionCreatedBy = "yep" | "external";

/** Type of pending input request for notification badges */
export type PendingInputType = "tool-approval" | "user-question";

/** Agent activity - what the agent is doing */
export type AgentActivity =
  | "in-turn"
  | "idle"
  | "waiting-input"
  | "hold"
  | "terminated";

export type SessionArchiveBlockCode =
  | "agent_in_turn"
  | "waiting_input"
  | "agent_on_hold"
  | "external_active";

export interface SessionRuntime {
  ownership: SessionOwnership;
  activity?: AgentActivity;
  isBusy: boolean;
  hasResidentWorker: boolean;
  canArchive: boolean;
  archiveBlockCode?: SessionArchiveBlockCode;
  archiveBlockReason?: string;
}

/** Context usage information extracted from the last assistant message */
export interface ContextUsage {
  /** Input tokens used for context-window meter (provider-specific semantics) */
  inputTokens: number;
  /** Percentage of context window used (based on model's context limit) */
  percentage: number;
  /** Context window size used to compute percentage */
  contextWindow?: number;
  /** Output tokens generated in the last response (optional - may not be available) */
  outputTokens?: number;
  /** Cache read tokens (tokens served from cache) */
  cacheReadTokens?: number;
  /** Cache creation tokens (new tokens added to cache) */
  cacheCreationTokens?: number;
}

/**
 * A user-authored prompt/question extracted from the authoritative provider
 * session file. Used by session outline UIs so historical prompts survive
 * message-window pagination and page refreshes.
 */
export interface SessionQuestion {
  /** Message id used for deep-linking to the prompt when it is loaded. */
  id: string;
  /** Compact display text for the prompt. */
  text: string;
  /** Provider timestamp for the user message, when available. */
  timestamp?: string;
}

// =============================================================================
// Model Context Window Mapping
// =============================================================================

/** Default context window size (200K tokens) */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Default context window size for Codex cloud sessions when metadata is missing */
export const CODEX_DEFAULT_CONTEXT_WINDOW = 258_000;
export const CLAUDE_EXTENDED_CONTEXT_WINDOW = 1_000_000;

/**
 * Known context window sizes for different models.
 *
 * Claude models:
 * - Opus / Sonnet / Haiku standard aliases: 200K
 * - Explicit "[1m]" Claude variants: 1M
 * - Sonnet 3.5: 200K
 *
 * Gemini models:
 * - Gemini 2.0/1.5: 1M
 *
 * GPT models:
 * - GPT-4: 128K (varies by variant)
 * - GPT-4o: 128K
 * - GPT-5 / Codex 5.x: ~258K
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude models - 200K context
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  // Gemini models - 1M context
  gemini: 1_000_000,
  // GPT-5 / Codex models - ~258K context
  "gpt-5": CODEX_DEFAULT_CONTEXT_WINDOW,
  codex: CODEX_DEFAULT_CONTEXT_WINDOW,
  // GPT-4 models - 128K context
  "gpt-4": 128_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
};

/** Max context window / output caps for an OpenCode gateway model. */
export interface OpenCodeModelDefaultLimits {
  /** Maximum context window in tokens. */
  context: number;
  /** Maximum output tokens per response. */
  output: number;
}

/**
 * Curated context/output limits for models served through the OpenCode
 * ohmyrouter gateway.
 *
 * This is a LAST-RESORT fallback only. The authoritative windows come from the
 * live catalog: `opencode models --verbose` reports each model's
 * `limit.context`/`limit.output`, and the gateway `/v1/models` catalog reports
 * `context_window`. The OpenCode provider surfaces those real values on
 * `ModelInfo` (see `enrichWithGatewayContextWindows`), and the new-session form
 * prefers them. This table is consulted only when neither live source reports a
 * window (e.g. a custom provider that advertises a zero/blank limit and a model
 * id the gateway doesn't list), so the meter avoids the misleading 200K default.
 *
 * Values sourced from public provider docs / model cards (2026-07). Matched by
 * longest prefix so specific variants win over the family default (e.g.
 * `glm-5.2` → 1M beats `glm-5.1` → 200K). Keep entries lowercase.
 */
const OPENCODE_MODEL_LIMIT_RULES: ReadonlyArray<
  readonly [prefix: string, limits: OpenCodeModelDefaultLimits]
> = [
  // Anthropic Claude — Opus 4.6/4.7/4.8, Sonnet 4.6/5, Fable 5 ship 1M; Haiku 4.5 is 200K.
  ["claude-haiku", { context: 200_000, output: 64_000 }],
  ["claude-opus", { context: 1_000_000, output: 128_000 }],
  ["claude-sonnet-4", { context: 1_000_000, output: 64_000 }],
  ["claude-sonnet-5", { context: 1_000_000, output: 64_000 }],
  ["claude-sonnet", { context: 200_000, output: 64_000 }],
  ["claude-fable", { context: 1_000_000, output: 128_000 }],
  ["claude", { context: 200_000, output: 64_000 }],
  // Google Gemini 2.5 / 3.x — 1,048,576 context, 65,536 output.
  ["gemini", { context: 1_048_576, output: 65_536 }],
  // OpenAI GPT-5.x / Codex.
  ["gpt-5.4-mini", { context: 400_000, output: 128_000 }],
  ["gpt-5.2-codex", { context: 400_000, output: 128_000 }],
  ["gpt-5.3-codex", { context: 400_000, output: 128_000 }],
  ["gpt-5", { context: 1_000_000, output: 128_000 }],
  // ByteDance Doubao Seed 2.x — 256K context, 128K output (all variants).
  ["doubao-seed", { context: 256_000, output: 128_000 }],
  // DeepSeek V4 Pro/Flash — 1M context, 384K output.
  ["deepseek-v4", { context: 1_000_000, output: 384_000 }],
  ["deepseek", { context: 128_000, output: 64_000 }],
  // Zhipu GLM — 5.2 is 1M, 5.1 and earlier are 200K; 131K output.
  ["glm-5.2", { context: 1_000_000, output: 131_072 }],
  ["glm", { context: 200_000, output: 131_072 }],
  // Moonshot Kimi K2.x — 262,144 context.
  ["kimi", { context: 262_144, output: 65_536 }],
  // Alibaba Qwen 3.x — 1M context.
  ["qwen", { context: 1_000_000, output: 65_536 }],
  // MiniMax — M3 is 1M; M2.x approximated at 512K (best-effort).
  ["MiniMax-m3", { context: 1_000_000, output: 131_072 }],
  ["MiniMax-m2", { context: 524_288, output: 65_536 }],
  ["MiniMax", { context: 1_000_000, output: 131_072 }],
  // Xiaomi MiMo v2.5 (best-effort).
  ["mimo", { context: 256_000, output: 65_536 }],
  // MiniMax M2 family (best-effort).
  ["m2-her", { context: 256_000, output: 65_536 }],
  ["m2", { context: 256_000, output: 65_536 }],
];

/**
 * Resolve curated context/output limits for an OpenCode gateway model id.
 * Accepts bare ids ("claude-opus-4-8") or namespaced refs
 * ("yep-anthropic/claude-opus-4-8"); strips any provider prefix and `[..]`
 * suffix before matching. Returns undefined when the model family is unknown.
 */
export function getOpenCodeModelDefaultLimits(
  model: string | undefined,
): OpenCodeModelDefaultLimits | undefined {
  if (!model) return undefined;
  const slash = model.lastIndexOf("/");
  const raw = (slash >= 0 ? model.slice(slash + 1) : model)
    .toLowerCase()
    .replace(/\[.*?\]/g, "");
  let best: OpenCodeModelDefaultLimits | undefined;
  let bestLen = -1;
  for (const [prefix, limits] of OPENCODE_MODEL_LIMIT_RULES) {
    const normalizedPrefix = prefix.toLowerCase();
    if (raw.startsWith(normalizedPrefix) && normalizedPrefix.length > bestLen) {
      best = limits;
      bestLen = normalizedPrefix.length;
    }
  }
  return best;
}

/**
 * Get the context window size for a given model.
 *
 * Parses model IDs like:
 * - "claude-opus-4-5-20251101" → opus → 200K
 * - "claude-opus-4-6[1m]" → opus → 1M
 * - "claude-sonnet-4-20250514" → sonnet → 200K
 * - "sonnet[1m]" → sonnet → 1M
 * - "claude-3-5-sonnet-20241022" → sonnet → 200K
 * - "gemini-2.0-flash-exp" → gemini → 1M
 * - "gpt-4o-2024-08-06" → gpt-4o → 128K
 *
 * @param model - Model ID string (e.g., "claude-opus-4-5-20251101")
 * @param provider - Provider name for fallback defaults when model is missing
 * @returns Context window size in tokens
 */
export function getModelContextWindow(
  model: string | undefined,
  provider?: ProviderName,
): number {
  if (!model) {
    return provider === "codex"
      ? CODEX_DEFAULT_CONTEXT_WINDOW
      : DEFAULT_CONTEXT_WINDOW;
  }

  // OpenCode models resolve their window from the live catalog first (see
  // ModelInfoService, which caches the real `limit.context` reported by
  // `opencode models --verbose` and the gateway `/v1/models` catalog). This
  // curated table is only the offline/last-resort fallback for callers that
  // resolve straight from a model id without a cached window.
  if (provider === "opencode") {
    const limits = getOpenCodeModelDefaultLimits(model);
    if (limits) return limits.context;
  }

  const lowerModel = model.toLowerCase();

  if (lowerModel.includes("[1m]")) {
    return CLAUDE_EXTENDED_CONTEXT_WINDOW;
  }

  // Handle model IDs that may include provider namespace or other prefixes.
  if (lowerModel.includes("gpt-5") || lowerModel.includes("codex")) {
    return CODEX_DEFAULT_CONTEXT_WINDOW;
  }

  // Check for exact prefix matches first (for GPT models)
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lowerModel.startsWith(prefix)) {
      return size;
    }
  }

  // Parse Claude model IDs: claude-{family}-{version} or claude-{version}-{family}
  // Examples: claude-opus-4-5-*, claude-sonnet-4-*, claude-3-5-sonnet-*
  const claudeMatch = lowerModel.match(/claude-(?:(\w+)-\d|(\d+-\d+-)?(\w+))/);
  if (claudeMatch) {
    const family = claudeMatch[1] || claudeMatch[3];
    if (family && MODEL_CONTEXT_WINDOWS[family]) {
      return MODEL_CONTEXT_WINDOWS[family];
    }
  }

  // Check for Gemini models
  if (lowerModel.includes("gemini")) {
    return MODEL_CONTEXT_WINDOWS.gemini ?? DEFAULT_CONTEXT_WINDOW;
  }

  // Provider-level fallback when we don't recognize the model string.
  if (provider === "codex") {
    return CODEX_DEFAULT_CONTEXT_WINDOW;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Bump a known-too-small context window up to the next tier when the
 * recorded usage exceeds it. The Claude Code SDK strips the `[1m]` suffix
 * from the model ID before writing to JSONL, so a 1M-context session shows
 * up as a plain `claude-opus-4-7-thinking-max` — which `getModelContextWindow`
 * scores as 200K. The user then sees their long sessions as >100% full.
 *
 * If `inputTokens` is bigger than `contextWindow`, the original run *must*
 * have used a larger window (the model physically couldn't have ingested
 * more tokens than it can hold). Claude only has one larger tier today
 * (1M), so escalating to that recovers the right denominator.
 *
 * No-op for provider/model combos that don't have a known larger tier (Codex,
 * Gemini, OpenCode); the >100% display there indicates a real limit/config
 * mismatch that the UI should surface instead of hiding.
 */
export function escalateContextWindow(
  contextWindow: number,
  inputTokens: number,
  provider?: ProviderName,
): number {
  if (inputTokens <= contextWindow) return contextWindow;
  if (provider === "codex" || provider === "codex-oss") return contextWindow;
  if (provider === "gemini" || provider === "gemini-acp") return contextWindow;
  if (provider === "opencode") return contextWindow;
  // Default to Claude's 1M tier for Claude and unknown providers.
  return Math.max(contextWindow, CLAUDE_EXTENDED_CONTEXT_WINDOW);
}

/**
 * Session ownership - who controls the session.
 */
export type SessionOwnership =
  | { owner: "none" } // no active process
  | {
      owner: "self";
      processId: string;
      permissionMode?: PermissionMode;
      modeVersion?: number;
    } // we control it
  | { owner: "external" }; // another process owns it

/**
 * Session sandbox policy from Codex turn_context.
 */
export interface SessionSandboxPolicy {
  type: string;
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export interface SessionBranchOption {
  id: string;
  sessionId: string;
  parentId: string | null;
  prompt: string;
  title: string;
  depth: number;
  index: number;
  siblingIndex: number;
  siblingCount: number;
  isActive: boolean;
  createdAt?: string;
  provider?: ProviderName;
}

export interface SessionBranchState {
  sessionId: string;
  activeBranchId: string | null;
  selectedBranchId: string | null;
  provider?: ProviderName;
  branches: SessionBranchOption[];
}

export interface SessionBranchMetadata {
  sessionId: string;
  branchId: string;
  activeBranchId: string | null;
  selectedBranchId: string | null;
  parentId: string | null;
  siblingIndex: number;
  siblingCount: number;
  alternatives: SessionBranchOption[];
}

export type CodexBranchOption = SessionBranchOption;
export type CodexBranchState = SessionBranchState;

/**
 * Recent session entry with enriched data from the server.
 * Session data is looked up server-side to avoid N+1 client requests.
 */
export interface EnrichedRecentEntry {
  sessionId: string;
  projectId: string;
  visitedAt: string;
  // Enriched fields from session/project data
  title: string | null;
  projectName: string;
  provider: ProviderName;
  /** Cumulative token spend across the whole session, when available. */
  cumulativeUsage?: ContextCumulativeUsage;
  /** Number of context compactions recorded in the active session history. */
  compactCount?: number;
  /** Best-effort details for each recorded context compaction. */
  compactEvents?: ContextCompactEvent[];
}

/** Terminal status of a session's most recent turn (bridge/provider-reported). */
export type SessionLastTurnStatus = "completed" | "interrupted" | "failed";

/** Provider retry/backoff state while a turn is being retried (OpenCode). */
export interface SessionRetryStatus {
  attempt?: number;
  message?: string;
  /** Epoch ms of the next retry attempt. */
  next?: number;
  actionLabel?: string;
  actionLink?: string;
}

/**
 * Session summary for list views.
 * Contains metadata without full message content.
 */
export interface AppSessionSummary {
  id: string;
  projectId: UrlProjectId;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userQuestions?: SessionQuestion[];
  ownership: SessionOwnership;
  // Provider field - which AI provider is running this session
  provider: ProviderName;
  /**
   * For provider-native subagent sessions (e.g. OpenCode task/subagent
   * children), the id of the session that spawned this one. Set on the session
   * detail so the UI can link back to the parent. Subagent children are hidden
   * from session lists and shown inline under their parent instead.
   */
  parentSessionId?: string;
  // Model used for this session (resolved, not "default")
  model?: string;
  // Provider-specific reasoning effort for this session (e.g. "max", "xhigh")
  reasoningEffort?: string;
  // Provider-specific service tier / speed label (e.g. "fast")
  serviceTier?: string;
  // Notification fields
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  runtime?: SessionRuntime;
  lastSeenAt?: string;
  hasUnread?: boolean;
  // Metadata fields
  customTitle?: string;
  aiTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  contextUsage?: ContextUsage;
  /** Cumulative token spend across the whole session. */
  cumulativeUsage?: ContextCumulativeUsage;
  /** Number of context compactions recorded in the active session history. */
  compactCount?: number;
  /** Best-effort details for each recorded context compaction. */
  compactEvents?: ContextCompactEvent[];
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Launcher identifier from session metadata (e.g. "Codex Desktop", "yep-anywhere") */
  originator?: string;
  /** Explicit creation owner recorded by Yep metadata. */
  createdBy?: SessionCreatedBy;
  /** CLI version from session metadata (e.g. "0.101.0") */
  cliVersion?: string;
  /** Session source from session metadata (e.g. "vscode", "exec") */
  source?: string;
  /** Approval policy from turn_context (e.g. "never", "on-request") */
  approvalPolicy?: string;
  /** Sandbox policy from turn_context */
  sandboxPolicy?: SessionSandboxPolicy;
  /** Provider-agnostic branch state for sessions with editable DAG/rollback history. */
  branchState?: SessionBranchState;
  /** Codex-only branch state derived from thread_rolled_back markers. */
  codexBranchState?: CodexBranchState;
  /**
   * True when the active branch has messages but no trailing `result` message,
   * indicating the last turn was interrupted (e.g. by a server restart) and the
   * session can be resumed. Only meaningful when ownership is "none" and the
   * session is not externally active.
   */
  interrupted?: boolean;
  /** Terminal status of the most recent turn (bridge-reported). */
  lastTurnStatus?: SessionLastTurnStatus;
  /** Most recent provider error message, if the last turn failed. */
  lastErrorMessage?: string;
  /** Present while the provider is retrying a failed request (OpenCode). */
  retryStatus?: SessionRetryStatus;
}

/**
 * Full session with messages.
 */
export interface AppSession extends AppSessionSummary {
  messages: AppMessage[];
}

// =============================================================================
// Agent Session Types (for Task subagents)
// =============================================================================

/** Status of an agent session, inferred from its messages */
export type AgentStatus = "pending" | "running" | "completed" | "failed";

/**
 * Agent session content returned by getAgentSession API.
 * Used for lazy-loading completed Task subagent content.
 */
export interface AgentSession {
  messages: AppMessage[];
  status: AgentStatus;
}

// =============================================================================
// Input Request Types
// =============================================================================

/**
 * Input request for tool approval or user questions.
 */
export interface InputRequest {
  id: string;
  sessionId: string;
  type: "tool-approval" | "question" | "choice";
  prompt: string;
  options?: string[];
  toolName?: string;
  toolInput?: unknown;
  timestamp: string;
  /**
   * Where the request came from. Persisted requests are reconstructed from a
   * provider JSONL owned by another process, so they are display-only.
   */
  source?: "process" | "codex-bridge" | "opencode-bridge" | "persisted";
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a message is a user entry.
 */
export function isUserMessage(msg: AppMessage): msg is AppUserMessage {
  return msg.type === "user";
}

/**
 * Check if a message is an assistant entry.
 */
export function isAssistantMessage(
  msg: AppMessage,
): msg is AppAssistantMessage {
  return msg.type === "assistant";
}

/**
 * Check if a message is a system entry.
 */
export function isSystemMessage(msg: AppMessage): msg is AppSystemMessage {
  return msg.type === "system";
}

/**
 * Check if a message is a summary entry.
 */
export function isSummaryMessage(msg: AppMessage): msg is AppSummaryMessage {
  return msg.type === "summary";
}

/**
 * Check if a message is a conversation message (user/assistant/system/summary).
 */
export function isConversationMessage(
  msg: AppMessage,
): msg is AppConversationMessage {
  return (
    msg.type === "user" ||
    msg.type === "assistant" ||
    msg.type === "system" ||
    msg.type === "summary"
  );
}

// =============================================================================
// Connected Browser Types
// =============================================================================

/**
 * Information about a connected browser profile.
 */
export interface ConnectionInfo {
  /** Unique identifier for the browser profile */
  browserProfileId: string;
  /** Number of active tabs/connections from this browser profile */
  connectionCount: number;
  /** ISO timestamp of the first connection from this browser profile */
  connectedAt: string;
  /** Optional friendly name for the device (from push subscription) */
  deviceName?: string;
}

/**
 * Response from GET /api/connections endpoint.
 */
export interface ConnectionsResponse {
  connections: ConnectionInfo[];
}

// =============================================================================
// Browser Profile Origin Tracking
// =============================================================================

/**
 * Origin information for a browser profile connection.
 * Tracks where a browser profile has connected from.
 */
export interface BrowserProfileOrigin {
  /** Full origin string (e.g., "https://localhost:3400") */
  origin: string;
  /** URL scheme (e.g., "https", "http") */
  scheme: string;
  /** Hostname without port (e.g., "localhost", "phone.tailnet") */
  hostname: string;
  /** Port number, or null if default port */
  port: number | null;
  /** User agent string for browser identification */
  userAgent: string;
  /** ISO timestamp of first connection from this origin */
  firstSeen: string;
  /** ISO timestamp of most recent connection from this origin */
  lastSeen: string;
}

/**
 * Browser profile information with origin tracking.
 * Persisted server-side to track device connections.
 */
export interface BrowserProfileInfo {
  /** Unique browser profile identifier */
  browserProfileId: string;
  /** All origins this profile has connected from */
  origins: BrowserProfileOrigin[];
  /** ISO timestamp when this profile was first seen */
  createdAt: string;
  /** ISO timestamp of most recent activity */
  lastActiveAt: string;
  /** Optional friendly name (from push subscription) */
  deviceName?: string;
}

/**
 * Response from GET /api/browser-profiles endpoint.
 */
export interface BrowserProfilesResponse {
  profiles: BrowserProfileInfo[];
}

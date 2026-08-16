// Provider abstraction types for multi-provider support
import type {
  CodexMcpMode,
  ContextStatusSdkPayload,
  ModelInfo,
  OpenCodeSessionConfig,
  PermissionMode,
  SlashCommand,
} from "@yep-anywhere/shared";
import type { MessageQueue } from "../messageQueue.js";
import type { CanUseTool, SDKMessage, UserMessage } from "../types.js";
import type { CodexSessionControls } from "./codex-controls.js";

/**
 * Provider names - extensible for future providers.
 */
export type ProviderName =
  | "claude"
  | "claude-ollama"
  | "codex"
  | "codex-oss"
  | "gemini"
  | "gemini-acp"
  | "opencode"
  | "pi"
  | "kimi"
  | "zcode";

/**
 * Authentication status for a provider.
 */
export interface AuthStatus {
  /** Whether the provider is installed/available */
  installed: boolean;
  /** Whether the provider is authenticated */
  authenticated: boolean;
  /** Whether auth is enabled (e.g., ANTHROPIC_API_KEY is set) */
  enabled: boolean;
  /** When authentication expires (if applicable) */
  expiresAt?: Date;
  /** User info if available */
  user?: { email?: string; name?: string };
}

/**
 * Options for starting a new agent session.
 */
export interface StartSessionOptions {
  /** Correlates provider startup logs for one create/resume attempt. */
  startupId?: string;
  /** Working directory for the session */
  cwd: string;
  /** Initial message to send (optional - session can wait for message) */
  initialMessage?: UserMessage;
  /** Session ID to resume (optional) */
  resumeSessionId?: string;
  /**
   * Internal provenance proof that `resumeSessionId` came from a create-only
   * Codex process which never accepted a user turn. Only that narrow case may
   * replace an exact `no rollout found` response with a fresh thread.
   */
  allowMissingRolloutReplacement?: boolean;
  /**
   * Provider-native edit boundary used with resumeSessionId. Claude resumes
   * through the supplied ancestor UUID; OpenCode and Pi fork before the
   * supplied native user message ID. Maps to the provider's
   * `resumeSessionAt` option.
   */
  resumeSessionAt?: string;
  /**
   * Legacy wire name for the number of trailing source turns excluded by a
   * source-preserving Codex edit fork. The provider creates a new thread with
   * stable `thread/fork.lastTurnId` (or a fresh thread for the first prompt)
   * and never mutates the source thread.
   */
  rollbackNumTurns?: number;
  /** Permission mode for tool approvals */
  permissionMode?: PermissionMode;
  /** Model to use (e.g., "sonnet", "opus", "haiku") */
  model?: string;
  /** Thinking configuration (undefined = thinking disabled) */
  thinking?: import("@yep-anywhere/shared").ThinkingConfig;
  /** Effort level for response quality (undefined = SDK default) */
  effort?: import("@yep-anywhere/shared").EffortLevel;
  /** Exact provider reasoning effort / OpenCode model variant. */
  reasoningEffort?: string;
  /** Codex MCP profile. Only consumed by the Codex provider. */
  codexMcpMode?: CodexMcpMode;
  /** Codex model source (Codex `model_provider`). Only consumed by Codex. */
  codexModelProvider?: string;
  /** Optional stable account key for per-account Codex event-spine rollout. */
  codexEventAccountId?: string;
  /** Optional stable project key recorded on canonical Codex event envelopes. */
  codexEventProjectId?: string;
  /** Managed provider/model configuration consumed by OpenCode and Pi. */
  opencodeConfig?: OpenCodeSessionConfig;
  /** Tool approval callback */
  onToolApproval?: CanUseTool;
  /** Configured SSH host for Claude remote execution. */
  executor?: string;
  /** Global instructions to append to system prompt (from server settings) */
  globalInstructions?: string;
}

/**
 * Result of starting an agent session.
 * This is the common interface all providers must return.
 */
export interface AgentSession {
  /** Async iterator yielding SDK messages */
  iterator: AsyncIterableIterator<SDKMessage>;
  /** Message queue for sending messages to the agent */
  queue: MessageQueue;
  /** Abort function to cancel the session */
  abort: () => void;
  /** Check if the underlying CLI process is still alive (undefined = not available) */
  isProcessAlive?: () => boolean;
  /** OS PID of the spawned agent child process (undefined if not available) */
  pid?: number | (() => number | undefined);
  /** Session ID if available immediately (some providers provide later via messages) */
  sessionId?: string;
  /**
   * Steer an active turn with additional user input.
   * A structured result can carry the provider-native turn accepted by the
   * steer operation. Boolean results remain supported for providers without a
   * stable turn identity.
   */
  steer?: (message: UserMessage) => Promise<AgentSteerResult>;
  /** Stable, capability-gated Codex app-server controls for this session. */
  codexControls?: CodexSessionControls;
  /**
   * Change max thinking tokens without restarting the session.
   * Pass null to disable thinking mode.
   * Only supported by Claude SDK 0.2.7+.
   */
  setMaxThinkingTokens?: (tokens: number | null) => Promise<void>;
  /**
   * Interrupt the current turn gracefully without killing the process.
   * The query will stop processing the current turn and return control.
   * Only supported by Claude SDK 0.2.7+.
   */
  interrupt?: () => Promise<void>;
  /**
   * Get the list of available models from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   */
  supportedModels?: () => Promise<ModelInfo[]>;
  /**
   * Get the list of available slash commands (skills) from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   */
  supportedCommands?: () => Promise<SlashCommand[]>;
  /**
   * Change the model mid-session without restarting.
   * Only supported by Claude SDK 0.2.7+.
   */
  setModel?: (model?: string) => Promise<void>;
  /**
   * Change the provider-native permission/session mode without restarting.
   * Providers that do not expose a native mode API may omit this.
   */
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  /**
   * Trigger a provider-native context compaction for this session
   * (e.g. ZCode `session/compact`). Providers without a compact capability
   * omit this.
   */
  compact?: () => Promise<void>;
  /**
   * Change the provider-native reasoning effort / thought level mid-session
   * (e.g. ZCode `session/setThoughtLevel`). Providers without a mid-session
   * level API omit this. Implementations must fail closed when the level is
   * not supported by the session's current model.
   */
  setReasoningEffort?: (effort: string) => Promise<void>;
  /**
   * Read the provider-native session goal status (e.g. ZCode
   * `session/goal {action: "show"}`). The `response` field is the
   * provider-rendered status text.
   */
  getGoal?: () => Promise<import("@yep-anywhere/shared").ProviderGoalState>;
  /**
   * Run a provider-native goal lifecycle action. `set`/`replace` require an
   * objective and may start a model turn immediately (startedTurn) — that is
   * the intended behavior of an explicit user action.
   */
  goalAction?: (
    action: import("@yep-anywhere/shared").ProviderGoalAction,
    objective?: string,
  ) => Promise<import("@yep-anywhere/shared").ProviderGoalState>;
  /**
   * Live context-window breakdown: how many tokens system prompt, tools,
   * skills, MCP servers, memory files, etc. each consume.
   * Returns null if the provider/SDK does not support it.
   * Only supported by Claude SDK 0.2.7+.
   */
  getContextUsage?: () => Promise<ContextStatusSdkPayload | null>;
  /**
   * Probe the SDK for its initialization result. Used to learn the real
   * context window of the resolved model on startup (before any result
   * message arrives). Returns null if the provider/SDK does not support it.
   * Only supported by Claude SDK 0.2.7+.
   */
  initializationResult?: () => Promise<{
    models: Array<{ id: string; contextWindow?: number }>;
  } | null>;
}

export type AgentSteerResult =
  | boolean
  | {
      accepted: boolean;
      turnId?: string;
    };

/**
 * Agent provider interface.
 * All providers (Claude, Codex, Gemini, local) implement this interface.
 */
export interface AgentProvider {
  /** Provider identifier */
  readonly name: ProviderName;
  /** Human-readable display name */
  readonly displayName: string;
  /** Whether this provider supports permission modes (default: true) */
  readonly supportsPermissionMode: boolean;
  /** Non-empty permission modes with distinct provider behavior. */
  readonly permissionModes?: readonly PermissionMode[];
  /** Whether this provider supports extended thinking toggle (default: true) */
  readonly supportsThinkingToggle: boolean;
  /** Whether this provider supports slash commands (default: false) */
  readonly supportsSlashCommands: boolean;

  /**
   * Check if this provider is installed and available.
   * For SDK-based providers, this is always true.
   * For CLI-based providers, this checks if the binary exists.
   */
  isInstalled(): Promise<boolean>;

  /**
   * Check if this provider is authenticated.
   * Returns true if the provider can be used immediately.
   */
  isAuthenticated(): Promise<boolean>;

  /**
   * Get detailed authentication status.
   */
  getAuthStatus(): Promise<AuthStatus>;

  /**
   * Start a new agent session.
   * Returns the session iterator, message queue, and abort function.
   */
  startSession(options: StartSessionOptions): Promise<AgentSession>;

  /**
   * Get available models for this provider.
   * For local providers (Codex with Ollama), this queries the local model list.
   * For cloud providers (Claude, Gemini), this returns a static list.
   *
   * Listing endpoints may set `waitForRefresh` to false so providers backed by
   * a slow remote catalog can return cached or fallback metadata immediately
   * and refresh it in the background.
   */
  getAvailableModels(options?: {
    waitForRefresh?: boolean;
  }): Promise<ModelInfo[]>;

  /**
   * List MCP server statuses for a workspace, when the provider can report
   * them. Read-only introspection: providers must never open MCP connections
   * here. Unsupported providers simply omit this method.
   */
  listMcpServers?(
    cwd: string,
  ): Promise<
    Record<string, import("@yep-anywhere/shared").ProviderMcpServerStatus>
  >;
}

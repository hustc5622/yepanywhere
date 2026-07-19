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
  | "opencode";

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
   * Provider-native edit boundary used with resumeSessionId. Claude resumes
   * through the supplied ancestor UUID; OpenCode forks before the supplied
   * native user message ID. Maps to the provider's `resumeSessionAt` option.
   */
  resumeSessionAt?: string;
  /**
   * Drop this many trailing user turns before continuing the same provider
   * session. Currently used by Codex app-server `thread/rollback`; other
   * providers should ignore it unless they expose equivalent same-thread
   * history control.
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
  /** Managed provider/model configuration consumed by OpenCode. */
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
   * Returns true when steered immediately, false when caller should enqueue instead.
   */
  steer?: (message: UserMessage) => Promise<boolean>;
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
   */
  getAvailableModels(): Promise<ModelInfo[]>;
}

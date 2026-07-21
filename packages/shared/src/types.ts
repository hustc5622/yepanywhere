/**
 * Provider name - which AI agent provider to use.
 * - "claude": Claude Code CLI running through a configured SSH executor
 * - "codex": OpenAI Codex via SDK (cloud models)
 * - "codex-oss": Codex via CLI with --oss (local models via Ollama)
 * - "gemini": Google Gemini via CLI
 * - "opencode": OpenCode via HTTP server (multi-provider agent)
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
 * All provider names in display order.
 * Used for filter dropdowns, iteration, etc.
 * Keep in sync with ProviderName type above.
 */
export const ALL_PROVIDERS: readonly ProviderName[] = [
  "claude",
  "claude-ollama",
  "codex",
  "codex-oss",
  "gemini",
  "gemini-acp",
  "opencode",
] as const;

/**
 * The default provider when none is specified.
 * Used when a new session does not explicitly select a provider.
 */
export const DEFAULT_PROVIDER: ProviderName = "codex";

export type RemoteSessionStorageMode = "shared" | "ssh-replica";

/**
 * How a remote Claude executor exposes its JSONL transcripts to Yep.
 *
 * `shared` means Claude writes directly into a filesystem visible to both
 * machines. `ssh-replica` keeps the compatibility path that pulls the remote
 * JSONL over SSH after every turn.
 */
export interface RemoteSessionStorageConfig {
  mode: RemoteSessionStorageMode;
  /** Local/Yep view of Claude's projects directory (required for shared). */
  localProjectsDir?: string;
  /** Remote/Claude view of the same projects directory (required for shared). */
  remoteProjectsDir?: string;
}

/**
 * SSH executor used by the Claude provider.
 *
 * Claude runs inside the remote machine, while Yep and the project catalog
 * remain on the local machine. `localRoot` and `remoteRoot` describe the same
 * shared directory as seen from each side.
 */
export interface RemoteExecutorConfig {
  /** SSH config alias or hostname/IP address. */
  host: string;
  /** Optional SSH user. Prefer this over embedding `user@` in host. */
  user?: string;
  /** Optional SSH port (defaults to 22). */
  port?: number;
  /** Absolute shared-directory root on the Yep host. */
  localRoot: string;
  /** Absolute shared-directory mount root inside the remote machine. */
  remoteRoot: string;
  /** Absolute remote Claude executable path; login-shell `claude` when omitted. */
  claudePath?: string;
  /** Optional remote Claude config root (sets CLAUDE_CONFIG_DIR). */
  remoteClaudeConfigDir?: string;
  /** Optional remote projects/session root; defaults to config-dir/projects or ~/.claude/projects. */
  remoteSessionsDir?: string;
  /** Transcript storage strategy. Omitted legacy configs use ssh-replica. */
  sessionStorage?: RemoteSessionStorageConfig;
}

/**
 * Model information for a provider.
 */
export interface ReasoningEffortInfo {
  reasoningEffort: string;
  description?: string;
}

export interface ModelInfo {
  /** Model identifier (e.g., "sonnet", "qwen2.5-coder:0.5b") */
  id: string;
  /** Canonical provider model id resolved from an alias, when available. */
  resolvedModel?: string;
  /** Human-readable name */
  name: string;
  /** Description of the model's capabilities (optional) */
  description?: string;
  /** Reasoning efforts advertised by the provider, in picker display order. */
  supportedReasoningEfforts?: ReasoningEffortInfo[];
  /** OpenCode reasoning efforts keyed by the request protocol used upstream. */
  supportedReasoningEffortsByProtocol?: Partial<
    Record<OpenCodeRequestProtocol, ReasoningEffortInfo[]>
  >;
  /** Provider-recommended reasoning effort for this model. */
  defaultReasoningEffort?: string;
  /** Whether the provider reports named effort controls for this model. */
  supportsEffort?: boolean;
  /** Whether the model supports provider-managed adaptive thinking. */
  supportsAdaptiveThinking?: boolean;
  /** Whether the model supports the provider's fast service mode. */
  supportsFastMode?: boolean;
  /** Whether the model supports the provider's automatic model mode. */
  supportsAutoMode?: boolean;
  /** Model size in bytes (for local models) */
  size?: number;
  /** Context window size in tokens (for local models) */
  contextWindow?: number;
  /** Maximum output tokens the model can generate in one response, when known. */
  maxOutputTokens?: number;
  /** Parameter count string, e.g. "30.5B" (for local models) */
  parameterSize?: string;
  /** Base model this preset was derived from, e.g. "qwen3-coder:30b" */
  parentModel?: string;
  /** Quantization level, e.g. "Q4_K_M" */
  quantizationLevel?: string;
  /** Request protocols exposed for this model by an OpenCode gateway. */
  supportedRequestProtocols?: OpenCodeRequestProtocol[];
  /** Upstream owner reported by a model gateway. */
  ownedBy?: string;
}

/**
 * Protocol used by the generated per-session OpenCode provider.
 */
export type OpenCodeRequestProtocol = "openai-compatible" | "anthropic";

export const ALL_OPENCODE_REQUEST_PROTOCOLS: readonly OpenCodeRequestProtocol[] =
  ["openai-compatible", "anthropic"] as const;

export interface OpenCodeModelLimits {
  /** Maximum context window in tokens */
  context: number;
  /** Maximum input tokens, when it differs from the total context window. */
  input?: number;
  /** Maximum output tokens */
  output: number;
}

export type OpenCodeJsonValue =
  | string
  | number
  | boolean
  | null
  | OpenCodeJsonValue[]
  | { [key: string]: OpenCodeJsonValue };

export type OpenCodeJsonObject = Record<string, OpenCodeJsonValue>;

export interface OpenCodeModelCapabilities {
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  toolCall?: boolean;
}

/**
 * Full configuration for a managed OpenCode session.
 *
 * The browser selects an upstream model and request protocol. Yep then creates
 * an isolated OpenCode provider/model entry before spawning `opencode serve`,
 * so one global OpenCode config never has to pretend a model only supports one
 * API shape. Credentials and the gateway base URL remain server-owned.
 */
export interface OpenCodeSessionConfig {
  /** Upstream model ID as returned by the gateway's /v1/models endpoint. */
  model: string;
  requestProtocol: OpenCodeRequestProtocol;
  /** Optional display name used in OpenCode's model catalog. */
  name?: string;
  limits?: OpenCodeModelLimits;
  capabilities?: OpenCodeModelCapabilities;
  /** OpenCode provider/model patches for fields not yet modeled by Yep's UI. */
  advanced?: {
    provider?: OpenCodeJsonObject;
    model?: OpenCodeJsonObject;
  };
}

/**
 * Slash command (skill) available in a session.
 */
export interface SlashCommand {
  /** Command name without leading slash (e.g., "commit", "review-pr") */
  name: string;
  /** Description of what the command does */
  description: string;
  /** Hint for command arguments (e.g., "<file>") */
  argumentHint?: string;
}

/**
 * Provider info for UI display.
 */
export interface ProviderInfo {
  name: ProviderName;
  displayName: string;
  installed: boolean;
  authenticated: boolean;
  enabled: boolean;
  expiresAt?: string;
  user?: { email?: string; name?: string };
  /** Available models for this provider */
  models?: ModelInfo[];
  /** Provider's current CLI/default model, when discoverable */
  currentModel?: string;
  /** Provider's current CLI/default effort level, when discoverable */
  currentEffortLevel?: EffortLevel;
  /** Whether this provider supports permission modes (default: true for backward compat) */
  supportsPermissionMode?: boolean;
  /**
   * Non-empty permission modes with distinct behavior for this provider.
   * Providers should omit aliases that resolve to the same underlying policy.
   */
  permissionModes?: readonly PermissionMode[];
  /** Whether this provider supports extended thinking toggle (default: true for backward compat) */
  supportsThinkingToggle?: boolean;
  /** Whether this provider supports slash commands (default: false) */
  supportsSlashCommands?: boolean;
}

/**
 * Canonical permission mode values. Providers map these to their native
 * approval/sandbox systems and advertise only distinct choices through
 * `ProviderInfo.permissionModes`.
 * - "auto": Use Claude Code's classifier to approve/deny permission prompts
 * - "default": Auto-approve read-only tools (Read, Glob, Grep, etc.), ask for mutating tools
 * - "acceptEdits": Auto-approve file editing tools (Edit, Write, NotebookEdit), ask for others
 * - "plan": Auto-approve read-only tools, ask for others (planning/analysis mode)
 * - "bypassPermissions": Auto-approve all tools (full autonomous mode)
 */
export type PermissionMode =
  | "auto"
  | "default"
  | "bypassPermissions"
  | "acceptEdits"
  | "plan";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

/**
 * All permission modes in canonical order.
 * Used for validation, dropdowns, and iteration.
 * Keep in sync with PermissionMode above.
 */
export const ALL_PERMISSION_MODES: readonly PermissionMode[] = [
  "auto",
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const;

/**
 * Codex MCP profile for app-server-backed sessions.
 * - "clear": Matches `cf -clear` profile (apps/plugins disabled, MCP disabled).
 * - "standard": Matches `cf` light profile (apps/plugins disabled).
 * - "full": Matches `cf -mcp` full profile (load all configured MCP/apps/plugins).
 */
export type CodexMcpMode = "clear" | "standard" | "full";

/**
 * All Codex MCP modes in canonical order.
 */
export const ALL_CODEX_MCP_MODES: readonly CodexMcpMode[] = [
  "clear",
  "standard",
  "full",
] as const;

/**
 * Saved defaults for the new session form.
 */
export interface NewSessionDefaults {
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingOption;
  /** Exact provider reasoning effort / OpenCode model variant. */
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  codexMcpMode?: CodexMcpMode;
  /** OpenCode-only managed provider/model configuration. */
  opencodeConfig?: OpenCodeSessionConfig;
}

/**
 * Model option for Claude sessions.
 * - "default": Use Yep's advertised Claude default (Sonnet 5)
 * - "best": Use Claude Code's best available model alias
 * - "sonnet": Claude Sonnet
 * - "sonnet[1m]": Claude Sonnet with 1M context when available
 * - "claude-fable-5[1m]": Claude Fable 5 with its advertised 1M context
 * - "opus": Claude Opus
 * - "opus[1m]": Claude Opus with 1M context when available
 * - "haiku": Claude Haiku
 * - "opusplan": Plan with Opus, execute with Sonnet
 */
export type ModelOption =
  | "default"
  | "best"
  | "sonnet"
  | "sonnet[1m]"
  | "claude-fable-5[1m]"
  | "opus"
  | "opus[1m]"
  | "haiku"
  | "opusplan";

/**
 * The logical default selection token.
 */
export const DEFAULT_MODEL: ModelOption = "default";

/**
 * Resolve a saved model option for picker matching. The server performs the
 * provider-specific execution mapping for the logical "default" token.
 */
export function resolveModel(
  model: ModelOption | undefined,
): string | undefined {
  return model === "default" || !model ? undefined : model;
}

/**
 * Effort level for Claude's response quality.
 * Maps to the SDK's effort parameter.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Thinking mode for the 3-way toggle.
 * - "off": Thinking disabled
 * - "auto": Model decides when to think (adaptive)
 * - "on": Always think (forced)
 */
export type ThinkingMode = "off" | "auto" | "on";

/**
 * Thinking + effort option sent from client to server.
 * Wire format (backward compatible):
 * - "off": Thinking disabled
 * - "auto": Adaptive thinking, no effort override
 * - "on:low" | "on:medium" | "on:high" | "on:xhigh" | "on:max": Forced-on thinking at effort level
 * - EffortLevel (plain): Adaptive thinking with effort (backward compat with old clients)
 */
export type ThinkingOption = "off" | "auto" | `on:${EffortLevel}` | EffortLevel;

/**
 * Thinking configuration for the SDK.
 */
export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens?: number }
  | { type: "disabled" };

/**
 * Convert thinking option to SDK thinking config + effort level.
 * On Opus 4.6+, "enabled" type is for older models and crashes the CLI.
 * Instead, "on" mode uses adaptive + explicit effort level.
 */
export function thinkingOptionToConfig(option: ThinkingOption): {
  thinking: ThinkingConfig;
  effort?: EffortLevel;
} {
  if (option === "off") {
    return { thinking: { type: "disabled" } };
  }
  if (option === "auto") {
    return { thinking: { type: "adaptive" } };
  }
  // "on:high" etc. = adaptive thinking with explicit effort level
  if (option.startsWith("on:")) {
    const effort = option.slice(3) as EffortLevel;
    return { thinking: { type: "adaptive" }, effort };
  }
  // Plain EffortLevel = adaptive + effort (backward compat with old clients)
  return { thinking: { type: "adaptive" }, effort: option as EffortLevel };
}

/**
 * Session ownership - who controls the session.
 * - "none": No active process
 * - "self": Process is running and owned by this server
 * - "external": Session is being controlled by an external program
 */
export type SessionOwnership =
  | { owner: "none" }
  | {
      owner: "self";
      processId: string;
      permissionMode?: PermissionMode;
      modeVersion?: number;
    }
  | { owner: "external" };

/**
 * Metadata about a file in a project.
 */
export interface FileMetadata {
  /** File path relative to project root */
  path: string;
  /** Absolute local filesystem path */
  absolutePath?: string;
  /** File size in bytes */
  size: number;
  /** MIME type (e.g., "text/typescript", "image/png") */
  mimeType: string;
  /** Whether the file is a text file (can be displayed inline) */
  isText: boolean;
}

/**
 * Response from the file content API.
 */
export interface FileContentResponse {
  /** File metadata */
  metadata: FileMetadata;
  /** File content (only for text files under size limit) */
  content?: string;
  /** URL to fetch raw file content */
  rawUrl: string;
  /** Syntax-highlighted HTML (when highlight=true and language is supported) */
  highlightedHtml?: string;
  /** Language used for highlighting */
  highlightedLanguage?: string;
  /** Whether the file was truncated for highlighting */
  highlightedTruncated?: boolean;
  /** Rendered markdown HTML (for .md files when highlight=true) */
  renderedMarkdownHtml?: string;
}

export type ReportDocumentKind = "markdown" | "text" | "transcript";

/**
 * Report document surfaced by the Reports page.
 */
export interface ReportDocument {
  /** Path relative to the configured reports directory */
  path: string;
  /** Absolute local filesystem path */
  absolutePath: string;
  /** Display title, usually the first H1/H2 in the document */
  title: string;
  /** Report source type */
  kind: ReportDocumentKind;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  modifiedAt: string;
}

/**
 * Response from the report document listing API.
 */
export interface ReportsListResponse {
  /** Configured root directory for report files */
  rootPath: string;
  /** Documents found under the root directory */
  documents: ReportDocument[];
}

/** Stable text selector used to relocate a comment after a report changes. */
export interface ReportCommentAnchor {
  /** Selected plain text in the rendered report. */
  exact: string;
  /** Plain text immediately before the selection. */
  prefix: string;
  /** Plain text immediately after the selection. */
  suffix: string;
  /** UTF-16 offset in the rendered report text when the comment was created. */
  start: number;
  /** Exclusive UTF-16 offset in the rendered report text. */
  end: number;
}

/** A persisted inline comment attached to rendered report text. */
export interface ReportComment {
  id: string;
  /** Report path relative to the configured reports directory. */
  reportPath: string;
  anchor: ReportCommentAnchor;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** Response returned after creating or editing a report comment. */
export interface ReportCommentMutationResponse {
  comment: ReportComment;
}

/**
 * Rendered Markdown report returned by the report document API.
 */
export interface ReportDocumentResponse {
  metadata: ReportDocument;
  /** Raw markdown content */
  content: string;
  /** Server-rendered safe HTML */
  renderedHtml: string;
  /** Inline comments attached to rendered text in this report. */
  comments: ReportComment[];
}

/**
 * Response from uploading a report document.
 */
export interface ReportUploadResponse {
  document: ReportDocument;
}

/** Response from uploading an image asset for a report document. */
export interface ReportImageUploadResponse {
  /** Image path relative to the report document's directory. */
  path: string;
  /** Ready-to-paste Markdown image reference. */
  markdown: string;
  /** Browser URL served by the report image endpoint. */
  url: string;
}

/**
 * A hunk from a unified diff patch.
 * Contains line numbers and the actual diff lines with prefixes.
 */
export interface PatchHunk {
  /** Starting line number in the old file */
  oldStart: number;
  /** Number of lines from old file in this hunk */
  oldLines: number;
  /** Starting line number in the new file */
  newStart: number;
  /** Number of lines in new file in this hunk */
  newLines: number;
  /** Diff lines prefixed with ' ' (context), '-' (removed), or '+' (added) */
  lines: string[];
}

/**
 * Server-computed augment for Edit tool_use blocks.
 * Provides pre-computed structuredPatch and highlighted diff HTML
 * so the client can render consistent unified diffs.
 */
export interface EditAugment {
  /** The tool_use ID this augment is for */
  toolUseId: string;
  /** Augment type discriminator */
  type: "edit";
  /** Computed unified diff with context lines */
  structuredPatch: PatchHunk[];
  /** Syntax-highlighted diff HTML (shiki, CSS variables theme) */
  diffHtml: string;
  /** The file path being edited */
  filePath: string;
}

/**
 * Permission rules for session tool filtering.
 * Patterns like "Bash(curl *)" match tool name + glob against tool input.
 * Evaluation order: deny first, then allow, then fall through to permission mode.
 */
export interface PermissionRules {
  // Patterns to auto-approve (e.g., ["Bash(tsx */browser-cli.ts *)"])
  allow?: string[];
  // Patterns to auto-deny (e.g., ["Bash(curl *)", "Bash(*| bash*)"])
  deny?: string[];
}

/** Answers submitted for an interactive user-question request. */
export type UserQuestionAnswer = string | string[];
export type UserQuestionAnswers = Record<string, UserQuestionAnswer>;

/**
 * Pre-rendered markdown augment for text blocks.
 * Contains HTML with syntax highlighting from server.
 */
export interface MarkdownAugment {
  /** Pre-rendered HTML with shiki syntax highlighting */
  html: string;
}

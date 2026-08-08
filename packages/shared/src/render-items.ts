/**
 * Provider-neutral render model shared by transcript producers and clients.
 *
 * The legacy message pipeline still produces text/thinking/tool_call items.
 * Native provider adapters should prefer the dedicated item variants below so
 * renderer code never has to inspect an opaque provider payload.
 */
import type { GeneratedArtifactManifest } from "./generated-artifact.js";

export type RenderItemLifecycleStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "declined"
  | "cancelled"
  | "unknown";

export interface RenderItemRedaction {
  level: "none" | "partial" | "full";
  hiddenFields?: string[];
  reason?: string;
}

/** Fields common to legacy and native render items. */
export interface RenderItemBase<TSource = unknown> {
  id: string;
  /** Source messages are diagnostics only; renderers must not infer payloads from them. */
  sourceMessages: TSource[];
  isSubagent?: boolean;
  provider?: string;
  threadId?: string;
  turnId?: string;
  providerItemId?: string;
  nativeType?: string;
  /** Provider event lifecycle used to reconcile live and replayed snapshots. */
  providerLifecycle?: "started" | "completed";
  createdAt?: string;
  updatedAt?: string;
  redaction?: RenderItemRedaction;
}

export interface TextItem<TSource = unknown> extends RenderItemBase<TSource> {
  type: "text";
  text: string;
  /** Codex assistant phase; commentary is an explicit model progress update. */
  phase?: "commentary" | "final_answer";
  isStreaming?: boolean;
  augmentHtml?: string;
}

export interface ThinkingItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "thinking";
  thinking: string;
  signature?: string;
  status: "streaming" | "complete";
}

export interface ToolResultData {
  content: string;
  isError: boolean;
  structured?: unknown;
}

export interface ToolCallItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "tool_call";
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: "pending" | "complete" | "error" | "aborted";
  partialOutput?: string;
}

export interface UserPromptItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "user_prompt";
  content: unknown;
}

export interface SessionSetupItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "session_setup";
  title: string;
  prompts: unknown[];
}

export interface SystemItem<TSource = unknown> extends RenderItemBase<TSource> {
  type: "system";
  subtype: "compact_boundary" | "status" | "init" | string;
  content: string;
  status?: "compacting" | null;
}

export interface PlanStep {
  text: string;
  status?: "pending" | "in_progress" | "completed";
}

export interface PlanRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "plan";
  text: string;
  steps?: PlanStep[];
  status: RenderItemLifecycleStatus;
}

export interface ReasoningRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "reasoning";
  /** User-visible summaries supplied by the provider. */
  summary: string[];
  /** Raw reasoning stays separate and may be omitted entirely by policy. */
  content: string[];
  visibility: "summary_only" | "raw_allowed" | "redacted";
  status: RenderItemLifecycleStatus;
}

export interface CommandRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "command";
  command: string;
  cwd?: string;
  processId?: string;
  source?: string;
  pluginId?: string;
  scriptPath?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  status: RenderItemLifecycleStatus;
}

export interface FileChangeRenderEntry {
  path: string;
  kind?: string;
  diff?: string;
}

export interface FileChangeRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "file_change";
  changes: FileChangeRenderEntry[];
  artifacts?: GeneratedArtifactManifest[];
  status: RenderItemLifecycleStatus;
}

export interface McpToolRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "mcp_tool";
  server: string;
  tool: string;
  pluginId?: string;
  appName?: string;
  actionName?: string;
  readOnly?: boolean;
  resultSummary?: string;
  error?: string;
  durationMs?: number;
  status: RenderItemLifecycleStatus;
}

export interface DynamicToolContentItem {
  type: "text" | "image" | "audio" | "unknown";
  text?: string;
  url?: string;
}

export interface DynamicToolRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "dynamic_tool";
  namespace?: string;
  tool: string;
  contentItems: DynamicToolContentItem[];
  success?: boolean;
  durationMs?: number;
  status: RenderItemLifecycleStatus;
}

export interface WebSearchRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "web_search";
  query: string;
  action?: string;
  resultCount?: number;
  status: RenderItemLifecycleStatus;
}

export interface ImageRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "image";
  mode: "view" | "generation";
  path?: string;
  url?: string;
  prompt?: string;
  transparentBackground?: boolean;
  artifacts?: GeneratedArtifactManifest[];
  status: RenderItemLifecycleStatus;
}

export interface HookRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "hook";
  fragments: Array<{ text: string; hookRunId?: string }>;
  status: RenderItemLifecycleStatus;
}

export interface ReviewRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "review";
  phase: "entered" | "exited";
  review: string;
  status: RenderItemLifecycleStatus;
}

export interface SleepRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "sleep";
  durationMs: number;
  status: RenderItemLifecycleStatus;
}

export interface SubAgentRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "subagent";
  activity: string;
  agentThreadIds: string[];
  agentPath?: string;
  senderThreadId?: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  /** Safe lifecycle labels keyed by child thread id; never includes messages. */
  agentStates?: Record<string, string>;
  status: RenderItemLifecycleStatus;
}

export interface CompactionRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "compaction";
  status: RenderItemLifecycleStatus;
}

export type InteractionOperationKind =
  | "command_approval"
  | "file_approval"
  | "permission_approval"
  | "question"
  | "mcp_elicitation"
  | "dynamic_tool"
  | "auth_refresh"
  | "attestation"
  | "current_time"
  | "unknown";

export type InteractionOperationState =
  | "open"
  | "answering"
  | "resolved"
  | "expired"
  | "cancelled"
  | "failed";

export interface NativeDecisionDescriptor {
  id: string;
  label?: string;
  description?: string;
  scope?: "once" | "turn" | "session" | "persistent";
  tone?: "primary" | "neutral" | "danger";
  requiresConfirmation?: boolean;
}

export interface InteractionActorPolicy {
  mode: "requester" | "requester_or_admin" | "session_owner" | "any_member";
  actorIds?: string[];
}

export interface SafeInteractionQuestion {
  id: string;
  title?: string;
  prompt: string;
  type: "single_select" | "multi_select" | "text" | "secret";
  required?: boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
}

export interface SafeInteractionPayload {
  title?: string;
  prompt: string;
  summary?: string;
  toolName?: string;
  cwd?: string;
  command?: string;
  files?: string[];
  /** Only permission category names belong in the public projection. */
  permissions?: string[];
  questions?: SafeInteractionQuestion[];
  details?: Array<{ label: string; value: string }>;
}

export interface InteractionOperation {
  operationId: string;
  provider: string;
  requestId: string;
  requestMethod: string;
  accountId?: string;
  projectId?: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  kind: InteractionOperationKind;
  state: InteractionOperationState;
  publicPayload: SafeInteractionPayload;
  privatePayloadRef?: string;
  allowedActors: InteractionActorPolicy;
  allowedDecisions: NativeDecisionDescriptor[];
  createdAt: number;
  expiresAt?: number;
  resolvedBy?: { id: string; displayName?: string; channel?: string };
  resolution?: { decision: string; summary?: string; resolvedAt?: number };
  version: number;
}

export interface InteractionRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "interaction";
  operation: InteractionOperation;
  status: RenderItemLifecycleStatus;
}

export interface WarningRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "warning";
  title?: string;
  message: string;
  diagnosticId?: string;
  retrying?: boolean;
  /** Structured Codex overload state; renderers localize it without raw errors. */
  retryStatus?: CodexRetryStatus;
  status: RenderItemLifecycleStatus;
}

/** Public, bounded retry metadata shared by the Yep and Feishu projections. */
export interface CodexRetryStatus {
  state: "queued" | "retrying";
  category: "overloaded";
  retryable: true;
  /** The request attempt that received the transient overload response. */
  attempt: number;
  /** The next request attempt that will be made. */
  nextAttempt: number;
  maxAttempts: number;
  retryInMs: number;
}

export interface UnknownRenderItem<TSource = unknown>
  extends RenderItemBase<TSource> {
  type: "unknown";
  originalType: string;
  safeSummary: string;
  status: RenderItemLifecycleStatus;
}

export type NativeRenderItem<TSource = unknown> =
  | PlanRenderItem<TSource>
  | ReasoningRenderItem<TSource>
  | CommandRenderItem<TSource>
  | FileChangeRenderItem<TSource>
  | McpToolRenderItem<TSource>
  | DynamicToolRenderItem<TSource>
  | WebSearchRenderItem<TSource>
  | ImageRenderItem<TSource>
  | HookRenderItem<TSource>
  | ReviewRenderItem<TSource>
  | SleepRenderItem<TSource>
  | SubAgentRenderItem<TSource>
  | CompactionRenderItem<TSource>
  | InteractionRenderItem<TSource>
  | WarningRenderItem<TSource>
  | UnknownRenderItem<TSource>;

export type LegacyRenderItem<TSource = unknown> =
  | TextItem<TSource>
  | ThinkingItem<TSource>
  | ToolCallItem<TSource>
  | UserPromptItem<TSource>
  | SessionSetupItem<TSource>
  | SystemItem<TSource>;

export type RenderItem<TSource = unknown> =
  | LegacyRenderItem<TSource>
  | NativeRenderItem<TSource>;

export const NATIVE_RENDER_ITEM_TYPES = [
  "plan",
  "reasoning",
  "command",
  "file_change",
  "mcp_tool",
  "dynamic_tool",
  "web_search",
  "image",
  "hook",
  "review",
  "sleep",
  "subagent",
  "compaction",
  "interaction",
  "warning",
  "unknown",
] as const satisfies readonly NativeRenderItem["type"][];

export type NativeRenderItemType = (typeof NATIVE_RENDER_ITEM_TYPES)[number];

const NATIVE_RENDER_ITEM_TYPE_SET: ReadonlySet<string> = new Set(
  NATIVE_RENDER_ITEM_TYPES,
);

export function isNativeRenderItemType(
  value: string,
): value is NativeRenderItemType {
  return NATIVE_RENDER_ITEM_TYPE_SET.has(value);
}

/** Stable Codex app-server v2 ThreadItem variants covered by the render selector. */
export const CODEX_THREAD_ITEM_TYPES = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
] as const;

export type CodexThreadItemType = (typeof CODEX_THREAD_ITEM_TYPES)[number];

export type CodexThreadItemRenderPolicy =
  | "user_prompt"
  | "hook"
  | "assistant_message"
  | "plan"
  | "reasoning"
  | "command"
  | "file_change"
  | "mcp_tool"
  | "dynamic_tool"
  | "subagent"
  | "web_search"
  | "image"
  | "sleep"
  | "review"
  | "compaction";

/** Compile-time exhaustive policy: a new generated ThreadItem type must be classified. */
export const CODEX_THREAD_ITEM_RENDER_POLICY = {
  userMessage: "user_prompt",
  hookPrompt: "hook",
  agentMessage: "assistant_message",
  plan: "plan",
  reasoning: "reasoning",
  commandExecution: "command",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool",
  dynamicToolCall: "dynamic_tool",
  collabAgentToolCall: "subagent",
  subAgentActivity: "subagent",
  webSearch: "web_search",
  imageView: "image",
  sleep: "sleep",
  imageGeneration: "image",
  enteredReviewMode: "review",
  exitedReviewMode: "review",
  contextCompaction: "compaction",
} as const satisfies Record<CodexThreadItemType, CodexThreadItemRenderPolicy>;

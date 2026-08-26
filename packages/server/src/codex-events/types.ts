import type { CodexRetryStatus } from "@yep-anywhere/shared";
import type { ThreadItem } from "../sdk/providers/codex-protocol/index.js";

export const CODEX_EVENT_SCHEMA_NAME = "yep.codex-event" as const;
export const CODEX_EVENT_SCHEMA_VERSION = 1 as const;

export type SafeJsonPrimitive = null | boolean | number | string;
export type SafeJsonValue =
  | SafeJsonPrimitive
  | SafeJsonValue[]
  | { [key: string]: SafeJsonValue };
export type SafeJsonObject = { [key: string]: SafeJsonValue };

/**
 * Payloads must be bounded JSON before entering the event spine. This wrapper is a
 * trust-boundary marker; it deliberately does not accept an arbitrary raw
 * JSON-RPC payload without an explicit caller conversion.
 */
export interface SafeCodexPayload {
  safety: "safe";
  data: SafeJsonValue;
  /** Historical count from older journals; new payloads retain plaintext. */
  redactionCount?: number;
  truncated?: boolean;
}

export function safeCodexPayload(data: SafeJsonValue): SafeCodexPayload {
  return { safety: "safe", data };
}

export type CodexProtocolProfile = "stable" | "experimental";

export interface CodexRuntimeIdentity {
  codexVersion: string;
  schemaHash: string;
  profile: CodexProtocolProfile;
  experimentalApi: boolean;
}

export type CodexEventDirection =
  | "client_request"
  | "client_response"
  | "server_request"
  | "server_notification";

export type CodexEventPhase = "observed" | "resolved";
export type CodexCallId = string | number;

export interface CodexEventEnvelope {
  schema: {
    name: typeof CODEX_EVENT_SCHEMA_NAME;
    version: typeof CODEX_EVENT_SCHEMA_VERSION;
  };
  eventId: string;
  dedupeKey?: string;
  provider: "codex";
  runtime: CodexRuntimeIdentity;
  projectId?: string;
  accountId?: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  callId?: CodexCallId;
  requestId?: CodexCallId;
  clientMessageId?: string;
  correlationId: string;
  method: string;
  direction: CodexEventDirection;
  phase: CodexEventPhase;
  appServerEmittedAtMs?: number;
  receivedAtMs: number;
  persistedAtMs: number;
  sequence: number;
  payload: SafeCodexPayload;
  /** Opaque pointer to separately retained raw data; raw bytes never live here. */
  rawRef?: string;
  source: {
    connectionId: string;
    replay: boolean;
  };
}

export type CodexEventDraft = Omit<
  CodexEventEnvelope,
  "persistedAtMs" | "sequence"
>;

export type CodexNativeThreadItemType = ThreadItem["type"];

export const CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE = {
  userMessage: "user_message",
  hookPrompt: "hook_prompt",
  agentMessage: "assistant_message",
  plan: "plan",
  reasoning: "reasoning",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool_call",
  dynamicToolCall: "dynamic_tool_call",
  collabAgentToolCall: "collab_agent_tool_call",
  subAgentActivity: "subagent_activity",
  webSearch: "web_search",
  imageView: "image_view",
  sleep: "sleep",
  imageGeneration: "image_generation",
  enteredReviewMode: "review_entered",
  exitedReviewMode: "review_exited",
  contextCompaction: "context_compaction",
} as const satisfies Record<CodexNativeThreadItemType, string>;

export type CodexCanonicalItemKind =
  (typeof CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE)[CodexNativeThreadItemType];

export type CodexItemLifecycleStatus =
  | "placeholder"
  | "started"
  | "streaming"
  | "completed";

export interface CodexItemStreamState {
  assistantText?: string;
  planText?: string;
  reasoningSummary?: string[];
  reasoningContent?: string[];
  commandOutput?: string;
  fileChangeOutput?: string;
  patchChanges?: SafeJsonValue;
  mcpProgress?: string[];
  terminalInteractions?: Array<{ processId: string }>;
}

export interface CanonicalCodexItemState {
  id: string;
  nativeType: string;
  kind: CodexCanonicalItemKind | "unknown";
  status: CodexItemLifecycleStatus;
  snapshot?: SafeJsonObject;
  stream: CodexItemStreamState;
  startedAtMs?: number;
  completedAtMs?: number;
  firstSequence: number;
  lastSequence: number;
  startedSequence?: number;
  completedSequence?: number;
  lateDeltaCount: number;
}

export type CodexCanonicalTurnStatus =
  | "queued"
  | "in_progress"
  | "waiting_user"
  | "completed"
  | "interrupted"
  | "failed";

export interface CanonicalCodexTurnState {
  id: string;
  threadId: string;
  status: CodexCanonicalTurnStatus;
  items: Record<string, CanonicalCodexItemState>;
  itemOrder: string[];
  plan?: SafeJsonValue;
  /** Event sequence of the latest `turn/plan/updated` snapshot. */
  planSequence?: number;
  diff?: string;
  error?: SafeJsonValue;
  startedAtMs?: number;
  completedAtMs?: number;
  firstSequence: number;
  lastSequence: number;
}

export interface CanonicalCodexThreadState {
  id: string;
  status?: string;
  lifecycle?: "active" | "archived" | "deleted" | "closed";
  turns: Record<string, CanonicalCodexTurnState>;
  turnOrder: string[];
  firstSequence: number;
  lastSequence: number;
  /**
   * Last-known thread goal snapshot. Codex emits `thread/goal/updated` with a
   * full goal snapshot on every mutation and `thread/goal/cleared` on removal;
   * we retain only the latest state so a REST refresh can surface the current
   * objective, status, token budget, and elapsed time without retaining every
   * update as a separate state object.
   */
  goal?: CanonicalCodexThreadGoal;
  /** Event sequence of the last goal mutation (updated or cleared). */
  goalSequence?: number;
  /** Wall-clock time (epoch ms) the last goal mutation occurred. */
  goalUpdatedAtMs?: number;
}

/**
 * Canonical snapshot of a Codex `ThreadGoal`, mirrored from the
 * `thread/goal/updated` notification payload. Fields use the app-server's
 * camelCase wire naming so the projection can pass them through directly.
 *
 * Status values: "active" | "paused" | "blocked" | "usageLimited" |
 * "budgetLimited" | "complete" (see `ThreadGoalStatus` in the app-server
 * protocol, `#[serde(rename_all = "camelCase")]`).
 */
export interface CanonicalCodexThreadGoal {
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexEventObservation {
  eventId: string;
  sequence: number;
  method: string;
  direction: CodexEventDirection;
  classification: string;
}

export interface CanonicalCodexClientRetry extends CodexRetryStatus {
  method: string;
  requestId: CodexCallId;
  clientMessageId?: string;
  threadId?: string;
  sequence: number;
}

export interface UnknownCodexEvent {
  eventId: string;
  sequence: number;
  method: string;
  direction: CodexEventDirection;
  compatibility: "newer_server" | "invalid_payload" | "disabled_experimental";
  payload: SafeCodexPayload;
}

export type CodexEventAnomalyKind =
  | "late_delta"
  | "late_started"
  | "terminal_rewrite_ignored"
  | "missing_identity"
  | "session_mismatch"
  | "out_of_order";

export interface CodexEventAnomaly {
  kind: CodexEventAnomalyKind;
  eventId: string;
  sequence: number;
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
}

export interface CanonicalCodexSessionState {
  schemaVersion: 1;
  sessionId: string;
  lastSequence: number;
  threads: Record<string, CanonicalCodexThreadState>;
  threadOrder: string[];
  observations: CodexEventObservation[];
  /** Safe client-side retry decisions reconstructed identically on replay. */
  clientRetries: CanonicalCodexClientRetry[];
  notificationCounts: Record<string, number>;
  unknownEvents: UnknownCodexEvent[];
  anomalies: CodexEventAnomaly[];
  appliedEventIds: string[];
  appliedDedupeKeys: string[];
}

export function createCanonicalCodexSessionState(
  sessionId: string,
): CanonicalCodexSessionState {
  return {
    schemaVersion: 1,
    sessionId,
    lastSequence: 0,
    threads: {},
    threadOrder: [],
    observations: [],
    clientRetries: [],
    notificationCounts: {},
    unknownEvents: [],
    anomalies: [],
    appliedEventIds: [],
    appliedDedupeKeys: [],
  };
}

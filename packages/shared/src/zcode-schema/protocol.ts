/**
 * ZCode app-server protocol schema (compatibility contract).
 *
 * ZCode Desktop ships a built-in CLI (`zcode.cjs`) that exposes a `app-server`
 * subcommand speaking newline-delimited JSON over stdio.  Unlike Codex
 * (thread/turn/item) ZCode uses workspace/session/interaction methods and
 * delivers a unified `session/event` notification stream.
 *
 * IMPORTANT: The real ZCode CLI 0.16.1 uses a **custom JSON-RPC-style
 * protocol that does NOT include a `jsonrpc` field**.  The message
 * dispatcher classifies messages solely by the presence of `method` and `id`
 * keys.  Outbound messages from the CLI never include `jsonrpc`.  Including
 * `jsonrpc: "2.0"` in outbound requests is tolerated (the dispatcher ignores
 * unknown keys), but Yep must NOT require it in schemas, and SHOULD omit it
 * from outbound messages to match the real protocol shape.
 *
 * All ZCode protocol param schemas use `.strict()` — unexpected keys are
 * rejected with `-32602 Invalid params`.  Yep's outbound requests must
 * therefore include only fields the CLI accepts.
 *
 * This module defines the stable contract surface that Yep relies on:
 *   - Envelope types for request/response/notification/server-request
 *     (no `jsonrpc` field required)
 *   - Method, event, delivery-kind, mode, streaming-kind and error-code
 *     enumerations
 *   - Minimal params/result schemas for the read-only and session methods
 *
 * Unknown event/part types are safely ignored by the normalizer rather than
 * rejecting the entire session.
 *
 * Compatibility baseline: Desktop 3.7.5 / CLI 0.16.1 (2026-08-11).
 * No public protocol stability commitment exists; capability probing and
 * graceful unavailable are mandatory for every integration path.
 */

import { z } from "zod";

// =============================================================================
// Message envelope (no jsonrpc field — matches real CLI 0.16.1)
// =============================================================================

export const ZCodeJsonRpcIdSchema = z.union([z.string(), z.number()]);
export type ZCodeJsonRpcId = z.infer<typeof ZCodeJsonRpcIdSchema>;

export const ZCodeJsonRpcErrorSchema = z
  .object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeJsonRpcError = z.infer<typeof ZCodeJsonRpcErrorSchema>;

/**
 * Client → server request (has both `id` and `method`).
 * The `jsonrpc` field is NOT required by the real CLI and is omitted from
 * outbound messages.  It is allowed (passthrough) if present, for
 * compatibility with any tooling that includes it.
 */
export const ZCodeJsonRpcRequestSchema = z
  .object({
    id: ZCodeJsonRpcIdSchema,
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeJsonRpcRequest = z.infer<typeof ZCodeJsonRpcRequestSchema>;

/** Server → client response (has `id`, no `method`). */
export const ZCodeJsonRpcResponseSchema = z
  .object({
    id: ZCodeJsonRpcIdSchema,
    result: z.unknown().optional(),
    error: ZCodeJsonRpcErrorSchema.optional(),
  })
  .passthrough();
export type ZCodeJsonRpcResponse = z.infer<typeof ZCodeJsonRpcResponseSchema>;

/** Server → client notification (has `method`, no `id`). */
export const ZCodeJsonRpcNotificationSchema = z
  .object({
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeJsonRpcNotification = z.infer<
  typeof ZCodeJsonRpcNotificationSchema
>;

/** Server → client request (has both `id` and `method`). */
export const ZCodeJsonRpcServerRequestSchema = z
  .object({
    id: ZCodeJsonRpcIdSchema,
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeJsonRpcServerRequest = z.infer<
  typeof ZCodeJsonRpcServerRequestSchema
>;

// =============================================================================
// Method names
// =============================================================================

export const ZCodeMethodSchema = z.enum([
  // workspace
  "workspace/readState",
  "workspace/updateProviderRegistry",
  "workspace/setDefaultMode",
  "workspace/setDefaultModel",
  "workspace/setDefaultThoughtLevel",
  "workspace/updateInteractionPreferences",
  // session
  "session/create",
  "session/resume",
  "session/list",
  "session/read",
  "session/messages",
  "session/events",
  "session/subscribe",
  "session/send",
  "session/stop",
  "session/close",
  "session/setModel",
  "session/setMode",
  "session/setThoughtLevel",
  "session/updateRuntimeModelConfig",
  "session/compact",
  "session/fork",
  "session/goal",
  "session/subagents",
  "session/cancelBackgroundTask",
  "session/usage",
  // usage
  "usage/stats",
  // interaction (server → client)
  "interaction/requestPermission",
  "interaction/requestUserInput",
  "interaction/requestProviderRuntimeHeaders",
  "interaction/browserList",
  "interaction/browserExecute",
  // mcp
  "mcp/list",
]);
export type ZCodeMethod = z.infer<typeof ZCodeMethodSchema>;

// =============================================================================
// Event names (delivered via session/event notification)
// =============================================================================

export const ZCodeEventNameSchema = z.enum([
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "userInput.requested",
  "userInput.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
]);
export type ZCodeEventName = z.infer<typeof ZCodeEventNameSchema>;

// =============================================================================
// Delivery kinds (session/subscribe parameter)
// =============================================================================

export const ZCodeDeliveryKindSchema = z.enum([
  "desktop-continuous",
  "web-remote-replayable",
]);
export type ZCodeDeliveryKind = z.infer<typeof ZCodeDeliveryKindSchema>;

/**
 * The delivery kind Yep prefers for its product semantics (disconnect-tolerant,
 * remote-replayable).  P0 fixtures must assert this value is accepted.
 */
export const ZCODE_PREFERRED_DELIVERY_KIND = "web-remote-replayable" as const;

// =============================================================================
// Execution modes
// =============================================================================

/**
 * ZCode native execution modes accepted by the protocol.
 *
 * `auto` is part of the wire enum but is NOT a usable mode: the CLI 0.16.1
 * PermissionService denies every tool call in it
 * (`mode.auto.unimplemented` — "Auto mode is reserved but not implemented
 * yet"), and ZCode's own mode picker offers only build/edit/plan/yolo.
 * Never select it — see `YEP_TO_ZCODE_MODE_MAP`.
 */
export const ZCodeModeSchema = z.enum([
  "auto",
  "build",
  "edit",
  "plan",
  "yolo",
]);
export type ZCodeMode = z.infer<typeof ZCodeModeSchema>;

/**
 * ZCode native modes that actually work, in the CLI's own picker order.
 *
 * Mirrors the CLI mode list:
 *   - `build` — "Ask before changes"
 *   - `edit`  — "Edit automatically"
 *   - `plan`  — "Plan mode"
 *   - `yolo`  — "Full access"
 */
export const ZCODE_SELECTABLE_MODES = [
  "build",
  "edit",
  "plan",
  "yolo",
] as const satisfies readonly ZCodeMode[];

/**
 * Mapping from Yep canonical PermissionMode to ZCode native mode.
 * Derived from the CLI's own mode picker (`build`/`edit`/`plan`/`yolo`).
 *
 * The map is intentionally total so lookups never yield `undefined`, but Yep's
 * `auto` has no ZCode equivalent: ZCode's `auto` denies every tool call, so it
 * degrades to `build` (ask before changes) instead. The provider does not
 * advertise `auto`, so this branch only catches sessions persisted before
 * `auto` was withdrawn.
 */
export const YEP_TO_ZCODE_MODE_MAP = {
  auto: "build",
  default: "build",
  acceptEdits: "edit",
  plan: "plan",
  bypassPermissions: "yolo",
} as const satisfies Record<string, ZCodeMode>;

// =============================================================================
// Streaming kinds (model.streaming event)
// =============================================================================

export const ZCodeStreamingKindSchema = z.enum([
  "start",
  "finish",
  "error",
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
]);
export type ZCodeStreamingKind = z.infer<typeof ZCodeStreamingKindSchema>;

// =============================================================================
// Stable error codes
// =============================================================================

export const ZCodeErrorCodeSchema = z.enum([
  "zcode_cli_not_found",
  "zcode_cli_unsupported_version",
  "zcode_node_runtime_unsupported",
  "zcode_config_unavailable",
  "zcode_registry_invalid",
  "zcode_model_unavailable",
  "zcode_protocol_start_failed",
  "zcode_protocol_timeout",
  "zcode_protocol_closed",
  "zcode_server_request_unsupported",
  "zcode_session_not_found",
  "zcode_session_inactive",
  "zcode_first_message_edit_unsupported",
  "zcode_db_unavailable",
  "zcode_db_schema_unsupported",
]);
export type ZCodeErrorCode = z.infer<typeof ZCodeErrorCodeSchema>;

// =============================================================================
// Workspace identity (required by workspace/readState and other methods)
// =============================================================================

/**
 * ZCode workspace identity object.  `workspacePath` and `workspaceKey` are
 * required; `workspaceIdentity` and `remoteSessionId` are optional.
 */
export const ZCodeWorkspaceIdentitySchema = z
  .object({
    workspacePath: z.string().min(1),
    workspaceKey: z.string().min(1),
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
  })
  .strict();
export type ZCodeWorkspaceIdentity = z.infer<
  typeof ZCodeWorkspaceIdentitySchema
>;

// =============================================================================
// Runtime model (used by session/create, session/resume, workspace/readState)
// =============================================================================

/**
 * ZCode runtime model object: `{ revision, generatedAt, model, provider,
 * thoughtLevel? }`.  This is the full runtime model shape; for session/create
 * the simpler `model: { providerId, modelId }` is used instead.
 */
export const ZCodeRuntimeModelSchema = z
  .object({
    revision: z.string(),
    generatedAt: z.number().int().nonnegative(),
    model: z
      .object({
        providerId: z.string(),
        modelId: z.string(),
      })
      .strict(),
    provider: z.unknown(),
    thoughtLevel: z.string().optional(),
  })
  .strict();
export type ZCodeRuntimeModel = z.infer<typeof ZCodeRuntimeModelSchema>;

/**
 * Simple model reference: `{ providerId, modelId }`.  Used by session/create
 * and session/setModel.
 */
export const ZCodeModelRefSchema = z
  .object({
    providerId: z.string(),
    modelId: z.string(),
  })
  .strict();
export type ZCodeModelRef = z.infer<typeof ZCodeModelRefSchema>;

// =============================================================================
// Minimal params/result schemas for read-only and session methods
// =============================================================================

// workspace/readState
export const ZCodeWorkspaceReadStateParamsSchema = z
  .object({
    workspace: ZCodeWorkspaceIdentitySchema,
    runtimeModel: ZCodeRuntimeModelSchema.optional(),
    preferWorkspaceDefaults: z.boolean().optional(),
  })
  .strict();

export const ZCodeWorkspaceStateSchema = z
  .object({
    workspace: z.unknown().optional(),
    models: z.array(z.unknown()).optional(),
    defaultModel: z.unknown().optional(),
    defaultMode: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeWorkspaceState = z.infer<typeof ZCodeWorkspaceStateSchema>;

// workspace/updateProviderRegistry
export const ZCodeRegistryModelSchema = z
  .object({
    modelId: z.string(),
  })
  .strict();
export type ZCodeRegistryModel = z.infer<typeof ZCodeRegistryModelSchema>;

/**
 * API key reference for registry entries.
 * Real ZCode CLI 0.16.1 uses a discriminated union:
 *   - `{source: "inline", value: string}` — inline key value
 *   - `{source: "credential", key: string}` — credential store reference
 *   - `{source: "env", name: string}` — env var name
 *   - `{source: "server-config", key: string}` — server config key
 */
export const ZCodeApiKeyRefSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("inline"), value: z.string() }).strict(),
  z.object({ source: z.literal("credential"), key: z.string() }).strict(),
  z.object({ source: z.literal("env"), name: z.string() }).strict(),
  z.object({ source: z.literal("server-config"), key: z.string() }).strict(),
  z.object({ source: z.literal("session-secret"), key: z.string() }).strict(),
]);
export type ZCodeApiKeyRef = z.infer<typeof ZCodeApiKeyRefSchema>;

export const ZCodeProviderRegistryEntrySchema = z
  .object({
    providerId: z.string(),
    kind: z.string(),
    source: z.string().optional(),
    // Real CLI 0.16.1: `models` is REQUIRED and must have >= 1 entry; entries
    // carry only `modelId` (no `name` — the schema is strict and rejects it).
    models: z.array(ZCodeRegistryModelSchema).min(1),
    baseURL: z.string().optional(),
    // Real CLI uses apiKey as a discriminated union {source: "inline", value: ...}
    // Tolerate both string (legacy) and object (real) forms.
    apiKey: z.union([z.string(), ZCodeApiKeyRefSchema]).optional(),
    apiKeyRequired: z.boolean().optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    runtimeHeaders: z.boolean().optional(),
  })
  .strict();
export type ZCodeProviderRegistryEntry = z.infer<
  typeof ZCodeProviderRegistryEntrySchema
>;

export const ZCodeRegistrySchema = z
  .object({
    revision: z.string(),
    generatedAt: z.number().int().nonnegative(),
    providers: z.array(ZCodeProviderRegistryEntrySchema),
  })
  .strict();
export type ZCodeRegistry = z.infer<typeof ZCodeRegistrySchema>;

export const ZCodeUpdateProviderRegistryParamsSchema = z
  .object({
    workspace: ZCodeWorkspaceIdentitySchema,
    registry: ZCodeRegistrySchema,
    includeWorkspaceState: z.boolean().optional(),
  })
  .strict();

// session/list
export const ZCodeSessionListParamsSchema = z.object({}).strict().optional();

export const ZCodeSessionListItemSchema = z
  .object({
    sessionId: z.string().optional(),
    id: z.string().optional(),
    title: z.string().optional(),
    directory: z.string().optional(),
    createdAt: z.unknown().optional(),
    updatedAt: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeSessionListItem = z.infer<typeof ZCodeSessionListItemSchema>;

export const ZCodeSessionListResultSchema = z
  .object({
    sessions: z.array(ZCodeSessionListItemSchema).optional(),
  })
  .passthrough();
export type ZCodeSessionListResult = z.infer<
  typeof ZCodeSessionListResultSchema
>;

// =============================================================================
// Session method params (for contract test fixtures)
// =============================================================================

export const ZCodeSessionCreateParamsSchema = z
  .object({
    workspace: ZCodeWorkspaceIdentitySchema,
    model: ZCodeModelRefSchema.optional(),
    runtimeModel: ZCodeRuntimeModelSchema.optional(),
    mode: ZCodeModeSchema.optional(),
    persistence: z.enum(["immediate", "deferred"]).optional(),
    thoughtLevel: z.string().optional(),
    sessionId: z.string().optional(),
    parentSessionId: z.string().optional(),
    titleGenerationEnabled: z.boolean().optional(),
    mcpServers: z.array(z.unknown()).optional(),
    toolAllowlist: z.array(z.string()).optional(),
    toolDenylist: z.array(z.string()).optional(),
    importedHistory: z.unknown().optional(),
  })
  .strict();

export const ZCodeSessionResumeParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    workspace: ZCodeWorkspaceIdentitySchema.optional(),
    runtimeModel: ZCodeRuntimeModelSchema.optional(),
    thoughtLevel: z.string().optional(),
    mcpServers: z.array(z.unknown()).optional(),
    toolAllowlist: z.array(z.string()).optional(),
    toolDenylist: z.array(z.string()).optional(),
  })
  .strict();

export const ZCodeSessionSendParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    content: z.string(),
    inputId: z.string().optional(),
    queryId: z.string().optional(),
    attachments: z.array(z.record(z.string(), z.unknown())).optional(),
    browserAmbientContext: z.unknown().optional(),
    expectedRevision: z.number().int().optional(),
    expectedProviderRevision: z.string().optional(),
    expectedModelRuntimeRevision: z.string().optional(),
    runtimeModel: ZCodeRuntimeModelSchema.optional(),
    automationId: z.string().optional(),
    offPeakTaskId: z.string().optional(),
    offPeakRunType: z.string().optional(),
  })
  .strict();

export const ZCodeSessionSetModelParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    model: ZCodeModelRefSchema,
    runtimeModel: ZCodeRuntimeModelSchema.optional(),
    expectedRevision: z.number().int().optional(),
    persistAsWorkspaceLastUsed: z.boolean().optional(),
  })
  .strict();

export const ZCodeSessionSetModeParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    mode: ZCodeModeSchema,
    expectedRevision: z.number().int().optional(),
  })
  .strict();

export const ZCodeSessionSetThoughtLevelParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    thoughtLevel: z.string().min(1),
    runtimeModel: ZCodeRuntimeModelSchema.optional(),
    expectedRevision: z.number().int().optional(),
    persistAsWorkspaceLastUsed: z.boolean().optional(),
  })
  .strict();

export const ZCodeSessionStopParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export const ZCodeSessionCompactParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export const ZCodeSessionSubscribeParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    deliveryKind: ZCodeDeliveryKindSchema,
    afterSeq: z.number().int().nonnegative().optional(),
    includeSnapshot: z.boolean().optional(),
  })
  .strict();

// =============================================================================
// Session snapshot result (returned by session/create and session/resume)
// =============================================================================

export const ZCodeSessionSchema = z
  .object({
    sessionId: z.string(),
    workspace: z.unknown().optional(),
    parentSessionId: z.string().optional(),
    traceId: z.string().optional(),
    sessionKind: z.string().optional(),
    title: z.string().optional(),
    titleSource: z.string().optional(),
    mode: z.string().optional(),
    status: z.string().optional(),
    model: z.unknown().optional(),
    target: z.unknown().nullable().optional(),
    createdAt: z.unknown().optional(),
    updatedAt: z.unknown().optional(),
    archivedAt: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeSession = z.infer<typeof ZCodeSessionSchema>;

export const ZCodeSessionSnapshotSchema = z
  .object({
    protocol: z.unknown().optional(),
    session: ZCodeSessionSchema,
    settings: z.unknown().optional(),
    projection: z.unknown().optional(),
    runtime: z.unknown().optional(),
    messages: z.array(z.unknown()).optional(),
    goalStats: z.unknown().optional(),
    todos: z.array(z.unknown()).optional(),
    todoGroups: z.array(z.unknown()).optional(),
    slashCommands: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type ZCodeSessionSnapshot = z.infer<typeof ZCodeSessionSnapshotSchema>;

// =============================================================================
// session/messages, session/fork, session/close (edit-fork support)
// =============================================================================

/**
 * session/messages params (real CLI 0.16.1, strict schema).
 * Only `sessionId` is required; Yep sends no other keys.
 */
export const ZCodeSessionMessagesParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

/**
 * session/fork target discriminated union (real CLI 0.16.1, strict objects).
 * Default when omitted: `{kind: "latestCheckpoint"}`.
 *
 * IMPORTANT: a `message` target forks INCLUSIVELY — the child session copies
 * history up to and including the target message. Yep's edit semantics need
 * an exclusive boundary, so callers target the message *before* the edited
 * one (and must refuse when the edited message is the first).
 */
export const ZCodeForkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), turnIndex: z.number().int() }).strict(),
  z.object({ kind: z.literal("message"), messageId: z.string() }).strict(),
  z
    .object({ kind: z.literal("checkpoint"), checkpointId: z.string() })
    .strict(),
  z.object({ kind: z.literal("latestCheckpoint") }).strict(),
]);
export type ZCodeForkTarget = z.infer<typeof ZCodeForkTargetSchema>;

/** session/fork params (real CLI 0.16.1, strict schema). */
export const ZCodeSessionForkParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: ZCodeForkTargetSchema.optional(),
    expectedRevision: z.number().int().optional(),
  })
  .strict();

/**
 * session/fork result (real CLI 0.16.1, strict schema).
 * The fork inherits the source session's mode/model/thoughtLevel, and the
 * forked session becomes active+resumed inside the same app-server process.
 */
export const ZCodeSessionForkResultSchema = z
  .object({
    forkedSessionId: z.string(),
    parentSessionId: z.string().optional(),
    targetMessageId: z.string().optional(),
    targetCheckpointId: z.string().optional(),
    response: z.string(),
    snapshot: ZCodeSessionSnapshotSchema,
  })
  .strict();
export type ZCodeSessionForkResult = z.infer<
  typeof ZCodeSessionForkResultSchema
>;

/** session/close params (real CLI 0.16.1, strict schema). */
export const ZCodeSessionCloseParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

// =============================================================================
// mcp/list (read-only MCP server status introspection)
// =============================================================================

/**
 * mcp/list params (real CLI 0.16.1, strict schema).
 *
 * `mode` defaults to `"connect"`, which would actually open MCP connections;
 * Yep always sends `"status"` for a read-only snapshot.
 */
export const ZCodeMcpListParamsSchema = z
  .object({
    workspace: ZCodeWorkspaceIdentitySchema,
    mcpServers: z.array(z.unknown()).optional(),
    mode: z.enum(["connect", "status"]).optional(),
  })
  .strict();

/**
 * One MCP server's status entry inside the mcp/list result.
 * Passthrough: the CLI may add fields (e.g. `authorization`) in future
 * versions; Yep only projects the documented safe subset.
 */
export const ZCodeMcpServerStatusSchema = z
  .object({
    status: z.enum([
      "connecting",
      "connected",
      "disabled",
      "disconnected",
      "failed",
      "untrusted",
    ]),
    transport: z.enum(["stdio", "http", "sse"]),
    toolCount: z.number().int().nonnegative(),
    updatedAt: z.string(),
    error: z.string().optional(),
    protocolEra: z.enum(["legacy", "modern"]).optional(),
    authorization: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeMcpServerStatus = z.infer<typeof ZCodeMcpServerStatusSchema>;

/** mcp/list result (real CLI 0.16.1). */
export const ZCodeMcpListResultSchema = z
  .object({
    statuses: z.record(z.string(), ZCodeMcpServerStatusSchema),
  })
  .passthrough();
export type ZCodeMcpListResult = z.infer<typeof ZCodeMcpListResultSchema>;

// =============================================================================
// session/goal (goal lifecycle)
// =============================================================================

/**
 * session/goal params (real CLI 0.16.1, strict schema `eKt`).
 * `objective` is required by the CLI for set/replace (yep validates before
 * sending). Requires an active session.
 */
export const ZCodeGoalActionSchema = z.enum([
  "show",
  "set",
  "replace",
  "pause",
  "resume",
  "clear",
]);
export type ZCodeGoalAction = z.infer<typeof ZCodeGoalActionSchema>;

export const ZCodeSessionGoalParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    inputId: z.string().optional(),
    action: ZCodeGoalActionSchema,
    objective: z.string().optional(),
    expectedRevision: z.number().int().optional(),
  })
  .strict();

/**
 * session/goal result (real CLI 0.16.1, `CSa`). `response` is the CLI-rendered
 * goal status text; set/replace may start a turn immediately
 * (`startedTurn: true`) — that is normal behavior for an explicit user action.
 */
export const ZCodeSessionGoalResultSchema = z
  .object({
    response: z.string(),
    snapshot: z.unknown().optional(),
    startedTurn: z.boolean().optional(),
  })
  .passthrough();
export type ZCodeSessionGoalResult = z.infer<
  typeof ZCodeSessionGoalResultSchema
>;

// =============================================================================
// Event envelope (session/event notification params)
// =============================================================================

/**
 * Real CLI event envelope shape.  The actual event name is in `type` and the
 * typed body is in `payload`.  `seq` is the sequence number; `sessionId` is
 * always present.
 */
export const ZCodeEventEnvelopeSchema = z
  .object({
    eventId: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    seq: z.number().int().nonnegative(),
    traceId: z.string().optional(),
    timestamp: z.number().int().nonnegative(),
    deliveryKind: z.string().optional(),
    type: z.string(),
    payload: z.unknown().optional(),
  })
  .passthrough();
export type ZCodeEventEnvelope = z.infer<typeof ZCodeEventEnvelopeSchema>;

// =============================================================================
// Compatibility baseline
// =============================================================================

/**
 * The Desktop/CLI version pair that was probed during the 2026-08-11
 * investigation.  P0 fixtures are calibrated to this baseline.  Other
 * versions default to experimental/unavailable until probed.
 */
export const ZCODE_COMPATIBILITY_BASELINE = {
  desktopVersion: "3.7.5",
  cliVersion: "0.16.1",
} as const;

// =============================================================================
// Protocol version comparison helper
// =============================================================================

/**
 * Parse a semver-like version string (`MAJOR.MINOR.PATCH`) into a comparable
 * tuple.  Returns `null` when the string is not parseable.
 *
 * ZCode CLI versions observed so far are simple `MAJOR.MINOR.PATCH` (e.g.
 * `0.16.1`).  Pre-release suffixes, if any, are ignored for comparison.
 */
export function parseZCodeVersion(
  version: string,
): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

/**
 * Returns `true` when `actual` is greater than or equal to `baseline`.
 * Both arguments must be parseable; unparseable strings return `false`.
 */
export function isZCodeVersionGte(actual: string, baseline: string): boolean {
  const a = parseZCodeVersion(actual);
  const b = parseZCodeVersion(baseline);
  if (!a || !b) return false;
  const [aMaj, aMin, aPat] = a;
  const [bMaj, bMin, bPat] = b;
  if (aMaj > bMaj) return true;
  if (aMaj < bMaj) return false;
  if (aMin > bMin) return true;
  if (aMin < bMin) return false;
  return aPat >= bPat; // equal major.minor → compare patch
}

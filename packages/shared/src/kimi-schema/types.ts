/**
 * Kimi Code CLI session schema.
 *
 * Kimi persists sessions to
 *   ~/.kimi-code/sessions/<workspace>/session_<uuid>/agents/<agentId>/wire.jsonl
 * plus a sibling `state.json` with title / timestamps / project cwd metadata.
 *
 * `wire.jsonl` is an append-only event log. The canonical transcript is
 * reconstructed from two record kinds:
 *   - `turn.prompt`               → a real user turn (input parts)
 *   - `context.append_loop_event` → the assistant's per-step stream:
 *       `content.part` (think/text), `tool.call`, `tool.result`, `step.begin/end`
 *
 * `context.append_message` records are the post-compaction context-memory
 * projection (tool results are role=user there), so they are intentionally
 * NOT used for transcript reconstruction to avoid double-counting.
 *
 * Parsing is deliberately lenient: each line is JSON-parsed, known record
 * types are zod-validated, and unknown types are passed through as
 * `{ type, ... }` so Kimi wire-format evolution does not break the reader.
 */

import { z } from "zod";

// =============================================================================
// Content parts (turn.prompt.input items and content.part.part)
// =============================================================================

export const KimiTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const KimiThinkPartSchema = z.object({
  type: z.literal("think"),
  think: z.string(),
});

/**
 * An image in `turn.prompt.input`.
 *
 * Kimi rewrites inline image data before persisting: the (possibly downscaled)
 * bytes are content-addressed into `<agentDir>/blobs/<sha256>` and the part's
 * url becomes `blobref:<mimeType>;<sha256>`. A `data:` url can still appear for
 * records written by other paths, so both forms are accepted.
 */
export const KimiImagePartSchema = z.object({
  type: z.literal("image_url"),
  imageUrl: z.object({
    url: z.string(),
    id: z.string().nullish(),
  }),
});
export type KimiImagePart = z.infer<typeof KimiImagePartSchema>;

/** A part inside `content.part` — either assistant text or reasoning. */
export const KimiContentPartValueSchema = z.union([
  KimiTextPartSchema,
  KimiThinkPartSchema,
]);
export type KimiContentPartValue = z.infer<typeof KimiContentPartValueSchema>;

// =============================================================================
// Loop events (payload of context.append_loop_event.event)
// =============================================================================

export const KimiStepBeginEventSchema = z.object({
  type: z.literal("step.begin"),
  uuid: z.string().optional(),
  turnId: z.string().optional(),
  step: z.number().optional(),
});

export const KimiContentPartEventSchema = z.object({
  type: z.literal("content.part"),
  uuid: z.string().optional(),
  turnId: z.string().optional(),
  step: z.number().optional(),
  part: KimiContentPartValueSchema,
});

export const KimiToolCallEventSchema = z.object({
  type: z.literal("tool.call"),
  uuid: z.string().optional(),
  turnId: z.string().optional(),
  step: z.number().optional(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  description: z.string().optional(),
});

export const KimiToolResultEventSchema = z.object({
  type: z.literal("tool.result"),
  toolCallId: z.string().optional(),
  parentUuid: z.string().optional(),
  result: z
    .object({
      output: z.string().optional(),
      note: z.string().optional(),
      isError: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});

export const KimiStepUsageSchema = z.object({
  inputOther: z.number().optional(),
  output: z.number().optional(),
  inputCacheRead: z.number().optional(),
  inputCacheCreation: z.number().optional(),
});
export type KimiStepUsage = z.infer<typeof KimiStepUsageSchema>;

export const KimiStepEndEventSchema = z.object({
  type: z.literal("step.end"),
  uuid: z.string().optional(),
  turnId: z.string().optional(),
  step: z.number().optional(),
  usage: KimiStepUsageSchema.optional(),
  finishReason: z.string().optional(),
  providerFinishReason: z.string().optional(),
  rawFinishReason: z.string().optional(),
  messageId: z.string().optional(),
});

/** Known loop-event payloads; unknown ones fall through to `{ type }`. */
export const KimiLoopEventSchema = z.union([
  KimiStepBeginEventSchema,
  KimiContentPartEventSchema,
  KimiToolCallEventSchema,
  KimiToolResultEventSchema,
  KimiStepEndEventSchema,
  z.object({ type: z.string() }).passthrough(),
]);
export type KimiLoopEvent = z.infer<typeof KimiLoopEventSchema>;
export type KimiContentPartEvent = z.infer<typeof KimiContentPartEventSchema>;
export type KimiToolCallEvent = z.infer<typeof KimiToolCallEventSchema>;
export type KimiToolResultEvent = z.infer<typeof KimiToolResultEventSchema>;
export type KimiStepEndEvent = z.infer<typeof KimiStepEndEventSchema>;

// =============================================================================
// Top-level wire.jsonl records
// =============================================================================

export const KimiMetadataRecordSchema = z.object({
  type: z.literal("metadata"),
  protocol_version: z.string().optional(),
  created_at: z.number().optional(),
});

/**
 * Upstream defines `config.update` as one partial-update payload. A record can
 * update model, profile, thinking effort, or any combination of them.
 */
export const KimiConfigUpdateRecordSchema = z
  .object({
    type: z.literal("config.update"),
    modelAlias: z.string().optional(),
    profileName: z.string().optional(),
    thinkingEffort: z.string().optional(),
    thinkingLevel: z.string().optional(),
    systemPrompt: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

/** `config.update` carrying at least a resolved model alias. */
export const KimiModelConfigRecordSchema = z
  .object({
    type: z.literal("config.update"),
    modelAlias: z.string(),
    profileName: z.string().optional(),
    thinkingEffort: z.string().optional(),
    thinkingLevel: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

/**
 * `config.update` carrying at least the resolved subagent profile. Upstream
 * defines one partial-update payload, so a record may contain both
 * `profileName` and `modelAlias`; both fields must survive parsing.
 */
export const KimiProfileConfigRecordSchema = z
  .object({
    type: z.literal("config.update"),
    profileName: z.string(),
    modelAlias: z.string().optional(),
    thinkingEffort: z.string().optional(),
    thinkingLevel: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiTurnPromptRecordSchema = z.object({
  type: z.literal("turn.prompt"),
  input: z.array(z.unknown()),
  time: z.number().optional(),
});

export const KimiLoopEventRecordSchema = z.object({
  type: z.literal("context.append_loop_event"),
  event: KimiLoopEventSchema,
  time: z.number().optional(),
});

export const KimiUsageRecordSchema = z
  .object({
    type: z.literal("usage.record"),
    model: z.string().optional(),
    usageScope: z.string().optional(),
    usage: z.unknown().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiTurnEndedErrorSchema = z
  .object({
    code: z.string(),
    message: z.string().optional(),
    name: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    retryable: z.boolean().optional(),
  })
  .passthrough();

/** Terminal outcome for one Kimi turn, including provider-level failures. */
export const KimiTurnEndedRecordSchema = z.object({
  type: z.literal("turn.ended"),
  turnId: z.union([z.string(), z.number()]).optional(),
  reason: z.string().optional(),
  error: KimiTurnEndedErrorSchema.optional(),
  durationMs: z.number().optional(),
  time: z.number().optional(),
});
export type KimiTurnEndedRecord = z.infer<typeof KimiTurnEndedRecordSchema>;

// -----------------------------------------------------------------------------
// Goal lifecycle (main-agent autonomous goal: create / update / clear / fork).
// Mirrors references/kimi-code packages/agent-core-v2/src/agent/goal/goalOps.ts.
// A goal is a structured, multi-turn autonomous target with budgets; only the
// main agent holds one. `complete` is transient (cleared immediately after).
// -----------------------------------------------------------------------------

export const KimiGoalBudgetLimitsSchema = z
  .object({
    tokenBudget: z.number().finite().nonnegative().optional(),
    turnBudget: z.number().finite().nonnegative().optional(),
    wallClockBudgetMs: z.number().finite().nonnegative().optional(),
  })
  .passthrough();

export const KimiGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "complete",
]);
export const KimiGoalActorSchema = z.enum([
  "user",
  "model",
  "runtime",
  "system",
]);

export const KimiGoalCreateRecordSchema = z
  .object({
    type: z.literal("goal.create"),
    goalId: z.string(),
    objective: z.string(),
    completionCriterion: z.string().nullish(),
    wallClockResumedAt: z.number().finite().nonnegative().nullish(),
    status: KimiGoalStatusSchema.nullish(),
    actor: KimiGoalActorSchema.nullish(),
    budgetLimits: KimiGoalBudgetLimitsSchema.nullish(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiGoalUpdateRecordSchema = z
  .object({
    type: z.literal("goal.update"),
    goalId: z.string().optional(),
    status: KimiGoalStatusSchema.optional(),
    reason: z.string().optional(),
    turnsUsed: z.number().finite().nonnegative().optional(),
    tokensUsed: z.number().finite().nonnegative().optional(),
    wallClockMs: z.number().finite().nonnegative().optional(),
    wallClockResumedAt: z.number().finite().nonnegative().optional(),
    budgetLimits: KimiGoalBudgetLimitsSchema.optional(),
    actor: KimiGoalActorSchema.optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiGoalClearRecordSchema = z
  .object({
    type: z.literal("goal.clear"),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiForkedRecordSchema = z
  .object({
    type: z.literal("forked"),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Profile binding. `profile.bind` carries the resolved profile, including the
// authoritative `profileName` ("agent" for main, "coder"/"explore"/… for a
// child). `tools.set_active_tools` / `tools.reset_active_tools` mutate the
// active tool roster mid-session.
// -----------------------------------------------------------------------------

export const KimiProfileBindRecordSchema = z
  .object({
    type: z.literal("profile.bind"),
    modelAlias: z.string().optional(),
    profileName: z.string().optional(),
    thinkingEffort: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiSetActiveToolsRecordSchema = z
  .object({
    type: z.literal("tools.set_active_tools"),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiResetActiveToolsRecordSchema = z
  .object({
    type: z.literal("tools.reset_active_tools"),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Context memory ops. `context.append_message` is the post-compaction
// projection (intentionally ignored for transcript reconstruction); the others
// track clear / apply_compaction / undo lifecycle.
// -----------------------------------------------------------------------------

export const KimiContextAppendMessageRecordSchema = z
  .object({
    type: z.literal("context.append_message"),
    message: z.unknown(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiContextClearRecordSchema = z
  .object({
    type: z.literal("context.clear"),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiContextApplyCompactionRecordSchema = z
  .object({
    type: z.literal("context.apply_compaction"),
    tokensBefore: z.number().optional(),
    tokensAfter: z.number().optional(),
    summaryOutputTokens: z.number().optional(),
    keptUserMessageCount: z.number().optional(),
    keptHeadUserMessageCount: z.number().optional(),
    droppedCount: z.number().optional(),
    legacyTail: z.boolean().optional(),
    compactedCount: z.number().optional(),
    count: z.number().optional(),
    summary: z.unknown().optional(),
    contextSummary: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiContextUndoRecordSchema = z
  .object({
    type: z.literal("context.undo"),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Turn lifecycle. `turn.steer` injects a mid-turn steer; `turn.cancel`
// records an abort intent (consumed by inferKimiSubagentStatus → interrupted).
// -----------------------------------------------------------------------------

export const KimiTurnSteerRecordSchema = z
  .object({
    type: z.literal("turn.steer"),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiTurnCancelRecordSchema = z
  .object({
    type: z.literal("turn.cancel"),
    turnId: z.number().optional(),
    target: z.enum(["active", "queued"]).optional(),
    reason: z.enum(["user_cancelled", "aborted"]).optional(),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Swarm mode. `swarm_mode.enter`/`exit` bracket an AgentSwarm fan-out.
// -----------------------------------------------------------------------------

export const KimiSwarmEnterRecordSchema = z
  .object({
    type: z.literal("swarm_mode.enter"),
    trigger: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiSwarmExitRecordSchema = z
  .object({
    type: z.literal("swarm_mode.exit"),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Plan mode (read-only planning lifecycle). Fields are passthrough — these
// records are low-frequency and the upstream payload is feature-scoped.
// -----------------------------------------------------------------------------

export const KimiPlanModeEnterRecordSchema = z
  .object({ type: z.literal("plan_mode.enter"), time: z.number().optional() })
  .passthrough();
export const KimiPlanModeCancelRecordSchema = z
  .object({ type: z.literal("plan_mode.cancel"), time: z.number().optional() })
  .passthrough();
export const KimiPlanModeExitRecordSchema = z
  .object({ type: z.literal("plan_mode.exit"), time: z.number().optional() })
  .passthrough();
export const KimiPlanRevisionRecordSchema = z
  .object({ type: z.literal("plan.revision"), time: z.number().optional() })
  .passthrough();

// -----------------------------------------------------------------------------
// Background task lifecycle. `info` carries the task descriptor (incl. agentId,
// subagentType, model); `task.terminated.outputTail` carries the bounded output
// summary beside `info`.
// -----------------------------------------------------------------------------

const KimiTaskInfoSchema = z
  .object({
    taskId: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    detached: z.boolean().optional(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
    timeoutMs: z.number().optional(),
    kind: z.string().optional(),
    agentId: z.string().optional(),
    subagentType: z.string().optional(),
    model: z.string().optional(),
    thinkingEffort: z.string().optional(),
  })
  .passthrough();

export const KimiTaskStartedRecordSchema = z
  .object({
    type: z.literal("task.started"),
    info: KimiTaskInfoSchema,
    time: z.number().optional(),
  })
  .passthrough();

export const KimiTaskTerminatedRecordSchema = z
  .object({
    type: z.literal("task.terminated"),
    info: KimiTaskInfoSchema,
    outputTail: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// LLM request / tools snapshot.
// -----------------------------------------------------------------------------

export const KimiLlmToolsSnapshotRecordSchema = z
  .object({
    type: z.literal("llm.tools_snapshot"),
    hash: z.string().optional(),
    tools: z.unknown().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiLlmRequestRecordSchema = z
  .object({
    type: z.literal("llm.request"),
    kind: z.string().optional(),
    maxTokens: z.number().optional(),
    messageCount: z.number().optional(),
    model: z.string().optional(),
    modelAlias: z.string().optional(),
    provider: z.string().optional(),
    systemPromptHash: z.string().optional(),
    thinkingEffort: z.string().optional(),
    thinkingKeep: z.boolean().optional(),
    toolSelect: z.unknown().optional(),
    toolsHash: z.string().optional(),
    turnStep: z.unknown().optional(),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Permission / todo store / user tool / mcp discovery.
// -----------------------------------------------------------------------------

export const KimiPermissionSetModeRecordSchema = z
  .object({
    type: z.literal("permission.set_mode"),
    mode: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiPermissionRulesAddRecordSchema = z
  .object({
    type: z.literal("permission.rules.add"),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiPermissionApprovalResultRecordSchema = z
  .object({
    type: z.literal("permission.record_approval_result"),
    turnId: z.number().int().nonnegative(),
    toolCallId: z.string(),
    toolName: z.string(),
    action: z.string(),
    sessionApprovalRule: z.string().optional(),
    result: z.unknown(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiPluginSessionStartRecordSchema = z
  .object({
    type: z.literal("plugin.session_start"),
    content: z.string().nullable(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiInterruptionReminderRecordedRecordSchema = z
  .object({
    type: z.literal("interruptionReminder.recorded"),
    turnId: z.number().int().nonnegative(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiToolsUpdateStoreRecordSchema = z
  .object({
    type: z.literal("tools.update_store"),
    key: z.string().optional(),
    value: z.unknown().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiRegisterUserToolRecordSchema = z
  .object({
    type: z.literal("tools.register_user_tool"),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiUnregisterUserToolRecordSchema = z
  .object({
    type: z.literal("tools.unregister_user_tool"),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiMcpToolsDiscoveredRecordSchema = z
  .object({
    type: z.literal("mcp.tools_discovered"),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Full compaction lifecycle. The begin record carries source/instruction;
// compaction metrics are persisted by `context.apply_compaction`.
// -----------------------------------------------------------------------------

export const KimiFullCompactionBeginRecordSchema = z
  .object({
    type: z.literal("full_compaction.begin"),
    source: z.enum(["manual", "auto"]).optional(),
    instruction: z.string().optional(),
    /** Compatibility with early fixtures that used `trigger`. */
    trigger: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiFullCompactionCancelRecordSchema = z
  .object({
    type: z.literal("full_compaction.cancel"),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiFullCompactionCompleteRecordSchema = z
  .object({
    type: z.literal("full_compaction.complete"),
    time: z.number().optional(),
  })
  .passthrough();

// -----------------------------------------------------------------------------
// Interaction (human-in-the-loop). `interaction.request` opens an
// approval/question/user_tool entry; `interaction.resolved` folds the
// response. A request left unresolved means the process died with it pending.
// -----------------------------------------------------------------------------

export const KimiInteractionRequestRecordSchema = z
  .object({
    type: z.literal("interaction.request"),
    id: z.string(),
    kind: z.enum(["approval", "question", "user_tool"]),
    toolCallId: z.string().optional(),
    agentId: z.string().optional(),
    request: z.unknown(),
    time: z.number().optional(),
  })
  .passthrough();

export const KimiInteractionResolvedRecordSchema = z
  .object({
    type: z.literal("interaction.resolved"),
    id: z.string(),
    response: z.unknown(),
    time: z.number().optional(),
  })
  .passthrough();

/** Discriminated where possible; unknown record types pass through. */
export type KimiWireRecord =
  | z.infer<typeof KimiMetadataRecordSchema>
  | z.infer<typeof KimiConfigUpdateRecordSchema>
  | z.infer<typeof KimiProfileBindRecordSchema>
  | z.infer<typeof KimiSetActiveToolsRecordSchema>
  | z.infer<typeof KimiResetActiveToolsRecordSchema>
  | z.infer<typeof KimiTurnPromptRecordSchema>
  | z.infer<typeof KimiTurnSteerRecordSchema>
  | z.infer<typeof KimiTurnCancelRecordSchema>
  | z.infer<typeof KimiTurnEndedRecordSchema>
  | z.infer<typeof KimiLoopEventRecordSchema>
  | z.infer<typeof KimiContextAppendMessageRecordSchema>
  | z.infer<typeof KimiContextClearRecordSchema>
  | z.infer<typeof KimiContextApplyCompactionRecordSchema>
  | z.infer<typeof KimiContextUndoRecordSchema>
  | z.infer<typeof KimiUsageRecordSchema>
  | z.infer<typeof KimiGoalCreateRecordSchema>
  | z.infer<typeof KimiGoalUpdateRecordSchema>
  | z.infer<typeof KimiGoalClearRecordSchema>
  | z.infer<typeof KimiForkedRecordSchema>
  | z.infer<typeof KimiSwarmEnterRecordSchema>
  | z.infer<typeof KimiSwarmExitRecordSchema>
  | z.infer<typeof KimiPlanModeEnterRecordSchema>
  | z.infer<typeof KimiPlanModeCancelRecordSchema>
  | z.infer<typeof KimiPlanModeExitRecordSchema>
  | z.infer<typeof KimiPlanRevisionRecordSchema>
  | z.infer<typeof KimiTaskStartedRecordSchema>
  | z.infer<typeof KimiTaskTerminatedRecordSchema>
  | z.infer<typeof KimiLlmToolsSnapshotRecordSchema>
  | z.infer<typeof KimiLlmRequestRecordSchema>
  | z.infer<typeof KimiPermissionSetModeRecordSchema>
  | z.infer<typeof KimiPermissionRulesAddRecordSchema>
  | z.infer<typeof KimiPermissionApprovalResultRecordSchema>
  | z.infer<typeof KimiPluginSessionStartRecordSchema>
  | z.infer<typeof KimiInterruptionReminderRecordedRecordSchema>
  | z.infer<typeof KimiToolsUpdateStoreRecordSchema>
  | z.infer<typeof KimiRegisterUserToolRecordSchema>
  | z.infer<typeof KimiUnregisterUserToolRecordSchema>
  | z.infer<typeof KimiMcpToolsDiscoveredRecordSchema>
  | z.infer<typeof KimiFullCompactionBeginRecordSchema>
  | z.infer<typeof KimiFullCompactionCancelRecordSchema>
  | z.infer<typeof KimiFullCompactionCompleteRecordSchema>
  | z.infer<typeof KimiInteractionRequestRecordSchema>
  | z.infer<typeof KimiInteractionResolvedRecordSchema>
  | ({ type: string } & Record<string, unknown>);

/**
 * Parsed Kimi session (raw wire records + state.json metadata). Consumed by
 * the server's normalization layer to produce provider-agnostic messages.
 */
export interface KimiSessionContent {
  sessionId: string;
  workDir?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  /**
   * Absolute path to the agent's `blobs/` directory, used to resolve
   * `blobref:<mime>;<sha256>` image parts to real files. Absent when the
   * session was not loaded from disk.
   */
  blobsDir?: string;
  records: KimiWireRecord[];
}

/**
 * state.json alongside the agent wire logs.
 *
 * Kimi Code <= 0.33 wrote ISO timestamps and `workDir` (v1). Kimi Code 0.34
 * introduced state version 2, whose timestamps are epoch milliseconds and
 * whose project directory is named `cwd`. Normalize both layouts here so the
 * server's reader can keep one stable internal contract.
 */
const KimiSessionTimestampSchema = z.union([z.string(), z.number()]);

function normalizeKimiSessionTimestamp(
  value: string | number | undefined,
): string | undefined {
  if (typeof value !== "number") return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export const KimiSessionStateSchema = z
  .object({
    createdAt: KimiSessionTimestampSchema.optional(),
    updatedAt: KimiSessionTimestampSchema.optional(),
    title: z.string().optional(),
    isCustomTitle: z.boolean().optional(),
    workDir: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough()
  .transform((state) => ({
    ...state,
    createdAt: normalizeKimiSessionTimestamp(state.createdAt),
    updatedAt: normalizeKimiSessionTimestamp(state.updatedAt),
    workDir: state.workDir ?? state.cwd,
  }));
export type KimiSessionState = z.infer<typeof KimiSessionStateSchema>;

// =============================================================================
// Parsing helpers
// =============================================================================

/**
 * Parse a `wire.jsonl` file body into typed records. Known types are
 * zod-validated; unrecognized lines are kept as generic `{ type }` records.
 * Malformed JSON lines are skipped.
 */
export function parseKimiWireJsonl(content: string): KimiWireRecord[] {
  const records: KimiWireRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      continue;
    }
    records.push(coerceKimiRecord(parsed as { type: string }));
  }
  return records;
}

function coerceKimiRecord(raw: { type: string }): KimiWireRecord {
  switch (raw.type) {
    case "metadata": {
      const r = KimiMetadataRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "config.update": {
      const r = KimiConfigUpdateRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "profile.bind": {
      const r = KimiProfileBindRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "tools.set_active_tools": {
      const r = KimiSetActiveToolsRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "tools.reset_active_tools": {
      const r = KimiResetActiveToolsRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "turn.prompt": {
      const r = KimiTurnPromptRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "turn.steer": {
      const r = KimiTurnSteerRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "turn.cancel": {
      const r = KimiTurnCancelRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "turn.ended": {
      const r = KimiTurnEndedRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "context.append_loop_event": {
      const r = KimiLoopEventRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "context.append_message": {
      const r = KimiContextAppendMessageRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "context.clear": {
      const r = KimiContextClearRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "context.apply_compaction": {
      const r = KimiContextApplyCompactionRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "context.undo": {
      const r = KimiContextUndoRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "usage.record": {
      const r = KimiUsageRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "goal.create": {
      const r = KimiGoalCreateRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "goal.update": {
      const r = KimiGoalUpdateRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "goal.clear": {
      const r = KimiGoalClearRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "forked": {
      const r = KimiForkedRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "swarm_mode.enter": {
      const r = KimiSwarmEnterRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "swarm_mode.exit": {
      const r = KimiSwarmExitRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "plan_mode.enter": {
      const r = KimiPlanModeEnterRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "plan_mode.cancel": {
      const r = KimiPlanModeCancelRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "plan_mode.exit": {
      const r = KimiPlanModeExitRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "plan.revision": {
      const r = KimiPlanRevisionRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "task.started": {
      const r = KimiTaskStartedRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "task.terminated": {
      const r = KimiTaskTerminatedRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "llm.tools_snapshot": {
      const r = KimiLlmToolsSnapshotRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "llm.request": {
      const r = KimiLlmRequestRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "permission.set_mode": {
      const r = KimiPermissionSetModeRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "permission.rules.add": {
      const r = KimiPermissionRulesAddRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "permission.record_approval_result": {
      const r = KimiPermissionApprovalResultRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "plugin.session_start": {
      const r = KimiPluginSessionStartRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "interruptionReminder.recorded": {
      const r = KimiInterruptionReminderRecordedRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "tools.update_store": {
      const r = KimiToolsUpdateStoreRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "tools.register_user_tool": {
      const r = KimiRegisterUserToolRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "tools.unregister_user_tool": {
      const r = KimiUnregisterUserToolRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "mcp.tools_discovered": {
      const r = KimiMcpToolsDiscoveredRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "full_compaction.begin": {
      const r = KimiFullCompactionBeginRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "full_compaction.cancel": {
      const r = KimiFullCompactionCancelRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "full_compaction.complete": {
      const r = KimiFullCompactionCompleteRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "interaction.request": {
      const r = KimiInteractionRequestRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "interaction.resolved": {
      const r = KimiInteractionResolvedRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    default:
      return raw;
  }
}

/** Parse `state.json`; returns null on failure. */
export function parseKimiSessionState(
  content: string,
): KimiSessionState | null {
  try {
    const result = KimiSessionStateSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Kimi injects a `<system>Image compressed to fit model limits: ...</system>`
 * text part immediately before an image it had to downscale. It is guidance for
 * the model (it names the on-disk original so the agent can re-read a crop at
 * full fidelity), not something the user wrote — so it is excluded from the
 * transcript's user text.
 *
 * The filter matches ONLY the exact Kimi-injected prefix. A naive
 * `<system>...</system>` match would also drop legitimate user text that
 * happens to be wrapped in a `<system>` tag, corrupting transcripts and
 * session titles. Kimi 0.29.1 itself only matches this specific compression
 * notice.
 */
const KIMI_SYSTEM_PART_RE =
  /^<system>Image compressed to fit model limits:[\s\S]*<\/system>$/;

/**
 * Kimi's ACP adapter currently degrades a batched AskUserQuestion call to its
 * first question because ACP has no multi-answer response shape. Yep injects
 * this exact provider-only reminder into provider prompts so the model asks
 * one question per call and never invents an answer for a dropped question.
 *
 * Exporting the exact text also lets persisted Kimi prompt replay remove only
 * Yep's own compatibility block without hiding similar user-authored prose.
 */
export const KIMI_ACP_SINGLE_QUESTION_REMINDER = `<system-reminder>
[yep-anywhere:kimi-acp-single-question]
This ACP host can transport exactly one AskUserQuestion item per tool call. Put exactly one question in every AskUserQuestion call and wait for its answer before asking the next. If a result omits any question, ask each missing question in a new one-question call. Never infer an omitted answer or treat a Recommended option as selected.
</system-reminder>`;

function isKimiInjectedSystemText(text: string): boolean {
  return KIMI_SYSTEM_PART_RE.test(text.trim());
}

/** Extract concatenated text from a `turn.prompt.input` array. */
export function getKimiPromptText(input: readonly unknown[]): string {
  return input
    .map((part) => {
      if (typeof part === "string") {
        return stripKimiAcpCompatibilityReminder(part);
      }
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const text = (part as { text: string }).text;
        return isKimiInjectedSystemText(text)
          ? ""
          : stripKimiAcpCompatibilityReminder(text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripKimiAcpCompatibilityReminder(text: string): string {
  if (text === KIMI_ACP_SINGLE_QUESTION_REMINDER) return "";
  const prefix = `${KIMI_ACP_SINGLE_QUESTION_REMINDER}\n\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** A `blobref:<mimeType>;<sha256>` reference resolved to its parts. */
export interface KimiBlobRef {
  mimeType: string;
  hash: string;
}

/**
 * Parse Kimi's content-addressed blob url. Returns null for any other form
 * (notably `data:` urls, which already carry their own bytes).
 */
export function parseKimiBlobRef(url: string): KimiBlobRef | null {
  if (!url.startsWith("blobref:")) return null;
  const body = url.slice("blobref:".length);
  const sep = body.lastIndexOf(";");
  if (sep <= 0) return null;
  const mimeType = body.slice(0, sep).trim();
  const hash = body.slice(sep + 1).trim();
  // Content-addressed by sha256; reject anything that could escape the blobs dir.
  if (!mimeType || !/^[0-9a-f]{64}$/.test(hash)) return null;
  return { mimeType, hash };
}

/** An image referenced by a user turn, resolved for presentation. */
export interface KimiPromptImage {
  /** Original url as persisted (`blobref:...` or `data:...`). */
  url: string;
  mimeType: string;
  /** Set when the url was a `blobref:`; names a file in the agent blobs dir. */
  blobHash?: string;
}

/** Extract the images attached to a `turn.prompt.input` array, in order. */
export function getKimiPromptImages(
  input: readonly unknown[],
): KimiPromptImage[] {
  const images: KimiPromptImage[] = [];
  for (const raw of input) {
    const parsed = KimiImagePartSchema.safeParse(raw);
    if (!parsed.success) continue;
    const url = parsed.data.imageUrl.url;
    const ref = parseKimiBlobRef(url);
    if (ref) {
      images.push({ url, mimeType: ref.mimeType, blobHash: ref.hash });
      continue;
    }
    const dataMatch = /^data:([^;,]+)[;,]/.exec(url);
    images.push({ url, mimeType: dataMatch?.[1] ?? "image/png" });
  }
  return images;
}

// Type guards used by the normalization layer.

export function isKimiTurnPromptRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiTurnPromptRecordSchema> {
  return record.type === "turn.prompt";
}

export function isKimiLoopEventRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiLoopEventRecordSchema> {
  return record.type === "context.append_loop_event";
}

export function isKimiTurnEndedRecord(
  record: KimiWireRecord,
): record is KimiTurnEndedRecord {
  return record.type === "turn.ended";
}

export function isKimiModelConfigRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiModelConfigRecordSchema> {
  return record.type === "config.update" && "modelAlias" in record;
}

/** Type guard for the profile-config variant of `config.update`. */
export function isKimiProfileConfigRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiProfileConfigRecordSchema> {
  return record.type === "config.update" && "profileName" in record;
}

/** Type guard for `profile.bind` (authoritative profile source). */
export function isKimiProfileBindRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiProfileBindRecordSchema> {
  return record.type === "profile.bind";
}

/** Type guard for `goal.create`. */
export function isKimiGoalCreateRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiGoalCreateRecordSchema> {
  return (
    record.type === "goal.create" &&
    KimiGoalCreateRecordSchema.safeParse(record).success
  );
}

/** Type guard for `goal.update`. */
export function isKimiGoalUpdateRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiGoalUpdateRecordSchema> {
  return (
    record.type === "goal.update" &&
    KimiGoalUpdateRecordSchema.safeParse(record).success
  );
}

/** Type guard for `goal.clear`. */
export function isKimiGoalClearRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiGoalClearRecordSchema> {
  return (
    record.type === "goal.clear" &&
    KimiGoalClearRecordSchema.safeParse(record).success
  );
}

/** Type guard for `forked` (goal boundary clear). */
export function isKimiForkedRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiForkedRecordSchema> {
  return (
    record.type === "forked" && KimiForkedRecordSchema.safeParse(record).success
  );
}

/** Type guard for `swarm_mode.enter`. */
export function isKimiSwarmEnterRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiSwarmEnterRecordSchema> {
  return record.type === "swarm_mode.enter";
}

/** Type guard for `swarm_mode.exit`. */
export function isKimiSwarmExitRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiSwarmExitRecordSchema> {
  return record.type === "swarm_mode.exit";
}

/** Type guard for `task.started`. */
export function isKimiTaskStartedRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiTaskStartedRecordSchema> {
  return record.type === "task.started";
}

/** Type guard for `task.terminated`. */
export function isKimiTaskTerminatedRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiTaskTerminatedRecordSchema> {
  return record.type === "task.terminated";
}

/** Type guard for `interaction.request`. */
export function isKimiInteractionRequestRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiInteractionRequestRecordSchema> {
  return record.type === "interaction.request";
}

/** Type guard for `interaction.resolved`. */
export function isKimiInteractionResolvedRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiInteractionResolvedRecordSchema> {
  return record.type === "interaction.resolved";
}

/** Type guard for `turn.cancel`. */
export function isKimiTurnCancelRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiTurnCancelRecordSchema> {
  return record.type === "turn.cancel";
}

/** Type guard for `full_compaction.begin`. */
export function isKimiFullCompactionBeginRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiFullCompactionBeginRecordSchema> {
  return (
    record.type === "full_compaction.begin" &&
    KimiFullCompactionBeginRecordSchema.safeParse(record).success
  );
}

/** Type guard for `context.apply_compaction`. */
export function isKimiContextApplyCompactionRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiContextApplyCompactionRecordSchema> {
  return (
    record.type === "context.apply_compaction" &&
    KimiContextApplyCompactionRecordSchema.safeParse(record).success
  );
}

/** Type guard for `tools.update_store`. */
export function isKimiToolsUpdateStoreRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiToolsUpdateStoreRecordSchema> {
  return record.type === "tools.update_store";
}

// =============================================================================
// Goal timeline replay (pure, from a main-agent wire.jsonl)
// =============================================================================

/**
 * A goal budget limit. Mirrors the upstream `GoalBudgetLimits`:
 * `tokenBudget` / `turnBudget` / `wallClockBudgetMs`.
 */
export interface KimiGoalBudgetLimits {
  tokenBudget?: number;
  turnBudget?: number;
  wallClockBudgetMs?: number;
}

/**
 * A single goal snapshot — the goal's state at one point in the wire timeline.
 * Emitted by `getKimiGoalTimeline` for `goal.create` and each meaningful
 * `goal.update` (status/budget/counter change), plus a terminal snapshot at
 * `goal.clear` / `forked`. The `change` field classifies what this snapshot
 * records, so the renderer can choose how prominently to surface it.
 */
export interface KimiGoalSnapshot {
  /** The goal id (from goal.create; undefined after clear). */
  goalId?: string;
  /** The objective text (from goal.create; carried forward). */
  objective?: string;
  /** Optional completion criterion the model must satisfy. */
  completionCriterion?: string;
  /** Current status, including the synthetic `cleared` timeline marker. */
  status: "active" | "paused" | "blocked" | "complete" | "cleared";
  /** Terminal reason (set on blocked/complete via goal.update.reason). */
  reason?: string;
  /** Turns consumed so far. */
  turnsUsed?: number;
  /** Tokens consumed so far. */
  tokensUsed?: number;
  /** Wall-clock milliseconds consumed so far. */
  wallClockMs?: number;
  /** Epoch-ms anchor for the currently active wall-clock interval. */
  wallClockResumedAt?: number;
  /** Active budget limits. */
  budgetLimits?: KimiGoalBudgetLimits;
  /** Who drove this change. */
  actor?: "user" | "model" | "runtime" | "system";
  /** Record timestamp (epoch ms). */
  time?: number;
  /** What this snapshot records. */
  change: "created" | "status" | "budget" | "progress" | "cleared";
}

/**
 * Replay `goal.*` / `forked` records into a timeline of goal snapshots.
 *
 * Mirrors the upstream `GoalModel` apply semantics (references/kimi-code
 * packages/agent-core-v2/src/agent/goal/goalOps.ts):
 *  - `goal.create` → a `created` snapshot (status forced to `active`,
 *    counters zeroed, budget limits initialized empty).
 *  - `goal.update` → a snapshot whose `change` reflects what changed: a
 *    `status` change (active/paused/blocked/complete), a `budget` change
 *    (budgetLimits), or a `progress` change (turnsUsed/tokensUsed/wallClockMs
 *    only). Exact no-op updates do not create timeline noise.
 *  - `goal.clear` / `forked` → a `cleared` snapshot (status `cleared`).
 *
 * On resume, the upstream normalizes an `active` goal down to `paused`
 * ("Paused after agent resume"); a replayed `active` status is preserved as-is
 * here (the wire already records what was dispatched), so callers that need
 * the post-resume view should apply `paused` themselves.
 *
 * Only the main agent holds a goal; child wires typically have no goal.*
 * records, in which case this returns an empty array.
 */
export function getKimiGoalTimeline(
  records: readonly KimiWireRecord[],
): KimiGoalSnapshot[] {
  const snapshots: KimiGoalSnapshot[] = [];
  let goal: {
    goalId: string;
    objective: string;
    completionCriterion?: string;
    status: "active" | "paused" | "blocked" | "complete";
    reason?: string;
    turnsUsed: number;
    tokensUsed: number;
    wallClockMs: number;
    wallClockResumedAt?: number;
    budgetLimits?: KimiGoalBudgetLimits;
  } | null = null;

  const emitProgress = (
    time: number | undefined,
    change: KimiGoalSnapshot["change"] = "progress",
    actor?: KimiGoalSnapshot["actor"],
  ) => {
    if (!goal) return;
    snapshots.push({
      goalId: goal.goalId,
      objective: goal.objective,
      ...(goal.completionCriterion
        ? { completionCriterion: goal.completionCriterion }
        : {}),
      status: goal.status,
      ...(goal.reason ? { reason: goal.reason } : {}),
      ...(goal.turnsUsed ? { turnsUsed: goal.turnsUsed } : {}),
      ...(goal.tokensUsed ? { tokensUsed: goal.tokensUsed } : {}),
      ...(goal.wallClockMs ? { wallClockMs: goal.wallClockMs } : {}),
      ...(goal.wallClockResumedAt !== undefined
        ? { wallClockResumedAt: goal.wallClockResumedAt }
        : {}),
      ...(goal.budgetLimits ? { budgetLimits: goal.budgetLimits } : {}),
      ...(actor ? { actor } : {}),
      ...(time !== undefined ? { time } : {}),
      change,
    });
  };

  for (const record of records) {
    if (isKimiGoalCreateRecord(record)) {
      goal = {
        goalId: record.goalId,
        objective: record.objective,
        ...(record.completionCriterion
          ? { completionCriterion: record.completionCriterion }
          : {}),
        status: "active",
        turnsUsed: 0,
        tokensUsed: 0,
        wallClockMs: 0,
        ...(record.wallClockResumedAt != null
          ? { wallClockResumedAt: record.wallClockResumedAt }
          : {}),
        budgetLimits: {},
      };
      snapshots.push({
        goalId: goal.goalId,
        objective: goal.objective,
        ...(goal.completionCriterion
          ? { completionCriterion: goal.completionCriterion }
          : {}),
        status: "active",
        turnsUsed: 0,
        tokensUsed: 0,
        wallClockMs: 0,
        budgetLimits: {},
        ...(goal.wallClockResumedAt !== undefined
          ? { wallClockResumedAt: goal.wallClockResumedAt }
          : {}),
        ...(record.actor ? { actor: record.actor } : {}),
        ...(record.time !== undefined ? { time: record.time } : {}),
        change: "created",
      });
      continue;
    }
    if (isKimiGoalUpdateRecord(record) && goal) {
      let change: KimiGoalSnapshot["change"] = "progress";
      let changed = false;
      if (record.status !== undefined && record.status !== goal.status) {
        goal.status = record.status;
        if (record.status === "active") {
          goal.reason = undefined;
          goal.wallClockResumedAt = record.wallClockResumedAt;
        } else {
          goal.reason = record.reason;
          goal.wallClockResumedAt = undefined;
        }
        change = "status";
        changed = true;
      } else if (
        record.wallClockResumedAt !== undefined &&
        goal.status === "active" &&
        record.wallClockResumedAt !== goal.wallClockResumedAt
      ) {
        goal.wallClockResumedAt = record.wallClockResumedAt;
        changed = true;
      }
      if (record.budgetLimits !== undefined) {
        goal.budgetLimits = record.budgetLimits;
        if (change === "progress") change = "budget";
        changed = true;
      }
      if (
        record.turnsUsed !== undefined &&
        record.turnsUsed !== goal.turnsUsed
      ) {
        goal.turnsUsed = record.turnsUsed;
        changed = true;
      }
      if (
        record.tokensUsed !== undefined &&
        record.tokensUsed !== goal.tokensUsed
      ) {
        goal.tokensUsed = record.tokensUsed;
        changed = true;
      }
      if (
        record.wallClockMs !== undefined &&
        record.wallClockMs !== goal.wallClockMs
      ) {
        goal.wallClockMs = record.wallClockMs;
        changed = true;
      }
      if (changed) emitProgress(record.time, change, record.actor);
      continue;
    }
    if ((isKimiGoalClearRecord(record) || isKimiForkedRecord(record)) && goal) {
      snapshots.push({
        goalId: goal.goalId,
        objective: goal.objective,
        ...(goal.completionCriterion
          ? { completionCriterion: goal.completionCriterion }
          : {}),
        status: "cleared",
        ...(goal.reason ? { reason: goal.reason } : {}),
        ...(goal.turnsUsed ? { turnsUsed: goal.turnsUsed } : {}),
        ...(goal.tokensUsed ? { tokensUsed: goal.tokensUsed } : {}),
        ...(goal.wallClockMs ? { wallClockMs: goal.wallClockMs } : {}),
        ...(goal.budgetLimits ? { budgetLimits: goal.budgetLimits } : {}),
        ...(record.time !== undefined ? { time: record.time } : {}),
        change: "cleared",
      });
      goal = null;
    }
  }

  return snapshots;
}

// =============================================================================
// Subagent metrics + lifecycle derivation (pure, from a child wire.jsonl)
// =============================================================================

/**
 * Provider-agnostic subagent lifecycle status. Mirrors
 * `SubagentStatus` in app-types; duplicated here to keep the kimi-schema
 * module free of cross-imports.
 */
export type KimiSubagentStatus =
  | "queued"
  | "starting"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "interrupted"
  | "backgrounded";

export interface KimiSubagentUsage {
  contextTokens?: number;
  inputOther?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
  output?: number;
  totalTokens?: number;
}

export interface KimiSubagentMetrics {
  usage?: KimiSubagentUsage;
  toolUseCount?: number;
  stepCount?: number;
  durationMs?: number;
}

/**
 * Resolve the subagent profile/type. Prefers `profile.bind.profileName` (the
 * authoritative source in Kimi Code 0.34+); falls back to the profile-config
 * variant of `config.update` (older sessions / a second record Kimi writes into
 * each child wire). The two carry the same `profileName` for a given agent.
 */
export function getKimiSubagentType(
  records: readonly KimiWireRecord[],
): string | undefined {
  for (const record of records) {
    if (record.type !== "profile.bind") continue;
    const profileName = (record as { profileName?: unknown }).profileName;
    if (typeof profileName === "string" && profileName.length > 0) {
      return profileName;
    }
  }
  for (const record of records) {
    if (record.type !== "config.update") continue;
    const profileName = (record as { profileName?: unknown }).profileName;
    if (typeof profileName === "string" && profileName.length > 0) {
      return profileName;
    }
  }
  return undefined;
}

/** Extract a record's millisecond timestamp when present. */
function kimiRecordTime(record: KimiWireRecord): number | undefined {
  const t = (record as { time?: unknown }).time;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (
    record.type === "metadata" &&
    typeof (record as { created_at?: unknown }).created_at === "number"
  ) {
    return (record as { created_at: number }).created_at;
  }
  return undefined;
}

/**
 * Derive run metrics for a subagent from its own `wire.jsonl` records.
 *
 * Rules (authoritative, non-heuristic — every value is measured from persisted
 * records, and absent measurements are omitted rather than zero-filled):
 *  - `toolUseCount`: number of child `tool.call` loop events.
 *  - `stepCount`:    number of child `step.end` loop events.
 *  - `usage`:        per-`step.end.usage` accumulated; cache reads/writes kept
 *                    as independent fields; `totalTokens` is their sum with
 *                    output; `contextTokens` is the last step's input total
 *                    (inputOther + inputCacheRead + inputCacheCreation), which
 *                    approximates Kimi's context-window fill.
 *  - `durationMs`:   first record timestamp → last record timestamp.
 */
export function deriveKimiSubagentMetrics(
  records: readonly KimiWireRecord[],
): KimiSubagentMetrics {
  let toolUseCount = 0;
  let stepCount = 0;
  let inputOther = 0;
  let output = 0;
  let inputCacheRead = 0;
  let inputCacheCreation = 0;
  let sawUsage = false;
  let lastContextInput: number | undefined;

  let firstTime: number | undefined;
  let lastTime: number | undefined;

  for (const record of records) {
    const t = kimiRecordTime(record);
    if (t !== undefined) {
      if (firstTime === undefined || t < firstTime) firstTime = t;
      if (lastTime === undefined || t > lastTime) lastTime = t;
    }

    if (!isKimiLoopEventRecord(record)) continue;
    const event = record.event;
    if (event.type === "tool.call") {
      toolUseCount += 1;
    } else if (event.type === "step.end") {
      stepCount += 1;
      const usage = (event as KimiStepEndEvent).usage;
      if (usage) {
        sawUsage = true;
        const other = usage.inputOther ?? 0;
        const cacheRead = usage.inputCacheRead ?? 0;
        const cacheCreation = usage.inputCacheCreation ?? 0;
        inputOther += other;
        output += usage.output ?? 0;
        inputCacheRead += cacheRead;
        inputCacheCreation += cacheCreation;
        lastContextInput = other + cacheRead + cacheCreation;
      }
    }
  }

  const metrics: KimiSubagentMetrics = {};
  if (toolUseCount > 0) metrics.toolUseCount = toolUseCount;
  if (stepCount > 0) metrics.stepCount = stepCount;
  if (
    firstTime !== undefined &&
    lastTime !== undefined &&
    lastTime > firstTime
  ) {
    metrics.durationMs = lastTime - firstTime;
  }
  if (sawUsage) {
    metrics.usage = {
      inputOther,
      output,
      inputCacheRead,
      inputCacheCreation,
      totalTokens: inputOther + output + inputCacheRead + inputCacheCreation,
      ...(lastContextInput !== undefined
        ? { contextTokens: lastContextInput }
        : {}),
    };
  }
  return metrics;
}

/**
 * Infer a subagent's lifecycle status from its own wire records.
 *
 * Signals (in priority order):
 *  - `turn.cancel` record             → `interrupted` (user/parent aborted).
 *  - last `step.end.finishReason` is a
 *    terminal completion (`end_turn`, `stop`) → `completed`.
 *  - has begun stepping but no terminal
 *    signal yet                       → `running`.
 *  - only setup records, nothing ran  → `queued`.
 *
 * A terminal parent tool.result wins over a clean child end because it carries
 * the batch/parent outcome. A non-terminal parent state (`running`,
 * `backgrounded`, `suspended`) is only a fallback: the child's own terminal
 * wire must still be allowed to converge it to completed. This never guesses
 * "completed" merely because messages exist.
 */
export function inferKimiSubagentStatus(
  records: readonly KimiWireRecord[],
  resolvedStatus?: KimiSubagentStatus,
): KimiSubagentStatus {
  let hasCancel = false;
  let sawStepBegin = false;
  let sawStepEnd = false;
  let lastFinishReason: string | undefined;
  let sawActivity = false;

  for (const record of records) {
    if (record.type === "turn.cancel") {
      hasCancel = true;
      continue;
    }
    if (!isKimiLoopEventRecord(record)) continue;
    const event = record.event;
    switch (event.type) {
      case "step.begin":
        sawStepBegin = true;
        sawActivity = true;
        break;
      case "content.part":
      case "tool.call":
      case "tool.result":
        sawActivity = true;
        break;
      case "step.end": {
        sawStepEnd = true;
        sawActivity = true;
        const reason = (event as KimiStepEndEvent).finishReason;
        if (typeof reason === "string") lastFinishReason = reason;
        break;
      }
      default:
        break;
    }
  }

  if (hasCancel) return "interrupted";

  const completedTerminally =
    sawStepEnd &&
    typeof lastFinishReason === "string" &&
    /^(?:end_turn|stop|completed)$/i.test(lastFinishReason);
  const resolvedTerminally =
    resolvedStatus === "completed" ||
    resolvedStatus === "failed" ||
    resolvedStatus === "interrupted";
  if (resolvedTerminally) return resolvedStatus;
  if (completedTerminally) return "completed";
  if (resolvedStatus !== undefined) return resolvedStatus;
  if (sawStepBegin || sawActivity) return "running";
  return "queued";
}

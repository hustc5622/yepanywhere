/**
 * Session file schemas for Codex CLI.
 *
 * Codex persists sessions to ~/.codex/sessions/ as JSONL files.
 * Each line is a JSON object with timestamp, type, and payload.
 *
 * This is DIFFERENT from the streaming output format (events.ts).
 * Session files use a wrapper format with explicit payload nesting.
 *
 * Event types in session files:
 * - session_meta: Session initialization metadata
 * - response_item: Message content (user, assistant, reasoning, function calls)
 * - event_msg: Event notifications (user_message, agent_message, token_count, etc.)
 * - turn_context: Per-turn context (cwd, approval policy, model, etc.)
 */

import { z } from "zod";

// =============================================================================
// Session Metadata
// =============================================================================

/**
 * Session metadata payload - first entry in session file.
 */
export const CodexSessionMetaPayloadSchema = z
  .object({
    session_id: z.string().optional(),
    id: z.string(),
    forked_from_id: z.string().nullable().optional(),
    parent_thread_id: z.string().nullable().optional(),
    timestamp: z.string(),
    cwd: z.string(),
    originator: z.string().optional(), // e.g. "codex_exec"
    cli_version: z.string().optional(),
    instructions: z.string().optional(),
    // Root sessions use scalar values such as "exec"/"vscode". Subagents use
    // a structured `source.subagent.thread_spawn` payload.
    source: z.unknown().optional(),
    thread_source: z.string().optional(),
    agent_nickname: z.string().nullable().optional(),
    agent_role: z.string().nullable().optional(),
    agent_path: z.string().nullable().optional(),
    model_provider: z.string().optional(), // e.g. "openai"
  })
  .passthrough();

export type CodexSessionMetaPayload = z.infer<
  typeof CodexSessionMetaPayloadSchema
>;

export const CodexSessionMetaEntrySchema = z.object({
  timestamp: z.string(),
  type: z.literal("session_meta"),
  payload: CodexSessionMetaPayloadSchema,
});

export type CodexSessionMetaEntry = z.infer<typeof CodexSessionMetaEntrySchema>;

// =============================================================================
// Response Item - Messages and Content
// =============================================================================

/**
 * Input text content block in user messages.
 */
export const CodexInputTextContentSchema = z.object({
  type: z.literal("input_text"),
  text: z.string(),
});

/**
 * Output text content block in assistant messages.
 */
export const CodexOutputTextContentSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
});

/**
 * Input image content block in user/developer messages.
 * Persisted shape can vary, so we keep this permissive.
 */
export const CodexInputImageContentSchema = z
  .object({
    type: z.literal("input_image"),
    image_url: z.string().optional(),
    file_path: z.string().optional(),
    mime_type: z.string().optional(),
  })
  .passthrough();

export const CodexMessagePhaseSchema = z
  .enum(["commentary", "final_answer"])
  .nullable()
  .optional();

export type CodexMessagePhase = z.infer<typeof CodexMessagePhaseSchema>;

/**
 * User or assistant message payload.
 */
export const CodexMessagePayloadSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "developer"]),
  phase: CodexMessagePhaseSchema,
  content: z.array(
    z.union([
      CodexInputTextContentSchema,
      CodexOutputTextContentSchema,
      CodexInputImageContentSchema,
    ]),
  ),
});

export type CodexMessagePayload = z.infer<typeof CodexMessagePayloadSchema>;

/**
 * Reasoning summary block.
 */
export const CodexSummaryTextSchema = z.object({
  type: z.literal("summary_text"),
  text: z.string(),
});

/**
 * Reasoning payload (chain-of-thought, may be encrypted).
 */
export const CodexReasoningPayloadSchema = z.object({
  type: z.literal("reasoning"),
  summary: z.array(CodexSummaryTextSchema).optional(),
  content: z.unknown().nullable().optional(), // Raw content if available
  encrypted_content: z.string().optional(), // Encrypted reasoning
});

export type CodexReasoningPayload = z.infer<typeof CodexReasoningPayloadSchema>;

/**
 * Function call payload.
 */
export const CodexFunctionCallPayloadSchema = z.object({
  type: z.literal("function_call"),
  name: z.string(),
  arguments: z.string(), // JSON string
  call_id: z.string(),
});

export type CodexFunctionCallPayload = z.infer<
  typeof CodexFunctionCallPayloadSchema
>;

export const CodexFunctionCallOutputContentItemSchema = z.union([
  CodexInputTextContentSchema,
  CodexInputImageContentSchema,
]);

export type CodexFunctionCallOutputContentItem = z.infer<
  typeof CodexFunctionCallOutputContentItemSchema
>;

/**
 * Function call output payload.
 */
export const CodexFunctionCallOutputPayloadSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.union([
    z.string(),
    z.array(CodexFunctionCallOutputContentItemSchema),
  ]),
});

export type CodexFunctionCallOutputPayload = z.infer<
  typeof CodexFunctionCallOutputPayloadSchema
>;

/**
 * Custom tool call payload (Codex-specific persisted format).
 */
export const CodexCustomToolCallPayloadSchema = z
  .object({
    type: z.literal("custom_tool_call"),
    call_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    namespace: z.string().optional(),
    arguments: z.string().optional(),
    input: z.unknown().optional(),
  })
  .passthrough();

export type CodexCustomToolCallPayload = z.infer<
  typeof CodexCustomToolCallPayloadSchema
>;

/**
 * Custom tool call output payload (Codex-specific persisted format).
 */
export const CodexCustomToolCallOutputPayloadSchema = z
  .object({
    type: z.literal("custom_tool_call_output"),
    call_id: z.string().optional(),
    output: z.unknown().optional(),
  })
  .passthrough();

export type CodexCustomToolCallOutputPayload = z.infer<
  typeof CodexCustomToolCallOutputPayloadSchema
>;

/**
 * Web search call payload.
 */
export const CodexWebSearchCallPayloadSchema = z
  .object({
    type: z.literal("web_search_call"),
    call_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    query: z.string().optional(),
    arguments: z.string().optional(),
    input: z.unknown().optional(),
    action: z.unknown().optional(),
  })
  .passthrough();

export type CodexWebSearchCallPayload = z.infer<
  typeof CodexWebSearchCallPayloadSchema
>;

const CodexImageGenerationPayloadFields = {
  id: z.string().optional(),
  status: z.string().optional(),
  revisedPrompt: z.string().nullable().optional(),
  revised_prompt: z.string().nullable().optional(),
  result: z.string().optional(),
  savedPath: z.string().optional(),
  saved_path: z.string().optional(),
};

/**
 * Image generation payload.
 *
 * Codex app-server exposes this as a ThreadItem, but some persisted formats can
 * also carry it as a response_item payload. Accept both naming styles so older
 * rollout files remain renderable.
 */
export const CodexImageGenerationPayloadSchema = z
  .object({
    type: z.literal("image_generation"),
    ...CodexImageGenerationPayloadFields,
  })
  .passthrough();

export const CodexImageGenerationCamelPayloadSchema = z
  .object({
    type: z.literal("imageGeneration"),
    ...CodexImageGenerationPayloadFields,
  })
  .passthrough();

export const CodexImageGenerationCallPayloadSchema = z
  .object({
    type: z.literal("image_generation_call"),
    ...CodexImageGenerationPayloadFields,
  })
  .passthrough();

export type CodexImageGenerationPayload =
  | z.infer<typeof CodexImageGenerationPayloadSchema>
  | z.infer<typeof CodexImageGenerationCamelPayloadSchema>
  | z.infer<typeof CodexImageGenerationCallPayloadSchema>;

/**
 * Ghost commit snapshot for git state tracking.
 */
export const CodexGhostSnapshotPayloadSchema = z.object({
  type: z.literal("ghost_snapshot"),
  ghost_commit: z.object({
    id: z.string(),
    parent: z.string(),
    preexisting_untracked_files: z.array(z.string()).optional(),
    preexisting_untracked_dirs: z.array(z.string()).optional(),
  }),
});

export type CodexGhostSnapshotPayload = z.infer<
  typeof CodexGhostSnapshotPayloadSchema
>;

/**
 * Union of all response item payload types.
 */
export const CodexResponseItemPayloadSchema = z.discriminatedUnion("type", [
  CodexMessagePayloadSchema,
  CodexReasoningPayloadSchema,
  CodexFunctionCallPayloadSchema,
  CodexFunctionCallOutputPayloadSchema,
  CodexCustomToolCallPayloadSchema,
  CodexCustomToolCallOutputPayloadSchema,
  CodexWebSearchCallPayloadSchema,
  CodexImageGenerationPayloadSchema,
  CodexImageGenerationCamelPayloadSchema,
  CodexImageGenerationCallPayloadSchema,
  CodexGhostSnapshotPayloadSchema,
]);

export type CodexResponseItemPayload = z.infer<
  typeof CodexResponseItemPayloadSchema
>;

export const CodexResponseItemEntrySchema = z.object({
  timestamp: z.string(),
  type: z.literal("response_item"),
  payload: CodexResponseItemPayloadSchema,
});

export type CodexResponseItemEntry = z.infer<
  typeof CodexResponseItemEntrySchema
>;

// =============================================================================
// Event Messages
// =============================================================================

/**
 * Rate limit info.
 */
export const CodexRateLimitsSchema = z.object({
  primary: z
    .object({
      used_percent: z.number(),
      window_minutes: z.number(),
      resets_at: z.number(),
    })
    .optional(),
  secondary: z
    .object({
      used_percent: z.number(),
      window_minutes: z.number(),
      resets_at: z.number(),
    })
    .nullable()
    .optional(),
  credits: z
    .object({
      has_credits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.unknown().nullable(),
    })
    .nullable()
    .optional(),
  plan_type: z.string().nullable().optional(),
});

/**
 * Token usage info.
 */
export const CodexTokenUsageInfoSchema = z.object({
  total_token_usage: z
    .object({
      input_tokens: z.number(),
      cached_input_tokens: z.number().optional(),
      output_tokens: z.number(),
      reasoning_output_tokens: z.number().optional(),
      total_tokens: z.number(),
    })
    .optional(),
  last_token_usage: z
    .object({
      input_tokens: z.number(),
      cached_input_tokens: z.number().optional(),
      output_tokens: z.number(),
      reasoning_output_tokens: z.number().optional(),
      total_tokens: z.number(),
    })
    .optional(),
  model_context_window: z.number().optional(),
});

/**
 * User message event.
 */
export const CodexUserMessageEventSchema = z.object({
  type: z.literal("user_message"),
  message: z.string(),
  images: z.array(z.unknown()).optional(),
});

/**
 * Agent message event.
 */
export const CodexAgentMessageEventSchema = z.object({
  type: z.literal("agent_message"),
  message: z.string(),
});

/**
 * Agent reasoning event (summary of thinking).
 */
export const CodexAgentReasoningEventSchema = z.object({
  type: z.literal("agent_reasoning"),
  text: z.string(),
});

/**
 * Token count event.
 */
export const CodexTokenCountEventSchema = z.object({
  type: z.literal("token_count"),
  info: CodexTokenUsageInfoSchema.nullable(),
  rate_limits: CodexRateLimitsSchema.nullable().optional(),
});

/**
 * Context compacted event.
 */
export const CodexContextCompactedEventSchema = z.object({
  type: z.literal("context_compacted"),
});

/**
 * Generic item completion event.
 */
export const CodexItemCompletedEventSchema = z
  .object({
    type: z.literal("item_completed"),
    thread_id: z.string().optional(),
    turn_id: z.string().optional(),
    item: z.unknown().optional(),
  })
  .passthrough();

export const CodexImageGenerationEndEventSchema = z
  .object({
    type: z.literal("image_generation_end"),
    ...CodexImageGenerationPayloadFields,
  })
  .passthrough();

/**
 * Turn aborted event.
 */
export const CodexTurnAbortedEventSchema = z
  .object({
    type: z.literal("turn_aborted"),
    reason: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type CodexTurnAbortedEvent = z.infer<typeof CodexTurnAbortedEventSchema>;

/**
 * Thread rolled back event.
 *
 * Codex CLI backtrack (Esc Esc) appends this marker to the rollout file after
 * `thread/rollback`. The previous response_item/event_msg lines remain on
 * disk; readers must apply the marker when deriving the visible conversation.
 */
export const CodexThreadRolledBackEventSchema = z
  .object({
    type: z.literal("thread_rolled_back"),
    num_turns: z.number().int().nonnegative(),
  })
  .passthrough();

export type CodexThreadRolledBackEvent = z.infer<
  typeof CodexThreadRolledBackEventSchema
>;

/**
 * Task started event - emitted at the beginning of an agent turn.
 */
export const CodexTaskStartedEventSchema = z.object({
  type: z.literal("task_started"),
  turn_id: z.string(),
  model_context_window: z.number(),
  collaboration_mode_kind: z.string(),
});

/**
 * Task complete event - emitted when an agent turn finishes.
 */
export const CodexTaskCompleteEventSchema = z.object({
  type: z.literal("task_complete"),
  turn_id: z.string(),
  last_agent_message: z.string().nullable(),
});

/**
 * Union of event message types.
 */
export const CodexEventMsgPayloadSchema = z.discriminatedUnion("type", [
  CodexUserMessageEventSchema,
  CodexAgentMessageEventSchema,
  CodexAgentReasoningEventSchema,
  CodexTokenCountEventSchema,
  CodexContextCompactedEventSchema,
  CodexItemCompletedEventSchema,
  CodexImageGenerationEndEventSchema,
  CodexTurnAbortedEventSchema,
  CodexThreadRolledBackEventSchema,
  CodexTaskStartedEventSchema,
  CodexTaskCompleteEventSchema,
]);

export type CodexEventMsgPayload = z.infer<typeof CodexEventMsgPayloadSchema>;

export const CodexEventMsgEntrySchema = z.object({
  timestamp: z.string(),
  type: z.literal("event_msg"),
  payload: CodexEventMsgPayloadSchema,
});

export type CodexEventMsgEntry = z.infer<typeof CodexEventMsgEntrySchema>;

// =============================================================================
// Compaction Entries
// =============================================================================

/**
 * Compaction payload for persisted replacement history snapshots.
 */
export const CodexCompactedPayloadSchema = z
  .object({
    message: z.string().optional(),
    replacement_history: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type CodexCompactedPayload = z.infer<typeof CodexCompactedPayloadSchema>;

export const CodexCompactedEntrySchema = z.object({
  timestamp: z.string(),
  type: z.literal("compacted"),
  payload: CodexCompactedPayloadSchema,
});

export type CodexCompactedEntry = z.infer<typeof CodexCompactedEntrySchema>;

// =============================================================================
// Turn Context
// =============================================================================

/**
 * Sandbox policy configuration.
 */
export const CodexSandboxPolicySchema = z.object({
  type: z.string(),
  network_access: z.boolean().optional(),
  exclude_tmpdir_env_var: z.boolean().optional(),
  exclude_slash_tmp: z.boolean().optional(),
});

/**
 * Turn context payload - sent at the start/end of turns.
 */
export const CodexTurnContextPayloadSchema = z
  .object({
    cwd: z.string(),
    approval_policy: z.string(),
    sandbox_policy: CodexSandboxPolicySchema.optional(),
    model: z.string().optional(),
    effort: z.string().nullable().optional(),
    service_tier: z.string().nullable().optional(),
    serviceTier: z.string().nullable().optional(),
    collaboration_mode: z
      .object({
        mode: z.string().optional(),
        settings: z
          .object({
            model: z.string().nullable().optional(),
            reasoning_effort: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    summary: z.string().optional(),
  })
  .passthrough();

export type CodexTurnContextPayload = z.infer<
  typeof CodexTurnContextPayloadSchema
>;

export const CodexTurnContextEntrySchema = z.object({
  timestamp: z.string(),
  type: z.literal("turn_context"),
  payload: CodexTurnContextPayloadSchema,
});

export type CodexTurnContextEntry = z.infer<typeof CodexTurnContextEntrySchema>;

// =============================================================================
// Session Entry Union
// =============================================================================

/**
 * Union of all session file entry types.
 * Use this for parsing individual JSONL lines from ~/.codex/sessions/.
 */
export const CodexSessionEntrySchema = z.discriminatedUnion("type", [
  CodexSessionMetaEntrySchema,
  CodexResponseItemEntrySchema,
  CodexEventMsgEntrySchema,
  CodexCompactedEntrySchema,
  CodexTurnContextEntrySchema,
]);

export type CodexSessionEntry = z.infer<typeof CodexSessionEntrySchema>;

/**
 * Parse a JSONL line from a Codex session file.
 * Returns null if parsing fails.
 */
export function parseCodexSessionEntry(line: string): CodexSessionEntry | null {
  try {
    const json = JSON.parse(line);
    const result = CodexSessionEntrySchema.safeParse(json);
    if (result.success) {
      return result.data;
    }
    // Return raw JSON for forward compatibility with unknown types
    if (json && typeof json === "object" && "type" in json) {
      return json as CodexSessionEntry;
    }
    return null;
  } catch {
    return null;
  }
}

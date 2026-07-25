/**
 * Kimi Code CLI session schema.
 *
 * Kimi persists sessions to
 *   ~/.kimi-code/sessions/<workspace>/session_<uuid>/agents/<agentId>/wire.jsonl
 * plus a sibling `state.json` with title / timestamps / workDir.
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
    .object({ output: z.string().optional(), note: z.string().optional() })
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

/** `config.update` carrying the resolved model alias + thinking effort. */
export const KimiModelConfigRecordSchema = z.object({
  type: z.literal("config.update"),
  modelAlias: z.string(),
  thinkingEffort: z.string().optional(),
  time: z.number().optional(),
});

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

export const KimiUsageRecordSchema = z.object({
  type: z.literal("usage.record"),
  time: z.number().optional(),
});

/** Discriminated where possible; unknown record types pass through. */
export type KimiWireRecord =
  | z.infer<typeof KimiMetadataRecordSchema>
  | z.infer<typeof KimiModelConfigRecordSchema>
  | z.infer<typeof KimiTurnPromptRecordSchema>
  | z.infer<typeof KimiLoopEventRecordSchema>
  | z.infer<typeof KimiUsageRecordSchema>
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
  records: KimiWireRecord[];
}

/** state.json alongside the agent wire logs. */
export const KimiSessionStateSchema = z
  .object({
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    title: z.string().optional(),
    isCustomTitle: z.boolean().optional(),
    workDir: z.string().optional(),
  })
  .passthrough();
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
      const r = KimiModelConfigRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "turn.prompt": {
      const r = KimiTurnPromptRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "context.append_loop_event": {
      const r = KimiLoopEventRecordSchema.safeParse(raw);
      return r.success ? r.data : raw;
    }
    case "usage.record": {
      const r = KimiUsageRecordSchema.safeParse(raw);
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

/** Extract concatenated text from a `turn.prompt.input` array. */
export function getKimiPromptText(input: readonly unknown[]): string {
  return input
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
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

export function isKimiModelConfigRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiModelConfigRecordSchema> {
  return record.type === "config.update" && "modelAlias" in record;
}

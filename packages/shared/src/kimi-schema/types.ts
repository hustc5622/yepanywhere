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
  /**
   * Absolute path to the agent's `blobs/` directory, used to resolve
   * `blobref:<mime>;<sha256>` image parts to real files. Absent when the
   * session was not loaded from disk.
   */
  blobsDir?: string;
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

function isKimiInjectedSystemText(text: string): boolean {
  return KIMI_SYSTEM_PART_RE.test(text.trim());
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
        const text = (part as { text: string }).text;
        return isKimiInjectedSystemText(text) ? "" : text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
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

export function isKimiModelConfigRecord(
  record: KimiWireRecord,
): record is z.infer<typeof KimiModelConfigRecordSchema> {
  return record.type === "config.update" && "modelAlias" in record;
}

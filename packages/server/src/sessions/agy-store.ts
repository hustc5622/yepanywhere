/**
 * Antigravity CLI (`agy`) on-disk session store (read-only).
 *
 * Layout under `~/.gemini/antigravity-cli/` (see references/antigravity):
 * - `conversation_summaries.db`: SQLite catalog (`conversation_summaries`).
 * - `brain/<id>/.system_generated/logs/transcript_full.jsonl`: one JSON step
 *   per line (`step_index`, `type`, `content`, `tool_calls`, ...). The
 *   non-`_full` transcript double-encodes tool args and may truncate.
 * - `conversations/<id>.db`: protobuf trajectory store; Yep only scans its
 *   step blobs for the ACP tool call ids (`call_<digits>`) so persisted tool
 *   rows reuse the ids the live ACP stream emitted.
 *
 * Yep never writes any of these files; mutations go through `agy acp`.
 */

import { realpathSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiCompactionEntry,
  PiContentBlock,
  PiImageContent,
  PiMessageEntry,
  PiSessionContent,
  PiSessionEntry,
  PiTextContent,
  PiUsage,
} from "@yep-anywhere/shared";
import { PI_THINKING_PREVIEW_MAX_LENGTH } from "@yep-anywhere/shared";
import {
  getAgySideSessionRegistry,
  isHiddenAgySideSession,
} from "../side-conversations/agy-registry.js";
import { withSqliteDatabase } from "../sqlite/query.js";
import type { Message } from "../supervisor/types.js";
import {
  canonicalizeAgyToolName,
  cleanAgyToolOutput,
  normalizeAgyToolArguments,
  readAgyToolTiming,
} from "./agy-tools.js";

/**
 * agy's app data directory. `AGY_DATA_DIR` is a Yep-only override for tests
 * and diagnostics; agy itself defaults to `~/.gemini/antigravity-cli`.
 */
export function resolveAgyDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.AGY_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);
  return join(homedir(), ".gemini", "antigravity-cli");
}

export const AGY_DATA_DIR = resolveAgyDataDir();
/** Per-conversation working directories; transcripts live below (watched). */
export const AGY_BRAIN_DIR = join(AGY_DATA_DIR, "brain");
export const AGY_SUMMARIES_DB_PATH = join(
  AGY_DATA_DIR,
  "conversation_summaries.db",
);
export const AGY_CONVERSATIONS_DIR = join(AGY_DATA_DIR, "conversations");

export interface AgyStoreOptions {
  dataDir?: string;
  /**
   * Conversations that only back a Yep side conversation stay out of every
   * listing (default: the shared side-conversation registry).
   */
  isHidden?: (sessionId: string) => boolean;
}

export interface AgySessionRecord {
  sessionId: string;
  cwd: string;
  title: string | null;
  preview: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** `CASCADE_RUN_STATUS_IDLE`, `..._RUNNING`, ... */
  status: string | null;
  stepCount: number;
  transcriptPath: string;
  conversationDbPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function paths(dataDir: string) {
  return {
    summariesDb: join(dataDir, "conversation_summaries.db"),
    brainDir: join(dataDir, "brain"),
    conversationsDir: join(dataDir, "conversations"),
  };
}

export function agyTranscriptPath(
  sessionId: string,
  dataDir: string = AGY_DATA_DIR,
): string {
  return join(
    dataDir,
    "brain",
    sessionId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
}

/**
 * Parse agy's Go-formatted datetimes (`2026-11-21 08:58:04.649217+00:00`).
 * The zero time (`0001-01-01 …`) means "never" and maps to null.
 */
export function parseAgyTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (value.startsWith("0001-01-01")) return null;
  const iso = value
    .trim()
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Pick the conversation's project directory from `workspace_uris`.
 *
 * agy records both the resolved and the requested path when they differ
 * (`/private/tmp/x` and `/tmp/x`), in either order. Prefer the requested
 * (symlinked) spelling — that is the path a user and Yep's project list know
 * — and otherwise the first workspace; extra `--add-dir` roots follow it.
 */
export function pickAgyWorkspace(raw: unknown): string | null {
  let uris: unknown;
  try {
    uris = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!Array.isArray(uris)) return null;
  const pathsList = uris.flatMap((uri): string[] => {
    if (typeof uri !== "string") return [];
    if (!uri.startsWith("file://")) return uri.startsWith("/") ? [uri] : [];
    try {
      return [fileURLToPath(uri)];
    } catch {
      return [];
    }
  });
  const first = pathsList[0];
  if (!first) return null;
  const firstReal = realpathOrSelf(first);
  const spellings = pathsList.filter(
    (candidate) => realpathOrSelf(candidate) === firstReal,
  );
  return (
    spellings.find((candidate) => realpathOrSelf(candidate) !== candidate) ??
    first
  );
}

const AGY_SESSION_SELECT = `SELECT conversation_id, title, preview, step_count,
                  last_modified_time, last_user_input_time, workspace_uris, status
             FROM conversation_summaries
            WHERE parent_conversation_id = ''
              AND step_count > 0`;

function toRecord(
  row: Record<string, unknown>,
  dataDir: string,
): AgySessionRecord | null {
  const sessionId = asString(row.conversation_id);
  const cwd = pickAgyWorkspace(row.workspace_uris);
  if (!sessionId || !cwd) return null;
  const updatedAtMs =
    parseAgyTime(row.last_modified_time) ??
    parseAgyTime(row.last_user_input_time) ??
    0;
  const { conversationsDir } = paths(dataDir);
  return {
    sessionId,
    cwd,
    title: asString(row.title),
    preview: asString(row.preview),
    // The catalog has no creation time; the transcript's first step does.
    createdAtMs: updatedAtMs,
    updatedAtMs,
    status: asString(row.status),
    stepCount: asNumber(row.step_count) ?? 0,
    transcriptPath: agyTranscriptPath(sessionId, dataDir),
    conversationDbPath: join(conversationsDir, `${sessionId}.db`),
  };
}

/** List user-facing root conversations (subagent runs excluded). */
export async function listAgySessionRecords(
  options: AgyStoreOptions = {},
): Promise<AgySessionRecord[]> {
  const dataDir = options.dataDir ?? AGY_DATA_DIR;
  const rows = await withSqliteDatabase<Record<string, unknown>[]>(
    paths(dataDir).summariesDb,
    [],
    (db) =>
      db
        .prepare(`${AGY_SESSION_SELECT} ORDER BY last_modified_time DESC`)
        .all(),
  );
  const hidden = options.isHidden
    ? null
    : getAgySideSessionRegistry().hiddenIds();
  const isHidden = options.isHidden ?? ((id: string) => !!hidden?.has(id));
  return rows.flatMap((row) => {
    const record = toRecord(row, dataDir);
    return record && !isHidden(record.sessionId) ? [record] : [];
  });
}

export async function findAgySessionRecord(
  sessionId: string,
  options: AgyStoreOptions = {},
): Promise<AgySessionRecord | null> {
  const dataDir = options.dataDir ?? AGY_DATA_DIR;
  if ((options.isHidden ?? isHiddenAgySideSession)(sessionId)) return null;
  const row = await withSqliteDatabase<Record<string, unknown> | undefined>(
    paths(dataDir).summariesDb,
    undefined,
    (db) =>
      db
        .prepare(`${AGY_SESSION_SELECT} AND conversation_id = ?`)
        .get(sessionId),
  );
  return row ? toRecord(row, dataDir) : null;
}

export async function getAgyTranscriptStats(
  transcriptPath: string,
): Promise<{ mtime: number; size: number } | null> {
  try {
    const info = await stat(transcriptPath);
    return { mtime: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

/** Session id for a watched path under `brain/<id>/...`. */
export function agySessionIdFromWatchPath(filePath: string): string | null {
  const match =
    /(?:^|[\\/])brain[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\/]|$)/i.exec(
      filePath,
    ) ??
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\/]|$)/i.exec(
      filePath,
    );
  return match?.[1] ?? null;
}

const CALL_ID_RE = /call_\d{6,}/g;

function blobText(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("latin1");
  return typeof value === "string" ? value : "";
}

/**
 * ACP tool call ids per step, read from the conversation's protobuf store.
 * A PLANNER_RESPONSE step lists its calls in order; a tool-result step holds
 * its own call id. Best effort: an unreadable store yields an empty map and
 * the transcript falls back to synthesized ids.
 */
export async function readAgyStepCallIds(
  conversationDbPath: string,
): Promise<Map<number, string[]>> {
  const rows = await withSqliteDatabase<Record<string, unknown>[]>(
    conversationDbPath,
    [],
    (db) => db.prepare("SELECT idx, step_payload FROM steps").all(),
  );
  const result = new Map<number, string[]>();
  for (const row of rows) {
    const idx = asNumber(row.idx);
    if (idx === null) continue;
    const ids: string[] = [];
    for (const match of blobText(row.step_payload).matchAll(CALL_ID_RE)) {
      if (!ids.includes(match[0])) ids.push(match[0]);
    }
    if (ids.length > 0) result.set(idx, ids);
  }
  return result;
}

export interface AgyTranscriptStep {
  stepIndex: number;
  type: string;
  source?: string;
  status?: string;
  createdAt?: string;
  content?: string;
  error?: string;
  thinking?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  media: Array<{ mimeType: string; uri: string }>;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

function readArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Parse transcript lines; the last line may be torn while agy appends. */
export function parseAgyTranscriptSteps(raw: string): AgyTranscriptStep[] {
  const byIndex = new Map<number, AgyTranscriptStep>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    const stepIndex = asNumber(row.step_index);
    const type = asString(row.type);
    if (stepIndex === null || !type) continue;
    byIndex.set(stepIndex, {
      stepIndex,
      type,
      source: asString(row.source) ?? undefined,
      status: asString(row.status) ?? undefined,
      createdAt: asString(row.created_at) ?? undefined,
      content: typeof row.content === "string" ? row.content : undefined,
      error: typeof row.error === "string" ? row.error : undefined,
      thinking: typeof row.thinking === "string" ? row.thinking : undefined,
      model: asString(row.model) ?? undefined,
      inputTokens: asNumber(row.input_tokens) ?? undefined,
      outputTokens: asNumber(row.output_tokens) ?? undefined,
      cacheReadTokens: asNumber(row.cache_read_tokens) ?? undefined,
      media: (Array.isArray(row.media) ? row.media : []).flatMap((item) =>
        isRecord(item) && typeof item.uri === "string"
          ? [
              {
                uri: item.uri,
                mimeType:
                  typeof item.mime_type === "string"
                    ? item.mime_type
                    : "image/png",
              },
            ]
          : [],
      ),
      toolCalls: (Array.isArray(row.tool_calls) ? row.tool_calls : []).flatMap(
        (call) =>
          isRecord(call) && typeof call.name === "string"
            ? [{ name: call.name, args: readArgs(call.args) }]
            : [],
      ),
    });
  }
  return [...byIndex.values()].sort((a, b) => a.stepIndex - b.stepIndex);
}

/** The newest transcript step, as far as it matters for turn liveness. */
export interface AgyTranscriptTail {
  stepIndex: number;
  type: string;
  /**
   * agy handed control back: a planner response with no tool call (the
   * turn's answer, or a progress note before waiting on background work),
   * or an error. Anything else means the agent is still working.
   */
  yielded: boolean;
}

/** A step that ends agy's work until something wakes it again. */
export function isAgyYieldStep(
  step: Pick<AgyTranscriptStep, "type" | "toolCalls">,
): boolean {
  return (
    (step.type === "PLANNER_RESPONSE" && step.toolCalls.length === 0) ||
    step.type === "ERROR_MESSAGE"
  );
}

/**
 * Read only the end of an agy transcript. Liveness checks run while agy is
 * working, against transcripts that grow to megabytes.
 */
export async function readAgyTranscriptTail(
  transcriptPath: string,
  maxBytes = 256 * 1024,
): Promise<AgyTranscriptTail | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(transcriptPath, "r");
    const { size } = await handle.stat();
    if (size === 0) return null;
    // One step can be large (a long tool output); widen until one parses.
    for (let window = maxBytes; ; window *= 4) {
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      let text = buffer.toString("utf8");
      // A window that starts mid-line drops its torn first line.
      if (length < size) text = text.slice(text.indexOf("\n") + 1);
      const last = parseAgyTranscriptSteps(text).at(-1);
      if (last) {
        return {
          stepIndex: last.stepIndex,
          type: last.type,
          yielded: isAgyYieldStep(last),
        };
      }
      if (length >= size || window >= 64 * 1024 * 1024) return null;
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The text the user typed. agy wraps prompts as
 * `<USER_REQUEST>…</USER_REQUEST><ADDITIONAL_METADATA>…` (plus optional
 * `<USER_SETTINGS_CHANGE>` / attachment notes).
 */
export function readAgyUserText(content: string | undefined): string {
  if (!content) return "";
  const match = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/u.exec(content);
  if (match) return match[1] ?? "";
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gu, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gu, "")
    .trim();
}

export interface AgyTranscriptOptions {
  deferMedia?: boolean;
  deferThinking?: boolean;
  /**
   * Read ACP tool call ids from the conversation store (default true).
   * Summaries skip it: ids only matter for reconciling live tool rows.
   */
  resolveCallIds?: boolean;
}

function usageOf(step: AgyTranscriptStep): PiUsage | undefined {
  if (
    step.inputTokens === undefined &&
    step.outputTokens === undefined &&
    step.cacheReadTokens === undefined
  ) {
    return undefined;
  }
  const input = step.inputTokens ?? 0;
  const output = step.outputTokens ?? 0;
  const cacheRead = step.cacheReadTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
  };
}

function timestampOf(step: AgyTranscriptStep, fallbackMs: number): number {
  const parsed = step.createdAt ? Date.parse(step.createdAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

async function loadImage(
  media: { mimeType: string; uri: string },
  deferMedia: boolean,
): Promise<PiImageContent | null> {
  if (deferMedia) {
    return {
      type: "image",
      data: "",
      mimeType: media.mimeType,
      deferred: true,
    };
  }
  try {
    const path = media.uri.startsWith("file://")
      ? fileURLToPath(media.uri)
      : media.uri;
    const data = (await readFile(path)).toString("base64");
    return { type: "image", data, mimeType: media.mimeType };
  } catch {
    return null;
  }
}

/**
 * Message id of one transcript step. Step indexes restart in every
 * conversation and a native fork keeps its source's indexes, so the id is
 * qualified by the conversation: an edit-fork family is shown as one
 * branch tree and needs ids that stay unique across its sessions.
 */
export function agyStepEntryId(sessionId: string, stepIndex: number): string {
  return `agy-${sessionId}-step-${stepIndex}`;
}

const AGY_STEP_ENTRY_ID = /^agy-(?:(.+)-)?step-(\d+)$/u;

/**
 * Inverse of {@link agyStepEntryId}. Also accepts the unqualified
 * `agy-step-<n>` ids older Yep builds produced (`sessionId: null`).
 */
export function parseAgyStepEntryId(
  id: string,
): { sessionId: string | null; stepIndex: number } | null {
  const match = AGY_STEP_ENTRY_ID.exec(id);
  if (!match) return null;
  const stepIndex = Number(match[2]);
  if (!Number.isSafeInteger(stepIndex)) return null;
  return { sessionId: match[1] ?? null, stepIndex };
}

/**
 * Convert agy steps into a linear Pi session so Pi's transcript projection
 * and tool renderers can be reused.
 */
export async function buildAgyPiSession(
  steps: readonly AgyTranscriptStep[],
  header: { sessionId: string; cwd: string; createdAtMs: number },
  callIds: ReadonlyMap<number, readonly string[]>,
  options: AgyTranscriptOptions = {},
): Promise<PiSessionContent> {
  const entries: PiSessionEntry[] = [];
  let parentId: string | null = null;
  const push = (
    id: string,
    timestampMs: number,
    message: PiAgentMessage,
  ): void => {
    const entry: PiMessageEntry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date(timestampMs).toISOString(),
      message,
    };
    entries.push(entry);
    parentId = id;
  };

  /** Calls of the latest planner step still waiting for their result step. */
  let pending: Array<{ id: string; name: string }> = [];
  const callNames = new Map<string, string>();
  let lastTimestamp = header.createdAtMs || Date.now();

  for (const step of steps) {
    const timestampMs = timestampOf(step, lastTimestamp);
    lastTimestamp = timestampMs;
    const entryId = agyStepEntryId(header.sessionId, step.stepIndex);
    switch (step.type) {
      case "USER_INPUT": {
        pending = [];
        const text = readAgyUserText(step.content).trim();
        const images: PiImageContent[] = [];
        for (const media of step.media) {
          if (!media.mimeType.startsWith("image/")) continue;
          const image = await loadImage(media, options.deferMedia === true);
          if (image) images.push(image);
        }
        if (!text && images.length === 0) break;
        const content: Array<PiTextContent | PiImageContent> = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...images,
        ];
        push(entryId, timestampMs, {
          role: "user",
          content,
          timestamp: timestampMs,
        });
        break;
      }
      case "PLANNER_RESPONSE": {
        const blocks: PiContentBlock[] = [];
        const thinking = step.thinking?.trim();
        if (thinking) {
          blocks.push(
            options.deferThinking &&
              thinking.length > PI_THINKING_PREVIEW_MAX_LENGTH
              ? {
                  type: "thinking",
                  thinking: thinking.slice(0, PI_THINKING_PREVIEW_MAX_LENGTH),
                  deferred: true,
                  thinkingLength: thinking.length,
                }
              : { type: "thinking", thinking },
          );
        }
        if (step.content?.trim()) {
          blocks.push({ type: "text", text: step.content });
        }
        const ids = callIds.get(step.stepIndex) ?? [];
        pending = step.toolCalls.map((call, index) => {
          const id = ids[index] ?? `agy-call-${step.stepIndex}-${index}`;
          callNames.set(id, call.name);
          blocks.push({
            type: "toolCall",
            id,
            name: canonicalizeAgyToolName(call.name, call.args),
            arguments: normalizeAgyToolArguments(call.name, call.args),
          });
          return { id, name: call.name };
        });
        if (blocks.length === 0) break;
        const message: PiAssistantMessage = {
          role: "assistant",
          content: blocks,
          provider: "antigravity",
          ...(step.model ? { model: step.model } : {}),
          ...(usageOf(step) ? { usage: usageOf(step) } : {}),
          stopReason: step.toolCalls.length > 0 ? "toolUse" : "stop",
          timestamp: timestampMs,
        };
        push(entryId, timestampMs, message);
        break;
      }
      case "GENERIC": {
        const ownId = callIds.get(step.stepIndex)?.[0];
        let call = ownId
          ? pending.find((candidate) => candidate.id === ownId)
          : undefined;
        if (!call && ownId && callNames.has(ownId)) {
          call = { id: ownId, name: callNames.get(ownId) ?? "tool" };
        }
        call ??= pending[0];
        if (!call) break;
        pending = pending.filter((candidate) => candidate !== call);
        const failed = step.status === "ERROR";
        const raw = failed
          ? (step.error ?? step.content ?? "")
          : (step.content ?? "");
        const text = cleanAgyToolOutput(raw);
        // The step's created_at is when the call was issued, not when it
        // ended; the bookkeeping lines carry both ends.
        const timing = readAgyToolTiming(step.content ?? raw);
        const resultMs = timing.completedAtMs ?? timestampMs;
        push(entryId, resultMs, {
          role: "toolResult",
          toolCallId: call.id,
          toolName: canonicalizeAgyToolName(call.name),
          content: [{ type: "text", text }],
          isError: failed,
          timestamp: resultMs,
          ...(timing.durationMs !== undefined
            ? { durationMs: timing.durationMs }
            : {}),
        });
        break;
      }
      case "CHECKPOINT": {
        pending = [];
        const compaction: PiCompactionEntry = {
          type: "compaction",
          id: entryId,
          parentId,
          timestamp: new Date(timestampMs).toISOString(),
          summary: step.content ?? "Context compacted",
        };
        entries.push(compaction);
        parentId = entryId;
        break;
      }
      case "ERROR_MESSAGE": {
        const errorMessage = (step.error ?? step.content ?? "").trim();
        if (!errorMessage) break;
        push(entryId, timestampMs, {
          role: "assistant",
          content: [],
          provider: "antigravity",
          stopReason: "error",
          errorMessage,
          timestamp: timestampMs,
        });
        break;
      }
      default:
        // SYSTEM_MESSAGE and other runtime plumbing are not conversation.
        break;
    }
  }

  const firstTimestamp = entries[0]?.timestamp;
  return {
    header: {
      type: "session",
      id: header.sessionId,
      timestamp:
        firstTimestamp ??
        new Date(header.createdAtMs || Date.now()).toISOString(),
      cwd: header.cwd,
    },
    entries,
    activeEntries: entries,
  };
}

export async function readAgyTranscript(
  record: Pick<
    AgySessionRecord,
    | "sessionId"
    | "cwd"
    | "createdAtMs"
    | "transcriptPath"
    | "conversationDbPath"
  >,
  options: AgyTranscriptOptions = {},
): Promise<PiSessionContent | null> {
  let raw: string;
  try {
    raw = await readFile(record.transcriptPath, "utf8");
  } catch {
    return null;
  }
  const steps = parseAgyTranscriptSteps(raw);
  const callIds =
    options.resolveCallIds !== false &&
    steps.some((step) => step.toolCalls.length > 0)
      ? await readAgyStepCallIds(record.conversationDbPath)
      : new Map<number, string[]>();
  return buildAgyPiSession(steps, record, callIds, options);
}

/**
 * Mark agy replies addressed to the user as final answers so the display
 * keeps them outside the folded work (like Codex `final_answer`).
 *
 * agy runs one prompt as a chain of planner steps. A step with text and no
 * tool call is where agy yields (the turn's answer, or a pause while
 * background tasks run); text next to `ask_question` is the report the
 * question is about. Text that merely accompanies ordinary tool calls
 * ("let me check X") stays part of the work.
 */
export function annotateAgyReplyPhases(messages: Message[]): Message[] {
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    if (!parseAgyStepEntryId(message.uuid ?? "")) continue;
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;
    const hasText = content.some(
      (block) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0,
    );
    if (!hasText) continue;
    const tools = content.filter((block) => block?.type === "tool_use");
    const repliesToUser =
      tools.length === 0 ||
      tools.some(
        (block) => (block as { name?: unknown }).name === "AskUserQuestion",
      );
    if (repliesToUser) message.codexMessagePhase = "final_answer";
  }
  return messages;
}

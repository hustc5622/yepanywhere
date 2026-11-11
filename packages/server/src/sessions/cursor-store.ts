/**
 * Read a Cursor ACP session from `~/.cursor/acp-sessions/<id>/`.
 *
 * `meta.json` holds cwd and title. `store.db` is a content-addressed blob
 * store: `meta` key `0` is hex-encoded JSON naming `latestRootBlobId`, and
 * that blob is a protobuf node whose 32-byte children are either JSON chat
 * messages or further protobuf nodes. Assistant text lives on the JSON
 * `assistant` blobs; system and `<user_info>` preamble blobs are skipped.
 *
 * After a context compaction the root keeps the post-compaction conversation
 * in field 1 and the pre-compaction history in a field-13 record (its own
 * field 1 messages plus the summary blob in field 4). The record is walked
 * first so history reads chronologically; the prompt Cursor repeats after
 * the summary dedupes by blob id, and the summary becomes a compaction row.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ContextUsage,
  CursorTranscriptMessage,
} from "@yep-anywhere/shared";
import { withSqliteDatabase } from "../sqlite/query.js";
import { readCursorContextUsage } from "./cursor-context-usage.js";

export interface CursorSessionDiskMeta {
  schemaVersion?: number;
  cwd: string;
  title?: string;
}

export interface CursorStoredSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: CursorTranscriptMessage[];
  contextUsage?: ContextUsage;
}

interface StoreMeta {
  latestRootBlobId?: string;
  createdAt?: number;
  name?: string;
}

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const CONVERSATION_SUMMARY_RE =
  /^\s*<conversation_summary>\s*([\s\S]*?)\s*(?:<\/conversation_summary>\s*)?$/;
/** Root field holding a compacted (pre-summary) history record. */
const COMPACTION_RECORD_FIELD = 13;

/** SQLite commits usually change the WAL while store.db itself stays unchanged. */
export async function getCursorSessionFileStats(
  sessionDir: string,
): Promise<{ mtime: number; size: number } | null> {
  try {
    const db = await stat(join(sessionDir, "store.db"));
    const extras = await Promise.all(
      ["store.db-wal", "meta.json"].map((name) =>
        stat(join(sessionDir, name)).catch(() => null),
      ),
    );
    const files = [db, ...extras.filter((file) => file !== null)];
    return {
      mtime: Math.max(...files.map((file) => file.mtimeMs)),
      size: files.reduce((sum, file) => sum + file.size, 0),
    };
  } catch {
    return null;
  }
}

export function parseCursorMetaJson(raw: string): CursorSessionDiskMeta | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const cwd = (parsed as { cwd?: unknown }).cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    const title = (parsed as { title?: unknown }).title;
    return {
      schemaVersion: (parsed as { schemaVersion?: unknown }).schemaVersion as
        | number
        | undefined,
      cwd,
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
    };
  } catch {
    return null;
  }
}

export async function readCursorSessionDir(
  sessionDir: string,
): Promise<CursorStoredSession | null> {
  const sessionId = sessionDir.split("/").at(-1) ?? "";
  let meta: CursorSessionDiskMeta | null = null;
  try {
    meta = parseCursorMetaJson(
      await readFile(join(sessionDir, "meta.json"), "utf8"),
    );
  } catch {
    return null;
  }
  if (!meta || !sessionId) return null;

  const dbPath = join(sessionDir, "store.db");
  const stored = await withSqliteDatabase(dbPath, null, (db) => readStore(db));
  if (!stored) return null;
  let updatedAt = stored.createdAt;
  try {
    const stats = await getCursorSessionFileStats(sessionDir);
    if (stats) updatedAt = new Date(stats.mtime).toISOString();
  } catch {
    // Keep the store's createdAt when the file disappears mid-read.
  }

  return {
    sessionId,
    cwd: meta.cwd,
    title: meta.title ?? stored.name,
    createdAt: stored.createdAt,
    updatedAt,
    messages: stored.messages,
    contextUsage: stored.contextUsage,
  };
}

interface StoreRead {
  name: string | null;
  createdAt: string;
  messages: CursorTranscriptMessage[];
  contextUsage?: ContextUsage;
}

function readStore(db: {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}): StoreRead | null {
  const metaRow = db.prepare("SELECT value FROM meta WHERE key = ?").get("0");
  const value = metaRow?.value;
  if (typeof value !== "string" || value.length === 0) return null;
  let storeMeta: StoreMeta;
  try {
    const json = Buffer.from(value, "hex").toString("utf8");
    storeMeta = JSON.parse(json) as StoreMeta;
  } catch {
    return null;
  }
  const root = storeMeta.latestRootBlobId;
  if (!root) return null;

  const blobs = new Map<string, Buffer>();
  for (const row of db.prepare("SELECT id, data FROM blobs").all()) {
    const id = row.id;
    const data = row.data;
    if (typeof id !== "string") continue;
    if (Buffer.isBuffer(data)) blobs.set(id, data);
    else if (data instanceof Uint8Array) blobs.set(id, Buffer.from(data));
  }

  const messages: CursorTranscriptMessage[] = [];
  walkBlob(root, blobs, new Set(), messages, 0);
  const rootData = blobs.get(root);

  const createdMs =
    typeof storeMeta.createdAt === "number" ? storeMeta.createdAt : Date.now();
  return {
    name: typeof storeMeta.name === "string" ? storeMeta.name : null,
    createdAt: new Date(createdMs).toISOString(),
    messages,
    contextUsage: rootData ? readCursorContextUsage(rootData) : undefined,
  };
}

function walkBlob(
  id: string,
  blobs: Map<string, Buffer>,
  seen: Set<string>,
  out: CursorTranscriptMessage[],
  depth: number,
): void {
  if (depth > 64 || seen.has(id)) return;
  seen.add(id);
  const data = blobs.get(id);
  if (!data || data.length === 0 || data.length > 2_000_000) return;

  if (data[0] === 0x7b) {
    const message = transcriptFromJsonBlob(id, data);
    if (message) out.push(message);
    return;
  }

  const children = protobufDigestFields(data);
  const ordered = [
    ...children.filter((child) => child.field === COMPACTION_RECORD_FIELD),
    ...children.filter((child) => child.field !== COMPACTION_RECORD_FIELD),
  ];
  for (const child of ordered) {
    if (blobs.has(child.id)) walkBlob(child.id, blobs, seen, out, depth + 1);
  }
}

function transcriptFromJsonBlob(
  id: string,
  data: Buffer,
): CursorTranscriptMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const role = (parsed as { role?: unknown }).role;
  const content = (parsed as { content?: unknown }).content;
  if (role === "user") {
    const summary = flattenText(content).match(CONVERSATION_SUMMARY_RE);
    if (summary) {
      return {
        id: `cursor-${id.slice(0, 12)}`,
        role: "compaction",
        text: summary[1]?.trim() ?? "",
      };
    }
    const text = extractUserText(content);
    if (!text) return null;
    return { id: `cursor-${id.slice(0, 12)}`, role: "user", text };
  }
  if (role === "assistant") {
    const extracted = extractAssistant(content);
    const blocks = extractBlocks(content);
    if (!extracted && !blocks.length) return null;
    return {
      id: `cursor-${id.slice(0, 12)}`,
      role: "assistant",
      text: extracted?.text ?? "",
      ...(extracted?.reasoning ? { reasoning: extracted.reasoning } : {}),
      ...(blocks.some((block) => block.type === "tool_use") ? { blocks } : {}),
    };
  }
  if (role === "tool") {
    const blocks = extractBlocks(content, parsed as Record<string, unknown>);
    if (!blocks.length) return null;
    return { id: `cursor-${id.slice(0, 12)}`, role: "tool", text: "", blocks };
  }
  return null;
}

function extractBlocks(
  content: unknown,
  message?: Record<string, unknown>,
): NonNullable<CursorTranscriptMessage["blocks"]> {
  if (!Array.isArray(content)) return [];
  const blocks: NonNullable<CursorTranscriptMessage["blocks"]> = [];
  for (const value of content) {
    if (!value || typeof value !== "object") continue;
    const part = value as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string")
      blocks.push({ type: "text", text: part.text });
    if (
      (part.type === "reasoning" || part.type === "thinking") &&
      typeof part.text === "string" &&
      part.text
    )
      blocks.push({ type: "thinking", thinking: part.text });
    if (
      part.type === "tool-call" &&
      typeof part.toolCallId === "string" &&
      typeof part.toolName === "string"
    ) {
      const input =
        part.args && typeof part.args === "object" && !Array.isArray(part.args)
          ? { ...(part.args as Record<string, unknown>) }
          : {};
      if (typeof input.path === "string" && input.file_path === undefined)
        input.file_path = input.path;
      if (
        part.toolName === "Write" &&
        typeof input.contents === "string" &&
        input.content === undefined
      )
        input.content = input.contents;
      blocks.push({
        type: "tool_use",
        id: part.toolCallId,
        name: part.toolName === "Shell" ? "Bash" : part.toolName,
        input,
      });
    }
    if (part.type === "tool-result" && typeof part.toolCallId === "string") {
      const native = (
        message?.providerOptions as
          | {
              cursor?: {
                highLevelToolCallResult?: {
                  isError?: boolean;
                  output?: { failure?: unknown };
                };
              };
            }
          | undefined
      )?.cursor?.highLevelToolCallResult;
      const isError =
        part.isError === true ||
        native?.isError === true ||
        native?.output?.failure !== undefined;
      blocks.push({
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content:
          typeof part.result === "string"
            ? part.result
            : JSON.stringify(part.result ?? ""),
        ...(isError ? { is_error: true } : {}),
      });
    }
  }
  return blocks;
}

function extractUserText(content: unknown): string | null {
  const raw = flattenText(content);
  if (!raw) return null;
  const query = raw.match(USER_QUERY_RE);
  if (query?.[1]?.trim()) return query[1].trim();
  if (raw.includes("<user_info>") || raw.includes("<timestamp>")) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractAssistant(
  content: unknown,
): { text: string; reasoning?: string } | null {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? { text } : null;
  }
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  const reasoning: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const type = (part as { type?: unknown }).type;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    if (type === "reasoning" || type === "thinking")
      reasoning.push(text.trim());
    else if (type === "text" || type === undefined) texts.push(text);
  }
  if (texts.length === 0 && reasoning.length === 0) return null;
  return {
    text: texts.join(""),
    ...(reasoning.length > 0 ? { reasoning: reasoning.join("") } : {}),
  };
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** Length-delimited protobuf fields whose payload is a 32-byte blob digest. */
export function protobufDigestChildren(data: Buffer): string[] {
  return protobufDigestFields(data).map((child) => child.id);
}

function protobufDigestFields(
  data: Buffer,
): Array<{ field: number; id: string }> {
  const children: Array<{ field: number; id: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    if (!tag) break;
    offset = tag.next;
    const wire = tag.value % 8;
    if (wire === 0) {
      const value = readVarint(data, offset);
      if (!value) break;
      offset = value.next;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      continue;
    }
    if (wire !== 2) break;
    const length = readVarint(data, offset);
    if (!length) break;
    offset = length.next;
    // Lengths are unsigned, so this keeps `end` inside the blob and ahead of
    // `offset`: every iteration moves forward.
    if (length.value > data.length - offset) break;
    const end = offset + length.value;
    const chunk = data.subarray(offset, end);
    if (chunk.length === 32)
      children.push({
        field: Math.floor(tag.value / 8),
        id: Buffer.from(chunk).toString("hex"),
      });
    offset = end;
  }
  return children;
}

/**
 * Unsigned varint as a safe integer, or null when truncated or wider than
 * 2^53. Bitwise shifts would wrap the fifth byte into a negative int32.
 */
function readVarint(
  data: Buffer,
  offset: number,
): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  for (let index = offset; index < data.length && index < offset + 8; index++) {
    const byte = data[index] as number;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0)
      return Number.isSafeInteger(value) ? { value, next: index + 1 } : null;
    scale *= 0x80;
  }
  return null;
}

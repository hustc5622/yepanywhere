/**
 * DeepSeek Harness (`dsh`) on-disk session store — strictly read-only.
 *
 * dsh keeps one directory per session under `$DSH_HOME/sessions`:
 *
 *   <sessions>/<encoded-cwd>/<session-id>/session.v<N>.jsonl.zstd
 *
 * The artifact is a concatenation of independent, checksummed Zstandard
 * frames: one frame for the header line, then one frame per durable append
 * batch. Older format generations stay beside the current one, so the reader
 * always picks the highest version present. A write in progress can leave a
 * torn final frame; only structurally complete frames are decoded.
 *
 * Upstream references (read-only, `references/dsh/`):
 * - packages/session/session-persistence-jsonl/src/zstd.ts (frame layout)
 * - packages/session/session-persistence-jsonl/README.md (layout, locking)
 * - packages/core/session/src/types.ts (event vocabulary)
 * - packages/llm/llm/src/{types,message}.ts (content blocks, message sources)
 * - packages/util/home-paths/src/index.ts (`$DSH_HOME` resolution)
 *
 * Yep never writes these files. dsh holds a kernel `flock` on `session.lock`
 * for its single writer; readers never touch the lock.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiContentBlock,
  PiImageContent,
  PiSessionContent,
  PiSessionEntry,
  PiTextContent,
  PiUsage,
} from "@yep-anywhere/shared";

/** Resolve `$DSH_HOME` like dsh does: a blank override counts as unset. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_HOME?.trim();
  if (explicit) {
    if (explicit === "~") return homedir();
    if (explicit.startsWith("~/")) return join(homedir(), explicit.slice(2));
    return explicit;
  }
  return join(homedir(), ".dsh");
}

export const DSH_HOME = resolveDshHome();
/** Root of per-project session directories (watched for changes). */
export const DSH_SESSIONS_DIR = join(DSH_HOME, "sessions");

const ZSTD_MAGIC = 0xfd2fb528;
const LOG_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;
const THINKING_PREVIEW_MAX = 240;

export function isDshDecompressionSupported(): boolean {
  return typeof zlib.zstdDecompressSync === "function";
}

// ---------------------------------------------------------------------------
// Zstandard frames

/**
 * Byte ranges of the structurally complete frames. Mirrors dsh's own
 * `scanZstdFrames`: frames are walked without decompression, and EOF inside a
 * frame stops the scan there (a torn tail from a concurrent append).
 */
export function scanCompleteZstdFrames(
  buffer: Buffer,
  maxFrames = Number.POSITIVE_INFINITY,
): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < buffer.length && frames.length < maxFrames) {
    const start = offset;
    if (buffer.length - offset < 5) return frames;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames;
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) return frames;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerRest =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < headerRest) return frames;
    offset += headerRest;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      if (blockType === 0x03) return frames;
      const payload = blockType === 0x01 ? 1 : blockHeader >>> 3;
      if (buffer.length - offset < payload) return frames;
      offset += payload;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/**
 * Decode complete frames one at a time: Node's one-shot zstd API stops after
 * the first frame of a concatenated stream.
 */
function decodeZstdFrames(
  buffer: Buffer,
  frames: ReadonlyArray<{ start: number; end: number }>,
): string {
  let text = "";
  for (const frame of frames) {
    text += zlib
      .zstdDecompressSync(buffer.subarray(frame.start, frame.end))
      .toString("utf8");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Raw log parsing (cached, incremental for append-only growth)

export interface DshSessionHeader {
  type: "session";
  version?: number;
  id: string;
  createdAt?: number;
  cwd: string;
  parentSession?: string;
  origin?: string;
  delegationDepth?: number;
}

export interface DshEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

interface ParsedLog {
  mtimeMs: number;
  size: number;
  /** Bytes already decoded (compressed: complete frames; plain: full lines). */
  consumed: number;
  /** Text after the last newline of the decoded stream, awaiting more data. */
  pendingText: string;
  header: DshSessionHeader | null;
  events: DshEvent[];
}

const parsedLogCache = new Map<string, ParsedLog>();
const MAX_CACHED_LOGS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeader(value: unknown): DshSessionHeader | null {
  if (!isRecord(value) || value.type !== "session") return null;
  if (typeof value.id !== "string" || typeof value.cwd !== "string") {
    return null;
  }
  return value as unknown as DshSessionHeader;
}

function appendLines(log: ParsedLog, text: string): void {
  const combined = log.pendingText + text;
  const lines = combined.split("\n");
  log.pendingText = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!log.header) {
      const header = parseHeader(value);
      if (header) {
        log.header = header;
        continue;
      }
    }
    if (isRecord(value) && typeof value.type === "string") {
      log.events.push(value as unknown as DshEvent);
    }
  }
}

/**
 * Parse one session log. Results are cached by path and reused while the
 * file is unchanged; append-only growth decodes only the new frames.
 */
export async function readDshLog(
  logPath: string,
): Promise<{ header: DshSessionHeader; events: DshEvent[] } | null> {
  let info: { mtimeMs: number; size: number };
  try {
    info = await stat(logPath);
  } catch {
    parsedLogCache.delete(logPath);
    return null;
  }
  const compressed = logPath.endsWith(".zstd");
  if (compressed && !isDshDecompressionSupported()) return null;

  let cached = parsedLogCache.get(logPath);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.header
      ? { header: cached.header, events: cached.events }
      : null;
  }
  // A shrink or rewrite (format migration, crash repair) invalidates the
  // incremental state; growth keeps the already-decoded prefix.
  if (cached && info.size < cached.consumed) cached = undefined;

  let buffer: Buffer;
  try {
    buffer = await readFile(logPath);
  } catch {
    return null;
  }
  const log: ParsedLog = cached ?? {
    mtimeMs: 0,
    size: 0,
    consumed: 0,
    pendingText: "",
    header: null,
    events: [],
  };
  try {
    if (compressed) {
      const tail = buffer.subarray(log.consumed);
      const frames = scanCompleteZstdFrames(tail);
      const end = frames.at(-1)?.end ?? 0;
      if (end > 0) {
        appendLines(log, decodeZstdFrames(tail, frames));
        log.consumed += end;
      }
    } else {
      const tail = buffer.subarray(log.consumed);
      const lastNewline = tail.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        appendLines(log, tail.subarray(0, lastNewline + 1).toString("utf8"));
        log.consumed += lastNewline + 1;
      }
    }
  } catch {
    // A complete frame that fails to decode is corruption; keep whatever was
    // decoded earlier instead of failing the whole listing.
    if (!cached) return null;
  }
  // Every dsh frame ends with a newline, so a frame boundary is a line
  // boundary; flush any trailing record that ended exactly at EOF.
  if (log.pendingText.trim()) {
    const pending = log.pendingText;
    log.pendingText = "";
    appendLines(log, `${pending}\n`);
  }
  log.mtimeMs = info.mtimeMs;
  log.size = info.size;
  parsedLogCache.delete(logPath);
  parsedLogCache.set(logPath, log);
  if (parsedLogCache.size > MAX_CACHED_LOGS) {
    const oldest = parsedLogCache.keys().next().value;
    if (oldest) parsedLogCache.delete(oldest);
  }
  return log.header ? { header: log.header, events: log.events } : null;
}

/** Read only the header (first frame/line) of a session log. */
export async function readDshLogHeader(
  logPath: string,
): Promise<DshSessionHeader | null> {
  const cached = parsedLogCache.get(logPath);
  if (cached?.header) return cached.header;
  let buffer: Buffer;
  try {
    buffer = await readFile(logPath);
  } catch {
    return null;
  }
  try {
    const text = logPath.endsWith(".zstd")
      ? isDshDecompressionSupported()
        ? decodeZstdFrames(buffer, scanCompleteZstdFrames(buffer, 1))
        : ""
      : buffer.toString("utf8", 0, Math.min(buffer.length, 64 * 1024));
    const firstLine = text.split("\n", 1)[0]?.trim();
    return firstLine ? parseHeader(JSON.parse(firstLine)) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session catalog

export interface DshSessionRecord {
  sessionId: string;
  cwd: string;
  createdAtMs: number;
  /** Modification time of the current log, used as last activity. */
  updatedAtMs: number;
  /** Absolute session directory (`<sessions>/<encoded-cwd>/<id>`). */
  sessionDir: string;
  /** Current (highest-version) log file. */
  logPath: string;
  logSize: number;
}

/** Pick the current log in a session directory: highest format version wins. */
export function pickDshLogFile(fileNames: readonly string[]): string | null {
  let best: { name: string; version: number } | null = null;
  for (const name of fileNames) {
    const match = LOG_FILE_RE.exec(name);
    if (!match) continue;
    const version = match[1] ? Number(match[1]) : 0;
    if (!best || version > best.version) best = { name, version };
  }
  return best?.name ?? null;
}

async function readDirents(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Read the root-conversation record of one session directory, if any. */
export async function readDshSessionRecord(
  sessionDir: string,
): Promise<DshSessionRecord | null> {
  return recordForSessionDir(sessionDir);
}

async function recordForSessionDir(
  sessionDir: string,
): Promise<DshSessionRecord | null> {
  const entries = await readDirents(sessionDir);
  const logName = pickDshLogFile(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  if (!logName) return null;
  const logPath = join(sessionDir, logName);
  let info: { mtimeMs: number; size: number };
  try {
    info = await stat(logPath);
  } catch {
    return null;
  }
  if (info.size === 0) return null;
  const header = await readDshLogHeader(logPath);
  if (!header) return null;
  // Delegated subagent sessions belong to their parent conversation.
  if (
    header.parentSession ||
    header.origin === "subagent" ||
    (typeof header.delegationDepth === "number" && header.delegationDepth > 0)
  ) {
    return null;
  }
  return {
    sessionId: header.id,
    cwd: header.cwd,
    createdAtMs:
      typeof header.createdAt === "number" ? header.createdAt : info.mtimeMs,
    updatedAtMs: info.mtimeMs,
    sessionDir,
    logPath,
    logSize: info.size,
  };
}

export interface DshStoreOptions {
  sessionsDir?: string;
}

/** List root conversations across every dsh project directory. */
export async function listDshSessionRecords(
  options: DshStoreOptions = {},
): Promise<DshSessionRecord[]> {
  const sessionsDir = options.sessionsDir ?? DSH_SESSIONS_DIR;
  const projectDirs = (await readDirents(sessionsDir)).filter((entry) =>
    entry.isDirectory(),
  );
  const records: DshSessionRecord[] = [];
  for (const projectDir of projectDirs) {
    const projectPath = join(sessionsDir, projectDir.name);
    const sessionDirs = (await readDirents(projectPath)).filter((entry) =>
      entry.isDirectory(),
    );
    const found = await Promise.all(
      sessionDirs.map((entry) =>
        recordForSessionDir(join(projectPath, entry.name)),
      ),
    );
    for (const record of found) if (record) records.push(record);
  }
  records.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return records;
}

/** Look up one session by id (directory name equals the session id). */
export async function findDshSessionRecord(
  sessionId: string,
  options: DshStoreOptions = {},
): Promise<DshSessionRecord | null> {
  if (!isSafeDshSessionId(sessionId)) return null;
  const sessionsDir = options.sessionsDir ?? DSH_SESSIONS_DIR;
  for (const projectDir of await readDirents(sessionsDir)) {
    if (!projectDir.isDirectory()) continue;
    const sessionDir = join(sessionsDir, projectDir.name, sessionId);
    const record = await recordForSessionDir(sessionDir);
    if (record?.sessionId === sessionId) return record;
  }
  return null;
}

function isSafeDshSessionId(sessionId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId) &&
    !sessionId.includes("..")
  );
}

// ---------------------------------------------------------------------------
// Pi projection

export interface DshTranscriptOptions {
  deferMedia?: boolean;
  deferThinking?: boolean;
}

export interface DshLogFacts {
  /** Latest `session/title`, when dsh has produced one. */
  title: string | null;
  /** Context window recorded by the latest `request/context`. */
  contextWindow?: number;
  /** Turn lifecycle derived from the log tail. */
  activity: DshLogActivity;
}

export interface DshLogActivity {
  /** `in-flight` while the latest turn has no `turn/end`. */
  turn: "in-flight" | "settled" | "unknown";
  /** A tool approval or a user question is waiting for an answer in dsh. */
  waitingInput: boolean;
}

/**
 * Tool names mapped onto Pi-native names where Pi's converter already knows
 * the renderer, or straight to Yep renderer names otherwise. dsh tool inputs
 * already use Claude-style fields (`file_path`, `old_string`, ...).
 */
function adaptToolCall(
  nativeName: string,
  rawArguments: unknown,
): { name: string; arguments: Record<string, unknown> } {
  let args: Record<string, unknown>;
  if (isRecord(rawArguments)) {
    args = { ...rawArguments };
  } else if (typeof rawArguments === "string") {
    try {
      const parsed: unknown = JSON.parse(rawArguments);
      args = isRecord(parsed) ? parsed : { input: parsed };
    } catch {
      args = { input: rawArguments };
    }
  } else {
    args = {};
  }
  switch (nativeName) {
    case "glob":
      return { name: "Glob", arguments: args };
    case "read_image":
      return { name: "read", arguments: args };
    case "web_fetch":
      return {
        name: "WebFetch",
        arguments: { prompt: "", ...args },
      };
    case "web_search": {
      const queries = Array.isArray(args.queries)
        ? args.queries.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return {
        name: "WebSearch",
        arguments:
          typeof args.query === "string" || queries.length === 0
            ? args
            : { ...args, query: queries.join(" | ") },
      };
    }
    case "str_replace_editor": {
      const path = typeof args.path === "string" ? args.path : undefined;
      switch (args.command) {
        case "create":
          return {
            name: "write",
            arguments: { ...args, file_path: path, content: args.file_text },
          };
        case "str_replace":
          return {
            name: "edit",
            arguments: {
              ...args,
              file_path: path,
              old_string: args.old_str,
              new_string: args.new_str,
            },
          };
        case "view":
          return { name: "read", arguments: { ...args, file_path: path } };
        default:
          return { name: nativeName, arguments: args };
      }
    }
    default:
      return { name: nativeName, arguments: args };
  }
}

function adaptUsage(value: unknown): PiUsage | undefined {
  if (!isRecord(value)) return undefined;
  const num = (key: string) =>
    typeof value[key] === "number" ? (value[key] as number) : 0;
  const input = num("inputTokens");
  const output = num("outputTokens");
  const cacheRead = num("cacheReadTokens");
  const cacheWrite = num("cacheWriteTokens");
  const totalTokens =
    num("totalTokens") || input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function imagePlaceholder(block: Record<string, unknown>): PiTextContent {
  const attachment = isRecord(block.attachment) ? block.attachment : {};
  const name = typeof attachment.name === "string" ? attachment.name : "image";
  const size =
    typeof attachment.width === "number" &&
    typeof attachment.height === "number"
      ? ` ${attachment.width}×${attachment.height}`
      : "";
  return { type: "text", text: `[Image: ${name}${size}]` };
}

function filePlaceholder(block: Record<string, unknown>): PiTextContent {
  const attachment = isRecord(block.attachment) ? block.attachment : {};
  const name = typeof attachment.name === "string" ? attachment.name : "file";
  return { type: "text", text: `[File: ${name}]` };
}

function adaptInputContent(
  content: unknown,
): Array<PiTextContent | PiImageContent> {
  if (!Array.isArray(content)) return [];
  const blocks: Array<PiTextContent | PiImageContent> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push(imagePlaceholder(block));
    } else if (block.type === "file") {
      blocks.push(filePlaceholder(block));
    }
  }
  return blocks;
}

function joinText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

function failureMessage(reason: Record<string, unknown>): string {
  const error = isRecord(reason.error) ? reason.error : undefined;
  if (error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return "The dsh turn failed.";
}

/**
 * Project a dsh event log into a linear Pi session.
 *
 * - `user/message` entries are shown only for human prompts
 *   (`source.kind === "user"`); instructions, runtime context, skill catalogs
 *   and approval notices are model plumbing.
 * - `assistant/message` carries text, reasoning and `tool-call` blocks; the
 *   matching `tool/result` events become Pi tool results.
 * - `turn/end` closes a turn: an abort marks the last assistant message
 *   aborted, a failure adds an error assistant entry.
 * - `compaction/summary` becomes a Pi compaction boundary.
 */
export function projectDshEvents(
  header: DshSessionHeader,
  events: readonly DshEvent[],
  options: DshTranscriptOptions = {},
): { session: PiSessionContent; facts: DshLogFacts } {
  const entries: PiSessionEntry[] = [];
  let parentId: string | null = null;
  const toolNames = new Map<string, string>();
  let title: string | null = null;
  let contextWindow: number | undefined;
  let turnOpen = false;
  let sawTurn = false;
  const openApprovals = new Set<string>();
  const openQuestionCalls = new Set<string>();
  let lastAssistant: PiAssistantMessage | null = null;
  let lastConversationRole: "user" | "assistant" | "toolResult" | null = null;

  const push = (
    id: string,
    timeMs: number | undefined,
    message: PiAgentMessage,
  ) => {
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date(
        timeMs ?? header.createdAt ?? Date.now(),
      ).toISOString(),
      message,
    });
    parentId = id;
  };

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    const fallbackId = `dsh-${event.seq ?? entries.length}`;
    switch (event.type) {
      case "turn/start":
        turnOpen = true;
        sawTurn = true;
        break;
      case "turn/end": {
        turnOpen = false;
        sawTurn = true;
        openQuestionCalls.clear();
        const reason = isRecord(data.reason) ? data.reason : {};
        if (reason.kind === "aborted") {
          if (lastAssistant && lastConversationRole === "assistant") {
            lastAssistant.stopReason = "aborted";
          }
        } else if (reason.kind === "error") {
          const message: PiAssistantMessage = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: failureMessage(reason),
            timestamp: event.time,
          };
          push(`${fallbackId}-error`, event.time, message);
          lastAssistant = message;
          lastConversationRole = "assistant";
        }
        break;
      }
      case "user/message": {
        const source = isRecord(data.source) ? data.source : {};
        if (source.kind !== "user") break;
        const content = adaptInputContent(data.content);
        if (content.length === 0) break;
        push(typeof data.id === "string" ? data.id : fallbackId, event.time, {
          role: "user",
          content,
          timestamp: event.time,
        });
        lastConversationRole = "user";
        break;
      }
      case "assistant/message": {
        const message = isRecord(data.message) ? data.message : {};
        const source = isRecord(message.source) ? message.source : {};
        const content: PiContentBlock[] = [];
        let hasToolCall = false;
        for (const block of Array.isArray(message.content)
          ? message.content
          : []) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            content.push({ type: "text", text: block.text });
          } else if (
            block.type === "reasoning" &&
            typeof block.text === "string"
          ) {
            const thinking = block.text;
            content.push(
              options.deferThinking && thinking.length > THINKING_PREVIEW_MAX
                ? {
                    type: "thinking",
                    thinking: thinking.slice(0, THINKING_PREVIEW_MAX),
                    deferred: true,
                    thinkingLength: thinking.length,
                  }
                : { type: "thinking", thinking },
            );
          } else if (
            block.type === "tool-call" &&
            typeof block.name === "string"
          ) {
            const id = typeof block.id === "string" ? block.id : "";
            const adapted = adaptToolCall(block.name, block.arguments);
            toolNames.set(id, adapted.name);
            if (block.name === "ask_user_question") openQuestionCalls.add(id);
            hasToolCall = true;
            content.push({
              type: "toolCall",
              id,
              name: adapted.name,
              arguments: adapted.arguments,
            });
          } else if (block.type === "image") {
            content.push(imagePlaceholder(block));
          }
        }
        const assistant: PiAssistantMessage = {
          role: "assistant",
          content,
          ...(typeof source.provider === "string"
            ? { provider: source.provider }
            : {}),
          ...(typeof source.model === "string" ? { model: source.model } : {}),
          ...(adaptUsage(data.usage) ? { usage: adaptUsage(data.usage) } : {}),
          stopReason: hasToolCall ? "toolUse" : "stop",
          timestamp: event.time,
        };
        push(
          typeof message.id === "string" ? message.id : fallbackId,
          event.time,
          assistant,
        );
        lastAssistant = assistant;
        lastConversationRole = "assistant";
        break;
      }
      case "tool/result": {
        const message = isRecord(data.message) ? data.message : {};
        const toolCallId =
          typeof message.toolCallId === "string" ? message.toolCallId : "";
        openQuestionCalls.delete(toolCallId);
        const content = adaptInputContent(message.content);
        push(
          typeof message.id === "string" ? message.id : fallbackId,
          event.time,
          {
            role: "toolResult",
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? "tool",
            content,
            isError: message.isError === true,
            timestamp: event.time,
          },
        );
        lastConversationRole = "toolResult";
        break;
      }
      case "compaction/summary": {
        const id = fallbackId;
        entries.push({
          type: "compaction",
          id,
          parentId,
          timestamp: new Date(event.time ?? Date.now()).toISOString(),
          summary: joinText(data.summary) || "Context compacted",
          ...(typeof data.shadowedTokenCount === "number"
            ? { tokensBefore: data.shadowedTokenCount }
            : {}),
        });
        parentId = id;
        break;
      }
      case "session/title":
        if (typeof data.title === "string" && data.title.trim()) {
          title = data.title.trim();
        }
        break;
      case "request/context":
        if (typeof data.contextWindow === "number" && data.contextWindow > 0) {
          contextWindow = data.contextWindow;
        }
        break;
      case "approval/asked":
        if (typeof data.id === "string") openApprovals.add(data.id);
        break;
      case "approval/decided":
        if (typeof data.id === "string") openApprovals.delete(data.id);
        break;
    }
  }

  return {
    session: {
      header: {
        type: "session",
        id: header.id,
        timestamp: new Date(header.createdAt ?? Date.now()).toISOString(),
        cwd: header.cwd,
      },
      entries,
      activeEntries: entries,
    },
    facts: {
      title,
      contextWindow,
      activity: {
        turn: turnOpen ? "in-flight" : sawTurn ? "settled" : "unknown",
        waitingInput:
          turnOpen && (openApprovals.size > 0 || openQuestionCalls.size > 0),
      },
    },
  };
}

export async function readDshTranscript(
  record: Pick<DshSessionRecord, "logPath">,
  options: DshTranscriptOptions = {},
): Promise<{ session: PiSessionContent; facts: DshLogFacts } | null> {
  const log = await readDshLog(record.logPath);
  if (!log) return null;
  return projectDshEvents(log.header, log.events, options);
}

/** Whether a session log holds at least one human prompt (not a blank). */
export async function dshRecordHasConversation(
  record: Pick<DshSessionRecord, "logPath">,
): Promise<boolean> {
  const log = await readDshLog(record.logPath);
  if (!log) return false;
  return log.events.some(
    (event) =>
      event.type === "user/message" &&
      isRecord(event.data) &&
      isRecord(event.data.source) &&
      event.data.source.kind === "user",
  );
}

/** Turn activity for the external-session tracker. */
export async function readDshLogActivity(
  logPath: string,
): Promise<DshLogActivity> {
  const log = await readDshLog(logPath);
  if (!log) return { turn: "unknown", waitingInput: false };
  return projectDshEvents(log.header, log.events).facts.activity;
}

export async function getDshLogStats(
  logPath: string,
): Promise<{ mtime: number; size: number } | null> {
  try {
    const info = await stat(logPath);
    return { mtime: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

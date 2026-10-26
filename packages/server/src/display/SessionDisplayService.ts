import { createHash, randomUUID } from "node:crypto";
import type {
  ContextUsage,
  SessionDisplayActivity,
  SessionDisplayCurrent,
  SessionDisplayGroupPage,
  SessionDisplayKnownView,
  SessionDisplaySnapshot,
  SessionDisplayToolDetail,
  SessionDisplayToolOutput,
  SessionDisplayTurnStatus,
  SessionDisplayView,
} from "@yep-anywhere/shared";
import {
  SESSION_DISPLAY_MAX_NOTICE_LENGTH,
  SessionDisplayNoticeSegmentSchema,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type {
  RuntimeController,
  RuntimeSessionSubscription,
} from "../runtime/types.js";
import { cursorStreamError } from "../sdk/providers/cursor-errors.js";
import {
  extractToolPaths,
  selectSessionDisplayToolMessages,
} from "../sessions/display-projection.js";
import { augmentPersistedSessionMessages } from "../sessions/persisted-augments.js";
import type { Message } from "../supervisor/types.js";
import {
  SessionDisplayReducer,
  decodeDisplayToolId,
} from "./SessionDisplayReducer.js";
import {
  type SessionDisplayCacheState,
  SessionDisplayPhaseTotals,
  type SessionDisplayTimingSink,
  timed,
} from "./display-timing.js";

/** Cold initializations at or above this duration are logged with phases. */
const DEFAULT_SLOW_INITIALIZE_MS = 500;

export interface SessionDisplayReadObserver {
  timing?: SessionDisplayTimingSink;
  onCacheState?(state: SessionDisplayCacheState): void;
}

export interface DisplaySelection {
  projectId: string;
  sessionId: string;
  branchId?: string;
}
export interface DisplaySourcePage {
  provider: string;
  messages: Message[];
  contextUsage?: ContextUsage;
  turnStatuses?: Readonly<Record<string, SessionDisplayTurnStatus>>;
  /** Native Codex turns covering [from, before); newer live turns may lag history. */
  codexTurnWindow?: { turnIds: string[]; from: number; before: number };
  activity: SessionDisplayActivity["state"];
  cursor?: string;
  stamp: string;
}
export interface SessionDisplaySource {
  reasoning?(selection: DisplaySelection, id: string): Promise<string>;
  read(
    selection: DisplaySelection,
    cursor?: string,
    timing?: SessionDisplayTimingSink,
  ): Promise<DisplaySourcePage>;
  stamp(
    selection: DisplaySelection,
    timing?: SessionDisplayTimingSink,
  ): Promise<string>;
  detail(
    selection: DisplaySelection,
    runId: string,
    rawId?: string,
  ): Promise<Message[]>;
}
type Emit = (eventType: string, data: unknown) => void;
type RecordValue = Record<string, unknown>;
interface Entry {
  selection: DisplaySelection;
  view: SessionDisplayView;
  ready: Promise<void>;
  /** True until the first history read settles; later callers record `wait`. */
  initializing?: boolean;
  model?: SessionDisplayReducer;
  snapshot?: SessionDisplaySnapshot;
  listeners: Set<Emit>;
  sourceSubscription?: RuntimeSessionSubscription | null;
  /**
   * Runtime process whose events this entry has already observed, through the
   * cold source read plus its live subscription.
   */
  sourceProcessId?: string;
  controller: AbortController;
  overlay: Map<string, RecordValue>;
  bootstrapReplay: Map<string, RecordValue>;
  controls: Map<string, unknown>;
  details: Map<string, Message>;
  detailBytes: number;
  /**
   * Cursor thoughts still waiting for the assistant text or tool that followed
   * them. Native history keeps only an encrypted signature, so a later refresh
   * uses the anchor on each thought instead of appending the chain after the
   * answer.
   */
  cursorPendingThoughts: string[];
  streamId?: string;
  provider?: string;
  stamp?: string;
  refreshing?: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>;
}
const MAX_DETAILS_BYTES = 8 * 1024 * 1024;
const MAX_BODY_PAGE = 128 * 1024;
const CONTROL_EVENTS = new Set([
  "connected",
  "status",
  "deferred-queue",
  "permission-mode",
  "mode-change",
  "context-status",
  "retry-status",
  "session-id-changed",
  "complete",
  "error",
]);

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function messageContent(message: RecordValue): unknown {
  return asRecord(message.message)?.content ?? message.content;
}
/** Deliver a replayed runtime message as one this projection has not seen. */
function asLiveReplay(type: string, data: unknown): unknown {
  const message = asRecord(data);
  if (type !== "message" || message?.isReplay !== true) return data;
  return { ...message, isReplay: false };
}

function isCursorTrackedMessage(
  message: RecordValue,
  provider: string | undefined,
): boolean {
  return (
    provider === "cursor" ||
    typeof message.cursorTurnIndex === "number" ||
    (typeof message.turnId === "string" &&
      message.turnId.startsWith("cursor-turn-"))
  );
}

/** A live Cursor thought, with no answer or tool call in the same message. */
function isCursorThinkingOnly(message: RecordValue): boolean {
  if (message.type !== "assistant") return false;
  const content = messageContent(message);
  if (!Array.isArray(content) || content.length === 0) return false;
  let hasThinking = false;
  for (const value of content) {
    const block = asRecord(value);
    if (
      block?.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim()
    ) {
      hasThinking = true;
      continue;
    }
    return false;
  }
  return hasThinking;
}

/**
 * The next visible Cursor step after a thought.
 * Tool results and user prompts are not anchors: the thought was flushed
 * before the tool call or the assistant text that followed it.
 */
function cursorThinkingAnchor(
  message: RecordValue,
): { text?: string; toolId?: string } | undefined {
  if (message.type !== "assistant") return undefined;
  const content = messageContent(message);
  if (typeof content === "string") {
    const text = content.trim();
    return text ? { text } : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  for (const value of content) {
    const block = asRecord(value);
    if (!block) continue;
    if (block.type === "tool_use" && typeof block.id === "string" && block.id)
      return { toolId: block.id };
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim()
    )
      return { text: block.text.trim() };
  }
  return undefined;
}

function thinkingBody(message: RecordValue): string {
  const content = messageContent(message);
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((value) => {
      const block = asRecord(value);
      return block?.type === "thinking" && typeof block.thinking === "string"
        ? [block.thinking.trim()]
        : [];
    })
    .filter(Boolean)
    .join("\n");
}

function cursorPromptBody(message: RecordValue): string {
  const content = messageContent(message);
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((value) => {
      const block = asRecord(value);
      return block?.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("")
    .trim();
}

/** ACP does not echo the user prompt; the injected copy is a plain user message. */
function isCursorUserPrompt(message: RecordValue): boolean {
  if (message.type !== "user") return false;
  const content = messageContent(message);
  if (
    Array.isArray(content) &&
    content.some((value) => asRecord(value)?.type === "tool_result")
  )
    return false;
  return cursorPromptBody(message).length > 0;
}

function cursorPromptsMatch(native: string, live: string): boolean {
  if (!native || !live) return false;
  return native === live || native.includes(live) || live.includes(native);
}

/**
 * Place the still-live prompt ahead of the native rows for its turn.
 * An opening turn can persist tools before `<user_query>` is readable.
 */
function insertCursorPrompt(
  messages: readonly Message[],
  prompt: RecordValue,
): Message[] {
  const id = prompt.uuid ?? prompt.id;
  if (
    typeof id === "string" &&
    messages.some((message) => message.uuid === id || message.id === id)
  )
    return [...messages];
  const stored = prompt as Message;
  const index = prompt.cursorTurnIndex;
  if (typeof index === "number") {
    const at = messages.findIndex(
      (message) => message.cursorTurnIndex === index,
    );
    if (at < 0) return [...messages, stored];
    return [...messages.slice(0, at), stored, ...messages.slice(at)];
  }
  const hasPrompt = messages.some(
    (message) =>
      message.type === "user" && cursorPromptBody(message).length > 0,
  );
  return hasPrompt ? [...messages, stored] : [stored, ...messages];
}

function hasToolInvocation(messages: readonly Message[]): boolean {
  return messages.some((message) => {
    const content = messageContent(message);
    return (
      Array.isArray(content) &&
      content.some((block) => asRecord(block)?.type === "tool_use")
    );
  });
}

function displayTextIdentity(message: RecordValue): string {
  if (typeof message.codexCorrelationKey === "string")
    return message.codexCorrelationKey;
  const raw = String(message.uuid ?? message.id ?? "");
  const run = message.codexTurnId ?? message.turnId;
  if (typeof run === "string" && raw.endsWith(`-${run}`))
    return `codex:${run}:agent-message:${raw.slice(0, -run.length - 1)}`;
  return String(asRecord(message.message)?.id ?? raw);
}

/** Retained replay overlay contains display facts/previews, never raw bodies. */
export function compactDisplayMessage(message: RecordValue): RecordValue {
  const result: RecordValue = {};
  for (const key of [
    "id",
    "uuid",
    "tempId",
    "displayQuestionId",
    "type",
    "role",
    "timestamp",
    "codexTurnId",
    "codexThreadId",
    "turnId",
    "cursorTurnIndex",
    "codexCorrelationKey",
    "clientUserMessageId",
    "codexMessagePhase",
    "codexAsyncMessage",
    "subtype",
    "status",
    "turnStatus",
    "is_error",
    "willRetry",
    "isSubagent",
    "isSidechain",
    "_isStreaming",
    "_isStreamingPlaceholder",
    "_streamingBlockIndex",
    "error",
    "parentUuid",
    "branch",
    "cursorThinkingBefore",
  ]) {
    if (message[key] !== undefined) result[key] = message[key];
  }
  const nativeItem = asRecord(message.codexThreadItem);
  if (message.subtype === "codex_native_item" && nativeItem) {
    if (nativeItem.type === "interAgentMessage") {
      const parsed =
        SessionDisplayNoticeSegmentSchema.shape.interAgentMessage.safeParse({
          type: "interAgentMessage",
          id:
            typeof nativeItem.id === "string"
              ? nativeItem.id.slice(0, 512)
              : undefined,
          kind: nativeItem.kind,
          sender:
            typeof nativeItem.sender === "string"
              ? nativeItem.sender.slice(0, 512)
              : undefined,
          recipient:
            typeof nativeItem.recipient === "string"
              ? nativeItem.recipient.slice(0, 512)
              : undefined,
          ...(typeof nativeItem.text === "string"
            ? {
                text: nativeItem.text.slice(
                  0,
                  SESSION_DISPLAY_MAX_NOTICE_LENGTH,
                ),
              }
            : {}),
          encrypted: nativeItem.encrypted === true,
          ...(nativeItem.truncated === true ||
          (typeof nativeItem.text === "string" &&
            nativeItem.text.length > SESSION_DISPLAY_MAX_NOTICE_LENGTH)
            ? { truncated: true }
            : {}),
        });
      if (parsed.success) result.codexThreadItem = parsed.data;
    } else if (nativeItem.type === "agentWait") {
      const projected: RecordValue = {};
      for (const key of [
        "type",
        "id",
        "status",
        "startedAt",
        "completedAt",
        "durationMs",
        "outcome",
      ]) {
        if (nativeItem[key] !== undefined) projected[key] = nativeItem[key];
      }
      const parsed =
        SessionDisplayNoticeSegmentSchema.shape.agentWait.safeParse(projected);
      if (parsed.success) result.codexThreadItem = parsed.data;
    } else if (nativeItem.type === "subAgentActivity") {
      const item: RecordValue = { type: "subAgentActivity" };
      for (const key of ["id", "kind", "agentThreadId", "agentPath"]) {
        if (typeof nativeItem[key] === "string")
          item[key] = nativeItem[key].slice(0, 512);
      }
      if (
        nativeItem.operation === "followup_task" ||
        nativeItem.operation === "send_message"
      ) {
        item.operation = nativeItem.operation;
      }
      result.codexThreadItem = item;
    }
    if (result.codexThreadItem) {
      result.codexThreadItemLifecycle = message.codexThreadItemLifecycle;
      result.codexThreadItemId = message.codexThreadItemId;
    }
  }
  const content = messageContent(message);
  const compact = Array.isArray(content)
    ? content.map((value) => {
        const block = asRecord(value);
        if (!block) return value;
        if (block.type === "tool_use") {
          const input = asRecord(block.input);
          const args: RecordValue = {};
          for (const key of [
            "command",
            "cmd",
            "script",
            "file_path",
            "path",
            "url",
            "snapshotUrl",
            "pattern",
            "query",
            "description",
            "plan",
            "todos",
          ]) {
            const value = input?.[key];
            if (typeof value === "string") args[key] = value.slice(0, 1_024);
            else if (
              Array.isArray(value) &&
              (key === "plan" || key === "todos")
            )
              args[key] = value.slice(0, 100);
          }
          return {
            type: "tool_use",
            id: block.id,
            // Output deltas omit invocation metadata. Keep those keys absent
            // so merging a delta cannot erase the original name or status.
            ...(block.name !== undefined ? { name: block.name } : {}),
            ...(block.status !== undefined ? { status: block.status } : {}),
            ...(block.input !== undefined
              ? {
                  input:
                    typeof block.input === "string"
                      ? block.input.slice(0, 1_024)
                      : args,
                  displayChangedPaths: extractToolPaths(block.input),
                }
              : {}),
            ...(typeof block.partialOutput === "string"
              ? { partialOutput: block.partialOutput.slice(-2_048) }
              : {}),
          };
        }
        if (block.type === "tool_result") {
          const text =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .flatMap((v) =>
                      typeof asRecord(v)?.text === "string"
                        ? [asRecord(v)?.text]
                        : [],
                    )
                    .join("\n")
                : "";
          return {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            is_error: block.is_error,
            ...(typeof block.durationMs === "number" &&
            Number.isFinite(block.durationMs) &&
            block.durationMs >= 0
              ? { durationMs: block.durationMs }
              : {}),
            content: text.slice(-2_048),
            displayTruncated: text.length > 2_048,
          };
        }
        if (block.type === "text" || block.type === "thinking") return block;
        return { type: block.type, deferred: true };
      })
    : content;
  const nested = asRecord(message.message);
  result.message = {
    role: nested?.role ?? message.role ?? message.type,
    ...(nested?.id ? { id: nested.id } : {}),
    content: compact,
  };
  return result;
}

/**
 * One source subscription and reducer per observed session/branch. A subscriber
 * receives a current snapshot before any patches; reconnect always rebases to
 * that compact state, so old journal tool bodies cannot cross the wire.
 */
export class SessionDisplayService {
  private source?: SessionDisplaySource;
  private entries = new Map<string, Entry>();
  /**
   * Settled, unobserved views kept after expiry (oldest first). Reviving one
   * skips the history read when the source stamp is unchanged.
   */
  private dormant = new Map<string, { entry: Entry; bytes: number }>();
  private dormantBytes = 0;
  constructor(
    private readonly options: {
      runtime: Pick<
        RuntimeController,
        "subscribeSession" | "getProcessForSession"
      > &
        Partial<Pick<RuntimeController, "replay">>;
      pollMs?: number;
      retentionMs?: number;
      maxEntries?: number;
      slowInitializeMs?: number;
      /** Settled views kept after expiry; 0 disables dormancy. */
      maxDormantEntries?: number;
      maxDormantBytes?: number;
    },
  ) {}

  configureSource(source: SessionDisplaySource): void {
    this.source = source;
  }
  private key(selection: DisplaySelection): string {
    return JSON.stringify([
      selection.projectId,
      selection.sessionId,
      selection.branchId ?? "active",
    ]);
  }
  private requireSource(): SessionDisplaySource {
    if (!this.source)
      throw new Error("Session display source is not configured");
    return this.source;
  }
  private async get(
    selection: DisplaySelection,
    observer?: SessionDisplayReadObserver,
  ): Promise<Entry> {
    const key = this.key(selection);
    let entry = this.entries.get(key);
    if (!entry) {
      const max = this.options.maxEntries ?? 16;
      for (const [oldKey, candidate] of this.entries) {
        if (this.entries.size < max) break;
        if (candidate.snapshot && !candidate.listeners.size)
          this.sleep(oldKey, candidate);
      }
      if (this.entries.size >= max)
        throw new Error("Too many active session displays");
      const sleeping = this.dormant.get(key);
      if (sleeping) {
        this.dormant.delete(key);
        this.dormantBytes -= sleeping.bytes;
        return this.revive(key, sleeping.entry, observer);
      }
      entry = {
        selection,
        view: {
          sessionId: selection.sessionId,
          branchScopeId: selection.branchId ?? "active",
          epoch: randomUUID(),
        },
        ready: Promise.resolve(),
        listeners: new Set(),
        controller: new AbortController(),
        overlay: new Map(),
        bootstrapReplay: new Map(),
        controls: new Map(),
        details: new Map(),
        detailBytes: 0,
        cursorPendingThoughts: [],
      };
      this.entries.set(key, entry);
      const current = entry;
      current.initializing = true;
      observer?.onCacheState?.("miss");
      const totals = new SessionDisplayPhaseTotals(observer?.timing);
      const startedAt = performance.now();
      entry.ready = this.initialize(current, totals)
        .then(
          () => this.logSlowInitialize(current, totals, startedAt),
          (error) => {
            this.logSlowInitialize(current, totals, startedAt, error);
            this.drop(key, current);
            throw error;
          },
        )
        .finally(() => {
          current.initializing = false;
        });
      await entry.ready;
      return entry;
    }
    if (entry.initializing) {
      observer?.onCacheState?.("wait");
      await timed(observer?.timing, "wait", () => entry.ready);
      return entry;
    }
    observer?.onCacheState?.("hit");
    await entry.ready;
    return entry;
  }

  /**
   * Re-activate a dormant view. Its projection is reused only when the source
   * is provably unchanged: same stamp and still no runtime process. Otherwise
   * the entry is reset and cold-initialized under a new epoch.
   */
  private async revive(
    key: string,
    entry: Entry,
    observer?: SessionDisplayReadObserver,
  ): Promise<Entry> {
    entry.controller = new AbortController();
    entry.initializing = true;
    this.entries.set(key, entry);
    const totals = new SessionDisplayPhaseTotals(observer?.timing);
    const startedAt = performance.now();
    let revived = false;
    entry.ready = (async () => {
      const [stamp, process] = await Promise.all([
        this.requireSource().stamp(entry.selection, totals),
        entry.selection.branchId
          ? null
          : timed(totals, "attach", () =>
              this.options.runtime.getProcessForSession(
                entry.selection.sessionId,
              ),
            ),
      ]);
      if (!process && stamp === entry.stamp && entry.snapshot) {
        revived = true;
        this.poll(entry);
        this.expire(entry);
        return;
      }
      this.reset(entry);
      await this.initialize(entry, totals);
    })()
      .then(
        () => {
          if (!revived) this.logSlowInitialize(entry, totals, startedAt);
        },
        (error) => {
          this.logSlowInitialize(entry, totals, startedAt, error);
          this.drop(key, entry);
          throw error;
        },
      )
      .finally(() => {
        entry.initializing = false;
      });
    try {
      await entry.ready;
    } finally {
      observer?.onCacheState?.(revived ? "revived" : "miss");
    }
    return entry;
  }

  /** Forget every derived state so `initialize` starts from scratch. */
  private reset(entry: Entry): void {
    entry.view = { ...entry.view, epoch: randomUUID() };
    entry.model = undefined;
    entry.snapshot = undefined;
    entry.stamp = undefined;
    entry.provider = undefined;
    entry.streamId = undefined;
    entry.sourceProcessId = undefined;
    entry.sourceSubscription = undefined;
    entry.overlay.clear();
    entry.bootstrapReplay.clear();
    entry.controls.clear();
    entry.details.clear();
    entry.detailBytes = 0;
    entry.cursorPendingThoughts = [];
  }

  /**
   * Expire an unobserved view. Settled historical views without a live
   * runtime subscription keep their projection in a bounded dormant cache;
   * anything that may still change through live events is dropped.
   */
  private sleep(key: string, entry: Entry): void {
    const maxEntries = this.options.maxDormantEntries ?? 32;
    const state = entry.snapshot?.activity.state;
    if (
      maxEntries <= 0 ||
      entry.listeners.size ||
      entry.initializing ||
      entry.refreshing ||
      entry.sourceSubscription ||
      !entry.snapshot ||
      entry.stamp === undefined ||
      !(
        state === "completed" ||
        state === "interrupted" ||
        state === "failed" ||
        state === "unknown"
      )
    ) {
      this.drop(key, entry);
      return;
    }
    this.drop(key, entry);
    // Tool bodies are re-read from history on demand; keep only the projection.
    entry.details.clear();
    entry.detailBytes = 0;
    const bytes = JSON.stringify(entry.snapshot).length * 2 + 4096;
    const maxBytes = this.options.maxDormantBytes ?? 64 * 1024 * 1024;
    if (bytes > maxBytes) return;
    const previous = this.dormant.get(key);
    if (previous) this.dormantBytes -= previous.bytes;
    this.dormant.delete(key);
    this.dormant.set(key, { entry, bytes });
    this.dormantBytes += bytes;
    for (const [oldKey, old] of this.dormant) {
      if (this.dormant.size <= maxEntries && this.dormantBytes <= maxBytes)
        break;
      this.dormant.delete(oldKey);
      this.dormantBytes -= old.bytes;
    }
  }

  private logSlowInitialize(
    entry: Entry,
    totals: SessionDisplayPhaseTotals,
    startedAt: number,
    error?: unknown,
  ): void {
    const durationMs = performance.now() - startedAt;
    if (
      !error &&
      durationMs < (this.options.slowInitializeMs ?? DEFAULT_SLOW_INITIALIZE_MS)
    )
      return;
    getLogger().info(
      {
        event: "session_display_cold_read",
        sessionId: entry.selection.sessionId,
        branchScoped: Boolean(entry.selection.branchId),
        provider: entry.provider ?? null,
        durationMs: Math.round(durationMs),
        phases: totals.rounded(),
        nodeCount: entry.snapshot?.nodes.length ?? null,
        attachedProcess: Boolean(entry.sourceProcessId),
        failed: Boolean(error),
        ...(error && typeof (error as { code?: unknown }).code === "string"
          ? { errorCode: (error as { code: string }).code }
          : {}),
      },
      "Session display cold read",
    );
  }

  private async initialize(
    entry: Entry,
    timing?: SessionDisplayTimingSink,
  ): Promise<void> {
    // Attach before reading history. Subscription replay is kept on the server;
    // subsequent live events are overlaid after the cold source read.
    await timed(timing, "attach", async () => {
      const process = entry.selection.branchId
        ? null
        : await this.options.runtime.getProcessForSession(
            entry.selection.sessionId,
          );
      if (process) {
        entry.sourceProcessId = process.id;
        entry.sourceSubscription = await this.options.runtime.subscribeSession(
          entry.selection.sessionId,
          (type, data) => this.event(entry, type, data),
          { signal: entry.controller.signal, displayProjection: true },
        );
      }
    });
    await this.refresh(entry, true, timing);
    await timed(timing, "replay", () => this.recoverCursorHistory(entry));
    this.poll(entry);
    this.expire(entry);
  }

  private async recoverCursorHistory(entry: Entry): Promise<void> {
    if (
      entry.provider === "cursor" &&
      !entry.selection.branchId &&
      this.options.runtime.replay
    ) {
      try {
        const records = await this.options.runtime.replay({
          sessionId: entry.selection.sessionId,
          allProcesses: true,
        });
        // Recover thoughts across generations, but keep runtime outcome replay
        // scoped as before: an old failed process cannot fail a resumed turn.
        const process = await this.options.runtime.getProcessForSession(
          entry.selection.sessionId,
        );
        const outcomeProcessId = process?.id ?? records.at(-1)?.processId;
        const failures = new Map<unknown, RecordValue>();
        const terminals = new Map<unknown, RecordValue>();
        const thoughts = new Map<string, RecordValue>();
        const pendingThoughts: RecordValue[] = [];
        // Reuse lifecycle pairing on timing-only messages. Replaying whole
        // tools here would replace native names/results and disturb grouping.
        const toolTimings = new SessionDisplayReducer(entry.view, "cursor");
        // Bind to the streamed message identity, then keep its text current.
        // The first chunk may be just "底部", too short to match native history.
        const anchors = new Map<
          string,
          { sourceId: string; text?: string; toolId?: string }
        >();
        for (const record of records) {
          if (
            record.type !== "message" ||
            record.sessionId !== entry.selection.sessionId
          )
            continue;
          const message = asRecord(record.data);
          if (!message) continue;
          const content = messageContent(message);
          if (Array.isArray(content)) {
            const tools = content.flatMap<RecordValue>((value) => {
              const block = asRecord(value);
              if (block?.type === "tool_use" && typeof block.id === "string")
                return [{ type: "tool_use", id: block.id }];
              if (
                block?.type === "tool_result" &&
                typeof block.tool_use_id === "string"
              )
                return [
                  {
                    type: "tool_result",
                    tool_use_id: block.tool_use_id,
                    durationMs: block.durationMs,
                  },
                ];
              return [];
            });
            if (tools.length)
              toolTimings.message(
                {
                  ...message,
                  timestamp: message.timestamp ?? record.timestamp,
                  message: {
                    role: asRecord(message.message)?.role ?? message.type,
                    content: tools,
                  },
                },
                true,
              );
          }
          this.rememberBody(entry, message);
          if (isCursorUserPrompt(message) || message.type === "result") {
            for (const thought of pendingThoughts) {
              thought.cursorThinkingBefore ??= { fallback: true };
            }
            pendingThoughts.length = 0;
          }
          if (
            isCursorThinkingOnly(message) &&
            typeof message.uuid === "string"
          ) {
            // Later chunks for the same live id replace earlier ones.
            const previous = thoughts.get(message.uuid);
            if (
              previous?.cursorThinkingBefore !== undefined &&
              message.cursorThinkingBefore === undefined
            )
              message.cursorThinkingBefore = previous.cursorThinkingBefore;
            thoughts.set(message.uuid, message);
            const pendingAt = pendingThoughts.findIndex(
              (thought) => thought.uuid === message.uuid,
            );
            if (pendingAt >= 0) pendingThoughts[pendingAt] = message;
            else pendingThoughts.push(message);
          } else {
            const anchor = cursorThinkingAnchor(message);
            if (anchor) {
              const sourceId = message.uuid ?? message.id;
              let bound = anchor;
              if (typeof sourceId === "string") {
                const existing = anchors.get(sourceId);
                const current = existing ?? { sourceId };
                Object.assign(current, anchor);
                anchors.set(sourceId, current);
                bound = current;
              }
              for (const thought of pendingThoughts) {
                if (
                  thought.cursorThinkingBefore === undefined &&
                  thought.turnId === message.turnId
                )
                  thought.cursorThinkingBefore = bound;
              }
              pendingThoughts.length = 0;
            }
          }
          if (record.processId && record.processId !== outcomeProcessId)
            continue;
          const failure = cursorStreamError(messageContent(message));
          if (failure || message.type === "error")
            failures.set(message.turnId, {
              ...message,
              isReplay: false,
              type: "error",
              message: undefined,
              content: undefined,
              role: undefined,
              error: failure?.message ?? message.error,
            });
          if (message.type === "result") terminals.set(message.turnId, message);
        }
        for (const thought of pendingThoughts) {
          if (thought.cursorThinkingBefore === undefined)
            thought.cursorThinkingBefore = { fallback: true };
        }
        for (const [turnId, failure] of failures) {
          this.event(entry, "message", failure);
          const terminal = terminals.get(turnId);
          if (terminal)
            this.event(entry, "message", {
              ...terminal,
              isReplay: false,
              turnStatus: "failed",
              is_error: true,
            });
        }
        let anchorsChanged = false;
        for (const thought of thoughts.values()) {
          const uuid = thought.uuid;
          if (typeof uuid !== "string") continue;
          const existing = entry.overlay.get(uuid);
          if (existing) {
            if (
              existing.cursorThinkingBefore === undefined &&
              thought.cursorThinkingBefore !== undefined
            ) {
              existing.cursorThinkingBefore = thought.cursorThinkingBefore;
              anchorsChanged = true;
            }
            continue;
          }
          this.event(entry, "message", { ...thought, isReplay: false });
        }
        // Thoughts already on screen were appended before this journal pass
        // could see what followed them. Rebuild so the new anchors apply.
        entry.model?.restoreToolTimings(toolTimings.tools.values());
        if (anchorsChanged) await this.refresh(entry, true);
        this.scheduleFlush(entry);
      } catch {
        // Native history remains usable during a runtime/journal outage.
        // On-demand reasoning can retry recovery when the connection returns.
      }
    }
  }

  private rememberBody(entry: Entry, message: RecordValue): RecordValue {
    const content = messageContent(message);
    if (!Array.isArray(content)) return message;
    const mergedBlocks = new Map<unknown, RecordValue>();
    // ACP thought IDs only exist in the live stream. Keep their complete bodies
    // under the same bounded budget as tool bodies, including after a turn ends.
    const identity = message.codexCorrelationKey ?? message.uuid ?? message.id;
    content.forEach((value, index) => {
      const block = asRecord(value);
      if (
        typeof identity !== "string" ||
        block?.type !== "thinking" ||
        typeof block.thinking !== "string"
      )
        return;
      this.cacheBody(entry, `thinking:${identity}:${index}`, {
        ...message,
        message: { role: "assistant", content: [block] },
      } as Message);
    });
    const blocks = content.filter((v) => {
      const b = asRecord(v);
      return b?.type === "tool_use" || b?.type === "tool_result";
    });
    for (const value of blocks) {
      const block = asRecord(value);
      if (!block) continue;
      const rawId = block.id ?? block.tool_use_id;
      if (typeof rawId !== "string") continue;
      const runId = message.codexTurnId ?? message.turnId ?? "session";
      const key = `${runId}:${block.type}:${rawId}`;
      const previous = entry.details.get(key);
      // Output-only updates must not overwrite the complete tool invocation.
      const oldBlock =
        previous && Array.isArray(previous.message?.content)
          ? asRecord(previous.message.content[0])
          : undefined;
      const mergedBlock = { ...oldBlock, ...block };
      mergedBlocks.set(value, mergedBlock);
      const next = {
        ...message,
        message: {
          role: asRecord(message.message)?.role ?? message.type,
          content: [mergedBlock],
        },
      } as Message;
      this.cacheBody(entry, key, next);
    }
    // A returning reader may only have the invocation in subscription replay,
    // while persisted history still lacks the running command. Hydrate live
    // deltas from that invocation before building the compact display overlay.
    return {
      ...message,
      message: {
        ...asRecord(message.message),
        content: content.map((block) => mergedBlocks.get(block) ?? block),
      },
    };
  }

  private cacheBody(entry: Entry, key: string, message: Message): void {
    const bytes = JSON.stringify(message).length * 2;
    if (bytes > MAX_DETAILS_BYTES / 2) return;
    const previous = entry.details.get(key);
    if (previous) {
      entry.detailBytes -= JSON.stringify(previous).length * 2;
      entry.details.delete(key);
    }
    entry.details.set(key, message);
    entry.detailBytes += bytes;
    while (entry.detailBytes > MAX_DETAILS_BYTES) {
      const first = entry.details.entries().next().value;
      if (!first) break;
      entry.detailBytes -= JSON.stringify(first[1]).length * 2;
      entry.details.delete(first[0]);
    }
  }

  private stopStreaming(
    entry: Entry,
    options: {
      exceptId?: string;
      onlyId?: string;
      runId?: string;
      supersededBy?: string;
    } = {},
  ): void {
    for (const [id, pending] of entry.overlay) {
      if (
        (pending._isStreaming !== true &&
          !(pending._isStreamingPlaceholder && options.supersededBy)) ||
        id === options.exceptId ||
        (options.onlyId && id !== options.onlyId) ||
        (options.runId &&
          (pending.codexTurnId ?? pending.turnId) !== options.runId)
      )
        continue;
      const stopped = {
        ...pending,
        _isStreaming: false,
        _isStreamingPlaceholder: true,
        ...(options.supersededBy &&
        !pending._displaySupersededBy &&
        displayTextIdentity(pending) !== options.supersededBy
          ? { _displaySupersededBy: options.supersededBy }
          : {}),
      };
      entry.overlay.set(id, stopped);
      entry.model?.message(stopped);
    }
  }

  /**
   * Remember which assistant text or tool call followed each Cursor thought.
   * Streaming updates of that same message refresh the anchor text in place.
   */
  private bindCursorThinking(
    entry: Entry,
    id: string,
    compact: RecordValue,
  ): void {
    if (!isCursorTrackedMessage(compact, entry.provider)) return;
    if (isCursorUserPrompt(compact) || compact.type === "result") {
      for (const thoughtId of entry.cursorPendingThoughts) {
        const thought = entry.overlay.get(thoughtId);
        if (thought) thought.cursorThinkingBefore ??= { fallback: true };
      }
      entry.cursorPendingThoughts.length = 0;
    }
    if (isCursorThinkingOnly(compact)) {
      if (
        compact.cursorThinkingBefore === undefined &&
        !entry.cursorPendingThoughts.includes(id)
      )
        entry.cursorPendingThoughts.push(id);
      return;
    }
    const anchor = cursorThinkingAnchor(compact);
    if (anchor && entry.cursorPendingThoughts.length > 0) {
      const bound = { ...anchor, sourceId: id };
      for (const thoughtId of entry.cursorPendingThoughts) {
        const thought = entry.overlay.get(thoughtId);
        if (
          thought &&
          thought.turnId === compact.turnId &&
          thought.cursorThinkingBefore === undefined
        )
          thought.cursorThinkingBefore = bound;
      }
      entry.cursorPendingThoughts.length = 0;
    }
    if (!anchor) return;
    for (const thought of entry.overlay.values()) {
      const before = asRecord(thought.cursorThinkingBefore);
      if (before?.sourceId !== id) continue;
      if (anchor.text) before.text = anchor.text;
      if (anchor.toolId) before.toolId = anchor.toolId;
    }
  }

  private event(entry: Entry, type: string, data: unknown): void {
    if (entry.controller.signal.aborted) return;
    const message = asRecord(data);
    if (
      type === "display-text-catchup" &&
      typeof message?.messageId === "string" &&
      typeof message.text === "string"
    ) {
      const previous = entry.overlay.get(message.messageId);
      if (
        (previous && previous._isStreaming !== true) ||
        entry.model?.isMessageCommitted(message.messageId)
      )
        return;
      this.event(entry, "message", {
        ...previous,
        type: "assistant",
        uuid: message.messageId,
        _isStreaming: true,
        _isStreamingPlaceholder: true,
        message: { role: "assistant", content: message.text },
      });
      return;
    }
    if (type === "message" && message) {
      if (
        message.isSubagent === true ||
        message.isSidechain === true ||
        (typeof message.codexThreadId === "string" &&
          message.codexThreadId !== entry.selection.sessionId) ||
        message.parent_tool_use_id ||
        message.parentToolUseId
      )
        return;
      const remembered = this.rememberBody(entry, message);
      if (message.isReplay === true) {
        if (!entry.model) {
          const key = String(
            message.uuid ??
              message.id ??
              `${message.type}:${message.turnId ?? entry.bootstrapReplay.size}`,
          );
          entry.bootstrapReplay.set(key, compactDisplayMessage(remembered));
          if (entry.bootstrapReplay.size > 500) {
            const first = entry.bootstrapReplay.keys().next().value;
            if (first) entry.bootstrapReplay.delete(first);
          }
        }
        return;
      }
      if (
        message.subtype === "history_fork_complete" ||
        message.subtype === "history_rewrite_complete"
      ) {
        entry.overlay.clear();
        entry.view = { ...entry.view, epoch: randomUUID() };
        void this.refresh(entry, true).catch(() =>
          this.emit(entry, "display-sync", { state: "retrying" }),
        );
        return;
      }
      if (
        message.subtype === "compact_boundary" ||
        message.subtype === "turn_complete" ||
        message.type === "result" ||
        (message.type === "error" && message.willRetry !== true)
      ) {
        // A failed/interrupted compaction has no completed item to replace its
        // started overlay. Retire the transient status before history refresh
        // so replay cannot resurrect a spinner after the turn has settled.
        const turnId = message.codexTurnId ?? message.turnId;
        for (const [id, pending] of entry.overlay) {
          if (
            pending.subtype === "status" &&
            pending.status === "compacting" &&
            (!turnId || (pending.codexTurnId ?? pending.turnId) === turnId)
          ) {
            entry.overlay.delete(id);
          }
        }
        const status = asRecord(entry.controls.get("message:status"));
        if (
          status?.status === "compacting" &&
          (!turnId || (status.codexTurnId ?? status.turnId) === turnId)
        ) {
          entry.controls.set("message:status", { ...status, status: null });
        }
      }
      let compact: RecordValue;
      if (message.type === "stream_event") {
        const runId = message.codexTurnId ?? message.turnId;
        if (typeof runId === "string" && entry.model?.isRunEnded(runId)) return;
        const event = asRecord(message.event);
        if (event?.type === "message_start") {
          this.stopStreaming(entry);
          entry.streamId = asRecord(event.message)?.id as string | undefined;
          this.scheduleFlush(entry);
          return;
        }
        // Codex deltas identify their item directly and do not emit message_start.
        const id = message.codexTurnId
          ? (message.uuid ?? message.id)
          : (entry.streamId ?? message.uuid ?? message.id);
        if (typeof id !== "string") return;
        if (
          event?.type === "content_block_stop" ||
          event?.type === "message_stop"
        ) {
          this.stopStreaming(entry, { onlyId: id });
          if (event.type === "message_stop") entry.streamId = undefined;
          this.scheduleFlush(entry);
          return;
        }
        const delta = asRecord(event?.delta);
        const start = event?.type === "content_block_start";
        const block = asRecord(event?.content_block);
        if (start) this.stopStreaming(entry);
        const deltaText =
          start && block?.type === "text"
            ? (block.text ?? "")
            : event?.type === "content_block_delta" &&
                delta?.type === "text_delta"
              ? delta.text
              : undefined;
        if (typeof deltaText !== "string") {
          this.scheduleFlush(entry);
          return;
        }
        const previous = entry.overlay.get(id);
        // A late delta must not resurrect a stopped or committed message.
        if (
          previous &&
          previous._isStreaming !== true &&
          (!start || previous._isStreamingPlaceholder !== true)
        )
          return;
        if (!previous || start) this.stopStreaming(entry, { exceptId: id });
        const index =
          typeof event?.index === "number" &&
          Number.isSafeInteger(event.index) &&
          event.index >= 0 &&
          event.index < 10_000
            ? event.index
            : 0;
        const content = messageContent(previous ?? {});
        const blocks: RecordValue[] = Array.isArray(content)
          ? content.map((b) => ({ ...asRecord(b) }))
          : typeof content === "string"
            ? [{ type: "text", text: content }]
            : [];
        while (blocks.length <= index) blocks.push({ type: "text", text: "" });
        const oldText = start ? "" : blocks[index]?.text;
        blocks[index] = {
          type: "text",
          text: (typeof oldText === "string" ? oldText : "") + deltaText,
        };
        compact = compactDisplayMessage({
          ...previous,
          ...message,
          uuid: id,
          type: "assistant",
          _isStreaming: true,
          _isStreamingPlaceholder: true,
          _streamingBlockIndex: index,
          message: {
            role: "assistant",
            id,
            content: blocks,
          },
        });
      } else {
        compact = compactDisplayMessage(remembered);
        const content = messageContent(message);
        const hasTool =
          Array.isArray(content) &&
          content.some((b) => asRecord(b)?.type === "tool_use");
        const isPrompt =
          message.type === "user" &&
          !(
            Array.isArray(content) &&
            content.some((b) => asRecord(b)?.type === "tool_result")
          );
        if (
          message.type === "assistant" ||
          hasTool ||
          isPrompt ||
          message.type === "result" ||
          message.type === "error" ||
          message.subtype === "turn_complete"
        ) {
          const run = message.codexTurnId ?? message.turnId;
          this.stopStreaming(entry, {
            ...(!isPrompt && typeof run === "string" ? { runId: run } : {}),
            ...(message._isStreaming === true
              ? { exceptId: String(message.uuid ?? message.id) }
              : {}),
            ...(message.type === "assistant" &&
            typeof run === "string" &&
            !message._isStreaming &&
            !hasTool &&
            (typeof content === "string" ||
              (Array.isArray(content) &&
                content.some((b) => asRecord(b)?.type === "text")))
              ? { supersededBy: displayTextIdentity(message) }
              : {}),
          });
        }
      }
      if (entry.provider === "pi" || entry.provider === "mcode") {
        // Prose ids differ between live and persisted entries for these
        // providers; stable tool ids stream while source reads reconcile prose.
        const content = messageContent(compact);
        if (compact.type !== "system" && compact.type !== "result") {
          const tools = Array.isArray(content)
            ? content.filter((value) => {
                const block = asRecord(value);
                return (
                  block?.type === "tool_use" || block?.type === "tool_result"
                );
              })
            : [];
          if (!tools.length) return;
          compact.message = { ...asRecord(compact.message), content: tools };
        }
      }
      // Codex turn/completed carries a turn id but no message id. Retain it
      // across source refreshes, which can still see the other account's
      // unfinished history after the live turn has already ended.
      const completionTurnId = compact.codexTurnId ?? compact.turnId;
      const id =
        compact.uuid ??
        compact.id ??
        (compact.subtype === "turn_complete" &&
        typeof completionTurnId === "string"
          ? `turn-complete:${completionTurnId}`
          : undefined);
      if (typeof id === "string") {
        const previous = entry.overlay.get(id);
        const oldContent = messageContent(previous ?? {});
        const newContent = messageContent(compact);
        if (Array.isArray(oldContent) && Array.isArray(newContent)) {
          const merged = new Map(
            oldContent.map((b, i) => {
              const v = asRecord(b);
              return [v?.id ?? v?.tool_use_id ?? `${v?.type}:${i}`, b];
            }),
          );
          newContent.forEach((b, i) => {
            const v = asRecord(b);
            const key = v?.id ?? v?.tool_use_id ?? `${v?.type}:${i}`;
            merged.set(key, { ...asRecord(merged.get(key)), ...v });
          });
          compact.message = {
            ...asRecord(compact.message),
            content: [...merged.values()],
          };
        }
        if (
          compact.cursorThinkingBefore === undefined &&
          previous?.cursorThinkingBefore !== undefined
        )
          compact.cursorThinkingBefore = previous.cursorThinkingBefore;
        this.bindCursorThinking(entry, id, compact);
        entry.overlay.set(id, compact);
        if (entry.overlay.size > 2_000) {
          const first = entry.overlay.keys().next().value;
          if (first) entry.overlay.delete(first);
        }
      }
      entry.model?.message(compact);
      this.scheduleFlush(entry);
      if (message.type === "result" || message.subtype === "turn_complete")
        void this.refresh(entry, true).catch(() =>
          this.emit(entry, "display-sync", { state: "retrying" }),
        );
      if (
        message.type === "system" &&
        ["init", "status", "turn_usage", "turn_complete"].includes(
          String(message.subtype),
        )
      ) {
        const control: RecordValue = {};
        for (const key of [
          "type",
          "subtype",
          "uuid",
          "turnId",
          "codexTurnId",
          "turnStatus",
          "model",
          "reasoningEffort",
          "serviceTier",
          "usage",
          "contextUsage",
          "slash_commands",
          "tools",
          "mcp_servers",
          "status",
        ]) {
          if (message[key] !== undefined) control[key] = message[key];
        }
        entry.controls.set(`message:${message.subtype}`, control);
        this.emit(entry, "message", control);
      }
      return;
    }
    if (!CONTROL_EVENTS.has(type)) return;
    // A new runtime subscription supplies a fresh queue in connected. Do not
    // let a previous process's queue override that snapshot on later reconnects.
    if (type === "connected") entry.controls.delete("deferred-queue");
    if (type === "error") {
      this.event(entry, "message", {
        type: "error",
        uuid: `runtime-error:${entry.model?.currentRunId ?? "session"}`,
        turnId: entry.model?.currentRunId,
        displayQuestionId: entry.model?.currentQuestionId,
        error:
          typeof message?.error === "string"
            ? message.error
            : typeof message?.message === "string"
              ? message.message
              : "Agent process failed",
      });
      entry.sourceSubscription?.cleanup();
      entry.sourceSubscription = null;
    }
    entry.controls.set(type, data);
    if (
      type === "complete" ||
      type === "error" ||
      (type === "retry-status" && message?.retryStatus) ||
      ((type === "connected" || type === "status") &&
        ["idle", "hold", "waiting-input"].includes(String(message?.state)))
    ) {
      this.stopStreaming(entry);
      entry.model?.stopStreaming();
    }
    if (type === "connected" || type === "status") {
      if (message?.state === "in-turn") entry.model?.setRuntime("running");
      else if (message?.state === "waiting-input")
        entry.model?.setRuntime("waiting-input");
      else if (message?.state === "hold") entry.model?.setRuntime("hold");
      else if (message?.state === "idle")
        void this.refresh(entry, true).catch(() =>
          this.emit(entry, "display-sync", { state: "retrying" }),
        );
    }
    this.scheduleFlush(entry);
    this.emit(entry, type, data);
    if (type === "complete") {
      entry.sourceSubscription?.cleanup();
      entry.sourceSubscription = null;
      void this.refresh(entry, true).catch(() =>
        this.emit(entry, "display-sync", { state: "retrying" }),
      );
    }
  }

  private refresh(
    entry: Entry,
    force: boolean,
    timing?: SessionDisplayTimingSink,
  ): Promise<void> {
    if (entry.refreshing) return entry.refreshing;
    const task = (async () => {
      const source = this.requireSource();
      const stamp = await source.stamp(entry.selection, timing);
      if (!force && stamp === entry.stamp) return;
      const page = await source.read(entry.selection, undefined, timing);
      if (entry.controller.signal.aborted) return;
      const reduceStartedAt = performance.now();
      try {
        this.applySourcePage(entry, page);
      } finally {
        timing?.add("reduce", performance.now() - reduceStartedAt);
      }
    })();
    entry.refreshing = task.finally(() => {
      entry.refreshing = undefined;
    });
    return entry.refreshing;
  }

  private applySourcePage(entry: Entry, page: DisplaySourcePage): void {
    if (page.provider === "cursor" && page.contextUsage) {
      const usage = {
        sessionId: entry.selection.sessionId,
        branchId: entry.selection.branchId,
        contextUsage: page.contextUsage,
      };
      const previous = entry.controls.get("display-context-usage");
      if (JSON.stringify(previous) !== JSON.stringify(usage)) {
        entry.controls.set("display-context-usage", usage);
        this.emit(entry, "display-context-usage", usage);
      }
    }
    if (page.provider === "cursor") {
      // The CLI does not persist its error-text chunks to native history.
      // Recover both new typed failures and older wrongly-completed turns.
      const failedTurns = new Set<unknown>();
      for (const [id, message] of entry.bootstrapReplay) {
        const failure = cursorStreamError(messageContent(message));
        if (message.type !== "error" && !failure) continue;
        failedTurns.add(message.turnId);
        entry.overlay.set(id, {
          ...message,
          type: "error",
          message: undefined,
          content: undefined,
          role: undefined,
          error: failure?.message ?? message.error,
          errorCode: failure?.code ?? message.errorCode,
        });
      }
      for (const [id, message] of entry.bootstrapReplay) {
        if (message.type === "result" && failedTurns.has(message.turnId))
          entry.overlay.set(id, {
            ...message,
            turnStatus: "failed",
            is_error: true,
          });
      }
      // Native history can contain tool or assistant rows before `<user_query>`
      // is committed. Keep the injected prompt until that row is readable.
      const promptedTurns = new Set<number>();
      const promptTexts: string[] = [];
      for (const message of page.messages) {
        if (message.type !== "user") continue;
        const body = cursorPromptBody(message);
        if (!body) continue;
        promptTexts.push(body);
        if (typeof message.cursorTurnIndex === "number")
          promptedTurns.add(message.cursorTurnIndex);
      }
      for (const [id, message] of entry.bootstrapReplay) {
        if (!isCursorUserPrompt(message)) continue;
        const index = message.cursorTurnIndex;
        if (typeof index === "number" && promptedTurns.has(index)) continue;
        const body = cursorPromptBody(message);
        if (
          typeof index !== "number" &&
          promptTexts.some((native) => cursorPromptsMatch(native, body))
        )
          continue;
        entry.overlay.set(id, message);
      }
    }
    this.acknowledgePersisted(entry, page);
    const model = new SessionDisplayReducer(entry.view, page.provider);
    let restored = page.messages;
    if (page.provider === "cursor") {
      for (const message of entry.overlay.values()) {
        if (isCursorUserPrompt(message))
          restored = insertCursorPrompt(restored, message);
      }
    }
    model.restore(restored, page.turnStatuses);
    if (!page.messages.length)
      for (const message of entry.bootstrapReplay.values())
        model.message(message, true);
    entry.bootstrapReplay.clear();
    model.setRuntime(page.activity);
    for (const message of entry.overlay.values()) {
      if (message.subtype === "turn_complete") continue;
      if (page.provider === "pi" || page.provider === "mcode") {
        if (message.type !== "system" && message.type !== "result") {
          const content = messageContent(message);
          const tools = Array.isArray(content)
            ? content.filter((value) =>
                ["tool_use", "tool_result"].includes(
                  String(asRecord(value)?.type),
                ),
              )
            : [];
          if (tools.length)
            model.message({
              ...message,
              message: { ...asRecord(message.message), content: tools },
            });
          continue;
        }
      }
      model.message(message);
    }
    // Apply terminal facts after replaying prose. An older turn must not
    // close a newer, not-yet-persisted turn in the same overlay.
    for (const message of entry.overlay.values()) {
      if (message.subtype === "turn_complete") model.message(message);
    }
    if (page.provider === "cursor" && entry.model)
      model.restoreToolTimings(entry.model.tools.values());
    entry.provider = page.provider;
    const controlState = asRecord(
      entry.controls.get("status") ?? entry.controls.get("connected"),
    )?.state;
    if (
      (controlState === "hold" || controlState === "waiting-input") &&
      !["completed", "interrupted", "failed"].includes(
        model.snapshot().activity.state,
      )
    )
      model.setRuntime(controlState);
    entry.stamp = page.stamp;
    const previous = entry.snapshot;
    const previousTail = previous?.nodes.at(-1);
    if (
      previousTail &&
      !model.snapshot().nodes.some((node) => node.id === previousTail.id)
    ) {
      // A rewrite (or a source window too far ahead to prove continuity)
      // invalidates the view. Do not replay acknowledged, removed history.
      entry.view = { ...entry.view, epoch: randomUUID() };
      model.view = entry.view;
    }
    entry.model = model;
    if (!previous || previous.view.epoch !== entry.view.epoch) {
      entry.snapshot = model.snapshot(page.cursor);
      this.emit(entry, "display-snapshot", entry.snapshot);
    } else {
      const patch = model.commit(previous);
      entry.snapshot = model.snapshot(page.cursor);
      if (patch) this.emit(entry, "display-patch", patch);
    }
  }

  private acknowledgePersisted(entry: Entry, page: DisplaySourcePage): void {
    for (const [runId, status] of Object.entries(page.turnStatuses ?? {})) {
      if (status !== "running") this.stopStreaming(entry, { runId });
    }
    const results = new Set<string>();
    const questions = new Set<string>();
    const texts = new Map<string, string>();
    const nativeItems = new Set<string>();
    const nativeIdentity = (message: RecordValue): string | undefined => {
      const item = asRecord(message.codexThreadItem);
      if (
        message.subtype !== "codex_native_item" ||
        (item?.type !== "interAgentMessage" &&
          item?.type !== "subAgentActivity" &&
          item?.type !== "agentWait") ||
        typeof item.id !== "string"
      )
        return undefined;
      return JSON.stringify([
        message.codexThreadId ?? entry.selection.sessionId,
        message.codexTurnId ?? message.turnId ?? "",
        item.type,
        item.id,
        item.type === "agentWait"
          ? `${item.status}:${item.outcome ?? ""}`
          : item.kind,
      ]);
    };
    const completedAnswerTurns = new Set<string>();
    const identity = displayTextIdentity;
    const text = (content: unknown) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((value) => {
                const block = asRecord(value);
                return block?.type === "text" && typeof block.text === "string"
                  ? [block.text]
                  : [];
              })
              .join("")
          : "";
    const cursorTurns = new Map<number, { hasPrompt: boolean; text: string }>();
    const completedCursorTurns = new Set<number>();
    const cursorPromptTexts: string[] = [];
    if (page.provider === "cursor") {
      for (const message of entry.overlay.values()) {
        if (
          message.type === "result" &&
          typeof message.cursorTurnIndex === "number"
        )
          completedCursorTurns.add(message.cursorTurnIndex);
      }
      for (const message of page.messages) {
        const index = message.cursorTurnIndex;
        if (typeof index !== "number") continue;
        const turn = cursorTurns.get(index) ?? { hasPrompt: false, text: "" };
        const content = messageContent(message);
        if (message.type === "user" && typeof content === "string") {
          turn.hasPrompt = true;
          const body = content.trim();
          if (body) cursorPromptTexts.push(body);
        }
        if (message.type === "assistant") turn.text += text(content);
        cursorTurns.set(index, turn);
      }
    }
    for (const message of page.messages) {
      const nativeKey = nativeIdentity(message);
      if (nativeKey) nativeItems.add(nativeKey);
      const content = messageContent(message);
      const blocks = Array.isArray(content) ? content.map(asRecord) : [];
      const run = String(message.codexTurnId ?? message.turnId ?? "session");
      for (const block of blocks)
        if (block?.type === "tool_result")
          results.add(`${run}:${block.tool_use_id}`);
      if (
        message.type === "user" &&
        !blocks.some((block) => block?.type === "tool_result")
      )
        questions.add(
          String(
            message.clientUserMessageId ??
              message.codexCorrelationKey ??
              message.uuid ??
              message.id,
          ),
        );
      if (message.type === "assistant" && text(content)) {
        texts.set(identity(message), text(content));
        if (
          (page.provider === "codex" || page.provider === "codex-oss") &&
          message.codexMessagePhase === "final_answer" &&
          page.turnStatuses?.[run] === "completed"
        )
          completedAnswerTurns.add(run);
      }
    }
    for (const [key, message] of entry.overlay) {
      const nativeKey = nativeIdentity(message);
      if (nativeKey && nativeItems.has(nativeKey)) {
        entry.overlay.delete(key);
        continue;
      }
      const turnId = message.codexTurnId ?? message.turnId;
      const window = page.codexTurnWindow;
      const timestamp =
        typeof message.timestamp === "string"
          ? Date.parse(message.timestamp)
          : Number.NaN;
      // Older providers lost the child thread id. Only remove such leftovers
      // when native history proves their turn is absent within the loaded
      // interval. Unknown newer turns and turns outside this page remain live.
      if (
        (typeof message.codexThreadId === "string" &&
          message.codexThreadId !== entry.selection.sessionId) ||
        (message.codexThreadId === undefined &&
          window &&
          typeof turnId === "string" &&
          !window.turnIds.includes(turnId) &&
          timestamp >= window.from &&
          timestamp < window.before)
      ) {
        entry.overlay.delete(key);
        continue;
      }
      if (
        message.type === "error" &&
        typeof message.displayQuestionId === "string"
      ) {
        const latestQuestion = [...questions].at(-1);
        if (
          latestQuestion &&
          `question:${latestQuestion}` !== message.displayQuestionId
        ) {
          entry.overlay.delete(key);
          continue;
        }
      }
      const content = messageContent(message);
      const blocks = Array.isArray(content) ? content.map(asRecord) : [];
      const run = String(message.codexTurnId ?? message.turnId ?? "session");
      const tools = blocks.filter(
        (block) => block?.type === "tool_use" || block?.type === "tool_result",
      );
      // Cursor persists content hashes while ACP chunks have local UUIDs.
      // Correlate within the native turn ordinal; matching an older turn's
      // identical reply must never erase output from a new turn.
      if (
        page.provider === "cursor" &&
        isCursorUserPrompt(message) &&
        typeof message.cursorTurnIndex !== "number" &&
        cursorPromptTexts.some((native) =>
          cursorPromptsMatch(native, cursorPromptBody(message)),
        )
      ) {
        entry.overlay.delete(key);
        continue;
      }
      const cursorTurn =
        typeof message.cursorTurnIndex === "number"
          ? cursorTurns.get(message.cursorTurnIndex)
          : undefined;
      if (cursorTurn?.hasPrompt && !tools.length) {
        const body = text(content);
        const thinkingBodies = blocks.flatMap((block) =>
          block?.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
            ? [block.thinking]
            : [],
        );
        // Native history keeps an encrypted signature and an empty reasoning
        // body. Drop the live thought only when that body is actually in the
        // persisted assistant text.
        const settledThinking =
          message.type === "assistant" &&
          !body &&
          thinkingBodies.length > 0 &&
          thinkingBodies.every((thinking) =>
            cursorTurn.text.includes(thinking),
          ) &&
          completedCursorTurns.has(message.cursorTurnIndex as number) &&
          blocks.every((block) => block?.type === "thinking");
        if (
          message.type === "user" ||
          settledThinking ||
          (message.type === "assistant" &&
            body &&
            cursorTurn.text.includes(body))
        ) {
          entry.overlay.delete(key);
          continue;
        }
      }
      // A later committed item can replace an abandoned sampling attempt while
      // the turn keeps running. Wait for that specific replacement in history;
      // until then retain the partial text with its streaming indicator stopped.
      if (
        message._isStreamingPlaceholder === true &&
        !tools.length &&
        typeof message._displaySupersededBy === "string" &&
        texts.has(message._displaySupersededBy)
      ) {
        entry.overlay.delete(key);
        continue;
      }
      // A sampling retry can abandon an item mid-delta and finish under a new
      // item ID. It will never have an exact persisted identity/text match.
      // Retire only transient prose from a turn whose completed final answer
      // is in this source page; live completion alone can race persistence.
      if (
        message.type === "assistant" &&
        (message._isStreaming === true ||
          message._isStreamingPlaceholder === true) &&
        !tools.length &&
        typeof turnId === "string" &&
        completedAnswerTurns.has(turnId)
      ) {
        entry.overlay.delete(key);
        continue;
      }
      if (
        tools.length &&
        tools.every((block) =>
          results.has(`${run}:${block?.id ?? block?.tool_use_id}`),
        ) &&
        (!text(content) || texts.get(identity(message)) === text(content))
      )
        entry.overlay.delete(key);
      else if (
        !tools.length &&
        message.type === "assistant" &&
        texts.get(identity(message)) === text(content)
      )
        entry.overlay.delete(key);
      else if (
        message.type === "user" &&
        !tools.length &&
        questions.has(
          String(
            message.clientUserMessageId ??
              message.codexCorrelationKey ??
              message.uuid ??
              message.id,
          ),
        )
      )
        entry.overlay.delete(key);
      else if (
        message.subtype === "turn_complete" &&
        page.turnStatuses?.[run] === message.turnStatus &&
        page.activity === message.turnStatus
      )
        entry.overlay.delete(key);
    }
  }

  private emit(entry: Entry, type: string, data: unknown): void {
    for (const emit of entry.listeners) emit(type, data);
  }
  private scheduleFlush(entry: Entry): void {
    if (!entry.model || entry.flushTimer) return;
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = undefined;
      this.flush(entry);
    }, 25);
    entry.flushTimer.unref?.();
  }
  private flush(entry: Entry): void {
    if (!entry.model || !entry.snapshot) return;
    const patch = entry.model.commit(entry.snapshot);
    if (!patch) return;
    entry.snapshot = entry.model.snapshot(entry.snapshot.olderCursor);
    this.emit(entry, "display-patch", patch);
  }
  private poll(entry: Entry): void {
    if (entry.controller.signal.aborted) return;
    entry.pollTimer = setTimeout(async () => {
      try {
        // Stable-id owned providers are updated incrementally from runtime.
        // File-backed/external providers use the same projection transport.
        if (
          !entry.sourceSubscription ||
          !["in-turn", "waiting-input"].includes(
            String(
              asRecord(
                entry.controls.get("status") ?? entry.controls.get("connected"),
              )?.state,
            ),
          ) ||
          !["codex", "codex-oss", "claude", "claude-ollama"].includes(
            entry.provider ?? "",
          )
        )
          await this.refresh(entry, false);
        if (!entry.sourceSubscription && !entry.selection.branchId) {
          const process = entry.listeners.size
            ? await this.options.runtime.getProcessForSession(
                entry.selection.sessionId,
              )
            : null;
          if (process) {
            // A different process started after this projection was built
            // (idle resume, settings restart). Its buffered events, including
            // the prompt it was started with, were emitted before this attach
            // and are absent from native history that persists them late, so
            // they are live news here. Resubscribing to the same process keeps
            // treating replay as already-seen history.
            const unseenProcess = process.id !== entry.sourceProcessId;
            entry.sourceProcessId = process.id;
            entry.sourceSubscription =
              await this.options.runtime.subscribeSession(
                entry.selection.sessionId,
                (type, data) =>
                  this.event(
                    entry,
                    type,
                    unseenProcess ? asLiveReplay(type, data) : data,
                  ),
                { signal: entry.controller.signal, displayProjection: true },
              );
            // Reconcile the recovered events against what native history
            // already persisted, instead of waiting for its next change.
            if (unseenProcess) await this.refresh(entry, true);
          }
        }
      } catch {
        this.emit(entry, "display-sync", { state: "retrying" });
      }
      this.poll(entry);
    }, this.options.pollMs ?? 1_000);
    entry.pollTimer.unref?.();
  }
  private expire(entry: Entry): void {
    if (entry.expiry) clearTimeout(entry.expiry);
    if (entry.listeners.size) return;
    entry.expiry = setTimeout(
      () => this.sleep(this.key(entry.selection), entry),
      this.options.retentionMs ?? 30_000,
    );
    entry.expiry.unref?.();
  }
  private drop(key: string, entry: Entry): void {
    entry.controller.abort();
    entry.sourceSubscription?.cleanup();
    clearTimeout(entry.flushTimer);
    clearTimeout(entry.pollTimer);
    clearTimeout(entry.expiry);
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
  dispose(): void {
    for (const [key, entry] of this.entries) this.drop(key, entry);
    this.dormant.clear();
    this.dormantBytes = 0;
  }

  async subscribe(
    selection: DisplaySelection,
    emit: Emit,
    signal?: AbortSignal,
    known?: SessionDisplayKnownView,
  ): Promise<{ cleanup(): void }> {
    const entry = await this.get(selection);
    if (signal?.aborted) return { cleanup() {} };
    clearTimeout(entry.expiry);
    this.flush(entry);
    const connected = entry.controls.get("connected");
    const status = asRecord(entry.controls.get("status"));
    const deferredQueue = asRecord(entry.controls.get("deferred-queue"));
    emit("connected", {
      ...asRecord(connected),
      sessionId: selection.sessionId,
      ...(status
        ? { state: status.state, request: status.request ?? null }
        : {}),
      ...(Array.isArray(deferredQueue?.messages)
        ? { deferredMessages: deferredQueue.messages }
        : {}),
    });
    const snapshot = entry.snapshot;
    if (
      snapshot &&
      known?.epoch === snapshot.view.epoch &&
      known.seq === snapshot.seq
    ) {
      // The client already holds exactly this projection (cached or loaded
      // over HTTP); skip re-sending the whole snapshot.
      emit("display-current", {
        view: snapshot.view,
        seq: snapshot.seq,
      } satisfies SessionDisplayCurrent);
    } else emit("display-snapshot", snapshot);
    const contextUsage = entry.controls.get("display-context-usage");
    if (contextUsage) emit("display-context-usage", contextUsage);
    for (const [key, value] of entry.controls)
      if (key.startsWith("message:init")) emit("message", value);
    entry.listeners.add(emit);
    const cleanup = () => {
      entry.listeners.delete(emit);
      this.expire(entry);
      signal?.removeEventListener("abort", cleanup);
    };
    signal?.addEventListener("abort", cleanup, { once: true });
    return { cleanup };
  }
  async snapshot(
    selection: DisplaySelection,
    reset = false,
    observer?: SessionDisplayReadObserver,
  ): Promise<SessionDisplaySnapshot> {
    const entry = await this.get(selection, observer);
    if (reset) {
      entry.overlay.clear();
      entry.cursorPendingThoughts.length = 0;
      entry.view = { ...entry.view, epoch: randomUUID() };
      await this.refresh(entry, true, observer?.timing);
      await timed(observer?.timing, "replay", () =>
        this.recoverCursorHistory(entry),
      );
    }
    this.flush(entry);
    if (!entry.snapshot) throw new Error("Display snapshot is not ready");
    return entry.snapshot;
  }
  async older(
    selection: DisplaySelection,
    cursor: string,
    observer?: SessionDisplayReadObserver,
  ): Promise<SessionDisplaySnapshot> {
    const entry = await this.get(selection, observer);
    const view = entry.view;
    const page = await this.requireSource().read(
      selection,
      cursor,
      observer?.timing,
    );
    if (entry.view.epoch !== view.epoch)
      throw new Error("Display view changed while loading history");
    const reduceStartedAt = performance.now();
    const model = new SessionDisplayReducer(view, page.provider);
    model.restore(page.messages, page.turnStatuses);
    if (!entry.snapshot) throw new Error("Display snapshot is not ready");
    const snapshot = {
      ...model.snapshot(page.cursor),
      seq: entry.snapshot.seq,
    };
    observer?.timing?.add("reduce", performance.now() - reduceStartedAt);
    return snapshot;
  }
  async group(
    selection: DisplaySelection,
    groupId: string,
    cursor?: string,
  ): Promise<SessionDisplayGroupPage> {
    const entry = await this.get(selection);
    // Closed groups still retain their lightweight index. Use the same group
    // membership as the displayed snapshot, including when paginating: history
    // may record long-running tools in completion order across text boundaries.
    // Only groups outside this projection need to be reconstructed from history.
    let steps = entry.model?.groupSteps(groupId);
    if (!steps) {
      const locator = decodeDisplayToolId(groupId.replace(/^dg2\./, "dt2."));
      if (!locator) throw new Error("Invalid display group id");
      const messages = await this.requireSource().detail(
        selection,
        locator.runId,
      );
      const model = new SessionDisplayReducer(entry.view, entry.provider);
      model.restore(messages);
      steps = model.groupSteps(groupId);
    }
    if (!steps) throw new Error("Display tool group not found");
    const end = cursor ? Number(cursor) : steps.length;
    if (!Number.isSafeInteger(end) || end < 0 || end > steps.length)
      throw new Error("Invalid group cursor");
    const start = Math.max(0, end - 50);
    return {
      groupId,
      total: steps.length,
      steps: steps.slice(start, end),
      ...(start > 0 ? { nextCursor: String(start) } : {}),
    };
  }
  private toolOutput(
    entry: Entry,
    toolId: string,
  ): SessionDisplayToolOutput | undefined {
    const step = entry.model?.tools.get(toolId)?.step;
    if (!step) return undefined;
    const output = step.status === "running" ? step.preview : "";
    const revision = createHash("sha256")
      .update(JSON.stringify([entry.view.epoch, toolId, step.status, output]))
      .digest("base64url")
      .slice(0, 20);
    return { revision, status: step.status, output };
  }

  async output(
    selection: DisplaySelection,
    toolId: string,
    since?: string,
  ): Promise<SessionDisplayToolOutput> {
    if (!decodeDisplayToolId(toolId))
      throw new Error("Invalid display tool id");
    // Read only the existing projection's bounded tail. No detail/history reads,
    // Markdown augmentation, or serialization of command inputs on this path.
    const result = this.toolOutput(await this.get(selection), toolId);
    if (!result) throw new Error("Unknown display tool id");
    return result.revision === since
      ? { revision: result.revision, status: result.status }
      : result;
  }

  async detail(
    selection: DisplaySelection,
    toolId: string,
    cursor?: string,
  ): Promise<SessionDisplayToolDetail<Message>> {
    const locator = decodeDisplayToolId(toolId);
    if (!locator) throw new Error("Invalid display tool id");
    const entry = await this.get(selection);
    let messages = selectSessionDisplayToolMessages(
      [...entry.details.values()].filter(
        (m) => (m.codexTurnId ?? m.turnId ?? "session") === locator.runId,
      ),
      [locator.rawId],
    );
    if (
      !hasToolInvocation(messages) ||
      !messages.some((m) => m.type === "user")
    ) {
      const persisted = await this.requireSource().detail(
        selection,
        locator.runId,
        locator.rawId,
      );
      if (persisted.length) messages = persisted;
    }
    if (!hasToolInvocation(messages))
      throw new Error("Tool invocation is unavailable");
    // Persisted detail may only contain the original invocation. Keep the
    // current output tail independent of that body, including JSON pagination.
    const output = this.toolOutput(entry, toolId);
    const liveOutput =
      output?.status === "running"
        ? { liveOutput: output.output, liveOutputRevision: output.revision }
        : {};
    // Details are fetched one tool at a time. Huge raw values use a paged JSON
    // representation rather than forcing all renderer inputs into the browser.
    const json = JSON.stringify(messages);
    if (json.length > MAX_BODY_PAGE) {
      const revision = createHash("sha256")
        .update(json)
        .digest("base64url")
        .slice(0, 20);
      let offset = 0;
      if (cursor) {
        const decoded = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        );
        if (
          !Number.isSafeInteger(decoded.offset) ||
          decoded.offset < 0 ||
          (decoded.revision === revision && decoded.offset >= json.length)
        )
          throw new Error("Invalid detail cursor");
        if (decoded.revision === revision) offset = decoded.offset;
      }
      const next = Math.min(json.length, offset + MAX_BODY_PAGE);
      return {
        toolId,
        version: entry.model?.tools.get(toolId)?.step.version ?? 0,
        ...liveOutput,
        messages: [],
        rawJson: {
          content: json.slice(offset, next),
          offset,
          total: json.length,
          revision,
        },
        ...(next < json.length
          ? {
              nextCursor: Buffer.from(
                JSON.stringify({ offset: next, revision }),
              ).toString("base64url"),
            }
          : {}),
      };
    }
    await augmentPersistedSessionMessages(messages);
    return {
      toolId,
      version: entry.model?.tools.get(toolId)?.step.version ?? 0,
      ...liveOutput,
      messages,
    };
  }

  async reasoning(selection: DisplaySelection, id: string): Promise<string> {
    const entry = await this.get(selection);
    const cached = () => {
      const content = messageContent(entry.details.get(id) ?? {});
      const block = Array.isArray(content) ? asRecord(content[0]) : undefined;
      return block?.type === "thinking" && typeof block.thinking === "string"
        ? block.thinking
        : undefined;
    };
    const body = cached();
    if (body !== undefined) return body;
    // Cursor persists different IDs and may encrypt reasoning in its native
    // store. The retained runtime journal is authoritative for live-only IDs.
    if (
      entry.provider === "cursor" &&
      !selection.branchId &&
      this.options.runtime.replay
    ) {
      const records = await this.options.runtime.replay({
        sessionId: selection.sessionId,
        allProcesses: true,
      });
      for (const record of records) {
        if (
          record.type !== "message" ||
          record.sessionId !== selection.sessionId
        )
          continue;
        const message = asRecord(record.data);
        const identity =
          message?.codexCorrelationKey ?? message?.uuid ?? message?.id;
        if (
          message &&
          typeof identity === "string" &&
          id.startsWith(`thinking:${identity}:`)
        )
          this.rememberBody(entry, message);
      }
      const replayed = cached();
      if (replayed !== undefined) return replayed;
    }
    const read = this.requireSource().reasoning;
    if (!read) throw new Error("Reasoning detail is unavailable");
    return read(selection, id);
  }
}

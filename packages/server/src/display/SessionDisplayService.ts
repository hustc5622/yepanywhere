import { createHash, randomUUID } from "node:crypto";
import type {
  SessionDisplayActivity,
  SessionDisplayGroupPage,
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
import type {
  RuntimeController,
  RuntimeSessionSubscription,
} from "../runtime/types.js";
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

export interface DisplaySelection {
  projectId: string;
  sessionId: string;
  branchId?: string;
}
export interface DisplaySourcePage {
  provider: string;
  messages: Message[];
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
  ): Promise<DisplaySourcePage>;
  stamp(selection: DisplaySelection): Promise<string>;
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
  model?: SessionDisplayReducer;
  snapshot?: SessionDisplaySnapshot;
  listeners: Set<Emit>;
  sourceSubscription?: RuntimeSessionSubscription | null;
  controller: AbortController;
  overlay: Map<string, RecordValue>;
  bootstrapReplay: RecordValue[];
  controls: Map<string, unknown>;
  details: Map<string, Message>;
  detailBytes: number;
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
  constructor(
    private readonly options: {
      runtime: Pick<
        RuntimeController,
        "subscribeSession" | "getProcessForSession"
      >;
      pollMs?: number;
      retentionMs?: number;
      maxEntries?: number;
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
  private async get(selection: DisplaySelection): Promise<Entry> {
    const key = this.key(selection);
    let entry = this.entries.get(key);
    if (!entry) {
      const max = this.options.maxEntries ?? 16;
      for (const [oldKey, candidate] of this.entries) {
        if (this.entries.size < max) break;
        if (candidate.snapshot && !candidate.listeners.size)
          this.drop(oldKey, candidate);
      }
      if (this.entries.size >= max)
        throw new Error("Too many active session displays");
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
        bootstrapReplay: [],
        controls: new Map(),
        details: new Map(),
        detailBytes: 0,
      };
      this.entries.set(key, entry);
      const current = entry;
      entry.ready = this.initialize(current).catch((error) => {
        this.drop(key, current);
        throw error;
      });
    }
    await entry.ready;
    return entry;
  }

  private async initialize(entry: Entry): Promise<void> {
    // Attach before reading history. Subscription replay is kept on the server;
    // subsequent live events are overlaid after the cold source read.
    if (
      !entry.selection.branchId &&
      (await this.options.runtime.getProcessForSession(
        entry.selection.sessionId,
      ))
    ) {
      entry.sourceSubscription = await this.options.runtime.subscribeSession(
        entry.selection.sessionId,
        (type, data) => this.event(entry, type, data),
        { signal: entry.controller.signal, displayProjection: true },
      );
    }
    await this.refresh(entry, true);
    this.poll(entry);
    this.expire(entry);
  }

  private rememberBody(entry: Entry, message: RecordValue): RecordValue {
    const content = messageContent(message);
    if (!Array.isArray(content)) return message;
    const mergedBlocks = new Map<unknown, RecordValue>();
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
      const bytes = JSON.stringify(next).length * 2;
      if (bytes > MAX_DETAILS_BYTES / 2) continue;
      if (previous) {
        entry.detailBytes -= JSON.stringify(previous).length * 2;
        entry.details.delete(key);
      }
      entry.details.set(key, next);
      entry.detailBytes += bytes;
      while (entry.detailBytes > MAX_DETAILS_BYTES) {
        const first = entry.details.entries().next().value;
        if (!first) break;
        entry.detailBytes -= JSON.stringify(first[1]).length * 2;
        entry.details.delete(first[0]);
      }
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
        if (!entry.model && entry.bootstrapReplay.length < 500)
          entry.bootstrapReplay.push(compactDisplayMessage(remembered));
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
      if (entry.provider === "pi" || entry.provider === "kimi") {
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

  private refresh(entry: Entry, force: boolean): Promise<void> {
    if (entry.refreshing) return entry.refreshing;
    const task = (async () => {
      const source = this.requireSource();
      const stamp = await source.stamp(entry.selection);
      if (!force && stamp === entry.stamp) return;
      const page = await source.read(entry.selection);
      if (entry.controller.signal.aborted) return;
      this.acknowledgePersisted(entry, page);
      const model = new SessionDisplayReducer(entry.view, page.provider);
      model.restore(page.messages, page.turnStatuses);
      if (!page.messages.length)
        for (const message of entry.bootstrapReplay)
          model.message(message, true);
      entry.bootstrapReplay = [];
      model.setRuntime(page.activity);
      for (const message of entry.overlay.values()) {
        if (message.subtype === "turn_complete") continue;
        if (page.provider === "pi" || page.provider === "kimi") {
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
    })();
    entry.refreshing = task.finally(() => {
      entry.refreshing = undefined;
    });
    return entry.refreshing;
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
        if (
          !entry.sourceSubscription &&
          !entry.selection.branchId &&
          entry.listeners.size &&
          (await this.options.runtime.getProcessForSession(
            entry.selection.sessionId,
          ))
        ) {
          entry.sourceSubscription =
            await this.options.runtime.subscribeSession(
              entry.selection.sessionId,
              (type, data) => this.event(entry, type, data),
              { signal: entry.controller.signal, displayProjection: true },
            );
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
      () => this.drop(this.key(entry.selection), entry),
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
  }

  async subscribe(
    selection: DisplaySelection,
    emit: Emit,
    signal?: AbortSignal,
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
    emit("display-snapshot", entry.snapshot);
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
  ): Promise<SessionDisplaySnapshot> {
    const entry = await this.get(selection);
    if (reset) {
      entry.overlay.clear();
      entry.view = { ...entry.view, epoch: randomUUID() };
      await this.refresh(entry, true);
    }
    this.flush(entry);
    if (!entry.snapshot) throw new Error("Display snapshot is not ready");
    return entry.snapshot;
  }
  async older(
    selection: DisplaySelection,
    cursor: string,
  ): Promise<SessionDisplaySnapshot> {
    const entry = await this.get(selection);
    const view = entry.view;
    const page = await this.requireSource().read(selection, cursor);
    if (entry.view.epoch !== view.epoch)
      throw new Error("Display view changed while loading history");
    const model = new SessionDisplayReducer(view, page.provider);
    model.restore(page.messages, page.turnStatuses);
    if (!entry.snapshot) throw new Error("Display snapshot is not ready");
    return { ...model.snapshot(page.cursor), seq: entry.snapshot.seq };
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
    const read = this.requireSource().reasoning;
    if (!read) throw new Error("Reasoning detail is unavailable");
    return read(selection, id);
  }
}

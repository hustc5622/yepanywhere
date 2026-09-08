import { createHash, randomUUID } from "node:crypto";
import type {
  SessionDisplayActivity,
  SessionDisplayGroupPage,
  SessionDisplaySnapshot,
  SessionDisplayToolDetail,
  SessionDisplayTurnStatus,
  SessionDisplayView,
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
    "turnId",
    "codexCorrelationKey",
    "clientUserMessageId",
    "codexMessagePhase",
    "subtype",
    "turnStatus",
    "is_error",
    "willRetry",
    "isSubagent",
    "isSidechain",
    "_isStreaming",
    "error",
    "parentUuid",
    "branch",
  ]) {
    if (message[key] !== undefined) result[key] = message[key];
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
            "file_path",
            "path",
            "url",
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
            displayChangedPaths: extractToolPaths(block.input),
            name: block.name,
            status: block.status,
            ...(block.input !== undefined ? { input: args } : {}),
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

  private rememberBody(entry: Entry, message: RecordValue): void {
    const content = messageContent(message);
    if (!Array.isArray(content)) return;
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
      const next = {
        ...message,
        message: {
          role: asRecord(message.message)?.role ?? message.type,
          content: [{ ...oldBlock, ...block }],
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
  }

  private event(entry: Entry, type: string, data: unknown): void {
    if (entry.controller.signal.aborted) return;
    const message = asRecord(data);
    if (
      type === "display-text-catchup" &&
      typeof message?.messageId === "string" &&
      typeof message.text === "string"
    ) {
      this.event(entry, "message", {
        type: "assistant",
        uuid: message.messageId,
        _isStreaming: true,
        message: { role: "assistant", content: message.text },
      });
      return;
    }
    if (type === "message" && message) {
      if (
        message.isSubagent === true ||
        message.isSidechain === true ||
        message.parent_tool_use_id ||
        message.parentToolUseId
      )
        return;
      this.rememberBody(entry, message);
      if (message.isReplay === true) {
        if (!entry.model && entry.bootstrapReplay.length < 500)
          entry.bootstrapReplay.push(compactDisplayMessage(message));
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
      let compact: RecordValue;
      if (message.type === "stream_event") {
        const event = asRecord(message.event);
        if (event?.type === "message_start")
          entry.streamId = asRecord(event.message)?.id as string | undefined;
        const delta = asRecord(event?.delta);
        if (
          event?.type !== "content_block_delta" ||
          delta?.type !== "text_delta" ||
          typeof delta.text !== "string"
        )
          return;
        const id = entry.streamId ?? message.uuid ?? message.id;
        if (typeof id !== "string") return;
        const previous = entry.overlay.get(id);
        const text = messageContent(previous ?? {});
        compact = compactDisplayMessage({
          ...message,
          uuid: id,
          type: "assistant",
          _isStreaming: true,
          message: {
            role: "assistant",
            id,
            content: (typeof text === "string" ? text : "") + delta.text,
          },
        });
      } else compact = compactDisplayMessage(message);
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
      const id = compact.uuid ?? compact.id;
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
    const results = new Set<string>();
    const questions = new Set<string>();
    const texts = new Map<string, string>();
    const identity = (message: RecordValue) =>
      String(
        message.codexCorrelationKey ??
          asRecord(message.message)?.id ??
          message.uuid ??
          message.id ??
          "",
      );
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
      if (message.type === "assistant" && text(content))
        texts.set(identity(message), text(content));
    }
    for (const [key, message] of entry.overlay) {
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
        page.turnStatuses?.[run] === message.turnStatus
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
    let steps = entry.model?.groupSteps(groupId);
    const group = entry.snapshot?.nodes.find((n) => n.id === groupId);
    if (
      cursor ||
      (group?.type === "segment" &&
        group.segment.type === "tool_group" &&
        group.segment.displayMode === "summary")
    )
      steps = null;
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
    if (!messages.length || !messages.some((m) => m.type === "user")) {
      const persisted = await this.requireSource().detail(
        selection,
        locator.runId,
        locator.rawId,
      );
      if (persisted.length) messages = persisted;
    }
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
      messages,
    };
  }

  async reasoning(selection: DisplaySelection, id: string): Promise<string> {
    const read = this.requireSource().reasoning;
    if (!read) throw new Error("Reasoning detail is unavailable");
    return read(selection, id);
  }
}

import type { CodexAsyncMessage } from "@yep-anywhere/shared";
import {
  SESSION_DISPLAY_LIVE_STEP_LIMIT,
  SESSION_DISPLAY_STEP_PREVIEW_LIMIT,
  type SessionDisplayActivity,
  type SessionDisplayNode,
  type SessionDisplayPatch,
  type SessionDisplaySnapshot,
  type SessionDisplayToolStep,
  type SessionDisplayTurnStatus,
  type SessionDisplayView,
} from "@yep-anywhere/shared";
import { renderSafeMarkdown } from "../augments/safe-markdown.js";
import { normalizeCodexToolInvocation } from "../codex/normalization.js";
import {
  buildSessionDisplayProjection,
  extractToolPaths,
  isCheckTool,
} from "../sessions/display-projection.js";
import type { Message } from "../supervisor/types.js";

type RecordValue = Record<string, unknown>;
type GroupSegment = Extract<
  Extract<SessionDisplayNode, { type: "segment" }>["segment"],
  { type: "tool_group" }
>;

export interface DisplayToolRecord {
  rawId: string;
  runId: string;
  step: SessionDisplayToolStep;
  paths: Set<string>;
  check: boolean;
  position: number;
  /**
   * Identity of the assistant message that requested the call. Calls sharing a
   * batch were issued together and may finish in any order; calls in different
   * batches are strictly sequential, because a model only emits the next batch
   * after it has seen the results of the previous one.
   */
  batch: string;
}
interface Group {
  id: string;
  runId: string;
  tools: string[];
  closed: boolean;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
export function displayToolId(runId: string, rawId: string): string {
  return `dt2.${Buffer.from(JSON.stringify([runId, rawId])).toString("base64url")}`;
}
export function decodeDisplayToolId(
  id: string,
): { runId: string; rawId: string } | null {
  if (!id.startsWith("dt2.") || id.length > 8_192) return null;
  try {
    const values: unknown = JSON.parse(
      Buffer.from(id.slice(4), "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(values) ||
      values.length !== 2 ||
      !values.every((v) => typeof v === "string" && v.length > 0)
    )
      return null;
    return { runId: values[0], rawId: values[1] };
  } catch {
    return null;
  }
}
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .flatMap((v) => {
        const block = record(v);
        return typeof block?.text === "string" ? [block.text] : [];
      })
      .join("\n");
  return "";
}
function toolSummary(input: unknown): string {
  const args = record(input);
  if (!args) return typeof input === "string" ? input.slice(0, 1_024) : "";
  for (const key of [
    "command",
    "cmd",
    "file_path",
    "path",
    "url",
    "pattern",
    "query",
    "description",
    "prompt",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 1_024);
  }
  return "";
}

/**
 * Server-owned display facts. Tool bodies never enter this reducer. The same
 * operations build cold history and live state; a message commit closes only
 * the preceding presentation groups, not the provider's execution turn.
 */
export class SessionDisplayReducer {
  private nodes: SessionDisplayNode[] = [];
  private renderedNodes = new WeakMap<SessionDisplayNode, SessionDisplayNode>();
  private nodeIndices = new Map<string, number>();
  private groups = new Map<string, Group>();
  readonly tools = new Map<string, DisplayToolRecord>();
  /** Tool records in creation order, used to detect stranded steps. */
  private toolOrder: DisplayToolRecord[] = [];
  private rawToolIds = new Map<string, string>();
  private aliases = new Map<string, string>();
  private committed = new Set<string>();
  private currentRun = "session";
  private currentSection = "preamble";
  private currentGroup: string | undefined;
  private streamingId: string | undefined;
  private runtime: SessionDisplayActivity["state"] = "unknown";
  private compactionRun: string | undefined;
  private seq = 0;

  constructor(
    public view: SessionDisplayView,
    private readonly provider?: string,
  ) {}

  get currentRunId(): string {
    return this.currentRun;
  }
  get currentQuestionId(): string | undefined {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (node?.type === "question") return node.id;
    }
    return undefined;
  }

  restore(
    messages: readonly Message[],
    statuses?: Readonly<Record<string, SessionDisplayTurnStatus>>,
  ): void {
    for (const message of messages) this.message(message as RecordValue, true);
    for (const [runId, status] of Object.entries(statuses ?? {})) {
      if (status !== "running") this.closeRun(runId, status);
    }
  }

  private put(node: SessionDisplayNode): void {
    const index = this.nodeIndices.get(node.id);
    if (index === undefined) {
      this.nodeIndices.set(node.id, this.nodes.length);
      this.nodes.push(node);
    } else this.nodes[index] = node;
  }

  setRuntime(state: SessionDisplayActivity["state"]): void {
    if (["completed", "interrupted", "failed"].includes(state))
      this.compactionRun = undefined;
    const last = this.nodes.at(-1);
    this.runtime =
      state === "running" &&
      last?.type === "segment" &&
      last.segment.type === "assistant_text" &&
      last.segment.phase === "final" &&
      !last.segment.streaming &&
      ![...this.tools.values()].some((t) => t.step.status === "running")
        ? "finishing"
        : state;
  }

  private closeBefore(id: string): void {
    const index = this.nodeIndices.get(id);
    if (index === undefined) return;
    for (const node of this.nodes.slice(0, index)) {
      const group = this.groups.get(node.id);
      if (group && group.runId === this.currentRun) {
        group.closed = true;
        for (const id of group.tools) {
          const tool = this.tools.get(id);
          if (tool) this.releasePreview(tool);
        }
      }
    }
    this.currentGroup = undefined;
  }

  private closeRun(runId: string, status: SessionDisplayTurnStatus): void {
    if (this.compactionRun === runId && status !== "running")
      this.compactionRun = undefined;
    for (const group of this.groups.values())
      if (group.runId === runId) group.closed = true;
    for (const tool of this.tools.values()) {
      if (tool.runId === runId && tool.step.status === "running") {
        tool.step = {
          ...tool.step,
          version: tool.step.version + 1,
          status: status === "interrupted" ? "interrupted" : "unknown",
        };
      }
    }
    if (runId === this.currentRun) {
      this.runtime = status === "running" ? "running" : status;
      this.currentGroup = undefined;
    }
  }

  private text(
    id: string,
    text: string,
    streaming: boolean,
    phase?: unknown,
    timestamp?: string,
    thinking = false,
    deferred = false,
    asyncMessage?: CodexAsyncMessage,
  ): void {
    if (!text.trim()) return;
    if (streaming && this.committed.has(id)) return;
    const old = this.nodeIndices.get(id);
    if (old === undefined) this.currentGroup = undefined;
    this.put({
      type: "segment",
      id,
      turnId:
        old === undefined
          ? this.currentSection
          : (this.nodes[old]?.turnId ?? this.currentSection),
      segment: thinking
        ? {
            type: "thinking",
            id,
            content: text.slice(0, 240),
            detailRef: id,
            ...(text.length > 240 || deferred ? { truncated: true } : {}),
            ...(timestamp ? { timestamp } : {}),
          }
        : {
            type: "assistant_text",
            id,
            content: text,
            streaming,
            ...(asyncMessage ? { asyncMessage } : {}),
            phase: asyncMessage
              ? "text"
              : phase === "commentary"
                ? "progress"
                : phase === "final_answer"
                  ? "final"
                  : "text",
            ...(timestamp ? { timestamp } : {}),
          },
    });
    if (!streaming && !this.committed.has(id)) {
      this.committed.add(id);
      this.closeBefore(id);
      if (
        !asyncMessage &&
        phase === "final_answer" &&
        this.runtime === "running"
      )
        this.runtime = "finishing";
    }
  }

  private tool(
    block: RecordValue,
    runId: string,
    timestamp?: string,
    replay = false,
    batchId?: string,
  ): void {
    const rawId = string(block.id);
    if (!rawId) return;
    const id = displayToolId(runId, rawId);
    let tool = this.tools.get(id);
    if (!replay && !tool && this.runtime !== "hold") this.runtime = "running";
    const originalName = string(block.name) ?? tool?.step.name ?? "Tool";
    const normalized =
      block.input !== undefined &&
      (this.provider === "codex" || this.provider === "codex-oss")
        ? normalizeCodexToolInvocation(originalName, block.input)
        : undefined;
    const name = normalized?.toolName ?? originalName;
    const normalizedName = name.toLowerCase().replace(/[^a-z]/g, "");
    if (["updateplan", "todowrite", "todoupdate"].includes(normalizedName)) {
      const args = record(block.input);
      const plan = args?.plan ?? args?.todos;
      const text = Array.isArray(plan)
        ? plan
            .map((item) => {
              const step = record(item);
              return `${step?.status ?? "pending"}: ${step?.step ?? step?.content ?? ""}`;
            })
            .join("\n")
        : "";
      if (text)
        this.put({
          type: "segment",
          id: `plan:${runId}`,
          turnId: `turn:${runId}`,
          segment: {
            type: "notice",
            id: `plan:${runId}`,
            kind: "plan",
            message: text.slice(0, 8_192),
          },
        });
      return;
    }
    if (!tool) {
      let group = this.currentGroup
        ? this.groups.get(this.currentGroup)
        : undefined;
      if (!group || group.closed || group.runId !== runId) {
        const groupId = displayToolId(runId, rawId).replace("dt2.", "dg2.");
        group = { id: groupId, runId, tools: [], closed: false };
        this.groups.set(groupId, group);
        this.currentGroup = groupId;
        this.put({
          type: "segment",
          id: groupId,
          turnId: this.currentSection,
          segment: {
            type: "tool_group",
            id: groupId,
            detailRef: groupId,
            count: 1,
            failedCount: 0,
            status: "running",
            toolNames: [],
            displayMode: "steps",
          },
        });
      }
      tool = {
        position: group.tools.length,
        rawId,
        runId,
        batch: batchId ?? rawId,
        paths: new Set(),
        check: false,
        step: {
          id,
          groupId: group.id,
          name,
          status: "running",
          summary: "",
          preview: "",
          truncated: false,
          version: 0,
          // A live step without a source timestamp still needs a start time so
          // the client can show how long it has been running. Replay must not
          // invent one: a resumed history would look like it just started.
          ...(timestamp
            ? { timestamp }
            : replay
              ? {}
              : { timestamp: new Date().toISOString() }),
        },
      };
      this.tools.set(id, tool);
      this.toolOrder.push(tool);
      this.rawToolIds.set(rawId, id);
      group.tools.push(id);
      const previousId =
        group.tools[group.tools.length - SESSION_DISPLAY_LIVE_STEP_LIMIT - 1];
      const previous = previousId ? this.tools.get(previousId) : undefined;
      if (previous) this.releasePreview(previous);
    }
    const input = normalized?.input ?? block.input;
    const partial = string(block.partialOutput);
    const summary =
      input === undefined ? tool.step.summary : toolSummary(input);
    const completed =
      block.status === "completed" || block.status === "complete";
    const nextStep = {
      ...tool.step,
      name,
      summary,
      ...(partial !== undefined
        ? {
            preview: partial.slice(-SESSION_DISPLAY_STEP_PREVIEW_LIMIT),
            truncated: partial.length > SESSION_DISPLAY_STEP_PREVIEW_LIMIT,
          }
        : {}),
      ...(completed && !(replay && tool.step.status !== "running")
        ? { status: "completed" as const }
        : {}),
    };
    if (JSON.stringify(nextStep) !== JSON.stringify(tool.step))
      nextStep.version++;
    tool.step = nextStep;
    this.releasePreview(tool);
    if (["edit", "write", "multiedit", "applypatch"].includes(normalizedName)) {
      const paths = Array.isArray(block.displayChangedPaths)
        ? block.displayChangedPaths.filter(
            (p): p is string => typeof p === "string",
          )
        : extractToolPaths(input);
      for (const path of paths) tool.paths.add(path);
    }
    tool.check ||= isCheckTool(input);
  }

  private result(block: RecordValue, runId: string): void {
    const rawId = string(block.tool_use_id);
    if (!rawId) return;
    let id = displayToolId(runId, rawId);
    if (!this.tools.has(id)) id = this.rawToolIds.get(rawId) ?? id;
    let tool = this.tools.get(id);
    if (!tool) {
      this.tool({ id: rawId }, runId);
      tool = this.tools.get(displayToolId(runId, rawId));
    }
    if (!tool) return;
    const text = outputText(block.content);
    const nextStep: SessionDisplayToolStep = {
      ...tool.step,
      status: block.is_error === true ? "failed" : "completed",
      preview: text.slice(-SESSION_DISPLAY_STEP_PREVIEW_LIMIT),
      truncated:
        text.length > SESSION_DISPLAY_STEP_PREVIEW_LIMIT ||
        block.displayTruncated === true,
    };
    if (JSON.stringify(nextStep) !== JSON.stringify(tool.step))
      nextStep.version++;
    tool.step = nextStep;
    this.releasePreview(tool);
  }

  private releasePreview(tool: DisplayToolRecord): void {
    const group = this.groups.get(tool.step.groupId);
    if (
      tool.step.status !== "running" &&
      group &&
      (group.closed ||
        tool.position < group.tools.length - SESSION_DISPLAY_LIVE_STEP_LIMIT)
    ) {
      tool.step = {
        ...tool.step,
        summary: tool.step.summary.slice(0, 256),
        preview: "",
      };
    }
  }

  message(message: RecordValue, persisted = false): void {
    if (message.isSubagent === true || message.isSidechain === true) return;
    const nested = record(message.message);
    const content = nested?.content ?? message.content;
    const rawId = string(message.uuid) ?? string(message.id);
    const runId =
      string(message.codexTurnId) ??
      string(message.turnId) ??
      ((this.provider === "codex" || this.provider === "codex-oss") &&
      this.currentRun !== "session"
        ? this.currentRun
        : undefined);
    const timestamp = string(message.timestamp);
    const replay = persisted || message.isReplay === true;
    // Codex supplies correlation only on completion; deltas already carry the
    // native item + turn UUID. Claude's nested message id is also stable across
    // stream_event and the persisted assistant message.
    const textIdentity = (id: string, index = 0): string => {
      const correlation = string(message.codexCorrelationKey);
      const prefix = runId ? `codex:${runId}:agent-message:` : undefined;
      const itemId =
        prefix && correlation?.startsWith(prefix)
          ? correlation.slice(prefix.length)
          : runId && id.endsWith(`-${runId}`)
            ? id.slice(0, -runId.length - 1)
            : undefined;
      return itemId
        ? `text:${runId}:${itemId}:${index}`
        : `text:${string(nested?.id) ?? id}:${index}`;
    };

    if (message.type === "system" && message.subtype === "status") {
      this.compactionRun =
        message.status === "compacting"
          ? (runId ?? this.currentRun)
          : undefined;
      if (this.compactionRun) {
        this.currentRun = this.compactionRun;
        this.runtime = "running";
      }
      return;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      this.compactionRun = undefined;
    }

    if (message.type === "system" && message.subtype === "turn_complete") {
      const status = message.turnStatus;
      if (
        runId &&
        (status === "completed" ||
          status === "interrupted" ||
          status === "failed")
      )
        this.closeRun(runId, status);
      return;
    }
    if (message.type === "result") {
      this.closeRun(
        runId ?? this.currentRun,
        message.turnStatus === "interrupted"
          ? "interrupted"
          : message.is_error === true
            ? "failed"
            : "completed",
      );
      return;
    }
    if (message.type === "stream_event") {
      if (replay) return; // Completed snapshots/replayed message bodies are authoritative.
      const event = record(message.event);
      if (event?.type === "message_start") {
        this.streamingId = string(record(event.message)?.id) ?? rawId;
        if (runId) this.currentRun = runId;
      }
      const delta = record(event?.delta);
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        if (runId) this.currentRun = runId;
        const streamId = this.streamingId ?? rawId;
        if (!streamId) return;
        const blockIndex =
          typeof event.index === "number" &&
          Number.isSafeInteger(event.index) &&
          event.index >= 0
            ? event.index
            : 0;
        const id =
          this.aliases.get(`${streamId}:${blockIndex}`) ??
          textIdentity(streamId, blockIndex);
        if (this.committed.has(id)) return;
        const index = this.nodeIndices.get(id);
        const node = index === undefined ? undefined : this.nodes[index];
        const previous =
          node?.type === "segment" && node.segment.type === "assistant_text"
            ? node.segment.content
            : "";
        this.text(
          id,
          previous + delta.text,
          true,
          message.codexMessagePhase,
          timestamp,
        );
      }
      return;
    }
    const blocks: RecordValue[] = Array.isArray(content)
      ? content.flatMap((b) => (record(b) ? [b as RecordValue] : []))
      : [];
    const role = nested?.role ?? message.role ?? message.type;
    if (role === "user" && !blocks.some((b) => b.type === "tool_result")) {
      if (!rawId) return;
      const projected = buildSessionDisplayProjection({
        sessionId: this.view.sessionId,
        revision: "display-v2",
        messages: [message as Message],
        questionCoverage: "partial",
        provider: this.provider,
      });
      const question = projected.page.turns.find((t) => t.question)?.question;
      if (!question) return;
      const identity =
        string(message.clientUserMessageId) ??
        string(message.codexCorrelationKey) ??
        rawId;
      const id = `question:${identity}`;
      const previousIndex = this.nodeIndices.get(id);
      const previous =
        previousIndex === undefined ? undefined : this.nodes[previousIndex];
      if (previous?.type === "question") {
        this.put({
          ...previous,
          question: {
            ...previous.question,
            ...question,
            ...(string(message.tempId)
              ? { tempId: string(message.tempId) }
              : {}),
          },
        });
        return;
      }
      this.currentRun = runId ?? "session";
      this.currentSection = `turn:${runId ?? rawId}`;
      this.currentGroup = undefined;
      this.put({
        type: "question",
        id,
        turnId: this.currentSection,
        question: {
          ...question,
          ...(string(message.tempId) ? { tempId: string(message.tempId) } : {}),
        },
      });
      return;
    }
    if (runId) this.currentRun = runId;
    const effectiveRun = runId ?? this.currentRun;
    if (message.type === "system" || message.type === "kimi_goal") {
      const projection = buildSessionDisplayProjection({
        sessionId: this.view.sessionId,
        revision: "display-v2",
        messages: [message as Message],
        questionCoverage: "partial",
        provider: this.provider,
      });
      for (const turn of projection.page.turns)
        for (const segment of turn.segments) {
          if (segment.type === "notice" || segment.type === "error")
            this.put({
              type: "segment",
              id: segment.id,
              turnId: this.currentSection,
              segment,
            });
        }
      return;
    }
    if (role === "assistant" || message.type === "summary") {
      const identity = string(message.codexCorrelationKey) ?? rawId;
      if (identity) {
        const textBlocks =
          typeof content === "string"
            ? [{ type: "text", text: content }]
            : blocks;
        for (let index = 0; index < textBlocks.length; index++) {
          const block = textBlocks[index];
          if (!block) continue;
          if (block.type === "text" && typeof block.text === "string") {
            const id =
              (rawId && this.aliases.get(`${rawId}:${index}`)) ||
              textIdentity(rawId ?? identity, index);
            if (rawId) this.aliases.set(`${rawId}:${index}`, id);
            this.text(
              id,
              block.text,
              message._isStreaming === true,
              message.codexMessagePhase,
              timestamp,
              false,
              false,
              message.codexAsyncMessage as CodexAsyncMessage | undefined,
            );
          } else if (
            block.type === "thinking" &&
            typeof block.thinking === "string" &&
            this.provider === "pi"
          ) {
            this.text(
              `thinking:${identity}:${index}`,
              block.thinking,
              message._isStreaming === true,
              undefined,
              timestamp,
              true,
              block.deferred === true,
            );
          } else if (block.type === "tool_use") {
            this.tool(block, effectiveRun, timestamp, replay, identity);
          }
        }
      }
    }
    for (const block of blocks) {
      if (block.type === "tool_use" && role !== "assistant")
        this.tool(block, effectiveRun, timestamp, replay, rawId ?? undefined);
      else if (block.type === "tool_result") this.result(block, effectiveRun);
    }
    if (message.type === "error" && message.willRetry !== true) {
      const id = `error:${rawId ?? effectiveRun}`;
      const text =
        string(message.error) ??
        string(record(message.error)?.message) ??
        (outputText(content) || "Agent error");
      this.put({
        type: "segment",
        id,
        turnId: `turn:${effectiveRun}`,
        segment: { type: "error", id, message: text.slice(0, 8_192) },
      });
      this.closeRun(effectiveRun, "failed");
    }
  }

  groupSteps(id: string): SessionDisplayToolStep[] | null {
    const group = this.groups.get(id);
    return group
      ? group.tools.flatMap((id) => {
          const tool = this.tools.get(id);
          if (!tool) return [];
          return [{ ...tool.step, preview: "" }];
        })
      : null;
  }

  private groupSegment(group: Group): GroupSegment {
    const tools = this.groupSteps(group.id) ?? [];
    const running = tools.filter((t) => t.status === "running");
    const failed = tools.filter((t) => t.status === "failed");
    const paths = new Set<string>();
    let checks = 0;
    for (const id of group.tools) {
      const tool = this.tools.get(id);
      if (!tool) continue;
      for (const path of tool.paths) paths.add(path);
      if (tool.check) checks++;
    }
    return {
      type: "tool_group",
      id: group.id,
      detailRef: group.id,
      count: tools.length,
      failedCount: failed.length,
      runningCount: running.length,
      unknownCount: tools.filter((t) => t.status === "unknown").length,
      interruptedCount: tools.filter((t) => t.status === "interrupted").length,
      status: running.length
        ? "running"
        : failed.length
          ? failed.length === tools.length
            ? "failed"
            : "mixed"
          : tools.some(
                (t) => t.status === "interrupted" || t.status === "unknown",
              )
            ? "mixed"
            : "completed",
      toolNames: group.closed
        ? []
        : [...new Set(tools.map((t) => t.name))].slice(0, 5),
      displayMode: group.closed ? "summary" : "steps",
      version: tools.reduce((sum, t) => sum + t.version, group.closed ? 1 : 0),
      ...(paths.size ? { changedFileCount: paths.size } : {}),
      ...(checks ? { checkCount: checks } : {}),
      // The active stage carries only its lightweight tool index. Closed groups
      // expose aggregate counts until a reader explicitly requests the index;
      // inputs and results always remain behind the per-tool detail endpoint.
      ...(!group.closed
        ? { steps: tools.slice(-SESSION_DISPLAY_LIVE_STEP_LIMIT) }
        : {}),
    };
  }

  /**
   * Retire tool steps that can no longer receive a result.
   *
   * A step normally ends on its `tool_result`, or on a terminal turn status via
   * `closeRun`. Neither arrives when a provider stream dies mid tool call: Pi
   * persists the half-built call from a broken upstream stream, and Codex loses
   * a turn outright when its app-server or bridge restarts before
   * `turn_complete`. Providers without native turn ids (Pi, Kimi) make this
   * worse, because every run collapses onto `session` and `closeRun` can only
   * fire once the whole session goes idle. The orphan then spins as a bogus
   * "still running" row for the rest of the session.
   *
   * Tool batches are strictly sequential: a model only requests the next batch
   * after it has seen the results of the previous one. So any running step from
   * a batch older than the newest settled step is dead, not pending. Steps
   * inside one batch are never judged against each other, which leaves a
   * genuinely in-flight parallel batch (some done, some still working) alone.
   */
  private reapStrandedTools(): void {
    let lastSettled = -1;
    for (let index = this.toolOrder.length - 1; index >= 0; index--) {
      if (this.toolOrder[index]?.step.status !== "running") {
        lastSettled = index;
        break;
      }
    }
    if (lastSettled < 1) return;
    const liveBatch = this.toolOrder[lastSettled]?.batch;
    for (let index = 0; index < lastSettled; index++) {
      const tool = this.toolOrder[index];
      if (!tool || tool.step.status !== "running" || tool.batch === liveBatch) {
        continue;
      }
      tool.step = {
        ...tool.step,
        version: tool.step.version + 1,
        status: "unknown",
      };
      this.releasePreview(tool);
    }
  }

  snapshot(olderCursor?: string): SessionDisplaySnapshot {
    this.reapStrandedTools();
    const nodes = this.nodes.map((node) => {
      if (node.type === "segment" && node.segment.type === "assistant_text") {
        const cached = this.renderedNodes.get(node);
        if (cached) return cached;
        // Render at snapshot/flush time, not on every token. Cold history,
        // older pages and live patches all need HTML for TextBlock's renderer.
        // Keep this synchronous so rendering cannot reorder projection patches.
        let rendered = node;
        try {
          rendered = {
            ...node,
            segment: {
              ...node.segment,
              renderedHtml: renderSafeMarkdown(node.segment.content),
            },
          };
        } catch {
          // Preserve readable text if an individual Markdown block fails.
        }
        this.renderedNodes.set(node, rendered);
        return rendered;
      }
      const group = this.groups.get(node.id);
      return group
        ? {
            ...node,
            type: "segment" as const,
            segment: this.groupSegment(group),
          }
        : node;
    });
    const running = [...this.tools.values()].filter(
      (t) => t.step.status === "running",
    );
    // Only carry tools that are otherwise outside the default current-step window.
    const visible = new Set(
      nodes.flatMap((n) =>
        n.type === "segment" && n.segment.type === "tool_group"
          ? (n.segment.steps?.map((t) => t.id) ?? [])
          : [],
      ),
    );
    const activityTools = running.filter((t) => !visible.has(t.step.id));
    return {
      version: 2,
      view: this.view,
      seq: this.seq,
      nodes,
      activity: {
        state: this.runtime,
        tools: activityTools
          .slice(-SESSION_DISPLAY_LIVE_STEP_LIMIT)
          .map((t) => ({ ...t.step, preview: "" })),
        runningCount: running.length,
        ...(this.compactionRun ? { isCompacting: true } : {}),
      },
      ...(olderCursor ? { olderCursor } : {}),
    };
  }

  commit(previous: SessionDisplaySnapshot): SessionDisplayPatch | null {
    this.seq = previous.seq;
    const next = this.snapshot();
    const old = new Map(previous.nodes.map((n) => [n.id, JSON.stringify(n)]));
    const upsert = next.nodes.filter(
      (n) => old.get(n.id) !== JSON.stringify(n),
    );
    const nextIds = new Set(next.nodes.map((n) => n.id));
    const remove = previous.nodes
      .filter((n) => !nextIds.has(n.id))
      .map((n) => n.id);
    const order = next.nodes.map((n) => n.id);
    const reordered =
      JSON.stringify(order) !== JSON.stringify(previous.nodes.map((n) => n.id));
    if (
      !upsert.length &&
      !remove.length &&
      JSON.stringify(previous.activity) === JSON.stringify(next.activity)
    )
      return null;
    this.seq++;
    return {
      view: this.view,
      baseSeq: previous.seq,
      seq: this.seq,
      upsert,
      remove,
      ...(reordered ? { order } : {}),
      activity: next.activity,
    };
  }
}

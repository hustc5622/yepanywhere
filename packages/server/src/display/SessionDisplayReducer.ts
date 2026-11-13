import type { CodexAsyncMessage } from "@yep-anywhere/shared";
import {
  SESSION_DISPLAY_LIVE_STEP_LIMIT,
  SESSION_DISPLAY_PROCESS_MAX_MESSAGE_IDS,
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
import { isCodexAgentWaitTool } from "../codex/agent-wait.js";
import { normalizeCodexToolInvocation } from "../codex/normalization.js";
import {
  buildSessionDisplayProjection,
  extractToolPaths,
  getCodexSubagentOperation,
  isCheckTool,
} from "../sessions/display-projection.js";
import type { Message } from "../supervisor/types.js";

type RecordValue = Record<string, unknown>;
type SegmentNode = Extract<SessionDisplayNode, { type: "segment" }>;
type QuestionNode = Extract<SessionDisplayNode, { type: "question" }>;
type DisplaySegment = SegmentNode["segment"];
type GroupSegment = Extract<DisplaySegment, { type: "tool_group" }>;
type ProcessSegment = Extract<DisplaySegment, { type: "process" }>;
interface SourceTime {
  time: number;
  value: string;
}

/** Runtime states in which the latest block cannot receive more work. */
const SETTLED_RUNTIME_STATES = new Set<SessionDisplayActivity["state"]>([
  "completed",
  "interrupted",
  "failed",
  "unknown",
]);
/** Visible markers that stay in the timeline when a settled answer folds. */
const PINNED_NOTICE_KINDS = new Set<string>([
  "session_setup",
  "compaction",
  "warning",
  "turn_aborted",
  "goal",
  "provider_event",
]);

export interface SessionDisplayReducerOptions {
  /**
   * Fold the working steps of settled answers behind one `process` segment.
   * Members stay retrievable through `processNodes`.
   */
  foldSettled?: boolean;
}

function isAsyncText(segment: DisplaySegment): boolean {
  return (
    segment.type === "assistant_text" && segment.asyncMessage !== undefined
  );
}

/** Errors, async questions and visible markers are never folded away. */
function isPinnedSegment(segment: DisplaySegment): boolean {
  if (segment.type === "error") return true;
  if (segment.type === "notice") return PINNED_NOTICE_KINDS.has(segment.kind);
  return isAsyncText(segment);
}

/**
 * Live work that keeps a block expanded. Only tools and streaming text count:
 * closing a run settles both, whereas notice states (agent waits, subagents)
 * may legitimately stay stale and must not pin a finished answer open.
 */
function isActiveSegment(segment: DisplaySegment): boolean {
  if (segment.type === "tool_group")
    return segment.status === "running" || (segment.runningCount ?? 0) > 0;
  return segment.type === "assistant_text" && segment.streaming === true;
}

function foldVersion(members: readonly SegmentNode[]): number {
  let hash = 2166136261;
  const mix = (value: string) => {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (const node of members) {
    const segment = node.segment;
    mix(node.id);
    mix(
      segment.type === "tool_group"
        ? `${segment.version ?? 0}:${segment.status}`
        : segment.type === "assistant_text" || segment.type === "thinking"
          ? String(segment.content.length)
          : String(JSON.stringify(segment).length),
    );
  }
  return hash >>> 0;
}

export interface DisplayToolRecord {
  rawId: string;
  runId: string;
  step: SessionDisplayToolStep;
  paths: Set<string>;
  check: boolean;
  position: number;
  /**
   * Identity of the assistant message that requested the call. Calls sharing a
   * batch were issued together and may finish in any order. Sequential
   * providers use this to detect abandoned calls; Codex command lifecycles
   * can outlive the model's tool response and span multiple batches.
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
interface CursorThinkingPlacement {
  text?: string;
  toolId?: string;
  fallback?: boolean;
  section?: string;
}

function cursorTextsMatch(native: string, live: string): boolean {
  const left = native.trim();
  const right = live.trim();
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function readCursorThinkingPlacement(
  message: RecordValue,
): CursorThinkingPlacement | undefined {
  const raw = record(message.cursorThinkingBefore);
  if (!raw) return undefined;
  const text = string(raw.text);
  const toolId = string(raw.toolId);
  const fallback = raw.fallback === true;
  if (!text && !toolId && !fallback) return undefined;
  const turnId = string(message.turnId);
  return {
    ...(text ? { text } : {}),
    ...(toolId ? { toolId } : {}),
    ...(fallback ? { fallback: true } : {}),
    ...(turnId ? { section: `turn:${turnId}` } : {}),
  };
}

function toolSummary(input: unknown): string {
  const args = record(input);
  if (!args) return typeof input === "string" ? input.slice(0, 1_024) : "";
  for (const key of [
    "command",
    "cmd",
    "script",
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
  private streamingTexts = new Map<string, string>();
  private endedRuns = new Set<string>();
  /** Terminal outcome per provider run, used to label folded work. */
  private runStatuses = new Map<string, SessionDisplayTurnStatus>();
  /** Known completion time per provider run, bounding a fold's duration. */
  private runEndedAt = new Map<string, string>();
  private runtime: SessionDisplayActivity["state"] = "unknown";
  private compactionRun: string | undefined;
  private seq = 0;

  constructor(
    public view: SessionDisplayView,
    private readonly provider?: string,
    private readonly options: SessionDisplayReducerOptions = {},
  ) {}

  get currentRunId(): string {
    return this.currentRun;
  }
  isRunEnded(runId: string): boolean {
    return this.endedRuns.has(runId);
  }
  isMessageCommitted(messageId: string): boolean {
    const id = this.aliases.get(`${messageId}:0`);
    return id !== undefined && this.committed.has(id);
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
    completedAt?: Readonly<Record<string, string>>,
  ): void {
    for (const message of messages) this.message(message as RecordValue, true);
    for (const [runId, status] of Object.entries(statuses ?? {})) {
      if (status !== "running") this.closeRun(runId, status);
    }
    for (const [runId, timestamp] of Object.entries(completedAt ?? {}))
      if (Number.isFinite(Date.parse(timestamp)))
        this.runEndedAt.set(runId, timestamp);
  }

  private put(node: SessionDisplayNode): void {
    const index = this.nodeIndices.get(node.id);
    if (index === undefined) {
      this.nodeIndices.set(node.id, this.nodes.length);
      this.nodes.push(node);
    } else this.nodes[index] = node;
  }

  private insertAt(index: number, node: SessionDisplayNode): void {
    this.nodes.splice(index, 0, node);
    for (let cursor = index; cursor < this.nodes.length; cursor += 1) {
      const current = this.nodes[cursor];
      if (current) this.nodeIndices.set(current.id, cursor);
    }
  }

  private cursorTurnEnd(section: string): number | undefined {
    let end = this.nodes.length;
    for (let index = end - 1; index >= 0; index--) {
      const node = this.nodes[index];
      if (node?.type !== "question") continue;
      if (node.turnId === section) return end;
      end = index;
    }
    return undefined;
  }

  /**
   * Restore a reasoning boundary inside a previously coalesced tool group.
   * Use the same first-call identity as live grouping so detail URLs and the
   * client's expanded state survive a native-history refresh.
   */
  private splitGroupBefore(tool: DisplayToolRecord): number | undefined {
    const group = this.groups.get(tool.step.groupId);
    const index = group ? this.nodeIndices.get(group.id) : undefined;
    if (!group || index === undefined) return undefined;
    const position = group.tools.indexOf(tool.step.id);
    if (position <= 0) return index;
    const node = this.nodes[index];
    if (!node) return undefined;
    const tail: Group = {
      id: tool.step.id.replace("dt2.", "dg2."),
      runId: group.runId,
      tools: group.tools.splice(position),
      closed: group.closed,
    };
    group.closed = true;
    this.groups.set(tail.id, tail);
    for (const [position, id] of tail.tools.entries()) {
      const moved = this.tools.get(id);
      if (!moved) continue;
      moved.position = position;
      moved.step = {
        ...moved.step,
        groupId: tail.id,
        version: moved.step.version + 1,
      };
    }
    this.insertAt(index + 1, {
      type: "segment",
      id: tail.id,
      turnId: node.turnId,
      segment: this.groupSegment(tail),
    });
    return index + 1;
  }

  /**
   * Put a recovered Cursor thought above the exact reply or tool it preceded.
   * A missed anchor still stays before that turn's last reply.
   */
  private findCursorThinkingIndex(
    placement: CursorThinkingPlacement,
  ): number | undefined {
    const section = placement.section ?? this.currentSection;
    const runId = section.startsWith("turn:")
      ? section.slice("turn:".length)
      : this.currentRun;
    if (placement.toolId) {
      const mapped = this.rawToolIds.get(placement.toolId);
      const tool =
        this.tools.get(displayToolId(runId, placement.toolId)) ??
        (mapped ? this.tools.get(mapped) : undefined);
      if (tool && tool.runId === runId) {
        const index = this.splitGroupBefore(tool);
        if (index !== undefined) return index;
      }
    }
    if (placement.text) {
      for (let index = 0; index < this.nodes.length; index += 1) {
        const node = this.nodes[index];
        if (
          node?.type === "segment" &&
          node.segment.type === "assistant_text" &&
          node.turnId === section &&
          cursorTextsMatch(node.segment.content, placement.text)
        )
          return index;
      }
    }
    let lastText: number | undefined;
    let firstTool: number | undefined;
    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index];
      if (node?.type !== "segment" || node.turnId !== section) continue;
      if (node.segment.type === "assistant_text") lastText = index;
      if (node.segment.type === "tool_group" && firstTool === undefined)
        firstTool = index;
    }
    // A missed anchor stays in this turn, before the reply it belongs with,
    // or before the tools when the reply has not been written yet. It must
    // not be appended after the answer.
    return lastText ?? firstTool ?? this.cursorTurnEnd(section);
  }

  setRuntime(state: SessionDisplayActivity["state"]): void {
    if (state !== "running" && state !== "unknown") this.stopStreaming();
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

  /** Closing presentation never discards partial text or commits it as an answer. */
  stopStreaming(runId?: string, exceptId?: string): void {
    for (const [id, run] of this.streamingTexts) {
      if (id === exceptId || (runId && run !== runId)) continue;
      const index = this.nodeIndices.get(id);
      const node = index === undefined ? undefined : this.nodes[index];
      if (node?.type === "segment" && node.segment.type === "assistant_text")
        this.put({ ...node, segment: { ...node.segment, streaming: false } });
      this.streamingTexts.delete(id);
    }
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
    if (status !== "running") {
      this.endedRuns.add(runId);
      this.runStatuses.set(runId, status);
      this.stopStreaming(runId);
    }
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
    provisional = false,
    placement?: CursorThinkingPlacement,
    messageId?: string,
  ): void {
    if (!text.trim()) return;
    if (streaming && this.committed.has(id)) return;
    const old = this.nodeIndices.get(id);
    const previous = old === undefined ? undefined : this.nodes[old];
    // Deltas carry no persisted identity; keep the one already recorded.
    const sourceMessageId =
      messageId ??
      (previous?.type === "segment" &&
      previous.segment.type === "assistant_text"
        ? previous.segment.messageId
        : undefined);
    if (old === undefined) this.stopStreaming(this.currentRun, id);
    const active = streaming && !this.endedRuns.has(this.currentRun);
    if (active && !thinking) this.streamingTexts.set(id, this.currentRun);
    else this.streamingTexts.delete(id);
    if (old === undefined) this.currentGroup = undefined;
    const section =
      old === undefined
        ? (placement?.section ?? this.currentSection)
        : (this.nodes[old]?.turnId ?? this.currentSection);
    const node: SessionDisplayNode = {
      type: "segment",
      id,
      turnId: section,
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
            ...(sourceMessageId ? { messageId: sourceMessageId } : {}),
            content: text,
            streaming: active,
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
    };
    if (old === undefined && placement && thinking) {
      const at = this.findCursorThinkingIndex(placement);
      if (at !== undefined) {
        const turnId = this.nodes[at]?.turnId ?? section;
        this.insertAt(at, { ...node, turnId });
      } else this.put(node);
    } else this.put(node);
    if (!streaming && !provisional && !this.committed.has(id)) {
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
    if (!tool) this.stopStreaming(runId);
    if (!replay && !tool && this.runtime !== "hold") this.runtime = "running";
    const originalName = string(block.name) ?? tool?.step.name ?? "Tool";
    // Codex projects mailbox waits as agentWait notices with the same call id.
    if (
      (this.provider === "codex" || this.provider === "codex-oss") &&
      isCodexAgentWaitTool(originalName)
    )
      return;
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
        ? {
            status: "completed" as const,
            completedAt: this.completionTimestamp(tool, timestamp, replay),
          }
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

  private completionTimestamp(
    tool: DisplayToolRecord,
    timestamp: string | undefined,
    replay: boolean,
  ): string | undefined {
    if (tool.step.completedAt) return tool.step.completedAt;
    const end =
      timestamp ??
      (!replay && tool.step.status === "running"
        ? new Date().toISOString()
        : undefined);
    const startMs = Date.parse(tool.step.timestamp ?? "");
    const endMs = Date.parse(end ?? "");
    // Identical timestamps often mean a whole call was persisted in one
    // message. They do not establish a zero-duration execution.
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? end
      : undefined;
  }

  private result(
    block: RecordValue,
    runId: string,
    timestamp?: string,
    replay = false,
  ): void {
    const rawId = string(block.tool_use_id);
    if (!rawId) return;
    let id = displayToolId(runId, rawId);
    if (!this.tools.has(id)) id = this.rawToolIds.get(rawId) ?? id;
    let tool = this.tools.get(id);
    if (!tool) {
      // A result without its call cannot establish when execution started.
      this.tool({ id: rawId }, runId, undefined, true);
      tool = this.tools.get(displayToolId(runId, rawId));
    }
    if (!tool) return;
    const text = outputText(block.content);
    const nextStep: SessionDisplayToolStep = {
      ...tool.step,
      status: block.is_error === true ? "failed" : "completed",
      completedAt: this.completionTimestamp(tool, timestamp, replay),
      ...(typeof block.durationMs === "number" &&
      Number.isFinite(block.durationMs) &&
      block.durationMs >= 0
        ? { durationMs: block.durationMs }
        : {}),
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
      ) {
        this.closeRun(runId, status);
        if (timestamp) this.runEndedAt.set(runId, timestamp);
      }
      return;
    }
    if (message.type === "result") {
      const resultRun = runId ?? this.currentRun;
      this.closeRun(
        resultRun,
        message.turnStatus === "interrupted"
          ? "interrupted"
          : message.turnStatus === "failed" || message.is_error === true
            ? "failed"
            : "completed",
      );
      if (timestamp) this.runEndedAt.set(resultRun, timestamp);
      return;
    }
    if (message.type === "stream_event") {
      if (replay) return; // Completed snapshots/replayed message bodies are authoritative.
      if (runId && this.endedRuns.has(runId)) return;
      const event = record(message.event);
      if (event?.type === "message_start") {
        if (!runId) this.endedRuns.delete(this.currentRun);
        this.stopStreaming();
        this.streamingId = string(record(event.message)?.id) ?? rawId;
        if (runId) this.currentRun = runId;
      }
      if (
        event?.type === "content_block_stop" ||
        event?.type === "message_stop"
      ) {
        this.stopStreaming(runId);
        if (event.type === "message_stop") this.streamingId = undefined;
        return;
      }
      if (event?.type === "content_block_start") this.stopStreaming(runId);
      const delta = record(event?.delta);
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        if (runId) this.currentRun = runId;
        const streamId = message.codexTurnId
          ? rawId
          : (this.streamingId ?? rawId);
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
        const turnId =
          this.provider === "cursor" &&
          runId &&
          previous.turnId === `turn:${rawId}`
            ? `turn:${runId}`
            : previous.turnId;
        if (
          turnId !== previous.turnId &&
          this.currentSection === previous.turnId
        ) {
          this.currentRun = runId ?? this.currentRun;
          this.currentSection = turnId;
        }
        this.put({
          ...previous,
          turnId,
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
      const startsNewRun = !replay && runId && runId !== this.currentRun;
      if (!runId) this.endedRuns.delete("session");
      this.stopStreaming();
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
      if (startsNewRun) this.setRuntime("running");
      return;
    }
    // Recovered Cursor thoughts and errors can target a previous question.
    // They must not change which run subsequent live events belong to.
    if (
      runId &&
      !(
        this.provider === "cursor" &&
        (message.type === "error" || message.cursorThinkingBefore !== undefined)
      )
    )
      this.currentRun = runId;
    const effectiveRun = runId ?? this.currentRun;
    if (message.type === "system") {
      const nativeItem = record(message.codexThreadItem);
      const nativeId = string(nativeItem?.id);
      const collaborationTool =
        nativeItem?.type === "subAgentActivity" && nativeId
          ? this.tools.get(displayToolId(effectiveRun, nativeId))
          : undefined;
      const operation = getCodexSubagentOperation(collaborationTool?.step.name);
      const projectedMessage =
        operation && nativeItem
          ? { ...message, codexThreadItem: { ...nativeItem, operation } }
          : message;
      const projection = buildSessionDisplayProjection({
        sessionId: this.view.sessionId,
        revision: "display-v2",
        messages: [projectedMessage as Message],
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
            if (typeof nested?.id === "string")
              this.aliases.set(`${nested.id}:${index}`, id);
            this.text(
              id,
              block.text,
              message._isStreaming === true &&
                index ===
                  (message._streamingBlockIndex ?? textBlocks.length - 1),
              message.codexMessagePhase,
              timestamp,
              false,
              false,
              message.codexAsyncMessage as CodexAsyncMessage | undefined,
              message._isStreaming === true ||
                message._isStreamingPlaceholder === true,
              undefined,
              rawId ?? undefined,
            );
          } else if (
            block.type === "thinking" &&
            typeof block.thinking === "string" &&
            (this.provider === "pi" || this.provider === "cursor")
          ) {
            this.text(
              `thinking:${identity}:${index}`,
              block.thinking,
              message._isStreaming === true,
              undefined,
              timestamp,
              true,
              block.deferred === true,
              undefined,
              false,
              this.provider === "cursor"
                ? readCursorThinkingPlacement(message)
                : undefined,
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
      else if (block.type === "tool_result")
        this.result(block, effectiveRun, timestamp, replay);
    }
    if (message.type === "error" && message.willRetry !== true) {
      const id = `error:${rawId ?? effectiveRun}`;
      const text =
        string(message.error) ??
        string(record(message.error)?.message) ??
        (outputText(content) || "Agent error");
      const node: SegmentNode = {
        type: "segment",
        id,
        turnId: `turn:${effectiveRun}`,
        segment: { type: "error", id, message: text.slice(0, 8_192) },
      };
      const at =
        this.provider === "cursor" && !this.nodeIndices.has(id)
          ? this.cursorTurnEnd(node.turnId)
          : undefined;
      if (at === undefined) this.put(node);
      else this.insertAt(at, node);
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

  /**
   * Native Cursor history omits per-call timing. Carry verified lifecycle
   * timestamps from live state or journal replay without replaying tool bodies,
   * changing execution status, or creating calls missing from this timeline.
   */
  restoreToolTimings(records: Iterable<DisplayToolRecord>): void {
    for (const { step: timing } of records) {
      const tool = this.tools.get(timing.id);
      if (!tool) continue;
      const start = tool.step.timestamp ?? timing.timestamp;
      const timestamp = Number.isFinite(Date.parse(start ?? ""))
        ? start
        : undefined;
      const end = tool.step.completedAt ?? timing.completedAt;
      const completedAt =
        timestamp && Date.parse(end ?? "") > Date.parse(timestamp)
          ? end
          : undefined;
      const duration = tool.step.durationMs ?? timing.durationMs;
      const durationMs =
        typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration >= 0
          ? duration
          : undefined;
      if (
        tool.step.timestamp === timestamp &&
        tool.step.completedAt === completedAt &&
        tool.step.durationMs === durationMs
      )
        continue;
      tool.step = {
        ...tool.step,
        ...(timestamp ? { timestamp } : {}),
        ...(completedAt ? { completedAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        version: tool.step.version + 1,
      };
    }
  }

  private groupSegment(group: Group): GroupSegment {
    const tools = this.groupSteps(group.id) ?? [];
    const running = tools.filter((t) => t.status === "running");
    const failed = tools.filter((t) => t.status === "failed");
    let durationMs = 0;
    let timedCount = 0;
    for (const tool of tools) {
      if (tool.status === "running") continue;
      const started = Date.parse(tool.timestamp ?? "");
      const ended = Date.parse(tool.completedAt ?? "");
      const span =
        Number.isFinite(started) && Number.isFinite(ended) && ended > started
          ? ended - started
          : undefined;
      // Equal start and end is not a duration. Cursor must not turn that into
      // a group total; an explicit positive durationMs still counts.
      const elapsed =
        this.provider === "cursor"
          ? (span ??
            (typeof tool.durationMs === "number" && tool.durationMs > 0
              ? tool.durationMs
              : undefined))
          : (tool.durationMs ??
            (Number.isFinite(ended) && Number.isFinite(started)
              ? ended - started
              : Number.NaN));
      if (
        typeof elapsed !== "number" ||
        !Number.isFinite(elapsed) ||
        elapsed < 0
      )
        continue;
      if (this.provider === "cursor" && elapsed === 0) continue;
      durationMs += elapsed;
      timedCount++;
    }
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
      ...(timedCount > 0 ? { durationMs, timedCount } : {}),
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
   * persists the half-built call from a broken upstream stream.
   * Providers without native turn ids (Pi, MiniMax Code) make this
   * worse, because every run collapses onto `session` and `closeRun` can only
   * fire once the whole session goes idle. The orphan then spins as a bogus
   * "still running" row for the rest of the session.
   *
   * On sequential providers a model only requests the next batch
   * after it has seen the results of the previous one. So any running step from
   * a batch older than the newest settled step is dead, not pending. Steps
   * inside one batch are never judged against each other, which leaves a
   * genuinely in-flight parallel batch (some done, some still working) alone.
   */
  private reapStrandedTools(): void {
    // Codex exec_command can yield a process id while the command keeps
    // running. Later calls completing says nothing about that process; only
    // its own result or a terminal turn may settle the display step.
    if (this.provider === "codex" || this.provider === "codex-oss") return;
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

  /** Nodes with Markdown and current tool-group summaries, before folding. */
  private renderNodes(): SessionDisplayNode[] {
    return this.nodes.map((node) => {
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
  }

  /**
   * Replace the working steps of every settled answer with one `process`
   * segment. Blocks are delimited by user prompts; only the latest block can
   * still be running, and a block with live work is never folded.
   */
  private foldProcesses(
    nodes: readonly SessionDisplayNode[],
    pageCursor?: string,
  ): {
    nodes: SessionDisplayNode[];
    folds: Map<string, SegmentNode[]>;
  } {
    const output: SessionDisplayNode[] = [];
    const folds = new Map<string, SegmentNode[]>();
    let anchor: QuestionNode | undefined;
    let block: SegmentNode[] = [];
    const flush = (isLast: boolean) => {
      if (block.length)
        output.push(
          ...this.foldBlock(block, anchor, isLast, folds, pageCursor),
        );
      block = [];
    };
    for (const node of nodes) {
      if (node.type === "question") {
        flush(false);
        output.push(node);
        anchor = node;
      } else block.push(node);
    }
    flush(true);
    return { nodes: output, folds };
  }

  private foldBlock(
    block: SegmentNode[],
    anchor: QuestionNode | undefined,
    isLast: boolean,
    folds: Map<string, SegmentNode[]>,
    pageCursor?: string,
  ): SegmentNode[] {
    if (
      isLast &&
      (!SETTLED_RUNTIME_STATES.has(this.runtime) || this.compactionRun)
    )
      return block;
    if (block.some((node) => isActiveSegment(node.segment))) return block;

    // The answer is the last real assistant text. A thought or tool row that
    // lands after it must not pull that text into the fold.
    const tail = new Set<string>();
    let tailStart = block.length;
    const isAnswerText = (segment: DisplaySegment) =>
      segment.type === "assistant_text" &&
      segment.phase !== "progress" &&
      !segment.asyncMessage;
    let index = block.length - 1;
    while (index >= 0) {
      const segment = block[index]?.segment;
      if (!segment) break;
      if (
        isPinnedSegment(segment) ||
        segment.type === "notice" ||
        segment.type === "thinking" ||
        segment.type === "tool_group" ||
        segment.type === "action_required" ||
        (segment.type === "assistant_text" && segment.phase === "progress")
      ) {
        index -= 1;
        continue;
      }
      break;
    }
    const answer = index >= 0 ? block[index] : undefined;
    if (answer && isAnswerText(answer.segment)) {
      tailStart = index;
      while (tailStart > 0) {
        const previous = block[tailStart - 1]?.segment;
        if (!previous || !isAnswerText(previous)) break;
        tailStart -= 1;
      }
      for (let cursor = tailStart; cursor <= index; cursor += 1) {
        const node = block[cursor];
        if (node) tail.add(node.id);
      }
    }
    // Visible markers recorded once the answer had begun (a manual compaction
    // between turns, a late warning) keep their source position after it
    // instead of being hoisted above the answer together with the work.
    const afterAnswer = new Set<string>();
    for (let index = tailStart + 1; index < block.length; index++) {
      const node = block[index];
      if (node && !tail.has(node.id) && isPinnedSegment(node.segment))
        afterAnswer.add(node.id);
    }
    const trailing = (node: SegmentNode) =>
      tail.has(node.id) || afterAnswer.has(node.id);
    let answered = tail.size > 0;

    type Part =
      | { node: SegmentNode }
      | { members: SegmentNode[]; startedAt?: string };
    const parts: Part[] = [];
    let members: SegmentNode[] = [];
    let held: SegmentNode[] = [];
    let boundary = anchor?.question.timestamp;
    const close = () => {
      if (members.length) parts.push({ members, startedAt: boundary });
      for (const node of held) parts.push({ node });
      members = [];
      held = [];
    };
    for (const node of block) {
      if (trailing(node)) continue;
      const segment = node.segment;
      const explicitAnswer =
        segment.type === "assistant_text" &&
        !segment.asyncMessage &&
        segment.phase === "final";
      if (explicitAnswer || isAsyncText(segment)) {
        // A mid-turn final answer or async question splits the work into
        // ordered folds and stays visible between them.
        if (explicitAnswer) answered = true;
        close();
        parts.push({ node });
        boundary = segment.timestamp ?? boundary;
      } else if (isPinnedSegment(segment)) {
        if (members.length) held.push(node);
        else parts.push({ node });
      } else members.push(node);
    }
    close();
    const foldCount = parts.filter((part) => "members" in part).length;
    if (!foldCount) return block;
    for (const node of block) if (trailing(node)) parts.push({ node });

    // Session-wide run facts (generic run, runtime state) may describe the
    // activity behind those later markers, e.g. a compaction's own result.
    // Only the block's own run then speaks for the answer.
    const sessionFacts = isLast && afterAnswer.size === 0;
    const status = this.blockStatus(block, anchor, sessionFacts, answered);
    const runId = this.blockRunId(block, anchor, sessionFacts);
    const anchorRun = anchor?.turnId.startsWith("turn:")
      ? anchor.turnId.slice("turn:".length)
      : undefined;
    // A shared session clock must not lend another turn's duration to this one.
    const runEnd =
      runId && (!anchorRun || runId === anchorRun)
        ? this.runEndedAt.get(runId)
        : undefined;
    const runEndTime = Date.parse(runEnd ?? "");
    const latest = this.latestTime(
      block.filter((node) => !afterAnswer.has(node.id)),
    );
    // Codex history stamps every item with the turn start; its native turn
    // completion is then the only evidence of how long the work took.
    const blockEnd =
      runEnd &&
      Number.isFinite(runEndTime) &&
      (!latest || runEndTime > latest.time)
        ? { time: runEndTime, value: runEnd }
        : latest;
    const anchorId =
      anchor?.id ?? `start:${block[0]?.id ?? this.view.sessionId}`;
    const output: SegmentNode[] = [];
    let foldIndex = 0;
    for (const part of parts) {
      if ("node" in part) {
        output.push(part.node);
        continue;
      }
      const isFinalFold = foldIndex === foldCount - 1;
      const id = `process:${anchorId}:${foldIndex}`;
      foldIndex++;
      folds.set(id, part.members);
      output.push({
        type: "segment",
        id,
        turnId: part.members[0]?.turnId ?? anchor?.turnId ?? "preamble",
        segment: this.processSegment(id, part.members, {
          // Only the last fold ends this answer; earlier folds lead into an
          // async question or a mid-turn reply.
          status: isFinalFold ? status : "unknown",
          startedAt: part.startedAt,
          endedAt: isFinalFold ? blockEnd : undefined,
          pageCursor,
        }),
      });
    }
    return output;
  }

  /**
   * Provider run that a block belongs to. Providers without native run ids
   * share the generic `session` run, whose facts only describe the latest
   * block.
   */
  private blockRunId(
    block: readonly SegmentNode[],
    anchor: QuestionNode | undefined,
    isLast: boolean,
  ): string | undefined {
    const turnId = anchor?.turnId ?? block[0]?.turnId;
    const runId = turnId?.startsWith("turn:")
      ? turnId.slice("turn:".length)
      : undefined;
    if (runId && runId !== "session" && this.endedRuns.has(runId)) return runId;
    if (runId && runId !== "session" && this.runEndedAt.has(runId))
      return runId;
    return isLast ? this.currentRun : undefined;
  }

  private blockStatus(
    block: readonly SegmentNode[],
    anchor: QuestionNode | undefined,
    isLast: boolean,
    answered: boolean,
  ): ProcessSegment["status"] {
    if (block.some((node) => node.segment.type === "error")) return "failed";
    if (
      block.some(
        (node) =>
          node.segment.type === "notice" &&
          node.segment.kind === "turn_aborted",
      )
    )
      return "interrupted";
    const runId = this.blockRunId(block, anchor, isLast);
    const runStatus = runId ? this.runStatuses.get(runId) : undefined;
    if (runStatus && runStatus !== "running") return runStatus;
    if (
      isLast &&
      (this.runtime === "completed" ||
        this.runtime === "interrupted" ||
        this.runtime === "failed")
    )
      return this.runtime;
    return answered ? "completed" : "unknown";
  }

  /** Known source times of a segment, including its tools' lifecycles. */
  private segmentTimes(node: SegmentNode): SourceTime[] {
    const values: Array<string | undefined> = [node.segment.timestamp];
    if (node.segment.type === "tool_group") {
      for (const id of this.groups.get(node.segment.id)?.tools ?? []) {
        const step = this.tools.get(id)?.step;
        values.push(step?.timestamp, step?.completedAt);
      }
    }
    return values.flatMap((value) => {
      const time = Date.parse(value ?? "");
      return value && Number.isFinite(time) ? [{ time, value }] : [];
    });
  }

  private latestTime(nodes: readonly SegmentNode[]): SourceTime | undefined {
    let latest: SourceTime | undefined;
    for (const node of nodes)
      for (const time of this.segmentTimes(node))
        if (!latest || time.time > latest.time) latest = time;
    return latest;
  }

  private processSegment(
    id: string,
    members: readonly SegmentNode[],
    options: {
      status: ProcessSegment["status"];
      startedAt?: string;
      endedAt?: SourceTime;
      pageCursor?: string;
    },
  ): ProcessSegment {
    let toolCount = 0;
    let failedToolCount = 0;
    let thinkingCount = 0;
    let updateCount = 0;
    const paths = new Set<string>();
    const messageIds = new Set<string>();
    let earliest: SourceTime | undefined;
    for (const node of members) {
      const segment = node.segment;
      if (segment.type === "tool_group") {
        toolCount += segment.count;
        failedToolCount += segment.failedCount;
        for (const toolId of this.groups.get(segment.id)?.tools ?? [])
          for (const path of this.tools.get(toolId)?.paths ?? [])
            paths.add(path);
      } else if (segment.type === "thinking") thinkingCount++;
      else if (segment.type === "assistant_text") {
        updateCount++;
        if (
          segment.messageId &&
          messageIds.size < SESSION_DISPLAY_PROCESS_MAX_MESSAGE_IDS
        )
          messageIds.add(segment.messageId);
      }
      for (const time of this.segmentTimes(node))
        if (!earliest || time.time < earliest.time) earliest = time;
    }
    const startedAt = Number.isFinite(Date.parse(options.startedAt ?? ""))
      ? options.startedAt
      : earliest?.value;
    const startMs = Date.parse(startedAt ?? "");
    const end = options.endedAt ?? this.latestTime(members);
    const endedAt =
      end && Number.isFinite(startMs) && end.time > startMs
        ? end.value
        : undefined;
    return {
      type: "process",
      id,
      status: options.status,
      stepCount: members.length,
      toolCount,
      failedToolCount,
      thinkingCount,
      updateCount,
      ...(paths.size ? { changedFileCount: paths.size } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      version: foldVersion(members),
      ...(options.pageCursor ? { pageCursor: options.pageCursor } : {}),
      ...(messageIds.size ? { messageIds: [...messageIds] } : {}),
      ...(startedAt ? { timestamp: startedAt } : {}),
    };
  }

  /** True when the id is a raw node or a fold of the current projection. */
  hasNode(id: string): boolean {
    if (this.nodeIndices.has(id)) return true;
    return (
      this.options.foldSettled === true &&
      id.startsWith("process:") &&
      this.foldProcesses(this.renderNodes()).folds.has(id)
    );
  }

  /** Folded members of one `process` segment, or null when it is not folded. */
  processNodes(id: string): SessionDisplayNode[] | null {
    if (!id.startsWith("process:")) return null;
    this.reapStrandedTools();
    return this.foldProcesses(this.renderNodes()).folds.get(id) ?? null;
  }

  /**
   * @param olderCursor cursor of the next older history page
   * @param pageCursor cursor that produced this (older) page, recorded on
   *   folds so their members can be read back outside the live projection
   */
  snapshot(olderCursor?: string, pageCursor?: string): SessionDisplaySnapshot {
    this.reapStrandedTools();
    const rendered = this.renderNodes();
    const nodes = this.options.foldSettled
      ? this.foldProcesses(rendered, pageCursor).nodes
      : rendered;
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

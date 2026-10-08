import type { Message } from "../supervisor/types.js";

export interface CodexAgentWait {
  type: "agentWait";
  id: string;
  status: "running" | "completed" | "interrupted" | "failed";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outcome?: "message" | "timeout" | "user_input" | "unknown";
}

export interface CodexAgentWaitSnapshot {
  item: CodexAgentWait;
  turnId?: string;
  timestamp?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function iso(value: unknown): string | undefined {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function isCodexAgentWaitTool(
  name: unknown,
  namespace?: unknown,
): boolean {
  if (
    namespace !== undefined &&
    namespace !== null &&
    namespace !== "" &&
    namespace !== "collaboration" &&
    namespace !== "multi_agent_v1"
  )
    return false;
  return (
    typeof name === "string" &&
    /^(?:(?:collaboration|multi_agent_v1)[.:])?wait_agent$/.test(name)
  );
}

function resultOutcome(output: unknown): CodexAgentWait["outcome"] {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return "unknown";
    }
  }
  const data = record(value);
  if (data?.timed_out === true) return "timeout";
  if (typeof data?.message === "string") {
    if (data.message.startsWith("Wait interrupted by new input."))
      return "user_input";
    if (data.message.startsWith("Wait completed.")) return "message";
  }
  return "unknown";
}

/** Correlate actual execution timestamps and result, never the requested timeout. */
export class CodexAgentWaitTracker {
  private waits = new Map<string, CodexAgentWaitSnapshot>();
  private currentTurnId: string | undefined;

  values(): CodexAgentWaitSnapshot[] {
    return [...this.waits.values()];
  }

  finishTurn(
    turnId: string | undefined,
    status: "interrupted" | "failed" | "completed",
    timestamp?: string,
  ): CodexAgentWaitSnapshot[] {
    const changed: CodexAgentWaitSnapshot[] = [];
    for (const [id, wait] of this.waits) {
      if (wait.item.status !== "running" || !turnId || wait.turnId !== turnId)
        continue;
      const completedAt = iso(timestamp);
      const item: CodexAgentWait = {
        ...wait.item,
        status,
        outcome: "unknown",
        ...(completedAt ? { completedAt } : {}),
      };
      if (item.startedAt && completedAt)
        item.durationMs = Math.max(
          0,
          Date.parse(completedAt) - Date.parse(item.startedAt),
        );
      const snapshot = { ...wait, item };
      this.waits.set(id, snapshot);
      changed.push(snapshot);
    }
    return changed;
  }

  observe(entry: {
    type: string;
    payload: unknown;
    timestamp?: string;
    turnId?: string;
  }): CodexAgentWaitSnapshot | null {
    const payload = record(entry.payload);
    if (!payload) return null;
    const metadata = record(payload.internal_chat_message_metadata_passthrough);
    const turnId =
      entry.turnId ??
      (typeof metadata?.turn_id === "string" ? metadata.turn_id : undefined) ??
      (typeof payload.turn_id === "string" ? payload.turn_id : undefined);
    if (
      entry.type === "turn_context" ||
      (entry.type === "event_msg" &&
        (payload.type === "task_started" || payload.type === "turn_started"))
    ) {
      if (turnId) this.currentTurnId = turnId;
      return null;
    }
    if (
      entry.type === "event_msg" &&
      (payload.type === "turn_aborted" ||
        payload.type === "task_complete" ||
        payload.type === "turn_complete")
    ) {
      this.finishTurn(
        turnId ?? this.currentTurnId,
        payload.type === "turn_aborted" ? "interrupted" : "completed",
      );
      return null;
    }

    const native =
      entry.type === "event_msg" &&
      (payload.type === "item_started" || payload.type === "item_completed")
        ? record(payload.item)
        : undefined;
    const nativeWait =
      (native?.type === "CollabAgentToolCall" ||
        native?.type === "collabAgentToolCall") &&
      native.tool === "wait";
    const call =
      entry.type === "response_item" &&
      payload.type === "function_call" &&
      isCodexAgentWaitTool(payload.name, payload.namespace);
    const output =
      entry.type === "response_item" && payload.type === "function_call_output";
    const id = nativeWait ? native?.id : payload.call_id;
    if (typeof id !== "string" || (!nativeWait && !call && !output))
      return null;
    const previous = this.waits.get(id);
    if (!nativeWait && !call && !previous) return null;
    const item: CodexAgentWait = previous
      ? { ...previous.item }
      : { type: "agentWait", id, status: "running" };
    const timestamp = iso(entry.timestamp);
    if (call && !item.startedAt && timestamp) item.startedAt = timestamp;
    if (nativeWait) {
      const startedAt = iso(payload.started_at_ms ?? payload.startedAtMs);
      const completedAt = iso(payload.completed_at_ms ?? payload.completedAtMs);
      if (startedAt) item.startedAt = startedAt;
      if (completedAt) item.completedAt = completedAt;
      if (payload.type === "item_started" && !item.startedAt && timestamp)
        item.startedAt = timestamp;
      if (payload.type === "item_completed") {
        item.status =
          native?.status === "failed"
            ? "failed"
            : native?.status === "interrupted"
              ? "interrupted"
              : "completed";
        if (!item.completedAt && timestamp) item.completedAt = timestamp;
        item.outcome ??= "unknown";
      }
    }
    if (output) {
      item.outcome = resultOutcome(payload.output);
      item.status =
        payload.is_error === true || item.status === "failed"
          ? "failed"
          : item.outcome === "user_input"
            ? "interrupted"
            : "completed";
      if (!item.completedAt && timestamp) item.completedAt = timestamp;
    }
    if (item.outcome === "user_input" && item.status !== "failed")
      item.status = "interrupted";
    if (item.startedAt && item.completedAt) {
      const duration =
        Date.parse(item.completedAt) - Date.parse(item.startedAt);
      if (duration >= 0) item.durationMs = duration;
    }
    const snapshot: CodexAgentWaitSnapshot = {
      item,
      ...((turnId ?? previous?.turnId ?? this.currentTurnId)
        ? { turnId: turnId ?? previous?.turnId ?? this.currentTurnId }
        : {}),
      ...((item.startedAt ?? timestamp)
        ? { timestamp: item.startedAt ?? timestamp }
        : {}),
    };
    this.waits.set(id, snapshot);
    return snapshot;
  }
}

export function codexAgentWaitMessage(
  snapshot: CodexAgentWaitSnapshot,
  sessionId: string,
): Message {
  const { item, turnId, timestamp } = snapshot;
  return {
    uuid: `codex-agent-wait:${sessionId}:${turnId ?? ""}:${item.id}`,
    type: "system",
    subtype: "codex_native_item",
    ...(timestamp ? { timestamp } : {}),
    codexThreadId: sessionId,
    ...(turnId ? { codexTurnId: turnId } : {}),
    codexThreadItemId: item.id,
    codexThreadItemLifecycle:
      item.status === "running" ? "started" : "completed",
    codexCorrelationKey: `codex:${turnId ?? ""}:agent-wait:${item.id}`,
    codexThreadItem: item,
  };
}

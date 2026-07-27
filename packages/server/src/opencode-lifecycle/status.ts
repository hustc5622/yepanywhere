export type OpenCodeUpstreamStatusType = "busy" | "retry" | "idle";

export interface OpenCodeRetryStatus {
  attempt?: number;
  message?: string;
  /** Epoch milliseconds for the next retry attempt. */
  next?: number;
  actionLabel?: string;
  actionLink?: string;
}

export interface OpenCodeUpstreamStatus {
  type: OpenCodeUpstreamStatusType;
  retryStatus?: OpenCodeRetryStatus;
}

export type OpenCodeAssistantTerminalEvidence =
  | "terminal"
  | "nonterminal"
  | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readNumber(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

/**
 * Normalize both current OpenCode status values and the historical `running`
 * spelling used by older builds and fixtures.
 */
export function parseOpenCodeUpstreamStatus(
  value: unknown,
): OpenCodeUpstreamStatus | null {
  const record = isRecord(value) ? value : undefined;
  const rawType = readString(record, "type")?.toLowerCase();
  const type = rawType === "running" ? "busy" : rawType;
  if (type !== "busy" && type !== "retry" && type !== "idle") {
    return null;
  }
  if (type !== "retry") return { type };

  const action = isRecord(record?.action) ? record.action : undefined;
  return {
    type,
    retryStatus: {
      attempt: readNumber(record, "attempt"),
      message: readString(record, "message"),
      next: readNumber(record, "next"),
      actionLabel: readString(action, "label"),
      actionLink: readString(action, "link"),
    },
  };
}

/**
 * OpenCode's status map omits idle sessions. A missing key is therefore an
 * idle sample, not an unknown status.
 */
export function readOpenCodeSessionStatus(
  value: unknown,
  sessionId: string,
): OpenCodeUpstreamStatus {
  if (!isRecord(value) || !Object.hasOwn(value, sessionId)) {
    return { type: "idle" };
  }
  return parseOpenCodeUpstreamStatus(value[sessionId]) ?? { type: "idle" };
}

/**
 * Determine whether the newest assistant message proves that the agent loop
 * is terminal. A completed `tool-calls` message may still continue into tool
 * execution. OpenCode may also finish a stream with `finish=unknown` without
 * treating it as a fatal provider/session error, so a completed message with
 * that finish value is terminal once authoritative idle and settled tools
 * confirm the turn has stopped. Old OpenCode versions without finish metadata
 * remain unknown and use the stable-idle compatibility path.
 */
export function readOpenCodeAssistantTerminalEvidence(
  value: unknown,
): OpenCodeAssistantTerminalEvidence | null {
  const wrapper = isRecord(value) ? value : undefined;
  const info = isRecord(wrapper?.info) ? wrapper.info : wrapper;
  if (!info || readString(info, "role") !== "assistant") return null;

  const time = isRecord(info.time) ? info.time : undefined;
  const completed = readNumber(time, "completed") !== undefined;
  const finish = readString(info, "finish")?.toLowerCase();
  if (!completed) return "nonterminal";
  if (!finish) return "unknown";
  if (finish === "tool-calls") return "nonterminal";
  return "terminal";
}

export function isOpenCodeToolPartPending(value: unknown): boolean | null {
  const wrapper = isRecord(value) ? value : undefined;
  const part = isRecord(wrapper?.part) ? wrapper.part : wrapper;
  if (!part || readString(part, "type") !== "tool") return null;
  const state = isRecord(part.state) ? part.state : undefined;
  const status = readString(state, "status")?.toLowerCase();
  if (!status) return null;
  return status === "pending" || status === "running";
}

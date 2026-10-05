import type { useOptionalI18n } from "../i18n";
import englishMessages from "../i18n/en.json";

export type CodexAgentStatus =
  | "pendingInit"
  | "running"
  | "idle"
  | "completed"
  | "interrupted"
  | "errored"
  | "shutdown"
  | "notFound"
  | "notLoaded"
  | "queued"
  | "suspended"
  | "unknown";

export type CodexAgentTranslate = NonNullable<
  ReturnType<typeof useOptionalI18n>
>["t"];

/** English fallback for standalone renderers; application views use I18nContext. */
export const codexAgentFallbackText: CodexAgentTranslate = (key, vars) => {
  let value = englishMessages[key];
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function message(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * App-server CollabAgentState uses {status, message}, whereas v2 tool results
 * serialize AgentStatus as "running" or {completed: message}/{errored: error}.
 */
export function normalizeCodexAgentStatus(value: unknown): {
  status: CodexAgentStatus;
  message?: string;
} {
  const object = record(value);
  if (object) {
    if ("completed" in object) {
      return { status: "completed", message: message(object.completed) };
    }
    if ("errored" in object) {
      return { status: "errored", message: message(object.errored) };
    }
    if ("status" in object) {
      const normalized = normalizeCodexAgentStatus(object.status);
      return {
        ...normalized,
        message: message(object.message) ?? normalized.message,
      };
    }
    // Thread/read runtime snapshots describe liveness separately from turns.
    if (typeof object.type === "string") {
      return normalizeCodexAgentStatus(object.type);
    }
  }
  switch (value) {
    case "pending_init":
    case "pendingInit":
    case "starting":
      return { status: "pendingInit" };
    case "running":
    case "active":
    case "in_progress":
    case "inProgress":
      return { status: "running" };
    case "idle":
      return { status: "idle" };
    case "completed":
    case "complete":
      return { status: "completed" };
    case "interrupted":
    case "aborted":
      return { status: "interrupted" };
    case "errored":
    case "error":
    case "failed":
    case "systemError":
      return { status: "errored" };
    case "shutdown":
      return { status: "shutdown" };
    case "not_found":
    case "notFound":
      return { status: "notFound" };
    case "notLoaded":
      return { status: "notLoaded" };
    case "queued":
      return { status: "queued" };
    case "suspended":
      return { status: "suspended" };
    default:
      return { status: "unknown" };
  }
}

const STATUS_KEYS = {
  pendingInit: "codexAgentStatusStarting",
  running: "codexAgentStatusRunning",
  idle: "codexAgentStatusIdle",
  completed: "codexAgentStatusCompleted",
  interrupted: "codexAgentStatusInterrupted",
  errored: "codexAgentStatusFailed",
  shutdown: "codexAgentStatusClosed",
  notFound: "codexAgentStatusUnavailable",
  notLoaded: "codexAgentStatusNotLoaded",
  queued: "codexAgentStatusQueued",
  suspended: "codexAgentStatusSuspended",
  unknown: "codexAgentStatusUnknown",
} as const;

export function codexAgentStatusLabel(
  status: CodexAgentStatus,
  t: CodexAgentTranslate = codexAgentFallbackText,
): string {
  return t(STATUS_KEYS[status]);
}

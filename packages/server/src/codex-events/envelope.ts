import {
  CODEX_EVENT_SCHEMA_NAME,
  CODEX_EVENT_SCHEMA_VERSION,
  type CodexCallId,
  type CodexEventDirection,
  type CodexEventDraft,
  type CodexEventPhase,
  type CodexRuntimeIdentity,
  type SafeCodexPayload,
  type SafeJsonObject,
  type SafeJsonValue,
} from "./types.js";

export interface CreateCodexEventDraftInput {
  eventId: string;
  dedupeKey?: string;
  runtime: CodexRuntimeIdentity;
  projectId?: string;
  accountId?: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  callId?: CodexCallId;
  requestId?: CodexCallId;
  clientMessageId?: string;
  correlationId?: string;
  method: string;
  direction: CodexEventDirection;
  phase?: CodexEventPhase;
  appServerEmittedAtMs?: number;
  receivedAtMs?: number;
  payload: SafeCodexPayload;
  rawRef?: string;
  connectionId: string;
  replay?: boolean;
}

/**
 * Builds the transport-neutral portion of an event. Persistence assigns the
 * monotonic `sequence` and `persistedAtMs` fields.
 */
export function createCodexEventDraft(
  input: CreateCodexEventDraftInput,
): CodexEventDraft {
  const payload = asObject(input.payload.data);
  const nestedThread = asObject(payload?.thread);
  const nestedTurn = asObject(payload?.turn);
  const nestedItem = asObject(payload?.item);

  const threadId =
    input.threadId ??
    readString(payload, "threadId") ??
    readString(nestedThread, "id");
  const turnId =
    input.turnId ??
    readString(payload, "turnId") ??
    readString(nestedTurn, "id");
  const itemId =
    input.itemId ??
    readString(payload, "itemId") ??
    readString(nestedItem, "id");
  const callId = input.callId ?? readCallId(payload, "callId");
  const requestId = input.requestId ?? readCallId(payload, "requestId");
  const clientMessageId =
    input.clientMessageId ??
    readString(payload, "clientMessageId") ??
    readString(nestedItem, "clientId");

  return {
    schema: {
      name: CODEX_EVENT_SCHEMA_NAME,
      version: CODEX_EVENT_SCHEMA_VERSION,
    },
    eventId: input.eventId,
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
    provider: "codex",
    runtime: structuredClone(input.runtime),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    sessionId: input.sessionId,
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(callId === undefined ? {} : { callId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
    correlationId:
      input.correlationId ??
      String(
        requestId ?? callId ?? itemId ?? turnId ?? threadId ?? input.eventId,
      ),
    method: input.method,
    direction: input.direction,
    phase: input.phase ?? "observed",
    ...(input.appServerEmittedAtMs === undefined
      ? {}
      : { appServerEmittedAtMs: input.appServerEmittedAtMs }),
    receivedAtMs: input.receivedAtMs ?? Date.now(),
    payload: structuredClone(input.payload),
    ...(input.rawRef === undefined ? {} : { rawRef: input.rawRef }),
    source: {
      connectionId: input.connectionId,
      replay: input.replay ?? false,
    },
  };
}

function asObject(
  value: SafeJsonValue | undefined,
): SafeJsonObject | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  return value;
}

function readString(
  object: SafeJsonObject | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCallId(
  object: SafeJsonObject | undefined,
  key: string,
): CodexCallId | undefined {
  const value = object?.[key];
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

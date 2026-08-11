import {
  type CodexCallId,
  type CodexEventDirection,
  type CodexEventDraft,
  type CodexEventEnvelope,
  type CodexEventPhase,
  type SafeJsonValue,
  createCodexEventDraft,
  safeCodexPayload,
} from "../../src/codex-events/index.js";

const runtime = {
  codexVersion: "0.147.0",
  schemaHash: "sha256:test-schema",
  profile: "experimental" as const,
  experimentalApi: true,
};

export interface TestDraftOptions {
  eventId?: string;
  dedupeKey?: string;
  direction?: CodexEventDirection;
  phase?: CodexEventPhase;
  sessionId?: string;
  connectionId?: string;
  receivedAtMs?: number;
  requestId?: CodexCallId;
  clientMessageId?: string;
  correlationId?: string;
}

export function testDraft(
  method: string,
  data: SafeJsonValue,
  options: TestDraftOptions = {},
): CodexEventDraft {
  return createCodexEventDraft({
    eventId: options.eventId ?? `event:${method}`,
    ...(options.dedupeKey === undefined
      ? {}
      : { dedupeKey: options.dedupeKey }),
    runtime,
    sessionId: options.sessionId ?? "session-1",
    method,
    direction: options.direction ?? "server_notification",
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    payload: safeCodexPayload(data),
    connectionId: options.connectionId ?? "connection-1",
    receivedAtMs: options.receivedAtMs ?? 1_000,
    ...(options.requestId === undefined
      ? {}
      : { requestId: options.requestId }),
    ...(options.clientMessageId === undefined
      ? {}
      : { clientMessageId: options.clientMessageId }),
    ...(options.correlationId === undefined
      ? {}
      : { correlationId: options.correlationId }),
  });
}

export function testEvent(
  sequence: number,
  method: string,
  data: SafeJsonValue,
  options: TestDraftOptions = {},
): CodexEventEnvelope {
  return {
    ...testDraft(method, data, {
      ...options,
      eventId: options.eventId ?? `event-${sequence}:${method}`,
    }),
    persistedAtMs: 2_000 + sequence,
    sequence,
  };
}

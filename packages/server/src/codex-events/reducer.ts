import { classifyCodexNotification } from "./classification.js";
import type { CodexEventStore } from "./store.js";
import {
  CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE,
  type CanonicalCodexItemState,
  type CanonicalCodexSessionState,
  type CanonicalCodexThreadState,
  type CanonicalCodexTurnState,
  type CodexCanonicalItemKind,
  type CodexCanonicalTurnStatus,
  type CodexEventAnomalyKind,
  type CodexEventEnvelope,
  type SafeJsonObject,
  type SafeJsonValue,
  createCanonicalCodexSessionState,
} from "./types.js";

const TERMINAL_TURN_STATUSES = new Set<CodexCanonicalTurnStatus>([
  "completed",
  "interrupted",
  "failed",
]);

/** Apply one persisted event without mutating the supplied projection. */
export function reduceCodexEvent(
  current: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
): CanonicalCodexSessionState {
  if (
    current.appliedEventIds.includes(event.eventId) ||
    (event.dedupeKey !== undefined &&
      current.appliedDedupeKeys.includes(event.dedupeKey))
  ) {
    return current;
  }

  const state = structuredClone(current);
  if (event.sequence < state.lastSequence) {
    addAnomaly(state, event, "out_of_order");
  }
  state.lastSequence = Math.max(state.lastSequence, event.sequence);
  state.appliedEventIds.push(event.eventId);
  if (event.dedupeKey !== undefined) {
    state.appliedDedupeKeys.push(event.dedupeKey);
  }

  const classification =
    event.direction === "server_notification"
      ? classifyCodexNotification(event.method)
      : undefined;
  state.observations.push({
    eventId: event.eventId,
    sequence: event.sequence,
    method: event.method,
    direction: event.direction,
    classification: classification
      ? `${classification.domain}:${classification.disposition}`
      : `${event.direction}:${event.phase}`,
  });
  state.notificationCounts[event.method] =
    (state.notificationCounts[event.method] ?? 0) + 1;

  if (event.sessionId !== state.sessionId) {
    addAnomaly(state, event, "session_mismatch");
    return state;
  }

  if (classification && !classification.known) {
    state.unknownEvents.push({
      eventId: event.eventId,
      sequence: event.sequence,
      method: event.method,
      direction: event.direction,
      compatibility: classification.compatibility,
      payload: structuredClone(event.payload),
    });
    return state;
  }

  if (event.direction === "server_request") {
    reduceServerRequest(state, event);
    return state;
  }
  if (
    event.direction === "client_response" &&
    event.phase === "observed" &&
    event.correlationId.startsWith("client-retry:")
  ) {
    reduceClientRetry(state, event, asObject(event.payload.data));
    return state;
  }
  if (
    event.direction === "client_response" &&
    event.phase === "resolved" &&
    event.correlationId.startsWith("server-request:")
  ) {
    reduceServerRequestResolved(state, event, asObject(event.payload.data));
    return state;
  }
  if (event.direction !== "server_notification") return state;

  const payload = asObject(event.payload.data);
  switch (event.method) {
    case "thread/started":
      reduceThreadStarted(state, event, payload);
      break;
    case "thread/status/changed":
      reduceThreadStatus(state, event, payload);
      break;
    case "thread/archived":
      setThreadLifecycle(state, event, payload, "archived");
      break;
    case "thread/deleted":
      setThreadLifecycle(state, event, payload, "deleted");
      break;
    case "thread/unarchived":
      setThreadLifecycle(state, event, payload, "active");
      break;
    case "thread/closed":
      setThreadLifecycle(state, event, payload, "closed");
      break;
    case "turn/started":
      reduceTurnLifecycle(state, event, payload, false);
      break;
    case "turn/completed":
      reduceTurnLifecycle(state, event, payload, true);
      break;
    case "turn/plan/updated":
      reduceTurnPlan(state, event, payload);
      break;
    case "turn/diff/updated":
      reduceTurnDiff(state, event, payload);
      break;
    case "error":
      reduceError(state, event, payload);
      break;
    case "serverRequest/resolved":
      reduceServerRequestResolved(state, event, payload);
      break;
    case "item/started":
      reduceItemLifecycle(state, event, payload, false);
      break;
    case "item/completed":
      reduceItemLifecycle(state, event, payload, true);
      break;
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/mcpToolCall/progress":
      reduceItemDelta(state, event, payload);
      break;
  }
  return state;
}

function reduceClientRetry(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): void {
  const retry = asObject(payload?.retryStatus);
  const retryState = readString(retry, "state");
  const category = readString(retry, "category");
  const attempt = readNumber(retry, "attempt");
  const nextAttempt = readNumber(retry, "nextAttempt");
  const maxAttempts = readNumber(retry, "maxAttempts");
  const retryInMs = readNumber(retry, "retryInMs");
  if (
    event.requestId === undefined ||
    (retryState !== "queued" && retryState !== "retrying") ||
    category !== "overloaded" ||
    retry?.retryable !== true ||
    attempt === undefined ||
    nextAttempt === undefined ||
    maxAttempts === undefined ||
    retryInMs === undefined ||
    !Number.isSafeInteger(attempt) ||
    attempt <= 0 ||
    !Number.isSafeInteger(nextAttempt) ||
    nextAttempt !== attempt + 1 ||
    !Number.isSafeInteger(maxAttempts) ||
    nextAttempt > maxAttempts ||
    !Number.isSafeInteger(retryInMs) ||
    retryInMs < 0
  ) {
    addAnomaly(state, event, "missing_identity");
    return;
  }
  state.clientRetries.push({
    state: retryState,
    category: "overloaded",
    retryable: true,
    attempt,
    nextAttempt,
    maxAttempts,
    retryInMs,
    method: event.method,
    requestId: event.requestId,
    ...(event.clientMessageId === undefined
      ? {}
      : { clientMessageId: event.clientMessageId }),
    ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
    sequence: event.sequence,
  });
}

/** Sort first so a live batch and a persisted replay project identically. */
export function reduceCodexEvents(
  initial: CanonicalCodexSessionState,
  events: readonly CodexEventEnvelope[],
): CanonicalCodexSessionState {
  return [...events]
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.eventId.localeCompare(right.eventId),
    )
    .reduce(reduceCodexEvent, initial);
}

export async function replayCodexSession(
  store: CodexEventStore,
  sessionId: string,
): Promise<CanonicalCodexSessionState> {
  const events = await store.replay({ sessionId });
  return reduceCodexEvents(createCanonicalCodexSessionState(sessionId), events);
}

function reduceThreadStarted(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): void {
  const threadSnapshot = asObject(payload?.thread);
  const threadId = resolveThreadId(event, payload);
  if (!threadId) {
    addAnomaly(state, event, "missing_identity");
    return;
  }
  const thread = ensureThread(state, threadId, event.sequence);
  thread.lifecycle = thread.lifecycle ?? "active";
  thread.status = readTaggedString(threadSnapshot?.status) ?? thread.status;
  thread.lastSequence = Math.max(thread.lastSequence, event.sequence);
}

function reduceThreadStatus(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): void {
  const threadId = resolveThreadId(event, payload);
  if (!threadId) {
    addAnomaly(state, event, "missing_identity");
    return;
  }
  const thread = ensureThread(state, threadId, event.sequence);
  thread.status = readTaggedString(payload?.status) ?? thread.status;
  thread.lastSequence = Math.max(thread.lastSequence, event.sequence);
}

function setThreadLifecycle(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
  lifecycle: NonNullable<CanonicalCodexThreadState["lifecycle"]>,
): void {
  const threadId = resolveThreadId(event, payload);
  if (!threadId) {
    addAnomaly(state, event, "missing_identity");
    return;
  }
  const thread = ensureThread(state, threadId, event.sequence);
  thread.lifecycle = lifecycle;
  thread.lastSequence = Math.max(thread.lastSequence, event.sequence);
}

function reduceTurnLifecycle(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
  completed: boolean,
): void {
  const threadId = resolveThreadId(event, payload);
  const turnSnapshot = asObject(payload?.turn);
  const turnId = resolveTurnId(event, payload);
  if (!threadId || !turnId) {
    addAnomaly(state, event, "missing_identity");
    return;
  }
  const turn = ensureTurn(state, threadId, turnId, event.sequence);
  const incomingStatus = normalizeTurnStatus(
    readString(turnSnapshot, "status"),
  );
  if (completed) {
    if (TERMINAL_TURN_STATUSES.has(turn.status)) {
      addAnomaly(state, event, "terminal_rewrite_ignored");
    } else {
      turn.status = incomingStatus ?? "completed";
      turn.completedAtMs = secondsToMs(readNumber(turnSnapshot, "completedAt"));
      const error = turnSnapshot?.error;
      if (error !== undefined && error !== null)
        turn.error = structuredClone(error);
    }
  } else if (!TERMINAL_TURN_STATUSES.has(turn.status)) {
    turn.status = "in_progress";
    turn.startedAtMs = secondsToMs(readNumber(turnSnapshot, "startedAt"));
  }
  turn.lastSequence = Math.max(turn.lastSequence, event.sequence);

  const items = turnSnapshot?.items;
  if (Array.isArray(items)) {
    for (const value of items) {
      const item = asObject(value);
      if (!item) continue;
      hydrateItem(turn, event, item, completed);
    }
  }
}

function reduceTurnPlan(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): void {
  const turn = resolveTurn(state, event, payload);
  if (!turn) return;
  if (payload?.plan !== undefined) turn.plan = structuredClone(payload.plan);
  turn.lastSequence = Math.max(turn.lastSequence, event.sequence);
}

function reduceTurnDiff(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): void {
  const turn = resolveTurn(state, event, payload);
  if (!turn) return;
  turn.diff = readString(payload, "diff") ?? turn.diff;
  turn.lastSequence = Math.max(turn.lastSequence, event.sequence);
}

function reduceError(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): void {
  const turn = resolveTurn(state, event, payload);
  if (!turn) return;
  if (payload?.error !== undefined) turn.error = structuredClone(payload.error);
  if (
    payload?.willRetry === false &&
    !TERMINAL_TURN_STATUSES.has(turn.status)
  ) {
    turn.status = "failed";
  }
  turn.lastSequence = Math.max(turn.lastSequence, event.sequence);
}

function reduceServerRequest(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
): void {
  const payload = asObject(event.payload.data);
  const turn = resolveTurn(state, event, payload);
  if (turn && !TERMINAL_TURN_STATUSES.has(turn.status)) {
    turn.status = "waiting_user";
    turn.lastSequence = Math.max(turn.lastSequence, event.sequence);
  }
}

function reduceServerRequestResolved(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): void {
  const turn = resolveTurn(state, event, payload);
  if (turn?.status === "waiting_user") turn.status = "in_progress";
  if (turn) turn.lastSequence = Math.max(turn.lastSequence, event.sequence);
}

function reduceItemLifecycle(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
  completed: boolean,
): void {
  const turn = resolveTurn(state, event, payload);
  if (!turn) return;
  const snapshot = asObject(payload?.item);
  const itemId = resolveItemId(event, payload);
  if (!itemId || !snapshot) {
    addAnomaly(state, event, "missing_identity");
    return;
  }
  const item = ensureItem(turn, itemId, event.sequence);
  if (completed) {
    if (item.status === "completed") {
      addAnomaly(state, event, "terminal_rewrite_ignored");
      return;
    }
    applyItemIdentity(item, snapshot);
    item.snapshot = structuredClone(snapshot);
    item.status = "completed";
    item.completedAtMs = readNumber(payload, "completedAtMs");
    item.completedSequence = event.sequence;
  } else {
    if (item.status === "completed") {
      addAnomaly(state, event, "late_started");
      return;
    }
    applyItemIdentity(item, snapshot);
    item.snapshot = structuredClone(snapshot);
    item.status = hasStreamData(item) ? "streaming" : "started";
    item.startedAtMs = readNumber(payload, "startedAtMs");
    item.startedSequence = event.sequence;
  }
  item.lastSequence = Math.max(item.lastSequence, event.sequence);
  turn.lastSequence = Math.max(turn.lastSequence, event.sequence);
}

function hydrateItem(
  turn: CanonicalCodexTurnState,
  event: CodexEventEnvelope,
  snapshot: SafeJsonObject,
  completed: boolean,
): void {
  const itemId = readString(snapshot, "id");
  if (!itemId) return;
  const item = ensureItem(turn, itemId, event.sequence);
  if (item.status === "completed" && !completed) return;
  applyItemIdentity(item, snapshot);
  item.snapshot = structuredClone(snapshot);
  if (completed) {
    item.status = "completed";
    item.completedSequence ??= event.sequence;
  } else if (item.status !== "completed") {
    item.status = hasStreamData(item) ? "streaming" : "started";
    item.startedSequence ??= event.sequence;
  }
  item.lastSequence = Math.max(item.lastSequence, event.sequence);
}

function reduceItemDelta(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): void {
  const turn = resolveTurn(state, event, payload);
  if (!turn) return;
  const itemId = resolveItemId(event, payload);
  if (!itemId) {
    addAnomaly(state, event, "missing_identity");
    return;
  }
  const item = ensureItem(turn, itemId, event.sequence);
  if (item.status === "completed") {
    item.lateDeltaCount += 1;
    item.lastSequence = Math.max(item.lastSequence, event.sequence);
    turn.lastSequence = Math.max(turn.lastSequence, event.sequence);
    addAnomaly(state, event, "late_delta");
    return;
  }

  const delta = readString(payload, "delta") ?? "";
  switch (event.method) {
    case "item/agentMessage/delta":
      item.nativeType =
        item.nativeType === "unknown" ? "agentMessage" : item.nativeType;
      item.kind = item.kind === "unknown" ? "assistant_message" : item.kind;
      item.stream.assistantText = (item.stream.assistantText ?? "") + delta;
      break;
    case "item/plan/delta":
      item.nativeType =
        item.nativeType === "unknown" ? "plan" : item.nativeType;
      item.kind = item.kind === "unknown" ? "plan" : item.kind;
      item.stream.planText = (item.stream.planText ?? "") + delta;
      break;
    case "item/reasoning/summaryPartAdded": {
      item.nativeType =
        item.nativeType === "unknown" ? "reasoning" : item.nativeType;
      item.kind = item.kind === "unknown" ? "reasoning" : item.kind;
      const index = readIndex(payload, "summaryIndex");
      item.stream.reasoningSummary ??= [];
      const parts = item.stream.reasoningSummary;
      fillThrough(parts, index);
      break;
    }
    case "item/reasoning/summaryTextDelta": {
      item.nativeType =
        item.nativeType === "unknown" ? "reasoning" : item.nativeType;
      item.kind = item.kind === "unknown" ? "reasoning" : item.kind;
      item.stream.reasoningSummary ??= [];
      appendIndexed(
        item.stream.reasoningSummary,
        readIndex(payload, "summaryIndex"),
        delta,
      );
      break;
    }
    case "item/reasoning/textDelta":
      item.nativeType =
        item.nativeType === "unknown" ? "reasoning" : item.nativeType;
      item.kind = item.kind === "unknown" ? "reasoning" : item.kind;
      item.stream.reasoningContent ??= [];
      appendIndexed(
        item.stream.reasoningContent,
        readIndex(payload, "contentIndex"),
        delta,
      );
      break;
    case "item/commandExecution/outputDelta":
      item.nativeType =
        item.nativeType === "unknown" ? "commandExecution" : item.nativeType;
      item.kind = item.kind === "unknown" ? "command_execution" : item.kind;
      item.stream.commandOutput = (item.stream.commandOutput ?? "") + delta;
      break;
    case "item/commandExecution/terminalInteraction": {
      item.nativeType =
        item.nativeType === "unknown" ? "commandExecution" : item.nativeType;
      item.kind = item.kind === "unknown" ? "command_execution" : item.kind;
      const processId = readString(payload, "processId");
      if (processId) {
        item.stream.terminalInteractions ??= [];
        item.stream.terminalInteractions.push({ processId });
      }
      break;
    }
    case "item/fileChange/outputDelta":
      item.nativeType =
        item.nativeType === "unknown" ? "fileChange" : item.nativeType;
      item.kind = item.kind === "unknown" ? "file_change" : item.kind;
      item.stream.fileChangeOutput =
        (item.stream.fileChangeOutput ?? "") + delta;
      break;
    case "item/fileChange/patchUpdated":
      item.nativeType =
        item.nativeType === "unknown" ? "fileChange" : item.nativeType;
      item.kind = item.kind === "unknown" ? "file_change" : item.kind;
      if (payload?.changes !== undefined) {
        item.stream.patchChanges = structuredClone(payload.changes);
      }
      break;
    case "item/mcpToolCall/progress": {
      item.nativeType =
        item.nativeType === "unknown" ? "mcpToolCall" : item.nativeType;
      item.kind = item.kind === "unknown" ? "mcp_tool_call" : item.kind;
      const message = readString(payload, "message");
      if (message !== undefined) {
        item.stream.mcpProgress ??= [];
        item.stream.mcpProgress.push(message);
      }
      break;
    }
  }
  item.status = "streaming";
  item.lastSequence = Math.max(item.lastSequence, event.sequence);
  turn.lastSequence = Math.max(turn.lastSequence, event.sequence);
}

function ensureThread(
  state: CanonicalCodexSessionState,
  threadId: string,
  sequence: number,
): CanonicalCodexThreadState {
  const existing = state.threads[threadId];
  if (existing) return existing;
  const thread: CanonicalCodexThreadState = {
    id: threadId,
    turns: {},
    turnOrder: [],
    firstSequence: sequence,
    lastSequence: sequence,
  };
  state.threads[threadId] = thread;
  state.threadOrder.push(threadId);
  return thread;
}

function ensureTurn(
  state: CanonicalCodexSessionState,
  threadId: string,
  turnId: string,
  sequence: number,
): CanonicalCodexTurnState {
  const thread = ensureThread(state, threadId, sequence);
  const existing = thread.turns[turnId];
  if (existing) return existing;
  const turn: CanonicalCodexTurnState = {
    id: turnId,
    threadId,
    status: "queued",
    items: {},
    itemOrder: [],
    firstSequence: sequence,
    lastSequence: sequence,
  };
  thread.turns[turnId] = turn;
  thread.turnOrder.push(turnId);
  thread.lastSequence = Math.max(thread.lastSequence, sequence);
  return turn;
}

function ensureItem(
  turn: CanonicalCodexTurnState,
  itemId: string,
  sequence: number,
): CanonicalCodexItemState {
  const existing = turn.items[itemId];
  if (existing) return existing;
  const item: CanonicalCodexItemState = {
    id: itemId,
    nativeType: "unknown",
    kind: "unknown",
    status: "placeholder",
    stream: {},
    firstSequence: sequence,
    lastSequence: sequence,
    lateDeltaCount: 0,
  };
  turn.items[itemId] = item;
  turn.itemOrder.push(itemId);
  return item;
}

function resolveTurn(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): CanonicalCodexTurnState | undefined {
  const threadId = resolveThreadId(event, payload);
  const turnId = resolveTurnId(event, payload);
  if (!threadId || !turnId) {
    addAnomaly(state, event, "missing_identity");
    return undefined;
  }
  return ensureTurn(state, threadId, turnId, event.sequence);
}

function resolveThreadId(
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): string | undefined {
  return (
    event.threadId ??
    readString(payload, "threadId") ??
    readString(asObject(payload?.thread), "id")
  );
}

function resolveTurnId(
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): string | undefined {
  return (
    event.turnId ??
    readString(payload, "turnId") ??
    readString(asObject(payload?.turn), "id")
  );
}

function resolveItemId(
  event: CodexEventEnvelope,
  payload: SafeJsonObject | undefined,
): string | undefined {
  return (
    event.itemId ??
    readString(payload, "itemId") ??
    readString(asObject(payload?.item), "id")
  );
}

function applyItemIdentity(
  item: CanonicalCodexItemState,
  snapshot: SafeJsonObject,
): void {
  const nativeType = readString(snapshot, "type");
  if (!nativeType) return;
  item.nativeType = nativeType;
  item.kind = canonicalItemKind(nativeType);
}

function canonicalItemKind(
  nativeType: string,
): CodexCanonicalItemKind | "unknown" {
  if (Object.hasOwn(CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE, nativeType)) {
    return CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE[
      nativeType as keyof typeof CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE
    ];
  }
  return "unknown";
}

function hasStreamData(item: CanonicalCodexItemState): boolean {
  return Object.keys(item.stream).length > 0;
}

function appendIndexed(values: string[], index: number, delta: string): void {
  fillThrough(values, index);
  values[index] += delta;
}

function fillThrough(values: string[], index: number): void {
  while (values.length <= index) values.push("");
}

function readIndex(payload: SafeJsonObject | undefined, key: string): number {
  const value = readNumber(payload, key);
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function normalizeTurnStatus(
  status: string | undefined,
): CodexCanonicalTurnStatus | undefined {
  if (status === "inProgress") return "in_progress";
  if (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed"
  ) {
    return status;
  }
  return undefined;
}

function secondsToMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
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
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  object: SafeJsonObject | undefined,
  key: string,
): number | undefined {
  const value = object?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readTaggedString(
  value: SafeJsonValue | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  return readString(asObject(value), "type");
}

function addAnomaly(
  state: CanonicalCodexSessionState,
  event: CodexEventEnvelope,
  kind: CodexEventAnomalyKind,
): void {
  state.anomalies.push({
    kind,
    eventId: event.eventId,
    sequence: event.sequence,
    method: event.method,
    ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
  });
}

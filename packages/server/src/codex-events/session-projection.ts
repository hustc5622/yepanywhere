import { createHash } from "node:crypto";
import {
  type GeneratedArtifactManifest,
  isGeneratedArtifactDownloadUrl,
} from "@yep-anywhere/shared";
import type { Message } from "../supervisor/types.js";
import type { CodexProjectionCache } from "./projection-cache.js";
import { reduceCodexEvents } from "./reducer.js";
import {
  type CanonicalCodexItemState,
  type CanonicalCodexSessionState,
  type CodexEventEnvelope,
  type SafeJsonObject,
  type SafeJsonValue,
  createCanonicalCodexSessionState,
} from "./types.js";

const DEFAULT_MAX_REFRESH_EVENTS = 100_000;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_NATIVE_TYPE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

export interface CanonicalCodexSessionOverlayOptions {
  /** Do not replay old synthetic rows into an incremental legacy response. */
  appendUnmatched?: boolean;
  /** A canonical cursor can still advance even when the rollout reader cannot see it. */
  afterMessageId?: string;
  maxEvents?: number;
  /** Registry-validated, path-free manifests from the selected journal only. */
  generatedArtifacts?: readonly GeneratedArtifactManifest[];
  /** Testable expiry boundary for supplied manifests. */
  nowMs?: number;
  /** Source id for projection cache keying. Required when projectionCache is used. */
  sourceId?: string;
  /** Optional process-level cache for incremental projection replay. */
  projectionCache?: CodexProjectionCache;
  /** Wall-clock start of the request; used with budgetMs for deadline checks. */
  startedMs?: number;
  /** Soft budget in milliseconds. When exceeded, overlay throws BudgetExceededError so the route can fall back to legacy. */
  budgetMs?: number;
  /**
   * Build at least this many of the most recently touched canonical
   * candidates. The full projection state is still replayed (or loaded from
   * cache), but old candidates are discarded before expensive Message
   * construction.
   */
  maxCandidateCount?: number;
}

export interface CanonicalCodexSessionOverlayResult {
  messages: Message[];
  eventCount: number;
  projectedMessageCount: number;
  /** True when the overlay completed within the budget. */
  budgetExceeded: boolean;
}

/** Thrown when the overlay exceeds its soft time budget, enabling legacy fallback. */
export class CodexOverlayBudgetExceededError extends Error {
  readonly eventCount: number;
  constructor(eventCount: number) {
    super("Canonical Codex overlay exceeded its time budget");
    this.name = "CodexOverlayBudgetExceededError";
    this.eventCount = eventCount;
  }
}

interface CanonicalMessageCandidate {
  message: Message;
  sequence: number;
  occurredAtMs: number;
  kind: "item" | "unknown" | "retry" | "interaction";
  originalItemId?: string;
  nativeType?: string;
}

/**
 * Overlay durable canonical facts onto legacy rollout normalization.
 *
 * Existing rollout messages remain the compatibility baseline. When a
 * canonical item identifies the same visible row, this adds the exact native
 * ThreadItem extension to that row; otherwise a synthetic native row is
 * inserted by event time. This keeps one visible item instead of rendering a
 * generic rollout row beside its typed canonical equivalent.
 */
export function overlayCanonicalCodexSessionMessages(
  sessionId: string,
  legacyMessages: readonly Message[],
  events: readonly CodexEventEnvelope[],
  options: CanonicalCodexSessionOverlayOptions = {},
): CanonicalCodexSessionOverlayResult {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_REFRESH_EVENTS;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError("Canonical Codex refresh maxEvents must be positive");
  }
  if (events.length > maxEvents) {
    throw new RangeError("Canonical Codex refresh event limit exceeded");
  }
  if (
    options.maxCandidateCount !== undefined &&
    (!Number.isSafeInteger(options.maxCandidateCount) ||
      options.maxCandidateCount < 1)
  ) {
    throw new RangeError(
      "Canonical Codex refresh maxCandidateCount must be positive",
    );
  }
  if (events.length === 0) {
    return {
      messages: [...legacyMessages],
      eventCount: 0,
      projectedMessageCount: 0,
      budgetExceeded: false,
    };
  }
  if (events.some((event) => event.sessionId !== sessionId)) {
    throw new Error("Canonical Codex refresh cannot mix session journals");
  }

  const budgetMs = options.budgetMs;
  const startedMs = options.startedMs;
  const checkBudget = (): void => {
    if (budgetMs === undefined || startedMs === undefined) {
      return;
    }
    if (Date.now() - startedMs >= budgetMs) {
      throw new CodexOverlayBudgetExceededError(events.length);
    }
  };

  checkBudget();
  const sortedEvents = [...events].sort(compareEvents);
  checkBudget();
  const projection =
    options.projectionCache && options.sourceId
      ? options.projectionCache.apply(options.sourceId, sessionId, sortedEvents)
      : reduceCodexEvents(
          createCanonicalCodexSessionState(sessionId),
          sortedEvents,
        );
  checkBudget();
  const candidates = buildCanonicalMessageCandidates(
    projection,
    sortedEvents,
    options.generatedArtifacts ?? [],
    options.nowMs ?? Date.now(),
    options.maxCandidateCount,
    checkBudget,
  );
  checkBudget();
  const messages = [...legacyMessages];
  const canonicalCursorIndex = options.afterMessageId
    ? candidates.findIndex(
        (candidate) => candidate.message.uuid === options.afterMessageId,
      )
    : -1;
  const appendUnmatched =
    options.appendUnmatched !== false || canonicalCursorIndex >= 0;

  // Pre-build a legacy itemId -> index index so findLegacyItemMatch's first
  // pass (identity match) is O(1) average instead of O(M) per candidate.
  const legacyItemIdIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    for (const itemId of extractLegacyItemIds(message)) {
      if (!legacyItemIdIndex.has(itemId)) {
        legacyItemIdIndex.set(itemId, i);
      }
    }
  }

  // Resolve and attach every legacy match before inserting synthetic rows.
  // This keeps the pre-built indexes stable: timestamp insertion changes array
  // positions and must not be allowed to retarget a later canonical item.
  const claimedLegacyIndexes = new Set<number>();
  const matchedCandidateIndexes = new Set<number>();
  for (let index = 0; index < candidates.length; index += 1) {
    if ((index & 0xff) === 0) checkBudget();
    const candidate = candidates[index];
    if (!candidate || candidate.kind !== "item") continue;
    const matchedIndex = findLegacyItemMatch(
      messages,
      candidate,
      claimedLegacyIndexes,
      legacyItemIdIndex,
    );
    if (matchedIndex >= 0) {
      const current = messages[matchedIndex];
      if (current) {
        messages[matchedIndex] = attachCanonicalItem(current, candidate);
        claimedLegacyIndexes.add(matchedIndex);
        matchedCandidateIndexes.add(index);
      }
    }
  }

  // Pre-build semantic duplicate indexes to avoid repeated O(M) scans inside
  // the candidate loop. These mirror hasSemanticDuplicate's per-kind checks
  // but use Sets so each candidate lookup is O(1) average.
  const existingMessageUuids = new Set<string | undefined>(
    messages.map((message) => message.uuid),
  );
  const existingUnknownContents = new Set<string>();
  const existingRetrySequences = new Set<number>();
  const existingInteractionKeys = new Set<string>();
  for (const message of messages) {
    if (message.warningKind === "unknown_codex_notification") {
      existingUnknownContents.add(
        typeof message.content === "string" ? message.content : "",
      );
    } else if (message.warningKind === "codex_app_server_overloaded") {
      if (typeof message.codexEventSequence === "number") {
        existingRetrySequences.add(message.codexEventSequence);
      }
    } else if (message.warningKind === "codex_interaction") {
      const interaction = asUnknownObject(message.codexInteraction);
      const method = readUnknownString(interaction, "method");
      const seq = interaction?.sequence;
      if (
        method !== undefined &&
        typeof seq === "number" &&
        seq !== undefined
      ) {
        existingInteractionKeys.add(`${method}:${seq}`);
      }
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    if ((index & 0xff) === 0) checkBudget();
    const candidate = candidates[index];
    if (!candidate) continue;

    if (matchedCandidateIndexes.has(index)) continue;
    if (
      candidate.kind !== "item" &&
      hasSemanticDuplicateFast(
        candidate.message,
        existingMessageUuids,
        existingUnknownContents,
        existingRetrySequences,
        existingInteractionKeys,
      )
    ) {
      continue;
    }

    if (
      appendUnmatched &&
      (canonicalCursorIndex < 0 || index > canonicalCursorIndex)
    ) {
      insertByTimestamp(messages, candidate.message, candidate.occurredAtMs);
      existingMessageUuids.add(candidate.message.uuid);
      if (candidate.message.warningKind === "unknown_codex_notification") {
        existingUnknownContents.add(
          typeof candidate.message.content === "string"
            ? candidate.message.content
            : "",
        );
      } else if (
        candidate.message.warningKind === "codex_app_server_overloaded"
      ) {
        if (typeof candidate.message.codexEventSequence === "number") {
          existingRetrySequences.add(candidate.message.codexEventSequence);
        }
      } else if (candidate.message.warningKind === "codex_interaction") {
        const interaction = asUnknownObject(candidate.message.codexInteraction);
        const method = readUnknownString(interaction, "method");
        const seq = interaction?.sequence;
        if (
          method !== undefined &&
          typeof seq === "number" &&
          seq !== undefined
        ) {
          existingInteractionKeys.add(`${method}:${seq}`);
        }
      }
    }
  }
  checkBudget();

  return {
    messages,
    eventCount: sortedEvents.length,
    projectedMessageCount: candidates.length,
    budgetExceeded: false,
  };
}

function buildCanonicalMessageCandidates(
  projection: CanonicalCodexSessionState,
  events: readonly CodexEventEnvelope[],
  generatedArtifacts: readonly GeneratedArtifactManifest[],
  nowMs: number,
  maxCandidateCount?: number,
  checkBudget?: () => void,
): CanonicalMessageCandidate[] {
  const eventBySequence = new Map(
    events.map((event) => [event.sequence, event] as const),
  );
  const artifactsBySource = indexReplayableGeneratedArtifacts(
    generatedArtifacts,
    nowMs,
  );
  const candidates: CanonicalMessageCandidate[] = [];

  const minCandidateSequence = deriveCandidateWindowStart(
    projection,
    events,
    maxCandidateCount,
    checkBudget,
  );
  const withinWindow = (sequence: number): boolean =>
    minCandidateSequence === undefined || sequence >= minCandidateSequence;
  let visited = 0;
  const checkBudgetPeriodically = (): void => {
    visited += 1;
    if ((visited & 0xff) === 0) checkBudget?.();
  };

  for (const threadId of projection.threadOrder) {
    const thread = projection.threads[threadId];
    if (!thread) continue;
    for (const turnId of thread.turnOrder) {
      const turn = thread.turns[turnId];
      if (!turn) continue;
      for (const itemId of turn.itemOrder) {
        checkBudgetPeriodically();
        const item = turn.items[itemId];
        if (!item) continue;
        const sequence =
          item.completedSequence ??
          item.startedSequence ??
          item.lastSequence ??
          item.firstSequence;
        if (!withinWindow(item.lastSequence)) continue;
        const event = eventBySequence.get(sequence);
        const occurredAtMs = eventTime(event);
        const safeItem = projectSafeThreadItem(item);
        const itemArtifacts =
          artifactsBySource.get(
            generatedArtifactSourceKey(thread.id, turn.id, item.id),
          ) ?? [];
        candidates.push({
          kind: "item",
          sequence,
          occurredAtMs,
          originalItemId: item.id,
          nativeType: item.nativeType,
          message: {
            uuid: canonicalMessageId(
              "item",
              `${thread.id}:${turn.id}:${item.id}`,
            ),
            type: "system",
            subtype: "codex_native_item",
            ...(occurredAtMs > 0
              ? { timestamp: new Date(occurredAtMs).toISOString() }
              : {}),
            codexThreadItem: safeItem,
            codexThreadItemLifecycle:
              item.status === "completed" ? "completed" : "started",
            codexThreadId: safeIdentity(thread.id, "thread"),
            codexTurnId: safeIdentity(turn.id, "turn"),
            codexEventSequence: sequence,
            codexRawReasoningAllowed: false,
            codexCanonicalRefresh: true,
            ...(itemArtifacts.length > 0
              ? {
                  codexGeneratedArtifacts: itemArtifacts.map((artifact) =>
                    structuredClone(artifact),
                  ),
                }
              : {}),
            _source: "jsonl",
          },
        });
      }
    }
  }

  for (const unknown of projection.unknownEvents) {
    checkBudgetPeriodically();
    if (!withinWindow(unknown.sequence)) continue;
    const event = eventBySequence.get(unknown.sequence);
    const occurredAtMs = eventTime(event);
    const method = safeMethod(unknown.method);
    const content = `Codex sent a newer event (${method}); Yep preserved it but this version cannot display its details yet.`;
    candidates.push({
      kind: "unknown",
      sequence: unknown.sequence,
      occurredAtMs,
      message: {
        uuid: canonicalMessageId("unknown", unknown.eventId),
        type: "system",
        subtype: "warning",
        ...(occurredAtMs > 0
          ? { timestamp: new Date(occurredAtMs).toISOString() }
          : {}),
        content,
        warning: content,
        warningKind: "unknown_codex_notification",
        codexEventMethod: method,
        codexEventSequence: unknown.sequence,
        codexCanonicalRefresh: true,
        _source: "jsonl",
      },
    });
  }

  for (const retry of projection.clientRetries) {
    checkBudgetPeriodically();
    if (!withinWindow(retry.sequence)) continue;
    const event = eventBySequence.get(retry.sequence);
    const occurredAtMs = eventTime(event);
    const content =
      retry.state === "queued"
        ? `Codex is busy. The request is queued for bounded attempt ${retry.nextAttempt}/${retry.maxAttempts}.`
        : `Codex is busy. Retrying with bounded attempt ${retry.nextAttempt}/${retry.maxAttempts}.`;
    candidates.push({
      kind: "retry",
      sequence: retry.sequence,
      occurredAtMs,
      message: {
        uuid: canonicalMessageId(
          "retry",
          `${String(retry.requestId)}:${retry.attempt}:${retry.state}`,
        ),
        type: "system",
        subtype: "warning",
        ...(occurredAtMs > 0
          ? { timestamp: new Date(occurredAtMs).toISOString() }
          : {}),
        content,
        warning: content,
        warningKind: "codex_app_server_overloaded",
        willRetry: true,
        codexRetryStatus: {
          state: retry.state,
          category: retry.category,
          retryable: retry.retryable,
          attempt: retry.attempt,
          nextAttempt: retry.nextAttempt,
          maxAttempts: retry.maxAttempts,
          retryInMs: retry.retryInMs,
        },
        codexEventSequence: retry.sequence,
        codexCanonicalRefresh: true,
        _source: "jsonl",
      },
    });
  }

  candidates.push(
    ...buildInteractionCandidates(events, minCandidateSequence, checkBudget),
  );
  checkBudget?.();
  return candidates.sort(compareCandidates);
}

function deriveCandidateWindowStart(
  projection: CanonicalCodexSessionState,
  events: readonly CodexEventEnvelope[],
  maxCandidateCount: number | undefined,
  checkBudget?: () => void,
): number | undefined {
  if (maxCandidateCount === undefined) return undefined;

  const touchSequences: number[] = [];
  let visited = 0;
  for (const threadId of projection.threadOrder) {
    const thread = projection.threads[threadId];
    if (!thread) continue;
    for (const turnId of thread.turnOrder) {
      const turn = thread.turns[turnId];
      if (!turn) continue;
      for (const itemId of turn.itemOrder) {
        const item = turn.items[itemId];
        if (item) touchSequences.push(item.lastSequence);
        visited += 1;
        if ((visited & 0xff) === 0) checkBudget?.();
      }
    }
  }
  touchSequences.push(
    ...projection.unknownEvents.map((event) => event.sequence),
    ...projection.clientRetries.map((retry) => retry.sequence),
  );

  const responsesByCorrelation = new Map<string, number>();
  const resolutionsByRequest = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    if ((index & 0xff) === 0) checkBudget?.();
    const event = events[index];
    if (!event) continue;
    if (event.direction === "client_response" && event.phase === "resolved") {
      responsesByCorrelation.set(event.correlationId, event.sequence);
    }
    if (
      event.method === "serverRequest/resolved" &&
      event.requestId !== undefined
    ) {
      resolutionsByRequest.set(String(event.requestId), event.sequence);
    }
  }
  for (let index = 0; index < events.length; index += 1) {
    if ((index & 0xff) === 0) checkBudget?.();
    const request = events[index];
    if (!request) continue;
    if (request.direction !== "server_request") continue;
    const resolvedSequence =
      responsesByCorrelation.get(request.correlationId) ??
      (request.requestId === undefined
        ? undefined
        : resolutionsByRequest.get(String(request.requestId)));
    touchSequences.push(
      Math.max(request.sequence, resolvedSequence ?? request.sequence),
    );
  }

  if (touchSequences.length <= maxCandidateCount) return undefined;
  touchSequences.sort((left, right) => left - right);
  return touchSequences[touchSequences.length - maxCandidateCount];
}

function buildInteractionCandidates(
  events: readonly CodexEventEnvelope[],
  minCandidateSequence?: number,
  checkBudget?: () => void,
): CanonicalMessageCandidate[] {
  const responsesByCorrelation = new Map<string, CodexEventEnvelope>();
  const resolutionsByRequest = new Map<string, CodexEventEnvelope>();
  for (let index = 0; index < events.length; index += 1) {
    if ((index & 0xff) === 0) checkBudget?.();
    const event = events[index];
    if (!event) continue;
    if (event.direction === "client_response" && event.phase === "resolved") {
      responsesByCorrelation.set(event.correlationId, event);
    }
    if (
      event.method === "serverRequest/resolved" &&
      event.requestId !== undefined
    ) {
      resolutionsByRequest.set(String(event.requestId), event);
    }
  }

  const candidates: CanonicalMessageCandidate[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if ((index & 0xff) === 0) checkBudget?.();
    const request = events[index];
    if (!request) continue;
    if (request.direction !== "server_request") continue;
    const response =
      responsesByCorrelation.get(request.correlationId) ??
      (request.requestId === undefined
        ? undefined
        : resolutionsByRequest.get(String(request.requestId)));
    if (
      minCandidateSequence !== undefined &&
      Math.max(request.sequence, response?.sequence ?? request.sequence) <
        minCandidateSequence
    ) {
      continue;
    }
    const status = response
      ? payloadHasError(response.payload.data)
        ? "failed"
        : "resolved"
      : "open";
    const method = safeMethod(request.method);
    const content = interactionContent(method, status);
    const occurredAtMs = eventTime(request);
    candidates.push({
      kind: "interaction",
      sequence: request.sequence,
      occurredAtMs,
      message: {
        uuid: canonicalMessageId("interaction", request.eventId),
        type: "system",
        subtype: "warning",
        ...(occurredAtMs > 0
          ? { timestamp: new Date(occurredAtMs).toISOString() }
          : {}),
        content,
        warning: content,
        warningKind: "codex_interaction",
        codexInteraction: {
          method,
          status,
          ...(request.requestId === undefined
            ? {}
            : {
                requestId: safeIdentity(String(request.requestId), "request"),
              }),
          ...(request.threadId === undefined
            ? {}
            : { threadId: safeIdentity(request.threadId, "thread") }),
          ...(request.turnId === undefined
            ? {}
            : { turnId: safeIdentity(request.turnId, "turn") }),
          ...(request.itemId === undefined
            ? {}
            : { itemId: safeIdentity(request.itemId, "item") }),
          sequence: request.sequence,
          ...(response === undefined
            ? {}
            : { resolvedSequence: response.sequence }),
        },
        codexEventSequence: request.sequence,
        codexCanonicalRefresh: true,
        _source: "jsonl",
      },
    });
  }
  return candidates;
}

function projectSafeThreadItem(
  item: CanonicalCodexItemState,
): Record<string, unknown> {
  const snapshot = asObject(item.snapshot);
  const nativeType = SAFE_NATIVE_TYPE.test(item.nativeType)
    ? item.nativeType
    : "unknown";
  const base: Record<string, unknown> = {
    type: nativeType,
    id: safeIdentity(item.id, "item"),
  };
  const status = readString(snapshot, "status");
  if (status) base.status = status;

  switch (nativeType) {
    case "userMessage":
      base.content = safeUserInputs(snapshot?.content);
      break;
    case "hookPrompt":
      base.fragments = safeHookFragments(snapshot?.fragments);
      break;
    case "agentMessage":
      base.text = projectedStreamText(
        item,
        readString(snapshot, "text"),
        item.stream.assistantText,
      );
      copyString(snapshot, base, "phase");
      break;
    case "plan":
      base.text = projectedStreamText(
        item,
        readString(snapshot, "text"),
        item.stream.planText,
      );
      break;
    case "reasoning":
      base.summary =
        item.status === "completed"
          ? (stringArray(snapshot?.summary) ??
            item.stream.reasoningSummary ??
            [])
          : (item.stream.reasoningSummary ??
            stringArray(snapshot?.summary) ??
            []);
      // Raw reasoning is deliberately absent even if an older journal retained it.
      base.content = [];
      break;
    case "commandExecution":
      base.command = "[command hidden in persisted refresh]";
      copyString(snapshot, base, "source");
      copyString(snapshot, base, "pluginId");
      copyNumber(snapshot, base, "exitCode");
      copyNumber(snapshot, base, "durationMs");
      break;
    case "fileChange":
      base.changes = safeFileChanges(
        snapshot?.changes ?? item.stream.patchChanges,
      );
      break;
    case "mcpToolCall":
      copyString(snapshot, base, "server");
      copyString(snapshot, base, "tool");
      copyString(snapshot, base, "pluginId");
      copyBoolean(snapshot, base, "readOnlyHint");
      copyNumber(snapshot, base, "durationMs");
      break;
    case "dynamicToolCall":
      copyString(snapshot, base, "namespace");
      copyString(snapshot, base, "tool");
      copyBoolean(snapshot, base, "success");
      copyNumber(snapshot, base, "durationMs");
      break;
    case "collabAgentToolCall":
      copyString(snapshot, base, "tool");
      copyString(snapshot, base, "model");
      copyString(snapshot, base, "reasoningEffort");
      base.senderThreadId = safeOptionalIdentity(
        readString(snapshot, "senderThreadId"),
        "thread",
      );
      base.receiverThreadIds = safeIdentityArray(
        snapshot?.receiverThreadIds,
        "thread",
      );
      base.agentsStates = safeAgentStates(snapshot?.agentsStates);
      break;
    case "subAgentActivity":
      copyString(snapshot, base, "kind");
      base.agentThreadId = safeOptionalIdentity(
        readString(snapshot, "agentThreadId"),
        "thread",
      );
      break;
    case "webSearch":
      copyString(snapshot, base, "query");
      base.action = safeWebAction(snapshot?.action);
      if (Array.isArray(snapshot?.results)) {
        base.results = snapshot.results.map(() => null);
      }
      break;
    case "imageView":
      // Never project the local path from a durable journal into the REST view.
      break;
    case "sleep":
      copyNumber(snapshot, base, "durationMs");
      break;
    case "imageGeneration":
      copyBoolean(snapshot, base, "transparentBackground");
      break;
    case "enteredReviewMode":
    case "exitedReviewMode":
      copyString(snapshot, base, "review");
      break;
    case "contextCompaction":
      break;
    default:
      // Unknown native types intentionally expose type + opaque id only.
      break;
  }
  return removeUndefined(base);
}

function projectedStreamText(
  item: CanonicalCodexItemState,
  snapshotText: string | undefined,
  streamText: string | undefined,
): string {
  return item.status === "completed"
    ? (snapshotText ?? streamText ?? "")
    : (streamText ?? snapshotText ?? "");
}

function safeUserInputs(value: SafeJsonValue | undefined): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const input = asObject(entry);
    const type = readString(input, "type");
    switch (type) {
      case "text":
        return [{ type, text: readString(input, "text") ?? "" }];
      case "skill":
      case "mention":
        return [{ type, name: readString(input, "name") ?? "" }];
      case "image":
      case "localImage":
      case "audio":
      case "localAudio":
        return [{ type }];
      default:
        return [{ type: "unknown" }];
    }
  });
}

function safeHookFragments(value: SafeJsonValue | undefined): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const fragment = asObject(entry);
    const text = readString(fragment, "text");
    if (!text) return [];
    const hookRunId = readString(fragment, "hookRunId");
    return [{ text, ...(hookRunId ? { hookRunId } : {}) }];
  });
}

function safeFileChanges(value: SafeJsonValue | undefined): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const change = asObject(entry);
    if (!change) return [];
    const kind = readString(change, "kind");
    return [{ path: "[path hidden]", ...(kind ? { kind } : {}) }];
  });
}

function safeWebAction(value: SafeJsonValue | undefined): unknown {
  const action = asObject(value);
  const type = readString(action, "type");
  return type ? { type } : null;
}

function safeAgentStates(value: SafeJsonValue | undefined): unknown {
  const states = asObject(value);
  if (!states) return {};
  const safe: Record<string, { status: string }> = {};
  for (const [threadId, stateValue] of Object.entries(states)) {
    const status = readString(asObject(stateValue), "status");
    if (status) safe[safeIdentity(threadId, "thread")] = { status };
  }
  return safe;
}

/**
 * Extract all ThreadItem identity strings from a legacy message so the overlay
 * can pre-build an itemId -> index index. Mirrors messageHasItemIdentity's
 * checks.
 */
function extractLegacyItemIds(message: Message): string[] {
  const ids: string[] = [];
  const nativeItem = asUnknownObject(message.codexThreadItem);
  const nativeId = readUnknownString(nativeItem, "id");
  if (nativeId) ids.push(nativeId);
  if (typeof message.itemId === "string") ids.push(message.itemId);
  if (typeof message.callId === "string") ids.push(message.callId);
  const toolUse = asUnknownObject(message.toolUse);
  const toolUseId = readUnknownString(toolUse, "id");
  if (toolUseId) ids.push(toolUseId);
  const content = message.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block?.id === "string") ids.push(block.id);
      if (typeof block?.tool_use_id === "string") ids.push(block.tool_use_id);
    }
  }
  return ids;
}

function findLegacyItemMatch(
  messages: readonly Message[],
  candidate: CanonicalMessageCandidate,
  claimed: ReadonlySet<number>,
  legacyItemIdIndex: ReadonlyMap<string, number>,
): number {
  const itemId = candidate.originalItemId;
  if (!itemId) return -1;

  // Fast path: use the pre-built itemId index to find the first unclaimed
  // legacy message with this item identity.
  const indexed = legacyItemIdIndex.get(itemId);
  const indexedMessage = indexed === undefined ? undefined : messages[indexed];
  if (
    indexed !== undefined &&
    indexedMessage !== undefined &&
    !claimed.has(indexed) &&
    messageHasItemIdentity(indexedMessage, itemId)
  ) {
    return indexed;
  }
  // Fall back to linear scan for claimed-index collisions or items not in
  // the index (e.g. when identity was added after the initial build).
  for (let index = 0; index < messages.length; index += 1) {
    if (claimed.has(index)) continue;
    const message = messages[index];
    if (message && messageHasItemIdentity(message, itemId)) return index;
  }

  const projected = asUnknownObject(candidate.message.codexThreadItem);
  const nativeType = candidate.nativeType;
  for (let index = 0; index < messages.length; index += 1) {
    if (claimed.has(index)) continue;
    const message = messages[index];
    if (!message) continue;
    if (nativeType === "agentMessage" && message.type === "assistant") {
      if (messageText(message) === readUnknownString(projected, "text")) {
        return index;
      }
    }
    if (nativeType === "userMessage" && message.type === "user") {
      if (messageText(message) === userInputText(projected?.content)) {
        return index;
      }
    }
    if (nativeType === "reasoning") {
      const summary = unknownStringArray(projected?.summary).join("\n");
      if (summary && messageThinking(message) === summary) return index;
    }
  }
  return -1;
}

function messageHasItemIdentity(message: Message, itemId: string): boolean {
  const nativeItem = asUnknownObject(message.codexThreadItem);
  if (readUnknownString(nativeItem, "id") === itemId) return true;
  if (message.itemId === itemId || message.callId === itemId) return true;
  if (asUnknownObject(message.toolUse)?.id === itemId) return true;

  const content = message.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => block.id === itemId || block.tool_use_id === itemId,
  );
}

function attachCanonicalItem(
  message: Message,
  candidate: CanonicalMessageCandidate,
): Message {
  return {
    ...message,
    codexThreadItem: structuredClone(candidate.message.codexThreadItem),
    codexThreadItemLifecycle: candidate.message.codexThreadItemLifecycle,
    codexThreadId: candidate.message.codexThreadId,
    codexTurnId: candidate.message.codexTurnId,
    codexEventSequence: candidate.sequence,
    codexRawReasoningAllowed: false,
    codexCanonicalRefresh: true,
    ...(candidate.message.codexGeneratedArtifacts === undefined
      ? {}
      : {
          codexGeneratedArtifacts: structuredClone(
            candidate.message.codexGeneratedArtifacts,
          ),
        }),
  };
}

function indexReplayableGeneratedArtifacts(
  artifacts: readonly GeneratedArtifactManifest[],
  nowMs: number,
): Map<string, GeneratedArtifactManifest[]> {
  if (!Number.isSafeInteger(nowMs)) return new Map();
  const bySource = new Map<string, GeneratedArtifactManifest[]>();
  const seenIds = new Set<string>();
  for (const artifact of artifacts) {
    if (!isSafeReplayableGeneratedArtifact(artifact, nowMs)) continue;
    if (seenIds.has(artifact.id)) continue;
    seenIds.add(artifact.id);
    const key = generatedArtifactSourceKey(
      artifact.source.threadId,
      artifact.source.turnId,
      artifact.source.itemId,
    );
    const current = bySource.get(key) ?? [];
    current.push(structuredClone(artifact));
    bySource.set(key, current);
  }
  return bySource;
}

function isSafeReplayableGeneratedArtifact(
  artifact: GeneratedArtifactManifest,
  nowMs: number,
): boolean {
  const expiresAtMs = Date.parse(artifact.retention?.expiresAt ?? "");
  return (
    artifact.schemaVersion === 1 &&
    /^ga_[a-f0-9]{32}$/.test(artifact.id) &&
    /^upload:[a-f0-9-]{36}$/.test(artifact.managedRef) &&
    isSafeGeneratedArtifactFileName(artifact.fileName) &&
    isSafeGeneratedArtifactKind(artifact.kind) &&
    /^[A-Za-z0-9][A-Za-z0-9.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,126}$/.test(
      artifact.mimeType,
    ) &&
    Number.isSafeInteger(artifact.sizeBytes) &&
    artifact.sizeBytes > 0 &&
    artifact.sizeBytes <= 30 * 1024 * 1024 &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.sha256) &&
    artifact.source?.provider === "codex" &&
    (artifact.source.type === "image_generation" ||
      artifact.source.type === "file_change") &&
    SAFE_IDENTITY.test(artifact.source.threadId) &&
    SAFE_IDENTITY.test(artifact.source.turnId) &&
    SAFE_IDENTITY.test(artifact.source.itemId) &&
    artifact.retention?.policy === "temporary" &&
    Number.isSafeInteger(expiresAtMs) &&
    expiresAtMs > nowMs &&
    isGeneratedArtifactDownloadUrl(artifact.downloadUrl) &&
    (artifact.previewUrl === undefined ||
      (artifact.kind === "image" &&
        artifact.previewUrl === artifact.downloadUrl))
  );
}

function isSafeGeneratedArtifactKind(
  value: GeneratedArtifactManifest["kind"],
): boolean {
  return (
    value === "image" ||
    value === "document" ||
    value === "spreadsheet" ||
    value === "presentation" ||
    value === "text" ||
    value === "video"
  );
}

function isSafeGeneratedArtifactFileName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 120 ||
    value === "." ||
    value === ".." ||
    value.includes("..")
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      character === "/" ||
      character === "\\"
    ) {
      return false;
    }
  }
  return true;
}

function generatedArtifactSourceKey(
  threadId: string,
  turnId: string,
  itemId: string,
): string {
  return `${threadId}\0${turnId}\0${itemId}`;
}

function hasSemanticDuplicateFast(
  candidate: Message,
  existingMessageUuids: ReadonlySet<string | undefined>,
  existingUnknownContents: ReadonlySet<string>,
  existingRetrySequences: ReadonlySet<number>,
  existingInteractionKeys: ReadonlySet<string>,
): boolean {
  if (existingMessageUuids.has(candidate.uuid)) return true;
  if (candidate.warningKind === "unknown_codex_notification") {
    return existingUnknownContents.has(
      typeof candidate.content === "string" ? candidate.content : "",
    );
  }
  if (candidate.warningKind === "codex_app_server_overloaded") {
    return typeof candidate.codexEventSequence === "number"
      ? existingRetrySequences.has(candidate.codexEventSequence)
      : false;
  }
  if (candidate.warningKind === "codex_interaction") {
    const interaction = asUnknownObject(candidate.codexInteraction);
    const method = readUnknownString(interaction, "method");
    const seq = interaction?.sequence;
    if (method === undefined || typeof seq !== "number" || seq === undefined)
      return false;
    return existingInteractionKeys.has(`${method}:${seq}`);
  }
  return false;
}

function insertByTimestamp(
  messages: Message[],
  message: Message,
  occurredAtMs: number,
): void {
  if (occurredAtMs <= 0) {
    messages.push(message);
    return;
  }
  // Fast path: candidates are typically pre-sorted by sequence (which
  // correlates with event time), so the common case is that the new message
  // belongs at or after the tail. Check the last element first to avoid a
  // full linear scan on every insertion.
  const last = messages[messages.length - 1];
  if (last) {
    const lastTimestamp = Date.parse(last.timestamp ?? "");
    if (!Number.isFinite(lastTimestamp) || lastTimestamp <= occurredAtMs) {
      messages.push(message);
      return;
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const timestamp = Date.parse(messages[index]?.timestamp ?? "");
    if (Number.isFinite(timestamp) && timestamp > occurredAtMs) {
      messages.splice(index, 0, message);
      return;
    }
  }
  messages.push(message);
}

function interactionContent(
  method: string,
  status: "open" | "resolved" | "failed",
): string {
  const request = method.includes("requestUserInput")
    ? "user input"
    : method.includes("elicitation")
      ? "MCP input"
      : method.includes("Approval") || method.includes("approval")
        ? "approval"
        : "an interaction";
  if (status === "open") return `Codex requested ${request}.`;
  if (status === "failed") return `Codex ${request} request failed.`;
  return `Codex ${request} request was resolved.`;
}

function compareEvents(
  left: CodexEventEnvelope,
  right: CodexEventEnvelope,
): number {
  return (
    left.sequence - right.sequence || left.eventId.localeCompare(right.eventId)
  );
}

function compareCandidates(
  left: CanonicalMessageCandidate,
  right: CanonicalMessageCandidate,
): number {
  return (
    left.sequence - right.sequence ||
    String(left.message.uuid).localeCompare(String(right.message.uuid))
  );
}

function eventTime(event: CodexEventEnvelope | undefined): number {
  if (!event) return 0;
  return (
    event.appServerEmittedAtMs ?? event.receivedAtMs ?? event.persistedAtMs ?? 0
  );
}

function canonicalMessageId(kind: string, identity: string): string {
  return `codex-canonical-${kind}-${digest(identity)}`;
}

function safeMethod(method: string): string {
  return method.slice(0, 160).replace(/[^A-Za-z0-9_./:-]/g, "?");
}

function safeIdentity(value: string, kind: string): string {
  return SAFE_IDENTITY.test(value) ? value : `${kind}-${digest(value)}`;
}

function safeOptionalIdentity(
  value: string | undefined,
  kind: string,
): string | undefined {
  return value === undefined ? undefined : safeIdentity(value, kind);
}

function safeIdentityArray(
  value: SafeJsonValue | undefined,
  kind: string,
): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" ? [safeIdentity(entry, kind)] : [],
      )
    : [];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function asObject(
  value: SafeJsonValue | undefined,
): SafeJsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function asUnknownObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  object: SafeJsonObject | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function readUnknownString(
  object: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: SafeJsonValue | undefined): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function unknownStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function copyString(
  source: SafeJsonObject | undefined,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = readString(source, key);
  if (value !== undefined) target[key] = value;
}

function copyNumber(
  source: SafeJsonObject | undefined,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source?.[key];
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function copyBoolean(
  source: SafeJsonObject | undefined,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source?.[key];
  if (typeof value === "boolean") target[key] = value;
}

function removeUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function payloadHasError(value: SafeJsonValue): boolean {
  const payload = asObject(value);
  return payload?.error !== undefined && payload.error !== null;
}

function messageText(message: Message): string {
  const content = message.message?.content ?? message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function messageThinking(message: Message): string {
  const content = message.message?.content ?? message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        block.type === "thinking" && typeof block.thinking === "string",
    )
    .map((block) => block.thinking)
    .join("\n");
}

function userInputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((entry) => {
      const input = asUnknownObject(entry);
      return input?.type === "text" && typeof input.text === "string"
        ? [input.text]
        : [];
    })
    .join("");
}

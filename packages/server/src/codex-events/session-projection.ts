import { createHash } from "node:crypto";
import {
  type GeneratedArtifactManifest,
  type SessionLastTurnStatus,
  type SessionRetryStatus,
  isGeneratedArtifactDownloadUrl,
} from "@yep-anywhere/shared";
import {
  type CanonicalCodexError,
  classifyCodexError,
  formatCodexRetryWarning,
} from "../codex/error-taxonomy.js";
import {
  type NormalizedCodexFileChange,
  publicCodexFileChanges,
} from "../codex/file-change.js";
import { isLegacyMaskedCodexFilePath } from "../codex/path-projection.js";
import { codexUserMessageIdentity } from "../codex/user-message-identity.js";
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

/**
 * Ceiling on the unwindowed full-history pass.
 *
 * This is a work bound, not a complexity cliff: the overlay is linear in event
 * count (measured 35-47 us/event across 2k..144k events on a production
 * journal, with no knee in the curve). See `assessCanonicalOverlayViability`
 * for which regime it applies to.
 */
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
  /**
   * Wall-clock start of the budgeted work.
   *
   * This must be the moment the overlay's own work begins, not the moment the
   * request began: the journal replay that precedes it is an unavoidable,
   * uninterruptible cold-load cost, and charging it to this budget meant a
   * session was denied its canonical view *because loading the journal was
   * slow*. Measured on a live install, the first canonical request after every
   * restart failed this way, ~17 s after boot, with a 3.4 s cold load against a
   * 2 s budget.
   */
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
  /** Latest native provider turn health reconstructed from the same journal. */
  turnHealth?: {
    lastTurnStatus?: SessionLastTurnStatus;
    lastErrorMessage?: string;
    retryStatus?: SessionRetryStatus;
  };
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

/**
 * Thrown by a caller that pre-checked viability and decided not to overlay.
 *
 * Distinct from the budget error because the two mean opposite things: the
 * budget error says "this was worth trying and ran out of time", this one says
 * "this was known up front to be out of bounds, so nothing was attempted".
 * Conflating them is what made a hard event-limit rejection show up in the logs
 * as `budgetExceeded: false` with no further explanation.
 */
export class CodexOverlayNotViableError extends Error {
  readonly reason: "event_limit";
  readonly eventCount: number;
  readonly maxEvents: number;
  constructor(
    viability: Extract<CanonicalOverlayViability, { viable: false }>,
  ) {
    super(`Canonical Codex overlay not viable: ${viability.reason}`);
    this.name = "CodexOverlayNotViableError";
    this.reason = viability.reason;
    this.eventCount = viability.eventCount;
    this.maxEvents = viability.maxEvents;
  }
}

interface CanonicalMessageCandidate {
  message: Message;
  sequence: number;
  occurredAtMs: number;
  kind: "item" | "unknown" | "retry" | "provider_error" | "interaction";
  originalItemId?: string;
  nativeType?: string;
}

/** Why an overlay cannot run, when it cannot. */
export type CanonicalOverlayViability =
  | { viable: true }
  | {
      viable: false;
      reason: "event_limit";
      eventCount: number;
      maxEvents: number;
    };

/**
 * Whether the overlay may run for a journal of this size.
 *
 * The ceiling exists to bound work, and the work has two very different
 * regimes:
 *
 *   - **Windowed** (`maxCandidateCount` set): candidate construction stops at
 *     the recent tail, so both the candidate build and the legacy matching are
 *     bounded by the window no matter how long the session is. Measured on a
 *     144,029-event session with 10,494 legacy rows: **139 ms** for a
 *     50-message window.
 *   - **Unwindowed** (explicit cursor, branch projection, or no window): every
 *     canonical candidate is built and matched against the legacy rows on every
 *     request. Same session: **6.8 s**, and the projection cache does not help
 *     because it memoizes the reduce, not the matching (warm 6.7 s vs cold
 *     7.0 s).
 *
 * So the ceiling only applies to the unwindowed regime. It used to be checked
 * against total history for both, which permanently disabled the canonical view
 * for long sessions even though the windowed request the client actually makes
 * is two orders of magnitude cheaper and comfortably inside the time budget.
 * The check also ran after the journal replay and after the generated-artifact
 * scan, so a rejected session paid for work that was then thrown away; callers
 * can now consult this before either.
 */
export function assessCanonicalOverlayViability(args: {
  eventCount: number;
  /** Window size when the caller only needs the recent candidate tail. */
  maxCandidateCount?: number;
  maxEvents?: number;
}): CanonicalOverlayViability {
  const maxEvents = args.maxEvents ?? DEFAULT_MAX_REFRESH_EVENTS;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError("Canonical Codex refresh maxEvents must be positive");
  }
  if (args.maxCandidateCount !== undefined) {
    return { viable: true };
  }
  if (args.eventCount > maxEvents) {
    return {
      viable: false,
      reason: "event_limit",
      eventCount: args.eventCount,
      maxEvents,
    };
  }
  return { viable: true };
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
  if (
    options.maxCandidateCount !== undefined &&
    (!Number.isSafeInteger(options.maxCandidateCount) ||
      options.maxCandidateCount < 1)
  ) {
    throw new RangeError(
      "Canonical Codex refresh maxCandidateCount must be positive",
    );
  }
  // Same predicate the route consults before replaying, so a caller that skips
  // the pre-check still gets identical behaviour.
  const viability = assessCanonicalOverlayViability({
    eventCount: events.length,
    maxEvents,
    ...(options.maxCandidateCount === undefined
      ? {}
      : { maxCandidateCount: options.maxCandidateCount }),
  });
  if (!viability.viable) {
    throw new RangeError("Canonical Codex refresh event limit exceeded");
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

  // Pre-build exact native/correlation indexes so live, rollout and canonical
  // rows meet by provider identity before any legacy content compatibility.
  const legacyItemIdIndex = new Map<string, number>();
  const legacyCorrelationKeyIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    if (
      typeof message.codexCorrelationKey === "string" &&
      !legacyCorrelationKeyIndex.has(message.codexCorrelationKey)
    ) {
      legacyCorrelationKeyIndex.set(message.codexCorrelationKey, i);
    }
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
      legacyCorrelationKeyIndex,
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
    ...providerTurnHealth(sortedEvents, candidates),
  };
}

/**
 * Merge only durable provider error notifications into a legacy rollout.
 *
 * Unlike the full canonical projection, this path does not reduce native
 * items or load generated artifacts. It is intentionally small enough for
 * the default session GET while still making failures survive a refresh.
 */
export function overlayCodexProviderErrorMessages(
  sessionId: string,
  legacyMessages: readonly Message[],
  events: readonly CodexEventEnvelope[],
  options: { maxEvents?: number } = {},
): CanonicalCodexSessionOverlayResult {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_REFRESH_EVENTS;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError(
      "Codex provider error overlay maxEvents must be positive",
    );
  }
  if (events.length > maxEvents) {
    throw new RangeError("Codex provider error overlay event limit exceeded");
  }
  if (events.some((event) => event.sessionId !== sessionId)) {
    throw new Error("Codex provider error overlay cannot mix session journals");
  }

  const sortedEvents = [...events].sort(compareEvents);
  const candidates = buildProviderErrorCandidates(sortedEvents);
  const messages = [...legacyMessages];
  const existingMessageUuids = new Set(messages.map((message) => message.uuid));
  for (const candidate of candidates) {
    if (existingMessageUuids.has(candidate.message.uuid)) continue;
    insertByTimestamp(messages, candidate.message, candidate.occurredAtMs);
    existingMessageUuids.add(candidate.message.uuid);
  }

  return {
    messages,
    eventCount: sortedEvents.length,
    projectedMessageCount: candidates.length,
    budgetExceeded: false,
    ...providerTurnHealth(sortedEvents, candidates),
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
        const userMessageIdentity =
          item.nativeType === "userMessage"
            ? codexUserMessageIdentity(safeItem.clientId)
            : undefined;
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
            ...(userMessageIdentity ?? {}),
            codexThreadItemLifecycle:
              item.status === "completed" ? "completed" : "started",
            codexThreadId: safeIdentity(thread.id, "thread"),
            codexTurnId: safeIdentity(turn.id, "turn"),
            codexEventSequence: sequence,
            codexRawReasoningAllowed: true,
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

      // Project the turn-level plan checklist (if any) as a dedicated native
      // item so the client can render the step list with per-step status.
      // Codex emits `turn/plan/updated` with `{ explanation?, plan: [{ step,
      // status }] }`; the reducer retains only the latest snapshot per turn, so
      // we emit one candidate per turn at the plan notification's own
      // sequence, even if later turn activity advances `turn.lastSequence`.
      if (turn.plan !== undefined && turn.planSequence !== undefined) {
        const planSeq = turn.planSequence;
        if (withinWindow(planSeq)) {
          const projectedPlan = projectTurnPlanSteps(turn.plan);
          if (projectedPlan.steps.length > 0 || projectedPlan.explanation) {
            const event = eventBySequence.get(planSeq);
            const occurredAtMs = eventTime(event);
            candidates.push({
              kind: "item",
              sequence: planSeq,
              occurredAtMs,
              originalItemId: `codex-plan-${turn.id}`,
              nativeType: "turnPlan",
              message: {
                uuid: canonicalMessageId("plan", `${thread.id}:${turn.id}`),
                type: "system",
                subtype: "codex_native_item",
                ...(occurredAtMs > 0
                  ? { timestamp: new Date(occurredAtMs).toISOString() }
                  : {}),
                codexThreadItem: {
                  type: "turnPlan",
                  id: safeIdentity(turn.id, "turn"),
                  steps: projectedPlan.steps,
                  ...(projectedPlan.explanation
                    ? { explanation: projectedPlan.explanation }
                    : {}),
                },
                codexThreadItemLifecycle: "completed",
                codexThreadId: safeIdentity(thread.id, "thread"),
                codexTurnId: safeIdentity(turn.id, "turn"),
                codexEventSequence: planSeq,
                codexCanonicalRefresh: true,
                _source: "jsonl",
              },
            });
          }
        }
      }
    }

    // Project the latest thread-level goal snapshot (if any) as a dedicated
    // native item so the client can render the current objective, status, and
    // token usage/budget and elapsed time. Goal mutations are
    // always-persisted events in Codex
    // (rollout/src/policy.rs), so a durable journal always carries the latest
    // snapshot. We emit one candidate per thread at the goal's last mutation
    // sequence. Current thread state is not trimmed by the per-item candidate
    // window, otherwise a still-active goal disappears after enough activity.
    if (thread.goal && thread.goalSequence !== undefined) {
      const goalSeq = thread.goalSequence;
      const event = eventBySequence.get(goalSeq);
      const occurredAtMs = thread.goalUpdatedAtMs ?? eventTime(event) ?? 0;
      const goal = thread.goal;
      candidates.push({
        kind: "item",
        sequence: goalSeq,
        occurredAtMs,
        nativeType: "threadGoal",
        message: {
          uuid: canonicalMessageId("goal", thread.id),
          type: "system",
          subtype: "codex_native_item",
          ...(occurredAtMs > 0
            ? { timestamp: new Date(occurredAtMs).toISOString() }
            : {}),
          codexThreadItem: {
            type: "threadGoal",
            id: safeIdentity(thread.id, "thread"),
            objective: goal.objective,
            status: goal.status,
            ...(goal.tokenBudget !== undefined
              ? { tokenBudget: goal.tokenBudget }
              : {}),
            tokensUsed: goal.tokensUsed,
            timeUsedSeconds: goal.timeUsedSeconds,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
          },
          codexThreadItemLifecycle: "completed",
          codexThreadId: safeIdentity(thread.id, "thread"),
          codexEventSequence: goalSeq,
          codexCanonicalRefresh: true,
          _source: "jsonl",
        },
      });
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
    ...buildProviderErrorCandidates(events, minCandidateSequence, checkBudget),
  );

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
      if (turn.planSequence !== undefined) {
        touchSequences.push(turn.planSequence);
      }
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
    ...events.flatMap((event) =>
      isProviderErrorCandidateEvent(event) ? [event.sequence] : [],
    ),
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

  // Deduplicate so a turn whose lastSequence equals its last item's
  // lastSequence (the common case) does not inflate the window calculation.
  const uniqueTouchSequences = [...new Set(touchSequences)];
  if (uniqueTouchSequences.length <= maxCandidateCount) return undefined;
  uniqueTouchSequences.sort((left, right) => left - right);
  return uniqueTouchSequences[uniqueTouchSequences.length - maxCandidateCount];
}

function buildProviderErrorCandidates(
  events: readonly CodexEventEnvelope[],
  minCandidateSequence?: number,
  checkBudget?: () => void,
): CanonicalMessageCandidate[] {
  const candidates: CanonicalMessageCandidate[] = [];
  const retryableErrorsByTurn = new Map<string, CanonicalCodexError>();
  const terminalTurns = new Map<
    string,
    {
      sequence: number;
      codexError: CanonicalCodexError;
      retryExhausted: boolean;
    }
  >();

  for (let index = 0; index < events.length; index += 1) {
    if ((index & 0xff) === 0) checkBudget?.();
    const event = events[index];
    if (!event || event.direction !== "server_notification") continue;

    const payload = asObject(event.payload.data);
    if (event.method === "error") {
      const turnId = event.turnId ?? readString(payload, "turnId");
      const threadId = event.threadId ?? readString(payload, "threadId");
      const turnKey = providerErrorTurnKey(event, threadId, turnId);
      const classified = classifyCodexError(
        payload?.error ?? event.payload.data,
        {
          ...(turnId ? { correlationId: turnId } : {}),
        },
      );
      const willRetry = payload?.willRetry === true;

      if (willRetry) {
        retryableErrorsByTurn.set(turnKey, classified);
        if (
          minCandidateSequence === undefined ||
          event.sequence >= minCandidateSequence
        ) {
          candidates.push(
            providerErrorCandidate(event, classified, {
              willRetry: true,
              threadId,
              turnId,
            }),
          );
        }
        continue;
      }

      const retryCause = retryableErrorsByTurn.get(turnKey);
      const retryExhausted =
        classified.category === "unknown" && retryCause !== undefined;
      const effectiveError = retryExhausted ? retryCause : classified;
      retryableErrorsByTurn.delete(turnKey);
      terminalTurns.set(turnKey, {
        sequence: event.sequence,
        codexError: effectiveError,
        retryExhausted,
      });
      if (
        minCandidateSequence === undefined ||
        event.sequence >= minCandidateSequence
      ) {
        candidates.push(
          providerErrorCandidate(event, effectiveError, {
            willRetry: false,
            retryExhausted,
            threadId,
            turnId,
          }),
        );
      }
      continue;
    }

    if (event.method !== "turn/completed") continue;
    const turn = asObject(payload?.turn);
    if (readString(turn, "status") !== "failed") continue;
    const turnId = event.turnId ?? readString(turn, "id");
    const threadId = event.threadId ?? readString(payload, "threadId");
    const turnKey = providerErrorTurnKey(event, threadId, turnId);
    const priorTerminal = terminalTurns.get(turnKey);
    if (
      priorTerminal !== undefined &&
      (minCandidateSequence === undefined ||
        priorTerminal.sequence >= minCandidateSequence)
    ) {
      continue;
    }

    const classified = classifyCodexError(turn?.error ?? event.payload.data, {
      ...(turnId ? { correlationId: turnId } : {}),
    });
    const retryCause = retryableErrorsByTurn.get(turnKey);
    const retryExhausted =
      priorTerminal?.retryExhausted ??
      (classified.category === "unknown" && retryCause !== undefined);
    const effectiveError =
      priorTerminal?.codexError ??
      (retryExhausted && retryCause ? retryCause : classified);
    retryableErrorsByTurn.delete(turnKey);
    terminalTurns.set(turnKey, {
      sequence: event.sequence,
      codexError: effectiveError,
      retryExhausted,
    });
    if (
      minCandidateSequence === undefined ||
      event.sequence >= minCandidateSequence
    ) {
      candidates.push(
        providerErrorCandidate(event, effectiveError, {
          willRetry: false,
          retryExhausted,
          threadId,
          turnId,
        }),
      );
    }
  }

  return candidates;
}

function providerErrorCandidate(
  event: CodexEventEnvelope,
  codexError: CanonicalCodexError,
  options: {
    willRetry: boolean;
    retryExhausted?: boolean;
    threadId?: string;
    turnId?: string;
  },
): CanonicalMessageCandidate {
  const occurredAtMs = eventTime(event);
  const shared = {
    uuid: canonicalMessageId("provider-error", event.eventId),
    ...(occurredAtMs > 0
      ? { timestamp: new Date(occurredAtMs).toISOString() }
      : {}),
    codexError,
    willRetry: options.willRetry,
    ...(options.threadId
      ? { threadId: safeIdentity(options.threadId, "thread") }
      : {}),
    ...(options.turnId ? { turnId: safeIdentity(options.turnId, "turn") } : {}),
    codexEventSequence: event.sequence,
    codexCanonicalRefresh: true,
    _source: "jsonl",
  };

  return {
    kind: "provider_error",
    sequence: event.sequence,
    occurredAtMs,
    message: options.willRetry
      ? {
          ...shared,
          type: "system",
          subtype: "warning",
          content: formatCodexRetryWarning(codexError),
          warning: formatCodexRetryWarning(codexError),
          warningKind: "codex_provider_retry",
        }
      : {
          ...shared,
          type: "error",
          error: codexError.publicMessage,
          ...(options.retryExhausted ? { codexRetryExhausted: true } : {}),
        },
  };
}

function providerErrorTurnKey(
  event: CodexEventEnvelope,
  threadId: string | undefined,
  turnId: string | undefined,
): string {
  return turnId ?? threadId ?? event.correlationId;
}

function isProviderErrorCandidateEvent(event: CodexEventEnvelope): boolean {
  if (event.direction !== "server_notification") return false;
  if (event.method === "error") return true;
  if (event.method !== "turn/completed") return false;
  const payload = asObject(event.payload.data);
  return readString(asObject(payload?.turn), "status") === "failed";
}

function providerTurnHealth(
  events: readonly CodexEventEnvelope[],
  candidates: readonly CanonicalMessageCandidate[],
):
  | Pick<CanonicalCodexSessionOverlayResult, "turnHealth">
  | Record<string, never> {
  let lastTerminalSequence = -1;
  let lastTurnStatus: SessionLastTurnStatus | undefined;
  let lastRetrySequence = -1;

  for (const event of events) {
    if (event.direction !== "server_notification") continue;
    const payload = asObject(event.payload.data);
    if (event.method === "error") {
      if (payload?.willRetry === true) {
        lastRetrySequence = Math.max(lastRetrySequence, event.sequence);
      } else if (event.sequence >= lastTerminalSequence) {
        lastTerminalSequence = event.sequence;
        lastTurnStatus = "failed";
      }
      continue;
    }
    if (event.method !== "turn/completed") continue;
    const status = readString(asObject(payload?.turn), "status");
    if (
      (status === "completed" ||
        status === "failed" ||
        status === "interrupted") &&
      event.sequence >= lastTerminalSequence
    ) {
      lastTerminalSequence = event.sequence;
      lastTurnStatus = status;
    }
  }

  const retryCandidate = [...candidates]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === "provider_error" &&
        candidate.message.willRetry === true &&
        candidate.sequence === lastRetrySequence,
    );
  const errorCandidate = [...candidates]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === "provider_error" &&
        candidate.message.type === "error" &&
        candidate.sequence <= lastTerminalSequence,
    );
  const retryIsCurrent = lastRetrySequence > lastTerminalSequence;
  if (!lastTurnStatus && !retryIsCurrent) return {};

  return {
    turnHealth: {
      ...(lastTurnStatus ? { lastTurnStatus } : {}),
      ...(lastTurnStatus === "failed" &&
      typeof errorCandidate?.message.error === "string"
        ? { lastErrorMessage: errorCandidate.message.error }
        : {}),
      ...(retryIsCurrent && retryCandidate
        ? {
            retryStatus: {
              message:
                typeof retryCandidate.message.warning === "string"
                  ? retryCandidate.message.warning
                  : undefined,
            },
          }
        : {}),
    },
  };
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
    ...snapshot,
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
      base.content = snapshot?.content ?? item.stream.reasoningContent ?? [];
      break;
    case "commandExecution":
      base.command = readString(snapshot, "command") ?? "";
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
      break;
    case "imageView":
      copyString(snapshot, base, "path");
      break;
    case "sleep":
      copyNumber(snapshot, base, "durationMs");
      break;
    case "imageGeneration":
      base.result = undefined;
      copyBoolean(snapshot, base, "transparentBackground");
      break;
    case "enteredReviewMode":
    case "exitedReviewMode":
      copyString(snapshot, base, "review");
      break;
    case "contextCompaction":
      break;
    default:
      // Unknown native fields remain available in the bounded snapshot.
      break;
  }
  return removeUndefined(base);
}

interface ProjectedTurnPlan {
  steps: Array<{ step: string; status: string }>;
  explanation?: string;
}

/**
 * Extract a safe checklist snapshot from the `turn.plan` canonical state.
 *
 * The reducer stores `structuredClone(payload.plan)` from the
 * `turn/plan/updated` notification, which carries `{ explanation?, plan:
 * [{ step, status }] }` in camelCase wire format (`TurnPlanUpdatedNotification`
 * in the app-server protocol). Only well-formed steps with a non-empty label
 * are retained; unknown status strings are passed through as-is so the client
 * can fall back gracefully.
 */
function projectTurnPlanSteps(plan: SafeJsonValue): ProjectedTurnPlan {
  const planObj = asObject(plan);
  const explanation = readString(planObj, "explanation");
  const rawSteps = planObj?.plan ?? plan;
  const steps: Array<{ step: string; status: string }> = [];

  if (Array.isArray(rawSteps)) {
    for (const raw of rawSteps) {
      const stepObj = asObject(raw);
      const step = readString(stepObj, "step");
      const status = readString(stepObj, "status");
      if (step && step.trim().length > 0 && status) {
        steps.push({ step, status });
      }
    }
  }

  return {
    steps,
    ...(explanation ? { explanation } : {}),
  };
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
  return Array.isArray(value) ? value : [];
}

function safeHookFragments(value: SafeJsonValue | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeFileChanges(
  value: unknown,
  pathsOnly = false,
): NormalizedCodexFileChange[] {
  if (!pathsOnly) return publicCodexFileChanges(value);
  // A replay may predate external-path labels. Retain its fingerprint so the
  // matching rollout row can restore a label without guessing by array order.
  const pathMetadata = Array.isArray(value)
    ? value.slice(0, 200).map((entry) => {
        const change = asObject(entry);
        return {
          path: change?.path,
          pathFingerprint: change?.pathFingerprint,
          kind: change?.kind,
        };
      })
    : [];
  return publicCodexFileChanges(pathMetadata).map(
    ({ path, pathFingerprint, kind }) => ({
      path,
      pathFingerprint,
      kind,
    }),
  );
}

function safeWebAction(value: SafeJsonValue | undefined): unknown {
  return value ?? null;
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
  legacyCorrelationKeyIndex: ReadonlyMap<string, number>,
): number {
  const correlationKey = candidate.message.codexCorrelationKey;
  if (typeof correlationKey === "string") {
    const correlated = legacyCorrelationKeyIndex.get(correlationKey);
    const correlatedMessage =
      correlated === undefined ? undefined : messages[correlated];
    if (
      correlated !== undefined &&
      correlatedMessage !== undefined &&
      !claimed.has(correlated) &&
      correlatedMessage.codexCorrelationKey === correlationKey
    ) {
      return correlated;
    }
  }

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
  const threadItem = structuredClone(candidate.message.codexThreadItem);
  const nativeItem = asUnknownObject(threadItem);
  if (
    candidate.nativeType === "fileChange" &&
    Array.isArray(nativeItem?.changes) &&
    nativeItem.changes.some((entry) => {
      const path = readUnknownString(asUnknownObject(entry), "path");
      return path !== undefined && isLegacyMaskedCodexFilePath(path);
    })
  ) {
    const content = message.message?.content ?? message.content;
    const tool = Array.isArray(content)
      ? content.find(
          (block) =>
            block.type === "tool_use" && block.id === candidate.originalItemId,
        )
      : undefined;
    const input = asUnknownObject(tool?.input);
    // Recovery only needs path metadata; do not reprocess potentially large
    // patch bodies while overlaying each historical file-change item.
    const legacyChanges = safeFileChanges(input?.changes, true);
    const pathsByFingerprint = new Map(
      legacyChanges
        .filter((change) => !isLegacyMaskedCodexFilePath(change.path))
        .map((change) => [change.pathFingerprint, change.path]),
    );
    if (Array.isArray(nativeItem.changes)) {
      nativeItem.changes = nativeItem.changes.map((entry) => {
        const change = asUnknownObject(entry);
        if (
          !change ||
          typeof change.path !== "string" ||
          !isLegacyMaskedCodexFilePath(change.path)
        ) {
          return entry;
        }
        const fingerprint = readUnknownString(change, "pathFingerprint");
        const recoveredPath = fingerprint
          ? pathsByFingerprint.get(fingerprint)
          : undefined;
        return recoveredPath ? { ...change, path: recoveredPath } : entry;
      });
    }
  }
  return {
    ...message,
    codexThreadItem: threadItem,
    codexThreadItemLifecycle: candidate.message.codexThreadItemLifecycle,
    codexThreadId: candidate.message.codexThreadId,
    codexTurnId: candidate.message.codexTurnId,
    ...(candidate.message.clientUserMessageId === undefined
      ? {}
      : { clientUserMessageId: candidate.message.clientUserMessageId }),
    ...(candidate.message.codexCorrelationKey === undefined
      ? {}
      : { codexCorrelationKey: candidate.message.codexCorrelationKey }),
    codexEventSequence: candidate.sequence,
    codexRawReasoningAllowed: true,
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

function safeIdentity(value: string, _kind: string): string {
  return value.slice(0, 2_048);
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

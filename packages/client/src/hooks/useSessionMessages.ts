import {
  type ContextStatusResponse,
  type ContextUsage,
  SESSION_DISPLAY_INITIAL_TURN_LIMIT,
  SESSION_DISPLAY_QUESTION_PREVIEW_MAX_LENGTH,
  type SessionDisplayPage,
  type SessionDisplayUserContent,
  type SessionQuestion,
  type SubagentDescriptor,
  type SubagentMetrics,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { type PaginationInfo, api } from "../api/client";
import {
  getMessageTimestampMs,
  hasEquivalentJsonlMessage,
  reconcileCodexLinearMessages,
} from "../lib/codexLinearMessages";
import {
  applyContextUsageToLatestUserPrompt,
  extractCodexTurnContextUsage,
} from "../lib/codexMessageContext";
import {
  getMessageContent,
  getMessageId,
  mergeJSONLMessages,
  mergeStreamMessage,
} from "../lib/mergeMessages";
import { isMobileShellDocument } from "../lib/nativePushBridge";
import {
  type SessionSnapshotValue,
  getSessionSnapshot,
  invalidateSessionSnapshots,
  putSessionSnapshot,
} from "../lib/sessionSnapshotCache";
import { getProvider } from "../providers/registry";
import type { Message, PermissionMode, Session, SessionStatus } from "../types";

/** Content from a subagent (Task tool) */
export interface AgentContent {
  messages: Message[];
  status: "pending" | "running" | "completed" | "failed";
  /** Real-time context usage from message_start events */
  contextUsage?: {
    inputTokens: number;
    percentage: number;
  };
  /** Resolved subagent type/profile (e.g. `explore`), when known. */
  agentType?: string;
  /** Derived run metrics (usage breakdown, tool/step counts, duration). */
  metrics?: SubagentMetrics;
  /** Rich identity + lifecycle descriptor, when the provider supplies it. */
  descriptor?: SubagentDescriptor;
}

/** Map of agentId → agent content */
export type AgentContentMap = Record<string, AgentContent>;

/** Streaming placeholder update from stream_event deltas */
export interface StreamingMessageUpdate {
  message: Message;
  agentId?: string;
}

/** Result from initial session load */
export interface SessionLoadResult {
  session: Session;
  status: SessionStatus;
  permissionMode?: PermissionMode;
  modeVersion?: number;
  pendingInputRequest?: unknown;
  slashCommands?: Array<{
    name: string;
    description: string;
    argumentHint?: string;
  }> | null;
}

/** Options for useSessionMessages */
export interface UseSessionMessagesOptions {
  projectId: string;
  sessionId: string;
  /** Branch id selected from the URL query. */
  branchId?: string;
  /** Prefer the lightweight persisted-history API for inactive sessions. */
  preferDisplayHistory?: boolean;
  /** The live runtime has settled and may replace legacy rows with display. */
  displayHistoryEligible?: boolean;
  /** This client owns the active stream and may flush closed raw prefixes. */
  displayHistoryLiveOwned?: boolean;
  /** Called when initial load completes with session data */
  onLoadComplete?: (result: SessionLoadResult) => void;
  /** Called on load error */
  onLoadError?: (error: Error) => void;
}

/** Result from useSessionMessages hook */
export interface UseSessionMessagesResult {
  /** Messages in the session */
  messages: Message[];
  /** Lightweight persisted timeline; null means the legacy Message[] path. */
  displayPage: SessionDisplayPage | null;
  /** Independently loaded complete/partial user-question directory. */
  displayQuestions: SessionQuestion[];
  displayQuestionCoverage: "complete" | "partial" | "unavailable";
  /** Display group replaced by the in-memory raw self-owned live tail. */
  hydratedLiveTailDetailRef: string | null;
  /** Subagent content keyed by agentId */
  agentContent: AgentContentMap;
  /** Mapping from Task tool_use_id → agentId */
  toolUseToAgent: Map<string, string>;
  /**
   * Mapping from Task tool_use_id → all subagent ids it produced. A single
   * `Agent` call is 1:1; an `AgentSwarm` call fans out to N children that
   * share one tool_use_id. Consumers rendering the full fan-out use this.
   */
  toolUseToAgentIds: Map<string, string[]>;
  /** Whether initial load is in progress */
  loading: boolean;
  /** Session data from initial load */
  session: Session | null;
  /** Set session data (for stream connected event) */
  setSession: React.Dispatch<React.SetStateAction<Session | null>>;
  /** Handle streaming content updates (for useStreamingContent) */
  handleStreamingUpdate: (message: Message, agentId?: string) => void;
  /** Handle multiple streaming content updates in one React state pass */
  handleStreamingUpdates: (updates: StreamingMessageUpdate[]) => void;
  /** Handle stream message event (buffered until initial load completes) */
  handleStreamMessageEvent: (incoming: Message) => void;
  /** Handle stream subagent message event */
  handleStreamSubagentMessage: (incoming: Message, agentId: string) => void;
  /** Register toolUse → agent mapping */
  registerToolUseAgent: (toolUseId: string, agentId: string) => void;
  /** Update agent content (for lazy loading) */
  setAgentContent: React.Dispatch<React.SetStateAction<AgentContentMap>>;
  /** Update toolUseToAgent mapping */
  setToolUseToAgent: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  /** Update toolUseToAgentIds (fan-out) mapping */
  setToolUseToAgentIds: React.Dispatch<
    React.SetStateAction<Map<string, string[]>>
  >;
  /** Direct messages setter (for clearing streaming placeholders) */
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Rewind/edit: drop the given uuid and everything after it */
  truncateMessagesBefore: (uuid: string, preserveTempId?: string) => void;
  /** Fetch new messages incrementally (for file change events) */
  fetchNewMessages: () => Promise<void>;
  /** Reload the authoritative session snapshot from REST */
  refreshSessionMessages: (options?: {
    branchId?: string | null;
    /** Allow an explicit history rewrite to remove messages missing from disk. */
    replaceMessages?: boolean;
    acceptSnapshot?: (snapshot: {
      session: Session;
      messages: Message[];
    }) => boolean;
  }) => Promise<Session | null>;
  /** Fetch session metadata only */
  fetchSessionMetadata: () => Promise<void>;
  /** Pagination info from compact-boundary-based loading */
  pagination: PaginationInfo | undefined;
  /** Whether older messages are being loaded */
  loadingOlder: boolean;
  /** Whether newer messages are being loaded */
  loadingNewer: boolean;
  /** Whether a target message window is being loaded */
  loadingTargetMessage: boolean;
  /** Load the next chunk of older messages */
  loadOlderMessages: () => Promise<void>;
  /** Load the next chunk of newer messages */
  loadNewerMessages: () => Promise<void>;
  /** Replace the visible window with one centered on a target message */
  loadTargetMessageWindow: (messageId: string) => Promise<boolean>;
  /** Notify the hook whether the transcript is following its live tail. */
  updateActiveWindowFollowingBottom: (followingBottom: boolean) => void;
  /** Increments after a browser-local prefix trim. */
  activeWindowTrimRevision: number;
}

function isCodexProvider(provider?: string): boolean {
  return provider === "codex" || provider === "codex-oss";
}

type SessionApiSnapshot = Awaited<ReturnType<typeof api.getSession>>;

function getSessionHistorySource(data: SessionApiSnapshot): string {
  if (data.historySource) return data.historySource;
  const canonical = data.codexCanonicalView;
  if (canonical?.sourceKind === "rollout") return "codex-rollout";
  if (canonical)
    return `codex-canonical:${canonical.sourceKind}:${canonical.source}`;
  return isCodexProvider(data.session.provider)
    ? "codex-rollout"
    : `provider:${data.session.provider}`;
}

function getSessionSnapshotRevision(data: SessionApiSnapshot): string {
  return data.pagination?.rolloutRevision ?? data.session.updatedAt;
}

function cacheSessionApiSnapshot(
  projectId: string,
  sessionId: string,
  branchId: string | undefined,
  data: SessionApiSnapshot,
): string | null {
  if (!isCodexProvider(data.session.provider)) return null;
  const historySource = getSessionHistorySource(data);
  const cached = putSessionSnapshot({
    projectId,
    sessionId,
    branchId,
    historySource,
    session: data.session,
    messages: data.messages,
    pagination: data.pagination,
    revision: getSessionSnapshotRevision(data),
  });
  return cached ? historySource : null;
}

/**
 * Hard cap on messages fetched per chunk (initial load and each "load older").
 * Compact-boundary slicing already bounds compacted sessions; this also bounds
 * long sessions that were never compacted, keeping first paint fast. Older
 * messages load on demand via the top-of-list infinite scroll.
 */
const INITIAL_MESSAGE_LIMIT = 100;
const ACTIVE_LIVE_TAIL_MAX_DETAIL_PAGES = 4;
const ACTIVE_DISPLAY_BOUNDARY_RETRY_DELAYS_MS = [80, 200, 500, 1_000, 2_000];
/** One delayed retry after the immediate context-status fallback misses. */
const CONTEXT_USAGE_RETRY_MS = 3_000;
const ACTIVE_WINDOW_TARGET_MESSAGES = INITIAL_MESSAGE_LIMIT;
const ACTIVE_WINDOW_TRIGGER_MESSAGES = INITIAL_MESSAGE_LIMIT + 50;
const ACTIVE_WINDOW_TURN_BOUNDARY_LOOKBACK = 25;
const ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS = 60_000;

function findDisplayLiveTail(page: SessionDisplayPage) {
  for (let turnIndex = page.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = page.turns[turnIndex];
    if (!turn) continue;
    for (
      let segmentIndex = turn.segments.length - 1;
      segmentIndex >= 0;
      segmentIndex -= 1
    ) {
      const segment = turn.segments[segmentIndex];
      if (segment?.type === "tool_group" && segment.liveTail) return segment;
    }
  }
  return null;
}

function isDisplayDetailStale(error: unknown): boolean {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return (
    code === "SESSION_DISPLAY_STALE" ||
    code === "SESSION_DISPLAY_CHANGED" ||
    code === "SESSION_TOOL_GROUP_NOT_FOUND"
  );
}

function contextUsageFromStatus(
  status: ContextStatusResponse,
): ContextUsage | undefined {
  if (status.source === "jsonl") return status.contextUsage;
  if (
    !Number.isFinite(status.totalTokens) ||
    status.totalTokens <= 0 ||
    !Number.isFinite(status.rawMaxTokens) ||
    status.rawMaxTokens <= 0
  ) {
    return undefined;
  }
  return {
    inputTokens: status.totalTokens,
    percentage: Math.round((status.totalTokens / status.rawMaxTokens) * 100),
    contextWindow: status.rawMaxTokens,
  };
}

function mergeSameSessionMetadata(
  current: Session | null,
  incoming: Session,
): Session {
  if (current?.id !== incoming.id) return incoming;
  const merged = { ...current, ...incoming };
  if (incoming.contextUsage === undefined && current.contextUsage) {
    merged.contextUsage = current.contextUsage;
  }
  return merged;
}

function isReadableAssistantBoundary(message: Message): boolean {
  if (message._displayLiveTail || message._isStreaming) return false;
  const role = message.message?.role ?? message.role;
  if (
    role !== "assistant" &&
    message.type !== "assistant" &&
    message.type !== "summary"
  ) {
    return false;
  }
  const content = getMessageContent(message);
  if (typeof content === "string") return content.trim().length > 0;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0,
    )
  );
}

function displayContainsAssistantBoundary(
  page: SessionDisplayPage,
  message: Message,
): boolean {
  const messageId = getMessageId(message);
  const codexCorrelationKey = nonEmptyMessageIdentity(
    message.codexCorrelationKey,
  );
  return page.turns.some((turn) =>
    turn.segments.some(
      (segment) =>
        segment.type === "assistant_text" &&
        ((codexCorrelationKey !== null &&
          segment.codexCorrelationKey === codexCorrelationKey) ||
          segment.id === messageId ||
          segment.id.startsWith(`${messageId}:`)),
    ),
  );
}

/**
 * A persisted display boundary closes every raw message that preceded it in
 * the same Codex turn. Usually the boundary itself is still present in the raw
 * list and gives us an exact array cut. During startup replay, however, display
 * can already own the final assistant item before the buffered tool messages
 * are flushed. In that case the closing item is never inserted into raw state,
 * so remove the already-seen prefix by native turn identity instead.
 */
function removeRawPrefixClosedByDisplayBoundary(
  messages: Message[],
  boundary: Message,
): Message[] {
  const boundaryId = getMessageId(boundary);
  const boundaryCorrelationKey = nonEmptyMessageIdentity(
    boundary.codexCorrelationKey,
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate) continue;
    if (
      getMessageId(candidate) === boundaryId ||
      (boundaryCorrelationKey !== null &&
        nonEmptyMessageIdentity(candidate.codexCorrelationKey) ===
          boundaryCorrelationKey)
    ) {
      return messages.slice(index + 1);
    }
  }

  const codexTurnId = nonEmptyMessageIdentity(boundary.codexTurnId);
  if (!codexTurnId) return messages;
  const filtered = messages.filter(
    (message) => nonEmptyMessageIdentity(message.codexTurnId) !== codexTurnId,
  );
  return filtered.length === messages.length ? messages : filtered;
}

function messageContainsToolUse(message: Message): boolean {
  if (message.toolUse) return true;
  const content = getMessageContent(message);
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block?.type === "tool_use" ||
        block?.type === "toolCall" ||
        block?.type === "function_call",
    )
  );
}

function mergeOlderPagination(
  current: PaginationInfo | undefined,
  incoming: PaginationInfo | undefined,
): PaginationInfo | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  return {
    ...incoming,
    hasNewerMessages: current.hasNewerMessages,
    truncatedAfterMessageId: current.truncatedAfterMessageId,
    returnedMessageCount:
      current.returnedMessageCount + incoming.returnedMessageCount,
  };
}

function mergeNewerPagination(
  current: PaginationInfo | undefined,
  incoming: PaginationInfo | undefined,
): PaginationInfo | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  return {
    ...incoming,
    hasOlderMessages: current.hasOlderMessages,
    truncatedBeforeMessageId: current.truncatedBeforeMessageId,
    returnedMessageCount:
      current.returnedMessageCount + incoming.returnedMessageCount,
  };
}

function isCodexHistoryCursorStale(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "SESSION_HISTORY_CURSOR_STALE"
  );
}

function mergeRefreshPagination(
  current: PaginationInfo | undefined,
  incoming: PaginationInfo | undefined,
): PaginationInfo | undefined {
  if (!incoming) return current;
  if (!current) return incoming;

  return {
    ...incoming,
    hasOlderMessages: current.hasOlderMessages || incoming.hasOlderMessages,
    hasNewerMessages:
      current.hasNewerMessages || incoming.hasNewerMessages || undefined,
    totalMessageCount: Math.max(
      current.totalMessageCount,
      incoming.totalMessageCount,
    ),
    returnedMessageCount: Math.max(
      current.returnedMessageCount,
      incoming.returnedMessageCount,
    ),
    truncatedBeforeMessageId:
      current.truncatedBeforeMessageId ?? incoming.truncatedBeforeMessageId,
    truncatedAfterMessageId:
      current.truncatedAfterMessageId ?? incoming.truncatedAfterMessageId,
  };
}

function codexSnapshotDeactivatesCurrentBranch(
  current: Session | null,
  incoming: Session,
): boolean {
  const currentBranchState =
    current?.codexBranchState ?? current?.branchState ?? null;
  const incomingBranchState =
    incoming.codexBranchState ?? incoming.branchState ?? null;
  const currentBranchId = currentBranchState?.activeBranchId;
  if (!currentBranchId || !incomingBranchState) return false;

  // A normal new turn advances activeBranchId while keeping the previous tip
  // on the active path. A rollback is different: the previous tip remains in
  // the append-only branch graph but is explicitly no longer active.
  const previousTip = incomingBranchState.branches.find(
    (branch) => branch.id === currentBranchId,
  );
  return previousTip?.isActive === false;
}

function getMessageRole(message: Message): string {
  const nestedRole = (message.message as { role?: unknown } | undefined)?.role;
  if (nestedRole === "user" || nestedRole === "assistant") {
    return nestedRole;
  }
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "system"
  ) {
    return message.role;
  }
  return "unknown";
}

function isRealUserPromptMessage(message: Message): boolean {
  if (message.type !== "user" && getMessageRole(message) !== "user") {
    return false;
  }

  const content = getMessageContent(message);
  if (!Array.isArray(content)) {
    return true;
  }

  return !content.every(
    (block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_result",
  );
}

function nonEmptyMessageIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

/**
 * Providers such as Pi and Kimi persist their own entry ids and never carry
 * the client-generated UUID into the session file, so a replayed optimistic
 * prompt cannot be matched to the persisted display question by identity.
 * Fall back to the prompt text plus a narrow timestamp window in that case.
 */
const DISPLAY_QUESTION_SEMANTIC_MATCH_WINDOW_MS = 15_000;

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function displayQuestionText(content: SessionDisplayUserContent): string {
  if (typeof content === "string") return normalizePromptText(content);
  return normalizePromptText(
    content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n"),
  );
}

/**
 * Fold the questions carried by a lightweight display page into the question
 * index. The live boundary flush moves finished prompts out of the streamed
 * message list and into the projection, so without this merge the inspector
 * would lose every prompt sent after the initial question fetch until the
 * session is reopened.
 */
export function appendDisplayPageQuestions(
  current: SessionQuestion[],
  page: SessionDisplayPage,
): SessionQuestion[] {
  const knownIds = new Set(current.map((question) => question.id));
  const knownIdentities = new Set(
    current.flatMap((question) => [
      ...(question.clientUserMessageId
        ? [`client:${question.clientUserMessageId}`]
        : []),
      ...(question.codexCorrelationKey
        ? [`correlation:${question.codexCorrelationKey}`]
        : []),
    ]),
  );
  const additions: SessionQuestion[] = [];
  for (const turn of page.turns) {
    const question = turn.question;
    if (!question || knownIds.has(question.messageId)) continue;
    const identities = [
      ...(question.clientUserMessageId
        ? [`client:${question.clientUserMessageId}`]
        : []),
      ...(question.codexCorrelationKey
        ? [`correlation:${question.codexCorrelationKey}`]
        : []),
    ];
    if (identities.some((identity) => knownIdentities.has(identity))) continue;
    const text = displayQuestionText(question.content);
    if (!text) continue;
    knownIds.add(question.messageId);
    for (const identity of identities) knownIdentities.add(identity);
    additions.push({
      id: question.messageId,
      turnId: turn.id,
      ...(question.clientUserMessageId
        ? { clientUserMessageId: question.clientUserMessageId }
        : {}),
      ...(question.codexCorrelationKey
        ? { codexCorrelationKey: question.codexCorrelationKey }
        : {}),
      text: text.slice(0, SESSION_DISPLAY_QUESTION_PREVIEW_MAX_LENGTH),
      ...(question.timestamp ? { timestamp: question.timestamp } : {}),
    });
  }
  return additions.length > 0 ? [...current, ...additions] : current;
}

function userPromptText(message: Message): string {
  const content = getMessageContent(message);
  if (typeof content === "string") return normalizePromptText(content);
  if (!Array.isArray(content)) return "";
  return normalizePromptText(
    content
      .flatMap((block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? [(block as { text: string }).text]
          : [],
      )
      .join("\n"),
  );
}

function displayContainsUserMessageIdentity(
  page: SessionDisplayPage,
  message: Message,
): boolean {
  if (!isRealUserPromptMessage(message)) return false;
  const messageId = getMessageId(message);
  const clientUserMessageId = nonEmptyMessageIdentity(
    message.clientUserMessageId,
  );
  const codexCorrelationKey = nonEmptyMessageIdentity(
    message.codexCorrelationKey,
  );
  const matchedByIdentity = page.turns.some((turn) => {
    const question = turn.question;
    if (!question) return false;
    return (
      // Pi echoes the prompt under its persisted entry id once known.
      question.messageId === messageId ||
      (clientUserMessageId !== null &&
        question.clientUserMessageId === clientUserMessageId) ||
      (codexCorrelationKey !== null &&
        question.codexCorrelationKey === codexCorrelationKey)
    );
  });
  if (matchedByIdentity) return true;

  // Only stream copies of a prompt the client itself sent (optimistic echo or
  // reconnect replay) are eligible for the semantic fallback. A brand-new
  // prompt with identical text is far outside the window of the old question.
  if (message.isReplay !== true && message.isOptimistic !== true) return false;
  const messageTimestampMs = getMessageTimestampMs(message);
  if (messageTimestampMs === null) return false;
  const text = userPromptText(message);
  if (!text) return false;

  return page.turns.some((turn) => {
    const question = turn.question;
    if (!question?.timestamp) return false;
    // Two distinct submissions can have the same text within this window.
    // Explicit identities take precedence over the legacy text fallback.
    if (
      (clientUserMessageId &&
        question.clientUserMessageId &&
        question.clientUserMessageId !== clientUserMessageId) ||
      (codexCorrelationKey &&
        question.codexCorrelationKey &&
        question.codexCorrelationKey !== codexCorrelationKey)
    ) {
      return false;
    }
    const questionTimestampMs = Date.parse(question.timestamp);
    if (!Number.isFinite(questionTimestampMs)) return false;
    if (
      Math.abs(questionTimestampMs - messageTimestampMs) >
      DISPLAY_QUESTION_SEMANTIC_MATCH_WINDOW_MS
    ) {
      return false;
    }
    return displayQuestionText(question.content) === text;
  });
}

function displayContainsAssistantMessageIdentity(
  page: SessionDisplayPage,
  message: Message,
): boolean {
  if (!isReadableAssistantBoundary(message)) return false;
  const codexCorrelationKey = nonEmptyMessageIdentity(
    message.codexCorrelationKey,
  );
  if (!codexCorrelationKey) return false;
  return page.turns.some((turn) =>
    turn.segments.some(
      (segment) =>
        segment.type === "assistant_text" &&
        segment.codexCorrelationKey === codexCorrelationKey,
    ),
  );
}

function displayOwnsClosedCodexTurn(
  page: SessionDisplayPage,
  message: Message,
): boolean {
  const codexTurnId = nonEmptyMessageIdentity(message.codexTurnId);
  if (!codexTurnId) return false;
  return page.turns.some(
    (turn) =>
      turn.id === `turn:${codexTurnId}` &&
      turn.segments.some(
        (segment) =>
          segment.type === "assistant_text" && segment.phase === "final",
      ),
  );
}

function maxDisplayPageTimestampMs(page: SessionDisplayPage): number {
  let maxMs = Number.NEGATIVE_INFINITY;
  const consider = (timestamp: string | undefined) => {
    if (!timestamp) return;
    const ms = Date.parse(timestamp);
    if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
  };
  for (const turn of page.turns) {
    consider(turn.question?.timestamp);
    for (const segment of turn.segments) consider(segment.timestamp);
  }
  return maxMs;
}

function displayContainsMessageIdentity(
  page: SessionDisplayPage,
  message: Message,
): boolean {
  // A turn can finish while a newly steered prompt is still pending. Only
  // the matching question proves that display already owns that input.
  if (isRealUserPromptMessage(message)) {
    return displayContainsUserMessageIdentity(page, message);
  }
  return (
    displayOwnsClosedCodexTurn(page, message) ||
    displayContainsAssistantMessageIdentity(page, message) ||
    displayContainsReasoningMessageIdentity(page, message)
  );
}

/**
 * Reasoning-only assistant messages are owned by display once it carries the
 * matching reasoning row.
 *
 * Pi emits whole assistant turns as reasoning plus tool calls without readable
 * text, so those raw rows are never closed by the assistant-boundary cut. A
 * mid-turn display refresh would otherwise render the same reasoning twice.
 */
function displayContainsReasoningMessageIdentity(
  page: SessionDisplayPage,
  message: Message,
): boolean {
  if (message._displayLiveTail || message._isStreaming) return false;
  if (isReadableAssistantBoundary(message)) return false;
  const content = getMessageContent(message);
  if (!Array.isArray(content)) return false;
  const hasReasoning = content.some(
    (block) =>
      block?.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim().length > 0,
  );
  if (!hasReasoning) return false;
  const messageId = getMessageId(message);
  return page.turns.some((turn) =>
    turn.segments.some(
      (segment) =>
        segment.type === "thinking" &&
        (segment.id === messageId || segment.id.startsWith(`${messageId}:`)),
    ),
  );
}

function removeMessagesRepresentedByDisplay(
  messages: Message[],
  page: SessionDisplayPage,
): Message[] {
  const filtered = messages.filter(
    (message) => !displayContainsMessageIdentity(page, message),
  );
  return filtered.length === messages.length ? messages : filtered;
}

export interface ActiveMessageWindowTrimPlan {
  messages: Message[];
  firstRetainedMessageId: string;
  removedMessageCount: number;
}

/**
 * Bound a live transcript with the same message-count policy as the server's
 * initial response. Prefer a nearby user-turn boundary for readability, but
 * retain the hard fallback so one tool-heavy turn cannot grow without limit.
 * The age gate avoids trimming rows that may not be persisted yet.
 */
export function planActiveMessageWindowTrim(
  messages: Message[],
  nowMs: number,
): ActiveMessageWindowTrimPlan | null {
  if (messages.length <= ACTIVE_WINDOW_TRIGGER_MESSAGES) {
    return null;
  }

  const targetStartIndex = messages.length - ACTIVE_WINDOW_TARGET_MESSAGES;
  let retainedStartIndex = targetStartIndex;
  const earliestTurnBoundaryIndex = Math.max(
    1,
    targetStartIndex - ACTIVE_WINDOW_TURN_BOUNDARY_LOOKBACK,
  );
  for (
    let index = targetStartIndex;
    index >= earliestTurnBoundaryIndex;
    index -= 1
  ) {
    const message = messages[index];
    if (message && isRealUserPromptMessage(message)) {
      retainedStartIndex = index;
      break;
    }
  }

  const firstRetainedMessage = messages[retainedStartIndex];
  if (!firstRetainedMessage) return null;
  const firstRetainedMessageId = getMessageId(firstRetainedMessage);
  const boundaryTimestampMs = getMessageTimestampMs(firstRetainedMessage);
  if (
    !firstRetainedMessageId ||
    boundaryTimestampMs === null ||
    nowMs - boundaryTimestampMs < ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS
  ) {
    return null;
  }

  return {
    messages: messages.slice(retainedStartIndex),
    firstRetainedMessageId,
    removedMessageCount: retainedStartIndex,
  };
}

function isEmptyAssistantContent(message: Message): boolean {
  if (message.type !== "assistant") {
    return false;
  }

  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim().length === 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }

    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type === "text") {
      return (
        typeof typedBlock.text !== "string" || typedBlock.text.trim() === ""
      );
    }
    if (typedBlock.type === "thinking") {
      return (
        typeof typedBlock.thinking !== "string" ||
        typedBlock.thinking.trim() === ""
      );
    }
    return false;
  });
}

function upsertMessageById(messages: Message[], message: Message): Message[] {
  const messageId = getMessageId(message);
  if (!messageId) return messages;

  const existingIdx = messages.findIndex((m) => getMessageId(m) === messageId);
  if (existingIdx >= 0) {
    if (messages[existingIdx] === message) return messages;
    const updated = [...messages];
    updated[existingIdx] = message;
    return updated;
  }

  return [...messages, message];
}

export function truncateMessagesForEdit(
  messages: Message[],
  editedMessageId: string,
  preserveTempId?: string,
): Message[] {
  const index = messages.findIndex(
    (message) => getMessageId(message) === editedMessageId,
  );
  if (index === -1) return messages;

  const prefix = messages.slice(0, index);
  if (!preserveTempId) return prefix;

  const optimisticEdit = messages
    .slice(index + 1)
    .find((message) => message.tempId === preserveTempId);
  return optimisticEdit ? [...prefix, optimisticEdit] : prefix;
}

/**
 * Hook for managing session messages with stream buffering.
 *
 * Handles:
 * - Initial REST load of messages
 * - Buffering stream messages until initial load completes
 * - Merging stream and JSONL messages
 * - Routing subagent messages to agentContent
 */
export function useSessionMessages(
  options: UseSessionMessagesOptions,
): UseSessionMessagesResult {
  const {
    projectId,
    sessionId,
    branchId,
    preferDisplayHistory = false,
    displayHistoryEligible = false,
    displayHistoryLiveOwned = false,
    onLoadComplete,
    onLoadError,
  } = options;
  const initialSnapshotRef = useRef<SessionSnapshotValue | null | undefined>(
    undefined,
  );
  if (initialSnapshotRef.current === undefined) {
    initialSnapshotRef.current = getSessionSnapshot({
      projectId,
      sessionId,
      branchId,
    });
  }
  const initialSnapshot = preferDisplayHistory
    ? null
    : initialSnapshotRef.current;

  // Core state
  const [messages, setMessages] = useState<Message[]>(
    () => initialSnapshot?.messages ?? [],
  );
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [displayPage, setDisplayPage] = useState<SessionDisplayPage | null>(
    null,
  );
  const [displayQuestions, setDisplayQuestions] = useState<SessionQuestion[]>(
    [],
  );
  const [displayQuestionCoverage, setDisplayQuestionCoverage] = useState<
    "complete" | "partial" | "unavailable"
  >("unavailable");
  const [hydratedLiveTailDetailRef, setHydratedLiveTailDetailRef] = useState<
    string | null
  >(null);
  const [agentContent, setAgentContent] = useState<AgentContentMap>({});
  const [toolUseToAgent, setToolUseToAgent] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [toolUseToAgentIds, setToolUseToAgentIds] = useState<
    Map<string, string[]>
  >(() => new Map());
  const [loading, setLoading] = useState(() => !initialSnapshot);
  const [session, setSession] = useState<Session | null>(
    () => initialSnapshot?.session ?? null,
  );
  const [pagination, setPagination] = useState<PaginationInfo | undefined>(
    () => initialSnapshot?.pagination,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [loadingTargetMessage, setLoadingTargetMessage] = useState(false);
  const [activeWindowTrimRevision, setActiveWindowTrimRevision] = useState(0);
  const [activeWindowTrimCheckRevision, setActiveWindowTrimCheckRevision] =
    useState(0);
  const sessionRef = useRef<Session | null>(initialSnapshot?.session ?? null);
  const displayPageRef = useRef<SessionDisplayPage | null>(null);
  const displayQuestionLoadGenerationRef = useRef(0);
  useEffect(() => {
    displayPageRef.current = displayPage;
    if (displayPage) {
      setMessages((current) =>
        removeMessagesRepresentedByDisplay(current, displayPage),
      );
    }
  }, [displayPage]);

  // Buffering: queue stream messages until initial load completes
  const streamBufferRef = useRef<
    Array<
      | { type: "message"; msg: Message }
      | { type: "subagent"; msg: Message; agentId: string }
    >
  >([]);
  const initialLoadCompleteRef = useRef(false);
  const activeWindowFollowingBottomRef = useRef(true);
  const activeWindowTrimSuppressedRef = useRef(false);
  const activeWindowTrimEnabledRef = useRef(
    typeof document !== "undefined" && isMobileShellDocument(),
  );

  // Track provider for DAG ordering decisions
  const providerRef = useRef<string | undefined>(
    initialSnapshot?.session.provider,
  );

  // Track last message ID for incremental fetching
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  const loadedMessageCountRef = useRef(0);
  // Highest timestamp observed from persisted JSONL messages.
  // Used to suppress startup replay events that are already on disk.
  const maxPersistedTimestampMsRef = useRef<number>(Number.NEGATIVE_INFINITY);
  // Tracks whether the same session has already completed its first load.
  // Branch changes reuse the page shell and should keep showing the
  // previous message list until the selected branch content arrives.
  const loadedSessionKeyRef = useRef<string | null>(
    initialSnapshot ? `${projectId}\u0000${sessionId}` : null,
  );
  // A full persisted refresh can be triggered by file activity, the focused
  // session watcher, and connection catch-up at the same time. Once a refresh
  // commits, responses from earlier generations must not overwrite it.
  const refreshRequestGenerationRef = useRef(0);
  // Highest refresh generation that successfully committed (or was explicitly
  // invalidated by navigation/edit). A failed newer request must not prevent an
  // older successful request from filling a gap.
  const refreshAppliedGenerationRef = useRef(0);
  // Pending one-shot contextUsage retry timer (cleared on session change).
  const contextUsageRetryTimerRef =
    useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const updatePersistedTimestampWatermark = useCallback(
    (persistedMessages: Message[]) => {
      let maxMs = maxPersistedTimestampMsRef.current;
      for (const message of persistedMessages) {
        const ts = getMessageTimestampMs(message);
        if (ts !== null && ts > maxMs) {
          maxMs = ts;
        }
      }
      maxPersistedTimestampMsRef.current = maxMs;
    },
    [],
  );

  // Update lastMessageIdRef when messages change
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      lastMessageIdRef.current = getMessageId(lastMessage);
    }
    loadedMessageCountRef.current = messages.length;
  }, [messages]);

  // Process a stream message event.
  // When replaying buffered startup events for Codex, suppress entries that are
  // semantically identical to already-loaded JSONL messages but have different UUIDs.
  const processStreamMessage = useCallback(
    (incoming: Message, fromBufferedReplay = false) => {
      const provider = providerRef.current;
      const turnContextUsage = extractCodexTurnContextUsage(
        incoming,
        sessionRef.current,
        provider,
      );
      if (turnContextUsage) {
        setMessages((prev) =>
          applyContextUsageToLatestUserPrompt(prev, turnContextUsage),
        );
        setSession((prev) =>
          prev
            ? {
                ...prev,
                contextUsage: turnContextUsage,
              }
            : prev,
        );
        return;
      }

      const isReplay = incoming.isReplay === true;
      const shouldApplyReplayDedupe =
        (fromBufferedReplay || isReplay) && isCodexProvider(provider);
      const incomingTimestampMs = getMessageTimestampMs(incoming);
      const isPersistedReplay =
        isReplay &&
        incomingTimestampMs !== null &&
        incomingTimestampMs <= maxPersistedTimestampMsRef.current;

      setMessages((prev) => {
        const currentDisplay = displayPageRef.current;
        if (
          currentDisplay &&
          displayContainsAssistantBoundary(currentDisplay, incoming)
        ) {
          return removeRawPrefixClosedByDisplayBoundary(prev, incoming);
        }
        if (
          currentDisplay &&
          displayContainsMessageIdentity(currentDisplay, incoming)
        ) {
          return prev;
        }
        // Replay history from the stream should not re-add messages that are
        // already persisted and loaded from JSONL.
        if (isPersistedReplay) {
          return prev;
        }

        if (shouldApplyReplayDedupe) {
          if (isEmptyAssistantContent(incoming)) {
            return prev;
          }
          if (hasEquivalentJsonlMessage(prev, incoming)) {
            return prev;
          }
        }

        const result = mergeStreamMessage(prev, incoming);
        return isCodexProvider(provider)
          ? reconcileCodexLinearMessages(result.messages)
          : result.messages;
      });
    },
    [],
  );

  // Process a buffered stream subagent message
  const processStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      setAgentContent((prev) => {
        const existing = prev[agentId] ?? {
          messages: [],
          status: "running" as const,
        };
        const incomingId = getMessageId(incoming);
        if (existing.messages.some((m) => getMessageId(m) === incomingId)) {
          return prev;
        }
        return {
          ...prev,
          [agentId]: {
            ...existing,
            messages: [...existing.messages, incoming],
            status: "running",
          },
        };
      });
    },
    [],
  );

  // Flush buffered stream messages after initial load
  const flushBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    streamBufferRef.current = [];
    for (const item of buffer) {
      if (item.type === "message") {
        processStreamMessage(item.msg, true);
      } else {
        processStreamSubagentMessage(item.msg, item.agentId);
      }
    }
  }, [processStreamMessage, processStreamSubagentMessage]);

  const applySessionSnapshot = useCallback(
    (
      data: {
        session: Session;
        messages: Message[];
        pagination?: PaginationInfo;
      },
      options?: { mergeCodexMessages?: boolean },
    ) => {
      const mergeCodexMessages =
        options?.mergeCodexMessages === true &&
        isCodexProvider(data.session.provider);
      sessionRef.current = data.session;
      setSession(data.session);
      setPagination((current) =>
        mergeCodexMessages
          ? mergeRefreshPagination(current, data.pagination)
          : data.pagination,
      );
      providerRef.current = data.session.provider;

      // Tag messages from JSONL as authoritative
      const taggedMessages = data.messages.map((m) => ({
        ...m,
        _source: "jsonl" as const,
      }));
      if (!mergeCodexMessages) {
        maxPersistedTimestampMsRef.current = Number.NEGATIVE_INFINITY;
      }
      updatePersistedTimestampWatermark(taggedMessages);
      const replaceMessages = isCodexProvider(data.session.provider)
        ? reconcileCodexLinearMessages(taggedMessages)
        : taggedMessages;
      const syncMessageRefs = (nextMessages: Message[]) => {
        // Keep cursor refs aligned with the final snapshot/merge result. A
        // stream "connected" event can fetch before the messages effect below
        // has run.
        const lastMessage = nextMessages[nextMessages.length - 1];
        lastMessageIdRef.current = lastMessage
          ? getMessageId(lastMessage)
          : undefined;
        loadedMessageCountRef.current = nextMessages.length;
      };

      if (mergeCodexMessages) {
        setMessages((current) => {
          const nextMessages = reconcileCodexLinearMessages(
            mergeJSONLMessages(current, taggedMessages, {
              skipDagOrdering: true,
            }).messages,
          );
          syncMessageRefs(nextMessages);
          return nextMessages;
        });
      } else {
        // Preserve the original synchronous cursor update for initial loads;
        // the first stream connection can catch up before React runs effects.
        syncMessageRefs(replaceMessages);
        setMessages(replaceMessages);
      }

      return data.session;
    },
    [updatePersistedTimestampWatermark],
  );

  // Fetch session metadata only
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      // For new sessions, prev may be null if JSONL didn't exist on initial load.
      // Message state lives in this hook's own `messages`, not on `session`, so
      // a metadata merge no longer has to carry an array across.
      setSession((prev) =>
        prev ? { ...prev, ...data.session } : data.session,
      );
    } catch {
      // Silent fail for metadata updates
    }
  }, [projectId, sessionId]);

  const refreshDisplayQuestions = useCallback(
    async (targetBranchId = branchId) => {
      const generation = ++displayQuestionLoadGenerationRef.current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let cursor: string | undefined;
        let accumulated: SessionQuestion[] = [];
        try {
          for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
            const page = await api.getSessionQuestions(projectId, sessionId, {
              cursor,
              branchId: targetBranchId,
            });
            if (generation !== displayQuestionLoadGenerationRef.current) return;
            const incoming = page.questions.map((question) => ({
              id: question.messageId,
              turnId: question.turnId,
              ...(question.clientUserMessageId
                ? { clientUserMessageId: question.clientUserMessageId }
                : {}),
              ...(question.codexCorrelationKey
                ? { codexCorrelationKey: question.codexCorrelationKey }
                : {}),
              text: question.preview,
              ...(question.timestamp ? { timestamp: question.timestamp } : {}),
            }));
            const byId = new Map(
              [...incoming, ...accumulated].map((question) => [
                question.id,
                question,
              ]),
            );
            accumulated = [...byId.values()];
            setDisplayQuestions(accumulated);
            setDisplayQuestionCoverage(page.coverage);
            cursor = page.nextCursor;
            if (!cursor) return;
          }
          setDisplayQuestionCoverage("partial");
          return;
        } catch (error) {
          if (generation !== displayQuestionLoadGenerationRef.current) return;
          if (attempt === 0 && isDisplayDetailStale(error)) continue;
          throw error;
        }
      }
    },
    [branchId, projectId, sessionId],
  );

  const loadSelfLiveTail = useCallback(
    async (
      page: SessionDisplayPage,
    ): Promise<{
      detailRef: string;
      messages: Message[];
    } | null> => {
      const liveTail = findDisplayLiveTail(page);
      if (!liveTail) return null;
      let cursor: string | undefined;
      const messages: Message[] = [];
      for (
        let pageIndex = 0;
        pageIndex < ACTIVE_LIVE_TAIL_MAX_DETAIL_PAGES;
        pageIndex += 1
      ) {
        const detail = await api.getSessionToolGroupDetails(
          projectId,
          sessionId,
          liveTail.detailRef,
          {
            revision: page.revision,
            cursor,
            branchId,
          },
        );
        messages.push(
          ...detail.messages.map((message) => ({
            ...message,
            _source: "sdk" as const,
            _displayLiveTail: true,
          })),
        );
        cursor = detail.nextCursor;
        if (!cursor) {
          return { detailRef: liveTail.detailRef, messages };
        }
      }
      // Keep the summary group when the open tail exceeds the bounded raw
      // hydration budget. The user can still page it through the normal row.
      return null;
    },
    [branchId, projectId, sessionId],
  );

  const refreshLightweightDisplay = useCallback(
    async (
      force = false,
      acceptSnapshot?: (snapshot: {
        session: Session;
        messages: Message[];
      }) => boolean,
      targetBranchId = branchId,
      allowCreate = false,
    ): Promise<Session | null> => {
      const activating = displayPageRef.current === null;
      if (activating && !allowCreate) return null;
      try {
        let metadata = await api.getSessionMetadata(projectId, sessionId);
        if (activating && metadata.ownership.owner !== "none") return null;
        if (!force && metadata.ownership.owner === "self") {
          return null;
        }
        if (
          acceptSnapshot &&
          !acceptSnapshot({ session: metadata.session, messages: [] })
        ) {
          return null;
        }
        const page = await api.getSessionDisplay(projectId, sessionId, {
          branchId: targetBranchId,
          limit: SESSION_DISPLAY_INITIAL_TURN_LIMIT,
        });
        if (activating) {
          const confirmed = await api.getSessionMetadata(projectId, sessionId);
          if (confirmed.ownership.owner !== "none") return null;
          metadata = confirmed;
        }
        displayPageRef.current = page;
        setDisplayPage(page);
        setMessages([]);
        setHydratedLiveTailDetailRef(null);
        lastMessageIdRef.current = undefined;
        loadedMessageCountRef.current = 0;
        const nextSession = mergeSameSessionMetadata(
          sessionRef.current,
          metadata.session,
        );
        sessionRef.current = nextSession;
        setSession(nextSession);
        providerRef.current = nextSession.provider;
        setPagination(undefined);
        void refreshDisplayQuestions(targetBranchId).catch(() => {
          setDisplayQuestionCoverage((coverage) =>
            coverage === "unavailable" ? "unavailable" : "partial",
          );
        });
        onLoadComplete?.({
          session: nextSession,
          status: metadata.ownership,
          permissionMode: metadata.permissionMode,
          modeVersion: metadata.modeVersion,
          pendingInputRequest: metadata.pendingInputRequest,
          slashCommands: metadata.slashCommands,
        });
        return nextSession;
      } catch {
        return null;
      }
    },
    [branchId, onLoadComplete, projectId, refreshDisplayQuestions, sessionId],
  );

  // Initial load. Branch switches reload message content for the same
  // session without returning the page to its full-screen loading state.
  useEffect(() => {
    const sessionLoadKey = `${projectId}\u0000${sessionId}`;
    const isBranchReloadWithinSession =
      loadedSessionKeyRef.current === sessionLoadKey;
    const cachedSnapshot = preferDisplayHistory
      ? null
      : getSessionSnapshot({
          projectId,
          sessionId,
          branchId,
        });
    const cachedHistorySource = cachedSnapshot?.historySource;
    let isCurrent = true;

    // A route/session/branch load supersedes any refresh started for the
    // previously rendered snapshot.
    const initialLoadGeneration = ++refreshRequestGenerationRef.current;
    refreshAppliedGenerationRef.current = initialLoadGeneration;

    initialLoadCompleteRef.current = false;
    streamBufferRef.current = [];
    maxPersistedTimestampMsRef.current = Number.NEGATIVE_INFINITY;
    if (cachedSnapshot) {
      applySessionSnapshot(cachedSnapshot);
      loadedSessionKeyRef.current = sessionLoadKey;
      setLoading(false);
    }
    if (!isBranchReloadWithinSession) {
      // History navigation only suppresses trimming for the session in which
      // it happened. A route change starts from the new session's live tail.
      activeWindowFollowingBottomRef.current = true;
      activeWindowTrimSuppressedRef.current = false;
      if (!cachedSnapshot) setLoading(true);
      setAgentContent({});
      setToolUseToAgent(new Map());
      setToolUseToAgentIds(new Map());
      setDisplayQuestions([]);
      setDisplayQuestionCoverage("unavailable");
    }

    const markReady = () => {
      initialLoadCompleteRef.current = true;
      flushBuffer();
      loadedSessionKeyRef.current = sessionLoadKey;
      setLoading(false);
    };

    const loadMissingContextUsage = async (): Promise<boolean> => {
      try {
        const status = await api.getContextStatus(projectId, sessionId);
        if (!isCurrent) return false;
        const contextUsage = contextUsageFromStatus(status);
        if (!contextUsage) return false;
        setSession((current) => {
          if (!current || current.contextUsage) return current;
          const next: Session = {
            ...current,
            contextUsage,
            ...(!current.model && status.model ? { model: status.model } : {}),
            ...(!current.cumulativeUsage && status.cumulativeUsage
              ? { cumulativeUsage: status.cumulativeUsage }
              : {}),
            ...(!current.compactEvents && status.compactEvents
              ? { compactEvents: status.compactEvents }
              : {}),
          };
          sessionRef.current = next;
          return next;
        });
        return true;
      } catch {
        return false;
      }
    };

    const scheduleContextUsageRetry = (loadedSession: Session) => {
      if (loadedSession.contextUsage) return;
      void loadMissingContextUsage().then((loaded) => {
        if (!isCurrent || loaded) return;
        contextUsageRetryTimerRef.current = setTimeout(() => {
          contextUsageRetryTimerRef.current = undefined;
          if (!isCurrent || sessionRef.current?.contextUsage) return;
          void loadMissingContextUsage();
        }, CONTEXT_USAGE_RETRY_MS);
      });
    };

    const loadLegacySnapshot = async () => {
      const data = await api.getSession(projectId, sessionId, undefined, {
        view: "canonical",
        tailCompactions: 2,
        maxMessages: INITIAL_MESSAGE_LIMIT,
        branchId,
      });
      if (!isCurrent) return;
      setDisplayPage(null);
      displayPageRef.current = null;
      setHydratedLiveTailDetailRef(null);
      const supersededByCommittedRefresh =
        initialLoadGeneration < refreshAppliedGenerationRef.current;
      if (!supersededByCommittedRefresh) {
        const historySource = getSessionHistorySource(data);
        const shouldMergeCachedSnapshot =
          cachedSnapshot !== null &&
          cachedHistorySource === historySource &&
          isCodexProvider(data.session.provider) &&
          !codexSnapshotDeactivatesCurrentBranch(
            sessionRef.current,
            data.session,
          );
        applySessionSnapshot(data, {
          mergeCodexMessages: shouldMergeCachedSnapshot,
        });
        if (cachedHistorySource && cachedHistorySource !== historySource) {
          invalidateSessionSnapshots({
            projectId,
            sessionId,
            branchId,
            historySource: cachedHistorySource,
          });
        }
        cacheSessionApiSnapshot(projectId, sessionId, branchId, data);
      }
      markReady();
      scheduleContextUsageRetry(data.session);
      if (!supersededByCommittedRefresh) {
        onLoadComplete?.({
          session: data.session,
          status: data.ownership,
          permissionMode: data.permissionMode,
          modeVersion: data.modeVersion,
          pendingInputRequest: data.pendingInputRequest,
          slashCommands: data.slashCommands,
        });
      }
    };

    const loadInitialSnapshot = async () => {
      if (preferDisplayHistory) {
        try {
          const metadata = await api.getSessionMetadata(projectId, sessionId);
          if (!isCurrent) return;
          let page: SessionDisplayPage | null = null;
          let liveTail: Awaited<ReturnType<typeof loadSelfLiveTail>> = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              page = await api.getSessionDisplay(projectId, sessionId, {
                branchId,
                limit: SESSION_DISPLAY_INITIAL_TURN_LIMIT,
              });
            } catch (error) {
              if (attempt === 0 && isDisplayDetailStale(error)) continue;
              throw error;
            }
            if (metadata.ownership.owner !== "self") break;
            try {
              liveTail = await loadSelfLiveTail(page);
              break;
            } catch (error) {
              if (attempt === 0 && isDisplayDetailStale(error)) continue;
              liveTail = null;
              break;
            }
          }
          if (!isCurrent || !page) return;
          sessionRef.current = metadata.session;
          setSession(metadata.session);
          providerRef.current = metadata.session.provider;
          setPagination(undefined);
          setMessages(liveTail?.messages ?? []);
          if (
            metadata.session.provider === "pi" ||
            metadata.session.provider === "kimi"
          ) {
            // These providers persist ids that never match live stream UUIDs,
            // so a reconnect replay cannot be deduplicated by identity. Seed
            // the persisted watermark from the display page and hydrated tail
            // so `isPersistedReplay` drops rows that are already on disk.
            updatePersistedTimestampWatermark(liveTail?.messages ?? []);
            const pageMaxMs = maxDisplayPageTimestampMs(page);
            if (pageMaxMs > maxPersistedTimestampMsRef.current) {
              maxPersistedTimestampMsRef.current = pageMaxMs;
            }
          }
          setHydratedLiveTailDetailRef(liveTail?.detailRef ?? null);
          const lastLiveTailMessage = liveTail?.messages.at(-1);
          lastMessageIdRef.current = lastLiveTailMessage
            ? getMessageId(lastLiveTailMessage)
            : undefined;
          loadedMessageCountRef.current = liveTail?.messages.length ?? 0;
          displayPageRef.current = page;
          setDisplayPage(page);
          markReady();
          scheduleContextUsageRetry(metadata.session);
          onLoadComplete?.({
            session: metadata.session,
            status: metadata.ownership,
            permissionMode: metadata.permissionMode,
            modeVersion: metadata.modeVersion,
            pendingInputRequest: metadata.pendingInputRequest,
            slashCommands: metadata.slashCommands,
          });
          void refreshDisplayQuestions().catch(() => {
            if (!isCurrent) return;
            setDisplayQuestionCoverage((coverage) =>
              coverage === "unavailable" ? "unavailable" : "partial",
            );
          });
          return;
        } catch {
          // Older servers or unavailable display projections fall back below.
        }
      }
      await loadLegacySnapshot();
    };

    void loadInitialSnapshot().catch((err) => {
      if (!isCurrent) return;
      initialLoadCompleteRef.current = true;
      flushBuffer();
      setLoading(false);
      // A stale snapshot remains useful during a transient SWR failure. Cold
      // loads preserve the existing error behavior.
      if (!cachedSnapshot) onLoadError?.(err);
    });

    return () => {
      isCurrent = false;
      displayQuestionLoadGenerationRef.current += 1;
      clearTimeout(contextUsageRetryTimerRef.current);
      contextUsageRetryTimerRef.current = undefined;
    };
  }, [
    projectId,
    sessionId,
    branchId,
    preferDisplayHistory,
    onLoadComplete,
    onLoadError,
    flushBuffer,
    applySessionSnapshot,
    loadSelfLiveTail,
    refreshDisplayQuestions,
    updatePersistedTimestampWatermark,
  ]);

  const settledDisplayTransitionRef = useRef({
    key: `${projectId}\u0000${sessionId}\u0000${branchId ?? ""}`,
    eligible: displayHistoryEligible,
    pending: false,
  });
  useEffect(() => {
    const key = `${projectId}\u0000${sessionId}\u0000${branchId ?? ""}`;
    const state = settledDisplayTransitionRef.current;
    if (state.key !== key) {
      settledDisplayTransitionRef.current = {
        key,
        eligible: displayHistoryEligible,
        pending: false,
      };
      return;
    }

    const becameEligible = displayHistoryEligible && !state.eligible;
    state.eligible = displayHistoryEligible;
    if (!displayHistoryEligible) {
      state.pending = false;
      return;
    }
    if (becameEligible) state.pending = true;
    if (!preferDisplayHistory || !state.pending || loading) {
      return;
    }

    state.pending = false;
    void refreshLightweightDisplay(false, undefined, branchId, true);
  }, [
    branchId,
    displayHistoryEligible,
    loading,
    preferDisplayHistory,
    projectId,
    refreshLightweightDisplay,
    sessionId,
  ]);

  const displayBoundaryFlushRef = useRef<{
    key: string;
    lastScheduledId: string | null;
    generation: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>({
    key: `${projectId}\u0000${sessionId}\u0000${branchId ?? ""}`,
    lastScheduledId: null,
    generation: 0,
    timer: null,
  });
  useEffect(() => {
    const key = `${projectId}\u0000${sessionId}\u0000${branchId ?? ""}`;
    const state = displayBoundaryFlushRef.current;
    if (state.key !== key) {
      if (state.timer) clearTimeout(state.timer);
      state.key = key;
      state.lastScheduledId = null;
      state.generation += 1;
      state.timer = null;
    }
    if (
      !preferDisplayHistory ||
      !displayHistoryLiveOwned ||
      !displayPageRef.current
    ) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.generation += 1;
      return;
    }

    const boundary = [...messages].reverse().find(isReadableAssistantBoundary);
    const boundaryId = boundary ? getMessageId(boundary) : undefined;
    const boundaryKey = boundary
      ? (nonEmptyMessageIdentity(boundary.codexCorrelationKey) ?? boundaryId)
      : undefined;
    if (!boundaryId || !boundaryKey || boundaryKey === state.lastScheduledId)
      return;

    state.lastScheduledId = boundaryKey;
    state.generation += 1;
    const generation = state.generation;
    if (state.timer) clearTimeout(state.timer);

    const attempt = async (attemptIndex: number) => {
      if (generation !== state.generation) return;
      try {
        const page = await api.getSessionDisplay(projectId, sessionId, {
          branchId,
          limit: SESSION_DISPLAY_INITIAL_TURN_LIMIT,
        });
        if (generation !== state.generation) return;
        if (boundary && displayContainsAssistantBoundary(page, boundary)) {
          const currentMessages = messagesRef.current;
          let boundaryIndex = -1;
          for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
            const candidate = currentMessages[index];
            if (candidate && getMessageId(candidate) === boundaryId) {
              boundaryIndex = index;
              break;
            }
          }
          if (boundaryIndex < 0) return;
          const remaining = currentMessages.filter(
            (message, index) =>
              index > boundaryIndex ||
              (message.isOptimistic === true &&
                isRealUserPromptMessage(message) &&
                !displayContainsUserMessageIdentity(page, message)),
          );
          const nextLiveTail = findDisplayLiveTail(page);
          displayPageRef.current = page;
          setDisplayPage(page);
          // Prompts that just moved from the live stream into the projection
          // must stay visible in the inspector's question index.
          setDisplayQuestions((currentQuestions) =>
            appendDisplayPageQuestions(currentQuestions, page),
          );
          setHydratedLiveTailDetailRef(
            nextLiveTail && remaining.some(messageContainsToolUse)
              ? nextLiveTail.detailRef
              : null,
          );
          messagesRef.current = remaining;
          setMessages(remaining);
          const last = remaining.at(-1);
          lastMessageIdRef.current = last ? getMessageId(last) : undefined;
          loadedMessageCountRef.current = remaining.length;
          state.timer = null;
          return;
        }
      } catch {
        // Persistence can lag the live stream; retry within the bounded window.
      }

      const delay = ACTIVE_DISPLAY_BOUNDARY_RETRY_DELAYS_MS[attemptIndex + 1];
      if (delay === undefined || generation !== state.generation) {
        state.timer = null;
        return;
      }
      state.timer = setTimeout(() => {
        void attempt(attemptIndex + 1);
      }, delay);
    };

    state.timer = setTimeout(() => {
      void attempt(0);
    }, ACTIVE_DISPLAY_BOUNDARY_RETRY_DELAYS_MS[0]);
  }, [
    branchId,
    displayHistoryLiveOwned,
    messages,
    preferDisplayHistory,
    projectId,
    sessionId,
  ]);
  useEffect(() => {
    return () => {
      const state = displayBoundaryFlushRef.current;
      state.generation += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    };
  }, []);

  const updateActiveWindowFollowingBottom = useCallback(
    (followingBottom: boolean) => {
      if (activeWindowFollowingBottomRef.current === followingBottom) return;
      activeWindowFollowingBottomRef.current = followingBottom;
      if (followingBottom) {
        setActiveWindowTrimCheckRevision((revision) => revision + 1);
      }
    },
    [],
  );

  // The server bounds initial loads, but a live session can keep appending for
  // hours. On the Android shell, silently drop an old prefix while the reader
  // follows the bottom. Manual history navigation suppresses trimming for the
  // rest of this mount so loaded rows never disappear under the user.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an intentional non-data signal that rechecks an unchanged message window after returning to the bottom
  useEffect(() => {
    if (
      !activeWindowTrimEnabledRef.current ||
      !initialLoadCompleteRef.current ||
      !activeWindowFollowingBottomRef.current ||
      activeWindowTrimSuppressedRef.current
    ) {
      return;
    }

    const plan = planActiveMessageWindowTrim(messages, Date.now());
    if (!plan) return;

    setMessages(plan.messages);
    setPagination((current) => ({
      hasOlderMessages: true,
      hasNewerMessages: current?.hasNewerMessages,
      totalMessageCount: Math.max(
        current?.totalMessageCount ?? 0,
        messages.length,
      ),
      returnedMessageCount: plan.messages.length,
      truncatedBeforeMessageId: plan.firstRetainedMessageId,
      truncatedAfterMessageId: current?.truncatedAfterMessageId,
      totalCompactions: current?.totalCompactions ?? 0,
    }));
    setActiveWindowTrimRevision((revision) => revision + 1);
  }, [messages, activeWindowTrimCheckRevision]);

  // Handle streaming content updates (from useStreamingContent)
  const handleStreamingUpdates = useCallback(
    (updates: StreamingMessageUpdate[]) => {
      const mainUpdates: Message[] = [];
      const agentUpdates = new Map<string, Message[]>();

      for (const { message, agentId } of updates) {
        const messageId = getMessageId(message);
        if (!messageId) continue;

        if (agentId) {
          const existing = agentUpdates.get(agentId);
          if (existing) {
            existing.push(message);
          } else {
            agentUpdates.set(agentId, [message]);
          }
        } else {
          mainUpdates.push(message);
        }
      }

      if (mainUpdates.length > 0) {
        setMessages((prev) => mainUpdates.reduce(upsertMessageById, prev));
      }

      if (agentUpdates.size > 0) {
        setAgentContent((prev) => {
          let next = prev;

          for (const [agentId, messages] of agentUpdates) {
            const existing = next[agentId] ?? {
              messages: [],
              status: "running" as const,
            };
            const updatedMessages = messages.reduce(
              upsertMessageById,
              existing.messages,
            );

            if (updatedMessages !== existing.messages) {
              if (next === prev) next = { ...prev };
              next[agentId] = { ...existing, messages: updatedMessages };
            }
          }

          return next;
        });
      }
    },
    [],
  );

  const handleStreamingUpdate = useCallback(
    (message: Message, agentId?: string) => {
      handleStreamingUpdates([{ message, agentId }]);
    },
    [handleStreamingUpdates],
  );

  // Handle stream message event (with buffering)
  const handleStreamMessageEvent = useCallback(
    (incoming: Message) => {
      if (!initialLoadCompleteRef.current) {
        streamBufferRef.current.push({ type: "message", msg: incoming });
        return;
      }
      processStreamMessage(incoming);
    },
    [processStreamMessage],
  );

  // Handle stream subagent message event (with buffering)
  const handleStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      if (!initialLoadCompleteRef.current) {
        streamBufferRef.current.push({
          type: "subagent",
          msg: incoming,
          agentId,
        });
        return;
      }
      processStreamSubagentMessage(incoming, agentId);
    },
    [processStreamSubagentMessage],
  );

  // Register toolUse → agent mapping
  const registerToolUseAgent = useCallback(
    (toolUseId: string, agentId: string) => {
      setToolUseToAgent((prev) => {
        if (prev.has(toolUseId)) return prev;
        const next = new Map(prev);
        next.set(toolUseId, agentId);
        return next;
      });
      setToolUseToAgentIds((prev) => {
        const existing = prev.get(toolUseId);
        if (existing?.includes(agentId)) return prev;
        const next = new Map(prev);
        next.set(toolUseId, existing ? [...existing, agentId] : [agentId]);
        return next;
      });
    },
    [],
  );

  // Fetch new messages incrementally (for file change events)
  const fetchNewMessages = useCallback(async () => {
    if (displayPageRef.current) {
      await refreshLightweightDisplay(false);
      return;
    }
    if (pagination?.hasNewerMessages) {
      return;
    }

    invalidateSessionSnapshots({ projectId, sessionId, branchId });
    try {
      const data = await api.getSession(
        projectId,
        sessionId,
        lastMessageIdRef.current,
        { view: "canonical", branchId },
      );
      if (data.session.provider === "pi" || data.session.provider === "kimi") {
        // Pi and Kimi cannot correlate their persisted entry ids with live
        // process UUIDs, and their readers return a full transcript even when
        // `afterMessageId` is supplied. Treat it as an authoritative snapshot;
        // merging would append persisted copies of old user turns at the tail.
        applySessionSnapshot(data);
      } else if (data.messages.length > 0) {
        updatePersistedTimestampWatermark(data.messages);
        setMessages((prev) => {
          const result = mergeJSONLMessages(prev, data.messages, {
            skipDagOrdering: !getProvider(data.session.provider).capabilities
              .supportsDag,
          });
          return isCodexProvider(data.session.provider)
            ? reconcileCodexLinearMessages(result.messages)
            : result.messages;
        });
      }
      // Update session metadata (including title, model, contextUsage) which may have changed
      // For new sessions, prev may be null if JSONL didn't exist on initial load
      if (data.session.provider !== "pi" && data.session.provider !== "kimi") {
        setSession((prev) =>
          prev ? { ...prev, ...data.session } : data.session,
        );
      }
      onLoadComplete?.({
        session: data.session,
        status: data.ownership,
        permissionMode: data.permissionMode,
        modeVersion: data.modeVersion,
        pendingInputRequest: data.pendingInputRequest,
        slashCommands: data.slashCommands,
      });
    } catch {
      // Silent fail for incremental updates
    }
  }, [
    projectId,
    sessionId,
    branchId,
    pagination?.hasNewerMessages,
    applySessionSnapshot,
    refreshLightweightDisplay,
    updatePersistedTimestampWatermark,
    onLoadComplete,
  ]);

  const refreshSessionMessages = useCallback(
    async (options?: {
      branchId?: string | null;
      replaceMessages?: boolean;
      acceptSnapshot?: (snapshot: {
        session: Session;
        messages: Message[];
      }) => boolean;
    }) => {
      const resolvedBranchId =
        options?.branchId === undefined
          ? branchId
          : (options.branchId ?? undefined);
      if (displayPageRef.current) {
        return refreshLightweightDisplay(
          options?.replaceMessages === true,
          options?.acceptSnapshot,
          resolvedBranchId,
        );
      }
      const requestGeneration = ++refreshRequestGenerationRef.current;
      const cachedSnapshot = getSessionSnapshot({
        projectId,
        sessionId,
        branchId: resolvedBranchId,
      });
      if (options?.replaceMessages) {
        invalidateSessionSnapshots({
          projectId,
          sessionId,
          branchId: resolvedBranchId,
        });
      }
      try {
        const data = await api.getSession(projectId, sessionId, undefined, {
          view: "canonical",
          tailCompactions: 2,
          maxMessages: Math.max(
            INITIAL_MESSAGE_LIMIT,
            loadedMessageCountRef.current,
          ),
          branchId: resolvedBranchId,
        });
        if (requestGeneration < refreshAppliedGenerationRef.current) {
          return null;
        }
        if (
          options?.acceptSnapshot &&
          !options.acceptSnapshot({
            session: data.session,
            messages: data.messages,
          })
        ) {
          return null;
        }
        refreshAppliedGenerationRef.current = requestGeneration;
        const shouldReplaceMessages =
          options?.replaceMessages === true ||
          !isCodexProvider(data.session.provider) ||
          codexSnapshotDeactivatesCurrentBranch(
            sessionRef.current,
            data.session,
          );
        const refreshedSession = applySessionSnapshot(data, {
          mergeCodexMessages: !shouldReplaceMessages,
        });
        const historySource = getSessionHistorySource(data);
        if (
          cachedSnapshot?.historySource &&
          cachedSnapshot.historySource !== historySource
        ) {
          invalidateSessionSnapshots({
            projectId,
            sessionId,
            branchId: resolvedBranchId,
            historySource: cachedSnapshot.historySource,
          });
        }
        cacheSessionApiSnapshot(projectId, sessionId, resolvedBranchId, data);
        onLoadComplete?.({
          session: data.session,
          status: data.ownership,
          permissionMode: data.permissionMode,
          modeVersion: data.modeVersion,
          pendingInputRequest: data.pendingInputRequest,
          slashCommands: data.slashCommands,
        });
        return refreshedSession;
      } catch {
        return null;
      }
    },
    [
      projectId,
      sessionId,
      branchId,
      applySessionSnapshot,
      onLoadComplete,
      refreshLightweightDisplay,
    ],
  );

  // Load older messages (previous chunk before the current truncation point)
  const loadOlderMessages = useCallback(async () => {
    const currentDisplay = displayPageRef.current;
    if (currentDisplay) {
      if (!currentDisplay.nextCursor) return;
      activeWindowTrimSuppressedRef.current = true;
      setLoadingOlder(true);
      try {
        const older = await api.getSessionDisplay(projectId, sessionId, {
          cursor: currentDisplay.nextCursor,
          branchId,
          limit: SESSION_DISPLAY_INITIAL_TURN_LIMIT,
        });
        const merged: SessionDisplayPage = {
          ...currentDisplay,
          revision: older.revision,
          turns: [...older.turns, ...currentDisplay.turns],
          nextCursor: older.nextCursor,
        };
        displayPageRef.current = merged;
        setDisplayPage(merged);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          (error as { code?: unknown }).code === "SESSION_DISPLAY_STALE"
        ) {
          try {
            const refreshed = await api.getSessionDisplay(
              projectId,
              sessionId,
              {
                branchId,
                limit: SESSION_DISPLAY_INITIAL_TURN_LIMIT,
              },
            );
            displayPageRef.current = refreshed;
            setDisplayPage(refreshed);
          } catch {
            // Leave the current lightweight page visible.
          }
        }
      } finally {
        setLoadingOlder(false);
      }
      return;
    }
    if (!pagination?.hasOlderMessages || !pagination.truncatedBeforeMessageId) {
      return;
    }
    activeWindowTrimSuppressedRef.current = true;
    setLoadingOlder(true);
    try {
      const data = await api.getSession(projectId, sessionId, undefined, {
        view: "canonical",
        tailCompactions: 2,
        maxMessages: INITIAL_MESSAGE_LIMIT,
        beforeMessageId: pagination.truncatedBeforeMessageId,
        rolloutRevision: pagination.rolloutRevision,
        branchId,
      });
      setMessages((prev) => {
        const taggedOlder = data.messages.map((m) => ({
          ...m,
          _source: "jsonl" as const,
        }));
        updatePersistedTimestampWatermark(taggedOlder);
        const combined = [...taggedOlder, ...prev];
        return isCodexProvider(data.session.provider)
          ? reconcileCodexLinearMessages(combined)
          : combined;
      });
      setPagination((current) =>
        mergeOlderPagination(current, data.pagination),
      );
    } catch (error) {
      if (isCodexHistoryCursorStale(error)) {
        await refreshSessionMessages({ replaceMessages: true });
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [
    projectId,
    sessionId,
    branchId,
    pagination,
    updatePersistedTimestampWatermark,
    refreshSessionMessages,
  ]);

  const loadNewerMessages = useCallback(async () => {
    if (!pagination?.hasNewerMessages || !pagination.truncatedAfterMessageId) {
      return;
    }
    activeWindowTrimSuppressedRef.current = true;
    setLoadingNewer(true);
    try {
      const data = await api.getSession(projectId, sessionId, undefined, {
        view: "canonical",
        maxMessages: INITIAL_MESSAGE_LIMIT,
        afterWindowMessageId: pagination.truncatedAfterMessageId,
        rolloutRevision: pagination.rolloutRevision,
        branchId,
      });
      setMessages((prev) => {
        const taggedNewer = data.messages.map((m) => ({
          ...m,
          _source: "jsonl" as const,
        }));
        updatePersistedTimestampWatermark(taggedNewer);
        const combined = [...prev, ...taggedNewer];
        return isCodexProvider(data.session.provider)
          ? reconcileCodexLinearMessages(combined)
          : combined;
      });
      setPagination((current) =>
        mergeNewerPagination(current, data.pagination),
      );
    } catch (error) {
      if (isCodexHistoryCursorStale(error)) {
        await refreshSessionMessages({ replaceMessages: true });
      }
    } finally {
      setLoadingNewer(false);
    }
  }, [
    projectId,
    sessionId,
    branchId,
    pagination,
    updatePersistedTimestampWatermark,
    refreshSessionMessages,
  ]);

  const loadTargetMessageWindow = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (!messageId) return false;
      const currentDisplay = displayPageRef.current;
      if (currentDisplay) {
        const containsTarget = (page: SessionDisplayPage) =>
          page.turns.some((turn) => turn.question?.messageId === messageId);
        if (containsTarget(currentDisplay)) return true;
        setLoadingTargetMessage(true);
        try {
          let merged = currentDisplay;
          for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
            if (!merged.nextCursor) return false;
            const older = await api.getSessionDisplay(projectId, sessionId, {
              cursor: merged.nextCursor,
              branchId,
              limit: SESSION_DISPLAY_INITIAL_TURN_LIMIT,
            });
            merged = {
              ...merged,
              revision: older.revision,
              turns: [...older.turns, ...merged.turns],
              nextCursor: older.nextCursor,
            };
            displayPageRef.current = merged;
            setDisplayPage(merged);
            if (containsTarget(older)) return true;
          }
          return false;
        } catch {
          return false;
        } finally {
          setLoadingTargetMessage(false);
        }
      }
      // A user-directed window replacement supersedes background tail refreshes.
      refreshRequestGenerationRef.current += 1;
      refreshAppliedGenerationRef.current = refreshRequestGenerationRef.current;
      activeWindowTrimSuppressedRef.current = true;
      setLoadingTargetMessage(true);
      try {
        const data = await api.getSession(projectId, sessionId, undefined, {
          view: "canonical",
          aroundMessageId: messageId,
          maxMessages: INITIAL_MESSAGE_LIMIT,
          rolloutRevision: pagination?.rolloutRevision,
          branchId,
        });
        const targetFound =
          data.pagination?.targetMessageFound !== false &&
          data.messages.some((message) => getMessageId(message) === messageId);
        if (!targetFound) {
          return false;
        }

        const loadedSession = applySessionSnapshot(data);
        cacheSessionApiSnapshot(projectId, sessionId, branchId, data);
        onLoadComplete?.({
          session: data.session,
          status: data.ownership,
          permissionMode: data.permissionMode,
          modeVersion: data.modeVersion,
          pendingInputRequest: data.pendingInputRequest,
          slashCommands: data.slashCommands,
        });
        return Boolean(loadedSession);
      } catch {
        return false;
      } finally {
        setLoadingTargetMessage(false);
      }
    },
    [
      projectId,
      sessionId,
      branchId,
      pagination?.rolloutRevision,
      applySessionSnapshot,
      onLoadComplete,
    ],
  );

  /**
   * Rewind/edit: drop the message with `uuid` and everything after it (keeping
   * everything before). Used when editing a past prompt — we optimistically
   * remove the original message and its old branch so the freshly streamed
   * branch replaces it instead of stacking. We key on the edited message's OWN
   * uuid (always present in the list) rather than its parent, which may be a
   * non-rendered entry like a system message. No-op if the uuid isn't found.
   */
  const truncateMessagesBefore = useCallback(
    (uuid: string, preserveTempId?: string) => {
      // Do not let a background refresh started before the edit restore the old
      // tail after the optimistic truncation.
      refreshRequestGenerationRef.current += 1;
      refreshAppliedGenerationRef.current = refreshRequestGenerationRef.current;
      invalidateSessionSnapshots({ projectId, sessionId, branchId });
      setDisplayPage((current) => {
        if (!current) return current;
        const turnIndex = current.turns.findIndex(
          (turn) => turn.question?.messageId === uuid,
        );
        if (turnIndex < 0) return current;
        const next = { ...current, turns: current.turns.slice(0, turnIndex) };
        displayPageRef.current = next;
        return next;
      });
      setMessages((prev) =>
        truncateMessagesForEdit(prev, uuid, preserveTempId),
      );
    },
    [projectId, sessionId, branchId],
  );

  return {
    messages,
    displayPage,
    displayQuestions,
    displayQuestionCoverage,
    hydratedLiveTailDetailRef,
    agentContent,
    toolUseToAgent,
    toolUseToAgentIds,
    loading,
    session,
    setSession,
    handleStreamingUpdate,
    handleStreamingUpdates,
    handleStreamMessageEvent,
    handleStreamSubagentMessage,
    registerToolUseAgent,
    setAgentContent,
    setToolUseToAgent,
    setToolUseToAgentIds,
    setMessages,
    truncateMessagesBefore,
    fetchNewMessages,
    refreshSessionMessages,
    fetchSessionMetadata,
    pagination,
    loadingOlder,
    loadingNewer,
    loadingTargetMessage,
    loadOlderMessages,
    loadNewerMessages,
    loadTargetMessageWindow,
    updateActiveWindowFollowingBottom,
    activeWindowTrimRevision,
  };
}

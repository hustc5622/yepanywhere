import type { SubagentDescriptor, SubagentMetrics } from "@yep-anywhere/shared";
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
  /** Called when initial load completes with session data */
  onLoadComplete?: (result: SessionLoadResult) => void;
  /** Called on load error */
  onLoadError?: (error: Error) => void;
}

/** Result from useSessionMessages hook */
export interface UseSessionMessagesResult {
  /** Messages in the session */
  messages: Message[];
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
/**
 * One-shot delayed metadata retry when the initial GET returns no
 * contextUsage (bridge session not yet readable from disk, or the first
 * turn has not finished). No later event is guaranteed to fill the gap,
 * so the indicator would otherwise stay hidden until the next navigation.
 */
const CONTEXT_USAGE_RETRY_MS = 3_000;
const ACTIVE_WINDOW_TARGET_MESSAGES = INITIAL_MESSAGE_LIMIT;
const ACTIVE_WINDOW_TRIGGER_MESSAGES = INITIAL_MESSAGE_LIMIT + 50;
const ACTIVE_WINDOW_TURN_BOUNDARY_LOOKBACK = 25;
const ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS = 60_000;

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
  const { projectId, sessionId, branchId, onLoadComplete, onLoadError } =
    options;
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
  const initialSnapshot = initialSnapshotRef.current;

  // Core state
  const [messages, setMessages] = useState<Message[]>(
    () => initialSnapshot?.messages ?? [],
  );
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

  // Initial load. Branch switches reload message content for the same
  // session without returning the page to its full-screen loading state.
  useEffect(() => {
    const sessionLoadKey = `${projectId}\u0000${sessionId}`;
    const isBranchReloadWithinSession =
      loadedSessionKeyRef.current === sessionLoadKey;
    const cachedSnapshot = getSessionSnapshot({
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
    }

    api
      .getSession(projectId, sessionId, undefined, {
        view: "canonical",
        tailCompactions: 2,
        maxMessages: INITIAL_MESSAGE_LIMIT,
        branchId,
      })
      .then((data) => {
        if (!isCurrent) return;
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

        // Mark ready and flush buffer
        initialLoadCompleteRef.current = true;
        flushBuffer();

        loadedSessionKeyRef.current = sessionLoadKey;
        setLoading(false);

        // The initial GET can legitimately miss contextUsage (bridge session
        // not yet readable from disk, first turn unfinished), and no later
        // event is guaranteed to fill the gap. Retry metadata once so the
        // context indicator appears without requiring a navigation.
        if (!data.session.contextUsage) {
          contextUsageRetryTimerRef.current = setTimeout(() => {
            contextUsageRetryTimerRef.current = undefined;
            if (isCurrent) void fetchSessionMetadata();
          }, CONTEXT_USAGE_RETRY_MS);
        }

        if (!supersededByCommittedRefresh) {
          // Notify parent only for the snapshot that was actually applied.
          onLoadComplete?.({
            session: data.session,
            status: data.ownership,
            permissionMode: data.permissionMode,
            modeVersion: data.modeVersion,
            pendingInputRequest: data.pendingInputRequest,
            slashCommands: data.slashCommands,
          });
        }
      })
      .catch((err) => {
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
      clearTimeout(contextUsageRetryTimerRef.current);
      contextUsageRetryTimerRef.current = undefined;
    };
  }, [
    projectId,
    sessionId,
    branchId,
    onLoadComplete,
    onLoadError,
    flushBuffer,
    applySessionSnapshot,
    fetchSessionMetadata,
  ]);

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
      if (data.session.provider === "kimi") {
        // Kimi's reader cannot honor afterMessageId because its normalized
        // message ids are synthesized from the full wire transcript. Treat
        // the response as an authoritative snapshot instead of appending it:
        // live Kimi messages use process UUIDs, so an incremental merge would
        // see every persisted copy as new and append old turns at the tail.
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
      if (data.session.provider !== "kimi") {
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
      const requestGeneration = ++refreshRequestGenerationRef.current;
      const resolvedBranchId =
        options?.branchId === undefined
          ? branchId
          : (options.branchId ?? undefined);
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
    [projectId, sessionId, branchId, applySessionSnapshot, onLoadComplete],
  );

  // Load older messages (previous chunk before the current truncation point)
  const loadOlderMessages = useCallback(async () => {
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
      setMessages((prev) =>
        truncateMessagesForEdit(prev, uuid, preserveTempId),
      );
    },
    [projectId, sessionId, branchId],
  );

  return {
    messages,
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

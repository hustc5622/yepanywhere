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
  getMessageId,
  mergeJSONLMessages,
  mergeStreamMessage,
} from "../lib/mergeMessages";
import { getProvider } from "../providers/registry";
import type { BrowserSessionMetadata, Message, SessionStatus } from "../types";

/** Content from a subagent (Task tool) */
export interface AgentContent {
  messages: Message[];
  status: "pending" | "running" | "completed" | "failed";
  /** Real-time context usage from message_start events */
  contextUsage?: {
    inputTokens: number;
    percentage: number;
  };
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
  session: BrowserSessionMetadata;
  status: SessionStatus;
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
  /** Whether initial load is in progress */
  loading: boolean;
  /** Session data from initial load */
  session: BrowserSessionMetadata | null;
  /** Set session data (for stream connected event) */
  setSession: React.Dispatch<
    React.SetStateAction<BrowserSessionMetadata | null>
  >;
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
  /** Direct messages setter (for clearing streaming placeholders) */
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Rewind/edit: drop the given uuid and everything after it */
  truncateMessagesBefore: (uuid: string) => void;
  /** Fetch new messages incrementally (for file change events) */
  fetchNewMessages: () => Promise<void>;
  /** Reload the authoritative session snapshot from REST */
  refreshSessionMessages: (options?: {
    branchId?: string | null;
  }) => Promise<BrowserSessionMetadata | null>;
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
}

function isCodexProvider(provider?: string): boolean {
  return provider === "codex" || provider === "codex-oss";
}

/**
 * Hard cap on messages fetched per chunk (initial load and each "load older").
 * Compact-boundary slicing already bounds compacted sessions; this also bounds
 * long sessions that were never compacted, keeping first paint fast. Older
 * messages load on demand via the top-of-list infinite scroll.
 */
const INITIAL_MESSAGE_LIMIT = 100;

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

  // Core state
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentContent, setAgentContent] = useState<AgentContentMap>({});
  const [toolUseToAgent, setToolUseToAgent] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<BrowserSessionMetadata | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [loadingTargetMessage, setLoadingTargetMessage] = useState(false);
  const sessionRef = useRef<BrowserSessionMetadata | null>(null);

  // Buffering: queue stream messages until initial load completes
  const streamBufferRef = useRef<
    Array<
      | { type: "message"; msg: Message }
      | { type: "subagent"; msg: Message; agentId: string }
    >
  >([]);
  const initialLoadCompleteRef = useRef(false);

  // Track provider for DAG ordering decisions
  const providerRef = useRef<string | undefined>(undefined);

  // Track last message ID for incremental fetching
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  const loadedMessageCountRef = useRef(0);
  // Highest timestamp observed from persisted JSONL messages.
  // Used to suppress startup replay events that are already on disk.
  const maxPersistedTimestampMsRef = useRef<number>(Number.NEGATIVE_INFINITY);
  // Tracks whether the same session has already completed its first load.
  // Branch changes reuse the page shell and should keep showing the
  // previous message list until the selected branch content arrives.
  const loadedSessionKeyRef = useRef<string | null>(null);

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
    (data: {
      session: BrowserSessionMetadata;
      messages: Message[];
      pagination?: PaginationInfo;
    }) => {
      sessionRef.current = data.session;
      setSession(data.session);
      setPagination(data.pagination);
      providerRef.current = data.session.provider;

      // Tag messages from JSONL as authoritative
      const taggedMessages = data.messages.map((m) => ({
        ...m,
        _source: "jsonl" as const,
      }));
      maxPersistedTimestampMsRef.current = Number.NEGATIVE_INFINITY;
      updatePersistedTimestampWatermark(taggedMessages);
      setMessages(
        isCodexProvider(data.session.provider)
          ? reconcileCodexLinearMessages(taggedMessages)
          : taggedMessages,
      );

      // Update lastMessageIdRef synchronously to avoid race condition:
      // stream "connected" event calls fetchNewMessages() immediately, but the
      // useEffect that normally updates lastMessageIdRef runs asynchronously.
      // Without this, fetchNewMessages() would use undefined and refetch everything.
      const lastMessage = taggedMessages[taggedMessages.length - 1];
      lastMessageIdRef.current = lastMessage
        ? getMessageId(lastMessage)
        : undefined;

      loadedMessageCountRef.current = taggedMessages.length;
      return data.session;
    },
    [updatePersistedTimestampWatermark],
  );

  // Initial load. Branch switches reload message content for the same
  // session without returning the page to its full-screen loading state.
  useEffect(() => {
    const sessionLoadKey = `${projectId}\u0000${sessionId}`;
    const isBranchReloadWithinSession =
      loadedSessionKeyRef.current === sessionLoadKey;
    let isCurrent = true;

    initialLoadCompleteRef.current = false;
    streamBufferRef.current = [];
    maxPersistedTimestampMsRef.current = Number.NEGATIVE_INFINITY;
    if (!isBranchReloadWithinSession) {
      setLoading(true);
      setAgentContent({});
    }

    api
      .getSession(projectId, sessionId, undefined, {
        tailCompactions: 2,
        maxMessages: INITIAL_MESSAGE_LIMIT,
        branchId,
      })
      .then((data) => {
        if (!isCurrent) return;
        applySessionSnapshot(data);

        // Mark ready and flush buffer
        initialLoadCompleteRef.current = true;
        flushBuffer();

        loadedSessionKeyRef.current = sessionLoadKey;
        setLoading(false);

        // Notify parent
        onLoadComplete?.({
          session: data.session,
          status: data.ownership,
          pendingInputRequest: data.pendingInputRequest,
          slashCommands: data.slashCommands,
        });
      })
      .catch((err) => {
        if (!isCurrent) return;
        initialLoadCompleteRef.current = true;
        flushBuffer();
        setLoading(false);
        onLoadError?.(err);
      });

    return () => {
      isCurrent = false;
    };
  }, [
    projectId,
    sessionId,
    branchId,
    onLoadComplete,
    onLoadError,
    flushBuffer,
    applySessionSnapshot,
  ]);

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
    },
    [],
  );

  // Fetch new messages incrementally (for file change events)
  const fetchNewMessages = useCallback(async () => {
    if (pagination?.hasNewerMessages) {
      return;
    }

    try {
      const data = await api.getSession(
        projectId,
        sessionId,
        lastMessageIdRef.current,
        { branchId },
      );
      if (data.messages.length > 0) {
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
      setSession((prev) =>
        prev ? { ...prev, ...data.session } : data.session,
      );
      onLoadComplete?.({
        session: data.session,
        status: data.ownership,
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
    updatePersistedTimestampWatermark,
    onLoadComplete,
  ]);

  const refreshSessionMessages = useCallback(
    async (options?: { branchId?: string | null }) => {
      const resolvedBranchId =
        options?.branchId === undefined
          ? branchId
          : (options.branchId ?? undefined);
      try {
        const data = await api.getSession(projectId, sessionId, undefined, {
          tailCompactions: 2,
          maxMessages: Math.max(
            INITIAL_MESSAGE_LIMIT,
            loadedMessageCountRef.current,
          ),
          branchId: resolvedBranchId,
        });
        const refreshedSession = applySessionSnapshot(data);
        onLoadComplete?.({
          session: data.session,
          status: data.ownership,
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
    setLoadingOlder(true);
    try {
      const data = await api.getSession(projectId, sessionId, undefined, {
        tailCompactions: 2,
        maxMessages: INITIAL_MESSAGE_LIMIT,
        beforeMessageId: pagination.truncatedBeforeMessageId,
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
    } catch {
      // Silent fail for loading older messages
    } finally {
      setLoadingOlder(false);
    }
  }, [
    projectId,
    sessionId,
    branchId,
    pagination,
    updatePersistedTimestampWatermark,
  ]);

  const loadNewerMessages = useCallback(async () => {
    if (!pagination?.hasNewerMessages || !pagination.truncatedAfterMessageId) {
      return;
    }
    setLoadingNewer(true);
    try {
      const data = await api.getSession(projectId, sessionId, undefined, {
        maxMessages: INITIAL_MESSAGE_LIMIT,
        afterWindowMessageId: pagination.truncatedAfterMessageId,
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
    } catch {
      // Silent fail for loading newer messages
    } finally {
      setLoadingNewer(false);
    }
  }, [
    projectId,
    sessionId,
    branchId,
    pagination,
    updatePersistedTimestampWatermark,
  ]);

  const loadTargetMessageWindow = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (!messageId) return false;
      setLoadingTargetMessage(true);
      try {
        const data = await api.getSession(projectId, sessionId, undefined, {
          aroundMessageId: messageId,
          maxMessages: INITIAL_MESSAGE_LIMIT,
          branchId,
        });
        const targetFound =
          data.pagination?.targetMessageFound !== false &&
          data.messages.some((message) => getMessageId(message) === messageId);
        if (!targetFound) {
          return false;
        }

        const loadedSession = applySessionSnapshot(data);
        onLoadComplete?.({
          session: data.session,
          status: data.ownership,
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
    [projectId, sessionId, branchId, applySessionSnapshot, onLoadComplete],
  );

  // Fetch session metadata only
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      // For new sessions, prev may be null if JSONL didn't exist on initial load
      setSession((prev) =>
        prev ? { ...prev, ...data.session } : data.session,
      );
    } catch {
      // Silent fail for metadata updates
    }
  }, [projectId, sessionId]);

  /**
   * Rewind/edit: drop the message with `uuid` and everything after it (keeping
   * everything before). Used when editing a past prompt — we optimistically
   * remove the original message and its old branch so the freshly streamed
   * branch replaces it instead of stacking. We key on the edited message's OWN
   * uuid (always present in the list) rather than its parent, which may be a
   * non-rendered entry like a system message. No-op if the uuid isn't found.
   */
  const truncateMessagesBefore = useCallback((uuid: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => getMessageId(m) === uuid);
      if (idx === -1) return prev;
      return prev.slice(0, idx);
    });
  }, []);

  return {
    messages,
    agentContent,
    toolUseToAgent,
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
  };
}

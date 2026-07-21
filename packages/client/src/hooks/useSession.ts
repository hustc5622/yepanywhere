import {
  type AgentActivity,
  type MarkdownAugment,
  type ProviderName,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { getMessageId } from "../lib/mergeMessages";
import { findPendingTasks } from "../lib/pendingTasks";
import { extractSessionIdFromFileEvent } from "../lib/sessionFile";
import { generateUUID } from "../lib/uuid";
import type {
  InputRequest,
  Message,
  PermissionMode,
  Session,
  SessionLastTurnStatus,
  SessionRetryStatus,
  SessionStatus,
} from "../types";
import { usePendingMessages } from "./usePendingMessages";
import { useSessionPermissionMode } from "./useSessionPermissionMode";

// Re-exported for backward compatibility with existing consumers/tests that
// import these from useSession; the implementation now lives in
// usePendingMessages.
export {
  type PendingMessage,
  reconcilePendingMessagesWithConfirmedMessages,
} from "./usePendingMessages";

/** Bridge-reported health of the most recent turn (retry/failure surface). */
export interface SessionTurnHealth {
  lastTurnStatus?: SessionLastTurnStatus;
  lastErrorMessage?: string;
  retryStatus?: SessionRetryStatus;
}

export function sessionTurnHealthFromSession(
  session: Pick<Session, "lastTurnStatus" | "lastErrorMessage" | "retryStatus">,
): SessionTurnHealth | null {
  return session.lastTurnStatus ||
    session.lastErrorMessage ||
    session.retryStatus
    ? {
        lastTurnStatus: session.lastTurnStatus,
        lastErrorMessage: session.lastErrorMessage,
        retryStatus: session.retryStatus,
      }
    : null;
}
import {
  type FileChangeEvent,
  type ProcessStateEvent,
  type SessionMetadataChangedEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
  useFileActivity,
} from "./useFileActivity";
import {
  type AgentContentMap,
  type SessionLoadResult,
  useSessionMessages,
} from "./useSessionMessages";
import { useSessionStream } from "./useSessionStream";
import { useSessionWatchStream } from "./useSessionWatchStream";
import {
  type StreamingMarkdownCallbacks,
  useStreamingContent,
} from "./useStreamingContent";

export type ProcessState = "idle" | "in-turn" | "waiting-input" | "hold";

function processStateFromActivity(
  activity: AgentActivity | undefined,
): ProcessState | undefined {
  if (
    activity === "idle" ||
    activity === "in-turn" ||
    activity === "waiting-input" ||
    activity === "hold"
  ) {
    return activity;
  }
  if (activity === "terminated") {
    return "idle";
  }
  return undefined;
}

export function processStateFromProcessEvent(
  event: Pick<ProcessStateEvent, "activity" | "pendingInputType">,
): ProcessState | undefined {
  // pendingInputType is the direct signal that a prompt exists. In
  // particular, bridge snapshots can briefly pair it with the provider's
  // underlying in-turn/busy activity while the tool call is blocked.
  if (event.pendingInputType) return "waiting-input";
  return processStateFromActivity(event.activity);
}

function keepPersistedPendingInputForSession(
  request: InputRequest | null,
  sessionId: string,
): InputRequest | null {
  return request?.source === "persisted" && request.sessionId === sessionId
    ? request
    : null;
}

// Re-export types from useSessionMessages
export type { AgentContent, AgentContentMap } from "./useSessionMessages";

const THROTTLE_MS = 500;
const HISTORY_REWRITE_RETRY_DELAYS_MS = [
  120, 300, 600, 1_000, 1_500, 2_500, 4_000,
] as const;
// Cap the conditional backoff so a dropped rollback/turn event can't leave the
// edit spinner spinning indefinitely. Once elapsed crosses this budget we do a
// single unconditional refresh and clear the pending state.
const HISTORY_REWRITE_MAX_WAIT_MS = 12_000;

export interface HistoryRewriteSyncTarget {
  expectedPrompt: string;
  previousActiveBranchId: string | null;
}

interface HistoryRewriteSyncRequest extends HistoryRewriteSyncTarget {
  id: number;
  startedAt: number;
}

export function isCodexHistoryRewriteSnapshotReady(
  session: Session,
  target: HistoryRewriteSyncTarget,
): boolean {
  const branchState = session.codexBranchState ?? session.branchState;
  const activeBranchId = branchState?.activeBranchId;
  if (
    !branchState ||
    !activeBranchId ||
    activeBranchId === target.previousActiveBranchId
  ) {
    return false;
  }

  const activeBranch = branchState.branches.find(
    (branch) => branch.id === activeBranchId,
  );
  if (!activeBranch || activeBranch.siblingCount < 2) return false;

  const expectedPrompt = target.expectedPrompt.trim();
  const persistedPrompt = activeBranch.prompt.trim();
  return (
    persistedPrompt === expectedPrompt ||
    persistedPrompt.startsWith(`${expectedPrompt}\n`)
  );
}

// Re-export StreamingMarkdownCallbacks for consumers
export type { StreamingMarkdownCallbacks } from "./useStreamingContent";

/** Deferred message queued server-side, waiting for agent's turn to end */
export interface DeferredMessage {
  tempId?: string;
  content: string;
  timestamp: string;
}

function normalizeMetadataTitle(title: string): string | undefined {
  const normalized = title.trim();
  return normalized || undefined;
}

export function mergeSessionMetadataChange(
  session: Session | null,
  event: SessionMetadataChangedEvent,
  expectedSessionId: string,
): Session | null {
  if (
    !session ||
    event.sessionId !== expectedSessionId ||
    (event.title === undefined && event.aiTitle === undefined)
  ) {
    return session;
  }

  return {
    ...session,
    ...(event.title !== undefined && {
      customTitle: normalizeMetadataTitle(event.title),
    }),
    ...(event.aiTitle !== undefined && {
      aiTitle: normalizeMetadataTitle(event.aiTitle),
    }),
  };
}

export function shouldRefreshOpenCodeAuthoritativeSnapshot(
  provider: Session["provider"] | undefined,
  owner: SessionStatus["owner"],
  processState: ProcessState,
  eventSessionId: string,
  expectedSessionId: string,
): boolean {
  return (
    provider === "opencode" &&
    owner === "self" &&
    processState === "idle" &&
    eventSessionId === expectedSessionId
  );
}

export function shouldRefreshFullPersistedSession(
  provider: Session["provider"] | undefined,
): boolean {
  return (
    provider === "codex" || provider === "codex-oss" || provider === "opencode"
  );
}

function extractUserMessageText(
  sdkMessage: Record<string, unknown>,
): string | null {
  const message = sdkMessage.message as
    | { content?: unknown; role?: unknown }
    | undefined;
  const content = message?.content;

  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter((part) => part.length > 0);
    if (textParts.length === 0) return null;
    const joined = textParts.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }

  return null;
}

export function useSession(
  projectId: string,
  sessionId: string,
  initialStatus?: { owner: "self"; processId: string },
  streamingMarkdownCallbacks?: StreamingMarkdownCallbacks,
  branchId?: string,
) {
  // Use initial status if provided (from navigation state) to connect stream immediately
  const [status, setStatus] = useState<SessionStatus>(
    initialStatus ?? { owner: "none" },
  );
  // If we have initial status, assume process is in-turn (just started)
  const [processState, setProcessState] = useState<ProcessState>(
    initialStatus ? "in-turn" : "idle",
  );
  const [pendingInputRequest, setPendingInputRequest] =
    useState<InputRequest | null>(null);
  const [turnHealth, setTurnHealth] = useState<SessionTurnHealth | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [historyRewriteRequest, setHistoryRewriteRequest] =
    useState<HistoryRewriteSyncRequest | null>(null);
  const [historyRewriteSignal, setHistoryRewriteSignal] = useState(0);
  const historyRewriteSequenceRef = useRef(0);
  const historyRewriteAttemptRef = useRef(0);
  const historyRewriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const handledHistoryRewriteSignalRef = useRef(0);

  const signalHistoryRewriteSync = useCallback(() => {
    setHistoryRewriteSignal((value) => value + 1);
  }, []);

  const beginHistoryRewriteSync = useCallback(
    (target: HistoryRewriteSyncTarget) => {
      historyRewriteSequenceRef.current += 1;
      historyRewriteAttemptRef.current = 0;
      handledHistoryRewriteSignalRef.current = historyRewriteSignal;
      if (historyRewriteTimerRef.current) {
        clearTimeout(historyRewriteTimerRef.current);
        historyRewriteTimerRef.current = null;
      }
      setHistoryRewriteRequest({
        ...target,
        id: historyRewriteSequenceRef.current,
        startedAt: Date.now(),
      });
    },
    [historyRewriteSignal],
  );

  // Actual session ID from server (may differ from URL sessionId during temp→real ID transition)
  // This happens when createSession returns before the SDK sends the real session ID
  const [actualSessionId, setActualSessionId] = useState<string>(sessionId);

  // Track last stream activity timestamp for engagement tracking
  // This includes both main session and subagent messages, so we can properly
  // mark sessions as "seen" even when subagent content arrives (which doesn't
  // update the parent session file's mtime until completion)
  const [lastStreamActivityAt, setLastStreamActivityAt] = useState<
    string | null
  >(null);

  // Deferred messages queue - messages queued server-side waiting for agent's turn to end
  const [deferredMessages, setDeferredMessages] = useState<DeferredMessage[]>(
    [],
  );

  // Compacting state - true when context is being compressed
  const [isCompacting, setIsCompacting] = useState(false);

  // Markdown augments loaded from REST response (keyed by message ID)
  const [markdownAugments, setMarkdownAugments] = useState<
    Record<string, MarkdownAugment>
  >({});

  // Permission mode (UI-selected + server-confirmed) is owned by a dedicated hook.
  const {
    permissionMode,
    modeVersion,
    applyServerModeUpdate,
    setPermissionMode,
  } = useSessionPermissionMode(sessionId, status.owner);
  // Track whether we've already processed a stream "connected" event in this mount.
  // For Codex providers, the first connected-event catch-up fetch can duplicate
  // freshly streamed messages because JSONL and stream IDs are not yet aligned.
  const hasHandledConnectedEventRef = useRef(false);

  // Reset connected-event tracking when switching sessions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally runs on session switches
  useEffect(() => {
    hasHandledConnectedEventRef.current = false;
    setTurnHealth(null);
    setHistoryRewriteRequest(null);
    if (historyRewriteTimerRef.current) {
      clearTimeout(historyRewriteTimerRef.current);
      historyRewriteTimerRef.current = null;
    }
  }, [sessionId]);

  // Slash commands available for this session (from init message)
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  // Tools available for this session (from init message)
  const [sessionTools, setSessionTools] = useState<string[]>([]);
  // MCP servers available for this session (from init message)
  const [mcpServers, setMcpServers] = useState<string[]>([]);

  // Handle initial load completion from useSessionMessages
  const handleLoadComplete = useCallback(
    (result: SessionLoadResult) => {
      // A durable provider ID may arrive while the client was disconnected.
      // Let REST canonicalization repair the URL even when the live ID-change
      // event was missed.
      if (result.session.id && result.session.id !== sessionId) {
        setActualSessionId(result.session.id);
      }

      // Only update status from REST if we don't already have an owned status from navigation.
      // This prevents a race condition where:
      // 1. Session created with initialStatus = {owner: "self"}
      // 2. stream connects because status.owner === "self"
      // 3. REST API returns status = {owner: "none"} (stale)
      // 4. setStatus({owner: "none"}) disconnects stream before it receives events
      // The owned status from initialStatus should only be changed by stream events.
      setStatus((prev) => {
        // If we already have owned status (from initialStatus), keep it unless REST also says owned
        if (prev.owner === "self" && result.status.owner !== "self") {
          return prev;
        }
        return result.status;
      });

      // Sync permission mode from server if owned
      if (
        result.status.owner === "self" &&
        result.status.permissionMode &&
        result.status.modeVersion !== undefined
      ) {
        applyServerModeUpdate(
          result.status.permissionMode,
          result.status.modeVersion,
        );
      }
      // Set pending input request from API response immediately. This also
      // clears stale prompts after another client already approved/denied them.
      setPendingInputRequest(
        result.pendingInputRequest
          ? (result.pendingInputRequest as InputRequest)
          : null,
      );
      const loadedProcessState = processStateFromActivity(
        result.session.runtime?.activity ?? result.session.activity,
      );
      if (loadedProcessState) {
        setProcessState(loadedProcessState);
      } else if (result.status.owner === "none") {
        setProcessState("idle");
      }
      setTurnHealth(sessionTurnHealthFromSession(result.session));
      // Set slash commands from API response so the "/" button appears reliably
      // (the SSE init message that normally carries these is discarded after ~30s)
      if (result.slashCommands?.length) {
        setSlashCommands(result.slashCommands.map((c) => c.name));
      }
    },
    [applyServerModeUpdate, sessionId],
  );

  // Handle initial load error
  const handleLoadError = useCallback((err: Error) => {
    setError(err);
  }, []);

  // Use the session messages hook for message state and stream buffering
  const {
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
  } = useSessionMessages({
    projectId,
    sessionId,
    branchId,
    onLoadComplete: handleLoadComplete,
    onLoadError: handleLoadError,
  });

  useEffect(() => {
    if (!historyRewriteRequest) return;

    let cancelled = false;
    const requestId = historyRewriteRequest.id;
    const attemptRefresh = async () => {
      historyRewriteTimerRef.current = null;
      const refreshed = await refreshSessionMessages({
        branchId: null,
        acceptSnapshot: ({ session: snapshotSession }) =>
          isCodexHistoryRewriteSnapshotReady(
            snapshotSession,
            historyRewriteRequest,
          ),
      });
      if (cancelled) return;

      if (refreshed) {
        setHistoryRewriteRequest((current) =>
          current?.id === requestId ? null : current,
        );
        return;
      }

      if (
        Date.now() - historyRewriteRequest.startedAt >=
        HISTORY_REWRITE_MAX_WAIT_MS
      ) {
        await refreshSessionMessages({ branchId: null });
        if (!cancelled) {
          setHistoryRewriteRequest((current) =>
            current?.id === requestId ? null : current,
          );
        }
        return;
      }

      const attempt = historyRewriteAttemptRef.current;
      historyRewriteAttemptRef.current = attempt + 1;
      const baseDelay =
        HISTORY_REWRITE_RETRY_DELAYS_MS[
          Math.min(attempt, HISTORY_REWRITE_RETRY_DELAYS_MS.length - 1)
        ] ?? 4_000;
      // Never schedule past the wait budget: clamp so the final attempt fires
      // right at the cap and takes the unconditional-refresh branch above.
      const remaining =
        HISTORY_REWRITE_MAX_WAIT_MS -
        (Date.now() - historyRewriteRequest.startedAt);
      const delay = Math.max(0, Math.min(baseDelay, remaining));
      historyRewriteTimerRef.current = setTimeout(attemptRefresh, delay);
    };

    const hasFreshSignal =
      historyRewriteSignal !== handledHistoryRewriteSignalRef.current;
    handledHistoryRewriteSignalRef.current = historyRewriteSignal;
    historyRewriteTimerRef.current = setTimeout(
      attemptRefresh,
      hasFreshSignal ? 25 : HISTORY_REWRITE_RETRY_DELAYS_MS[0],
    );

    return () => {
      cancelled = true;
      if (historyRewriteTimerRef.current) {
        clearTimeout(historyRewriteTimerRef.current);
        historyRewriteTimerRef.current = null;
      }
    };
  }, [historyRewriteRequest, historyRewriteSignal, refreshSessionMessages]);

  // Optimistic pending-message queue, reconciled against `messages` inside the hook.
  const {
    pendingMessages,
    setPendingMessages,
    addPendingMessage,
    removePendingMessage,
    updatePendingMessage,
  } = usePendingMessages(messages);

  // OpenCode's live user echo carries Yep's temporary UUID while persisted
  // history uses the provider-native message ID required for edit forks. Once
  // a turn settles, replace the whole visible snapshot so an incremental
  // `afterMessageId` fetch cannot skip the earlier authoritative user message.
  const openCodeSnapshotRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const scheduleOpenCodeAuthoritativeRefresh = useCallback(() => {
    if (session?.provider !== "opencode") return;

    if (openCodeSnapshotRefreshTimerRef.current) {
      clearTimeout(openCodeSnapshotRefreshTimerRef.current);
    }
    openCodeSnapshotRefreshTimerRef.current = setTimeout(() => {
      openCodeSnapshotRefreshTimerRef.current = null;
      void refreshSessionMessages();
    }, 120);
  }, [refreshSessionMessages, session?.provider]);

  useEffect(() => {
    return () => {
      if (openCodeSnapshotRefreshTimerRef.current) {
        clearTimeout(openCodeSnapshotRefreshTimerRef.current);
      }
    };
  }, []);

  // Set hold state (soft pause) for the session
  const setHold = useCallback(
    async (hold: boolean) => {
      // Only works if there's an active process
      if (status.owner !== "self" && status.owner !== "external") {
        console.warn("Cannot set hold: no active process");
        return;
      }

      try {
        const result = await api.setHold(sessionId, hold);
        // Process state will be updated via stream state-change event
        // but we can optimistically update if needed
        if (result.state === "hold") {
          setProcessState("hold");
        } else if (result.state === "in-turn") {
          setProcessState("in-turn");
        }
      } catch (err) {
        console.warn("Failed to set hold:", err);
      }
    },
    [sessionId, status.owner],
  );

  // Throttle state for incremental fetching
  const throttleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: boolean;
  }>({ timer: null, pending: false });

  // Track if we've loaded pending agents for this session
  const pendingAgentsLoadedRef = useRef<string | null>(null);

  // Load pending agent content on session load
  // This handles page reload while Tasks are running: loads agent content-so-far
  useEffect(() => {
    // Only run once per session after initial load
    if (loading || pendingAgentsLoadedRef.current === sessionId) return;
    if (messages.length === 0) return;

    const loadPendingAgents = async () => {
      // Mark as loaded to prevent re-running
      pendingAgentsLoadedRef.current = sessionId;

      // Find pending Tasks (tool_use without matching tool_result)
      const pendingTasks = findPendingTasks(messages);
      if (pendingTasks.length === 0) return;

      try {
        // Get agent mappings (toolUseId → agentId)
        const { mappings } = await api.getAgentMappings(projectId, sessionId);
        const mappingsMap = new Map(
          mappings.map((m) => [m.toolUseId, m.agentId]),
        );

        // Update the toolUseToAgent state with loaded mappings
        // This allows TaskRenderer to access agentContent even after page reload
        setToolUseToAgent((prev) => {
          const next = new Map(prev);
          for (const [toolUseId, agentId] of mappingsMap) {
            if (!next.has(toolUseId)) {
              next.set(toolUseId, agentId);
            }
          }
          return next;
        });

        // Load content for each pending task that has an agent file
        for (const task of pendingTasks) {
          const agentId = mappingsMap.get(task.toolUseId);
          if (!agentId) continue;

          try {
            const agentData = await api.getAgentSession(
              projectId,
              sessionId,
              agentId,
            );

            // Merge into agentContent state, deduping by message ID
            // Use getMessageId to prefer uuid over id
            setAgentContent((prev) => {
              const existing = prev[agentId];
              if (existing && existing.messages.length > 0) {
                // Already have content (maybe from stream), merge without duplicates
                const existingIds = new Set(
                  existing.messages.map((m) => getMessageId(m)),
                );
                const newMessages = agentData.messages.filter(
                  (m) => !existingIds.has(getMessageId(m)),
                );
                return {
                  ...prev,
                  [agentId]: {
                    messages: [...existing.messages, ...newMessages],
                    status: agentData.status,
                  },
                };
              }
              // No existing content, use loaded data
              return {
                ...prev,
                [agentId]: agentData,
              };
            });
          } catch {
            // Skip agents that can't be loaded
          }
        }
      } catch {
        // Silent fail for agent mappings - not critical
      }
    };

    loadPendingAgents();
  }, [
    loading,
    messages,
    projectId,
    sessionId,
    setAgentContent,
    setToolUseToAgent,
  ]);

  const fetchPersistedSessionChanges = useCallback(() => {
    const provider = session?.provider;
    // Codex can rewrite recent transcript entries, while OpenCode updates tool
    // parts in place inside the latest assistant message. An exclusive
    // `afterMessageId` fetch misses both cases, so reload the authoritative
    // bounded window instead.
    if (shouldRefreshFullPersistedSession(provider)) {
      void refreshSessionMessages();
      return;
    }

    void fetchNewMessages();
  }, [fetchNewMessages, refreshSessionMessages, session?.provider]);

  // Leading + trailing edge throttle:
  // - Leading: fires immediately on first call
  // - Trailing: fires again after timeout if events came during window
  // This ensures no updates are lost
  const throttledFetch = useCallback(() => {
    const ref = throttleRef.current;

    if (!ref.timer) {
      // No active throttle - fire immediately (LEADING EDGE)
      fetchPersistedSessionChanges();
      ref.timer = setTimeout(() => {
        ref.timer = null;
        if (ref.pending) {
          ref.pending = false;
          throttledFetch(); // Fire again (TRAILING EDGE)
        }
      }, THROTTLE_MS);
    } else {
      // Throttled - mark as pending for trailing edge
      ref.pending = true;
    }
  }, [fetchPersistedSessionChanges]);

  // Handle file changes - for non-owned sessions only
  // For owned sessions, stream provides real-time messages and session-updated events
  // provide metadata (title, messageCount), so we don't need to poll the API
  const handleFileChange = useCallback(
    (event: FileChangeEvent) => {
      // Only care about session files
      if (event.fileType !== "session" && event.fileType !== "agent-session") {
        return;
      }

      // Check if file matches current session (exact match to avoid false positives)
      // File format is: projects/<projectId>/<sessionId>.jsonl
      const fileSessionId = extractSessionIdFromFileEvent(event);
      if (fileSessionId !== sessionId) {
        return;
      }

      // For owned sessions: messages come via stream stream, metadata via session-updated event
      // No API call needed - skip file change processing entirely
      if (status.owner === "self") {
        if (historyRewriteRequest) {
          signalHistoryRewriteSync();
        }
        return;
      }

      // For external/idle sessions: fetch both messages and metadata via API
      throttledFetch();
    },
    [
      historyRewriteRequest,
      sessionId,
      signalHistoryRewriteSync,
      status.owner,
      throttledFetch,
    ],
  );

  // Handle session content updates via stream (title, messageCount, updatedAt, contextUsage)
  const handleSessionUpdated = useCallback(
    (event: SessionUpdatedEvent) => {
      if (event.sessionId !== sessionId) return;

      // Update session metadata from stream event (no API call needed)
      setSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ...(event.title !== undefined && { title: event.title }),
          ...(event.messageCount !== undefined && {
            messageCount: event.messageCount,
          }),
          ...(event.updatedAt !== undefined && {
            updatedAt: event.updatedAt,
          }),
          ...(event.contextUsage !== undefined && {
            contextUsage: event.contextUsage,
          }),
          ...(event.model !== undefined && { model: event.model }),
          ...(event.reasoningEffort !== undefined && {
            reasoningEffort: event.reasoningEffort,
          }),
          ...(event.serviceTier !== undefined && {
            serviceTier: event.serviceTier,
          }),
        };
      });

      if (
        historyRewriteRequest &&
        (session?.provider === "codex" || session?.provider === "codex-oss")
      ) {
        signalHistoryRewriteSync();
      }

      if (
        status.owner === "external" &&
        event.trigger === "codex-plan-updated"
      ) {
        throttledFetch();
      }

      if (
        shouldRefreshOpenCodeAuthoritativeSnapshot(
          session?.provider,
          status.owner,
          processState,
          event.sessionId,
          sessionId,
        )
      ) {
        scheduleOpenCodeAuthoritativeRefresh();
      }
    },
    [
      processState,
      historyRewriteRequest,
      scheduleOpenCodeAuthoritativeRefresh,
      session?.provider,
      sessionId,
      setSession,
      signalHistoryRewriteSync,
      status.owner,
      throttledFetch,
    ],
  );

  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      setSession((prev) => mergeSessionMetadataChange(prev, event, sessionId));
    },
    [sessionId, setSession],
  );

  // Listen for session status changes via stream
  const handleSessionStatusChange = useCallback(
    (event: SessionStatusEvent) => {
      if (event.sessionId === sessionId) {
        setStatus(event.ownership);
      }
    },
    [sessionId],
  );

  // Listen for process state changes via activity bus as a backup for session stream
  // This handles the race condition where the session stream might miss a status event
  // (e.g., when backgrounding the tab quickly after starting a session)
  const handleProcessStateChange = useCallback(
    async (event: ProcessStateEvent) => {
      if (event.sessionId !== sessionId) return;

      // Update process state from activity bus
      const nextProcessState = processStateFromProcessEvent(event);
      if (nextProcessState) {
        setProcessState(nextProcessState);
      }
      if (historyRewriteRequest) {
        signalHistoryRewriteSync();
      }
      // Mirror bridge-reported turn health (retry/failure). Events always
      // carry the server's latest truth, so absence clears stale state.
      setTurnHealth(
        event.lastTurnStatus || event.lastErrorMessage || event.retryStatus
          ? {
              lastTurnStatus: event.lastTurnStatus,
              lastErrorMessage: event.lastErrorMessage,
              retryStatus: event.retryStatus,
            }
          : null,
      );
      if (
        shouldRefreshOpenCodeAuthoritativeSnapshot(
          session?.provider,
          status.owner,
          nextProcessState ?? processState,
          event.sessionId,
          sessionId,
        )
      ) {
        scheduleOpenCodeAuthoritativeRefresh();
      }

      // Always refresh the current request when the event advertises pending
      // input. Codex can emit multiple approvals in one turn, and OpenCode's
      // underlying runtime may still report in-turn while permission-blocked.
      // Use the dedicated endpoint so the focused page only refreshes the
      // prompt instead of reloading all session metadata.
      if (event.pendingInputType) {
        api
          .getPendingInputRequest(sessionId)
          .then((result) => {
            setPendingInputRequest(result.request ?? null);
          })
          .catch(() => {
            // Non-critical. A later activity event or reconnect will refresh it.
          });
      } else {
        setPendingInputRequest((prev) =>
          keepPersistedPendingInputForSession(prev, sessionId),
        );
      }
    },
    [
      processState,
      historyRewriteRequest,
      scheduleOpenCodeAuthoritativeRefresh,
      session?.provider,
      sessionId,
      signalHistoryRewriteSync,
      status.owner,
    ],
  );

  // Handle activity bus reconnection (e.g., after phone screen wake).
  // Catches up on messages and ownership changes that occurred while disconnected.
  // Without this, a session that completed while the screen was off would show stale
  // data because the session stream unsubscribes when ownership becomes "none" and
  // nobody triggers a persisted-session refresh.
  const handleActivityReconnect = useCallback(async () => {
    if (historyRewriteRequest) {
      signalHistoryRewriteSync();
    } else {
      fetchPersistedSessionChanges();
    }
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      setStatus(data.ownership);
      setPendingInputRequest(data.pendingInputRequest ?? null);
      setTurnHealth(sessionTurnHealthFromSession(data.session));
      const nextProcessState = processStateFromActivity(
        data.session.runtime?.activity ?? data.session.activity,
      );
      if (nextProcessState) {
        setProcessState(nextProcessState);
      } else if (data.ownership.owner === "none") {
        setProcessState("idle");
      }
    } catch {
      // Silent fail - non-critical
    }
  }, [
    projectId,
    sessionId,
    fetchPersistedSessionChanges,
    historyRewriteRequest,
    signalHistoryRewriteSync,
  ]);

  useFileActivity({
    onSessionStatusChange: handleSessionStatusChange,
    onFileChange: handleFileChange,
    onSessionMetadataChange: handleSessionMetadataChange,
    onSessionUpdated: handleSessionUpdated,
    onProcessStateChange: handleProcessStateChange,
    onReconnect: handleActivityReconnect,
  });

  // Focused watch stream for non-owned sessions.
  // This is a targeted server-side watch of the currently viewed session file,
  // independent from broad global activity-tree watch behavior.
  const handleSessionWatchChange = useCallback(() => {
    if (status.owner === "self") {
      if (historyRewriteRequest) signalHistoryRewriteSync();
      return;
    }
    throttledFetch();
  }, [
    historyRewriteRequest,
    signalHistoryRewriteSync,
    status.owner,
    throttledFetch,
  ]);

  const sessionWatchTarget = useMemo(
    () =>
      status.owner === "self" && !historyRewriteRequest
        ? null
        : {
            sessionId,
            projectId,
            provider: session?.provider,
          },
    [
      historyRewriteRequest,
      projectId,
      session?.provider,
      sessionId,
      status.owner,
    ],
  );

  const { connected: sessionWatchConnected } = useSessionWatchStream(
    sessionWatchTarget,
    {
      onChange: handleSessionWatchChange,
    },
  );

  // Cleanup throttle timers
  useEffect(() => {
    return () => {
      if (throttleRef.current.timer) {
        clearTimeout(throttleRef.current.timer);
      }
    };
  }, []);

  // Callback for agent context usage updates
  const handleAgentContextUsage = useCallback(
    (agentId: string, usage: { inputTokens: number; percentage: number }) => {
      setAgentContent((prev) => {
        const existing = prev[agentId] ?? {
          messages: [],
          status: "running",
        };
        return {
          ...prev,
          [agentId]: { ...existing, contextUsage: usage },
        };
      });
    },
    [setAgentContent],
  );

  // Use streaming content hook for handling stream_event stream messages
  const {
    handleStreamEvent,
    clearStreaming,
    cleanup: cleanupStreaming,
  } = useStreamingContent({
    onUpdateMessage: handleStreamingUpdate,
    onUpdateMessages: handleStreamingUpdates,
    onToolUseMapping: registerToolUseAgent,
    onAgentContextUsage: handleAgentContextUsage,
    contextWindowSize: getModelContextWindow(session?.model, session?.provider),
    streamingMarkdownCallbacks,
  });

  // Cleanup streaming timers on unmount
  useEffect(() => {
    return () => {
      cleanupStreaming();
    };
  }, [cleanupStreaming]);

  const clearStreamingPlaceholders = useCallback(
    (options?: { agentId?: string; allAgents?: boolean; main?: boolean }) => {
      clearStreaming();

      const shouldClearMain = options?.main ?? !options?.agentId;
      if (shouldClearMain) {
        setMessages((prev) => {
          const filtered = prev.filter((m) => !m._isStreaming);
          return filtered.length === prev.length ? prev : filtered;
        });
      }

      const agentId = options?.agentId;
      if (!options?.allAgents && !agentId) return;

      setAgentContent((prev) => {
        let next: AgentContentMap | null = null;

        for (const [currentAgentId, existing] of Object.entries(prev)) {
          if (agentId && currentAgentId !== agentId) continue;

          const filtered = existing.messages.filter((m) => !m._isStreaming);
          if (filtered.length === existing.messages.length) continue;

          if (!next) next = { ...prev };
          next[currentAgentId] = { ...existing, messages: filtered };
        }

        return next ?? prev;
      });
    },
    [clearStreaming, setAgentContent, setMessages],
  );

  // Subscribe to live updates
  const handleStreamMessage = useCallback(
    (data: { eventType: string; [key: string]: unknown }) => {
      if (data.eventType === "message") {
        // Track stream activity for engagement tracking
        // This ensures sessions are marked as "seen" even when receiving
        // subagent content (which doesn't update parent session file mtime)
        setLastStreamActivityAt(new Date().toISOString());

        // The message event contains the SDK message directly
        // Pass through all fields without stripping
        const sdkMessage = data as Record<string, unknown> & {
          eventType: string;
        };

        // Extract id - prefer uuid, fall back to id field, then generate
        const rawUuid = sdkMessage.uuid;
        const rawId = sdkMessage.id;
        const id: string =
          (typeof rawUuid === "string" && rawUuid.length > 0
            ? rawUuid
            : null) ??
          (typeof rawId === "string" && rawId.length > 0 ? rawId : null) ??
          `msg-${generateUUID()}`;

        // Extract type and role
        const msgType =
          typeof sdkMessage.type === "string" ? sdkMessage.type : undefined;
        const msgRole = sdkMessage.role as Message["role"] | undefined;

        if (
          msgType === "system" &&
          sdkMessage.subtype === "history_rewrite_complete"
        ) {
          signalHistoryRewriteSync();
          return;
        }

        // Handle stream_event messages (partial content from streaming API)
        // Delegate to useStreamingContent hook
        if (msgType === "stream_event") {
          if (handleStreamEvent(sdkMessage)) {
            return; // Event was handled, don't process as regular message
          }
        }

        // For assistant messages, clear the matching streaming placeholder.
        if (msgType === "assistant") {
          // Check if this is a subagent message
          // Use parentToolUseId as the routing key (it's the Task tool_use id)
          const isSubagentMsg =
            sdkMessage.isSubagent &&
            typeof sdkMessage.parentToolUseId === "string";
          const msgAgentId = isSubagentMsg
            ? (sdkMessage.parentToolUseId as string)
            : undefined;

          if (msgAgentId) {
            // Remove streaming placeholders from this agent's content.
            clearStreamingPlaceholders({ agentId: msgAgentId });
          } else {
            // Remove streaming placeholder messages from main messages.
            clearStreamingPlaceholders();
          }
        }

        // Build message object, preserving all SDK fields
        const incoming: Message = {
          ...(sdkMessage as Partial<Message>),
          id,
          type: msgType,
          // Ensure role is set for user/assistant types
          role:
            msgRole ??
            (msgType === "user" || msgType === "assistant"
              ? msgType
              : undefined),
        };

        // Remove eventType from the message (it's stream envelope, not message data)
        (incoming as { eventType?: string }).eventType = undefined;

        // Extract slash_commands, tools, and mcp_servers from init messages
        if (msgType === "system" && sdkMessage.subtype === "init") {
          if (Array.isArray(sdkMessage.slash_commands)) {
            setSlashCommands(sdkMessage.slash_commands as string[]);
          }
          if (Array.isArray(sdkMessage.tools)) {
            setSessionTools(sdkMessage.tools as string[]);
          }
          if (Array.isArray(sdkMessage.mcp_servers)) {
            setMcpServers(sdkMessage.mcp_servers as string[]);
          }
        }

        // Handle status messages (compacting indicator)
        if (msgType === "system" && sdkMessage.subtype === "status") {
          const status = sdkMessage.status as "compacting" | null;
          setIsCompacting(status === "compacting");
          // Don't add status messages to the message list - they're transient
          return;
        }

        // Clear compacting state when compact_boundary arrives (compaction complete)
        if (msgType === "system" && sdkMessage.subtype === "compact_boundary") {
          setIsCompacting(false);
          // Let the message be added to show the completed compaction indicator
        }

        // Handle tempId for pending message resolution
        // When server echoes back tempId, remove from pending queue
        const tempId = sdkMessage.tempId as string | undefined;
        if (msgType === "user" && tempId) {
          removePendingMessage(tempId);
        } else if (msgType === "user") {
          // Fallback for providers that omit tempId on user echo:
          // clear one matching optimistic pending message by content.
          const incomingText = extractUserMessageText(sdkMessage);
          if (incomingText) {
            setPendingMessages((prev) => {
              const idx = prev.findIndex(
                (p) => p.content.trim() === incomingText,
              );
              if (idx === -1) return prev;
              return prev.filter((_, i) => i !== idx);
            });
          }
        }

        // Route subagent messages to agentContent instead of main messages
        // This keeps the parent session's DAG clean and allows proper nesting in UI
        // Use parentToolUseId as the routing key (it's the Task tool_use id)
        if (
          sdkMessage.isSubagent &&
          typeof sdkMessage.parentToolUseId === "string"
        ) {
          const agentId = sdkMessage.parentToolUseId;

          // Capture toolUseId → agentId mapping on first subagent message
          // This allows TaskRenderer to access agentContent immediately
          // Note: Since agentId === parentToolUseId === toolUseId, the mapping is identity
          registerToolUseAgent(agentId, agentId);

          handleStreamSubagentMessage(incoming, agentId);
          return; // Don't add to main messages
        }

        handleStreamMessageEvent(incoming);
      } else if (data.eventType === "status") {
        const statusData = data as {
          eventType: string;
          state: string;
          request?: InputRequest;
        };
        // Track process state (in-turn, idle, waiting-input, hold)
        if (
          statusData.state === "idle" ||
          statusData.state === "in-turn" ||
          statusData.state === "waiting-input" ||
          statusData.state === "hold"
        ) {
          setProcessState(statusData.state as ProcessState);
        }
        if (historyRewriteRequest) {
          signalHistoryRewriteSync();
        }
        if (statusData.state === "idle") {
          scheduleOpenCodeAuthoritativeRefresh();
        }
        // Capture pending input request when waiting for user input
        if (statusData.state === "waiting-input" && statusData.request) {
          setPendingInputRequest(statusData.request);
          // Also update actualSessionId from request in case it differs from URL
          // This handles the temp→real ID transition when state-change arrives
          // after the connected event (which may have had the temp ID)
          if (
            statusData.request.sessionId &&
            statusData.request.sessionId !== sessionId
          ) {
            setActualSessionId(statusData.request.sessionId);
          }
        } else {
          // Clear pending request when state changes away from waiting-input
          setPendingInputRequest((prev) =>
            keepPersistedPendingInputForSession(prev, sessionId),
          );
        }
      } else if (data.eventType === "deferred-queue") {
        const deferredData = data as {
          eventType: string;
          messages: DeferredMessage[];
        };
        setDeferredMessages(deferredData.messages ?? []);
      } else if (data.eventType === "complete") {
        clearStreamingPlaceholders({ main: true, allAgents: true });
        setProcessState("idle");
        setStatus({ owner: "none" });
        setPendingInputRequest(null);
        setDeferredMessages([]);
        scheduleOpenCodeAuthoritativeRefresh();
      } else if (data.eventType === "error") {
        clearStreamingPlaceholders({ main: true, allAgents: true });
      } else if (data.eventType === "connected") {
        // Sync state and permission mode from connected event
        const connectedData = data as {
          eventType: string;
          sessionId?: string;
          state?: string;
          permissionMode?: PermissionMode;
          modeVersion?: number;
          request?: InputRequest;
          provider?: ProviderName;
          model?: string;
          reasoningEffort?: string;
          serviceTier?: string;
          deferredMessages?: DeferredMessage[];
        };

        // Update actual session ID if server reports a different one
        // This handles the temp→real ID transition when createSession returns
        // before the SDK sends the real session ID
        // Check both the connected event's sessionId and the request's sessionId
        const serverSessionId =
          connectedData.sessionId ?? connectedData.request?.sessionId;
        if (serverSessionId && serverSessionId !== sessionId) {
          setActualSessionId(serverSessionId);
        }

        // Sync process state so watching tabs see "processing" indicator
        if (
          connectedData.state === "idle" ||
          connectedData.state === "in-turn" ||
          connectedData.state === "waiting-input" ||
          connectedData.state === "hold"
        ) {
          setProcessState(connectedData.state as ProcessState);
        }
        // Restore pending input request if state is waiting-input, clear if not
        // (handles reconnection after another tab already approved/denied)
        if (connectedData.state === "waiting-input" && connectedData.request) {
          setPendingInputRequest(connectedData.request);
        } else {
          setPendingInputRequest((prev) =>
            keepPersistedPendingInputForSession(prev, sessionId),
          );
        }
        if (
          connectedData.permissionMode &&
          connectedData.modeVersion !== undefined
        ) {
          applyServerModeUpdate(
            connectedData.permissionMode,
            connectedData.modeVersion,
          );
        }

        // Update session with provider/model from connected event (belt-and-suspenders)
        // This ensures the ProviderBadge shows even if the initial session load returned
        // incomplete data (e.g., JSONL not yet written for new sessions)
        const sseProvider = connectedData.provider;
        const sseModel = connectedData.model;
        const sseReasoningEffort = connectedData.reasoningEffort;
        const sseServiceTier = connectedData.serviceTier;
        if (sseProvider || sseModel || sseReasoningEffort || sseServiceTier) {
          setSession((prev) => {
            if (!prev) return prev;
            // Always update model if the connected event has a resolved model
            // (provider won't change, but model resolves from undefined/"Default" to actual name)
            return {
              ...prev,
              ...(sseProvider && { provider: prev.provider || sseProvider }),
              ...(sseModel && { model: sseModel }),
              ...(sseReasoningEffort && {
                reasoningEffort: sseReasoningEffort,
              }),
              ...(sseServiceTier && { serviceTier: sseServiceTier }),
            };
          });
        }

        // Sync deferred messages from connected event
        setDeferredMessages(connectedData.deferredMessages ?? []);

        // Fetch messages from JSONL since last known message.
        // For Codex providers, skip the very first connected-event fetch because
        // it can duplicate fresh stream messages (ID mismatch between stream and
        // early JSONL normalization). Reconnects still fetch as normal.
        const connectedProvider = connectedData.provider ?? session?.provider;
        const isCodexProvider =
          connectedProvider === "codex" || connectedProvider === "codex-oss";
        const isFirstConnectedEvent = !hasHandledConnectedEventRef.current;
        hasHandledConnectedEventRef.current = true;

        if (historyRewriteRequest) {
          signalHistoryRewriteSync();
        } else if (!(isFirstConnectedEvent && isCodexProvider)) {
          fetchNewMessages();
        }
      } else if (data.eventType === "mode-change") {
        // Handle mode change from another tab/client
        const modeData = data as {
          eventType: string;
          permissionMode?: PermissionMode;
          modeVersion?: number;
        };
        if (modeData.permissionMode && modeData.modeVersion !== undefined) {
          applyServerModeUpdate(modeData.permissionMode, modeData.modeVersion);
        }
      } else if (data.eventType === "markdown-augment") {
        // Handle markdown augment events (server-rendered)
        const augmentData = data as {
          eventType: string;
          blockIndex?: number;
          html: string;
          type?: string;
          messageId?: string;
        };

        // Two types of markdown-augment events:
        // 1. Final message augment: has messageId (uuid), no blockIndex
        //    → Store in markdownAugments for completed message rendering
        // 2. Streaming block augment: has blockIndex and type
        //    → Dispatch to streaming context for live rendering
        if (
          augmentData.messageId &&
          augmentData.blockIndex === undefined &&
          augmentData.html
        ) {
          // Final message augment - store in markdownAugments
          setMarkdownAugments((prev) => ({
            ...prev,
            [augmentData.messageId as string]: { html: augmentData.html },
          }));
        } else if (augmentData.blockIndex !== undefined) {
          // Streaming block augment - dispatch to context
          streamingMarkdownCallbacks?.onAugment?.({
            blockIndex: augmentData.blockIndex,
            html: augmentData.html,
            type: augmentData.type ?? "text",
            messageId: augmentData.messageId,
          });
        }
      } else if (data.eventType === "pending") {
        // Handle streaming markdown pending text events
        const pendingData = data as {
          eventType: string;
          html: string;
        };
        streamingMarkdownCallbacks?.onPending?.({
          html: pendingData.html,
        });
      } else if (data.eventType === "session-id-changed") {
        // Handle session ID change (temp ID → real SDK ID)
        // This event means the URL should be updated to use the new session ID
        const changeData = data as {
          eventType: string;
          oldSessionId: string;
          newSessionId: string;
        };
        if (changeData.newSessionId && changeData.newSessionId !== sessionId) {
          setActualSessionId(changeData.newSessionId);
          // Also update pendingInputRequest.sessionId if it matches the old ID
          // This prevents approval panel from hiding due to ID mismatch after
          // the temp→real transition
          setPendingInputRequest((prev) => {
            if (prev && prev.sessionId === changeData.oldSessionId) {
              return { ...prev, sessionId: changeData.newSessionId };
            }
            return prev;
          });
        }
      }
    },
    [
      applyServerModeUpdate,
      sessionId,
      handleStreamEvent,
      clearStreamingPlaceholders,
      removePendingMessage,
      setPendingMessages,
      streamingMarkdownCallbacks,
      handleStreamMessageEvent,
      handleStreamSubagentMessage,
      registerToolUseAgent,
      scheduleOpenCodeAuthoritativeRefresh,
      historyRewriteRequest,
      signalHistoryRewriteSync,
      setSession,
      fetchNewMessages,
      session?.provider,
    ],
  );

  // Handle stream errors by checking if process is still alive
  // If process died (idle timeout), transition to idle state
  // Uses lightweight metadata endpoint to avoid re-fetching all messages
  const handleStreamError = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      if (data.ownership.owner !== "self") {
        setStatus({ owner: "none" });
        setProcessState("idle");
      } else {
        const nextProcessState = processStateFromActivity(
          data.session.runtime?.activity ?? data.session.activity,
        );
        if (nextProcessState) setProcessState(nextProcessState);
      }
    } catch {
      // If session fetch fails, assume process is dead
      setStatus({ owner: "none" });
      setProcessState("idle");
    }
  }, [projectId, sessionId]);

  // Only connect to session stream when we own the session
  // External sessions are tracked via the activity stream instead
  const { connected, reconnect: reconnectStream } = useSessionStream(
    status.owner === "self" ? sessionId : null,
    { onMessage: handleStreamMessage, onError: handleStreamError },
  );

  const markPendingInputResolved = useCallback(
    (nextState: ProcessState = "in-turn") => {
      setPendingInputRequest(null);
      setProcessState((current) =>
        current === "waiting-input" ? nextState : current,
      );
      fetchNewMessages();
      api
        .getSessionMetadata(projectId, sessionId)
        .then((data) => {
          setStatus(data.ownership);
          setPendingInputRequest(data.pendingInputRequest ?? null);
          const nextProcessState = processStateFromActivity(
            data.session.runtime?.activity ?? data.session.activity,
          );
          if (nextProcessState) {
            setProcessState(nextProcessState);
          } else if (data.ownership.owner === "none") {
            setProcessState("idle");
          }
        })
        .catch(() => {
          // Non-critical. Stream/activity events will continue to update state.
        });
    },
    [projectId, sessionId, fetchNewMessages],
  );

  const sessionUpdatesConnected =
    status.owner === "self"
      ? connected
      : status.owner === "external"
        ? sessionWatchConnected
        : false;

  // Allow external model update (e.g., after /model command switches mid-session)
  const setSessionModel = useCallback(
    (model: string, reasoningEffort?: string) => {
      setSession((prev) =>
        prev
          ? {
              ...prev,
              model,
              ...(reasoningEffort !== undefined && { reasoningEffort }),
            }
          : prev,
      );
    },
    [setSession],
  );

  return {
    session,
    setSessionModel,
    messages,
    agentContent, // Subagent messages keyed by agentId (for Task tool)
    setAgentContent, // Setter for merging lazy-loaded agent content
    toolUseToAgent, // Mapping from Task tool_use_id → agentId (for rendering during streaming)
    markdownAugments, // Pre-rendered markdown HTML from REST response (keyed by blockId)
    status,
    processState,
    turnHealth, // Bridge-reported retry/failure state of the latest turn
    isCompacting, // True when context is being compressed
    isHeld: processState === "hold", // Derived from process state
    pendingInputRequest,
    actualSessionId, // Real session ID from server (may differ from URL during temp→real transition)
    permissionMode, // UI-selected mode (sent with next message)
    modeVersion,
    loading,
    error,
    connected,
    sessionWatchConnected,
    sessionUpdatesConnected,
    lastStreamActivityAt, // Last stream message timestamp for engagement tracking
    setStatus,
    setProcessState,
    setPermissionMode,
    setHold, // Set hold (soft pause) state
    pendingMessages, // Messages waiting for server confirmation
    addPendingMessage, // Add to pending queue, returns tempId
    removePendingMessage, // Remove from pending by tempId
    updatePendingMessage, // Update pending message fields (e.g. status)
    deferredMessages, // Messages queued server-side waiting for agent turn to end
    slashCommands, // Available slash commands from init message
    sessionTools, // Available tools from init message
    mcpServers, // Available MCP servers from init message
    pagination, // Compact-boundary pagination metadata
    loadingOlder, // Whether older messages are being loaded
    loadingNewer, // Whether newer messages are being loaded
    loadingTargetMessage, // Whether a target message window is being loaded
    loadOlderMessages, // Load next chunk of older messages
    loadNewerMessages, // Load next chunk of newer messages
    loadTargetMessageWindow, // Load a bounded window around a target message
    reconnectStream, // Force session stream reconnection (e.g., after process restart)
    truncateMessagesBefore, // Rewind/edit: drop a uuid and everything after it
    refreshSessionMessages, // Reload authoritative JSONL/session snapshot
    beginHistoryRewriteSync, // Codex edit: wait for the rewritten active branch before applying REST
    historyRewritePending: historyRewriteRequest !== null,
    markPendingInputResolved, // Clear a resolved approval/question immediately
  };
}

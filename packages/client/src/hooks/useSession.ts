import {
  type AgentActivity,
  type MarkdownAugment,
  type ProviderName,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { getMessageId } from "../lib/mergeMessages";
import { type AgentTask, findAgentTasks } from "../lib/pendingTasks";
import { normalizeProviderPermissionMode } from "../lib/providerPermissionModes";
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

/**
 * Merge a subagent's already-known messages with a freshly loaded transcript,
 * deduping by message id (uuid preferred). The loaded transcript is canonical;
 * messages only present in the existing set (e.g. arrived via stream after the
 * read) are appended.
 */
function mergeAgentMessages(existing: Message[], loaded: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of loaded) byId.set(getMessageId(m), m);
  for (const m of existing) {
    const id = getMessageId(m);
    if (!byId.has(id)) byId.set(id, m);
  }
  return Array.from(byId.values());
}

export interface AgentMappingLoadPlan {
  loadKey: string;
  tasks: AgentTask[];
}

/**
 * Select the tool calls whose agent mappings can be restored from disk.
 *
 * Most providers expose mappings while a Task is still pending, so completed
 * calls drop out and pending calls drive the key. Kimi's authoritative child
 * ids live in tool.result (completed calls must stay eligible and the key
 * must advance when another result lands), but the reader also assigns
 * provisional ids from on-disk agent directories, so pending Kimi calls are
 * eligible too.
 */
export function buildAgentMappingLoadPlan(
  messages: Message[],
  provider: Session["provider"] | undefined,
  sessionId: string,
): AgentMappingLoadPlan | null {
  const tasks = findAgentTasks(messages).filter((task) =>
    provider === "kimi" ? true : task.resultCount === 0,
  );
  if (tasks.length === 0) return null;

  return {
    loadKey: [
      sessionId,
      provider ?? "unknown",
      ...tasks.map(
        (task) =>
          `${task.toolUseId}:${task.resultCount}:${task.expectedAgentCount ?? "?"}`,
      ),
    ].join("\u0000"),
    tasks,
  };
}

/** Whether a pending Kimi spawn still has child directories left to discover. */
export function hasUnresolvedKimiAgentMappings(
  tasks: AgentTask[],
  idsByToolUse: ReadonlyMap<string, readonly string[]>,
): boolean {
  return tasks.some((task) => {
    if (task.resultCount > 0) return false;
    const mappedCount = idsByToolUse.get(task.toolUseId)?.length ?? 0;
    return task.expectedAgentCount === undefined
      ? mappedCount === 0
      : mappedCount < task.expectedAgentCount;
  });
}

/** Extract a Kimi child id from an agents/<id>/wire.jsonl activity event. */
export function extractKimiAgentIdFromFileEvent(
  event: Pick<FileChangeEvent, "provider" | "relativePath">,
): string | null {
  if (event.provider !== "kimi") return null;
  const parts = event.relativePath.split(/[\\/]/);
  const agentsIndex = parts.lastIndexOf("agents");
  const agentId = agentsIndex >= 0 ? parts[agentsIndex + 1] : undefined;
  return agentId && /^agent-\d+$/.test(agentId) ? agentId : null;
}

/** Initial stream updates need a REST fallback until the session GET lands. */
export function shouldFetchSessionMetadataForUpdate(
  session: Session | null,
): boolean {
  return session === null;
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
const KIMI_SNAPSHOT_RETRY_DELAYS_MS = [120, 300, 600, 1_200, 2_500] as const;
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

export function shouldRefreshSettledAuthoritativeSnapshot(
  provider: Session["provider"] | undefined,
  owner: SessionStatus["owner"],
  processState: ProcessState,
  eventSessionId: string,
  expectedSessionId: string,
): boolean {
  return (
    (provider === "opencode" || provider === "kimi") &&
    owner === "self" &&
    processState === "idle" &&
    eventSessionId === expectedSessionId
  );
}

/**
 * Kimi's persisted transcript uses synthesized message ids while its live
 * stream uses process UUIDs. Do not replace the live tail with a potentially
 * lagging full snapshot until the owned turn has settled.
 */
export function shouldDeferKimiPersistedSync(
  provider: Session["provider"] | undefined,
  owner: SessionStatus["owner"],
  processState: ProcessState | undefined,
): boolean {
  return provider === "kimi" && owner === "self" && processState !== "idle";
}

function normalizeKimiSnapshotText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function kimiMessageText(
  message: Message,
  includeToolResults: boolean,
): string {
  const content = message.message?.content ?? message.content;
  if (typeof content === "string") {
    return normalizeKimiSnapshotText(content);
  }
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
      continue;
    }
    if (
      includeToolResults &&
      block.type === "tool_result" &&
      typeof block.content === "string"
    ) {
      parts.push(block.content);
    }
  }
  return normalizeKimiSnapshotText(parts.join("\n"));
}

function kimiHumanPromptText(message: Message): string | null {
  const role = message.type ?? message.role ?? message.message?.role;
  if (role !== "user") return null;

  const content = message.message?.content ?? message.content;
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => block.type === "tool_result")
  ) {
    return null;
  }

  const text = kimiMessageText(message, false);
  return text || null;
}

/**
 * Kimi emits ACP chunks without stable message ids, while its persisted reader
 * synthesizes ids from the full wire log. A turn-ended event does not await the
 * wire persistence queue, so only replace live messages after the disk snapshot
 * contains both the latest prompt and the latest textual output from that turn.
 */
export function isKimiAuthoritativeSnapshotReady(
  currentMessages: Message[],
  persistedMessages: Message[],
): boolean {
  let currentPromptIndex = -1;
  let currentPrompt = "";
  for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
    const message = currentMessages[index];
    if (!message) continue;
    const prompt = kimiHumanPromptText(message);
    if (prompt !== null) {
      currentPromptIndex = index;
      currentPrompt = prompt;
      break;
    }
  }
  if (currentPromptIndex < 0) return true;

  let persistedPromptIndex = -1;
  for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
    const message = persistedMessages[index];
    if (message && kimiHumanPromptText(message) === currentPrompt) {
      persistedPromptIndex = index;
      break;
    }
  }
  if (persistedPromptIndex < 0) return false;

  let currentTailAnchor = "";
  for (
    let index = currentMessages.length - 1;
    index > currentPromptIndex;
    index -= 1
  ) {
    const message = currentMessages[index];
    if (!message) continue;
    const text = kimiMessageText(message, true);
    if (text) {
      currentTailAnchor = text;
      break;
    }
  }
  if (!currentTailAnchor) return true;

  const persistedTail = normalizeKimiSnapshotText(
    persistedMessages
      .slice(persistedPromptIndex + 1)
      .map((message) => kimiMessageText(message, true))
      .filter(Boolean)
      .join("\n"),
  );
  return persistedTail.includes(currentTailAnchor);
}

export function shouldRefreshFullPersistedSession(
  provider: Session["provider"] | undefined,
): boolean {
  return (
    provider === "codex" ||
    provider === "codex-oss" ||
    provider === "opencode" ||
    provider === "kimi"
  );
}

/**
 * A "tool_use-only" assistant message carries no streamed text/thinking of its
 * own — its content is exclusively tool_use blocks. Such messages must not
 * clear active streaming placeholders: a provider can emit a tool call before
 * flushing the reasoning/text that preceded it, and clearing here would make
 * that streamed text vanish until a later message re-emits it. Text-bearing
 * assistant messages still clear placeholders as before, and the `complete`
 * event force-clears any leftovers.
 */
export function isToolUseOnlyAssistantMessage(
  sdkMessage: Record<string, unknown>,
): boolean {
  const message = sdkMessage.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_use",
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
  initialStatus?: Extract<SessionStatus, { owner: "self" }>,
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
  } = useSessionPermissionMode(
    sessionId,
    status.owner,
    initialStatus?.permissionMode,
    initialStatus?.modeVersion,
  );
  // Track whether we've already processed a stream "connected" event in this mount.
  // For Codex providers, the first connected-event catch-up fetch can duplicate
  // freshly streamed messages because JSONL and stream IDs are not yet aligned.
  const hasHandledConnectedEventRef = useRef(false);

  // Reset connected-event tracking when switching sessions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally runs on session switches
  useEffect(() => {
    hasHandledConnectedEventRef.current = false;
    setLastStreamActivityAt(null);
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

      // Restore the live process mode when owned, otherwise the durable
      // per-session mode. Older servers do not return the top-level fields,
      // so use the provider's native default as a compatibility fallback.
      const restoredPermissionMode =
        result.permissionMode ??
        (result.status.owner === "self"
          ? result.status.permissionMode
          : undefined) ??
        normalizeProviderPermissionMode(result.session.provider, undefined);
      const restoredModeVersion =
        result.modeVersion ??
        (result.status.owner === "self"
          ? result.status.modeVersion
          : undefined) ??
        0;
      applyServerModeUpdate(restoredPermissionMode, restoredModeVersion);
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
  } = useSessionMessages({
    projectId,
    sessionId,
    branchId,
    onLoadComplete: handleLoadComplete,
    onLoadError: handleLoadError,
  });

  const lastPrunedActiveWindowRevisionRef = useRef(0);
  useEffect(() => {
    if (
      activeWindowTrimRevision === 0 ||
      activeWindowTrimRevision === lastPrunedActiveWindowRevisionRef.current
    ) {
      return;
    }
    lastPrunedActiveWindowRevisionRef.current = activeWindowTrimRevision;
    const retainedMessageIds = new Set(
      messages.map((message) => getMessageId(message)).filter(Boolean),
    );
    setMarkdownAugments((previous) => {
      let changed = false;
      const retained: Record<string, MarkdownAugment> = {};
      for (const [messageId, augment] of Object.entries(previous)) {
        if (retainedMessageIds.has(messageId)) {
          retained[messageId] = augment;
        } else {
          changed = true;
        }
      }
      return changed ? retained : previous;
    });
  }, [activeWindowTrimRevision, messages]);

  useEffect(() => {
    if (!historyRewriteRequest) return;

    let cancelled = false;
    const requestId = historyRewriteRequest.id;
    const attemptRefresh = async () => {
      historyRewriteTimerRef.current = null;
      const refreshed = await refreshSessionMessages({
        branchId: null,
        replaceMessages: true,
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
        await refreshSessionMessages({
          branchId: null,
          replaceMessages: true,
        });
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

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // OpenCode and Kimi both use different identities for live and persisted
  // messages. Once a turn settles, replace the whole visible snapshot so a
  // full persisted response cannot be appended as duplicate historical turns.
  const authoritativeSnapshotRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const authoritativeSnapshotRefreshGenerationRef = useRef(0);
  const scheduleAuthoritativeSnapshotRefresh = useCallback(() => {
    const provider = session?.provider;
    if (provider !== "opencode" && provider !== "kimi") {
      return;
    }

    const generation = ++authoritativeSnapshotRefreshGenerationRef.current;
    if (authoritativeSnapshotRefreshTimerRef.current) {
      clearTimeout(authoritativeSnapshotRefreshTimerRef.current);
    }

    const refresh = async (attempt: number) => {
      if (generation !== authoritativeSnapshotRefreshGenerationRef.current) {
        return;
      }
      authoritativeSnapshotRefreshTimerRef.current = null;
      const refreshed = await refreshSessionMessages(
        provider === "kimi"
          ? {
              replaceMessages: true,
              acceptSnapshot: ({ messages: persistedMessages }) =>
                isKimiAuthoritativeSnapshotReady(
                  messagesRef.current,
                  persistedMessages,
                ),
            }
          : undefined,
      );
      if (
        provider !== "kimi" ||
        refreshed ||
        generation !== authoritativeSnapshotRefreshGenerationRef.current
      ) {
        return;
      }

      const nextDelay = KIMI_SNAPSHOT_RETRY_DELAYS_MS[attempt + 1];
      if (nextDelay === undefined) return;
      authoritativeSnapshotRefreshTimerRef.current = setTimeout(() => {
        void refresh(attempt + 1);
      }, nextDelay);
    };

    const initialDelay =
      provider === "kimi" ? KIMI_SNAPSHOT_RETRY_DELAYS_MS[0] : 120;
    authoritativeSnapshotRefreshTimerRef.current = setTimeout(() => {
      void refresh(0);
    }, initialDelay);
  }, [refreshSessionMessages, session?.provider]);

  useEffect(() => {
    return () => {
      authoritativeSnapshotRefreshGenerationRef.current += 1;
      if (authoritativeSnapshotRefreshTimerRef.current) {
        clearTimeout(authoritativeSnapshotRefreshTimerRef.current);
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

  // Track the exact set of Task results used for the most recent mapping load.
  // Kimi's key advances when a new call appears, when a result lands, and
  // again if another result for the same tool call lands.
  const agentMappingsLoadKeyRef = useRef<string | null>(null);
  const knownKimiAgentIdsRef = useRef<Set<string>>(new Set());
  const [agentMappingsRevision, setAgentMappingsRevision] = useState(0);

  useEffect(() => {
    knownKimiAgentIdsRef.current = new Set(
      Array.from(toolUseToAgentIds.values()).flat(),
    );
  }, [toolUseToAgentIds]);

  // Restore agent mappings and content from persisted provider transcripts.
  // Other providers load pending Tasks from their streaming transcripts; Kimi's
  // ids come from the disk reader (authoritative tool.result ids, plus
  // provisional ids for still-running children from the agents/ directory).
  useEffect(() => {
    if (loading || messages.length === 0) return;

    const loadPlan = buildAgentMappingLoadPlan(
      messages,
      session?.provider,
      sessionId,
    );
    const loadKey = loadPlan
      ? `${loadPlan.loadKey}\u0000${agentMappingsRevision}`
      : null;
    if (!loadPlan || agentMappingsLoadKeyRef.current === loadKey) {
      return;
    }

    // Claim this plan before starting the request so unrelated rerenders do not
    // launch duplicate mapping/content reads.
    agentMappingsLoadKeyRef.current = loadKey;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const loadMappedAgents = async (attempt: number): Promise<void> => {
      try {
        // Get agent mappings (toolUseId → agentId). An AgentSwarm call fans
        // out to N children sharing one toolUseId, so group them.
        const { mappings } = await api.getAgentMappings(projectId, sessionId);
        if (cancelled) return;
        const firstAgentByToolUse = new Map<string, string>();
        const idsByToolUse = new Map<string, string[]>();
        for (const m of mappings) {
          if (!firstAgentByToolUse.has(m.toolUseId)) {
            firstAgentByToolUse.set(m.toolUseId, m.agentId);
          }
          const existing = idsByToolUse.get(m.toolUseId);
          if (existing) {
            if (!existing.includes(m.agentId)) existing.push(m.agentId);
          } else {
            idsByToolUse.set(m.toolUseId, [m.agentId]);
          }
        }
        if (session?.provider === "kimi") {
          for (const ids of idsByToolUse.values()) {
            for (const agentId of ids) {
              knownKimiAgentIdsRef.current.add(agentId);
            }
          }
        }

        // Update the toolUseToAgent state with loaded mappings
        // This allows TaskRenderer to access agentContent even after page reload
        setToolUseToAgent((prev) => {
          const next = new Map(prev);
          for (const [toolUseId, agentId] of firstAgentByToolUse) {
            // Kimi mappings are authoritative: let a later result-backed id
            // replace an earlier provisional (directory-scan) one.
            if (
              !next.has(toolUseId) ||
              (session?.provider === "kimi" && next.get(toolUseId) !== agentId)
            ) {
              next.set(toolUseId, agentId);
            }
          }
          return next;
        });
        setToolUseToAgentIds((prev) => {
          const next = new Map(prev);
          for (const [toolUseId, ids] of idsByToolUse) {
            if (session?.provider === "kimi") {
              // The reader returns the session's full mapping set, so a fresh
              // response replaces (rather than merges with) stale provisional
              // fan-outs.
              const existing = next.get(toolUseId) ?? [];
              const unchanged =
                existing.length === ids.length &&
                existing.every((id) => ids.includes(id));
              if (!unchanged) next.set(toolUseId, [...ids]);
            } else {
              const existing = next.get(toolUseId) ?? [];
              const merged = [...existing];
              for (const id of ids) {
                if (!merged.includes(id)) merged.push(id);
              }
              next.set(toolUseId, merged);
            }
          }
          return next;
        });

        // Load every mapped child selected by the plan. For a completed Kimi
        // AgentSwarm this supplies all member statuses and aggregate metrics,
        // rather than leaving the renderer with result.agentId's first child.
        const mappedAgentIds = new Set<string>();
        for (const task of loadPlan.tasks) {
          for (const id of idsByToolUse.get(task.toolUseId) ?? []) {
            mappedAgentIds.add(id);
          }
        }
        for (const agentId of mappedAgentIds) {
          if (cancelled) return;
          try {
            const agentData = await api.getAgentSession(
              projectId,
              sessionId,
              agentId,
            );

            if (cancelled) return;
            // Merge into agentContent state, deduping by message ID
            // Use getMessageId to prefer uuid over id
            setAgentContent((prev) => {
              const existing = prev[agentId];
              const merged =
                existing && existing.messages.length > 0
                  ? mergeAgentMessages(existing.messages, agentData.messages)
                  : agentData.messages;
              return {
                ...prev,
                [agentId]: {
                  messages: merged,
                  status: agentData.status,
                  ...(agentData.agentType
                    ? { agentType: agentData.agentType }
                    : {}),
                  ...(agentData.metrics ? { metrics: agentData.metrics } : {}),
                  ...(agentData.descriptor
                    ? { descriptor: agentData.descriptor }
                    : {}),
                },
              };
            });
          } catch {
            // Skip agents that can't be loaded
          }
        }

        // A pending Kimi call resolves only after the reader spots its
        // agents/<id> directory, which can appear a moment after the tool
        // call surfaces. Retry a few times so late directory creation is
        // picked up without waiting for the tool result.
        if (cancelled || session?.provider !== "kimi") return;
        const hasUnresolvedPending = hasUnresolvedKimiAgentMappings(
          loadPlan.tasks,
          idsByToolUse,
        );
        if (hasUnresolvedPending && attempt < 5) {
          retryTimer = setTimeout(
            () => void loadMappedAgents(attempt + 1),
            3000,
          );
        }
      } catch {
        // Silent fail for agent mappings - not critical
      }
    };

    void loadMappedAgents(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    agentMappingsRevision,
    loading,
    messages,
    projectId,
    session?.provider,
    sessionId,
    setAgentContent,
    setToolUseToAgent,
    setToolUseToAgentIds,
  ]);

  const fetchPersistedSessionChanges = useCallback(() => {
    const provider = session?.provider;
    // An owned Kimi turn is already supplied by the live stream. Its reader
    // returns a full snapshot even when afterMessageId is provided, so wait
    // until idle rather than replacing an in-flight live tail with disk lag.
    if (shouldDeferKimiPersistedSync(provider, status.owner, processState)) {
      return;
    }

    // Kimi cannot incrementally slice its synthesized ids. Even while idle,
    // reject a disk snapshot that has not caught up with the current live tail.
    if (provider === "kimi") {
      void refreshSessionMessages({
        replaceMessages: true,
        acceptSnapshot: ({ messages: persistedMessages }) =>
          isKimiAuthoritativeSnapshotReady(
            messagesRef.current,
            persistedMessages,
          ),
      });
      return;
    }

    // Codex can rewrite recent transcript entries and OpenCode updates tool
    // parts in place. Reload the authoritative bounded window for both cases.
    if (shouldRefreshFullPersistedSession(provider)) {
      void refreshSessionMessages();
      return;
    }
    void fetchNewMessages();
  }, [
    fetchNewMessages,
    processState,
    refreshSessionMessages,
    session?.provider,
    status.owner,
  ]);

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

      // Kimi swarm members can create their directories seconds apart. A new
      // child file is a durable signal to re-read the mapping even after the
      // bounded timer retries have ended.
      const kimiAgentId = extractKimiAgentIdFromFileEvent(event);
      if (kimiAgentId && !knownKimiAgentIdsRef.current.has(kimiAgentId)) {
        knownKimiAgentIdsRef.current.add(kimiAgentId);
        agentMappingsLoadKeyRef.current = null;
        setAgentMappingsRevision((revision) => revision + 1);
      }

      // Owned sessions normally stay on their stream. Kimi is the exception:
      // turn.ended does not await its wire persistence queue, so a main-agent
      // wire.jsonl event observed after idle is an additional convergence signal.
      if (status.owner === "self") {
        if (historyRewriteRequest) {
          signalHistoryRewriteSync();
        }
        if (session?.provider === "kimi" && processState === "idle") {
          scheduleAuthoritativeSnapshotRefresh();
        }
        return;
      }

      // For external/idle sessions: fetch both messages and metadata via API
      throttledFetch();
    },
    [
      historyRewriteRequest,
      processState,
      scheduleAuthoritativeSnapshotRefresh,
      session?.provider,
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

      // The initial GET can still be in flight when a stream event arrives
      // (e.g. the +1s/+3s reconcile events for a new session). Fetch metadata
      // instead of dropping the event so title/contextUsage land promptly.
      if (shouldFetchSessionMetadataForUpdate(session)) {
        void fetchSessionMetadata();
      }

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
        shouldRefreshSettledAuthoritativeSnapshot(
          session?.provider,
          status.owner,
          processState,
          event.sessionId,
          sessionId,
        )
      ) {
        scheduleAuthoritativeSnapshotRefresh();
      }
    },
    [
      processState,
      fetchSessionMetadata,
      historyRewriteRequest,
      scheduleAuthoritativeSnapshotRefresh,
      session,
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
        shouldRefreshSettledAuthoritativeSnapshot(
          session?.provider,
          status.owner,
          nextProcessState ?? processState,
          event.sessionId,
          sessionId,
        )
      ) {
        scheduleAuthoritativeSnapshotRefresh();
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
      scheduleAuthoritativeSnapshotRefresh,
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
          (sdkMessage.subtype === "history_fork_complete" ||
            // Older servers emitted the same sync signal under this subtype.
            sdkMessage.subtype === "history_rewrite_complete")
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
        // Skip pure tool_use messages: they don't represent the final form of
        // any streamed text/thinking, so clearing here would erase still-shown
        // streamed content before its real message arrives.
        if (
          msgType === "assistant" &&
          !isToolUseOnlyAssistantMessage(sdkMessage)
        ) {
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
          scheduleAuthoritativeSnapshotRefresh();
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
        scheduleAuthoritativeSnapshotRefresh();
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

        // Fetch messages from JSONL since the last known message. Kimi cannot
        // provide a real incremental slice, so an active turn stays on the live
        // stream and replaces itself with the full snapshot only after idle.
        // Codex keeps its existing first-connect guard for early normalization.
        const connectedProvider = connectedData.provider ?? session?.provider;
        const isCodexProvider =
          connectedProvider === "codex" || connectedProvider === "codex-oss";
        const isFirstConnectedEvent = !hasHandledConnectedEventRef.current;
        hasHandledConnectedEventRef.current = true;
        const connectedProcessState =
          connectedData.state === "idle" ||
          connectedData.state === "in-turn" ||
          connectedData.state === "waiting-input" ||
          connectedData.state === "hold"
            ? (connectedData.state as ProcessState)
            : undefined;

        if (historyRewriteRequest) {
          signalHistoryRewriteSync();
        } else if (
          shouldDeferKimiPersistedSync(
            connectedProvider,
            "self",
            connectedProcessState,
          )
        ) {
          // The stream will carry the active turn; idle/complete schedules the
          // authoritative replacement and retries until wire.jsonl catches up.
        } else if (connectedProvider === "kimi") {
          scheduleAuthoritativeSnapshotRefresh();
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
      scheduleAuthoritativeSnapshotRefresh,
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
      if (
        !shouldDeferKimiPersistedSync(
          session?.provider,
          status.owner,
          nextState,
        )
      ) {
        fetchNewMessages();
      }
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
    [projectId, sessionId, fetchNewMessages, session?.provider, status.owner],
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
    toolUseToAgentIds, // Mapping from Task tool_use_id → all subagent ids (AgentSwarm fan-out)
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
    updateActiveWindowFollowingBottom, // Allow safe active-tail memory trimming
    activeWindowTrimRevision, // Force bottom restoration after an accepted trim
    reconnectStream, // Force session stream reconnection (e.g., after process restart)
    truncateMessagesBefore, // Rewind/edit: drop a uuid and everything after it
    refreshSessionMessages, // Reload authoritative JSONL/session snapshot
    beginHistoryRewriteSync, // Codex edit: wait for the rewritten active branch before applying REST
    historyRewritePending: historyRewriteRequest !== null,
    markPendingInputResolved, // Clear a resolved approval/question immediately
  };
}

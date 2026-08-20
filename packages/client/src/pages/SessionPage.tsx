import type { ProviderName, UploadedFile } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api } from "../api/client";
import { FileEditor } from "../components/FileEditor";
import { MessageInput, type UploadProgress } from "../components/MessageInput";
import { MessageInputToolbar } from "../components/MessageInputToolbar";
import { MessageList } from "../components/MessageList";
import { ModelSwitchModal } from "../components/ModelSwitchModal";
import { ProcessInfoModal } from "../components/ProcessInfoModal";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { RecentSessionsDropdown } from "../components/RecentSessionsDropdown";
import { SessionInspector } from "../components/SessionInspector";
import { SessionMenu } from "../components/SessionMenu";
import { SessionMessagesSkeleton } from "../components/Skeleton";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import { Modal } from "../components/ui/Modal";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import { FileTabOpenerContext } from "../contexts/FileTabOpenerContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../contexts/StreamingMarkdownContext";
import { useToastContext } from "../contexts/ToastContext";
import { useActivityBusState } from "../hooks/useActivityBusState";
import { useConnection } from "../hooks/useConnection";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useInspectorWidth } from "../hooks/useInspectorWidth";
import { getModelSetting, getThinkingSetting } from "../hooks/useModelSettings";
import { useProject } from "../hooks/useProjects";
import { useProviders } from "../hooks/useProviders";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import {
  type StreamingMarkdownCallbacks,
  useSession,
} from "../hooks/useSession";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import {
  getAgentCommandConfig,
  getStaticAgentCommandConfigs,
} from "../lib/agentCommands";
import { getMessageId } from "../lib/mergeMessages";
import { preprocessMessages } from "../lib/preprocessMessages";
import {
  type PreprocessMessagesCache,
  preprocessMessagesCached,
} from "../lib/preprocessMessagesCache";
import { generateUUID } from "../lib/uuid";
import type { BrowserSessionMetadata, Message } from "../types";
import { getSessionDisplayTitle } from "../utils";

export function SessionPage() {
  const { projectId, sessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();

  // Guard against missing params - this shouldn't happen with proper routing
  if (!projectId || !sessionId) {
    return <SessionPageInvalidRoute />;
  }

  // Key ensures component remounts on session change, resetting all state
  // Wrap with StreamingMarkdownProvider for server-rendered markdown streaming
  return (
    <StreamingMarkdownProvider>
      <SessionPageContent
        key={sessionId}
        projectId={projectId}
        sessionId={sessionId}
      />
    </StreamingMarkdownProvider>
  );
}

function SessionPageInvalidRoute() {
  const { t } = useI18n();
  return <div className="error">{t("sessionInvalidUrl")}</div>;
}

function isCodexAppServerProvider(
  provider: ProviderName | string | undefined | null,
): provider is "codex" {
  return provider === "codex";
}

function getApprovalAgentName(
  provider: ProviderName | string | undefined | null,
): string {
  switch (provider) {
    case "codex":
    case "codex-oss":
      return "Codex";
    case "gemini":
    case "gemini-acp":
      return "Gemini";
    case "opencode":
      return "OpenCode";
    default:
      return "Claude";
  }
}

function getArchiveBlockReasonForState(
  owner: "self" | "external" | "none",
  processState: string,
): string {
  if (processState === "waiting-input") {
    return "This session is waiting for input. Respond or stop it before archiving.";
  }
  if (processState === "hold") {
    return "This session is on hold. Resume or stop it before archiving.";
  }
  if (processState === "in-turn") {
    return "This session is currently running. Wait for it to finish or stop it before archiving.";
  }
  if (owner === "external") {
    return "This session is controlled by an active external process. Wait for it to finish before archiving.";
  }
  return "This session cannot be archived right now.";
}

function calculateCodexRollbackNumTurns(
  messages: Message[],
  editedUuid: string,
): number | null {
  const userPrompts = preprocessMessages(messages).filter(
    (item) => item.type === "user_prompt",
  );
  const editedIndex = userPrompts.findIndex((item) =>
    item.sourceMessages.some((message) => getMessageId(message) === editedUuid),
  );
  if (editedIndex < 0) return null;

  const rollbackNumTurns = userPrompts.length - editedIndex;
  return rollbackNumTurns > 0 ? rollbackNumTurns : null;
}

function hasBranchChoices(
  session: BrowserSessionMetadata | null | undefined,
): boolean {
  const branchState = session?.branchState ?? session?.codexBranchState;
  return (
    branchState?.branches.some((branch) => branch.siblingCount > 1) ?? false
  );
}

export function SessionPageContent({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { t } = useI18n();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const inspector = useInspectorWidth();
  const basePath = useRemoteBasePath();
  const { project } = useProject(projectId);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedBranchId = searchParams.get("branch") || undefined;
  // Get initial status and title from navigation state (passed by NewSessionPage)
  // This allows SSE to connect immediately and show optimistic title without waiting for getSession
  // Also get provider so provider-specific controls can render immediately
  const navState = location.state as {
    initialStatus?: { owner: "self"; processId: string };
    initialTitle?: string;
    initialProvider?: ProviderName;
    /** Message id to scroll to + highlight (set by search deep-links). */
    targetMessageId?: string;
  } | null;
  const initialStatus = navState?.initialStatus;
  const initialTitle = navState?.initialTitle;
  const initialProvider = navState?.initialProvider;

  // Get streaming markdown context for server-rendered markdown streaming
  const streamingMarkdownContext = useStreamingMarkdownContext();

  // Memoize the callbacks object to avoid recreating on every render
  const streamingMarkdownCallbacks = useMemo<
    StreamingMarkdownCallbacks | undefined
  >(() => {
    if (!streamingMarkdownContext) return undefined;
    return {
      onAugment: streamingMarkdownContext.dispatchAugment,
      onPending: streamingMarkdownContext.dispatchPending,
      onStreamEnd: streamingMarkdownContext.dispatchStreamEnd,
      setCurrentMessageId: streamingMarkdownContext.setCurrentMessageId,
      captureHtml: streamingMarkdownContext.captureStreamingHtml,
    };
  }, [streamingMarkdownContext]);

  const {
    session,
    messages,
    agentContent,
    setAgentContent,
    toolUseToAgent,
    markdownAugments,
    status,
    processState,
    isCompacting,
    pendingInputRequest,
    actualSessionId,
    permissionMode,
    loading,
    error,
    retryInitialLoad,
    connected,
    sessionUpdatesConnected,
    lastStreamActivityAt,
    setStatus,
    setProcessState,
    setPermissionMode,
    setHold,
    isHeld,
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    updatePendingMessage,
    deferredMessages,
    slashCommands,
    setSessionModel,
    sessionTools,
    mcpServers,
    pagination,
    loadingOlder,
    loadingNewer,
    loadingTargetMessage,
    loadOlderMessages,
    loadNewerMessages,
    loadTargetMessageWindow,
    reconnectStream,
    truncateMessagesBefore,
    refreshSessionMessages,
    markPendingInputResolved,
  } = useSession(
    projectId,
    sessionId,
    initialStatus,
    streamingMarkdownCallbacks,
    selectedBranchId,
  );
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const isSessionReady = !loading && error === null && session !== null;

  // Dismiss cold-start splash once the session has loaded (covers deep-link
  // launches that land directly on a session URL).
  useHideSplashOnReady(!loading || error !== null);
  const preprocessCacheRef = useRef<PreprocessMessagesCache | null>(null);

  // Developer mode settings
  const { holdModeEnabled, showConnectionBars } = useDeveloperMode();

  // Session connection bar state for active session update streams
  const { connectionState } = useActivityBusState();
  const hasSessionUpdateStream =
    status.owner === "self" || status.owner === "external";
  const sessionConnectionStatus =
    !showConnectionBars || !hasSessionUpdateStream
      ? "idle"
      : sessionUpdatesConnected
        ? "connected"
        : connectionState === "reconnecting"
          ? "connecting"
          : "disconnected";

  // Effective provider for immediate display before session data loads
  // Always provide a default to prevent undefined access errors
  const effectiveProvider = session?.provider ?? initialProvider ?? "claude";
  const approvalAgentName = getApprovalAgentName(effectiveProvider);

  const [scrollTrigger, setScrollTrigger] = useState(0);
  const draftControlsRef = useRef<DraftControls | null>(null);
  const handleDraftControlsReady = useCallback((controls: DraftControls) => {
    draftControlsRef.current = controls;
  }, []);
  const { showToast } = useToastContext();

  // Edit/rewind: when set, the next send rewinds from a past user message.
  // Claude uses `parentUuid` as the SDK resume point. Codex app-server uses
  // `rollbackNumTurns` to match Codex CLI Esc Esc backtrack semantics.
  // `uuid` is the edited message's own id, used to optimistically trim the
  // local list. `preview` is shown in the banner.
  const [editRewind, setEditRewind] = useState<{
    parentUuid: string | null;
    uuid: string;
    preview: string;
    rollbackNumTurns?: number | null;
  } | null>(null);
  const [pendingBranchFocusId, setPendingBranchFocusId] = useState<
    string | null
  >(null);
  const [pendingEditBranchRefresh, setPendingEditBranchRefresh] =
    useState(false);
  const editBranchRefreshAttemptsRef = useRef(0);
  const editBranchRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  // Deep-link target message (from search). Seeded from navigation state once.
  const [targetMessageId, setTargetMessageId] = useState<string | null>(
    navState?.targetMessageId ?? null,
  );
  const [isInspectorOpen, setInspectorOpen] = useState(false);
  // In-page file tabs (VS Code-style): the chat is one tab, opened files are others.
  const [openFileTabs, setOpenFileTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>("chat");
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const [pendingCloseTab, setPendingCloseTab] = useState<string | null>(null);
  const saveHandlers = useRef<Map<string, () => Promise<void>>>(new Map());

  const updateSaveHandler = useCallback(
    (path: string, fn: (() => Promise<void>) | null) => {
      if (fn) saveHandlers.current.set(path, fn);
      else saveHandlers.current.delete(path);
    },
    [],
  );

  const openOrFocusFileTab = useCallback((path: string) => {
    setOpenFileTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveTab(path);
  }, []);

  const handleTabDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const closeTab = useCallback((path: string) => {
    setOpenFileTabs((prev) => {
      const idx = prev.indexOf(path);
      const next = prev.filter((p) => p !== path);
      setActiveTab((cur) => {
        if (cur !== path) return cur;
        return next.length > 0
          ? (next[Math.max(0, idx - 1)] ?? "chat")
          : "chat";
      });
      return next;
    });
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    saveHandlers.current.delete(path);
  }, []);

  const requestCloseTab = useCallback(
    (path: string) => {
      if (dirtyTabs.has(path)) setPendingCloseTab(path);
      else closeTab(path);
    },
    [dirtyTabs, closeTab],
  );

  const confirmCloseTab = useCallback(
    async (save: boolean) => {
      const path = pendingCloseTab;
      setPendingCloseTab(null);
      if (!path) return;
      if (save) {
        try {
          await saveHandlers.current.get(path)?.();
        } catch {
          // editor shows the save error; still close per user intent
        }
      }
      closeTab(path);
    },
    [pendingCloseTab, closeTab],
  );

  // Warn before unload while there are unsaved edits.
  useEffect(() => {
    if (dirtyTabs.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyTabs.size]);

  // Keep activeTab valid (fall back to chat if its file tab disappeared).
  useEffect(() => {
    if (activeTab !== "chat" && !openFileTabs.includes(activeTab)) {
      setActiveTab("chat");
    }
  }, [openFileTabs, activeTab]);

  const handleTargetFocused = useCallback(() => {
    setTargetMessageId(null);
  }, []);
  const handleInspectorSelectMessage = useCallback((messageId: string) => {
    if (!messageId) return;
    setTargetMessageId(messageId);
  }, []);

  const sessionBranchState = session?.branchState ?? session?.codexBranchState;
  const isViewingHistoricalBranch = useMemo(() => {
    if (!selectedBranchId || !sessionBranchState) return false;
    const selectedBranch = sessionBranchState.branches.find(
      (branch) => branch.id === selectedBranchId,
    );
    return selectedBranch ? !selectedBranch.isActive : false;
  }, [selectedBranchId, sessionBranchState]);

  const handleEditUserPrompt = useCallback(
    ({
      text,
      uuid,
      parentUuid,
    }: { text: string; uuid: string; parentUuid: string | null }) => {
      if (isViewingHistoricalBranch) return;
      const rollbackNumTurns = isCodexAppServerProvider(effectiveProvider)
        ? calculateCodexRollbackNumTurns(messagesRef.current, uuid)
        : null;
      setEditRewind({ parentUuid, uuid, preview: text, rollbackNumTurns });
      draftControlsRef.current?.setText(text);
      setScrollTrigger((prev) => prev + 1);
    },
    [effectiveProvider, isViewingHistoricalBranch],
  );

  const handleSelectBranch = useCallback(
    (branchId: string) => {
      setPendingBranchFocusId(branchId);
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("branch", branchId);
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  const handleBranchFocused = useCallback(() => {
    setPendingBranchFocusId(null);
  }, []);

  const clearEditBranchRefreshTimer = useCallback(() => {
    if (editBranchRefreshTimerRef.current) {
      clearTimeout(editBranchRefreshTimerRef.current);
      editBranchRefreshTimerRef.current = null;
    }
  }, []);

  const queueEditBranchRefresh = useCallback(() => {
    editBranchRefreshAttemptsRef.current = 0;
    clearEditBranchRefreshTimer();
    setPendingEditBranchRefresh(true);
  }, [clearEditBranchRefreshTimer]);

  const clearSelectedBranchAfterEdit = useCallback(() => {
    setPendingBranchFocusId(null);
    if (!selectedBranchId) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("branch");
        return next;
      },
      { replace: true },
    );
  }, [selectedBranchId, setSearchParams]);

  useEffect(() => clearEditBranchRefreshTimer, [clearEditBranchRefreshTimer]);

  useEffect(() => {
    if (!pendingEditBranchRefresh) return;
    if (processState !== "idle" && status.owner === "self") return;

    let cancelled = false;
    const refreshActiveBranch = async () => {
      clearSelectedBranchAfterEdit();
      const refreshedSession = await refreshSessionMessages({ branchId: null });
      if (cancelled) return;

      const attempt = editBranchRefreshAttemptsRef.current;
      if (
        (hasBranchChoices(refreshedSession) && attempt >= 1) ||
        attempt >= 2
      ) {
        setPendingEditBranchRefresh(false);
        return;
      }

      editBranchRefreshAttemptsRef.current = attempt + 1;
      editBranchRefreshTimerRef.current = setTimeout(refreshActiveBranch, 600);
    };

    clearEditBranchRefreshTimer();
    editBranchRefreshTimerRef.current = setTimeout(refreshActiveBranch, 150);

    return () => {
      cancelled = true;
      clearEditBranchRefreshTimer();
    };
  }, [
    clearEditBranchRefreshTimer,
    clearSelectedBranchAfterEdit,
    pendingEditBranchRefresh,
    processState,
    refreshSessionMessages,
    status.owner,
  ]);

  const handleCancelEdit = useCallback(() => {
    setEditRewind(null);
    draftControlsRef.current?.clearInput();
  }, []);

  // Sharing: check if configured (hidden unless sharing.json exists on server)
  const [sharingConfigured, setSharingConfigured] = useState(false);
  useEffect(() => {
    api
      .getSharingStatus()
      .then((res) => setSharingConfigured(res.configured))
      .catch(() => {});
  }, []);

  // Connection for uploads (uses WebSocket when enabled)
  const connection = useConnection();

  // Inject custom client-side commands alongside SDK-discovered ones
  const allSlashCommands = useMemo(() => {
    if (status.owner === "self") {
      return slashCommands.includes("model")
        ? slashCommands
        : ["model", ...slashCommands];
    }
    return slashCommands;
  }, [slashCommands, status.owner]);

  // Get provider capabilities based on session's provider
  const { providers } = useProviders();
  const currentProviderInfo = useMemo(() => {
    if (!effectiveProvider) return null;
    return providers.find((p) => p.name === effectiveProvider) ?? null;
  }, [effectiveProvider, providers]);
  // Default to true for backwards compatibility (except slash commands)
  const supportsPermissionMode =
    currentProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    currentProviderInfo?.supportsThinkingToggle ?? true;
  const supportsSlashCommands = currentProviderInfo?.supportsSlashCommands;
  const commandConfig = useMemo(() => {
    return getAgentCommandConfig(
      effectiveProvider,
      supportsSlashCommands,
      allSlashCommands,
    );
  }, [allSlashCommands, effectiveProvider, supportsSlashCommands]);
  const showCommandButton = status.owner === "self" && commandConfig.showButton;
  const activeCommands = useMemo(() => {
    if (status.owner !== "self") return [];
    return commandConfig.commands;
  }, [commandConfig.commands, status.owner]);
  const commandPrefix = commandConfig.prefix;
  const commandLabel = commandConfig.label;
  const commandButtons = useMemo(() => {
    if (status.owner !== "self") return [];
    return getStaticAgentCommandConfigs(allSlashCommands);
  }, [allSlashCommands, status.owner]);

  // Inline title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingTitleRef = useRef(false);

  // Recent sessions dropdown state
  const [showRecentSessions, setShowRecentSessions] = useState(false);
  const titleButtonRef = useRef<HTMLButtonElement>(null);

  // Local metadata state (for optimistic updates)
  // Reset when session changes to avoid showing stale data from previous session
  const [localCustomTitle, setLocalCustomTitle] = useState<string | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>(
    undefined,
  );

  // Reset local metadata state when sessionId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on sessionId change
  useEffect(() => {
    setLocalCustomTitle(undefined);
    setLocalIsArchived(undefined);
    setLocalIsStarred(undefined);
    setLocalHasUnread(undefined);
  }, [sessionId]);

  // Navigate to new session ID when temp ID is replaced with real SDK session ID
  // This ensures the URL stays in sync with the actual session
  useEffect(() => {
    if (actualSessionId && actualSessionId !== sessionId) {
      // Use replace to avoid creating a history entry for the temp ID
      navigate(
        `${basePath}/projects/${projectId}/sessions/${actualSessionId}`,
        {
          replace: true,
          state: location.state, // Preserve initial state for seamless transition
        },
      );
    }
  }, [
    actualSessionId,
    sessionId,
    projectId,
    navigate,
    location.state,
    basePath,
  ]);

  // File attachment state
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  // Track in-flight upload promises so handleSend can wait for them
  const pendingUploadsRef = useRef<Map<string, Promise<UploadedFile | null>>>(
    new Map(),
  );

  // Approval panel collapsed state (separate from message input collapse)
  const [approvalCollapsed, setApprovalCollapsed] = useState(false);

  // Process info modal state
  const [showProcessInfoModal, setShowProcessInfoModal] = useState(false);

  // Model switch modal state
  const [showModelSwitchModal, setShowModelSwitchModal] = useState(false);

  // Track user engagement to mark session as "seen".
  // Opening a session counts as reading the current content even when an
  // external terminal owns the process; future external writes can make it
  // unread again via updatedAt.
  //
  // We use two timestamps:
  // - activityAt: max(session summary update, SSE activity) - triggers the mark-seen action
  // - updatedAt: latest visible session activity - the timestamp we record
  //
  // This separation prevents a race condition where SSE timestamps (client clock)
  // could be ahead of the persisted session summary time, causing sessions to
  // never become unread again after viewing.
  const sessionUpdatedAt = session?.updatedAt ?? null;
  const activityAt = useMemo(() => {
    if (!sessionUpdatedAt && !lastStreamActivityAt) return null;
    if (!sessionUpdatedAt) return lastStreamActivityAt;
    if (!lastStreamActivityAt) return sessionUpdatedAt;
    // Return the more recent timestamp
    return sessionUpdatedAt > lastStreamActivityAt
      ? sessionUpdatedAt
      : lastStreamActivityAt;
  }, [sessionUpdatedAt, lastStreamActivityAt]);

  useEngagementTracking({
    sessionId,
    activityAt,
    updatedAt: sessionUpdatedAt,
    lastSeenAt: session?.lastSeenAt,
    hasUnread: session?.hasUnread,
    enabled: Boolean(session),
  });

  const handleSend = async (text: string) => {
    if (!isSessionReady) return;

    // Add to pending queue and get tempId to pass to server
    const tempId = addPendingMessage(text);
    setProcessState("in-turn"); // Optimistic: show processing indicator immediately
    setScrollTrigger((prev) => prev + 1); // Force scroll to bottom

    // Capture already-completed attachments
    const currentAttachments = [...attachments];

    // Wait for any in-flight uploads to complete before sending
    const pendingAtSendTime = [...pendingUploadsRef.current.values()];
    if (pendingAtSendTime.length > 0) {
      updatePendingMessage(tempId, { status: t("sessionUploading") });
      setAttachments([]); // Clear input area immediately
      const results = await Promise.all(pendingAtSendTime);
      for (const result of results) {
        if (result) currentAttachments.push(result);
      }
      // Remove uploaded files that handleAttach added to state during the wait
      // (they're already captured in currentAttachments). Preserve any new uploads
      // started after send was clicked.
      const sentIds = new Set(currentAttachments.map((a) => a.id));
      setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
      updatePendingMessage(tempId, { status: undefined });
    } else {
      setAttachments([]);
    }

    try {
      // Edit/rewind: branch the conversation from the chosen message.
      // For a message with a parent we rewind IN PLACE (same session): the SDK
      // resumes only up to the parent, the old tail becomes a dead branch the
      // server filters out, and the edited turn streams in. We optimistically
      // trim the local tail so it doesn't linger before the stream arrives.
      // Editing the very first message has no parent to rewind to, so we fall
      // back to starting a fresh session.
      if (editRewind) {
        const model = session?.model ?? getModelSetting();
        const thinking = getThinkingSetting();
        const sessionOptions = {
          mode: permissionMode,
          model,
          thinking,
          provider: effectiveProvider,
          executor: session?.executor,
        };
        const attachmentsArg =
          currentAttachments.length > 0 ? currentAttachments : undefined;
        setEditRewind(null);
        if (isCodexAppServerProvider(effectiveProvider)) {
          const rollbackNumTurns =
            editRewind.rollbackNumTurns ??
            calculateCodexRollbackNumTurns(messages, editRewind.uuid);
          if (!rollbackNumTurns) {
            throw new Error("Could not determine Codex rollback point");
          }
          truncateMessagesBefore(editRewind.uuid);
          const result = await api.resumeSession(
            projectId,
            sessionId,
            text,
            sessionOptions,
            attachmentsArg,
            tempId,
            undefined,
            rollbackNumTurns,
          );
          draftControlsRef.current?.clearDraft();
          setStatus({ owner: "self", processId: result.processId });
          queueEditBranchRefresh();
          reconnectStream();
        } else if (editRewind.parentUuid) {
          truncateMessagesBefore(editRewind.uuid);
          const result = await api.resumeSession(
            projectId,
            sessionId,
            text,
            sessionOptions,
            attachmentsArg,
            tempId,
            editRewind.parentUuid,
          );
          draftControlsRef.current?.clearDraft();
          setStatus({ owner: "self", processId: result.processId });
          queueEditBranchRefresh();
          reconnectStream();
        } else {
          // Edited the first message — no parent to rewind to; start fresh.
          const result = await api.startSession(
            projectId,
            text,
            sessionOptions,
            attachmentsArg,
          );
          draftControlsRef.current?.clearDraft();
          removePendingMessage(tempId);
          navigate(
            `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
          );
        }
        return;
      }

      if (status.owner === "none") {
        // Resume the session with current permission mode and model settings
        // Use session's existing model if available (important for non-Claude providers),
        // otherwise fall back to user's model preference for new Claude sessions
        const model = session?.model ?? getModelSetting();
        const thinking = getThinkingSetting();
        // Use effectiveProvider to ensure correct provider even if session data hasn't loaded
        // effectiveProvider = session?.provider ?? initialProvider (from navigation state)
        const result = await api.resumeSession(
          projectId,
          sessionId,
          text,
          {
            mode: permissionMode,
            model,
            thinking,
            provider: effectiveProvider,
            executor: session?.executor,
          },
          currentAttachments.length > 0 ? currentAttachments : undefined,
          tempId,
        );
        // Update status to trigger SSE connection
        setStatus({ owner: "self", processId: result.processId });
      } else {
        // Queue to existing process with current permission mode and thinking setting
        const thinking = getThinkingSetting();
        const result = await api.queueMessage(
          sessionId,
          text,
          permissionMode,
          currentAttachments.length > 0 ? currentAttachments : undefined,
          tempId,
          thinking,
        );
        // If process was restarted due to thinking mode change, reconnect stream
        if (result.restarted && result.processId) {
          setStatus({ owner: "self", processId: result.processId });
          reconnectStream();
        }
      }
      // Success - clear the draft from localStorage
      draftControlsRef.current?.clearDraft();
    } catch (err) {
      console.error("Failed to send:", err);

      // Check if process is dead (404) - auto-retry with resumeSession
      const is404 =
        err instanceof Error &&
        (err.message.includes("404") ||
          err.message.includes("No active process"));
      if (is404) {
        try {
          const model = session?.model ?? getModelSetting();
          const thinking = getThinkingSetting();
          const result = await api.resumeSession(
            projectId,
            sessionId,
            text,
            {
              mode: permissionMode,
              model,
              thinking,
              provider: effectiveProvider,
              executor: session?.executor,
            },
            currentAttachments.length > 0 ? currentAttachments : undefined,
            tempId,
          );
          setStatus({ owner: "self", processId: result.processId });
          draftControlsRef.current?.clearDraft();
          return;
        } catch (retryErr) {
          console.error("Failed to resume session:", retryErr);
          // Fall through to error handling below
        }
      }

      // Remove from pending queue and restore draft on error
      removePendingMessage(tempId);
      draftControlsRef.current?.restoreFromStorage();
      setAttachments(currentAttachments); // Restore attachments on error
      setProcessState("idle");
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("sessionSendFailed", { message: errorMsg }), "error");
    }
  };

  const handleQueue = async (text: string) => {
    if (!isSessionReady) return;

    const tempId = addPendingMessage(text);
    setScrollTrigger((prev) => prev + 1);

    // Capture already-completed attachments
    const currentAttachments = [...attachments];

    // Wait for any in-flight uploads to complete before queuing
    const pendingAtSendTime = [...pendingUploadsRef.current.values()];
    if (pendingAtSendTime.length > 0) {
      updatePendingMessage(tempId, { status: t("sessionUploading") });
      setAttachments([]);
      const results = await Promise.all(pendingAtSendTime);
      for (const result of results) {
        if (result) currentAttachments.push(result);
      }
      const sentIds = new Set(currentAttachments.map((a) => a.id));
      setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
      updatePendingMessage(tempId, { status: undefined });
    } else {
      setAttachments([]);
    }

    try {
      const thinking = getThinkingSetting();
      await api.queueMessage(
        sessionId,
        text,
        permissionMode,
        currentAttachments.length > 0 ? currentAttachments : undefined,
        tempId,
        thinking,
        true, // deferred
      );
      removePendingMessage(tempId);
      draftControlsRef.current?.clearDraft();
    } catch (err) {
      console.error("Failed to queue deferred message:", err);
      removePendingMessage(tempId);
      draftControlsRef.current?.restoreFromStorage();
      setAttachments(currentAttachments);
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("sessionQueueFailed", { message: errorMsg }), "error");
    }
  };

  const handleModelChanged = useCallback(
    (model: string) => {
      setSessionModel(model);
      showToast(t("sessionSwitchedModel", { model }), "success");
    },
    [setSessionModel, showToast, t],
  );

  const handleCustomCommand = useCallback((command: string) => {
    if (command === "model") {
      setShowModelSwitchModal(true);
      return true;
    }
    return false;
  }, []);

  const handleAbort = async () => {
    if (status.owner === "self" && status.processId) {
      // Try interrupt first (graceful stop), fall back to abort if not supported
      try {
        const result = await api.interruptProcess(status.processId);
        if (result.interrupted) {
          // Successfully interrupted - process is still alive
          return;
        }
        // Interrupt not supported or failed, fall back to abort
      } catch {
        // Interrupt endpoint failed (404 = old server, or other error)
      }
      // Fall back to abort (kills the process)
      await api.abortProcess(status.processId);
    }
  };

  const handleStalePendingInput = useCallback(() => {
    markPendingInputResolved("waiting-input");
  }, [markPendingInputResolved]);

  const handleApprove = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(sessionId, pendingInputRequest.id, "approve");
        markPendingInputResolved("in-turn");
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          handleStalePendingInput();
          return;
        }
        const msg = status ? `Error ${status}` : t("sessionApproveFailed");
        showToast(msg, "error");
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    markPendingInputResolved,
    handleStalePendingInput,
    showToast,
    t,
  ]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        // Approve and switch to acceptEdits mode
        await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve_accept_edits",
        );
        // Update local permission mode
        setPermissionMode("acceptEdits");
        markPendingInputResolved("in-turn");
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          handleStalePendingInput();
          return;
        }
        const msg = status ? `Error ${status}` : t("sessionApproveFailed");
        showToast(msg, "error");
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    setPermissionMode,
    markPendingInputResolved,
    handleStalePendingInput,
    showToast,
    t,
  ]);

  const handleApproveForSession = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve_for_session",
        );
        markPendingInputResolved("in-turn");
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          handleStalePendingInput();
          return;
        }
        const msg = status ? `Error ${status}` : t("sessionApproveFailed");
        showToast(msg, "error");
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    markPendingInputResolved,
    handleStalePendingInput,
    showToast,
    t,
  ]);

  const handleApproveAlways = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve_always",
        );
        markPendingInputResolved("in-turn");
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          handleStalePendingInput();
          return;
        }
        const msg = status ? `Error ${status}` : t("sessionApproveFailed");
        showToast(msg, "error");
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    markPendingInputResolved,
    handleStalePendingInput,
    showToast,
    t,
  ]);

  const handleDeny = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(sessionId, pendingInputRequest.id, "deny");
        markPendingInputResolved("in-turn");
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          handleStalePendingInput();
          return;
        }
        const msg = status ? `Error ${status}` : t("sessionDenyFailed");
        showToast(msg, "error");
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    markPendingInputResolved,
    handleStalePendingInput,
    showToast,
    t,
  ]);

  const handleDenyWithFeedback = useCallback(
    async (feedback: string) => {
      if (pendingInputRequest) {
        try {
          await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "deny",
            undefined,
            feedback,
          );
          markPendingInputResolved("in-turn");
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404) {
            handleStalePendingInput();
            return;
          }
          const msg = status ? `Error ${status}` : t("sessionFeedbackFailed");
          showToast(msg, "error");
        }
      }
    },
    [
      sessionId,
      pendingInputRequest,
      markPendingInputResolved,
      handleStalePendingInput,
      showToast,
      t,
    ],
  );

  const handleQuestionSubmit = useCallback(
    async (answers: Record<string, string>) => {
      if (pendingInputRequest) {
        try {
          await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "approve",
            answers,
          );
          markPendingInputResolved("in-turn");
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404) {
            handleStalePendingInput();
            return;
          }
          const msg = status ? `Error ${status}` : t("sessionAnswerFailed");
          showToast(msg, "error");
        }
      }
    },
    [
      sessionId,
      pendingInputRequest,
      markPendingInputResolved,
      handleStalePendingInput,
      showToast,
      t,
    ],
  );

  // Handle file attachment uploads
  // Each file uploads independently (parallel) and its promise is tracked
  // so handleSend can wait for in-flight uploads before sending
  const handleAttach = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const tempId = generateUUID();

        // Add to progress tracking
        setUploadProgress((prev) => [
          ...prev,
          {
            fileId: tempId,
            fileName: file.name,
            bytesUploaded: 0,
            totalBytes: file.size,
            percent: 0,
          },
        ]);

        // Start upload and track promise for handleSend to await
        const uploadPromise = connection
          .upload(projectId, sessionId, file, {
            onProgress: (bytesUploaded) => {
              setUploadProgress((prev) =>
                prev.map((p) =>
                  p.fileId === tempId
                    ? {
                        ...p,
                        bytesUploaded,
                        percent: Math.round((bytesUploaded / file.size) * 100),
                      }
                    : p,
                ),
              );
            },
          })
          .then(
            (uploaded) => {
              setAttachments((prev) => [...prev, uploaded]);
              return uploaded;
            },
            (err) => {
              console.error("Upload failed:", err);
              const errorMsg =
                err instanceof Error ? err.message : t("sessionShareFailed");
              showToast(
                t("sessionUploadFailed", {
                  file: file.name,
                  message: errorMsg,
                }),
                "error",
              );
              return null as UploadedFile | null;
            },
          )
          .finally(() => {
            setUploadProgress((prev) =>
              prev.filter((p) => p.fileId !== tempId),
            );
            pendingUploadsRef.current.delete(tempId);
          });

        pendingUploadsRef.current.set(tempId, uploadPromise);
      }
    },
    [projectId, sessionId, showToast, connection, t],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Check if pending request is an AskUserQuestion
  const isAskUserQuestion = pendingInputRequest?.toolName === "AskUserQuestion";
  const isPersistedInputRequest = pendingInputRequest?.source === "persisted";

  // If process is actively in-turn or waiting for input, don't mark tools as orphaned.
  // "orphanedToolUseIds" from server just means "no result yet" - but if the process is
  // in-turn (e.g., executing a Task subagent) or waiting for approval, they're not orphaned.
  // Also suppress orphan marking when the session stream is disconnected - we can't trust
  // processState without the stream, so show tools as pending (spinner) rather than
  // incorrectly marking them as interrupted.
  const activeToolApproval =
    processState === "in-turn" ||
    processState === "waiting-input" ||
    (hasSessionUpdateStream && !sessionUpdatesConnected);

  const renderItems = useMemo(() => {
    const result = preprocessMessagesCached(
      messages,
      {
        markdown: markdownAugments,
        activeToolApproval,
      },
      preprocessCacheRef.current,
    );
    preprocessCacheRef.current = result.cache;
    return result.renderItems;
  }, [messages, markdownAugments, activeToolApproval]);

  // Detect if session has pending tool calls without results
  // This can happen when the session is unowned but was active in another process (VS Code, CLI)
  // that is waiting for user input (tool approval, question answer)
  const hasPendingToolCalls = useMemo(() => {
    if (status.owner !== "none") return false;
    return renderItems.some(
      (item) => item.type === "tool_call" && item.status === "pending",
    );
  }, [renderItems, status.owner]);

  // Compute display title - priority:
  // 1. Local custom title (user renamed in this session)
  // 2. Session title from server
  // 3. Initial title from navigation state (optimistic, before server responds)
  // 4. "Untitled" as final fallback
  const sessionTitle = getSessionDisplayTitle(session);
  const displayTitle =
    localCustomTitle ??
    (sessionTitle !== "Untitled" ? sessionTitle : null) ??
    initialTitle ??
    t("sessionUntitled");
  const isArchived = localIsArchived ?? session?.isArchived ?? false;
  const isStarred = localIsStarred ?? session?.isStarred ?? false;
  const isRuntimeBusy =
    processState === "in-turn" ||
    processState === "waiting-input" ||
    processState === "hold" ||
    session?.runtime?.isBusy === true;
  const canArchive =
    isArchived ||
    (session?.runtime?.canArchive ??
      !(isRuntimeBusy || status.owner === "external"));
  const archiveBlockReason =
    session?.runtime?.archiveBlockReason ??
    getArchiveBlockReasonForState(status.owner, processState);

  // Update browser tab title
  useDocumentTitle(project?.name, displayTitle);

  const handleStartEditingTitle = () => {
    setRenameValue(displayTitle);
    setIsEditingTitle(true);
    // Focus the input and select all text after it renders
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  const handleCancelEditingTitle = () => {
    // Don't cancel if we're in the middle of saving
    if (isSavingTitleRef.current) return;
    setIsEditingTitle(false);
    setRenameValue("");
  };

  // On blur, save if value changed (handles mobile keyboard dismiss on Enter)
  const handleTitleBlur = () => {
    // Don't interfere if we're already saving
    if (isSavingTitleRef.current) return;
    // If value is empty or unchanged, just cancel
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditingTitle();
      return;
    }
    // Otherwise save (handles mobile Enter which blurs before keydown fires)
    handleSaveTitle();
  };

  const handleSaveTitle = async () => {
    if (!renameValue.trim() || isRenaming) return;
    isSavingTitleRef.current = true;
    setIsRenaming(true);
    try {
      await api.updateSessionMetadata(sessionId, { title: renameValue.trim() });
      setLocalCustomTitle(renameValue.trim());
      setIsEditingTitle(false);
      showToast(t("sessionRenamed"), "success");
    } catch (err) {
      console.error("Failed to rename session:", err);
      showToast(t("sessionRenameFailed"), "error");
    } finally {
      setIsRenaming(false);
      isSavingTitleRef.current = false;
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEditingTitle();
    }
  };

  const handleToggleArchive = async () => {
    const newArchived = !isArchived;
    if (newArchived && !canArchive) {
      showToast(archiveBlockReason, "error");
      return;
    }
    try {
      await api.updateSessionMetadata(sessionId, { archived: newArchived });
      setLocalIsArchived(newArchived);
      showToast(
        newArchived ? t("sessionArchived") : t("sessionUnarchived"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update archive status:", err);
      showToast(
        err instanceof Error ? err.message : t("sessionArchiveFailed"),
        "error",
      );
    }
  };

  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      setLocalIsStarred(newStarred);
      showToast(
        newStarred ? t("sessionStarred") : t("sessionUnstarred"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update star status:", err);
      showToast(t("sessionStarFailed"), "error");
    }
  };

  const hasUnread = localHasUnread ?? session?.hasUnread ?? false;

  const handleToggleRead = async () => {
    const newHasUnread = !hasUnread;
    setLocalHasUnread(newHasUnread);
    try {
      if (newHasUnread) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      showToast(
        newHasUnread ? t("sessionMarkedUnread") : t("sessionMarkedRead"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined); // Revert on error
      showToast(t("sessionReadFailed"), "error");
    }
  };

  const handleTerminate = async () => {
    if (status.owner === "self" && status.processId) {
      try {
        await api.abortProcess(status.processId);
        showToast(t("sessionTerminated"), "success");
      } catch (err) {
        console.error("Failed to terminate session:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(t("sessionTerminateFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleShare = useCallback(async () => {
    try {
      const { snapshotSession } = await import(
        "../lib/sharing/snapshotSession"
      );
      const html = snapshotSession(displayTitle);
      const result = await api.shareSession(html, displayTitle);
      await navigator.clipboard.writeText(result.url);
      showToast(t("sessionLinkCopied"), "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("sessionShareFailed");
      showToast(msg, "error");
    }
  }, [displayTitle, showToast, t]);

  // Sidebar icon component
  const SidebarIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );

  const SessionOutlineIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="14" y2="12" />
      <line x1="4" y1="18" x2="18" y2="18" />
    </svg>
  );

  const SessionInfoIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );

  const RepoIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <line x1="9" y1="13" x2="15" y2="13" />
    </svg>
  );

  const loadFailure =
    error ??
    (!loading && !session
      ? new Error("Session data could not be loaded")
      : null);

  if (loadFailure) {
    return (
      <div className="error session-load-error">
        <div>
          {t("sessionErrorPrefix")} {loadFailure.message}
        </div>
        <button type="button" onClick={retryInitialLoad}>
          {t("sessionRetry")}
        </button>
      </div>
    );
  }

  return (
    <FileTabOpenerContext.Provider value={{ openFileTab: openOrFocusFileTab }}>
      <div
        className={
          isWideScreen
            ? "main-content-wrapper session-main-wrapper"
            : "main-content-mobile"
        }
      >
        <div
          className={
            isWideScreen
              ? "main-content-constrained"
              : "main-content-mobile-inner"
          }
        >
          <header className="session-header">
            <div className="session-header-inner">
              <div className="session-header-left">
                {/* Sidebar toggle - on mobile: opens sidebar, on desktop: collapses/expands */}
                {/* Hide on desktop when collapsed (sidebar has its own toggle) */}
                {!(isWideScreen && isSidebarCollapsed) && (
                  <button
                    type="button"
                    className="sidebar-toggle"
                    onClick={isWideScreen ? toggleSidebar : openSidebar}
                    title={
                      isWideScreen
                        ? t("sessionToggleSidebar")
                        : t("sessionOpenSidebar")
                    }
                    aria-label={
                      isWideScreen
                        ? t("sessionToggleSidebar")
                        : t("sessionOpenSidebar")
                    }
                  >
                    <SidebarIcon />
                  </button>
                )}
                {/* Project breadcrumb */}
                {project?.name && (
                  <Link
                    to={`${basePath}/sessions?project=${projectId}`}
                    className="project-breadcrumb"
                    title={project.name}
                  >
                    {project.name.length > 12
                      ? `${project.name.slice(0, 12)}...`
                      : project.name}
                  </Link>
                )}
                <div className="session-title-row">
                  {isStarred && (
                    <svg
                      className="star-indicator-inline"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth="2"
                      role="img"
                      aria-label={t("sessionStarredLabel")}
                    >
                      <title>{t("sessionStarredLabel")}</title>
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  )}
                  {loading ? (
                    <span className="session-title-skeleton" />
                  ) : isEditingTitle ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      className="session-title-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={handleTitleKeyDown}
                      onBlur={handleTitleBlur}
                      disabled={isRenaming}
                    />
                  ) : (
                    <>
                      <button
                        ref={titleButtonRef}
                        type="button"
                        className="session-title session-title-dropdown-trigger"
                        onClick={() =>
                          setShowRecentSessions(!showRecentSessions)
                        }
                        title={session?.fullTitle ?? displayTitle}
                      >
                        <span className="session-title-text">
                          {displayTitle}
                        </span>
                        <svg
                          className="session-title-chevron"
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                      <RecentSessionsDropdown
                        currentSessionId={sessionId}
                        isOpen={showRecentSessions}
                        onClose={() => setShowRecentSessions(false)}
                        onNavigate={() => setShowRecentSessions(false)}
                        triggerRef={titleButtonRef}
                        basePath={basePath}
                      />
                    </>
                  )}
                  {!loading && isArchived && (
                    <span className="archived-badge">
                      {t("sessionArchivedBadge")}
                    </span>
                  )}
                  {!loading && (
                    <SessionMenu
                      sessionId={sessionId}
                      projectId={projectId}
                      isStarred={isStarred}
                      isArchived={isArchived}
                      hasUnread={hasUnread}
                      provider={session?.provider}
                      processId={
                        status.owner === "self" ? status.processId : undefined
                      }
                      canArchive={canArchive}
                      archiveBlockReason={archiveBlockReason}
                      onToggleStar={handleToggleStar}
                      onToggleArchive={handleToggleArchive}
                      onToggleRead={handleToggleRead}
                      onRename={handleStartEditingTitle}
                      onClone={(newSessionId) => {
                        navigate(
                          `${basePath}/projects/${projectId}/sessions/${newSessionId}`,
                        );
                      }}
                      onTerminate={handleTerminate}
                      sharingConfigured={sharingConfigured}
                      onShare={handleShare}
                      useFixedPositioning
                      useEllipsisIcon
                    />
                  )}
                </div>
              </div>
              <div className="session-header-right">
                {!isWideScreen && (
                  <button
                    type="button"
                    className="session-inspector-toggle"
                    onClick={() => setInspectorOpen(true)}
                    title={t("sessionInspectorOpen")}
                    aria-label={t("sessionInspectorOpen")}
                  >
                    <SessionOutlineIcon />
                  </button>
                )}
                {!loading && session && (
                  <button
                    type="button"
                    className="session-info-button"
                    onClick={() => setShowProcessInfoModal(true)}
                    title={t("sessionViewInfo")}
                    aria-label={t("sessionViewInfo")}
                  >
                    <SessionInfoIcon />
                  </button>
                )}
              </div>
            </div>
          </header>

          {/* Process Info Modal */}
          {showProcessInfoModal && session && (
            <ProcessInfoModal
              sessionId={actualSessionId}
              provider={session.provider}
              model={session.model}
              status={status}
              processState={processState}
              contextUsage={session.contextUsage}
              originator={session.originator}
              cliVersion={session.cliVersion}
              sessionSource={session.source}
              approvalPolicy={session.approvalPolicy}
              sandboxPolicy={session.sandboxPolicy}
              createdAt={session.createdAt}
              sessionStreamConnected={sessionUpdatesConnected}
              lastSessionEventAt={lastStreamActivityAt}
              onClose={() => setShowProcessInfoModal(false)}
            />
          )}

          {/* Model Switch Modal */}
          {showModelSwitchModal &&
            status.owner === "self" &&
            status.processId && (
              <ModelSwitchModal
                processId={status.processId}
                currentModel={session?.model}
                onModelChanged={handleModelChanged}
                onClose={() => setShowModelSwitchModal(false)}
              />
            )}

          {status.owner === "external" && (
            <div className="external-session-warning">
              {t("sessionExternalWarning")}
            </div>
          )}

          {hasPendingToolCalls && (
            <div className="external-session-warning pending-tool-warning">
              {t("sessionPendingElsewhereWarning")}
            </div>
          )}

          <div
            className="editor-tabbar"
            role="tablist"
            aria-label={t("editorTabs" as never)}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "chat"}
              className={`editor-tab${activeTab === "chat" ? " is-active" : ""}`}
              onClick={() => setActiveTab("chat")}
            >
              <span className="editor-tab-label">
                {t("editorTabChat" as never)}
              </span>
            </button>
            {openFileTabs.map((p) => (
              <div
                key={p}
                role="tab"
                aria-selected={activeTab === p}
                tabIndex={0}
                className={`editor-tab editor-tab--file${activeTab === p ? " is-active" : ""}${dirtyTabs.has(p) ? " is-dirty" : ""}`}
              >
                <button
                  type="button"
                  className="editor-tab-main"
                  onClick={() => setActiveTab(p)}
                  title={p}
                >
                  <TabFileIcon />
                  <span className="editor-tab-label">{p.split("/").pop()}</span>
                  {dirtyTabs.has(p) && (
                    <span className="editor-tab-dot" aria-hidden="true">
                      ●
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="editor-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    requestCloseTab(p);
                  }}
                  aria-label={t("editorClose" as never)}
                  title={t("editorClose" as never)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="session-workbench-body">
            <div
              className={`chat-panel${activeTab === "chat" ? " is-active" : ""}`}
            >
              <main className="session-messages">
                {loading ? (
                  <SessionMessagesSkeleton />
                ) : (
                  <SessionMetadataProvider
                    projectId={projectId}
                    projectPath={project?.path ?? null}
                    sessionId={sessionId}
                  >
                    <AgentContentProvider
                      agentContent={agentContent}
                      setAgentContent={setAgentContent}
                      toolUseToAgent={toolUseToAgent}
                      projectId={projectId}
                      sessionId={sessionId}
                    >
                      <MessageList
                        messages={messages}
                        preprocessedItems={renderItems}
                        provider={session?.provider}
                        isProcessing={
                          status.owner === "self" && processState === "in-turn"
                        }
                        isCompacting={isCompacting}
                        scrollTrigger={scrollTrigger}
                        pendingMessages={pendingMessages}
                        deferredMessages={deferredMessages}
                        onCancelDeferred={(tempId) =>
                          api.cancelDeferredMessage(sessionId, tempId)
                        }
                        markdownAugments={markdownAugments}
                        activeToolApproval={activeToolApproval}
                        hasOlderMessages={pagination?.hasOlderMessages}
                        hasNewerMessages={pagination?.hasNewerMessages}
                        loadingOlder={loadingOlder}
                        loadingNewer={loadingNewer}
                        loadingTargetMessage={loadingTargetMessage}
                        onLoadOlderMessages={loadOlderMessages}
                        onLoadNewerMessages={loadNewerMessages}
                        onLoadTargetMessage={loadTargetMessageWindow}
                        onEditUserPrompt={
                          !isViewingHistoricalBranch &&
                          (session?.provider === "claude" ||
                            session?.provider === "codex" ||
                            !session?.provider)
                            ? handleEditUserPrompt
                            : undefined
                        }
                        onSelectBranch={handleSelectBranch}
                        focusBranchId={pendingBranchFocusId}
                        onBranchFocused={handleBranchFocused}
                        targetMessageId={targetMessageId}
                        onTargetFocused={handleTargetFocused}
                      />
                    </AgentContentProvider>
                  </SessionMetadataProvider>
                )}
              </main>

              <footer className="session-input">
                <div
                  className={`session-connection-bar session-connection-${sessionConnectionStatus}`}
                />
                <div className="session-input-inner">
                  {/* User question panel */}
                  {pendingInputRequest &&
                    pendingInputRequest.sessionId === actualSessionId &&
                    isAskUserQuestion && (
                      <QuestionAnswerPanel
                        request={pendingInputRequest}
                        sessionId={actualSessionId}
                        onSubmit={handleQuestionSubmit}
                        onDeny={handleDeny}
                        readOnly={isPersistedInputRequest}
                      />
                    )}

                  {/* Tool approval: show panel + always-visible toolbar */}
                  {pendingInputRequest &&
                    pendingInputRequest.sessionId === actualSessionId &&
                    !isAskUserQuestion && (
                      <>
                        <ToolApprovalPanel
                          request={pendingInputRequest}
                          sessionId={actualSessionId}
                          agentName={approvalAgentName}
                          onApprove={handleApprove}
                          onDeny={handleDeny}
                          onApproveAcceptEdits={handleApproveAcceptEdits}
                          onApproveForSession={handleApproveForSession}
                          onApproveAlways={handleApproveAlways}
                          onDenyWithFeedback={handleDenyWithFeedback}
                          collapsed={approvalCollapsed}
                          onCollapsedChange={setApprovalCollapsed}
                        />
                        <MessageInputToolbar
                          mode={permissionMode}
                          onModeChange={setPermissionMode}
                          isHeld={holdModeEnabled ? isHeld : undefined}
                          onHoldChange={holdModeEnabled ? setHold : undefined}
                          supportsPermissionMode={supportsPermissionMode}
                          supportsThinkingToggle={supportsThinkingToggle}
                          contextUsage={session?.contextUsage}
                          projectId={projectId}
                          sessionId={actualSessionId}
                          isRunning={status.owner === "self"}
                          isThinking={processState === "in-turn"}
                          onStop={handleAbort}
                          pendingApproval={
                            approvalCollapsed
                              ? {
                                  type: "tool-approval",
                                  onExpand: () => setApprovalCollapsed(false),
                                }
                              : undefined
                          }
                        />
                      </>
                    )}

                  {/* Edit/rewind banner: shown while editing a past message */}
                  {editRewind && (
                    <div
                      className="edit-rewind-banner"
                      data-testid="edit-rewind-banner"
                    >
                      <span className="edit-rewind-banner-text">
                        {t("sessionEditingFromHere")}
                      </span>
                      <button
                        type="button"
                        className="edit-rewind-banner-cancel"
                        onClick={handleCancelEdit}
                      >
                        {t("actionCancel")}
                      </button>
                    </div>
                  )}

                  {/* No pending approval: show full message input */}
                  {!(
                    pendingInputRequest &&
                    pendingInputRequest.sessionId === actualSessionId &&
                    !isAskUserQuestion
                  ) && (
                    <MessageInput
                      onSend={handleSend}
                      onQueue={
                        isSessionReady &&
                        status.owner !== "none" &&
                        processState !== "idle"
                          ? handleQueue
                          : undefined
                      }
                      disabled={!isSessionReady}
                      placeholder={
                        status.owner === "external"
                          ? t("sessionPlaceholderExternal")
                          : processState === "idle"
                            ? t("sessionPlaceholderResume")
                            : t("sessionPlaceholderQueue")
                      }
                      mode={permissionMode}
                      onModeChange={setPermissionMode}
                      isHeld={holdModeEnabled ? isHeld : undefined}
                      onHoldChange={holdModeEnabled ? setHold : undefined}
                      supportsPermissionMode={supportsPermissionMode}
                      supportsThinkingToggle={supportsThinkingToggle}
                      isRunning={status.owner === "self"}
                      isThinking={processState === "in-turn"}
                      onStop={handleAbort}
                      draftKey={`draft-message-${sessionId}`}
                      onDraftControlsReady={handleDraftControlsReady}
                      collapsed={
                        !!(
                          pendingInputRequest &&
                          pendingInputRequest.sessionId === actualSessionId
                        )
                      }
                      contextUsage={session?.contextUsage}
                      projectId={projectId}
                      sessionId={sessionId}
                      attachments={attachments}
                      onAttach={handleAttach}
                      onRemoveAttachment={handleRemoveAttachment}
                      uploadProgress={uploadProgress}
                      commandPrefix={commandPrefix}
                      commandLabel={commandLabel}
                      commands={activeCommands}
                      showCommandButton={showCommandButton}
                      commandButtons={commandButtons}
                      onCustomCommand={handleCustomCommand}
                    />
                  )}
                </div>
              </footer>
            </div>
            {openFileTabs.map((p) => (
              <div
                key={p}
                className={`file-panel${activeTab === p ? " is-active" : ""}`}
              >
                <FileEditor
                  projectId={projectId}
                  filePath={p}
                  onClose={() => requestCloseTab(p)}
                  onDirtyChange={(d) => handleTabDirty(p, d)}
                  onSaveRef={(fn) => updateSaveHandler(p, fn)}
                />
              </div>
            ))}
          </div>
          {pendingCloseTab && (
            <Modal
              title={t("editorUnsavedConfirmTitle" as never)}
              onClose={() => setPendingCloseTab(null)}
            >
              <div className="unsaved-confirm">
                <p>
                  {t("editorUnsavedConfirmBody" as never, {
                    name: pendingCloseTab.split("/").pop() || pendingCloseTab,
                  })}
                </p>
                <div className="unsaved-confirm-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => confirmCloseTab(true)}
                  >
                    {t("editorSaveAndClose" as never)}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => confirmCloseTab(false)}
                  >
                    {t("editorCloseWithoutSave" as never)}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setPendingCloseTab(null)}
                  >
                    {t("editorCancel" as never)}
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </div>
        {isWideScreen ? (
          <SessionInspector
            presentation="sidebar"
            inspectorWidth={inspector.width}
            onResizeStart={() => inspector.setIsResizing(true)}
            onResize={inspector.setWidth}
            onResizeEnd={() => inspector.setIsResizing(false)}
            messages={messages}
            userQuestions={session?.userQuestions}
            markdownAugments={markdownAugments}
            activeToolApproval={activeToolApproval}
            projectId={projectId}
            sessionId={actualSessionId}
            provider={session?.provider}
            model={session?.model}
            reasoningEffort={session?.reasoningEffort}
            serviceTier={session?.serviceTier}
            basePath={basePath}
            status={status}
            processState={processState}
            onSelectMessage={handleInspectorSelectMessage}
            onOpenFile={(path) => openOrFocusFileTab(path)}
            processId={status.owner === "self" ? status.processId : undefined}
            providers={providers}
          />
        ) : (
          <SessionInspector
            presentation="drawer"
            isOpen={isInspectorOpen}
            onClose={() => setInspectorOpen(false)}
            messages={messages}
            userQuestions={session?.userQuestions}
            markdownAugments={markdownAugments}
            activeToolApproval={activeToolApproval}
            projectId={projectId}
            sessionId={actualSessionId}
            provider={session?.provider}
            model={session?.model}
            reasoningEffort={session?.reasoningEffort}
            serviceTier={session?.serviceTier}
            basePath={basePath}
            status={status}
            processState={processState}
            onSelectMessage={handleInspectorSelectMessage}
            onOpenFile={(path) => openOrFocusFileTab(path)}
            processId={status.owner === "self" ? status.processId : undefined}
            providers={providers}
          />
        )}
      </div>
    </FileTabOpenerContext.Provider>
  );
}

function TabFileIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3v5h5" />
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    </svg>
  );
}

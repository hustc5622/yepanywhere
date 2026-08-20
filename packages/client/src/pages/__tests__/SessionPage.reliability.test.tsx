import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionMetadata } from "../../types";
import { SessionPageContent } from "../SessionPage";

const mocks = vi.hoisted(() => ({
  addPendingMessage: vi.fn(() => "temp-1"),
  getSharingStatus: vi.fn(),
  navigate: vi.fn(),
  queueMessage: vi.fn(),
  resumeSession: vi.fn(),
  retryInitialLoad: vi.fn(),
  setProcessState: vi.fn(),
  setStatus: vi.fn(),
  showToast: vi.fn(),
  sessionState: {} as Record<string, unknown>,
}));

vi.mock("../../api/client", () => ({
  api: {
    getSharingStatus: mocks.getSharingStatus,
    queueMessage: mocks.queueMessage,
    resumeSession: mocks.resumeSession,
  },
}));

vi.mock("../../components/FileEditor", () => ({ FileEditor: () => null }));
vi.mock("../../components/MessageInput", () => ({
  MessageInput: ({
    disabled,
    onQueue,
    onSend,
  }: {
    disabled?: boolean;
    onQueue?: (text: string) => void;
    onSend: (text: string) => void;
  }) => (
    <button
      type="button"
      data-testid="message-input"
      data-has-queue={onQueue ? "true" : "false"}
      disabled={disabled}
      onClick={() => onSend("follow up")}
    >
      Send
    </button>
  ),
}));
vi.mock("../../components/MessageInputToolbar", () => ({
  MessageInputToolbar: () => null,
}));
vi.mock("../../components/MessageList", () => ({ MessageList: () => null }));
vi.mock("../../components/ModelSwitchModal", () => ({
  ModelSwitchModal: () => null,
}));
vi.mock("../../components/ProcessInfoModal", () => ({
  ProcessInfoModal: () => null,
}));
vi.mock("../../components/QuestionAnswerPanel", () => ({
  QuestionAnswerPanel: () => null,
}));
vi.mock("../../components/RecentSessionsDropdown", () => ({
  RecentSessionsDropdown: () => null,
}));
vi.mock("../../components/SessionInspector", () => ({
  SessionInspector: () => null,
}));
vi.mock("../../components/SessionMenu", () => ({ SessionMenu: () => null }));
vi.mock("../../components/Skeleton", () => ({
  SessionMessagesSkeleton: () => null,
}));
vi.mock("../../components/ToolApprovalPanel", () => ({
  ToolApprovalPanel: () => null,
}));
vi.mock("../../components/ui/Modal", () => ({ Modal: () => null }));

vi.mock("../../contexts/AgentContentContext", () => ({
  AgentContentProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../contexts/SessionMetadataContext", () => ({
  SessionMetadataProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../contexts/StreamingMarkdownContext", () => ({
  StreamingMarkdownProvider: ({ children }: { children: ReactNode }) =>
    children,
  useStreamingMarkdownContext: () => null,
}));
vi.mock("../../contexts/ToastContext", () => ({
  useToastContext: () => ({ showToast: mocks.showToast }),
}));

vi.mock("../../hooks/useActivityBusState", () => ({
  useActivityBusState: () => ({ connectionState: "connected" }),
}));
vi.mock("../../hooks/useConnection", () => ({
  useConnection: () => ({ upload: vi.fn() }),
}));
vi.mock("../../hooks/useDeveloperMode", () => ({
  useDeveloperMode: () => ({
    holdModeEnabled: false,
    showConnectionBars: false,
  }),
}));
vi.mock("../../hooks/useDocumentTitle", () => ({
  useDocumentTitle: vi.fn(),
}));
vi.mock("../../hooks/useEngagementTracking", () => ({
  useEngagementTracking: vi.fn(),
}));
vi.mock("../../hooks/useHideSplashOnReady", () => ({
  useHideSplashOnReady: vi.fn(),
}));
vi.mock("../../hooks/useInspectorWidth", () => ({
  useInspectorWidth: () => ({
    width: 320,
    setWidth: vi.fn(),
    setIsResizing: vi.fn(),
  }),
}));
vi.mock("../../hooks/useModelSettings", () => ({
  getModelSetting: () => "default",
  getThinkingSetting: () => false,
}));
vi.mock("../../hooks/useProjects", () => ({
  useProject: () => ({ project: { name: "Project", path: "D:/project" } }),
}));
vi.mock("../../hooks/useProviders", () => ({
  useProviders: () => ({ providers: [] }),
}));
vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));
vi.mock("../../hooks/useSession", () => ({
  useSession: () => mocks.sessionState,
}));
vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => (key === "sessionRetry" ? "Retry" : key),
  }),
}));
vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: false,
    toggleSidebar: vi.fn(),
    isSidebarCollapsed: false,
  }),
}));
vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  useLocation: () => ({ pathname: "/", state: null }),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ projectId: "project-1", sessionId: "session-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

const session: BrowserSessionMetadata = {
  id: "session-1",
  projectId: "project-1" as BrowserSessionMetadata["projectId"],
  title: "Reliable session",
  fullTitle: "Reliable session",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  messageCount: 0,
  ownership: { owner: "none" },
  provider: "codex",
};

function makeSessionState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session,
    messages: [],
    agentContent: {},
    setAgentContent: vi.fn(),
    toolUseToAgent: new Map(),
    markdownAugments: {},
    status: { owner: "none" },
    processState: "idle",
    isCompacting: false,
    pendingInputRequest: null,
    actualSessionId: "session-1",
    permissionMode: "default",
    loading: false,
    error: null,
    connected: false,
    sessionUpdatesConnected: false,
    lastStreamActivityAt: null,
    setStatus: mocks.setStatus,
    setProcessState: mocks.setProcessState,
    setPermissionMode: vi.fn(),
    setHold: vi.fn(),
    isHeld: false,
    pendingMessages: [],
    addPendingMessage: mocks.addPendingMessage,
    removePendingMessage: vi.fn(),
    updatePendingMessage: vi.fn(),
    deferredMessages: [],
    slashCommands: [],
    setSessionModel: vi.fn(),
    sessionTools: [],
    mcpServers: [],
    pagination: undefined,
    loadingOlder: false,
    loadingNewer: false,
    loadingTargetMessage: false,
    loadOlderMessages: vi.fn(),
    loadNewerMessages: vi.fn(),
    loadTargetMessageWindow: vi.fn(),
    reconnectStream: vi.fn(),
    truncateMessagesBefore: vi.fn(),
    refreshSessionMessages: vi.fn(),
    markPendingInputResolved: vi.fn(),
    retryInitialLoad: mocks.retryInitialLoad,
    ...overrides,
  };
}

function renderContent() {
  return render(
    <SessionPageContent projectId="project-1" sessionId="session-1" />,
  );
}

describe("SessionPageContent initial-load reliability", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSharingStatus.mockResolvedValue({ configured: false });
    mocks.resumeSession.mockResolvedValue({ processId: "process-2" });
    mocks.queueMessage.mockResolvedValue({ restarted: false });
    mocks.sessionState = makeSessionState();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("keeps Hook order stable when loading changes to a failed load", () => {
    mocks.sessionState = makeSessionState({
      loading: true,
      error: null,
      session: null,
    });
    const { rerender } = renderContent();

    mocks.sessionState = makeSessionState({
      loading: false,
      error: new Error("load failed"),
      session: null,
    });
    rerender(
      <SessionPageContent projectId="project-1" sessionId="session-1" />,
    );

    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
      "Rendered fewer hooks than expected",
    );
  });

  it("keeps Hook order stable when a ready session later reports failure", () => {
    const { rerender } = renderContent();

    mocks.sessionState = makeSessionState({
      loading: false,
      error: new Error("load failed"),
      session: null,
    });
    rerender(
      <SessionPageContent projectId="project-1" sessionId="session-1" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.retryInitialLoad).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
      "Rendered fewer hooks than expected",
    );
  });

  it("blocks input and queue actions until the session snapshot is ready", () => {
    mocks.sessionState = makeSessionState({
      loading: true,
      error: null,
      session: null,
      status: { owner: "self", processId: "process-1" },
      processState: "in-turn",
    });
    renderContent();

    const input = screen.getByTestId("message-input") as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(input.dataset.hasQueue).toBe("false");
    fireEvent.click(input);
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
    expect(mocks.addPendingMessage).not.toHaveBeenCalled();
  });

  it("resumes an unowned session once its snapshot is ready", async () => {
    renderContent();

    fireEvent.click(screen.getByTestId("message-input"));

    await waitFor(() => expect(mocks.resumeSession).toHaveBeenCalledTimes(1));
    expect(mocks.resumeSession).toHaveBeenCalledWith(
      "project-1",
      "session-1",
      "follow up",
      expect.any(Object),
      undefined,
      "temp-1",
    );
  });

  it("queues on the active process once its snapshot is ready", async () => {
    mocks.sessionState = makeSessionState({
      status: { owner: "self", processId: "process-1" },
      processState: "in-turn",
    });
    renderContent();

    const input = screen.getByTestId("message-input");
    expect(input.dataset.hasQueue).toBe("true");
    fireEvent.click(input);

    await waitFor(() => expect(mocks.queueMessage).toHaveBeenCalledTimes(1));
    expect(mocks.queueMessage).toHaveBeenCalledWith(
      "session-1",
      "follow up",
      "default",
      undefined,
      "temp-1",
      false,
    );
  });
});

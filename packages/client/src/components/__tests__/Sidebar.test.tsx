import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSessionItem } from "../../api/client";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import type { SessionMetadataChangedEvent } from "../../lib/activityBus";
import { UI_KEYS } from "../../lib/storageKeys";
import type { Project } from "../../types";
import { Sidebar } from "../Sidebar";

const {
  mockUseGlobalSessions,
  mockUseRecentProjects,
  mockUpdateSessionMetadata,
  mockFetchProjectGitRemotes,
  mockRenderSessionItem,
  mockActivityOn,
} = vi.hoisted(() => ({
  mockFetchProjectGitRemotes: vi.fn(),
  mockUseGlobalSessions: vi.fn(),
  mockUseRecentProjects: vi.fn(),
  mockUpdateSessionMetadata: vi.fn(),
  mockRenderSessionItem: vi.fn(),
  mockActivityOn: vi.fn((_event: string, _handler: unknown) => vi.fn()),
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: { on: mockActivityOn },
}));
vi.mock("../SessionListItem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../SessionListItem")>();
  return {
    ...actual,
    SessionListItem: (props: ComponentProps<typeof actual.SessionListItem>) => {
      mockRenderSessionItem(props.sessionId);
      return <actual.SessionListItem {...props} />;
    },
  };
});

vi.mock("../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: mockUseGlobalSessions,
}));

vi.mock("../../api/client", () => ({
  api: {
    updateSessionMetadata: mockUpdateSessionMetadata,
    fetchProjectGitRemotes: mockFetchProjectGitRemotes,
  },
}));

vi.mock("../../hooks/useRecentProjects", () => ({
  useRecentProjects: mockUseRecentProjects,
}));

function createSession(
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id: "session-1",
    title: "Session 1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    messageCount: 1,
    provider: "codex",
    projectId: "project-1",
    projectName: "Project 1",
    ownership: { owner: "none" },
    isArchived: false,
    isStarred: false,
    ...overrides,
  };
}

function renderSidebar(
  sessions: GlobalSessionItem[],
  props: Partial<ComponentProps<typeof Sidebar>> = {},
  projects: Project[] = [],
) {
  mockUseGlobalSessions.mockImplementation(() => ({
    sessions,
    loading: false,
    refetch: vi.fn(),
  }));
  mockUseRecentProjects.mockReturnValue({
    recentProjects: projects,
    projects,
    loading: false,
    refetch: vi.fn(),
  });

  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <Sidebar
            isOpen
            onClose={vi.fn()}
            onNavigate={vi.fn()}
            isDesktop
            {...props}
          />
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

function projectNameOrder(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll(".sidebar-project-name"),
    (node) => node.textContent ?? "",
  );
}

function sessionTitleOrder(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll(".session-list-item__title-text"),
    (node) => node.textContent ?? "",
  );
}

function enterArchiveSelection(title: string) {
  const row = screen.getByText(title).closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /options/i }));
  fireEvent.click(screen.getByRole("button", { name: "Select to archive…" }));
}

describe("Sidebar recent session browsing", () => {
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );

  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          store.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          store.delete(key);
        }),
        clear: vi.fn(() => {
          store.clear();
        }),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(
        globalThis,
        "localStorage",
        originalLocalStorageDescriptor,
      );
    }
  });

  it("renders only the changed session card during a live update", () => {
    const first = createSession({ id: "session-a", title: "Session A" });
    const second = createSession({ id: "session-b", title: "Session B" });
    const onNavigate = vi.fn();
    const { rerender } = renderSidebar([first, second], {
      currentSessionId: first.id,
      onNavigate,
    });
    expect(screen.getByText("Session B")).toBeTruthy();
    mockRenderSessionItem.mockClear();
    mockUseGlobalSessions.mockReturnValue({
      sessions: [{ ...first, title: "Updated A", activity: "in-turn" }, second],
      loading: false,
      refetch: vi.fn(),
    });
    rerender(
      <MemoryRouter>
        <I18nProvider>
          <ToastProvider>
            <Sidebar
              isOpen
              isDesktop
              currentSessionId={first.id}
              onClose={vi.fn()}
              onNavigate={onNavigate}
            />
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Updated A")).toBeTruthy();
    expect(screen.getByText("Session B")).toBeTruthy();
    expect(mockRenderSessionItem.mock.calls.map(([id]) => id)).toEqual([
      first.id,
    ]);
    expect(mockUseRecentProjects).toHaveBeenLastCalledWith({
      enabled: true,
      liveUpdates: false,
    });
  });

  it("leaves metadata reconciliation to the session hook and avoids duplicate reconnect fetches", () => {
    renderSidebar([createSession()]);
    const refetchSessions =
      mockUseGlobalSessions.mock.results.at(-1)?.value.refetch;
    const refetchProjects =
      mockUseRecentProjects.mock.results.at(-1)?.value.refetch;
    expect(
      mockActivityOn.mock.calls.some(
        ([event]) => event === "session-metadata-changed",
      ),
    ).toBe(false);
    for (const event of ["reconnect", "refresh"]) {
      const handler = (
        mockActivityOn.mock.calls as unknown as [
          string,
          (event?: SessionMetadataChangedEvent) => void,
        ][]
      ).find(([name]) => name === event)?.[1];
      act(() => handler?.());
    }
    expect(refetchSessions).not.toHaveBeenCalled();
    expect(refetchProjects).toHaveBeenCalledTimes(2);
  });

  it("renders the desktop collapse control inside the expanded sidebar", () => {
    const onToggleExpanded = vi.fn();
    const { container } = renderSidebar([], { onToggleExpanded });
    const header = container.querySelector(".sidebar-header");

    expect(header).not.toBeNull();
    const collapseButton = within(header as HTMLElement).getByRole("button", {
      name: "Collapse sidebar",
    });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapseButton);

    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("keeps the desktop expand control inside the collapsed sidebar", () => {
    const onToggleExpanded = vi.fn();
    const { container } = renderSidebar([], {
      isCollapsed: true,
      onToggleExpanded,
    });
    const header = container.querySelector(".sidebar-header");

    expect(header).not.toBeNull();
    const expandButton = within(header as HTMLElement).getByRole("button", {
      name: "Expand sidebar",
    });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expandButton);

    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("unfolds page links on desktop and remembers folding them", () => {
    renderSidebar([]);
    const toggle = screen.getByRole("button", { name: "Navigation" });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(localStorage.getItem(UI_KEYS.sidebarNavExpandedDesktop)).toBe(
      "false",
    );
  });

  it("opens the mobile drawer with page links folded", () => {
    renderSidebar([], { isDesktop: false });
    const toggle = screen.getByRole("button", { name: "Navigation" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("link", { name: "New Session" })).toBeTruthy();

    fireEvent.click(toggle);

    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(localStorage.getItem(UI_KEYS.sidebarNavExpandedMobile)).toBe("true");
  });

  it("keeps every page icon in the collapsed desktop rail", () => {
    localStorage.setItem(UI_KEYS.sidebarNavExpandedDesktop, "false");
    renderSidebar([], { isCollapsed: true });

    expect(screen.queryByRole("button", { name: "Navigation" })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  });

  it("collapses pinned sessions with their project and keeps pins first when expanded", () => {
    const pinnedSession = createSession({
      id: "pinned-session",
      title: "Pinned Session",
      updatedAt: "2025-01-01T00:00:00.000Z",
      isStarred: true,
    });
    const newerSession = createSession({
      id: "newer-session",
      title: "Newer Session",
      updatedAt: new Date().toISOString(),
    });

    const { container } = renderSidebar([newerSession, pinnedSession]);
    const projectToggle = screen.getByRole("button", { name: /Project 1/i });

    expect(projectToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Pinned Session")).toBeNull();
    expect(screen.queryByText("Newer Session")).toBeNull();

    fireEvent.click(projectToggle);

    expect(projectToggle.getAttribute("aria-expanded")).toBe("true");
    expect(sessionTitleOrder(container)).toEqual([
      "Pinned Session",
      "Newer Session",
    ]);
    expect(
      screen
        .getByText("Pinned Session")
        .closest("li")
        ?.classList.contains("pinned"),
    ).toBe(true);
    expect(container.querySelector(".session-pin-icon")).toBeNull();
    expect(screen.queryByRole("button", { name: /Starred/i })).toBeNull();
    expect(mockUseGlobalSessions).toHaveBeenCalled();
    expect(
      mockUseGlobalSessions.mock.calls.every(
        ([options]) => options?.includePinned === true && !options?.starred,
      ),
    ).toBe(true);

    fireEvent.click(projectToggle);

    expect(projectToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Pinned Session")).toBeNull();
    expect(screen.queryByText("Newer Session")).toBeNull();

    fireEvent.click(projectToggle);

    expect(sessionTitleOrder(container)).toEqual([
      "Pinned Session",
      "Newer Session",
    ]);
  });

  it("moves the project Git summary out of the crowded project title", () => {
    const project: Project = {
      id: "project-1",
      path: "/workspace/project-1",
      name: "Project 1",
      sessionCount: 1,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: "2026-01-01T00:05:00.000Z",
      gitStatus: {
        isGitRepo: true,
        branch: "feature/sidebar-details",
        head: "abc1234",
        upstream: "origin/feature/sidebar-details",
        ahead: 1,
        behind: 0,
        isClean: false,
        stagedCount: 0,
        unstagedCount: 4,
        deletedCount: 0,
        untrackedCount: 1,
        conflictedCount: 0,
        stashCount: 0,
      },
    };
    const { container } = renderSidebar([createSession()], {}, [project]);

    expect(container.querySelector(".sidebar-project-title")?.textContent).toBe(
      "Project 1",
    );
    expect(screen.queryByText("feature/sidebar-details")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show Git details for Project 1",
      }),
    );

    expect(screen.getByRole("dialog").textContent).toContain(
      "feature/sidebar-details",
    );
  });

  it("rolls waiting approvals and questions up to the collapsed project row", () => {
    const { container, unmount } = renderSidebar([
      createSession({
        id: "approval",
        title: "Approval Session",
        activity: "waiting-input",
        pendingInputType: "tool-approval",
      }),
      createSession({
        id: "running",
        title: "Running Session",
        activity: "in-turn",
      }),
      createSession({ id: "idle", title: "Idle Session" }),
    ]);

    const needsInput = container.querySelector(
      ".sidebar-project-status--needs-input",
    );
    expect(needsInput?.textContent).toBe("Approval");
    expect(needsInput?.getAttribute("title")).toBe(
      "Waiting for you (1): Approval Session",
    );
    // A waiting session is not double-counted as running.
    expect(
      container.querySelector(".sidebar-project-status--running")?.textContent,
    ).toBe("1");
    unmount();

    const mixed = renderSidebar([
      createSession({
        id: "approval",
        title: "Approval Session",
        activity: "waiting-input",
        pendingInputType: "tool-approval",
      }),
      createSession({
        id: "question",
        title: null,
        activity: "waiting-input",
        pendingInputType: "user-question",
      }),
    ]);
    const mixedBadge = mixed.container.querySelector(
      ".sidebar-project-status--needs-input",
    );
    expect(mixedBadge?.textContent).toBe("Needs you2");
    expect(
      mixed.container.querySelector(".sidebar-project-status--running"),
    ).toBeNull();
  });

  it("fetches remotes for visible git projects when refreshing recent sessions", async () => {
    const gitStatus = {
      isGitRepo: true,
      branch: "main",
      head: "abc1234",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isClean: true,
      stagedCount: 0,
      unstagedCount: 0,
      deletedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      stashCount: 0,
    };
    const projects: Project[] = [
      {
        id: "project-1",
        path: "/workspace/project-1",
        name: "Project 1",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        gitStatus,
      },
      {
        id: "project-2",
        path: "/workspace/project-2",
        name: "Project 2",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        gitStatus: { ...gitStatus, isGitRepo: false },
      },
    ];
    let finishFetch: (() => void) | undefined;
    mockFetchProjectGitRemotes.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetch = () => resolve({ results: [] });
        }),
    );
    const now = new Date().toISOString();
    renderSidebar(
      [
        createSession({ updatedAt: now }),
        createSession({
          id: "session-2",
          projectId: "project-2",
          projectName: "Project 2",
          updatedAt: now,
        }),
      ],
      {},
      projects,
    );
    const refetchProjects = mockUseRecentProjects.mock.results[0]?.value
      .refetch as ReturnType<typeof vi.fn>;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(mockFetchProjectGitRemotes).toHaveBeenCalledWith(["project-1"]);
    const gitButton = screen.getByRole("button", {
      name: "Show Git details for Project 1",
    });
    expect(gitButton.classList.contains("is-syncing")).toBe(true);

    await act(async () => finishFetch?.());
    await waitFor(() =>
      expect(refetchProjects).toHaveBeenCalledWith({ fresh: true }),
    );
    expect(gitButton.classList.contains("is-syncing")).toBe(false);
  });

  it.each(["recent", "older"])(
    "moves the project with the latest session activity to the top of the %s section",
    (section) => {
      const now =
        Date.now() - (section === "older" ? 2 * 24 * 60 * 60 * 1000 : 0);
      const projectB = createSession({
        id: "session-b",
        title: "Session B",
        projectId: "project-b",
        projectName: "Project B",
        updatedAt: new Date(now - 10 * 60_000).toISOString(),
      });
      const projectA = createSession({
        id: "session-a",
        title: "Session A",
        projectId: "project-a",
        projectName: "Project A",
        updatedAt: new Date(now - 20 * 60_000).toISOString(),
        activity: "in-turn",
      });

      const { container, rerender } = renderSidebar([projectB, projectA], {
        currentSessionId: "session-a",
      });

      expect(projectNameOrder(container)).toEqual(["Project B", "Project A"]);
      fireEvent.click(screen.getByRole("button", { name: /Project A/i }));
      expect(screen.queryByText("Session A")).toBeNull();

      mockUseGlobalSessions.mockImplementation(() => ({
        sessions: [
          projectB,
          {
            ...projectA,
            updatedAt: new Date(now).toISOString(),
          },
        ],
        loading: false,
        refetch: vi.fn(),
      }));

      rerender(
        <MemoryRouter>
          <I18nProvider>
            <ToastProvider>
              <Sidebar
                isOpen
                onClose={vi.fn()}
                onNavigate={vi.fn()}
                isDesktop
                currentSessionId="session-a"
              />
            </ToastProvider>
          </I18nProvider>
        </MemoryRouter>,
      );

      expect(projectNameOrder(container)).toEqual(["Project A", "Project B"]);
      expect(screen.queryByText("Session A")).toBeNull();
    },
  );

  it("orders projects by their newest session even when an older pin arrives first", () => {
    const now = Date.now();
    const { container } = renderSidebar([
      createSession({
        id: "pinned-c",
        projectId: "project-c",
        projectName: "Project C",
        updatedAt: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
        isStarred: true,
      }),
      createSession({
        id: "pinned-a",
        title: "Pinned A",
        projectId: "project-a",
        projectName: "Project A",
        updatedAt: new Date(now - 7 * 24 * 60 * 60_000).toISOString(),
        isStarred: true,
      }),
      createSession({
        id: "session-b",
        projectId: "project-b",
        projectName: "Project B",
        updatedAt: new Date(now - 10 * 60_000).toISOString(),
      }),
      createSession({
        id: "latest-a",
        title: "Latest A",
        projectId: "project-a",
        projectName: "Project A",
        updatedAt: new Date(now).toISOString(),
      }),
    ]);

    expect(projectNameOrder(container)).toEqual([
      "Project A",
      "Project B",
      "Project C",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Project A/i }));
    expect(sessionTitleOrder(container)).toEqual(["Pinned A", "Latest A"]);
  });

  it("orders sessions within a project group by most recent activity", () => {
    // Input order puts the older session first, mirroring the hook's stable
    // order where an existing row was updated in place after a newer sibling.
    const olderSession = createSession({
      id: "session-older",
      title: "Older Session",
      projectId: "project-x",
      projectName: "Project X",
      updatedAt: "2026-01-01T09:34:00.000Z",
    });
    const newerSession = createSession({
      id: "session-newer",
      title: "Newer Session",
      projectId: "project-x",
      projectName: "Project X",
      updatedAt: "2026-01-01T11:10:00.000Z",
    });

    const { container } = renderSidebar([olderSession, newerSession], {
      currentSessionId: "session-older",
    });

    expect(sessionTitleOrder(container)).toEqual([
      "Newer Session",
      "Older Session",
    ]);
  });

  it.each([false, true])(
    "does not reopen the current session group after the user collapses it (isStarred=%s)",
    async (isStarred) => {
      const currentSession = createSession({
        id: "session-a",
        title: "Session A",
        projectId: "project-a",
        projectName: "Project A",
        updatedAt: "2026-01-01T00:01:00.000Z",
        isStarred,
      });

      const { rerender } = renderSidebar([currentSession], {
        currentSessionId: "session-a",
      });

      await waitFor(() => {
        expect(screen.getByText("Session A")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Project A/i }));
      expect(screen.queryByText("Session A")).toBeNull();

      mockUseGlobalSessions.mockImplementation(() => ({
        sessions: [
          {
            ...currentSession,
            updatedAt: "2026-01-01T00:20:00.000Z",
          },
        ],
        loading: false,
        refetch: vi.fn(),
      }));

      rerender(
        <MemoryRouter>
          <I18nProvider>
            <ToastProvider>
              <Sidebar
                isOpen
                onClose={vi.fn()}
                onNavigate={vi.fn()}
                isDesktop
                currentSessionId="session-a"
              />
            </ToastProvider>
          </I18nProvider>
        </MemoryRouter>,
      );

      expect(screen.queryByText("Session A")).toBeNull();
    },
  );

  it.each([true, false])(
    "shows checkboxes only during menu-initiated archiving (isDesktop=%s)",
    async (isDesktop) => {
      mockUpdateSessionMetadata.mockResolvedValue({});
      const onNavigate = vi.fn();

      renderSidebar(
        [
          createSession({
            id: "session-a",
            title: "Session A",
            projectId: "project-a",
            projectName: "Project A",
            updatedAt: new Date().toISOString(),
          }),
          createSession({
            id: "session-b",
            title: "Session B",
            projectId: "project-a",
            projectName: "Project A",
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        ],
        { currentSessionId: "session-a", isDesktop, onNavigate },
      );

      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
      enterArchiveSelection("Session A");

      expect(screen.getAllByRole("checkbox")).toHaveLength(2);
      expect(
        (screen.getByLabelText("Select Session A") as HTMLInputElement).checked,
      ).toBe(true);
      expect(mockUpdateSessionMetadata).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Session B"));
      expect(
        (screen.getByLabelText("Select Session B") as HTMLInputElement).checked,
      ).toBe(true);
      expect(onNavigate).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Archive" }));

      await waitFor(() => {
        expect(mockUpdateSessionMetadata).toHaveBeenCalledTimes(2);
        expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
        expect(
          screen.queryByRole("button", { name: "Cancel archiving" }),
        ).toBeNull();
      });
      expect(mockUpdateSessionMetadata).toHaveBeenCalledWith("session-a", {
        archived: true,
      });
      expect(mockUpdateSessionMetadata).toHaveBeenCalledWith("session-b", {
        archived: true,
      });
    },
  );

  it("keeps empty selection editable until cancellation and then restores navigation", () => {
    const onNavigate = vi.fn();
    renderSidebar([createSession()], {
      currentSessionId: "session-1",
      onNavigate,
    });

    enterArchiveSelection("Session 1");
    fireEvent.click(screen.getByLabelText("Select Session 1"));

    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel archiving" }));

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByText("0 selected")).toBeNull();
    expect(mockUpdateSessionMetadata).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Session 1"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

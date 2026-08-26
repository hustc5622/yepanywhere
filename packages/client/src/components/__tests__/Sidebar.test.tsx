import {
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
import type { Project } from "../../types";
import { Sidebar } from "../Sidebar";

const {
  mockUseGlobalSessions,
  mockUseRecentProjects,
  mockUpdateSessionMetadata,
} = vi.hoisted(() => ({
  mockUseGlobalSessions: vi.fn(),
  mockUseRecentProjects: vi.fn(),
  mockUpdateSessionMetadata: vi.fn(),
}));

vi.mock("../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: mockUseGlobalSessions,
}));

vi.mock("../../api/client", () => ({
  api: {
    updateSessionMetadata: mockUpdateSessionMetadata,
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

  it("places a pinned session first in its project with a distinct background", async () => {
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

    await waitFor(() =>
      expect(screen.getByText("Pinned Session")).toBeTruthy(),
    );
    expect(screen.queryByText("Newer Session")).toBeNull();

    fireEvent.click(
      container.querySelector(".sidebar-project-toggle") as HTMLButtonElement,
    );

    const selectLabels = Array.from(
      container.querySelectorAll('[aria-label^="Select "]'),
      (node) => node.getAttribute("aria-label"),
    );
    expect(selectLabels).toEqual([
      "Select Pinned Session",
      "Select Newer Session",
    ]);
    expect(
      screen
        .getByText("Pinned Session")
        .closest("li")
        ?.classList.contains("pinned"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: /Starred/i })).toBeNull();
    expect(mockUseGlobalSessions).toHaveBeenCalled();
    expect(
      mockUseGlobalSessions.mock.calls.every(
        ([options]) => options?.includePinned === true && !options?.starred,
      ),
    ).toBe(true);
  });

  it("keeps project order stable when an active session receives a newer timestamp", () => {
    const projectB = createSession({
      id: "session-b",
      title: "Session B",
      projectId: "project-b",
      projectName: "Project B",
      updatedAt: "2026-01-01T00:10:00.000Z",
    });
    const projectA = createSession({
      id: "session-a",
      title: "Session A",
      projectId: "project-a",
      projectName: "Project A",
      updatedAt: "2026-01-01T00:01:00.000Z",
      activity: "in-turn",
    });

    const { container, rerender } = renderSidebar([projectB, projectA], {
      currentSessionId: "session-a",
    });

    expect(projectNameOrder(container)).toEqual(["Project B", "Project A"]);

    mockUseGlobalSessions.mockImplementation(() => ({
      sessions: [
        projectB,
        {
          ...projectA,
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

    expect(projectNameOrder(container)).toEqual(["Project B", "Project A"]);
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

    const selectLabels = Array.from(
      container.querySelectorAll('[aria-label^="Select "]'),
      (node) => node.getAttribute("aria-label"),
    );

    expect(selectLabels).toEqual([
      "Select Newer Session",
      "Select Older Session",
    ]);
  });

  it("does not reopen the current session group after the user collapses it", async () => {
    const currentSession = createSession({
      id: "session-a",
      title: "Session A",
      projectId: "project-a",
      projectName: "Project A",
      updatedAt: "2026-01-01T00:01:00.000Z",
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
  });

  it("archives checked sidebar sessions in one action", async () => {
    mockUpdateSessionMetadata.mockResolvedValue({});

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
      { currentSessionId: "session-a" },
    );

    fireEvent.click(screen.getByLabelText("Select Session A"));
    fireEvent.click(screen.getByLabelText("Select Session B"));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(mockUpdateSessionMetadata).toHaveBeenCalledTimes(2);
    });
    expect(mockUpdateSessionMetadata).toHaveBeenCalledWith("session-a", {
      archived: true,
    });
    expect(mockUpdateSessionMetadata).toHaveBeenCalledWith("session-b", {
      archived: true,
    });
  });
});

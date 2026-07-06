import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalSessionItem } from "../../api/client";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { Sidebar } from "../Sidebar";

const { mockUseGlobalSessions, mockUseRecentProjects } = vi.hoisted(() => ({
  mockUseGlobalSessions: vi.fn(),
  mockUseRecentProjects: vi.fn(),
}));

vi.mock("../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: mockUseGlobalSessions,
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
) {
  mockUseGlobalSessions.mockImplementation((options) => ({
    sessions: options?.starred ? [] : sessions,
    loading: false,
    refetch: vi.fn(),
  }));
  mockUseRecentProjects.mockReturnValue({
    recentProjects: [],
    projects: [],
    loading: false,
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
  afterEach(() => {
    vi.clearAllMocks();
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

    mockUseGlobalSessions.mockImplementation((options) => ({
      sessions: options?.starred
        ? []
        : [
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

    mockUseGlobalSessions.mockImplementation((options) => ({
      sessions: options?.starred
        ? []
        : [
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
});

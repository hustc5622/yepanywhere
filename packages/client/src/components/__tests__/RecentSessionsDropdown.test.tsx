import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalSessionItem } from "../../api/client";
import { RecentSessionsDropdown } from "../RecentSessionsDropdown";

const { mockUseGlobalSessions } = vi.hoisted(() => ({
  mockUseGlobalSessions: vi.fn(),
}));

vi.mock("../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: mockUseGlobalSessions,
}));

function createSession(
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id: "session-1",
    title: "Recent work",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    messageCount: 4,
    provider: "claude",
    projectId: "project-1",
    projectName: "yepanywhere",
    ownership: { owner: "none" },
    ...overrides,
  };
}

function renderDropdown(sessions: GlobalSessionItem[]) {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    bottom: 20,
    height: 20,
    left: 12,
    right: 112,
    top: 0,
    width: 100,
    x: 12,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  mockUseGlobalSessions.mockReturnValue({ sessions });

  return render(
    <MemoryRouter>
      <RecentSessionsDropdown
        currentSessionId="current-session"
        isOpen
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        triggerRef={{ current: trigger }}
      />
    </MemoryRouter>,
  );
}

describe("RecentSessionsDropdown", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows effective usage and compact count for recent sessions", () => {
    renderDropdown([
      createSession({
        cumulativeUsage: {
          totalTokens: 12_500,
          inputTokens: 9_000,
          outputTokens: 2_000,
          cacheReadTokens: 1_500,
          cacheCreationTokens: 0,
          turnCount: 3,
        },
        compactCount: 2,
        compactEvents: [
          {
            timestamp: "2026-01-01T00:02:00.000Z",
            beforeTokens: 167_000,
            afterTokens: 57_000,
            reclaimedTokens: 110_000,
            trigger: "auto",
          },
          {
            timestamp: "2026-01-01T00:04:00.000Z",
            beforeTokens: 168_000,
            afterTokens: 129_000,
            reclaimedTokens: 39_000,
            trigger: "manual",
          },
        ],
      }),
    ]);

    const usage = screen.getByText("11.0K");
    expect(usage).toBeTruthy();
    expect(usage.getAttribute("title")).toContain("Input: 9,000");
    expect(usage.getAttribute("title")).toContain("Cache read: 1,500");
    expect(usage.getAttribute("title")).toContain("Output: 2,000");
    expect(usage.getAttribute("title")).toContain("Raw total: 12,500");
    fireEvent.click(usage);
    expect(screen.getByText("Effective")).toBeTruthy();
    expect(screen.getByText("11,000 excl. cache")).toBeTruthy();
    expect(screen.getByText("Cache read")).toBeTruthy();
    const compact = screen.getByText("2 compacts");
    expect(compact.getAttribute("title")).toContain(
      "#1 auto: 167.0K -> 57.0K, saved 110,000",
    );
    fireEvent.click(compact);
    expect(screen.getByText("#1 auto")).toBeTruthy();
    expect(screen.getByText("167.0K -> 57.0K")).toBeTruthy();
    expect(screen.getByText("110.0K")).toBeTruthy();
    expect(screen.getByText("#2 manual")).toBeTruthy();
  });
});

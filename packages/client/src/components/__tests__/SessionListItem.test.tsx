import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { SessionListItem } from "../SessionListItem";

const { mockUpdateSessionMetadata } = vi.hoisted(() => ({
  mockUpdateSessionMetadata: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    updateSessionMetadata: mockUpdateSessionMetadata,
  },
}));

function renderItem(
  props: Partial<ComponentProps<typeof SessionListItem>> = {},
) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <SessionListItem
            sessionId="session-1"
            projectId="project-1"
            title="Session title"
            status={{ owner: "none" }}
            provider="codex"
            isArchived={false}
            mode="card"
            {...props}
          />
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("SessionListItem archive feedback", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("disables archive with the runtime block reason", () => {
    renderItem({
      runtime: {
        ownership: { owner: "self", processId: "proc-1" },
        activity: "in-turn",
        isBusy: true,
        hasResidentWorker: false,
        canArchive: false,
        archiveBlockCode: "agent_in_turn",
        archiveBlockReason: "Agent is still running",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /options/i }));

    const archiveButton = screen.getByRole("button", { name: /archive/i });
    expect((archiveButton as HTMLButtonElement).disabled).toBe(true);
    expect(archiveButton.getAttribute("title")).toBe("Agent is still running");
  });

  it("shows the server archive error in a toast", async () => {
    mockUpdateSessionMetadata.mockRejectedValueOnce(
      new Error("This session is waiting for input."),
    );

    renderItem({
      runtime: {
        ownership: { owner: "none" },
        isBusy: false,
        hasResidentWorker: false,
        canArchive: true,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /options/i }));
    fireEvent.click(screen.getByRole("button", { name: /archive/i }));

    await waitFor(() => {
      expect(
        screen.getByText("This session is waiting for input."),
      ).toBeTruthy();
    });
  });

  it("copies session info from the menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const projectId = toUrlProjectId("/Users/someone/work/alpha");
    renderItem({
      projectId,
      projectName: "Project Alpha",
      model: "gpt-5-codex",
      basePath: "/yep",
    });

    fireEvent.click(screen.getByRole("button", { name: /options/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy session info/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    const copiedText = writeText.mock.calls[0]?.[0] as string;
    // The copied block must be self-locating: a bare session id cannot be
    // resolved back to a project by any API, route or CLI.
    expect(copiedText).toBe(
      [
        "Title: Session title",
        "Session ID: session-1",
        "Provider: codex",
        "Project: /Users/someone/work/alpha",
        `Link: ${window.location.origin}/projects/${projectId}/sessions/session-1`,
      ].join("\n"),
    );
  });

  it("shows effective usage and compact count in compact mode", () => {
    renderItem({
      mode: "compact",
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
      ],
    });

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
    fireEvent.click(compact);
    expect(screen.getByText("#1 auto")).toBeTruthy();
    expect(screen.getByText("167.0K -> 57.0K")).toBeTruthy();
    expect(screen.getByText("110.0K")).toBeTruthy();
  });

  it("uses effective usage for card size metadata", () => {
    renderItem({
      showSizeMeta: true,
      messageCount: 4,
      contextUsage: {
        inputTokens: 99_000,
        percentage: 50,
      },
      cumulativeUsage: {
        totalTokens: 12_500,
        inputTokens: 9_000,
        outputTokens: 2_000,
        cacheReadTokens: 1_500,
        cacheCreationTokens: 0,
        turnCount: 3,
      },
      compactCount: 1,
      compactEvents: [
        {
          beforeTokens: 167_000,
          afterTokens: 57_000,
          reclaimedTokens: 110_000,
        },
      ],
    });

    expect(screen.getByText("11.0K")).toBeTruthy();
    const compact = screen.getByText("1 compact");
    fireEvent.click(compact);
    expect(screen.getByText("167.0K -> 57.0K")).toBeTruthy();
    expect(screen.queryByText("99.0K")).toBeNull();
  });
});

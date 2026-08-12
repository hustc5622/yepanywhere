import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("renders an unknown creation source when runtime data is not a string", () => {
    renderItem({
      sessionSource: {
        subagent: { other: "guardian" },
      } as unknown as string,
    });

    expect(screen.getByText("未知")).toBeTruthy();
  });
});

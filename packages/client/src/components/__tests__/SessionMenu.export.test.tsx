import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { SessionMenu } from "../SessionMenu";

function renderMenu(provider: string) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <SessionMenu
            sessionId="session-1"
            projectId="project-1"
            provider={provider}
            isStarred={false}
            isArchived={false}
            onToggleStar={() => {}}
            onToggleArchive={() => {}}
            onRename={() => {}}
          />
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("Codex transcript menu", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("calls canonical export and reports download failures", async () => {
    const download = vi
      .spyOn(api, "downloadCodexTranscript")
      .mockRejectedValue(new Error("fixture download failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderMenu("codex");

    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Export Codex transcript" }),
    );

    await waitFor(() => expect(download).toHaveBeenCalledWith("session-1"));
    expect(
      await screen.findByText("Failed to export Codex transcript"),
    ).toBeDefined();
  });

  it("does not offer Codex export for another provider", () => {
    renderMenu("claude");
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));

    expect(
      screen.queryByRole("button", { name: "Export Codex transcript" }),
    ).toBeNull();
  });
});

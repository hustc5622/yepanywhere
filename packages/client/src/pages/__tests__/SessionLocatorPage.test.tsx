import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SessionLocatorPage } from "../SessionLocatorPage";

const mocks = vi.hoisted(() => ({
  locateSession: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { locateSession: mocks.locateSession },
}));

function renderAt(path: string) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/sessions/:sessionId" element={<SessionLocatorPage />} />
          <Route
            path="/projects/:projectId/sessions/:sessionId"
            element={<div data-testid="session-page" />}
          />
          <Route
            path="/sessions"
            element={<div data-testid="session-list" />}
          />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("SessionLocatorPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("redirects to the project-scoped session URL once resolved", async () => {
    mocks.locateSession.mockResolvedValue({
      session: { projectId: "proj-1", sessionId: "ses_abc" },
    });

    renderAt("/sessions/ses_abc");

    await waitFor(() => {
      expect(screen.getByTestId("session-page")).toBeTruthy();
    });
    expect(mocks.locateSession).toHaveBeenCalledWith("ses_abc");
  });

  it("follows the canonical id when the requested id was an alias", async () => {
    mocks.locateSession.mockResolvedValue({
      session: { projectId: "proj-1", sessionId: "ses_durable" },
    });

    renderAt("/sessions/ses_bootstrap");

    await waitFor(() => {
      expect(screen.getByTestId("session-page")).toBeTruthy();
    });
    expect(mocks.locateSession).toHaveBeenCalledWith("ses_bootstrap");
  });

  it("shows a resolving state before the lookup settles", () => {
    mocks.locateSession.mockReturnValue(new Promise(() => {}));

    renderAt("/sessions/ses_slow");

    expect(screen.getByText("Finding this session…")).toBeTruthy();
    expect(screen.getByText("ses_slow")).toBeTruthy();
  });

  it("reports a 404 as an unowned session id, not an error", async () => {
    mocks.locateSession.mockRejectedValue(apiError(404, "Session not found"));

    renderAt("/sessions/ses_nope");

    await waitFor(() => {
      expect(screen.getByText("No project owns this session ID")).toBeTruthy();
    });
    expect(screen.getByText("ses_nope")).toBeTruthy();
    expect(screen.getByText("Back to all sessions")).toBeTruthy();
  });

  it("surfaces non-404 failures verbatim", async () => {
    mocks.locateSession.mockRejectedValue(apiError(500, "boom"));

    renderAt("/sessions/ses_broken");

    await waitFor(() => {
      expect(screen.getByText("Could not look up this session")).toBeTruthy();
    });
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("does not redirect after unmount", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mocks.locateSession.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const { unmount } = renderAt("/sessions/ses_race");
    unmount();
    resolve?.({ session: { projectId: "proj-1", sessionId: "ses_race" } });

    await Promise.resolve();
    expect(screen.queryByTestId("session-page")).toBeNull();
  });
});

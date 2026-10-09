import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SearchPage } from "../SearchPage";

const mocks = vi.hoisted(() => ({ search: vi.fn(), projects: vi.fn() }));
vi.mock("../../api/client", () => ({
  api: { search: mocks.search, getGlobalSessions: mocks.projects },
}));
vi.mock("../../hooks/useHideSplashOnReady", () => ({
  useHideSplashOnReady: () => {},
}));
vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({ openSidebar: vi.fn(), isWideScreen: false }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const response = {
  results: [
    {
      sessionId: "a",
      projectId: "p",
      projectName: "Project",
      title: "First result",
      provider: "codex",
      updatedAt: "2026-10-01T00:00:00Z",
      matchCount: 1,
      matches: [],
    },
  ],
  totalSessions: 1,
  totalMatches: 1,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/search?q=test"]}>
      <I18nProvider>
        <SearchPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("SearchPage loading", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.search.mockReset().mockResolvedValue(response);
    mocks.projects.mockReset().mockResolvedValue({ projects: [] });
  });
  afterEach(cleanup);

  it("keeps the scope control mounted and only uses result skeletons for the first query", async () => {
    const initial = deferred<typeof response>();
    const projects = deferred<{ projects: { id: string; name: string }[] }>();
    mocks.search.mockReturnValueOnce(initial.promise);
    mocks.projects.mockReturnValueOnce(projects.promise);
    const view = renderPage();
    const scope = screen.getByRole("button", { name: "All projects" });
    expect(scope.hasAttribute("disabled")).toBe(true);
    expect(
      view.container.querySelectorAll(".search-result-skeleton-snippets"),
    ).toHaveLength(3);
    await act(async () => {
      initial.resolve(response);
      projects.resolve({ projects: [{ id: "p", name: "Project" }] });
    });
    expect(screen.getByRole("button", { name: "All projects" })).toBe(scope);
    expect(scope.hasAttribute("disabled")).toBe(false);
    const firstResult = screen.getByText("First result");
    const next = deferred<typeof response>();
    mocks.search.mockReturnValueOnce(next.promise);
    fireEvent.click(screen.getByRole("button", { name: "Best match" }));
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2));
    expect(screen.getByText("First result")).toBe(firstResult);
    expect(
      view.container.querySelectorAll(".search-result-skeleton-snippets"),
    ).toHaveLength(0);
    expect(screen.getByText("Searching…")).toBeTruthy();
    await act(async () => {
      next.resolve({ results: [], totalSessions: 0, totalMatches: 0 });
    });
    expect(screen.queryByText("First result")).toBeNull();
    expect(screen.getByText("No matches found")).toBeTruthy();
  });

  it("replaces an initial loading state with an error when the request fails", async () => {
    const initial = deferred<typeof response>();
    mocks.search.mockReturnValueOnce(initial.promise);
    const view = renderPage();
    await act(async () => {
      initial.reject(new Error("Search unavailable"));
    });
    expect(screen.getByText(/Search unavailable/)).toBeTruthy();
    expect(
      view.container.querySelectorAll(".search-result-skeleton-snippets"),
    ).toHaveLength(0);
    expect(screen.queryByText("Searching…")).toBeNull();
  });
});

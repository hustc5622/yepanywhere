import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { GitStatusInfo } from "@yep-anywhere/shared";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { SessionInspector } from "../../components/SessionInspector";
import { I18nProvider } from "../../i18n";
import * as preprocessing from "../../lib/preprocessMessages";
import { UI_KEYS } from "../../lib/storageKeys";
import { useGitStatus } from "../useGitStatus";

vi.mock("../../api/client", () => ({ api: { getGitStatus: vi.fn() } }));
const status = (branch: string): GitStatusInfo => ({
  isGitRepo: true,
  branch,
  upstream: null,
  ahead: 0,
  behind: 0,
  isClean: true,
  files: [],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.getGitStatus).mockResolvedValue(status("main"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  localStorage.setItem(UI_KEYS.locale, "en");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  localStorage.removeItem(UI_KEYS.locale);
});
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it("only polls the visible Git tab, stops on close and refreshes on reopen", async () => {
  const inspector = (isOpen: boolean) => (
    <MemoryRouter>
      <I18nProvider>
        <SessionInspector
          presentation="drawer"
          isOpen={isOpen}
          messages={[]}
          projectId="p"
          sessionId="s"
          status={{ owner: "none" }}
          onSelectMessage={() => {}}
        />
      </I18nProvider>
    </MemoryRouter>
  );
  const { rerender } = render(inspector(false));
  await advance(60_000);
  expect(api.getGitStatus).not.toHaveBeenCalled();
  rerender(inspector(true));
  await advance(60_000);
  expect(api.getGitStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "Git" }));
  await advance(10_000);
  expect(api.getGitStatus).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("tab", { name: "Questions" }));
  await advance(15_000);
  expect(api.getGitStatus).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("tab", { name: "Git" }));
  await advance(0);
  rerender(inspector(false));
  await advance(60_000);
  expect(api.getGitStatus).toHaveBeenCalledTimes(4);
  rerender(inspector(true));
  await advance(0);
  expect(api.getGitStatus).toHaveBeenCalledTimes(5);
});

it.each(["resolve", "reject"] as const)(
  "ignores an old project's late %s",
  async (outcome) => {
    let resolve!: (value: GitStatusInfo) => void;
    let reject!: (reason: Error) => void;
    vi.mocked(api.getGitStatus)
      .mockImplementationOnce(
        () =>
          new Promise((ok, fail) => {
            resolve = ok;
            reject = fail;
          }),
      )
      .mockResolvedValue(status("new"));
    const { result, rerender } = renderHook(
      ({ project }) => useGitStatus(project),
      {
        initialProps: { project: "old" },
      },
    );
    rerender({ project: "new" });
    expect(result.current.gitStatus).toBeNull();
    await advance(0);
    await act(async () => {
      if (outcome === "resolve") resolve(status("old"));
      else reject(new Error("old project failed"));
    });
    expect(result.current.gitStatus?.branch).toBe("new");
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  },
);

it("invalidates requests across disable/reopen of the same project", async () => {
  let finish!: (value: GitStatusInfo) => void;
  vi.mocked(api.getGitStatus).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ project }: { project?: string }) => useGitStatus(project),
    {
      initialProps: { project: "p" } as { project?: string },
    },
  );
  rerender({ project: undefined });
  expect(result.current.loading).toBe(false);
  rerender({ project: "p" });
  await advance(0);
  await act(async () => finish(status("stale")));
  expect(result.current.gitStatus?.branch).toBe("main");
});

it("does not overlap slow polls or poll a hidden page", async () => {
  let finish!: (value: GitStatusInfo) => void;
  vi.mocked(api.getGitStatus).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderHook(() => useGitStatus("p"));
  await advance(60_000);
  expect(api.getGitStatus).toHaveBeenCalledTimes(1);
  await act(async () => finish(status("main")));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await advance(60_000);
  expect(api.getGitStatus).toHaveBeenCalledTimes(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await advance(0);
  expect(api.getGitStatus).toHaveBeenCalledTimes(2);
});

it("does not preprocess messages while the drawer or browser page is hidden", async () => {
  const preprocess = vi.spyOn(preprocessing, "preprocessMessages");
  const inspector = (isOpen: boolean, text: string) => (
    <MemoryRouter>
      <I18nProvider>
        <SessionInspector
          presentation="drawer"
          isOpen={isOpen}
          messages={[
            {
              uuid: text,
              type: "user",
              message: { role: "user", content: text },
            },
          ]}
          projectId="p"
          sessionId="s"
          status={{ owner: "none" }}
          onSelectMessage={() => {}}
        />
      </I18nProvider>
    </MemoryRouter>
  );
  const { rerender } = render(inspector(false, "a"));
  rerender(inspector(false, "b"));
  expect(preprocess).not.toHaveBeenCalled();
  rerender(inspector(true, "c"));
  expect(preprocess).toHaveBeenCalledTimes(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  rerender(inspector(true, "d"));
  expect(preprocess).toHaveBeenCalledTimes(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(preprocess).toHaveBeenCalledTimes(2);
});

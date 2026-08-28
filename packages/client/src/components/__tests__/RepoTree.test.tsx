import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoTree } from "../RepoTree";

const mocks = vi.hoisted(() => ({
  browseProjectFiles: vi.fn(),
  onProjectFilesChanged: null as (() => void) | null,
  t: (key: string) => key,
}));

vi.mock("../../api/client", () => ({
  api: { browseProjectFiles: mocks.browseProjectFiles },
}));

vi.mock("../../hooks/useProjectFileWatch", () => ({
  useProjectFileWatch: (_projectId: string, onChange: () => void) => {
    mocks.onProjectFilesChanged = onChange;
  },
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: mocks.t }),
}));

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error("deferred promise was not initialized");
      resolve(value);
    },
  };
}

describe("RepoTree refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onProjectFilesChanged = null;
  });

  it("keeps expanded directory entries visible while a watcher refresh is pending", async () => {
    const initialRoot = deferred<{ entries: unknown[] }>();
    const initialSrc = deferred<{ entries: unknown[] }>();
    const refreshedRoot = deferred<{ entries: unknown[] }>();
    const refreshedSrc = deferred<{ entries: unknown[] }>();

    mocks.browseProjectFiles
      .mockReturnValueOnce(initialRoot.promise)
      .mockReturnValueOnce(initialSrc.promise)
      .mockReturnValueOnce(refreshedRoot.promise)
      .mockReturnValueOnce(refreshedSrc.promise);

    render(<RepoTree projectId="project-1" />);

    await waitFor(() =>
      expect(mocks.browseProjectFiles).toHaveBeenCalledWith("project-1", ""),
    );
    initialRoot.resolve({
      entries: [{ name: "src", path: "src", type: "dir" }],
    });

    const srcButton = await screen.findByRole("button", { name: "src" });
    fireEvent.click(srcButton);
    await waitFor(() =>
      expect(mocks.browseProjectFiles).toHaveBeenCalledWith("project-1", "src"),
    );
    initialSrc.resolve({
      entries: [{ name: "App.tsx", path: "src/App.tsx", type: "file" }],
    });

    await screen.findByRole("button", { name: "App.tsx" });

    act(() => mocks.onProjectFilesChanged?.());

    await waitFor(() =>
      expect(mocks.browseProjectFiles).toHaveBeenCalledTimes(4),
    );
    expect(screen.getByRole("button", { name: "App.tsx" })).toBeDefined();
  });
});

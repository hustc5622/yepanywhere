import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SessionFileActivityIndex } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { useSessionFileIndex } from "../useSessionFileIndex";

vi.mock("../../api/client", () => ({ api: { getSessionFileIndex: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("stops while disabled and ignores a prior request after reopening", async () => {
  let finish!: (value: SessionFileActivityIndex) => void;
  vi.mocked(api.getSessionFileIndex)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(index("new"));
  const { result, rerender } = renderHook(
    ({ enabled }) => useSessionFileIndex("p", "s", { enabled }),
    { initialProps: { enabled: true } },
  );
  rerender({ enabled: false });
  expect(result.current.loading).toBe(false);
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.index?.generatedAt).toBe("new"));
  await act(async () => finish(index("stale")));
  expect(result.current.index?.generatedAt).toBe("new");
});

it("waits for slow scans before scheduling another poll", async () => {
  vi.useFakeTimers();
  let finish!: (value: SessionFileActivityIndex) => void;
  vi.mocked(api.getSessionFileIndex)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(index("next"));
  const { result, rerender } = renderHook(
    ({ enabled }) => useSessionFileIndex("p", "s", { enabled }),
    { initialProps: { enabled: true } },
  );
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(api.getSessionFileIndex).toHaveBeenCalledTimes(1);
  await act(async () => finish(index("slow")));
  expect(result.current.index?.generatedAt).toBe("slow");
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(api.getSessionFileIndex).toHaveBeenCalledTimes(2);
  rerender({ enabled: false });
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(api.getSessionFileIndex).toHaveBeenCalledTimes(2);
});
const index = (generatedAt: string): SessionFileActivityIndex => ({
  projectId: "p",
  sessionId: "s",
  files: [],
  truncated: false,
  generatedAt,
});

it("drops the prior branch's cached index and ignores its late response", async () => {
  let finishOld: ((value: SessionFileActivityIndex) => void) | undefined;
  vi.mocked(api.getSessionFileIndex)
    .mockResolvedValueOnce(index("cached-old"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(index("new"));
  const { result, rerender } = renderHook(
    ({ branchId }) => useSessionFileIndex("p", "s", { branchId }),
    { initialProps: { branchId: "old" } },
  );
  await waitFor(() =>
    expect(result.current.index?.generatedAt).toBe("cached-old"),
  );
  act(() => {
    void result.current.refetch();
  });
  rerender({ branchId: "new" });
  expect(result.current.index).toBeNull();
  await waitFor(() => expect(result.current.index?.generatedAt).toBe("new"));
  await act(async () => {
    finishOld?.(index("stale-old"));
  });
  expect(result.current.index?.generatedAt).toBe("new");
  expect(api.getSessionFileIndex).toHaveBeenLastCalledWith("p", "s", {
    branchId: "new",
  });
});

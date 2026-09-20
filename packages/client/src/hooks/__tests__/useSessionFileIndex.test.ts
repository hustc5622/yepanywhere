import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SessionFileActivityIndex } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { useSessionFileIndex } from "../useSessionFileIndex";

vi.mock("../../api/client", () => ({ api: { getSessionFileIndex: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
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

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { useSessionInspectorHistory } from "../useSessionInspectorHistory";

vi.mock("../../api/client", () => ({ api: { getSession: vi.fn() } }));
const page = (id: string) => ({
  messages: [
    { uuid: id, type: "user", message: { role: "user", content: id } },
  ],
});
const options = {
  projectId: "p",
  sessionId: "s",
  branchId: "a",
  revision: "r1",
  processState: "idle",
  enabled: false,
  onError: vi.fn(),
};
beforeEach(() => {
  vi.mocked(api.getSession).mockResolvedValue(page("first") as never);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("loads on open, defers closed revisions, and refreshes once on reopen", async () => {
  const { result, rerender } = renderHook(useSessionInspectorHistory, {
    initialProps: options,
  });
  expect(api.getSession).not.toHaveBeenCalled();
  rerender({ ...options, enabled: true });
  await waitFor(() => expect(result.current.messages?.[0]?.uuid).toBe("first"));
  expect(api.getSession).toHaveBeenCalledTimes(1);
  rerender({ ...options, revision: "r2" });
  rerender({ ...options, revision: "r3" });
  expect(api.getSession).toHaveBeenCalledTimes(1);
  vi.mocked(api.getSession).mockResolvedValue(page("new") as never);
  rerender({ ...options, revision: "r3", enabled: true });
  await waitFor(() => expect(result.current.messages?.[0]?.uuid).toBe("new"));
  expect(api.getSession).toHaveBeenCalledTimes(2);
  rerender({ ...options, revision: "r3" });
  rerender({ ...options, revision: "r3", enabled: true });
  expect(api.getSession).toHaveBeenCalledTimes(2);
});

it("stops pagination after closing and ignores the late page", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.getSession).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  const { result, rerender } = renderHook(useSessionInspectorHistory, {
    initialProps: { ...options, enabled: true },
  });
  expect(api.getSession).toHaveBeenCalledTimes(1);
  rerender(options);
  await act(async () =>
    finish({
      ...page("old"),
      pagination: {
        hasOlderMessages: true,
        truncatedBeforeMessageId: "cursor",
      },
    }),
  );
  expect(api.getSession).toHaveBeenCalledTimes(1);
  expect(result.current.messages).toBeNull();
  expect(result.current.loading).toBe(false);
  rerender({ ...options, enabled: true });
  await waitFor(() => expect(result.current.messages?.[0]?.uuid).toBe("first"));
});

it("defers active turns and isolates branches while a request is pending", async () => {
  let finish!: (value: unknown) => void;
  const { result, rerender } = renderHook(useSessionInspectorHistory, {
    initialProps: { ...options, enabled: true, processState: "in-turn" },
  });
  expect(api.getSession).not.toHaveBeenCalled();
  vi.mocked(api.getSession).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  rerender({ ...options, enabled: true });
  rerender({ ...options, enabled: true, branchId: "b" });
  await waitFor(() => expect(result.current.messages?.[0]?.uuid).toBe("first"));
  await act(async () => finish(page("old branch")));
  expect(result.current.messages?.[0]?.uuid).toBe("first");
  expect(api.getSession).toHaveBeenLastCalledWith(
    "p",
    "s",
    undefined,
    expect.objectContaining({ branchId: "b" }),
  );
});

it("retries a stale cursor once and does not loop on failed refreshes", async () => {
  vi.mocked(api.getSession).mockRejectedValueOnce({
    code: "SESSION_HISTORY_CHANGED",
  });
  const { result, rerender } = renderHook(useSessionInspectorHistory, {
    initialProps: { ...options, enabled: true },
  });
  await waitFor(() => expect(result.current.messages?.[0]?.uuid).toBe("first"));
  expect(api.getSession).toHaveBeenCalledTimes(2);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(api.getSession).mockRejectedValue(new Error("offline"));
  rerender({ ...options, enabled: true, revision: "r2" });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(api.getSession).toHaveBeenCalledTimes(3);
  expect(result.current.messages?.[0]?.uuid).toBe("first");
  expect(options.onError).not.toHaveBeenCalled();
  log.mockRestore();
});

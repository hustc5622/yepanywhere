import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../types";
import { useSubagentSession } from "../useSubagentSession";

const { getAgentSession, getAgentSessionInTree } = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
  getAgentSessionInTree: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { getAgentSession, getAgentSessionInTree },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(
  agentType: string,
  status: AgentSession["status"] = "running",
): AgentSession {
  return { messages: [], status, agentType };
}

const initialScope = {
  projectId: "project-1",
  parentSessionId: "parent-session",
  agentId: "child-agent",
  enabled: true,
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useSubagentSession", () => {
  let visibility: "visible" | "hidden";

  function setVisible(visible: boolean) {
    act(() => {
      visibility = visible ? "visible" : "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    getAgentSession.mockReset();
    getAgentSessionInTree.mockReset();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("loads through the parent scope only when enabled and visible", async () => {
    const data = session("explore");
    getAgentSession.mockResolvedValue(data);
    visibility = "hidden";
    const { result, rerender } = renderHook(useSubagentSession, {
      initialProps: { ...initialScope, enabled: false },
    });
    expect(result.current.loading).toBe(false);
    expect(getAgentSession).not.toHaveBeenCalled();

    rerender(initialScope);
    await advance(30_000);
    expect(getAgentSession).not.toHaveBeenCalled();
    setVisible(true);
    expect(getAgentSession).toHaveBeenCalledWith(
      "project-1",
      "parent-session",
      "child-agent",
    );
    await settle();
    expect(result.current).toMatchObject({ data, loading: false, error: null });

    rerender({ ...initialScope, enabled: false });
    act(() => result.current.refresh());
    await advance(60_000);
    expect(getAgentSession).toHaveBeenCalledTimes(1);
  });

  it("discards a late response from a different child", async () => {
    const oldRead = deferred<AgentSession>();
    const newData = session("new-child");
    getAgentSession
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(newData);
    const { result, rerender } = renderHook(useSubagentSession, {
      initialProps: initialScope,
    });
    rerender({ ...initialScope, agentId: "new-child" });
    await settle();
    expect(result.current.data).toBe(newData);

    oldRead.resolve(session("old-child"));
    await settle();
    expect(result.current.data).toBe(newData);
    expect(getAgentSession).toHaveBeenLastCalledWith(
      "project-1",
      "parent-session",
      "new-child",
    );
  });

  it("uses the root tree API when a root scope is provided", async () => {
    const data = session("grandchild", "completed");
    getAgentSessionInTree.mockResolvedValueOnce(data);
    const { result } = renderHook(() =>
      useSubagentSession({
        ...initialScope,
        parentSessionId: "immediate-parent",
        rootSessionId: "root-session",
      }),
    );
    await settle();

    expect(getAgentSessionInTree).toHaveBeenCalledWith(
      "project-1",
      "root-session",
      "child-agent",
    );
    expect(getAgentSession).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data, error: null, loading: false });
  });

  it("isolates late responses when the root tree changes for the same parent and child", async () => {
    const previousRoot = deferred<AgentSession>();
    const currentData = session("current-root");
    getAgentSessionInTree
      .mockReturnValueOnce(previousRoot.promise)
      .mockResolvedValueOnce(currentData);
    const { result, rerender } = renderHook(useSubagentSession, {
      initialProps: { ...initialScope, rootSessionId: "old-root" },
    });

    rerender({ ...initialScope, rootSessionId: "current-root" });
    await settle();
    expect(result.current.data).toBe(currentData);
    expect(getAgentSessionInTree).toHaveBeenLastCalledWith(
      "project-1",
      "current-root",
      "child-agent",
    );
    previousRoot.resolve(session("retired-root"));
    await settle();
    expect(result.current.data).toBe(currentData);
    expect(getAgentSession).not.toHaveBeenCalled();
  });

  it("immediately clears old data and errors when the parent scope changes", async () => {
    const oldData = session("old-parent");
    const newRead = deferred<AgentSession>();
    getAgentSession
      .mockResolvedValueOnce(oldData)
      .mockRejectedValueOnce(new Error("old parent unavailable"))
      .mockReturnValueOnce(newRead.promise);
    const { result, rerender } = renderHook(useSubagentSession, {
      initialProps: initialScope,
    });
    await settle();
    act(() => result.current.refresh());
    await settle();
    expect(result.current.data).toBe(oldData);
    expect(result.current.error?.message).toBe("old parent unavailable");

    rerender({ ...initialScope, parentSessionId: "other-parent" });
    expect(result.current).toMatchObject({
      data: null,
      error: null,
      loading: true,
    });
    expect(getAgentSession).toHaveBeenLastCalledWith(
      "project-1",
      "other-parent",
      "child-agent",
    );
    newRead.resolve(session("other-parent"));
    await settle();
    expect(result.current.data?.agentType).toBe("other-parent");
  });

  it("waits for a retired read before reopening the same scope without reusing its result", async () => {
    const retired = deferred<AgentSession>();
    const fresh = deferred<AgentSession>();
    getAgentSession
      .mockReturnValueOnce(retired.promise)
      .mockReturnValueOnce(fresh.promise);
    const { result, rerender } = renderHook(useSubagentSession, {
      initialProps: initialScope,
    });
    rerender({ ...initialScope, enabled: false });
    expect(result.current.loading).toBe(false);
    rerender(initialScope);
    act(() => result.current.refresh());
    expect(getAgentSession).toHaveBeenCalledTimes(1);

    retired.resolve(session("retired"));
    await settle();
    expect(result.current.data).toBeNull();
    expect(getAgentSession).toHaveBeenCalledTimes(2);
    fresh.resolve(session("fresh"));
    await settle();
    expect(result.current.data?.agentType).toBe("fresh");
  });

  it("pauses while hidden and isolates an in-flight response until a fresh visible read", async () => {
    const first = session("first");
    const hiddenRead = deferred<AgentSession>();
    const refreshed = session("visible-again");
    getAgentSession
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(hiddenRead.promise)
      .mockResolvedValueOnce(refreshed);
    const { result } = renderHook(() => useSubagentSession(initialScope));
    await settle();
    await advance(3_000);
    expect(getAgentSession).toHaveBeenCalledTimes(2);

    setVisible(false);
    hiddenRead.resolve(session("hidden-response", "completed"));
    await settle();
    expect(result.current.data).toBe(first);
    expect(result.current.loading).toBe(false);
    await advance(60_000);
    expect(getAgentSession).toHaveBeenCalledTimes(2);

    setVisible(true);
    await settle();
    expect(result.current.data).toBe(refreshed);
    expect(getAgentSession).toHaveBeenCalledTimes(3);
  });

  it("serializes refreshes and polls running and completed children at their respective intervals", async () => {
    const first = deferred<AgentSession>();
    const second = deferred<AgentSession>();
    getAgentSession
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(session("follow-up", "running"));
    const { result } = renderHook(() => useSubagentSession(initialScope));
    await advance(30_000);
    expect(getAgentSession).toHaveBeenCalledTimes(1);

    first.resolve(session("working"));
    await settle();
    await advance(2_999);
    expect(getAgentSession).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getAgentSession).toHaveBeenCalledTimes(2);
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    await advance(30_000);
    expect(getAgentSession).toHaveBeenCalledTimes(2);

    second.resolve(session("done", "completed"));
    await settle();
    await advance(14_999);
    expect(getAgentSession).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getAgentSession).toHaveBeenCalledTimes(3);
    expect(result.current.data?.agentType).toBe("follow-up");
    await advance(3_000);
    expect(getAgentSession).toHaveBeenCalledTimes(4);
  });

  it("reports a 404 without polling and allows an explicit retry", async () => {
    const retry = deferred<AgentSession>();
    getAgentSession
      .mockRejectedValueOnce(
        Object.assign(new Error("Child not found"), { status: 404 }),
      )
      .mockReturnValueOnce(retry.promise);
    const { result } = renderHook(() => useSubagentSession(initialScope));
    await settle();
    expect(result.current).toMatchObject({
      data: null,
      loading: false,
      error: { notFound: true, message: "Child not found" },
    });
    await advance(120_000);
    expect(getAgentSession).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    expect(getAgentSession).toHaveBeenCalledTimes(2);
    retry.resolve(session("available", "completed"));
    await settle();
    expect(result.current).toMatchObject({
      data: session("available", "completed"),
      error: null,
      loading: false,
    });
  });

  it("keeps loaded data after a polling failure and resets the timer after manual retry", async () => {
    const first = session("loaded");
    getAgentSession
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValue(session("recovered"));
    const { result } = renderHook(() => useSubagentSession(initialScope));
    await settle();
    await advance(3_000);
    expect(result.current).toMatchObject({
      data: first,
      error: { notFound: false, message: "Network unavailable" },
      loading: false,
    });
    await advance(60_000);
    expect(getAgentSession).toHaveBeenCalledTimes(2);
    act(() => result.current.refresh());
    await settle();
    expect(result.current.data?.agentType).toBe("recovered");
    expect(result.current.error).toBeNull();
    await advance(3_000);
    expect(getAgentSession).toHaveBeenCalledTimes(4);
  });

  it("does not schedule another request after unmounting during a read", async () => {
    const pending = deferred<AgentSession>();
    getAgentSession.mockReturnValueOnce(pending.promise);
    const { unmount } = renderHook(() => useSubagentSession(initialScope));
    unmount();
    pending.resolve(session("late"));
    await settle();
    await advance(60_000);
    expect(getAgentSession).toHaveBeenCalledTimes(1);
  });
});

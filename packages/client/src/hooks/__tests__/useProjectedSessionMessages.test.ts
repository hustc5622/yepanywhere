import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SessionDisplaySnapshot } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionManager } from "../../lib/connection";
import { DisplaySchemaMismatchError } from "../../lib/displaySchemaMismatch";
import {
  resetSessionPrefetchForTests,
  startSessionPrefetch,
} from "../../lib/sessionPrefetch";
import {
  WS_SNAPSHOT_GRACE_MS,
  resetDisplaySnapshotCacheForTests,
  useProjectedSessionMessages,
} from "../useProjectedSessionMessages";
import { useSession } from "../useSession";
import { useSessionStream } from "../useSessionStream";

const api = vi.hoisted(() => ({
  getSessionMetadata: vi.fn(),
  getSessionDisplayView: vi.fn(),
  getSessionQuestions: vi.fn(),
  getContextStatus: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api }));
vi.mock("../useSessionStream", () => ({ useSessionStream: vi.fn() }));
vi.mock("../useSessionWatchStream", () => ({
  useSessionWatchStream: () => ({ connected: false }),
}));
vi.mock("../useFileActivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../useFileActivity")>()),
  useFileActivity: () => {},
}));
const snapshot = (seq = 0, sessionId = "session"): SessionDisplaySnapshot => ({
  version: 2,
  view: { sessionId, branchScopeId: "active", epoch: "e1" },
  seq,
  nodes: [
    {
      type: "question",
      id: "q1",
      turnId: "turn:t1",
      question: { messageId: "u1", content: "Run" },
    },
  ],
  activity: { state: "running", tools: [], runningCount: 0 },
});
const options = { projectId: "project", sessionId: "session", enabled: true };
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.mocked(useSessionStream).mockReturnValue({
    connected: false,
    reconnect: vi.fn(),
  });
  api.getContextStatus.mockResolvedValue({ source: "jsonl" });
  api.getSessionMetadata.mockResolvedValue({
    session: {
      id: "session",
      provider: "codex",
      model: "model",
      updatedAt: "now",
    },
    ownership: { owner: "self", processId: "p" },
  });
  api.getSessionDisplayView.mockResolvedValue(snapshot());
  api.getSessionQuestions.mockResolvedValue({
    questions: [],
    coverage: "complete",
  });
});
afterEach(() => {
  cleanup();
  resetDisplaySnapshotCacheForTests();
  vi.resetAllMocks();
});

describe("projected session messages", () => {
  it("keeps a fresh pending prompt through historical user replays until a fresh echo arrives", async () => {
    const { result } = renderHook(() => useSession("project", "session"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.addPendingMessage("Run");
    });
    const stream = () => vi.mocked(useSessionStream).mock.calls.at(-1)?.[1];
    const pending = result.current.pendingMessages[0];
    expect(pending).toBeDefined();

    // This prompt was already visible at submission, even without a timestamp.
    act(() => {
      stream()?.onMessage({
        eventType: "message",
        type: "user",
        uuid: "u1",
        isReplay: true,
        message: { role: "user", content: "Run" },
      });
    });
    expect(result.current.pendingMessages).toEqual([pending]);

    // A previously unseen historical row is also ineligible by timestamp.
    act(() => {
      stream()?.onMessage({
        eventType: "message",
        type: "user",
        uuid: "old-unseen",
        timestamp: "2020-01-01T00:00:00.000Z",
        isReplay: true,
        message: { role: "user", content: "Run" },
      });
    });
    expect(result.current.pendingMessages).toEqual([pending]);

    act(() => {
      stream()?.onMessage({
        eventType: "message",
        type: "user",
        uuid: "fresh-echo",
        timestamp: pending?.timestamp,
        message: { role: "user", content: "Run" },
      });
    });
    expect(result.current.pendingMessages).toEqual([]);
  });

  it("applies streamed Cursor context before metadata loads and after compaction", async () => {
    const metadata = deferred<unknown>();
    api.getSessionMetadata.mockReturnValue(metadata.promise);
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    const usage = {
      inputTokens: 196_533,
      contextWindow: 256_000,
      percentage: 76.8,
    };
    act(() =>
      result.current.handleDisplayEvent?.("display-context-usage", {
        sessionId: "session",
        contextUsage: usage,
      }),
    );
    await act(async () => {
      metadata.resolve({
        session: {
          id: "session",
          provider: "cursor",
          contextUsage: { ...usage, inputTokens: 100_000 },
        },
        ownership: { owner: "self", processId: "p" },
      });
    });
    await waitFor(() =>
      expect(result.current.session?.contextUsage).toEqual(usage),
    );
    const compacted = { ...usage, inputTokens: 20_000, percentage: 7.8 };
    act(() =>
      result.current.handleDisplayEvent?.("display-context-usage", {
        sessionId: "session",
        contextUsage: compacted,
      }),
    );
    expect(result.current.session?.contextUsage).toEqual(compacted);
    act(() => {
      result.current.handleDisplayEvent?.("display-context-usage", {
        sessionId: "another-session",
        contextUsage: usage,
      });
      result.current.handleDisplayEvent?.("display-context-usage", {
        sessionId: "session",
        branchId: "another-branch",
        contextUsage: usage,
      });
      result.current.handleDisplayEvent?.("display-context-usage", {
        sessionId: "session",
        contextUsage: { ...usage, contextWindow: 0 },
      });
    });
    expect(result.current.session?.contextUsage).toEqual(compacted);
  });

  it("loads display and metadata concurrently when refreshing a branch", async () => {
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const metadata = deferred<unknown>();
    api.getSessionMetadata.mockReturnValueOnce(metadata.promise);
    api.getSessionDisplayView.mockClear();
    let refresh!: Promise<unknown>;
    act(() => {
      refresh = result.current.refreshSessionMessages();
    });
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(1);
    await act(async () => {
      metadata.resolve({
        session: { id: "session", provider: "codex" },
        ownership: { owner: "none" },
      });
      await refresh;
    });
  });
  it.each(["SESSION_DISPLAY_STALE", "SESSION_DISPLAY_CHANGED"])(
    "retries a cold %s response without publishing a page error",
    async (code) => {
      api.getSessionDisplayView.mockRejectedValueOnce(
        Object.assign(new Error("Display changed"), { status: 409, code }),
      );
      const onLoadError = vi.fn();
      const { result } = renderHook(() =>
        useProjectedSessionMessages({ ...options, onLoadError }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.displayPage?.sessionId).toBe("session");
      expect(onLoadError).not.toHaveBeenCalled();
      expect(api.getSessionDisplayView.mock.calls).toEqual([
        [
          "project",
          "session",
          { branchId: undefined, onResponse: expect.any(Function) },
        ],
        [
          "project",
          "session",
          { branchId: undefined, onResponse: expect.any(Function) },
        ],
      ]);
    },
  );

  it("stops retrying persistent display conflicts and recovers when WS supplies a snapshot", async () => {
    const error = Object.assign(new Error("Display changed"), {
      status: 409,
      code: "SESSION_DISPLAY_STALE",
    });
    api.getSessionDisplayView.mockRejectedValue(error);
    const { result } = renderHook(() => useSession("project", "session"));
    await waitFor(() => expect(result.current.error).toBe(error));
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(3);
    const streamOptions = vi.mocked(useSessionStream).mock.lastCall?.[1];
    act(() => {
      streamOptions?.onMessage({
        eventType: "display-snapshot",
        ...snapshot(),
      });
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.displayPage?.sessionId).toBe("session");
  });

  it("does not retry unrelated failures", async () => {
    const error = Object.assign(new Error("Session not found"), {
      status: 404,
      code: "SESSION_NOT_FOUND",
    });
    api.getSessionDisplayView.mockRejectedValue(error);
    const onLoadError = vi.fn();
    renderHook(() => useProjectedSessionMessages({ ...options, onLoadError }));
    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith(error));
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(1);
  });

  it("reports a display payload newer than the client schema as a mismatch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const drifted = snapshot();
    const question = drifted.nodes[0] as Extract<
      (typeof drifted.nodes)[number],
      { type: "question" }
    >;
    api.getSessionDisplayView.mockResolvedValue({
      ...drifted,
      nodes: [
        { ...question, question: { ...question.question, futureField: 1 } },
      ],
    });
    const onLoadError = vi.fn();
    renderHook(() => useProjectedSessionMessages({ ...options, onLoadError }));
    await waitFor(() => expect(onLoadError).toHaveBeenCalled());
    const error = onLoadError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(DisplaySchemaMismatchError);
    expect((error as DisplaySchemaMismatchError).detail).toBe(
      "nodes.*.question: unrecognized_keys (futureField)",
    );
  });

  it("cancels a scheduled retry after switching sessions", async () => {
    vi.useFakeTimers();
    try {
      api.getSessionDisplayView.mockRejectedValueOnce(
        Object.assign(new Error("Display changed"), {
          status: 409,
          code: "SESSION_DISPLAY_STALE",
        }),
      );
      const onLoadError = vi.fn();
      const { result, rerender } = renderHook(
        ({ sessionId }) =>
          useProjectedSessionMessages({ ...options, sessionId, onLoadError }),
        { initialProps: { sessionId: "session" } },
      );
      await act(async () => {});
      api.getSessionDisplayView.mockResolvedValue(snapshot(0, "other"));
      rerender({ sessionId: "other" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(result.current.displayPage?.sessionId).toBe("other");
      expect(api.getSessionDisplayView).toHaveBeenCalledTimes(2);
      expect(onLoadError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes metadata before the display finishes loading and retains live configuration", async () => {
    const pending = deferred<SessionDisplaySnapshot>();
    api.getSessionDisplayView.mockReturnValue(pending.promise);
    const onLoadComplete = vi.fn();
    const { result } = renderHook(() =>
      useProjectedSessionMessages({ ...options, onLoadComplete }),
    );
    await waitFor(() => expect(onLoadComplete).toHaveBeenCalled());
    expect(result.current.loading).toBe(true);
    act(() =>
      result.current.updateSessionConfiguration({
        serviceTier: "priority",
        reasoningEffort: "high",
      }),
    );
    await act(async () => {
      pending.resolve(snapshot());
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toMatchObject({
      serviceTier: "priority",
      reasoningEffort: "high",
    });
    await act(async () => {
      await result.current.fetchSessionMetadata();
    });
    expect(result.current.session?.serviceTier).toBe("priority");
  });

  it("applies an atomic stage transition and subsequent same-turn tools without raw messages", async () => {
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() =>
      result.current.handleDisplayEvent("display-patch", {
        view: snapshot().view,
        baseSeq: 0,
        seq: 1,
        remove: [],
        upsert: [
          {
            type: "segment",
            id: "progress",
            turnId: "turn:t1",
            segment: {
              type: "assistant_text",
              id: "progress",
              phase: "progress",
              content: "Continue",
            },
          },
        ],
        activity: snapshot().activity,
      }),
    );
    act(() =>
      result.current.handleDisplayEvent("display-patch", {
        view: snapshot().view,
        baseSeq: 1,
        seq: 2,
        remove: [],
        upsert: [
          {
            type: "segment",
            id: "group",
            turnId: "turn:t1",
            segment: {
              type: "tool_group",
              id: "group",
              count: 1,
              failedCount: 0,
              status: "running",
              toolNames: ["Bash"],
              detailRef: "group",
              displayMode: "steps",
              steps: [
                {
                  id: "tool",
                  groupId: "group",
                  name: "Bash",
                  summary: "pnpm test",
                  preview: "",
                  truncated: false,
                  status: "running",
                  version: 1,
                },
              ],
            },
          },
        ],
        activity: { ...snapshot().activity, runningCount: 1 },
      }),
    );
    expect(
      result.current.displayPage?.turns[0]?.segments.map((s) => s.type),
    ).toEqual(["assistant_text", "tool_group"]);
    expect(result.current.messages).toEqual([]);
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(1);
  });

  it("rejects old HTTP responses and duplicate patches after a newer streaming snapshot", async () => {
    const pending = deferred<SessionDisplaySnapshot>();
    api.getSessionDisplayView.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    act(() =>
      result.current.handleDisplayEvent("display-snapshot", {
        ...snapshot(8),
        activity: { state: "completed", tools: [], runningCount: 0 },
      }),
    );
    await act(async () => {
      pending.resolve(snapshot(2));
    });
    expect(result.current.displayActivity?.state).toBe("completed");
    act(() =>
      result.current.handleDisplayEvent("display-patch", {
        view: snapshot().view,
        baseSeq: 0,
        seq: 1,
        remove: ["q1"],
        upsert: [],
        activity: snapshot().activity,
      }),
    );
    expect(result.current.displayQuestions).toHaveLength(1);
  });

  it("resynchronizes a sequence gap instead of guessing which nodes to remove", async () => {
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.getSessionDisplayView.mockResolvedValue(snapshot(9));
    act(() =>
      result.current.handleDisplayEvent("display-patch", {
        view: snapshot().view,
        baseSeq: 8,
        seq: 9,
        remove: ["q1"],
        upsert: [],
        activity: snapshot().activity,
      }),
    );
    await waitFor(() =>
      expect(api.getSessionDisplayView).toHaveBeenCalledTimes(2),
    );
    expect(result.current.displayQuestions).toHaveLength(1);
  });

  it("isolates a late response when switching sessions", async () => {
    const pending = deferred<SessionDisplaySnapshot>();
    api.getSessionDisplayView.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ sessionId }) => useProjectedSessionMessages({ ...options, sessionId }),
      { initialProps: { sessionId: "session" } },
    );
    api.getSessionDisplayView.mockResolvedValue(snapshot(0, "other"));
    rerender({ sessionId: "other" });
    await waitFor(() =>
      expect(result.current.displayPage?.sessionId).toBe("other"),
    );
    await act(async () => {
      pending.resolve(snapshot(5));
    });
    expect(result.current.displayPage?.sessionId).toBe("other");
  });

  it("loads history without rolling back the live state or looping a finished cursor", async () => {
    api.getSessionDisplayView.mockResolvedValue({
      ...snapshot(4),
      olderCursor: "older",
    });
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.getSessionDisplayView.mockResolvedValue({
      ...snapshot(1),
      nodes: [
        {
          type: "question",
          id: "old",
          turnId: "turn:old",
          question: { messageId: "old", content: "Earlier" },
        },
      ],
    });
    await act(async () => {
      await result.current.loadOlderMessages();
    });
    expect(
      result.current.displayPage?.turns.map((t) => t.question?.messageId),
    ).toEqual(["old", "u1"]);
    expect(result.current.displayPage?.nextCursor).toBeUndefined();
    await act(async () => {
      await result.current.loadOlderMessages();
    });
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(2);
  });
});

describe("projected session messages with a connected socket", () => {
  beforeEach(() => {
    vi.spyOn(connectionManager, "state", "get").mockReturnValue("connected");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the HTTP read when the WS snapshot arrives first", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    expect(result.current.loading).toBe(true);
    act(() =>
      result.current.handleDisplayEvent("display-snapshot", snapshot(3)),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.displayKnownView).toEqual({
      epoch: snapshot().view.epoch,
      seq: 3,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_SNAPSHOT_GRACE_MS * 2);
    });
    expect(api.getSessionDisplayView).not.toHaveBeenCalled();
  });

  it("falls back to HTTP when the WS answer is late", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_SNAPSHOT_GRACE_MS);
    });
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.loading).toBe(false);
  });

  it("accepts a display-current marker for the cached projection", async () => {
    vi.useFakeTimers();
    // Seed the module cache through a first visit.
    const first = renderHook(() => useProjectedSessionMessages(options));
    act(() =>
      first.result.current.handleDisplayEvent("display-snapshot", snapshot(5)),
    );
    first.unmount();
    vi.mocked(api.getSessionDisplayView).mockClear();

    const { result } = renderHook(() => useProjectedSessionMessages(options));
    expect(result.current.displayKnownView).toEqual({
      epoch: snapshot().view.epoch,
      seq: 5,
    });
    act(() =>
      result.current.handleDisplayEvent("display-current", {
        view: snapshot().view,
        seq: 5,
      }),
    );
    expect(result.current.loading).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_SNAPSHOT_GRACE_MS * 2);
    });
    expect(api.getSessionDisplayView).not.toHaveBeenCalled();

    // A marker for a different epoch means the cache is not current.
    act(() =>
      result.current.handleDisplayEvent("display-current", {
        view: { ...snapshot().view, epoch: "other-epoch" },
        seq: 1,
      }),
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(1);
  });

  it("replaces a stale cached snapshot when HTTP returns a newer server epoch", async () => {
    vi.useFakeTimers();
    // Seed the module cache with an earlier visit's epoch.
    const first = renderHook(() => useProjectedSessionMessages(options));
    act(() =>
      first.result.current.handleDisplayEvent("display-snapshot", snapshot(5)),
    );
    first.unmount();
    vi.mocked(api.getSessionDisplayView).mockClear();

    const freshSnapshot: SessionDisplaySnapshot = {
      ...snapshot(0),
      view: { ...snapshot().view, epoch: "e2" },
      nodes: [
        ...snapshot().nodes,
        {
          type: "question",
          id: "q2",
          turnId: "turn:t2",
          question: { messageId: "u2", content: "Later prompt" },
        },
      ],
      activity: { state: "completed", tools: [], runningCount: 0 },
    };
    api.getSessionDisplayView.mockResolvedValue(freshSnapshot);

    const { result } = renderHook(() => useProjectedSessionMessages(options));
    // Shows the cached view immediately while waiting for WS.
    expect(result.current.displayKnownView).toEqual({ epoch: "e1", seq: 5 });

    // WS is slow or silent past the grace window; HTTP fallback returns e2.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_SNAPSHOT_GRACE_MS);
    });
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(1);
    expect(result.current.displayKnownView).toEqual({ epoch: "e2", seq: 0 });
    expect(result.current.displayQuestions).toHaveLength(2);
    expect(result.current.displayActivity?.state).toBe("completed");
  });

  it("retries a transient 409 conflict even when a stale cached snapshot is displayed", async () => {
    vi.useFakeTimers();
    const first = renderHook(() => useProjectedSessionMessages(options));
    act(() =>
      first.result.current.handleDisplayEvent("display-snapshot", snapshot(5)),
    );
    first.unmount();
    vi.mocked(api.getSessionDisplayView).mockClear();

    const freshSnapshot: SessionDisplaySnapshot = {
      ...snapshot(1),
      view: { ...snapshot().view, epoch: "e2" },
      activity: { state: "completed", tools: [], runningCount: 0 },
    };
    api.getSessionDisplayView
      .mockRejectedValueOnce(
        Object.assign(new Error("Display changed"), {
          status: 409,
          code: "SESSION_DISPLAY_CHANGED",
        }),
      )
      .mockResolvedValueOnce(freshSnapshot);

    const { result } = renderHook(() => useProjectedSessionMessages(options));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_SNAPSHOT_GRACE_MS + 300);
    });
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(2);
    expect(result.current.displayKnownView).toEqual({ epoch: "e2", seq: 1 });
    expect(result.current.displayActivity?.state).toBe("completed");
  });
});

describe("projected session messages with a cold-start prefetch", () => {
  afterEach(() => {
    resetSessionPrefetchForTests();
  });

  it("uses the prefetched view and metadata instead of new reads", async () => {
    api.getSessionDisplayView.mockResolvedValueOnce(snapshot(7));
    expect(
      startSessionPrefetch(
        { pathname: "/projects/project/sessions/session", search: "" },
        "",
      ),
    ).toBe(true);
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(1);
    expect(api.getSessionMetadata).toHaveBeenCalledTimes(1);

    const { result } = renderHook(() => useProjectedSessionMessages(options));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.displayKnownView?.seq).toBe(7);
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.session?.id).toBe("session"));
    expect(api.getSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal reads when the prefetch failed", async () => {
    api.getSessionDisplayView.mockRejectedValueOnce(new Error("offline"));
    api.getSessionMetadata.mockRejectedValueOnce(new Error("offline"));
    startSessionPrefetch(
      { pathname: "/projects/project/sessions/session", search: "" },
      "",
    );
    const { result } = renderHook(() => useProjectedSessionMessages(options));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getSessionDisplayView).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(api.getSessionMetadata).toHaveBeenCalledTimes(2),
    );
  });
});

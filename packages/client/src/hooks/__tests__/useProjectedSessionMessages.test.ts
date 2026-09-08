import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SessionDisplaySnapshot } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDisplaySnapshotCacheForTests,
  useProjectedSessionMessages,
} from "../useProjectedSessionMessages";

const api = vi.hoisted(() => ({
  getSessionMetadata: vi.fn(),
  getSessionDisplayView: vi.fn(),
  getSessionQuestions: vi.fn(),
  getContextStatus: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api }));
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

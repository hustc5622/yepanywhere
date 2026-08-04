import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Session } from "../../types";
import {
  planActiveMessageWindowTrim,
  truncateMessagesForEdit,
  useSessionMessages,
} from "../useSessionMessages";

const { mockGetSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getSession: mockGetSession,
    getSessionMetadata: vi.fn(),
  },
}));

function message(id: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    type: "user",
    message: { role: "user", content: id },
    ...extra,
  };
}

function codexSession(
  updatedAt: string,
  messages: Message[],
  extra: Partial<Session> = {},
): Session {
  return {
    id: "session-1",
    projectId: "project-1" as Session["projectId"],
    title: null,
    fullTitle: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt,
    messageCount: messages.length,
    ownership: { owner: "none" },
    provider: "codex",
    messages,
    ...extra,
  };
}

function sessionResponse(
  updatedAt: string,
  messages: Message[],
  extra: Partial<Session> = {},
) {
  const session = codexSession(updatedAt, messages, extra);
  return {
    session,
    messages,
    ownership: session.ownership,
    pagination: {
      hasOlderMessages: false,
      totalMessageCount: messages.length,
      returnedMessageCount: messages.length,
      totalCompactions: 0,
    },
  };
}

function kimiSessionResponse(updatedAt: string, messages: Message[]) {
  return sessionResponse(updatedAt, messages, { provider: "kimi" });
}

function codexBranchState(
  activeBranchId: string,
  branches: Array<{ id: string; parentId: string | null; isActive: boolean }>,
): NonNullable<Session["codexBranchState"]> {
  return {
    sessionId: "session-1",
    activeBranchId,
    selectedBranchId: activeBranchId,
    branches: branches.map((branch, index) => ({
      ...branch,
      sessionId: "session-1",
      prompt: branch.id,
      title: branch.id,
      depth: branch.parentId ? 2 : 1,
      index: index + 1,
      siblingIndex: 1,
      siblingCount: 1,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("truncateMessagesForEdit", () => {
  it("preserves the streamed optimistic edit that arrived before resume returned", () => {
    const optimisticEdit = message("edited-stream", { tempId: "temp-edit" });
    const messages = [
      message("before"),
      message("edited-original"),
      message("old-response", { type: "assistant" }),
      optimisticEdit,
    ];

    expect(
      truncateMessagesForEdit(messages, "edited-original", "temp-edit"),
    ).toEqual([messages[0], optimisticEdit]);
  });

  it("keeps the previous truncation behavior without a matching temp id", () => {
    const messages = [
      message("before"),
      message("edited-original"),
      message("old-response", { type: "assistant" }),
    ];

    expect(truncateMessagesForEdit(messages, "edited-original")).toEqual([
      messages[0],
    ]);
  });
});

describe("planActiveMessageWindowTrim", () => {
  it("retains complete recent turns and ignores tool-result user messages", () => {
    const messages: Message[] = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push(
        message(`user-${index}`, {
          timestamp: "2020-01-01T00:00:00.000Z",
        }),
        message(`assistant-${index}`, {
          type: "assistant",
          timestamp: "2020-01-01T00:00:01.000Z",
          message: { role: "assistant", content: `response ${index}` },
        }),
        message(`tool-result-${index}`, {
          timestamp: "2020-01-01T00:00:02.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `tool-${index}`,
                content: "done",
              },
            ],
          },
        }),
      );
    }

    const plan = planActiveMessageWindowTrim(
      messages,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );

    expect(plan?.firstRetainedMessageId).toBe("user-26");
    expect(plan?.messages[0]?.id).toBe("user-26");
    expect(plan?.messages).toHaveLength(102);
  });

  it("still bounds a single tool-heavy turn without a nearby user boundary", () => {
    const messages = [
      message("user-0", { timestamp: "2020-01-01T00:00:00.000Z" }),
      ...Array.from({ length: 150 }, (_, index) =>
        message(`assistant-${index}`, {
          type: "assistant",
          timestamp: "2020-01-01T00:00:01.000Z",
          message: { role: "assistant", content: `response ${index}` },
        }),
      ),
    ];

    const plan = planActiveMessageWindowTrim(
      messages,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );

    expect(plan?.firstRetainedMessageId).toBe("assistant-50");
    expect(plan?.messages).toHaveLength(100);
  });

  it("waits for the retained boundary to be old enough to be persisted", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const messages = Array.from({ length: 151 }, (_, index) =>
      message(`user-${index}`, {
        timestamp: new Date(nowMs - 10_000).toISOString(),
      }),
    );

    expect(planActiveMessageWindowTrim(messages, nowMs)).toBeNull();
  });
});

describe("useSessionMessages Codex snapshot refresh", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not let a late initial load overwrite a newer committed refresh", async () => {
    const initialMessage = message("persisted-1", {
      timestamp: "2026-07-31T00:00:01.000Z",
    });
    const newerMessage = message("persisted-2", {
      type: "assistant",
      timestamp: "2026-07-31T00:00:02.000Z",
    });
    const initialLoad = deferred<ReturnType<typeof sessionResponse>>();
    mockGetSession
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:02.000Z", [
          initialMessage,
          newerMessage,
        ]),
      );

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );

    await act(async () => {
      await result.current.refreshSessionMessages();
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "persisted-1",
      "persisted-2",
    ]);

    await act(async () => {
      initialLoad.resolve(
        sessionResponse("2026-07-31T00:00:01.000Z", [initialMessage]),
      );
      await initialLoad.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.session?.updatedAt).toBe("2026-07-31T00:00:02.000Z");
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "persisted-1",
      "persisted-2",
    ]);
  });

  it("ignores an older full refresh that resolves after a newer request", async () => {
    const initialMessage = message("persisted-1", {
      timestamp: "2026-07-31T00:00:01.000Z",
    });
    const newerToolMessage = message("persisted-tool", {
      type: "assistant",
      timestamp: "2026-07-31T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
      },
    });
    const olderRefresh = deferred<ReturnType<typeof sessionResponse>>();
    const newerRefresh = deferred<ReturnType<typeof sessionResponse>>();
    mockGetSession
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:01.000Z", [initialMessage]),
      )
      .mockReturnValueOnce(olderRefresh.promise)
      .mockReturnValueOnce(newerRefresh.promise);

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstRequest!: Promise<Session | null>;
    let secondRequest!: Promise<Session | null>;
    act(() => {
      firstRequest = result.current.refreshSessionMessages();
      secondRequest = result.current.refreshSessionMessages();
    });

    await act(async () => {
      newerRefresh.resolve(
        sessionResponse("2026-07-31T00:00:02.000Z", [
          initialMessage,
          newerToolMessage,
        ]),
      );
      await secondRequest;
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "persisted-1",
      "persisted-tool",
    ]);

    let staleResult: Session | null = codexSession(
      "2026-07-31T00:00:00.000Z",
      [],
    );
    await act(async () => {
      olderRefresh.resolve(
        sessionResponse("2026-07-31T00:00:01.000Z", [initialMessage]),
      );
      staleResult = await firstRequest;
    });

    expect(staleResult).toBeNull();
    expect(result.current.session?.updatedAt).toBe("2026-07-31T00:00:02.000Z");
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "persisted-1",
      "persisted-tool",
    ]);
  });

  it("can still apply an earlier response when the newer refresh fails", async () => {
    const initialMessage = message("persisted-1", {
      timestamp: "2026-07-31T00:00:01.000Z",
    });
    const recoveredMessage = message("persisted-2", {
      type: "assistant",
      timestamp: "2026-07-31T00:00:02.000Z",
    });
    const earlierRefresh = deferred<ReturnType<typeof sessionResponse>>();
    const failedNewerRefresh = deferred<ReturnType<typeof sessionResponse>>();
    mockGetSession
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:01.000Z", [initialMessage]),
      )
      .mockReturnValueOnce(earlierRefresh.promise)
      .mockReturnValueOnce(failedNewerRefresh.promise);

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstRequest!: Promise<Session | null>;
    let secondRequest!: Promise<Session | null>;
    act(() => {
      firstRequest = result.current.refreshSessionMessages();
      secondRequest = result.current.refreshSessionMessages();
    });

    await act(async () => {
      failedNewerRefresh.reject(new Error("network unavailable"));
      expect(await secondRequest).toBeNull();
    });
    await act(async () => {
      earlierRefresh.resolve(
        sessionResponse("2026-07-31T00:00:02.000Z", [
          initialMessage,
          recoveredMessage,
        ]),
      );
      await firstRequest;
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "persisted-1",
      "persisted-2",
    ]);
  });

  it("keeps live tool output when the latest disk snapshot still lags", async () => {
    const persistedMessage = message("persisted-1", {
      timestamp: "2026-07-31T00:00:01.000Z",
    });
    const liveToolMessage = message("live-tool", {
      type: "assistant",
      timestamp: "2026-07-31T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-live",
            name: "Bash",
            input: { command: "pnpm typecheck" },
            partialOutput: "checking client types",
          },
        ],
      },
    });
    const laggingPersistedToolMessage = message("persisted-tool", {
      type: "assistant",
      timestamp: "2026-07-31T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-live",
            name: "Bash",
            input: { command: "pnpm typecheck" },
          },
        ],
      },
    });
    const laggingRefresh = deferred<ReturnType<typeof sessionResponse>>();
    mockGetSession
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:01.000Z", [persistedMessage]),
      )
      .mockReturnValueOnce(laggingRefresh.promise);

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let refreshRequest!: Promise<Session | null>;
    act(() => {
      refreshRequest = result.current.refreshSessionMessages();
      result.current.handleStreamMessageEvent(liveToolMessage);
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "persisted-1",
      "live-tool",
    ]);

    await act(async () => {
      laggingRefresh.resolve(
        sessionResponse("2026-07-31T00:00:02.000Z", [
          persistedMessage,
          laggingPersistedToolMessage,
        ]),
      );
      await refreshRequest;
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "persisted-1",
      "persisted-tool",
    ]);
    expect(result.current.messages[1]?._source).toBe("jsonl");
    expect(result.current.messages[1]?.message?.content).toMatchObject([
      {
        type: "tool_use",
        id: "call-live",
        partialOutput: "checking client types",
      },
    ]);
  });

  it("still allows an explicit history rewrite to replace the visible tail", async () => {
    const retainedMessage = message("retained", {
      timestamp: "2026-07-31T00:00:01.000Z",
    });
    const oldBranchMessage = message("old-branch", {
      type: "assistant",
      timestamp: "2026-07-31T00:00:02.000Z",
    });
    mockGetSession
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:02.000Z", [
          retainedMessage,
          oldBranchMessage,
        ]),
      )
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:03.000Z", [retainedMessage]),
      );

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refreshSessionMessages({ replaceMessages: true });
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "retained",
    ]);
  });

  it("does not treat a normal new Codex turn as a destructive branch rewrite", async () => {
    const persistedMessage = message("persisted-1", {
      timestamp: "2026-07-31T00:00:01.000Z",
    });
    const liveMessage = message("live-tool", {
      type: "assistant",
      timestamp: "2026-07-31T00:00:02.000Z",
    });
    mockGetSession
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:01.000Z", [persistedMessage], {
          codexBranchState: codexBranchState("branch-1", [
            { id: "branch-1", parentId: null, isActive: true },
          ]),
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:02.000Z", [persistedMessage], {
          codexBranchState: codexBranchState("branch-2", [
            { id: "branch-1", parentId: null, isActive: true },
            { id: "branch-2", parentId: "branch-1", isActive: true },
          ]),
        }),
      );

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.handleStreamMessageEvent(liveMessage));
    await act(async () => {
      await result.current.refreshSessionMessages();
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "persisted-1",
      "live-tool",
    ]);
  });

  it("replaces an inactive tail when persisted Codex history proves a rollback", async () => {
    const retainedMessage = message("retained", {
      timestamp: "2026-07-31T00:00:01.000Z",
    });
    const rolledBackMessage = message("rolled-back", {
      type: "assistant",
      timestamp: "2026-07-31T00:00:02.000Z",
    });
    mockGetSession
      .mockResolvedValueOnce(
        sessionResponse(
          "2026-07-31T00:00:02.000Z",
          [retainedMessage, rolledBackMessage],
          {
            codexBranchState: codexBranchState("branch-2", [
              { id: "branch-1", parentId: null, isActive: true },
              { id: "branch-2", parentId: "branch-1", isActive: true },
            ]),
          },
        ),
      )
      .mockResolvedValueOnce(
        sessionResponse("2026-07-31T00:00:03.000Z", [retainedMessage], {
          codexBranchState: codexBranchState("branch-1", [
            { id: "branch-1", parentId: null, isActive: true },
            { id: "branch-2", parentId: "branch-1", isActive: false },
          ]),
        }),
      );

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refreshSessionMessages();
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "retained",
    ]);
  });
});

describe("useSessionMessages Kimi authoritative snapshot sync", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("replaces live UUID copies instead of appending the full persisted history", async () => {
    const firstUser = message("session-1-user-0", {
      timestamp: "2026-08-04T07:25:14.291Z",
      message: { role: "user", content: "first question" },
    });
    const firstAssistant = message("session-1-assistant-0", {
      type: "assistant",
      timestamp: "2026-08-04T07:27:51.439Z",
      message: { role: "assistant", content: "first answer" },
    });
    const persistedSecondUser = message("session-1-user-1", {
      timestamp: "2026-08-04T07:29:30.479Z",
      message: { role: "user", content: "second question" },
    });
    const persistedSecondAssistant = message("session-1-assistant-1", {
      type: "assistant",
      timestamp: "2026-08-04T07:34:21.313Z",
      message: { role: "assistant", content: "second answer" },
    });
    const persistedThirdUser = message("session-1-user-2", {
      timestamp: "2026-08-04T07:39:41.242Z",
      message: { role: "user", content: "third question" },
    });
    const persistedThirdAssistant = message("session-1-assistant-2", {
      type: "assistant",
      timestamp: "2026-08-04T07:55:48.416Z",
      message: { role: "assistant", content: "third answer" },
    });

    mockGetSession.mockResolvedValueOnce(
      kimiSessionResponse("2026-08-04T07:27:51.439Z", [
        firstUser,
        firstAssistant,
      ]),
    );

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamMessageEvent(
        message("live-second-user", {
          timestamp: "2026-08-04T07:29:30.100Z",
          message: { role: "user", content: "second question" },
        }),
      );
      result.current.handleStreamMessageEvent(
        message("live-second-assistant", {
          type: "assistant",
          timestamp: "2026-08-04T07:34:21.500Z",
          message: { role: "assistant", content: "second answer" },
        }),
      );
      result.current.handleStreamMessageEvent(
        message("live-third-user", {
          timestamp: "2026-08-04T07:39:41.000Z",
          message: { role: "user", content: "third question" },
        }),
      );
      result.current.handleStreamMessageEvent(
        message("live-third-assistant", {
          type: "assistant",
          timestamp: "2026-08-04T07:55:48.500Z",
          message: { role: "assistant", content: "third answer" },
        }),
      );
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "session-1-user-0",
      "session-1-assistant-0",
      "live-second-user",
      "live-second-assistant",
      "live-third-user",
      "live-third-assistant",
    ]);

    mockGetSession.mockResolvedValueOnce(
      kimiSessionResponse("2026-08-04T07:55:48.416Z", [
        firstUser,
        firstAssistant,
        persistedSecondUser,
        persistedSecondAssistant,
        persistedThirdUser,
        persistedThirdAssistant,
      ]),
    );

    await act(async () => {
      await result.current.fetchNewMessages();
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "session-1-user-0",
      "session-1-assistant-0",
      "session-1-user-1",
      "session-1-assistant-1",
      "session-1-user-2",
      "session-1-assistant-2",
    ]);
    expect(
      result.current.messages.every((item) => item._source === "jsonl"),
    ).toBe(true);
  });
});

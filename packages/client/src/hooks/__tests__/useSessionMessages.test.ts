import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionSnapshotCacheForTests } from "../../lib/sessionSnapshotCache";
import type { Message, Session } from "../../types";
import {
  planActiveMessageWindowTrim,
  truncateMessagesForEdit,
  useSessionMessages,
} from "../useSessionMessages";

const {
  mockGetSession,
  mockGetSessionMetadata,
  mockGetContextStatus,
  mockGetSessionDisplay,
  mockGetSessionToolGroupDetails,
  mockGetSessionQuestions,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetSessionMetadata: vi.fn(),
  mockGetContextStatus: vi.fn(),
  mockGetSessionDisplay: vi.fn(),
  mockGetSessionToolGroupDetails: vi.fn(),
  mockGetSessionQuestions: vi.fn(),
}));

beforeEach(() => {
  mockGetContextStatus.mockReset();
  mockGetContextStatus.mockResolvedValue({
    source: "jsonl",
    contextWindow: 200_000,
    contextWindowFromCache: false,
  });
});

afterEach(() => {
  resetSessionSnapshotCacheForTests();
  mockGetSessionMetadata.mockReset();
  mockGetSessionDisplay.mockReset();
  mockGetSessionToolGroupDetails.mockReset();
  mockGetSessionQuestions.mockReset();
});

vi.mock("../../api/client", () => ({
  api: {
    getSession: mockGetSession,
    getSessionMetadata: mockGetSessionMetadata,
    getContextStatus: mockGetContextStatus,
    getSessionDisplay: mockGetSessionDisplay,
    getSessionToolGroupDetails: mockGetSessionToolGroupDetails,
    getSessionQuestions: mockGetSessionQuestions,
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

describe("useSessionMessages lightweight display history", () => {
  afterEach(() => {
    cleanup();
    mockGetSession.mockReset();
  });

  it("opens an inactive session without requesting the legacy transcript", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", []);
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: { owner: "none" },
    });
    mockGetSessionDisplay
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-1",
        turns: [
          {
            id: "turn:user-2",
            question: { messageId: "user-2", content: "Question 2" },
            segments: [],
          },
        ],
        nextCursor: "older-display",
      })
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-1",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Question 1" },
            segments: [],
          },
        ],
      });
    mockGetSessionQuestions
      .mockResolvedValueOnce({
        questions: [
          {
            messageId: "user-2",
            turnId: "turn:user-2",
            preview: "Question 2",
          },
        ],
        coverage: "partial",
        nextCursor: "older-questions",
      })
      .mockResolvedValueOnce({
        questions: [
          {
            messageId: "user-1",
            turnId: "turn:user-1",
            preview: "Question 1",
          },
        ],
        coverage: "complete",
      });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(result.current.displayQuestionCoverage).toBe("complete"),
    );
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.displayPage?.turns[0]?.id).toBe("turn:user-2");
    expect(
      result.current.displayQuestions.map((question) => question.id),
    ).toEqual(["user-1", "user-2"]);

    await act(async () => {
      await result.current.loadOlderMessages();
    });
    expect(result.current.displayPage?.turns.map((turn) => turn.id)).toEqual([
      "turn:user-1",
      "turn:user-2",
    ]);
  });

  it("restarts the question snapshot once when an active revision changes", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", []);
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: { owner: "none" },
    });
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-2",
      turns: [],
    });
    mockGetSessionQuestions
      .mockResolvedValueOnce({
        questions: [
          {
            messageId: "newer-1",
            turnId: "turn:newer-1",
            preview: "Newer question",
          },
        ],
        coverage: "partial",
        nextCursor: "stale-cursor",
      })
      .mockRejectedValueOnce({ code: "SESSION_DISPLAY_STALE" })
      .mockResolvedValueOnce({
        questions: [
          {
            messageId: "newer-2",
            turnId: "turn:newer-2",
            preview: "Current newer question",
          },
        ],
        coverage: "partial",
        nextCursor: "current-cursor",
      })
      .mockResolvedValueOnce({
        questions: [
          {
            messageId: "older-2",
            turnId: "turn:older-2",
            preview: "Current older question",
          },
        ],
        coverage: "complete",
      });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );

    await waitFor(() =>
      expect(result.current.displayQuestionCoverage).toBe("complete"),
    );
    expect(mockGetSessionQuestions).toHaveBeenCalledTimes(4);
    expect(
      result.current.displayQuestions.map((question) => question.id),
    ).toEqual(["older-2", "newer-2"]);
  });

  it("fills missing metadata usage from the indexed context status", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", []);
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: { owner: "none" },
    });
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-1",
      turns: [],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });
    mockGetContextStatus.mockResolvedValue({
      source: "jsonl",
      model: "gpt-5.6-sol",
      contextWindow: 760_000,
      contextWindowFromCache: true,
      contextUsage: {
        inputTokens: 394_295,
        percentage: 52,
        contextWindow: 760_000,
        outputTokens: 700,
        cacheReadTokens: 393_856,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );

    await waitFor(() =>
      expect(result.current.session?.contextUsage).toMatchObject({
        inputTokens: 394_295,
        percentage: 52,
        contextWindow: 760_000,
      }),
    );
    expect(result.current.session?.model).toBe("gpt-5.6-sol");
    expect(mockGetContextStatus).toHaveBeenCalledTimes(1);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("loads active history through display and hydrates only the self live tail", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", []);
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: { owner: "self", processId: "process-1" },
    });
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-active",
      turns: [
        {
          id: "turn:user-1",
          question: { messageId: "user-1", content: "Run the checks" },
          segments: [
            {
              type: "tool_group",
              id: "group-history",
              status: "completed",
              count: 10,
              failedCount: 0,
              toolNames: ["Bash"],
              detailRef: "detail-history",
            },
            {
              type: "tool_group",
              id: "group-live",
              status: "running",
              count: 1,
              failedCount: 0,
              toolNames: ["Bash"],
              detailRef: "detail-live",
              liveTail: true,
            },
          ],
        },
      ],
    });
    mockGetSessionToolGroupDetails.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-active",
      detailRef: "detail-live",
      messages: [message("live-tail-1")],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetSessionDisplay).toHaveBeenCalledTimes(1);
    expect(mockGetSessionToolGroupDetails).toHaveBeenCalledWith(
      "project-1",
      "session-1",
      "detail-live",
      expect.objectContaining({ revision: "revision-active" }),
    );
    expect(result.current.displayPage?.revision).toBe("revision-active");
    expect(result.current.hydratedLiveTailDetailRef).toBe("detail-live");
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "live-tail-1",
    ]);
  });

  it("does not re-add a live Codex user echo already owned by display", async () => {
    const session = codexSession("2026-09-01T11:47:39.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-active-user",
      turns: [
        {
          id: "turn:turn-1",
          question: {
            messageId: "persisted-user",
            clientUserMessageId: "client-user-1",
            codexCorrelationKey: "codex:user-message:client-user-1",
            content: "Run once",
            timestamp: "2026-09-01T11:47:42.595Z",
          },
          segments: [],
        },
      ],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamMessageEvent(
        message("live-user", {
          _source: "sdk",
          clientUserMessageId: "client-user-1",
          codexCorrelationKey: "codex:user-message:client-user-1",
          codexTurnId: "turn-1",
          timestamp: "2026-09-01T11:47:39.535Z",
          message: { role: "user", content: "Run once" },
        }),
      );
    });
    expect(result.current.messages).toEqual([]);

    act(() => {
      result.current.handleStreamMessageEvent(
        message("intentional-repeat", {
          _source: "sdk",
          clientUserMessageId: "client-user-2",
          codexCorrelationKey: "codex:user-message:client-user-2",
          codexTurnId: "turn-2",
          timestamp: "2026-09-01T11:47:43.000Z",
          message: { role: "user", content: "Run once" },
        }),
      );
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "intentional-repeat",
    ]);
  });

  it("drops a replayed Pi prompt and tail rows already persisted under different ids", async () => {
    const session = codexSession("2026-09-02T07:59:31.000Z", [], {
      provider: "pi",
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-pi",
      turns: [
        {
          id: "turn:7bf2d331",
          question: {
            messageId: "7bf2d331",
            content: "git-commit-push 一下",
            timestamp: "2026-09-02T07:59:17.396Z",
          },
          segments: [
            {
              type: "tool_group",
              id: "group-live",
              status: "running",
              count: 1,
              failedCount: 0,
              toolNames: ["Bash"],
              detailRef: "detail-live",
              liveTail: true,
              timestamp: "2026-09-02T07:59:31.399Z",
            },
          ],
        },
      ],
    });
    mockGetSessionToolGroupDetails.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-pi",
      detailRef: "detail-live",
      messages: [
        message("0c9dff55", {
          type: "assistant",
          timestamp: "2026-09-02T07:59:31.365Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-3", name: "Bash", input: {} },
            ],
          },
        }),
      ],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "0c9dff55",
    ]);

    // Reconnect replay: the optimistic prompt carries the client UUID, which
    // Pi never persists, and the tool rows carry synthetic live ids.
    act(() => {
      result.current.handleStreamMessageEvent(
        message("client-uuid-1", {
          uuid: "client-uuid-1",
          _source: "sdk",
          isReplay: true,
          isOptimistic: true,
          clientUserMessageId: "client-uuid-1",
          timestamp: "2026-09-02T07:59:17.380Z",
          message: { role: "user", content: "git-commit-push 一下" },
        }),
      );
      result.current.handleStreamMessageEvent(
        message("pi-assistant-1", {
          uuid: "pi-assistant-1",
          type: "assistant",
          _source: "sdk",
          isReplay: true,
          timestamp: "2026-09-02T07:59:31.365Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-3", name: "Bash", input: {} },
            ],
          },
        }),
      );
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "0c9dff55",
    ]);

    // A newer live row past the persisted watermark is still appended.
    act(() => {
      result.current.handleStreamMessageEvent(
        message("pi-assistant-2", {
          uuid: "pi-assistant-2",
          type: "assistant",
          _source: "sdk",
          isReplay: true,
          timestamp: "2026-09-02T07:59:40.047Z",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "next" }],
          },
        }),
      );
    });
    expect(result.current.messages.map((item) => item.uuid ?? item.id)).toEqual(
      ["0c9dff55", "pi-assistant-2"],
    );

    // A genuinely new prompt with the same text is not swallowed.
    act(() => {
      result.current.handleStreamMessageEvent(
        message("client-uuid-2", {
          uuid: "client-uuid-2",
          _source: "sdk",
          isOptimistic: true,
          clientUserMessageId: "client-uuid-2",
          timestamp: "2026-09-02T08:03:00.000Z",
          message: { role: "user", content: "git-commit-push 一下" },
        }),
      );
    });
    expect(result.current.messages.map((item) => item.uuid ?? item.id)).toEqual(
      ["0c9dff55", "pi-assistant-2", "client-uuid-2"],
    );
  });

  it("matches a replayed Pi prompt to the display question by text when nothing newer is persisted", async () => {
    const session = codexSession("2026-09-02T07:59:17.000Z", [], {
      provider: "pi",
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-pi",
      turns: [
        {
          id: "turn:7bf2d331",
          question: {
            messageId: "7bf2d331",
            content: "git-commit-push 一下",
            timestamp: "2026-09-02T07:59:17.396Z",
          },
          segments: [],
        },
      ],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamMessageEvent(
        message("client-uuid-1", {
          uuid: "client-uuid-1",
          _source: "sdk",
          isReplay: true,
          isOptimistic: true,
          clientUserMessageId: "client-uuid-1",
          // Stamped after the persisted entry, so the watermark alone would
          // not catch it.
          timestamp: "2026-09-02T07:59:17.900Z",
          message: { role: "user", content: "git-commit-push  一下" },
        }),
      );
    });
    expect(result.current.messages).toEqual([]);
  });

  it("does not re-add live assistant text already owned by display", async () => {
    const session = codexSession("2026-09-01T12:19:29.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-active-assistant",
      turns: [
        {
          id: "turn:turn-1",
          question: { messageId: "user-1", content: "Inspect" },
          segments: [
            {
              type: "assistant_text",
              id: "persisted-progress:0",
              codexCorrelationKey:
                "codex:turn-1:agent-message:native-progress-1",
              phase: "progress",
              content: "Checking the runtime semantics.",
            },
          ],
        },
      ],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamMessageEvent(
        message("live-progress", {
          type: "assistant",
          role: "assistant",
          _source: "sdk",
          codexCorrelationKey: "codex:turn-1:agent-message:native-progress-1",
          message: {
            role: "assistant",
            content: "Checking the runtime semantics.",
          },
        }),
      );
    });
    expect(result.current.messages).toEqual([]);

    act(() => {
      result.current.handleStreamMessageEvent(
        message("intentional-progress", {
          type: "assistant",
          role: "assistant",
          _source: "sdk",
          codexCorrelationKey: "codex:turn-1:agent-message:native-progress-2",
          message: {
            role: "assistant",
            content: "Checking the runtime semantics.",
          },
        }),
      );
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "intentional-progress",
    ]);
  });

  it("replaces the hydrated live tail with display after the turn settles", async () => {
    const activeSession = codexSession("2026-09-01T00:00:00.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    const settledSession = codexSession("2026-09-01T00:00:01.000Z", [], {
      activity: "idle",
    });
    mockGetSessionMetadata
      .mockResolvedValueOnce({
        session: activeSession,
        ownership: activeSession.ownership,
      })
      .mockResolvedValueOnce({
        session: settledSession,
        ownership: { owner: "none" },
      });
    mockGetSessionDisplay
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-active",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Run the checks" },
            segments: [
              {
                type: "tool_group",
                id: "group-live",
                status: "running",
                count: 1,
                failedCount: 0,
                toolNames: ["Bash"],
                detailRef: "detail-live",
                liveTail: true,
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-settled",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Run the checks" },
            segments: [
              {
                type: "tool_group",
                id: "group-closed",
                status: "completed",
                count: 1,
                failedCount: 0,
                toolNames: ["Bash"],
                detailRef: "detail-closed",
              },
            ],
          },
        ],
      });
    mockGetSessionToolGroupDetails.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-active",
      detailRef: "detail-live",
      messages: [message("live-tail-1")],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result, rerender } = renderHook(
      ({ settled }) =>
        useSessionMessages({
          projectId: "project-1",
          sessionId: "session-1",
          preferDisplayHistory: true,
          displayHistoryEligible: settled,
        }),
      { initialProps: { settled: false } },
    );
    await waitFor(() =>
      expect(result.current.hydratedLiveTailDetailRef).toBe("detail-live"),
    );

    rerender({ settled: true });

    await waitFor(() =>
      expect(result.current.displayPage?.revision).toBe("revision-settled"),
    );
    expect(result.current.hydratedLiveTailDetailRef).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("drops a closed raw prefix once readable output is persisted in display", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-active",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Run" },
            segments: [
              {
                type: "tool_group",
                id: "group-live",
                status: "running",
                count: 1,
                failedCount: 0,
                toolNames: ["Bash"],
                detailRef: "detail-live",
                liveTail: true,
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-closed",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Run" },
            segments: [
              {
                type: "tool_group",
                id: "group-closed",
                status: "completed",
                count: 1,
                failedCount: 0,
                toolNames: ["Bash"],
                detailRef: "detail-closed",
              },
              {
                type: "assistant_text",
                id: "persisted-progress:0",
                codexCorrelationKey:
                  "codex:turn-1:agent-message:native-progress-1",
                phase: "progress",
                content: "Checks completed.",
              },
            ],
          },
        ],
      });
    mockGetSessionToolGroupDetails.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-active",
      detailRef: "detail-live",
      messages: [message("live-tail-1")],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
        displayHistoryLiveOwned: true,
      }),
    );
    await waitFor(() =>
      expect(result.current.hydratedLiveTailDetailRef).toBe("detail-live"),
    );

    act(() => {
      result.current.handleStreamMessageEvent(
        message("live-progress", {
          type: "assistant",
          role: "assistant",
          codexCorrelationKey: "codex:turn-1:agent-message:native-progress-1",
          message: { role: "assistant", content: "Checks completed." },
          _source: "sdk",
        }),
      );
    });

    await waitFor(() =>
      expect(result.current.displayPage?.revision).toBe("revision-closed"),
    );
    expect(result.current.hydratedLiveTailDetailRef).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(mockGetSessionDisplay).toHaveBeenCalledTimes(2);
  });

  it("keeps prompts sent after the question snapshot in the question index", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-1",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "First question" },
            segments: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-2",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "First question" },
            segments: [],
          },
          {
            id: "turn:user-2",
            question: {
              messageId: "user-2",
              content: "Second question",
              timestamp: "2026-09-01T00:01:00.000Z",
            },
            segments: [
              {
                type: "assistant_text",
                id: "persisted-progress:0",
                codexCorrelationKey:
                  "codex:turn-2:agent-message:native-progress-1",
                phase: "progress",
                content: "Working on it.",
              },
            ],
          },
        ],
      });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [
        {
          messageId: "user-1",
          turnId: "turn:user-1",
          preview: "First question",
        },
      ],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
        displayHistoryLiveOwned: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(
        result.current.displayQuestions.map((question) => question.id),
      ).toEqual(["user-1"]),
    );

    act(() => {
      result.current.handleStreamMessageEvent(
        message("live-user-2", {
          message: { role: "user", content: "Second question" },
          _source: "sdk",
        }),
      );
      result.current.handleStreamMessageEvent(
        message("live-progress", {
          type: "assistant",
          role: "assistant",
          codexCorrelationKey: "codex:turn-2:agent-message:native-progress-1",
          message: { role: "assistant", content: "Working on it." },
          _source: "sdk",
        }),
      );
    });

    await waitFor(() =>
      expect(result.current.displayPage?.revision).toBe("revision-2"),
    );
    // The prompt left the live message list with the boundary flush, so the
    // inspector index has to pick it up from the refreshed projection.
    expect(result.current.messages).toEqual([]);
    expect(
      result.current.displayQuestions.map((question) => ({
        id: question.id,
        text: question.text,
      })),
    ).toEqual([
      { id: "user-1", text: "First question" },
      { id: "user-2", text: "Second question" },
    ]);
  });

  it("drops buffered Codex tools when display already owns the closing final answer", async () => {
    const session = codexSession("2026-09-01T00:00:01.000Z", []);
    const metadata = deferred<{
      session: Session;
      ownership: { owner: "none" };
    }>();
    mockGetSessionMetadata.mockReturnValue(metadata.promise);
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-final",
      turns: [
        {
          id: "turn:turn-1",
          question: { messageId: "user-1", content: "Run" },
          segments: [
            {
              type: "tool_group",
              id: "group-closed",
              status: "completed",
              count: 1,
              failedCount: 0,
              toolNames: ["Bash"],
              detailRef: "detail-closed",
            },
            {
              type: "assistant_text",
              id: "persisted-final",
              codexCorrelationKey: "codex:turn-1:agent-message:native-final-1",
              phase: "final",
              content: "Done.",
            },
          ],
        },
      ],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );

    act(() => {
      result.current.handleStreamMessageEvent(
        message("replayed-tool", {
          type: "assistant",
          role: "assistant",
          codexTurnId: "turn-1",
          isReplay: true,
          _source: "sdk",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "bash-1",
                name: "Bash",
                input: { command: "echo done" },
              },
            ],
          },
        }),
      );
      result.current.handleStreamMessageEvent(
        message("replayed-result", {
          type: "user",
          role: "user",
          codexTurnId: "turn-1",
          isReplay: true,
          _source: "sdk",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "bash-1",
                content: "ok",
              },
            ],
          },
        }),
      );
      result.current.handleStreamMessageEvent(
        message("replayed-final", {
          type: "assistant",
          role: "assistant",
          codexTurnId: "turn-1",
          codexCorrelationKey: "codex:turn-1:agent-message:native-final-1",
          codexMessagePhase: "final_answer",
          isReplay: true,
          _source: "sdk",
          message: { role: "assistant", content: "Done." },
        }),
      );
    });

    metadata.resolve({ session, ownership: { owner: "none" } });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.displayPage?.revision).toBe("revision-final");
    expect(result.current.messages).toEqual([]);

    act(() => {
      result.current.handleStreamMessageEvent(
        message("late-replayed-tool", {
          type: "assistant",
          role: "assistant",
          codexTurnId: "turn-1",
          isReplay: true,
          _source: "sdk",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "bash-late",
                name: "Bash",
                input: { command: "echo stale" },
              },
            ],
          },
        }),
      );
    });
    expect(result.current.messages).toEqual([]);

    act(() => {
      result.current.handleStreamMessageEvent(
        message("next-turn-tool", {
          type: "assistant",
          role: "assistant",
          codexTurnId: "turn-2",
          isReplay: true,
          _source: "sdk",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "bash-next",
                name: "Bash",
                input: { command: "echo current" },
              },
            ],
          },
        }),
      );
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "next-turn-tool",
    ]);
  });

  it("refreshes display once when live-tail detail is stale", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-1",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Run" },
            segments: [
              {
                type: "tool_group",
                id: "group-1",
                status: "running",
                count: 1,
                failedCount: 0,
                toolNames: ["Bash"],
                detailRef: "detail-1",
                liveTail: true,
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-2",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Run" },
            segments: [
              {
                type: "tool_group",
                id: "group-2",
                status: "running",
                count: 1,
                failedCount: 0,
                toolNames: ["Bash"],
                detailRef: "detail-2",
                liveTail: true,
              },
            ],
          },
        ],
      });
    mockGetSessionToolGroupDetails
      .mockRejectedValueOnce(
        Object.assign(new Error("stale"), {
          code: "SESSION_DISPLAY_STALE",
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-2",
        detailRef: "detail-2",
        messages: [message("live-tail-2")],
      });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );

    await waitFor(() =>
      expect(result.current.hydratedLiveTailDetailRef).toBe("detail-2"),
    );
    expect(mockGetSessionDisplay).toHaveBeenCalledTimes(2);
    expect(mockGetSessionToolGroupDetails).toHaveBeenCalledTimes(2);
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "live-tail-2",
    ]);
  });

  it("keeps external active history lightweight", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", [], {
      ownership: { owner: "external" },
      activity: "in-turn",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay.mockResolvedValue({
      sessionId: "session-1",
      revision: "revision-external",
      turns: [],
    });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetSessionToolGroupDetails).not.toHaveBeenCalled();
    expect(result.current.displayPage?.revision).toBe("revision-external");
    expect(result.current.messages).toEqual([]);
  });

  it("applies a forced display refresh for an owned Pi session", async () => {
    // Pi's live stream cannot replay a tail older than the process buffer, so a
    // settled forced refresh is the only way an owned session converges. The
    // unforced refresh must still be dropped so an in-flight turn keeps its tail.
    const session = codexSession("2026-09-01T00:00:00.000Z", [], {
      provider: "pi",
      ownership: { owner: "self", processId: "process-1" },
      activity: "idle",
    });
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    mockGetSessionDisplay
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-stale",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "First" },
            segments: [],
          },
        ],
      })
      .mockResolvedValue({
        sessionId: "session-1",
        revision: "revision-fresh",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "First" },
            segments: [],
          },
          {
            id: "turn:user-2",
            question: { messageId: "user-2", content: "Written while away" },
            segments: [],
          },
        ],
      });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
        displayHistoryLiveOwned: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.displayPage?.revision).toBe("revision-stale");

    await act(async () => {
      await result.current.refreshSessionMessages();
    });
    expect(result.current.displayPage?.revision).toBe("revision-stale");

    await act(async () => {
      await result.current.refreshSessionMessages({ replaceMessages: true });
    });
    expect(result.current.displayPage?.revision).toBe("revision-fresh");
    expect(result.current.displayPage?.turns.map((turn) => turn.id)).toEqual([
      "turn:user-1",
      "turn:user-2",
    ]);
  });

  it("switches an active legacy session to display history after it settles", async () => {
    const contextUsage = {
      inputTokens: 394_295,
      percentage: 52,
      contextWindow: 760_000,
    };
    const activeSession = codexSession("2026-09-01T00:00:00.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    const settledSession = codexSession("2026-09-01T00:00:01.000Z", [], {
      activity: "idle",
    });
    mockGetSessionMetadata
      .mockResolvedValueOnce({
        session: activeSession,
        ownership: activeSession.ownership,
      })
      .mockResolvedValue({
        session: settledSession,
        ownership: { owner: "none" },
      });
    mockGetSession.mockResolvedValue(
      sessionResponse("2026-09-01T00:00:00.000Z", [message("live-1")], {
        ownership: activeSession.ownership,
        activity: "in-turn",
        contextUsage,
      }),
    );
    mockGetSessionDisplay
      .mockRejectedValueOnce(new Error("active display unavailable"))
      .mockResolvedValue({
        sessionId: "session-1",
        revision: "revision-settled",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Persisted question" },
            segments: [
              {
                type: "tool_group",
                id: "group-1",
                status: "completed",
                count: 2,
                failedCount: 0,
                toolNames: ["Bash"],
                detailRef: "detail-1",
              },
            ],
          },
        ],
      });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });

    const { result, rerender } = renderHook(
      ({ settled }) =>
        useSessionMessages({
          projectId: "project-1",
          sessionId: "session-1",
          preferDisplayHistory: true,
          displayHistoryEligible: settled,
        }),
      { initialProps: { settled: false } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.displayPage).toBeNull();
    expect(result.current.messages.map((item) => item.id)).toEqual(["live-1"]);
    expect(result.current.session?.contextUsage).toEqual(contextUsage);

    rerender({ settled: true });

    await waitFor(() =>
      expect(result.current.displayPage?.revision).toBe("revision-settled"),
    );
    expect(result.current.messages).toEqual([]);
    expect(result.current.session?.contextUsage).toEqual(contextUsage);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockGetSessionDisplay).toHaveBeenCalledTimes(2);
    expect(mockGetSessionMetadata).toHaveBeenCalledTimes(3);

    act(() => {
      result.current.handleStreamMessageEvent(
        message("next-live", { _source: "sdk" }),
      );
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "next-live",
    ]);
  });

  it("abandons the display transition when the session resumes mid-request", async () => {
    const activeSession = codexSession("2026-09-01T00:00:00.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    const settledSession = codexSession("2026-09-01T00:00:01.000Z", [], {
      activity: "idle",
    });
    mockGetSessionMetadata
      .mockResolvedValueOnce({
        session: activeSession,
        ownership: activeSession.ownership,
      })
      .mockResolvedValueOnce({
        session: settledSession,
        ownership: { owner: "none" },
      })
      .mockResolvedValueOnce({
        session: activeSession,
        ownership: activeSession.ownership,
      });
    mockGetSession.mockResolvedValue(
      sessionResponse("2026-09-01T00:00:00.000Z", [message("live-1")], {
        ownership: activeSession.ownership,
        activity: "in-turn",
      }),
    );
    mockGetSessionDisplay
      .mockRejectedValueOnce(new Error("active display unavailable"))
      .mockResolvedValue({
        sessionId: "session-1",
        revision: "revision-not-committed",
        turns: [],
      });

    const { result, rerender } = renderHook(
      ({ settled }) =>
        useSessionMessages({
          projectId: "project-1",
          sessionId: "session-1",
          preferDisplayHistory: true,
          displayHistoryEligible: settled,
        }),
      { initialProps: { settled: false } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ settled: true });
    await waitFor(() =>
      expect(mockGetSessionMetadata).toHaveBeenCalledTimes(3),
    );

    expect(result.current.displayPage).toBeNull();
    expect(result.current.messages.map((item) => item.id)).toEqual(["live-1"]);
  });

  it("keeps legacy messages when the settled display transition fails", async () => {
    const activeSession = codexSession("2026-09-01T00:00:00.000Z", [], {
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    const settledSession = codexSession("2026-09-01T00:00:01.000Z", [], {
      activity: "idle",
    });
    mockGetSessionMetadata
      .mockResolvedValueOnce({
        session: activeSession,
        ownership: activeSession.ownership,
      })
      .mockResolvedValue({
        session: settledSession,
        ownership: { owner: "none" },
      });
    mockGetSession.mockResolvedValue(
      sessionResponse("2026-09-01T00:00:00.000Z", [message("live-1")], {
        ownership: activeSession.ownership,
        activity: "in-turn",
      }),
    );
    mockGetSessionDisplay.mockRejectedValue(new Error("display unavailable"));

    const { result, rerender } = renderHook(
      ({ settled }) =>
        useSessionMessages({
          projectId: "project-1",
          sessionId: "session-1",
          preferDisplayHistory: true,
          displayHistoryEligible: settled,
        }),
      { initialProps: { settled: false } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ settled: true });
    await waitFor(() => expect(mockGetSessionDisplay).toHaveBeenCalledTimes(2));

    expect(result.current.displayPage).toBeNull();
    expect(result.current.messages.map((item) => item.id)).toEqual(["live-1"]);
  });

  it("never auto-switches when display history is explicitly disabled", async () => {
    mockGetSession.mockResolvedValue(
      sessionResponse("2026-09-01T00:00:00.000Z", [message("legacy-1")]),
    );
    const { result, rerender } = renderHook(
      ({ settled }) =>
        useSessionMessages({
          projectId: "project-1",
          sessionId: "session-1",
          preferDisplayHistory: false,
          displayHistoryEligible: settled,
        }),
      { initialProps: { settled: false } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ settled: true });
    await act(async () => Promise.resolve());

    expect(result.current.displayPage).toBeNull();
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "legacy-1",
    ]);
    expect(mockGetSessionMetadata).not.toHaveBeenCalled();
    expect(mockGetSessionDisplay).not.toHaveBeenCalled();
  });

  it("falls back to legacy history when the display API is unavailable", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", []);
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: { owner: "none" },
    });
    mockGetSessionDisplay.mockRejectedValue(new Error("Not found"));
    mockGetSession.mockResolvedValue(
      sessionResponse("2026-09-01T00:00:00.000Z", [message("legacy-1")]),
    );

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(result.current.displayPage).toBeNull();
    expect(result.current.messages.map((item) => item.id)).toEqual([
      "legacy-1",
    ]);
  });

  it("refreshes lightweight history after a live turn becomes idle", async () => {
    const session = codexSession("2026-09-01T00:00:00.000Z", []);
    mockGetSessionMetadata
      .mockResolvedValueOnce({
        session,
        ownership: { owner: "none" },
      })
      .mockResolvedValueOnce({
        session: { ...session, updatedAt: "2026-09-01T00:00:01.000Z" },
        ownership: { owner: "none" },
      });
    mockGetSessionDisplay
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-1",
        turns: [],
      })
      .mockResolvedValueOnce({
        sessionId: "session-1",
        revision: "revision-2",
        turns: [
          {
            id: "turn:user-1",
            question: { messageId: "user-1", content: "Persisted question" },
            segments: [],
          },
        ],
      });
    mockGetSessionQuestions.mockResolvedValue({
      questions: [],
      coverage: "complete",
    });
    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        preferDisplayHistory: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setMessages([message("live-user", { _source: "sdk" })]);
    });
    await act(async () => {
      await result.current.fetchNewMessages();
    });

    expect(mockGetSession).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.displayPage?.revision).toBe("revision-2");
    expect(result.current.displayPage?.turns[0]?.id).toBe("turn:user-1");
  });
});

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

  it("paints a recent session snapshot immediately and revalidates by ID", async () => {
    const firstA = message("a-1", {
      timestamp: "2026-08-22T00:00:01.000Z",
    });
    const secondA = message("a-2", {
      type: "assistant",
      timestamp: "2026-08-22T00:00:02.000Z",
    });
    const firstB = message("b-1", {
      timestamp: "2026-08-22T00:00:03.000Z",
    });
    const revalidateA = deferred<ReturnType<typeof sessionResponse>>();
    mockGetSession
      .mockResolvedValueOnce(
        sessionResponse("2026-08-22T00:00:01.000Z", [firstA], {
          id: "session-a",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse("2026-08-22T00:00:03.000Z", [firstB], {
          id: "session-b",
        }),
      )
      .mockReturnValueOnce(revalidateA.promise);

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useSessionMessages({ projectId: "project-1", sessionId }),
      { initialProps: { sessionId: "session-a" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((item) => item.id)).toEqual(["a-1"]);

    rerender({ sessionId: "session-b" });
    await waitFor(() =>
      expect(result.current.messages.map((item) => item.id)).toEqual(["b-1"]),
    );

    rerender({ sessionId: "session-a" });
    expect(result.current.loading).toBe(false);
    expect(result.current.messages.map((item) => item.id)).toEqual(["a-1"]);
    const cachedFirstMessage = result.current.messages[0];

    await act(async () => {
      revalidateA.resolve(
        sessionResponse("2026-08-22T00:00:02.000Z", [firstA, secondA], {
          id: "session-a",
        }),
      );
      await revalidateA.promise;
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "a-1",
      "a-2",
    ]);
    expect(result.current.messages[0]).toBe(cachedFirstMessage);
  });

  it("keeps the bounded snapshot across a route remount", async () => {
    const firstA = message("a-1", {
      timestamp: "2026-08-22T00:00:01.000Z",
    });
    mockGetSession.mockResolvedValueOnce(
      sessionResponse("2026-08-22T00:00:01.000Z", [firstA], {
        id: "session-a",
      }),
    );
    const firstMount = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-a" }),
    );
    await waitFor(() => expect(firstMount.result.current.loading).toBe(false));
    firstMount.unmount();

    const revalidate = deferred<ReturnType<typeof sessionResponse>>();
    mockGetSession.mockReturnValueOnce(revalidate.promise);
    const secondMount = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-a" }),
    );

    expect(secondMount.result.current.loading).toBe(false);
    expect(secondMount.result.current.messages.map((item) => item.id)).toEqual([
      "a-1",
    ]);

    await act(async () => {
      revalidate.resolve(
        sessionResponse("2026-08-22T00:00:01.000Z", [firstA], {
          id: "session-a",
        }),
      );
      await revalidate.promise;
    });
  });

  it("does not let a late response from another session overwrite a cache hit", async () => {
    const firstA = message("a-1", {
      timestamp: "2026-08-22T00:00:01.000Z",
    });
    const lateB = deferred<ReturnType<typeof sessionResponse>>();
    const revalidateA = deferred<ReturnType<typeof sessionResponse>>();
    mockGetSession
      .mockResolvedValueOnce(
        sessionResponse("2026-08-22T00:00:01.000Z", [firstA], {
          id: "session-a",
        }),
      )
      .mockReturnValueOnce(lateB.promise)
      .mockReturnValueOnce(revalidateA.promise);

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useSessionMessages({ projectId: "project-1", sessionId }),
      { initialProps: { sessionId: "session-a" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ sessionId: "session-b" });
    rerender({ sessionId: "session-a" });
    expect(result.current.loading).toBe(false);
    expect(result.current.messages.map((item) => item.id)).toEqual(["a-1"]);

    await act(async () => {
      lateB.resolve(
        sessionResponse("2026-08-22T00:00:09.000Z", [message("b-late")], {
          id: "session-b",
        }),
      );
      await lateB.promise;
    });
    expect(result.current.messages.map((item) => item.id)).toEqual(["a-1"]);

    await act(async () => {
      revalidateA.resolve(
        sessionResponse("2026-08-22T00:00:02.000Z", [firstA], {
          id: "session-a",
        }),
      );
      await revalidateA.promise;
    });
    expect(result.current.messages.map((item) => item.id)).toEqual(["a-1"]);
  });

  it("applies live Codex usage without rendering a control message", async () => {
    const prompt = message("persisted-prompt", {
      timestamp: "2026-08-14T15:50:09.000Z",
    });
    mockGetSession.mockResolvedValueOnce(
      sessionResponse("2026-08-14T15:50:09.000Z", [prompt]),
    );

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamMessageEvent({
        type: "system",
        subtype: "turn_usage",
        usage: {
          input_tokens: 167_772,
          output_tokens: 1_024,
          cached_input_tokens: 150_000,
          model_context_window: 258_400,
        },
      } as Message);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.contextBefore).toMatchObject({
      inputTokens: 167_772,
      percentage: 65,
      contextWindow: 258_400,
    });
    expect(result.current.session?.contextUsage).toMatchObject({
      inputTokens: 167_772,
      outputTokens: 1_024,
      cacheReadTokens: 150_000,
      percentage: 65,
      contextWindow: 258_400,
    });
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

  it("replaces Pi live UUID copies with the native entry order", async () => {
    const persistedFirst = message("pi-entry-user-1", {
      timestamp: "2026-08-25T01:00:00.000Z",
      message: { role: "user", content: "first" },
    });
    mockGetSession.mockResolvedValueOnce(
      sessionResponse("2026-08-25T01:00:00.000Z", [persistedFirst], {
        provider: "pi",
      }),
    );

    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "project-1", sessionId: "session-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamMessageEvent(
        message("pi-live-user-2", {
          timestamp: "2026-08-25T01:01:00.000Z",
          message: { role: "user", content: "second" },
        }),
      );
      result.current.handleStreamMessageEvent(
        message("pi-live-assistant-2", {
          type: "assistant",
          timestamp: "2026-08-25T01:01:01.000Z",
          message: { role: "assistant", content: "answer" },
        }),
      );
    });

    const persistedSecond = message("pi-entry-user-2", {
      timestamp: "2026-08-25T01:01:00.000Z",
      message: { role: "user", content: "second" },
    });
    const persistedAnswer = message("pi-entry-assistant-2", {
      type: "assistant",
      timestamp: "2026-08-25T01:01:01.000Z",
      message: { role: "assistant", content: "answer" },
    });
    mockGetSession.mockResolvedValueOnce(
      sessionResponse(
        "2026-08-25T01:01:01.000Z",
        [persistedFirst, persistedSecond, persistedAnswer],
        { provider: "pi" },
      ),
    );

    await act(async () => {
      await result.current.fetchNewMessages();
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      "pi-entry-user-1",
      "pi-entry-user-2",
      "pi-entry-assistant-2",
    ]);
  });
});

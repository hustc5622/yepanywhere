import { act, cleanup, renderHook } from "@testing-library/react";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalSessionItem,
  GlobalSessionStats,
  ProjectOption,
} from "../../api/client";
import type {
  SessionCreatedEvent,
  SessionMetadataChangedEvent,
  SessionUpdatedEvent,
} from "../useFileActivity";
import { useGlobalSessions } from "../useGlobalSessions";

const {
  mockGetGlobalSessionStats,
  mockGetGlobalSessions,
  mockGetSessionMetadata,
  mockUseFileActivity,
} = vi.hoisted(() => ({
  mockGetGlobalSessionStats: vi.fn(),
  mockGetGlobalSessions: vi.fn(),
  mockGetSessionMetadata: vi.fn(),
  mockUseFileActivity: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getGlobalSessionStats: mockGetGlobalSessionStats,
    getGlobalSessions: mockGetGlobalSessions,
    getSessionMetadata: mockGetSessionMetadata,
  },
}));

vi.mock("../useFileActivity", () => ({
  useFileActivity: mockUseFileActivity,
}));

const stats: GlobalSessionStats = {
  totalCount: 0,
  unreadCount: 0,
  starredCount: 0,
  archivedCount: 0,
  providerCounts: {},
  executorCounts: {},
};

const projects: ProjectOption[] = [{ id: "project-1", name: "Project 1" }];
const projectId = "project-1" as UrlProjectId;
const projectId2 = "project-2" as UrlProjectId;

const baseSession: GlobalSessionItem = {
  id: "session-1",
  title: null,
  createdAt: "2026-06-22T08:00:00.000Z",
  updatedAt: "2026-06-22T08:00:00.000Z",
  messageCount: 0,
  provider: "codex",
  projectId,
  projectName: "Project 1",
  ownership: { owner: "none" },
  isArchived: false,
  isStarred: false,
};

const baseSessionSummary = {
  ...baseSession,
  projectId,
  fullTitle: null,
  messageCount: baseSession.messageCount ?? 0,
};

function response(sessions: GlobalSessionItem[]) {
  return {
    sessions,
    hasMore: false,
    stats,
    projects,
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useGlobalSessions", () => {
  let activityHandlers: {
    onSessionCreated?: (event: SessionCreatedEvent) => void;
    onSessionMetadataChange?: (event: SessionMetadataChangedEvent) => void;
    onSessionUpdated?: (event: SessionUpdatedEvent) => void;
    onReconnect?: () => void;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetGlobalSessions.mockReset();
    mockGetGlobalSessionStats.mockReset();
    mockGetSessionMetadata.mockReset();
    mockUseFileActivity.mockReset();
    activityHandlers = {};
    mockUseFileActivity.mockImplementation((handlers) => {
      activityHandlers = handlers;
    });
    mockGetGlobalSessions.mockResolvedValue(response([]));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("refetches after an untitled session-created event so the resolved title can appear", async () => {
    const resolvedSession = {
      ...baseSession,
      title: "Resolved session title",
      messageCount: 1,
    };
    mockGetGlobalSessions
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([resolvedSession]));

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    act(() => {
      activityHandlers.onSessionCreated?.({
        type: "session-created",
        session: baseSessionSummary,
        timestamp: "2026-06-22T08:00:00.000Z",
      });
    });

    expect(result.current.sessions[0]?.title).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(2);
    expect(result.current.sessions[0]?.title).toBe("Resolved session title");
  });

  it("cancels pending title refetches when session-updated provides a title", async () => {
    mockGetGlobalSessions.mockResolvedValue(response([]));

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    act(() => {
      activityHandlers.onSessionCreated?.({
        type: "session-created",
        session: baseSessionSummary,
        timestamp: "2026-06-22T08:00:00.000Z",
      });
    });
    act(() => {
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: baseSession.id,
        projectId,
        title: "Title from event",
        messageCount: 1,
        updatedAt: "2026-06-22T08:00:01.000Z",
        timestamp: "2026-06-22T08:00:01.000Z",
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(result.current.sessions[0]?.title).toBe("Title from event");
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing title when session-updated reports a transient null title", async () => {
    const resolvedSession = {
      ...baseSession,
      title: "Existing session title",
      messageCount: 3,
    };
    mockGetGlobalSessions.mockResolvedValue(response([resolvedSession]));

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    act(() => {
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: baseSession.id,
        projectId,
        title: null,
        messageCount: 4,
        updatedAt: "2026-06-22T08:00:01.000Z",
        timestamp: "2026-06-22T08:00:01.000Z",
      });
    });

    expect(result.current.sessions[0]?.title).toBe("Existing session title");
    expect(result.current.sessions[0]?.messageCount).toBe(4);
  });

  it("refreshes only the changed session when aiTitle metadata changes", async () => {
    const existingSession = {
      ...baseSession,
      title: "Verbose first user message",
      messageCount: 2,
    };
    const refreshedSession = {
      ...existingSession,
      aiTitle: "Concise AI Title",
      updatedAt: "2026-06-22T08:00:02.000Z",
    };
    mockGetGlobalSessions.mockResolvedValue(response([existingSession]));
    mockGetSessionMetadata.mockResolvedValue({
      session: refreshedSession,
      ownership: existingSession.ownership,
    });

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    act(() => {
      activityHandlers.onSessionMetadataChange?.({
        type: "session-metadata-changed",
        sessionId: baseSession.id,
        projectId,
        aiTitle: "Concise AI Title",
        timestamp: "2026-06-22T08:00:02.000Z",
      });
    });
    await flushPromises();

    expect(mockGetSessionMetadata).toHaveBeenCalledWith(
      projectId,
      baseSession.id,
    );
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    expect(result.current.sessions[0]?.aiTitle).toBe("Concise AI Title");
    expect(result.current.sessions[0]?.updatedAt).toBe(
      "2026-06-22T08:00:02.000Z",
    );
  });

  it("keeps an existing title when a refetch returns a transient null title", async () => {
    const resolvedSession = {
      ...baseSession,
      title: "Existing session title",
      messageCount: 3,
    };
    const transientUntitledSession = {
      ...baseSession,
      title: null,
      messageCount: 4,
      updatedAt: "2026-06-22T08:00:01.000Z",
    };
    mockGetGlobalSessions
      .mockResolvedValueOnce(response([resolvedSession]))
      .mockResolvedValueOnce(response([transientUntitledSession]));

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));
    await flushPromises();

    await act(async () => {
      await activityHandlers.onReconnect?.();
    });
    await flushPromises();

    expect(result.current.sessions[0]?.title).toBe("Existing session title");
    expect(result.current.sessions[0]?.messageCount).toBe(4);
  });

  it("fetches global stats separately from the sessions list", async () => {
    const globalStats: GlobalSessionStats = {
      totalCount: 7,
      unreadCount: 2,
      starredCount: 1,
      archivedCount: 3,
      providerCounts: { codex: 5, claude: 2 },
      executorCounts: { local: 6, remote: 1 },
    };
    mockGetGlobalSessionStats.mockResolvedValue({ stats: globalStats });
    mockGetGlobalSessions.mockResolvedValue(response([]));

    const { result } = renderHook(() =>
      useGlobalSessions({ includeStats: true, limit: 50 }),
    );
    await flushPromises();

    expect(mockGetGlobalSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includeStats: false }),
    );
    expect(mockGetGlobalSessionStats).toHaveBeenCalledTimes(1);
    expect(result.current.stats).toEqual(globalStats);
  });

  it("requests pinned-session coverage in the same list fetch", async () => {
    renderHook(() => useGlobalSessions({ includePinned: true, limit: 50 }));
    await flushPromises();

    expect(mockGetGlobalSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includePinned: true }),
    );
  });

  it("paginates from the ordinary page boundary before appended pins", async () => {
    const recentSession = {
      ...baseSession,
      id: "recent-session",
      updatedAt: "2026-06-22T08:00:00.000Z",
    };
    const oldPinnedSession = {
      ...baseSession,
      id: "old-pinned-session",
      updatedAt: "2026-05-01T08:00:00.000Z",
      isStarred: true,
    };
    const nextSession = {
      ...baseSession,
      id: "next-session",
      updatedAt: "2026-06-21T08:00:00.000Z",
    };
    mockGetGlobalSessions
      .mockResolvedValueOnce({
        ...response([recentSession, oldPinnedSession]),
        hasMore: true,
        nextCursor: recentSession.updatedAt,
      })
      .mockResolvedValueOnce(response([nextSession]));

    const { result } = renderHook(() =>
      useGlobalSessions({ includePinned: true, limit: 1 }),
    );
    await flushPromises();

    await act(async () => {
      await result.current.loadMore();
    });

    expect(mockGetGlobalSessions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: recentSession.updatedAt }),
    );
    expect(result.current.sessions.map((session) => session.id)).toEqual([
      "recent-session",
      "old-pinned-session",
      "next-session",
    ]);
  });

  it("does not fetch global stats for a project-scoped list", async () => {
    const { result } = renderHook(() =>
      useGlobalSessions({ projectId, includeStats: true, limit: 50 }),
    );
    await flushPromises();

    expect(mockGetGlobalSessions).toHaveBeenCalledWith(
      expect.objectContaining({ project: projectId, includeStats: false }),
    );
    expect(mockGetGlobalSessionStats).not.toHaveBeenCalled();
    expect(result.current.stats).toEqual(stats);
  });

  it("can disable live activity updates while keeping the initial fetch", async () => {
    renderHook(() => useGlobalSessions({ limit: 50, liveUpdates: false }));
    await flushPromises();

    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    expect(mockUseFileActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("can subscribe only to metadata live updates for single-session title changes", async () => {
    const existingSession = {
      ...baseSession,
      title: "Verbose first user message",
      messageCount: 2,
    };
    const refreshedSession = {
      ...existingSession,
      aiTitle: "Concise AI Title",
      updatedAt: "2026-06-22T08:00:02.000Z",
    };
    mockGetGlobalSessions.mockResolvedValue(response([existingSession]));
    mockGetSessionMetadata.mockResolvedValue({
      session: refreshedSession,
      ownership: existingSession.ownership,
    });

    const { result } = renderHook(() =>
      useGlobalSessions({
        limit: 50,
        liveUpdates: false,
        metadataLiveUpdates: true,
      }),
    );
    await flushPromises();

    expect(mockUseFileActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        onSessionCreated: undefined,
        onSessionUpdated: undefined,
        onSessionMetadataChange: expect.any(Function),
      }),
    );

    act(() => {
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: baseSession.id,
        projectId,
        title: "Should not apply",
        messageCount: 3,
        updatedAt: "2026-06-22T08:00:01.000Z",
        timestamp: "2026-06-22T08:00:01.000Z",
      });
    });

    expect(result.current.sessions[0]?.title).toBe(
      "Verbose first user message",
    );

    act(() => {
      activityHandlers.onSessionMetadataChange?.({
        type: "session-metadata-changed",
        sessionId: baseSession.id,
        projectId,
        aiTitle: "Concise AI Title",
        timestamp: "2026-06-22T08:00:02.000Z",
      });
    });
    await flushPromises();

    expect(mockGetSessionMetadata).toHaveBeenCalledWith(
      projectId,
      baseSession.id,
    );
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    expect(result.current.sessions[0]?.aiTitle).toBe("Concise AI Title");
    expect(result.current.sessions[0]?.updatedAt).toBe(
      "2026-06-22T08:00:02.000Z",
    );
  });

  it("uses the latest filters when a pending title refetch fires", async () => {
    const project2Session: GlobalSessionItem = {
      ...baseSession,
      id: "session-2",
      title: "Project 2 session",
      messageCount: 1,
      projectId: projectId2,
      projectName: "Project 2",
    };
    mockGetGlobalSessions.mockImplementation(async (params) =>
      response(params?.project === projectId2 ? [project2Session] : []),
    );

    const { result, rerender } = renderHook(
      ({ currentProjectId }) =>
        useGlobalSessions({ projectId: currentProjectId, limit: 50 }),
      { initialProps: { currentProjectId: projectId } },
    );
    await flushPromises();

    act(() => {
      activityHandlers.onSessionCreated?.({
        type: "session-created",
        session: baseSessionSummary,
        timestamp: "2026-06-22T08:00:00.000Z",
      });
    });

    rerender({ currentProjectId: projectId2 });
    await flushPromises();
    expect(result.current.sessions[0]?.id).toBe("session-2");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(mockGetGlobalSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: projectId2 }),
    );
    expect(result.current.sessions[0]?.id).toBe("session-2");
  });
});

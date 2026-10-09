import { act, cleanup, renderHook } from "@testing-library/react";
import {
  SLASH_COMMAND_SESSION_KIND,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalSessionItem,
  GlobalSessionStats,
  ProjectOption,
} from "../../api/client";
import type {
  ProcessStateEvent,
  SessionCreatedEvent,
  SessionMetadataChangedEvent,
  SessionSeenEvent,
  SessionStatusEvent,
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
    onSessionStatusChange?: (event: SessionStatusEvent) => void;
    onProcessStateChange?: (event: ProcessStateEvent) => void;
    onSessionSeen?: (event: SessionSeenEvent) => void;
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
    mockGetGlobalSessions.mockResolvedValue(response([]));
    mockGetSessionMetadata.mockResolvedValue({
      session: resolvedSession,
      ownership: resolvedSession.ownership,
    });

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

    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    expect(mockGetSessionMetadata).toHaveBeenCalledTimes(1);
    expect(mockGetSessionMetadata).toHaveBeenCalledWith(
      projectId,
      baseSession.id,
    );
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
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

  it("applies repeated sidebar updates without fetching the whole list", async () => {
    const first = { ...baseSession, title: "First", messageCount: 1 };
    const second = { ...first, id: "session-2", title: "Second" };
    mockGetGlobalSessions.mockResolvedValue(response([first, second]));
    const { result } = renderHook(() =>
      useGlobalSessions({
        excludeSessionKind: SLASH_COMMAND_SESSION_KIND,
        includePinned: true,
        limit: 50,
      }),
    );
    await flushPromises();
    const untouched = result.current.sessions[1];

    for (let i = 0; i < 10; i++) {
      act(() =>
        activityHandlers.onSessionUpdated?.({
          type: "session-updated",
          sessionId: first.id,
          projectId,
          messageCount: i + 2,
          timestamp: "2026-06-22T08:00:01.000Z",
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    }

    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    expect(mockGetSessionMetadata).not.toHaveBeenCalled();
    expect(result.current.sessions[0]?.messageCount).toBe(11);
    expect(result.current.sessions[1]).toBe(untouched);
  });

  it("updates ownership, running, approval, completion and read state in place", async () => {
    const first = { ...baseSession, title: "First", hasUnread: true };
    const second = { ...first, id: "session-2" };
    mockGetGlobalSessions.mockResolvedValue(response([first, second]));
    mockGetSessionMetadata.mockResolvedValue({
      session: { ...first, activity: "idle", hasUnread: false },
      ownership: first.ownership,
    });
    const { result } = renderHook(() =>
      useGlobalSessions({ excludeSessionKind: SLASH_COMMAND_SESSION_KIND }),
    );
    await flushPromises();
    const untouched = result.current.sessions[1];
    act(() =>
      activityHandlers.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: first.id,
        projectId,
        ownership: { owner: "self", processId: "process-1" },
        activity: "in-turn",
        timestamp: "now",
      }),
    );
    expect(result.current.sessions[0]?.runtime?.canArchive).toBe(false);
    act(() =>
      activityHandlers.onProcessStateChange?.({
        type: "process-state-changed",
        sessionId: first.id,
        projectId,
        activity: "waiting-input",
        pendingInputType: "tool-approval",
        timestamp: "now",
      }),
    );
    expect(result.current.sessions[0]?.pendingInputType).toBe("tool-approval");
    act(() =>
      activityHandlers.onProcessStateChange?.({
        type: "process-state-changed",
        sessionId: first.id,
        projectId,
        activity: "idle",
        lastTurnStatus: "failed",
        lastErrorMessage: "Test error",
        timestamp: "now",
      }),
    );
    act(() =>
      activityHandlers.onSessionSeen?.({
        type: "session-seen",
        sessionId: first.id,
        timestamp: "now",
      }),
    );
    expect(result.current.sessions[0]).toMatchObject({
      activity: "idle",
      hasUnread: false,
      lastTurnStatus: "failed",
      lastErrorMessage: "Test error",
    });
    expect(result.current.sessions[0]?.pendingInputType).toBeUndefined();
    expect(result.current.sessions[0]?.runtime?.canArchive).toBe(true);
    expect(result.current.sessions[1]).toBe(untouched);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    expect(mockGetSessionMetadata).toHaveBeenCalledTimes(1);
    expect(result.current.sessions[1]).toBe(untouched);
  });

  it.each(["idle", "terminated"] as const)(
    "reconciles only the completed card after %s without a summary event",
    async (activity) => {
      const running = {
        ...baseSession,
        title: "Running session",
        messageCount: 1,
        activity: "in-turn" as const,
      };
      const other = { ...running, id: "session-2" };
      const completed = {
        ...running,
        activity,
        updatedAt: "2026-06-22T08:06:40.000Z",
        messageCount: 12,
        hasUnread: true,
      };
      mockGetGlobalSessions.mockResolvedValue(response([running, other]));
      mockGetSessionMetadata.mockResolvedValue({
        session: completed,
        ownership: completed.ownership,
      });
      const { result } = renderHook(() => useGlobalSessions());
      await flushPromises();
      const untouched = result.current.sessions[1];
      act(() => {
        for (let i = 0; i < 3; i++) {
          activityHandlers.onProcessStateChange?.({
            type: "process-state-changed",
            sessionId: running.id,
            projectId,
            activity,
            timestamp: completed.updatedAt,
          });
        }
      });
      expect(result.current.sessions[0]?.activity).toBe(activity);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(mockGetSessionMetadata).toHaveBeenCalledTimes(1);
      expect(mockGetSessionMetadata).toHaveBeenCalledWith(
        projectId,
        running.id,
      );
      expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
      expect(result.current.sessions[0]).toMatchObject(completed);
      expect(result.current.sessions[1]).toBe(untouched);
    },
  );

  it("reconciles a released session when its terminal process event was missed", async () => {
    const running = {
      ...baseSession,
      title: "Running",
      activity: "in-turn" as const,
    };
    mockGetGlobalSessions.mockResolvedValue(response([running]));
    mockGetSessionMetadata.mockResolvedValue({
      session: {
        ...running,
        activity: "idle",
        updatedAt: "2026-06-22T08:06:40.000Z",
      },
      ownership: { owner: "none" },
    });
    const { result } = renderHook(() => useGlobalSessions());
    await flushPromises();
    act(() =>
      activityHandlers.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: running.id,
        projectId,
        ownership: { owner: "none" },
        timestamp: "2026-06-22T08:06:40.000Z",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.sessions[0]).toMatchObject({
      activity: "idle",
      updatedAt: "2026-06-22T08:06:40.000Z",
    });
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
  });

  it("hydrates only an unknown session and coalesces its event burst", async () => {
    mockGetGlobalSessions.mockResolvedValue(response([]));
    mockGetSessionMetadata.mockResolvedValue({
      session: {
        ...baseSession,
        title: "Resumed old session",
        activity: "in-turn",
        lastTurnStatus: "completed",
      },
      ownership: baseSession.ownership,
    });
    const { result } = renderHook(() =>
      useGlobalSessions({ excludeSessionKind: SLASH_COMMAND_SESSION_KIND }),
    );
    await flushPromises();
    act(() => {
      for (let i = 0; i < 20; i++)
        activityHandlers.onSessionUpdated?.({
          type: "session-updated",
          sessionId: baseSession.id,
          projectId,
          timestamp: "now",
        });
      activityHandlers.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: baseSession.id,
        projectId,
        ownership: baseSession.ownership,
        timestamp: "now",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockGetSessionMetadata).toHaveBeenCalledTimes(1);
    expect(mockGetSessionMetadata).toHaveBeenCalledWith(
      projectId,
      baseSession.id,
    );
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    expect(result.current.sessions[0]).toMatchObject({
      title: "Resumed old session",
      projectName: "Project 1",
      lastTurnStatus: "completed",
    });
  });

  it("removes newly excluded sessions and can restore them with a targeted lookup", async () => {
    const session = {
      ...baseSession,
      title: "Normal conversation",
      messageCount: 1,
    };
    mockGetGlobalSessions.mockResolvedValue(response([session]));
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    const { result } = renderHook(() =>
      useGlobalSessions({ excludeSessionKind: SLASH_COMMAND_SESSION_KIND }),
    );
    await flushPromises();
    act(() =>
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: session.id,
        projectId,
        title: "/help",
        timestamp: "now",
      }),
    );
    expect(result.current.sessions).toHaveLength(0);
    act(() =>
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: session.id,
        projectId,
        title: session.title,
        timestamp: "now",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.sessions[0]?.title).toBe(session.title);
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
  });

  it("applies pin/archive changes and restores an unarchived card without a list fetch", async () => {
    const session = {
      ...baseSession,
      title: "Normal conversation",
      messageCount: 1,
    };
    mockGetGlobalSessions.mockResolvedValue(response([session]));
    mockGetSessionMetadata.mockResolvedValue({
      session,
      ownership: session.ownership,
    });
    const { result } = renderHook(() =>
      useGlobalSessions({ includePinned: true }),
    );
    await flushPromises();
    act(() =>
      activityHandlers.onSessionMetadataChange?.({
        type: "session-metadata-changed",
        sessionId: session.id,
        projectId,
        pinned: true,
        timestamp: "now",
      }),
    );
    expect(result.current.sessions[0]?.isStarred).toBe(true);
    act(() =>
      activityHandlers.onSessionMetadataChange?.({
        type: "session-metadata-changed",
        sessionId: session.id,
        projectId,
        archived: true,
        timestamp: "now",
      }),
    );
    expect(result.current.sessions).toHaveLength(0);
    act(() =>
      activityHandlers.onSessionMetadataChange?.({
        type: "session-metadata-changed",
        sessionId: session.id,
        projectId,
        archived: false,
        timestamp: "now",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.sessions[0]?.id).toBe(session.id);
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    expect(mockGetSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("keeps archived and excluded sessions out of targeted results", async () => {
    const { result } = renderHook(() =>
      useGlobalSessions({ excludeSessionKind: SLASH_COMMAND_SESSION_KIND }),
    );
    await flushPromises();
    for (const session of [
      { ...baseSession, isArchived: true },
      { ...baseSession, title: "/help" },
    ]) {
      mockGetSessionMetadata.mockResolvedValue({
        session,
        ownership: session.ownership,
      });
      act(() =>
        activityHandlers.onSessionUpdated?.({
          type: "session-updated",
          sessionId: session.id,
          projectId,
          timestamp: "now",
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(result.current.sessions).toHaveLength(0);
    }
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
  });

  it("does not roll live state back when a metadata response arrives late", async () => {
    const session = {
      ...baseSession,
      title: "Existing",
      messageCount: 1,
      hasUnread: true,
    };
    let resolveMetadata!: (value: unknown) => void;
    mockGetGlobalSessions.mockResolvedValue(response([session]));
    mockGetSessionMetadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    const { result } = renderHook(() => useGlobalSessions());
    await flushPromises();
    act(() =>
      activityHandlers.onSessionMetadataChange?.({
        type: "session-metadata-changed",
        sessionId: session.id,
        projectId,
        aiTitle: "Fresh title",
        timestamp: "now",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    act(() => {
      activityHandlers.onProcessStateChange?.({
        type: "process-state-changed",
        sessionId: session.id,
        projectId,
        activity: "in-turn",
        timestamp: "now",
      });
      activityHandlers.onSessionSeen?.({
        type: "session-seen",
        sessionId: session.id,
        timestamp: "now",
      });
    });
    await act(async () => {
      resolveMetadata({ session, ownership: session.ownership });
    });
    expect(result.current.sessions[0]).toMatchObject({
      aiTitle: "Fresh title",
      activity: "in-turn",
      hasUnread: false,
    });
    mockGetSessionMetadata.mockResolvedValue({
      session: {
        ...session,
        aiTitle: "Fresh title",
        activity: "in-turn",
        hasUnread: false,
      },
      ownership: session.ownership,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockGetSessionMetadata).toHaveBeenCalledTimes(2);
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed single lookup local and retries on a later event", async () => {
    mockGetSessionMetadata.mockRejectedValueOnce(new Error("Unavailable"));
    const { result } = renderHook(() => useGlobalSessions());
    await flushPromises();
    const event: SessionUpdatedEvent = {
      type: "session-updated",
      sessionId: baseSession.id,
      projectId,
      timestamp: "now",
    };
    act(() => activityHandlers.onSessionUpdated?.(event));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(1);
    mockGetSessionMetadata.mockResolvedValue({
      session: { ...baseSession, title: "Recovered" },
      ownership: baseSession.ownership,
    });
    act(() => activityHandlers.onSessionUpdated?.(event));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.sessions[0]?.title).toBe("Recovered");
    expect(mockGetSessionMetadata).toHaveBeenCalledTimes(2);
  });

  it("cancels queued and in-flight metadata refreshes when hidden", async () => {
    let resolveMetadata!: (value: unknown) => void;
    mockGetSessionMetadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ enabled }) => useGlobalSessions({ enabled }),
      { initialProps: { enabled: true } },
    );
    await flushPromises();
    act(() =>
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: baseSession.id,
        projectId,
        timestamp: "now",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    act(() =>
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: "session-2",
        projectId,
        timestamp: "now",
      }),
    );
    rerender({ enabled: false });
    await act(async () => {
      resolveMetadata({
        session: baseSession,
        ownership: baseSession.ownership,
      });
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(mockGetSessionMetadata).toHaveBeenCalledTimes(1);
    expect(result.current.sessions).toHaveLength(0);
  });

  it("keeps server-side search filtering when a session changes", async () => {
    const { result } = renderHook(() =>
      useGlobalSessions({ searchQuery: "needle" }),
    );
    await flushPromises();
    act(() =>
      activityHandlers.onSessionUpdated?.({
        type: "session-updated",
        sessionId: baseSession.id,
        projectId,
        title: "Other title",
        timestamp: "now",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(2);
    expect(mockGetGlobalSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "needle" }),
    );
    expect(mockGetSessionMetadata).not.toHaveBeenCalled();
    expect(result.current.sessions).toHaveLength(0);
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
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

  it("cancels pending title refreshes when the project filter changes", async () => {
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

    expect(mockGetGlobalSessions).toHaveBeenCalledTimes(2);
    expect(mockGetSessionMetadata).not.toHaveBeenCalled();
    expect(mockGetGlobalSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: projectId2 }),
    );
    expect(result.current.sessions[0]?.id).toBe("session-2");
  });
});

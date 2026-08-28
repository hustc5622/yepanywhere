import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionMetadata } from "../../types";
import { useSessionMessages } from "../useSessionMessages";

const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { getSession },
}));

const session: BrowserSessionMetadata = {
  id: "session-1",
  projectId: "project-1" as BrowserSessionMetadata["projectId"],
  title: "Reliable session",
  fullTitle: "Reliable session",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  messageCount: 0,
  ownership: { owner: "none" },
  provider: "codex",
};

const sessionResponse = {
  session,
  messages: [],
  ownership: { owner: "none" as const },
};

describe("useSessionMessages initial-load reliability", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("retries a failed initial snapshot load and becomes ready", async () => {
    const onLoadComplete = vi.fn();
    const onLoadError = vi.fn();
    getSession
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(sessionResponse);

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
        onLoadComplete,
        onLoadError,
      }),
    );

    await waitFor(() => expect(onLoadError).toHaveBeenCalledTimes(1));

    act(() => result.current.retryInitialLoad());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(onLoadComplete).toHaveBeenCalledWith(
      expect.objectContaining({ session: sessionResponse.session }),
    );
    expect(result.current.session).toBe(sessionResponse.session);
  });

  it("starts a fresh load when the session key changes after failure", async () => {
    const onLoadComplete = vi.fn();
    const onLoadError = vi.fn();
    const nextSession = {
      ...session,
      id: "session-2",
      title: "Next session",
      fullTitle: "Next session",
    };
    getSession.mockRejectedValueOnce("offline").mockResolvedValueOnce({
      ...sessionResponse,
      session: nextSession,
    });

    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useSessionMessages({
          projectId: "project-1",
          sessionId,
          onLoadComplete,
          onLoadError,
        }),
      { initialProps: { sessionId: "session-1" } },
    );

    await waitFor(() =>
      expect(onLoadError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "offline" }),
      ),
    );

    rerender({ sessionId: "session-2" });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getSession).toHaveBeenLastCalledWith(
      "project-1",
      "session-2",
      undefined,
      expect.objectContaining({ maxMessages: 100 }),
    );
    expect(result.current.session).toBe(nextSession);
  });

  it("aborts the previous snapshot request when the session changes", async () => {
    let firstRequestSignal: AbortSignal | undefined;
    getSession
      .mockImplementationOnce(
        (
          _projectId: string,
          _sessionId: string,
          _afterMessageId: string | undefined,
          options: { signal?: AbortSignal },
        ) => {
          firstRequestSignal = options.signal;
          return new Promise(() => {});
        },
      )
      .mockResolvedValueOnce({
        ...sessionResponse,
        session: { ...session, id: "session-2" },
      });

    const { rerender } = renderHook(
      ({ sessionId }) =>
        useSessionMessages({ projectId: "project-1", sessionId }),
      { initialProps: { sessionId: "session-1" } },
    );

    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    expect(firstRequestSignal?.aborted).toBe(false);

    rerender({ sessionId: "session-2" });

    await waitFor(() => expect(firstRequestSignal?.aborted).toBe(true));
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
  });
});

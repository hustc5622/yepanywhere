import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, fetchJSON, isQueuedResumeSessionResponse } from "./client";

describe("api.updateServerSettings", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        settings: {
          serviceWorkerEnabled: true,
        },
      }),
    } as Response);

    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes undefined setting values as null so clears reach the server", async () => {
    await api.updateServerSettings({
      globalInstructions: undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.body).toBe(JSON.stringify({ globalInstructions: null }));
  });
});

describe("fetchJSON errors", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("preserves structured archive block details", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      json: async () => ({
        error: "This session is waiting for input.",
        code: "waiting_input",
        runtime: {
          ownership: { owner: "self", processId: "proc-1" },
          activity: "waiting-input",
          isBusy: true,
          hasResidentWorker: false,
          canArchive: false,
          archiveBlockCode: "waiting_input",
          archiveBlockReason: "This session is waiting for input.",
        },
      }),
    } as Response);

    await expect(
      fetchJSON("/sessions/session-1/metadata"),
    ).rejects.toMatchObject({
      message: "This session is waiting for input.",
      status: 409,
      code: "waiting_input",
      runtime: {
        canArchive: false,
        activity: "waiting-input",
      },
    });
  });
});

describe("queued session API responses", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("preserves the server's queued response instead of treating it as a started process", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        queued: true,
        queueId: "queue-1",
        position: 2,
      }),
    } as Response);

    const result = await api.resumeSession(
      "project-1",
      "session-1",
      "continue",
    );

    expect(isQueuedResumeSessionResponse(result)).toBe(true);
    expect(result).toEqual({
      queued: true,
      queueId: "queue-1",
      position: 2,
    });
  });

  it("distinguishes a started process from a queued response", () => {
    expect(
      isQueuedResumeSessionResponse({
        sessionId: "session-1",
        processId: "process-1",
        permissionMode: "default",
        modeVersion: 1,
      }),
    ).toBe(false);
  });

  it.each([
    [
      "startSession",
      () => api.startSession("project-1", "start"),
      "/api/projects/project-1/sessions",
    ],
    [
      "createSession",
      () => api.createSession("project-1"),
      "/api/projects/project-1/sessions/create",
    ],
  ] as const)(
    "preserves a queued response from %s",
    async (_name, request, expectedPath) => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 202,
        json: async () => ({
          queued: true,
          queueId: "queue-new",
          position: 3,
        }),
      } as Response);

      await expect(request()).resolves.toEqual({
        queued: true,
        queueId: "queue-new",
        position: 3,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expectedPath,
        expect.objectContaining({ method: "POST" }),
      );
    },
  );

  it("cancels a queued request through the queue endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ cancelled: true }),
    } as Response);

    await expect(api.cancelQueuedRequest("queue/1")).resolves.toEqual({
      cancelled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/queue/queue%2F1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("Codex transcript export", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("downloads the authenticated canonical Markdown transcript", async () => {
    const blob = new Blob(["# Transcript\n"], { type: "text/markdown" });
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers({
        "Content-Disposition":
          'attachment; filename="codex-transcript-session-1.md"',
      }),
      blob: async () => blob,
    } as Response);

    await expect(
      api.downloadCodexTranscript("session/1"),
    ).resolves.toMatchObject({
      blob,
      fileName: "codex-transcript-session-1.md",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session%2F1/codex-transcript?format=markdown",
      expect.objectContaining({
        cache: "no-store",
        credentials: "include",
        headers: expect.objectContaining({ "X-Yep-Anywhere": "true" }),
      }),
    );
  });
});

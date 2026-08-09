import type { InteractionOperation } from "@yep-anywhere/shared";
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

  it("preserves the authoritative operation returned by a CAS conflict", async () => {
    const operation: InteractionOperation = {
      operationId: "operation-1",
      provider: "codex",
      requestId: "request-1",
      requestMethod: "item/commandExecution/requestApproval",
      sessionId: "session-1",
      kind: "command_approval",
      state: "resolved",
      publicPayload: { prompt: "Allow command?" },
      allowedActors: { mode: "any_member" },
      allowedDecisions: [{ id: "accept", label: "Allow" }],
      createdAt: 1,
      resolution: { decision: "accept", resolvedAt: 2 },
      version: 5,
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      json: async () => ({
        error: "Interaction changed",
        operation,
      }),
    } as Response);

    await expect(fetchJSON("/sessions/session-1/input")).rejects.toMatchObject({
      message: "Interaction changed",
      status: 409,
      operation,
    });
  });
});

describe("interaction response API", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const operation: InteractionOperation = {
    operationId: "operation-1",
    provider: "codex",
    requestId: "request-1",
    requestMethod: "item/commandExecution/requestApproval",
    sessionId: "session-1",
    kind: "command_approval",
    state: "open",
    publicPayload: { prompt: "Allow command?" },
    allowedActors: { mode: "any_member" },
    allowedDecisions: [{ id: "accept", label: "Allow" }],
    createdAt: 1,
    version: 4,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("submits only the CAS identity and authenticated actor projection", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true }),
    } as Response);

    await api.respondToInput(
      "session-1",
      "request-1",
      "approve",
      undefined,
      undefined,
      operation,
    );

    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body))).toEqual({
      requestId: "request-1",
      response: "approve",
      operationId: "operation-1",
      operationVersion: 4,
      actor: { id: "yep-authenticated-user", channel: "yep" },
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

describe("generated artifact download", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("downloads only an authenticated server-managed artifact route", async () => {
    const blob = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      blob: async () => blob,
    } as Response);
    const downloadUrl = `/api/projects/project-1/sessions/session-1/generated-artifact/ga_${"a".repeat(32)}/${"b".repeat(64)}/report.pdf`;

    await expect(api.downloadGeneratedArtifact(downloadUrl)).resolves.toEqual({
      blob,
      fileName: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      downloadUrl,
      expect.objectContaining({
        cache: "no-store",
        credentials: "include",
        headers: expect.objectContaining({ "X-Yep-Anywhere": "true" }),
      }),
    );
  });

  it.each([
    "https://attacker.example/artifact",
    "/api/projects/project-1/sessions/session-1/upload/../../secret",
    "/api/projects/project-1/sessions/session-1/files/report.pdf",
  ])("rejects an unmanaged artifact URL before fetching: %s", async (url) => {
    await expect(api.downloadGeneratedArtifact(url)).rejects.toThrow(
      "Invalid generated artifact URL",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Codex structured input API", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const skillInput = {
    type: "skill" as const,
    name: "release-check",
    path: "/test-fixtures/skills/release-check/SKILL.md",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("serializes selected skills for start, resume, queue, and deferred queue", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionId: "session-1",
        processId: "process-1",
        permissionMode: "default",
        modeVersion: 1,
        queued: true,
      }),
    } as Response);

    await api.startSession("project-1", "start", {
      provider: "codex",
      codexInputs: [skillInput],
    });
    await api.resumeSession("project-1", "session-1", "resume", {
      provider: "codex",
      codexInputs: [skillInput],
    });
    await api.queueMessage(
      "session-1",
      "queue",
      undefined,
      undefined,
      "temp-queue",
      undefined,
      undefined,
      undefined,
      [skillInput],
    );
    await api.queueMessage(
      "session-1",
      "defer",
      undefined,
      undefined,
      "temp-defer",
      undefined,
      undefined,
      true,
      [skillInput],
    );

    const bodies = fetchMock.mock.calls.map(([, request]) =>
      JSON.parse(String(request?.body)),
    );
    expect(bodies).toEqual([
      expect.objectContaining({
        message: "start",
        codexInputs: [skillInput],
      }),
      expect.objectContaining({
        message: "resume",
        codexInputs: [skillInput],
      }),
      expect.objectContaining({
        message: "queue",
        codexInputs: [skillInput],
      }),
      expect.objectContaining({
        message: "defer",
        deferred: true,
        codexInputs: [skillInput],
      }),
    ]);
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

describe("Codex native controls", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("uses the authenticated bounded control endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ control: "skills/list", data: { data: [] } }),
    } as Response);

    await api.executeCodexControl("session/1", { control: "skills/list" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session%2F1/codex-control",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ control: "skills/list" }),
      }),
    );
  });
});

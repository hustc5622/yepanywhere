import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SideConversationResponse } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { RuntimeController } from "../../src/runtime/types.js";
import { SessionCommandService } from "../../src/services/SessionCommandService.js";
import type { PiSessionReader } from "../../src/sessions/pi-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";

const NOT_READY: SideConversationResponse = {
  supported: false,
  reason: "not_ready",
};
const CREATE = {
  action: "create" as const,
  requestId: "side-request",
  context: "snapshot" as const,
};

describe("side conversation parent restore", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  function setup(provider = "pi") {
    const projectPath = mkdtempSync(join(tmpdir(), "side-restore-"));
    roots.push(projectPath);
    const projectId = encodeProjectId(projectPath);
    const process = {
      id: "main-process",
      sessionId: "main",
      provider,
      permissionMode: "bypassPermissions",
      modeVersion: 1,
    };
    const created: SideConversationResponse = {
      supported: true,
      capabilities: { images: true },
      conversation: {
        id: "side",
        parentSessionId: "main",
        context: "snapshot",
        capturedAt: new Date(0).toISOString(),
        status: "idle",
        version: 1,
        messages: [],
      },
    };
    const sideConversation = vi.fn(
      async (): Promise<SideConversationResponse> => NOT_READY,
    );
    const resumeSession = vi.fn(async () => {
      sideConversation.mockResolvedValue(created);
      return process;
    });
    const getProcessSnapshotForSession = vi.fn(
      async (): Promise<unknown> => null,
    );
    const getSessionSummary = vi.fn(async () => ({
      id: "main",
      provider,
      model: "gateway/original-model",
      reasoningEffort: "high",
    }));
    const service = new SessionCommandService({
      runtimeController: {
        sideConversation,
        resumeSession,
        getProcessSnapshotForSession,
      } as unknown as RuntimeController,
      scanner: {
        getOrCreateProject: async () => ({
          id: projectId,
          path: projectPath,
          sessionDir: join(projectPath, "sessions"),
          provider,
        }),
        mapSessionCwdToLocal: (cwd: string) => cwd,
      } as unknown as ProjectScanner,
      readerFactory: () => ({ getSessionSummary }) as unknown as ISessionReader,
      piReaderFactory: () =>
        ({ getSessionSummary }) as unknown as PiSessionReader,
      sessionInteractionService: {} as SessionInteractionService,
      sessionMetadataService: {
        getPersistedProvider: () => provider,
        getPermissionMode: () => "bypassPermissions",
        getExecutor: () => undefined,
        getLlmGatewayConfig: () => undefined,
        setPermissionMode: vi.fn(),
      } as unknown as SessionMetadataService,
    });
    return {
      service,
      projectId,
      projectPath,
      created,
      sideConversation,
      resumeSession,
      getProcessSnapshotForSession,
      getSessionSummary,
    };
  }

  it("reports an inactive parent as available without starting it on probes", async () => {
    const { service, projectId, resumeSession } = setup();
    await expect(
      service.sideConversation({
        sessionId: "main",
        projectId,
        request: { action: "get" },
        allowRestore: true,
      }),
    ).resolves.toEqual({ supported: true, capabilities: { images: true } });
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("restores the parent without a user turn, keeping its model, then creates", async () => {
    const { service, projectId, projectPath, created, resumeSession } = setup();
    await expect(
      service.sideConversation({
        sessionId: "main",
        projectId,
        request: CREATE,
        allowRestore: true,
      }),
    ).resolves.toEqual(created);
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "main",
        projectPath,
        requireImmediate: true,
        modelSettings: expect.objectContaining({
          providerName: "pi",
          model: "gateway/original-model",
          reasoningEffort: "high",
          // Without this Pi would write thinking "off" into the session.
          thinking: { type: "adaptive" },
        }),
      }),
    );
    expect(resumeSession.mock.calls[0]?.[0]).not.toHaveProperty("message");
  });

  it("keeps a Pi session whose thinking was off turned off", async () => {
    const { service, projectId, resumeSession, getSessionSummary } = setup();
    getSessionSummary.mockResolvedValue({
      id: "main",
      provider: "pi",
      model: "gateway/original-model",
      reasoningEffort: "off",
    });
    await service.sideConversation({
      sessionId: "main",
      projectId,
      request: CREATE,
      allowRestore: true,
    });
    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSettings: expect.objectContaining({
          thinking: { type: "disabled" },
          reasoningEffort: "off",
        }),
      }),
    );
  });

  it.each(["codex", "agy"])("restores %s parents too", async (provider) => {
    const { service, projectId, created, resumeSession } = setup(provider);
    await expect(
      service.sideConversation({
        sessionId: "main",
        projectId,
        request: CREATE,
        allowRestore: true,
      }),
    ).resolves.toEqual(created);
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an externally controlled session", { allowRestore: false }],
    ["a request without its project", { projectId: undefined }],
  ])("never restores %s", async (_label, override) => {
    const { service, projectId, resumeSession } = setup();
    await expect(
      service.sideConversation({
        sessionId: "main",
        projectId,
        request: CREATE,
        allowRestore: true,
        ...override,
      }),
    ).resolves.toEqual(NOT_READY);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("does not replace a parent process that is still starting", async () => {
    const { service, projectId, resumeSession, getProcessSnapshotForSession } =
      setup();
    getProcessSnapshotForSession.mockResolvedValue({ state: "idle" });
    await expect(
      service.sideConversation({
        sessionId: "main",
        projectId,
        request: CREATE,
        allowRestore: true,
      }),
    ).resolves.toEqual(NOT_READY);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("only lets create restore: other actions stay pure controls", async () => {
    const { service, projectId, resumeSession } = setup();
    await expect(
      service.sideConversation({
        sessionId: "main",
        projectId,
        request: { action: "close", id: "side" },
        allowRestore: true,
      }),
    ).resolves.toEqual(NOT_READY);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("leaves providers without side chat untouched", async () => {
    const { service, projectId, resumeSession } = setup("claude");
    await expect(
      service.sideConversation({
        sessionId: "main",
        projectId,
        request: CREATE,
        allowRestore: true,
      }),
    ).resolves.toEqual(NOT_READY);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("surfaces an admission failure without creating anything", async () => {
    const { service, projectId, resumeSession, sideConversation } = setup();
    resumeSession.mockResolvedValue({
      error: "immediate_start_unavailable",
    } as never);
    const result = await service.sideConversation({
      sessionId: "main",
      projectId,
      request: CREATE,
      allowRestore: true,
    });
    expect(result).toMatchObject({ supported: true });
    expect(result.error).toMatch(/could not start/);
    expect(sideConversation).toHaveBeenCalledTimes(1);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { RuntimeController } from "../../src/runtime/types.js";
import { SessionCommandService } from "../../src/services/SessionCommandService.js";
import type { PiSessionReader } from "../../src/sessions/pi-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";

describe("Pi session compaction", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const projectPath = mkdtempSync(join(tmpdir(), "pi-compact-resume-"));
    roots.push(projectPath);
    const projectId = encodeProjectId(projectPath);
    const process = {
      id: "pi-process",
      sessionId: "pi-session",
      provider: "pi",
      permissionMode: "bypassPermissions",
      modeVersion: 2,
    };
    const resumeSession = vi.fn(async () => process);
    const compact = vi.fn(async () => ({ success: true }));
    const getProcessSnapshotForSession = vi.fn(
      async (): Promise<unknown> => null,
    );
    const getSessionSummary = vi.fn(async () => ({
      id: "pi-session",
      provider: "pi",
      model: "gateway/original-model",
      reasoningEffort: "high",
    }));
    const service = new SessionCommandService({
      runtimeController: {
        resumeSession,
        compact,
        getProcessSnapshotForSession,
      } as unknown as RuntimeController,
      scanner: {
        getOrCreateProject: async () => ({
          id: projectId,
          path: projectPath,
          sessionDir: join(projectPath, "sessions"),
          provider: "pi",
        }),
        mapSessionCwdToLocal: (cwd: string) => cwd,
      } as unknown as ProjectScanner,
      readerFactory: () => ({ getSessionSummary }) as unknown as ISessionReader,
      piReaderFactory: () =>
        ({ getSessionSummary }) as unknown as PiSessionReader,
      sessionInteractionService: {} as SessionInteractionService,
      sessionMetadataService: {
        getPersistedProvider: () => "pi",
        getPermissionMode: () => "bypassPermissions",
        getExecutor: () => undefined,
        getLlmGatewayConfig: () => undefined,
        setPermissionMode: vi.fn(),
      } as unknown as SessionMetadataService,
    });
    return {
      service,
      process,
      resumeSession,
      compact,
      getProcessSnapshotForSession,
      getSessionSummary,
      projectPath,
      input: {
        projectId,
        sessionId: "pi-session",
        customInstructions: "keep API decisions",
      },
    };
  }

  it("resumes the original session without a user turn, preserving settings before compacting", async () => {
    const { service, input, resumeSession, compact, projectPath } = setup();
    await expect(service.compactPiSession(input)).resolves.toMatchObject({
      ok: true,
      body: { success: true, sessionId: "pi-session", processId: "pi-process" },
    });
    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "pi-session",
        projectPath,
        permissionMode: "bypassPermissions",
        requireImmediate: true,
        modelSettings: expect.objectContaining({
          providerName: "pi",
          model: "gateway/original-model",
          reasoningEffort: "high",
          thinking: { type: "adaptive" },
        }),
      }),
    );
    expect(resumeSession.mock.calls[0]?.[0]).not.toHaveProperty("message");
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith("pi-process", {
      customInstructions: "keep API decisions",
    });
    expect(resumeSession.mock.invocationCallOrder[0]).toBeLessThan(
      compact.mock.invocationCallOrder[0],
    );
  });

  it.each(["idle", "in-turn"])(
    "reuses a %s process and lets Pi schedule compaction between turns",
    async (state) => {
      const {
        service,
        input,
        process,
        getProcessSnapshotForSession,
        resumeSession,
        compact,
      } = setup();
      getProcessSnapshotForSession.mockResolvedValue({ ...process, state });
      await expect(service.compactPiSession(input)).resolves.toMatchObject({
        ok: true,
      });
      expect(resumeSession).not.toHaveBeenCalled();
      expect(compact).toHaveBeenCalledTimes(1);
      expect(compact).toHaveBeenCalledWith("pi-process", {
        customInstructions: "keep API decisions",
      });
    },
  );

  it("returns admission failure without scheduling a message or compaction", async () => {
    const { service, input, resumeSession, compact } = setup();
    resumeSession.mockResolvedValue({
      error: "immediate_start_unavailable",
    } as never);
    await expect(service.compactPiSession(input)).resolves.toMatchObject({
      ok: false,
      status: 503,
      body: { code: "immediate_start_unavailable" },
    });
    expect(compact).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reports compaction failure after resume (throw=%s)",
    async (throws) => {
      const { service, input, compact } = setup();
      if (throws) compact.mockRejectedValue(new Error("Nothing to compact"));
      else compact.mockResolvedValue({ success: false });
      const result = await service.compactPiSession(input);
      expect(result).toMatchObject({
        ok: false,
        body: { processId: "pi-process", sessionId: "pi-session" },
      });
      if (throws) expect(result.body.error).toBe("Nothing to compact");
    },
  );

  it("rejects another provider before touching its process", async () => {
    const {
      service,
      input,
      process,
      getProcessSnapshotForSession,
      resumeSession,
      compact,
    } = setup();
    getProcessSnapshotForSession.mockResolvedValue({
      ...process,
      provider: "codex",
    });
    await expect(service.compactPiSession(input)).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    expect(resumeSession).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
  });
});

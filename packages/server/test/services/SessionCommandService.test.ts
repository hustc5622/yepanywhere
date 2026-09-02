import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type {
  RuntimeController,
  RuntimeProcessSnapshot,
  RuntimeSessionSubscription,
} from "../../src/runtime/types.js";
import { SessionCommandService } from "../../src/services/SessionCommandService.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

function processSnapshot(
  overrides: Partial<RuntimeProcessSnapshot> = {},
): RuntimeProcessSnapshot {
  return {
    id: "process-1",
    sessionId: "session-1",
    projectId: "project-1",
    projectPath: "/repo/app",
    projectName: "app",
    sessionTitle: null,
    state: "running",
    startedAt: new Date(0).toISOString(),
    queueDepth: 0,
    provider: "codex",
    permissionMode: "default",
    modeVersion: 0,
    pendingInputRequest: null,
    messageHistory: [],
    supportsDynamicModels: false,
    supportsDynamicCommands: false,
    supportsSetModel: false,
    supportsSetPermissionMode: false,
    ...overrides,
  } as RuntimeProcessSnapshot;
}

function interactionService(
  overrides: Partial<SessionInteractionService> = {},
): SessionInteractionService {
  return {
    terminateInteractionOperations: vi.fn(async () => []),
    getPendingInput: vi.fn(async () => null),
    respondToInput: vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: { accepted: true },
    })),
    getInteractionOperation: vi.fn(() => undefined),
    getInteractionOperations: vi.fn(() => []),
    getInteractionBroker: vi.fn(() => ({}) as never),
    ...overrides,
  } as unknown as SessionInteractionService;
}

function createService(
  runtime: Partial<RuntimeController>,
  options: {
    interactions?: SessionInteractionService;
    metadata?: SessionMetadataService;
  } = {},
): SessionCommandService {
  return new SessionCommandService({
    runtimeController: runtime as RuntimeController,
    scanner: {} as ProjectScanner,
    readerFactory: () => ({}) as ISessionReader,
    sessionInteractionService: options.interactions ?? interactionService(),
    sessionMetadataService: options.metadata,
  });
}

describe("SessionCommandService runtime boundary", () => {
  it("starts one native Codex turn and persists lifecycle metadata", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "session-command-start-"));
    try {
      const projectId = encodeProjectId(projectPath);
      const project: Project = {
        id: projectId,
        path: projectPath,
        name: "session-command-start",
        sessionCount: 0,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex",
      };
      const startSession = vi.fn(async () => ({
        id: "process-first",
        sessionId: "thread-first",
        provider: "codex" as const,
        permissionMode: "plan" as const,
        modeVersion: 1,
      }));
      const setProvider = vi.fn(async () => undefined);
      const setCodexMcpMode = vi.fn(async () => undefined);
      const setPermissionMode = vi.fn(async () => undefined);
      const setCreatedBy = vi.fn(async () => undefined);
      const setProjectLocation = vi.fn(async () => undefined);
      const service = new SessionCommandService({
        runtimeController: { startSession } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
          mapSessionCwdToLocal: vi.fn((cwd: string) => cwd),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
        sessionMetadataService: {
          setProvider,
          setCodexMcpMode,
          setPermissionMode,
          setCreatedBy,
          setProjectLocation,
        } as unknown as SessionMetadataService,
      });

      await expect(
        service.start({
          projectId,
          requireImmediate: true,
          body: {
            message: "first native turn",
            provider: "codex",
            mode: "plan",
            codexMcpMode: "standard",
            reasoningEffort: "xhigh",
            tempId: "client-temp-1",
            codexInputs: [
              {
                type: "skill",
                name: "fixture-skill",
                path: "/fixture/SKILL.md",
              },
            ],
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        body: {
          sessionId: "thread-first",
          processId: "process-first",
          permissionMode: "plan",
        },
      });
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath,
          requireImmediate: true,
          permissionMode: "plan",
          message: expect.objectContaining({
            text: "first native turn",
            tempId: "client-temp-1",
            codexInputs: [
              {
                type: "skill",
                name: "fixture-skill",
                path: "/fixture/SKILL.md",
              },
            ],
          }),
          modelSettings: expect.objectContaining({
            providerName: "codex",
            codexMcpMode: "standard",
            reasoningEffort: "xhigh",
          }),
        }),
      );
      expect(setProvider).toHaveBeenCalledWith("thread-first", "codex");
      expect(setCodexMcpMode).toHaveBeenCalledWith("thread-first", "standard");
      expect(setPermissionMode).toHaveBeenCalledWith("thread-first", "plan");
      expect(setCreatedBy).toHaveBeenCalledWith("thread-first", "yep");
      expect(setProjectLocation).toHaveBeenCalledWith(
        "thread-first",
        projectId,
        projectPath,
      );
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("infers the Codex model source that owns a channel-selected model", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "session-command-source-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test-deepseek");
    try {
      const projectId = encodeProjectId(projectPath);
      const project: Project = {
        id: projectId,
        path: projectPath,
        name: "session-command-source",
        sessionCount: 0,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex",
      };
      const startSession = vi.fn(async () => ({
        id: "process-source",
        sessionId: "thread-source",
        provider: "codex" as const,
        permissionMode: "default" as const,
        modeVersion: 1,
      }));
      const service = new SessionCommandService({
        runtimeController: { startSession } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
          mapSessionCwdToLocal: vi.fn((cwd: string) => cwd),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
      });

      await expect(
        service.start({
          projectId,
          requireImmediate: true,
          origin: { createdBy: "channel", originChannel: "feishu" },
          body: {
            message: "channel turn",
            provider: "codex",
            model: "deepseek-v4-flash",
          },
        }),
      ).resolves.toMatchObject({ ok: true, status: 200 });
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          modelSettings: expect.objectContaining({
            model: "deepseek-v4-flash",
            codexModelProvider: "deepseek",
          }),
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("maps immediate create rejection without accepting queue ownership", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "session-command-create-"));
    try {
      const projectId = encodeProjectId(projectPath);
      const project = {
        id: projectId,
        path: projectPath,
        name: "session-command-create",
        sessionCount: 0,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex" as const,
      } satisfies Project;
      const createSession = vi.fn(async () => ({
        error: "immediate_start_unavailable" as const,
      }));
      const service = new SessionCommandService({
        runtimeController: { createSession } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
      });

      await expect(
        service.create({
          projectId,
          requireImmediate: true,
          body: { provider: "codex" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 503,
        body: { code: "immediate_start_unavailable" },
      });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ requireImmediate: true }),
      );
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects explicit creates for the retired OpenCode provider", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "session-command-retired-"));
    try {
      const projectId = encodeProjectId(projectPath);
      const project = {
        id: projectId,
        path: projectPath,
        name: "session-command-retired",
        sessionCount: 0,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex" as const,
      } satisfies Project;
      const createSession = vi.fn(async () =>
        processSnapshot({ provider: "opencode" }),
      );
      const service = new SessionCommandService({
        runtimeController: { createSession } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
      });

      await expect(
        service.create({
          projectId,
          body: { provider: "opencode" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        body: {
          error: "OpenCode provider has been retired",
          code: "provider_retired",
        },
      });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects resume when persisted metadata names the retired provider", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "session-command-legacy-"));
    try {
      const projectId = encodeProjectId(projectPath);
      const project = {
        id: projectId,
        path: projectPath,
        name: "session-command-legacy",
        sessionCount: 0,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex" as const,
      } satisfies Project;
      const resumeSession = vi.fn(async () =>
        processSnapshot({ provider: "opencode" }),
      );
      const service = new SessionCommandService({
        runtimeController: { resumeSession } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
          mapSessionCwdToLocal: vi.fn((cwd: string) => cwd),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
        sessionMetadataService: {
          getProvider: vi.fn(() => "opencode"),
        } as unknown as SessionMetadataService,
      });

      await expect(
        service.resume({
          projectId,
          sessionId: "legacy-opencode-session",
          body: { message: "continue" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        body: {
          error: "OpenCode provider has been retired",
          code: "provider_retired",
        },
      });
      expect(resumeSession).not.toHaveBeenCalled();
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("persists channel origin and scopes Codex rollout by stable account key", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "session-command-channel-"));
    try {
      const projectId = encodeProjectId(projectPath);
      const project = {
        id: projectId,
        path: projectPath,
        name: "session-command-channel",
        sessionCount: 0,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex" as const,
      } satisfies Project;
      const createSession = vi.fn(async () => ({
        id: "process-channel",
        sessionId: "thread-channel",
        provider: "codex" as const,
        permissionMode: "default" as const,
        modeVersion: 0,
      }));
      const setOrigin = vi.fn(async () => undefined);
      const setProjectLocation = vi.fn(async () => undefined);
      const service = new SessionCommandService({
        runtimeController: { createSession } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
        sessionMetadataService: {
          setOrigin,
          setProjectLocation,
          setProvider: vi.fn(async () => undefined),
          setPermissionMode: vi.fn(async () => undefined),
        } as unknown as SessionMetadataService,
      });

      await expect(
        service.create({
          projectId,
          requireImmediate: true,
          origin: {
            createdBy: "channel",
            originChannel: "feishu",
            codexEventAccountId: "account-fixture",
          },
          body: { provider: "codex" },
        }),
      ).resolves.toMatchObject({
        ok: true,
        body: {
          sessionId: "thread-channel",
          processId: "process-channel",
        },
      });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          requireImmediate: true,
          modelSettings: expect.objectContaining({
            providerName: "codex",
            codexEventAccountId: "account-fixture",
          }),
        }),
      );
      expect(setOrigin).toHaveBeenCalledWith("thread-channel", {
        createdBy: "channel",
        originChannel: "feishu",
      });
      expect(setProjectLocation).toHaveBeenCalledWith(
        "thread-channel",
        projectId,
        projectPath,
      );
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("queues native inputs without promoting resolved reasoning effort", async () => {
    const snapshot = processSnapshot({
      permissionMode: "default",
      reasoningEffort: "xhigh",
      requestedReasoningEffort: undefined,
    });
    const queueMessage = vi.fn(async () => ({
      success: true as const,
      process: { id: snapshot.id },
      restarted: false,
    }));
    const setPermissionMode = vi.fn(async () => undefined);
    const service = createService(
      {
        getProcessSnapshotForSession: vi.fn(async () => snapshot),
        queueMessage,
      },
      {
        metadata: {
          getProvider: vi.fn(() => undefined),
          getExecutor: vi.fn(() => undefined),
          setPermissionMode,
        } as unknown as SessionMetadataService,
      },
    );

    await expect(
      service.send({
        projectId: "unused-for-owned-session",
        sessionId: snapshot.sessionId,
        requireImmediate: true,
        allowSteer: false,
        body: {
          message: "$fixture-skill continue",
          codexInputs: [
            {
              type: "skill",
              name: "fixture-skill",
              path: "/fixture/SKILL.md",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      body: {
        queued: true,
        restarted: false,
        processId: snapshot.id,
      },
    });
    expect(queueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: snapshot.sessionId,
        requireImmediate: true,
        allowSteer: false,
        permissionMode: "default",
        message: expect.objectContaining({
          text: "$fixture-skill continue",
          mode: "default",
          codexInputs: [
            {
              type: "skill",
              name: "fixture-skill",
              path: "/fixture/SKILL.md",
            },
          ],
        }),
        modelSettings: expect.objectContaining({
          reasoningEffort: undefined,
        }),
      }),
    );
    expect(setPermissionMode).toHaveBeenCalledWith(
      snapshot.sessionId,
      "default",
    );
  });

  it("deduplicates optimistic temp IDs before runtime queue dispatch", async () => {
    const snapshot = processSnapshot({
      messageHistory: [
        {
          type: "user",
          tempId: "client-temp-existing",
          message: { content: "already accepted" },
        },
      ] as RuntimeProcessSnapshot["messageHistory"],
    });
    const queueMessage = vi.fn();
    const service = createService({
      getProcessSnapshotForSession: vi.fn(async () => snapshot),
      queueMessage,
    });

    await expect(
      service.queue({
        sessionId: snapshot.sessionId,
        body: {
          message: "retry",
          tempId: "client-temp-existing",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      body: {
        queued: true,
        duplicate: true,
        processId: snapshot.id,
      },
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("fails closed when an external send cannot resume immediately", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "session-command-send-"));
    try {
      const projectId = encodeProjectId(projectPath);
      const project = {
        id: projectId,
        path: projectPath,
        name: "session-command-send",
        sessionCount: 1,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex" as const,
      } satisfies Project;
      const resumeSession = vi.fn(async () => ({
        error: "immediate_start_unavailable" as const,
      }));
      const service = new SessionCommandService({
        runtimeController: {
          getProcessSnapshotForSession: vi.fn(async () => null),
          resumeSession,
        } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
          mapSessionCwdToLocal: vi.fn((cwd: string) => cwd),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
      });

      await expect(
        service.send({
          projectId,
          sessionId: "existing-thread",
          requireImmediate: true,
          body: {
            message: "external follow-up",
            provider: "codex",
            reasoningEffort: "high",
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 503,
        body: { code: "immediate_start_unavailable" },
      });
      expect(resumeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "existing-thread",
          requireImmediate: true,
        }),
      );
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("interrupts the active turn and closes interaction aliases", async () => {
    const terminateInteractionOperations = vi.fn(async () => []);
    const interactions = interactionService({
      terminateInteractionOperations,
    });
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const service = createService(
      {
        getProcessSnapshotForSession: vi.fn(async () =>
          processSnapshot({
            pendingInputRequest: {
              id: "request-1",
              sessionId: "canonical-session",
              type: "tool-approval",
              toolName: "shell",
              input: {},
              timestamp: new Date(0).toISOString(),
            },
          }),
        ),
        interruptProcess,
      },
      { interactions },
    );

    await expect(service.interrupt("requested-session")).resolves.toMatchObject(
      {
        ok: true,
        body: {
          interrupted: true,
          supported: true,
          processId: "process-1",
        },
      },
    );
    expect(interruptProcess).toHaveBeenCalledWith("process-1");
    expect(terminateInteractionOperations).toHaveBeenCalledTimes(2);
    expect(terminateInteractionOperations).toHaveBeenCalledWith(
      "requested-session",
      "interrupt",
    );
    expect(terminateInteractionOperations).toHaveBeenCalledWith(
      "canonical-session",
      "interrupt",
    );
  });

  it("reports missing and unsupported processes without aborting them", async () => {
    const missing = createService({
      getProcessSnapshotForSession: vi.fn(async () => null),
    });
    await expect(missing.interrupt("session-1")).resolves.toMatchObject({
      ok: false,
      status: 404,
    });

    const abortProcess = vi.fn();
    const unsupported = createService({
      getProcessSnapshotForSession: vi.fn(async () => processSnapshot()),
      interruptProcess: vi.fn(async () => ({
        success: false,
        supported: false,
      })),
      abortProcess,
    });
    await expect(unsupported.interrupt("session-1")).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    expect(abortProcess).not.toHaveBeenCalled();
  });

  it("releases resident ownership with abort rather than turn interrupt", async () => {
    const abortProcess = vi.fn(async () => ({ aborted: true }));
    const interruptProcess = vi.fn();
    const service = createService({
      getProcessSnapshotForSession: vi.fn(async () =>
        processSnapshot({ state: "idle" }),
      ),
      abortProcess,
      interruptProcess,
    });

    await expect(service.releaseSession("session-1")).resolves.toMatchObject({
      ok: true,
      body: { released: true, hadProcess: true, processId: "process-1" },
    });
    expect(abortProcess).toHaveBeenCalledWith("process-1");
    expect(interruptProcess).not.toHaveBeenCalled();
  });

  it("treats absence as released and rejects a surviving owner", async () => {
    const missing = createService({
      getProcessSnapshotForSession: vi.fn(async () => null),
    });
    await expect(missing.releaseSession("missing")).resolves.toMatchObject({
      ok: true,
      body: { released: true, hadProcess: false },
    });

    const surviving = processSnapshot({ state: "idle" });
    const blocked = createService({
      getProcessSnapshotForSession: vi.fn(async () => surviving),
      abortProcess: vi.fn(async () => ({ aborted: false })),
    });
    await expect(blocked.releaseSession("session-1")).resolves.toMatchObject({
      ok: false,
      status: 409,
      body: { code: "session_release_failed" },
    });
  });

  it("switches only the Codex model source and forks away a failed usage turn", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "fixture-deepseek-key");
    const projectPath = mkdtempSync(join(tmpdir(), "codex-source-failover-"));
    try {
      const projectId = encodeProjectId(projectPath);
      const project: Project = {
        id: projectId,
        path: projectPath,
        name: "codex-source-failover",
        sessionCount: 1,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex",
      };
      const resumeSession = vi
        .fn()
        .mockResolvedValueOnce({
          id: "process-deepseek",
          sessionId: "thread-deepseek-fork",
          provider: "codex" as const,
          permissionMode: "default" as const,
          modeVersion: 1,
        })
        .mockResolvedValueOnce({
          id: "process-openai",
          sessionId: "thread-deepseek-fork",
          provider: "codex" as const,
          permissionMode: "default" as const,
          modeVersion: 2,
        });
      const abortProcess = vi.fn(async () => ({ aborted: true }));
      const setCodexModelProvider = vi.fn(async () => undefined);
      const service = new SessionCommandService({
        runtimeController: {
          getProcessSnapshotForSession: vi.fn(async () =>
            processSnapshot({ state: "idle" }),
          ),
          abortProcess,
          resumeSession,
        } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
          mapSessionCwdToLocal: vi.fn((cwd: string) => cwd),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
        sessionMetadataService: {
          getMetadata: vi.fn(() => undefined),
          getPersistedProvider: vi.fn(() => "codex"),
          getPermissionMode: vi.fn(() => "default"),
          getExecutor: vi.fn(() => undefined),
          getLlmGatewayConfig: vi.fn(() => undefined),
          getCodexMcpMode: vi.fn(() => "standard"),
          getCodexModelProvider: vi.fn(() => "openai"),
          setPermissionMode: vi.fn(async () => undefined),
          setProvider: vi.fn(async () => undefined),
          setCodexMcpMode: vi.fn(async () => undefined),
          setCodexModelProvider,
          setForkParentSessionId: vi.fn(async () => undefined),
          setCreatedBy: vi.fn(async () => undefined),
          setProjectLocation: vi.fn(async () => undefined),
        } as unknown as SessionMetadataService,
      });
      const attachment = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        originalName: "screen.png",
        name: "screen.png",
        path: join(projectPath, "screen.png"),
        size: 10,
        mimeType: "image/png",
      };

      await expect(
        service.switchCodexModelSource({
          projectId,
          sessionId: "thread-openai",
          excludeFailedTurn: true,
          origin: { createdBy: "channel", originChannel: "feishu" },
          body: {
            message: "Inspect this screenshot",
            attachments: [attachment],
            provider: "codex",
            model: "deepseek-v4-flash-vision-exp",
            tempId: "feishu-source-failover",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        body: {
          sessionId: "thread-deepseek-fork",
          processId: "process-deepseek",
          forkParentSessionId: "thread-openai",
        },
      });
      expect(resumeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "thread-openai",
          requireImmediate: true,
          allowMissingRolloutReplacement: true,
          message: expect.objectContaining({ attachments: [attachment] }),
          modelSettings: expect.objectContaining({
            providerName: "codex",
            model: "deepseek-v4-flash-vision-exp",
            codexModelProvider: "deepseek",
            rollbackNumTurns: 1,
          }),
        }),
      );
      expect(setCodexModelProvider).toHaveBeenCalledWith(
        "thread-deepseek-fork",
        "deepseek",
      );

      await expect(
        service.switchCodexModelSource({
          projectId,
          sessionId: "thread-deepseek-fork",
          body: {
            message: "Codex is available again",
            provider: "codex",
            model: "gpt-5.6-sol",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        body: {
          sessionId: "thread-deepseek-fork",
          processId: "process-openai",
        },
      });
      expect(abortProcess).toHaveBeenCalledWith("process-1");
      expect(resumeSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "thread-deepseek-fork",
          message: expect.objectContaining({
            text: "Codex is available again",
          }),
          modelSettings: expect.objectContaining({
            model: "gpt-5.6-sol",
            codexModelProvider: "openai",
          }),
        }),
      );
      expect(
        resumeSession.mock.calls.at(-1)?.[0].modelSettings.rollbackNumTurns,
      ).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("persists live and idle permission modes", async () => {
    const setPermissionModeMetadata = vi.fn(async () => undefined);
    const metadata = {
      setPermissionMode: setPermissionModeMetadata,
    } as unknown as SessionMetadataService;
    const liveRuntimeSet = vi.fn(async () => ({
      ok: true,
      permissionMode: "plan" as const,
      modeVersion: 2,
    }));
    const live = createService(
      { setPermissionMode: liveRuntimeSet },
      { metadata },
    );

    await expect(
      live.setPermissionMode("session-1", "plan"),
    ).resolves.toMatchObject({
      ok: true,
      body: { permissionMode: "plan", modeVersion: 2 },
    });
    expect(setPermissionModeMetadata).toHaveBeenCalledWith("session-1", "plan");

    const idle = createService(
      { setPermissionMode: vi.fn(async () => ({ ok: false })) },
      { metadata },
    );
    await expect(
      idle.setPermissionMode("idle-session", "acceptEdits"),
    ).resolves.toMatchObject({
      ok: true,
      body: { permissionMode: "acceptEdits", modeVersion: 0 },
    });
  });

  it("does not claim idle persistence when metadata is unavailable", async () => {
    const service = createService({
      setPermissionMode: vi.fn(async () => ({ ok: false })),
    });
    await expect(
      service.setPermissionMode("missing", "default"),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("executes typed Codex controls and maps safe failures", async () => {
    const executeCodexControl = vi.fn(async () => ({
      ok: true as const,
      control: "thread/goal/get" as const,
      data: { goal: null },
    }));
    const service = createService({
      getProcessSnapshotForSession: vi.fn(async () => processSnapshot()),
      executeCodexControl,
    });

    await expect(
      service.executeCodexControl({
        sessionId: "session-1",
        request: { control: "thread/goal/get" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      body: { control: "thread/goal/get", data: { goal: null } },
    });

    const blocked = createService({
      getProcessSnapshotForSession: vi.fn(async () => processSnapshot()),
      executeCodexControl: vi.fn(async () => ({
        ok: false as const,
        control: "thread/backgroundTerminals/list" as const,
        error: {
          code: "experimental_api_disabled" as const,
          message: "experimental disabled",
          retryable: false,
        },
      })),
    });
    await expect(
      blocked.executeCodexControl({
        sessionId: "session-1",
        request: { control: "thread/backgroundTerminals/list" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      body: { code: "experimental_api_disabled", retryable: false },
    });
  });

  it("resumes an inactive Codex session without a message before compacting", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "codex-compact-resume-"));
    try {
      const projectId = encodeProjectId(projectPath);
      const project: Project = {
        id: projectId,
        path: projectPath,
        name: "codex-compact-resume",
        sessionCount: 1,
        sessionDir: join(projectPath, "sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex",
      };
      const resumeSession = vi.fn(async () => ({
        id: "process-compact",
        sessionId: "session-compact",
        provider: "codex" as const,
        permissionMode: "default" as const,
        modeVersion: 0,
      }));
      const executeCodexControl = vi.fn(async () => ({
        ok: true as const,
        control: "thread/compact/start" as const,
        data: {},
      }));
      const service = new SessionCommandService({
        runtimeController: {
          getProcessSnapshotForSession: vi.fn(async () => null),
          resumeSession,
          executeCodexControl,
        } as unknown as RuntimeController,
        scanner: {
          getOrCreateProject: vi.fn(async () => project),
          mapSessionCwdToLocal: vi.fn((cwd: string) => cwd),
        } as unknown as ProjectScanner,
        readerFactory: () => ({}) as ISessionReader,
        sessionInteractionService: interactionService(),
        sessionMetadataService: {
          getPersistedProvider: vi.fn(() => "codex"),
          getPermissionMode: vi.fn(() => "default"),
          getExecutor: vi.fn(() => undefined),
          getLlmGatewayConfig: vi.fn(() => undefined),
          getCodexMcpMode: vi.fn(() => undefined),
          getCodexModelProvider: vi.fn(() => "openai"),
          setPermissionMode: vi.fn(async () => undefined),
          setCodexModelProvider: vi.fn(async () => undefined),
        } as unknown as SessionMetadataService,
      });

      await expect(
        service.resumeCodexControl({
          projectId,
          sessionId: "session-compact",
          request: { control: "thread/compact/start" },
          body: {
            mode: "default",
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        body: {
          sessionId: "session-compact",
          processId: "process-compact",
          control: "thread/compact/start",
          data: {},
        },
      });

      expect(resumeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-compact",
          projectPath,
          requireImmediate: true,
          modelSettings: expect.objectContaining({
            providerName: "codex",
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
          }),
        }),
      );
      expect(resumeSession.mock.calls[0]?.[0]).not.toHaveProperty("message");
      expect(executeCodexControl).toHaveBeenCalledWith({
        sessionId: "session-compact",
        request: { control: "thread/compact/start" },
      });
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("reuses a concurrently restored idle Codex process for compaction", async () => {
    const resumeSession = vi.fn();
    const executeCodexControl = vi.fn(async () => ({
      ok: true as const,
      control: "thread/compact/start" as const,
      data: {},
    }));
    const service = createService({
      getProcessSnapshotForSession: vi.fn(async () =>
        processSnapshot({ state: "idle" }),
      ),
      resumeSession,
      executeCodexControl,
    });

    await expect(
      service.resumeCodexControl({
        projectId: "project-1",
        sessionId: "session-1",
        request: { control: "thread/compact/start" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      body: {
        sessionId: "session-1",
        processId: "process-1",
        control: "thread/compact/start",
      },
    });
    expect(resumeSession).not.toHaveBeenCalled();
    expect(executeCodexControl).toHaveBeenCalledTimes(1);
  });

  it("delegates interactions and runtime subscriptions", async () => {
    const getPendingInput = vi.fn(async () => null);
    const respondToInput = vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: { accepted: true },
    }));
    const interactions = interactionService({
      getPendingInput,
      respondToInput,
    });
    const subscription = { unsubscribe: vi.fn() } as RuntimeSessionSubscription;
    const subscribeSession = vi.fn(async () => subscription);
    const service = createService({ subscribeSession }, { interactions });

    await service.getPendingInput("session-1");
    await service.respondToInput("session-1", {
      requestId: "request-1",
      response: "approve",
    });
    const emit = vi.fn();
    await expect(service.subscribe("session-1", emit)).resolves.toBe(
      subscription,
    );

    expect(getPendingInput).toHaveBeenCalledWith("session-1", undefined);
    expect(respondToInput).toHaveBeenCalledWith(
      "session-1",
      {
        requestId: "request-1",
        response: "approve",
      },
      undefined,
    );
    expect(subscribeSession).toHaveBeenCalledWith("session-1", emit, undefined);
  });
});

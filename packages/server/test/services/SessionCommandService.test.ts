import { describe, expect, it, vi } from "vitest";
import type { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import type {
  RuntimeController,
  RuntimeProcessSnapshot,
  RuntimeSessionSubscription,
} from "../../src/runtime/types.js";
import { SessionCommandService } from "../../src/services/SessionCommandService.js";

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
    sessionInteractionService: options.interactions ?? interactionService(),
    sessionMetadataService: options.metadata,
  });
}

describe("SessionCommandService runtime boundary", () => {
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

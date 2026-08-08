import type { InputRequest, UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexBridgeController } from "../../src/codex-bridge/types.js";
import { InteractionBroker } from "../../src/interactions/InteractionBroker.js";
import { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import type { OpenCodeBridgeController } from "../../src/opencode-bridge/types.js";
import type {
  RuntimeController,
  RuntimeProcessSnapshot,
} from "../../src/runtime/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("SessionInteractionService", () => {
  const brokers: InteractionBroker[] = [];
  const services: SessionInteractionService[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    for (const broker of brokers.splice(0)) broker.shutdown();
  });

  it("serializes competing channel claims before invoking a process", async () => {
    const request = makeRequest();
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerResponse = vi.fn(async () => {
      await providerGate;
      return { accepted: true };
    });
    const service = createService(services, brokers, {
      getProcessSnapshotForSession: vi.fn(async () => processSnapshot(request)),
      respondToInput: providerResponse,
    });
    const pending = await service.getPendingInput(request.sessionId);

    const winner = service.respondToInput(request.sessionId, {
      requestId: request.id,
      response: "approve",
      operationId: pending?.interaction?.operationId,
      operationVersion: pending?.interaction?.version,
      actor: { id: "yep-user", channel: "yep" },
    });
    await vi.waitFor(() => expect(providerResponse).toHaveBeenCalledTimes(1));
    const loser = await service.respondToInput(request.sessionId, {
      requestId: request.id,
      response: "deny",
      operationId: pending?.interaction?.operationId,
      operationVersion: pending?.interaction?.version,
      actor: { id: "synthetic-channel-user", channel: "feishu" },
    });
    releaseProvider();

    await expect(winner).resolves.toMatchObject({
      ok: true,
      body: {
        operation: {
          state: "resolved",
          resolvedBy: { id: "yep-user", channel: "yep" },
        },
      },
    });
    expect(loser).toMatchObject({
      ok: false,
      status: 409,
      body: {
        code: "interaction_already_resolved",
        operation: { state: "answering" },
      },
    });
    expect(providerResponse).toHaveBeenCalledTimes(1);
  });

  it("binds and forwards the exact winning claim to a bridge", async () => {
    const request = makeRequest({ source: "codex-bridge" });
    let releaseBridge!: () => void;
    const bridgeGate = new Promise<void>((resolve) => {
      releaseBridge = resolve;
    });
    const bridgeBinding = vi.fn(async () => true);
    const bridgeResponse = vi.fn(async () => {
      await bridgeGate;
      return true;
    });
    const bridge = {
      getPendingInputRequest: vi.fn(async () => request),
      bindPendingInputInteraction: bridgeBinding,
      respondToInput: bridgeResponse,
    } as unknown as CodexBridgeController;
    const service = createService(
      services,
      brokers,
      { getProcessSnapshotForSession: vi.fn(async () => null) },
      { codexBridgeService: bridge },
    );
    const pending = await service.getPendingInput(request.sessionId);

    expect(bridgeBinding).toHaveBeenCalledWith(request.sessionId, request.id, {
      operationId: pending?.interaction?.operationId,
      operationVersion: pending?.interaction?.version,
    });
    const winner = service.respondToInput(request.sessionId, {
      requestId: request.id,
      response: "approve_for_session",
      operationId: pending?.interaction?.operationId,
      operationVersion: pending?.interaction?.version,
      actor: { id: "yep-user", channel: "yep" },
    });
    await vi.waitFor(() => expect(bridgeResponse).toHaveBeenCalledTimes(1));
    const loser = await service.respondToInput(request.sessionId, {
      requestId: request.id,
      response: "deny",
      operationId: pending?.interaction?.operationId,
      operationVersion: pending?.interaction?.version,
      actor: { id: "synthetic-channel-user", channel: "feishu" },
    });
    releaseBridge();

    await expect(winner).resolves.toMatchObject({ ok: true });
    expect(loser).toMatchObject({ ok: false, status: 409 });
    expect(bridgeResponse).toHaveBeenCalledTimes(1);
    expect(bridgeResponse).toHaveBeenCalledWith(
      request.sessionId,
      request.id,
      "approve_for_session",
      undefined,
      {
        operationId: pending?.interaction?.operationId,
        operationVersion: (pending?.interaction?.version ?? 0) + 1,
        actor: { id: "yep-user", channel: "yep" },
      },
    );
  });

  it("does not reopen a resolved operation from a stale provider snapshot", async () => {
    const request = makeRequest();
    const providerResponse = vi.fn(async () => ({ accepted: true }));
    const service = createService(services, brokers, {
      getProcessSnapshotForSession: vi.fn(async () => processSnapshot(request)),
      respondToInput: providerResponse,
    });
    const pending = await service.getPendingInput(request.sessionId);
    await expect(
      service.respondToInput(request.sessionId, {
        requestId: request.id,
        response: "approve",
        operationId: pending?.interaction?.operationId,
        operationVersion: pending?.interaction?.version,
        actor: { id: "yep-user", channel: "yep" },
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      service.respondToInput(request.sessionId, {
        requestId: request.id,
        response: "deny",
        actor: { id: "legacy-channel-user", channel: "feishu" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      body: {
        code: "interaction_already_resolved",
        operation: { state: "resolved", version: 2 },
      },
    });
    expect(providerResponse).toHaveBeenCalledTimes(1);
    expect(service.getInteractionOperations(request.sessionId)).toHaveLength(1);
  });

  it("revalidates concurrent queue-head observations before superseding", async () => {
    const requestA = makeRequest({ id: "request-a" });
    const requestB = makeRequest({
      id: "request-b",
      timestamp: new Date(Date.now() + 1).toISOString(),
    });
    let current = requestA;
    let releaseRevalidation!: () => void;
    const revalidationGate = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    let snapshotReadCount = 0;
    const getProcessSnapshotForSession = vi.fn(async () => {
      snapshotReadCount += 1;
      if (snapshotReadCount === 1) return processSnapshot(requestA);
      if (snapshotReadCount === 2) await revalidationGate;
      return processSnapshot(current);
    });
    const service = createService(services, brokers, {
      getProcessSnapshotForSession,
      respondToInput: vi.fn(async () => ({ accepted: true })),
    });

    const staleRead = service.getPendingInput(requestA.sessionId);
    await vi.waitFor(() => expect(snapshotReadCount).toBe(2));
    current = requestB;
    const currentRead = service.getPendingInput(requestB.sessionId);
    releaseRevalidation();

    const [fromStaleRead, fromCurrentRead] = await Promise.all([
      staleRead,
      currentRead,
    ]);
    expect(fromStaleRead?.id).toBe(requestB.id);
    expect(fromCurrentRead?.id).toBe(requestB.id);
    expect(service.getInteractionOperations(requestB.sessionId)).toEqual([
      expect.objectContaining({ requestId: requestB.id, state: "open" }),
    ]);
  });

  it("does not let a stale null observation cancel a newer request", async () => {
    const request = makeRequest({ id: "request-after-empty-snapshot" });
    let releaseEmptySnapshot!: (value: RuntimeProcessSnapshot | null) => void;
    const emptySnapshot = new Promise<RuntimeProcessSnapshot | null>(
      (resolve) => {
        releaseEmptySnapshot = resolve;
      },
    );
    let snapshotReadCount = 0;
    const getProcessSnapshotForSession = vi.fn(async () => {
      snapshotReadCount += 1;
      if (snapshotReadCount === 1) return emptySnapshot;
      return processSnapshot(request);
    });
    const service = createService(services, brokers, {
      getProcessSnapshotForSession,
      respondToInput: vi.fn(async () => ({ accepted: true })),
    });

    const staleEmptyRead = service.getPendingInput(request.sessionId);
    await vi.waitFor(() => expect(snapshotReadCount).toBe(1));
    const currentRead = await service.getPendingInput(request.sessionId);
    expect(currentRead?.id).toBe(request.id);
    releaseEmptySnapshot(null);

    await expect(staleEmptyRead).resolves.toMatchObject({ id: request.id });
    expect(service.getInteractionOperations(request.sessionId)).toEqual([
      expect.objectContaining({ requestId: request.id, state: "open" }),
    ]);
  });

  it("invokes only the bridge controller that supplied the request", async () => {
    const request = makeRequest({ source: "codex-bridge" });
    const codexResponse = vi.fn(async () => false);
    const opencodeResponse = vi.fn(async () => true);
    const codex = {
      getPendingInputRequest: vi.fn(async () => request),
      respondToInput: codexResponse,
    } as unknown as CodexBridgeController;
    const opencode = {
      getPendingInputRequest: vi.fn(async () => ({
        ...request,
        source: "opencode-bridge" as const,
      })),
      respondToInput: opencodeResponse,
    } as unknown as OpenCodeBridgeController;
    const service = createService(
      services,
      brokers,
      { getProcessSnapshotForSession: vi.fn(async () => null) },
      { codexBridgeService: codex, opencodeBridgeService: opencode },
    );
    const pending = await service.getPendingInput(request.sessionId);

    await expect(
      service.respondToInput(request.sessionId, {
        requestId: request.id,
        response: "approve",
        operationId: pending?.interaction?.operationId,
        operationVersion: pending?.interaction?.version,
        actor: { id: "yep-user", channel: "yep" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      body: { code: "interaction_provider_rejected" },
    });
    expect(codexResponse).toHaveBeenCalledTimes(1);
    expect(opencodeResponse).not.toHaveBeenCalled();
  });

  it("terminates operations with the lifecycle's exact reason", async () => {
    const eventBus = new EventBus();
    const service = createService(services, brokers, {}, { eventBus });
    const broker = service.getInteractionBroker();
    const processRequest = makeRequest({ id: "process-exit-request" });
    const externalRequest = makeRequest({
      id: "external-exit-request",
      sessionId: "external-session",
      source: "codex-bridge",
    });
    const interruptedRequest = makeRequest({
      id: "interrupted-request",
      sessionId: "interrupted-session",
    });
    const processOperation = await register(broker, processRequest, "process");
    const externalOperation = await register(broker, externalRequest, "bridge");
    const interruptedOperation = await register(
      broker,
      interruptedRequest,
      "process",
    );
    const common = {
      projectId: "L3JlcG8" as UrlProjectId,
      timestamp: new Date().toISOString(),
    };

    eventBus.emit({
      type: "process-state-changed",
      ...common,
      sessionId: processRequest.sessionId,
      activity: "terminated",
    });
    eventBus.emit({
      type: "session-status-changed",
      ...common,
      sessionId: externalRequest.sessionId,
      ownership: { owner: "none" },
    });
    eventBus.emit({
      type: "session-aborted",
      ...common,
      sessionId: interruptedRequest.sessionId,
    });

    await vi.waitFor(() => {
      expect(broker.get(processOperation.operationId)).toMatchObject({
        state: "failed",
        resolution: { decision: "process_exit" },
      });
      expect(broker.get(externalOperation.operationId)).toMatchObject({
        state: "failed",
        resolution: { decision: "process_exit" },
      });
      expect(broker.get(interruptedOperation.operationId)).toMatchObject({
        state: "cancelled",
        resolution: { decision: "interrupt" },
      });
    });
  });

  it("re-reads a nonterminal process event without cancelling bridge input", async () => {
    const eventBus = new EventBus();
    const request = makeRequest({ source: "codex-bridge" });
    const bridge = {
      getPendingInputRequest: vi.fn(async () => request),
      respondToInput: vi.fn(async () => true),
    } as unknown as CodexBridgeController;
    const service = createService(
      services,
      brokers,
      { getProcessSnapshotForSession: vi.fn(async () => null) },
      { eventBus, codexBridgeService: bridge },
    );
    const pending = await service.getPendingInput(request.sessionId);

    eventBus.emit({
      type: "process-state-changed",
      sessionId: request.sessionId,
      projectId: "L3JlcG8" as UrlProjectId,
      activity: "running",
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(
        service.getInteractionOperation(
          pending?.interaction?.operationId as string,
        ),
      ).toMatchObject({ state: "open", requestId: request.id });
      expect(bridge.getPendingInputRequest).toHaveBeenCalledTimes(4);
    });
  });

  it("persists acceptEdits after the provider accepts the approval", async () => {
    const request = makeRequest();
    const setPermissionMode = vi.fn(async () => ({
      ok: true,
      permissionMode: "acceptEdits" as const,
      modeVersion: 7,
    }));
    const persistPermissionMode = vi.fn(async () => undefined);
    const service = createService(
      services,
      brokers,
      {
        getProcessSnapshotForSession: vi.fn(async () =>
          processSnapshot(request),
        ),
        respondToInput: vi.fn(async () => ({ accepted: true })),
        setPermissionMode,
      },
      {
        sessionMetadataService: {
          setPermissionMode: persistPermissionMode,
        } as unknown as SessionMetadataService,
      },
    );
    const pending = await service.getPendingInput(request.sessionId);

    await expect(
      service.respondToInput(request.sessionId, {
        requestId: request.id,
        response: "approve_accept_edits",
        operationId: pending?.interaction?.operationId,
        operationVersion: pending?.interaction?.version,
        actor: { id: "yep-user", channel: "yep" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(setPermissionMode).toHaveBeenCalledWith({
      sessionId: request.sessionId,
      mode: "acceptEdits",
    });
    expect(persistPermissionMode).toHaveBeenCalledWith(
      request.sessionId,
      "acceptEdits",
    );
  });
});

function makeRequest(overrides: Partial<InputRequest> = {}): InputRequest {
  return {
    id: "request-1",
    sessionId: "session-1",
    type: "tool-approval",
    prompt: "Allow this command?",
    toolName: "Bash",
    toolInput: { command: "pnpm test", cwd: "/repo/app" },
    timestamp: new Date(0).toISOString(),
    source: "process",
    ...overrides,
  };
}

function processSnapshot(request: InputRequest): RuntimeProcessSnapshot {
  return {
    id: "process-1",
    sessionId: request.sessionId,
    projectId: "project-1",
    projectPath: "/repo/app",
    projectName: "app",
    sessionTitle: null,
    state: "waiting-input",
    startedAt: new Date(0).toISOString(),
    queueDepth: 0,
    provider: "codex",
    permissionMode: "default",
    modeVersion: 0,
    pendingInputRequest: request,
    messageHistory: [],
    supportsDynamicModels: false,
    supportsDynamicCommands: false,
    supportsSetModel: false,
    supportsSetPermissionMode: true,
  } as RuntimeProcessSnapshot;
}

function createService(
  services: SessionInteractionService[],
  brokers: InteractionBroker[],
  runtime: Partial<RuntimeController>,
  options: {
    codexBridgeService?: CodexBridgeController;
    opencodeBridgeService?: OpenCodeBridgeController;
    sessionMetadataService?: SessionMetadataService;
    eventBus?: EventBus;
  } = {},
): SessionInteractionService {
  const broker = new InteractionBroker();
  brokers.push(broker);
  const service = new SessionInteractionService({
    runtimeController: runtime as RuntimeController,
    interactionBroker: broker,
    ...options,
  });
  services.push(service);
  return service;
}

async function register(
  broker: InteractionBroker,
  request: InputRequest,
  owner: "process" | "bridge",
) {
  return broker.register({
    request,
    owner,
    provider: "codex",
    resolveProvider: async () => true,
  });
}

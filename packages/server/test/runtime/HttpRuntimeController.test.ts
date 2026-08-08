import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { EmbeddedRuntimeController } from "../../src/runtime/EmbeddedRuntimeController.js";
import {
  HttpRuntimeController,
  type RuntimeFetch,
} from "../../src/runtime/HttpRuntimeController.js";
import { RuntimeEventStore } from "../../src/runtime/RuntimeEventStore.js";
import { createRuntimeControlApp } from "../../src/runtime/control-server.js";
import type {
  RuntimeController,
  RuntimeSessionEventEmitter,
} from "../../src/runtime/types.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import type {
  AgentProvider,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { EventBus } from "../../src/watcher/EventBus.js";

function createLongRunningProvider(): AgentProvider {
  return {
    name: "codex",
    displayName: "Codex",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: false,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    startSession: vi.fn(async (options: StartSessionOptions) => {
      let aborted = false;
      const sessionId = options.resumeSessionId ?? `http-${Date.now()}`;
      async function* iterator() {
        yield { type: "system", subtype: "init", session_id: sessionId };
        while (!aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        yield { type: "result", session_id: sessionId };
      }
      return {
        iterator: iterator(),
        queue: new MessageQueue(),
        abort: () => {
          aborted = true;
        },
      };
    }),
  };
}

describe("HttpRuntimeController", () => {
  const supervisors: Supervisor[] = [];
  const eventDirs: string[] = [];

  function createHarness(options?: {
    maxWorkers?: number;
    eventStore?: RuntimeEventStore;
  }) {
    const supervisor = new Supervisor({
      provider: createLongRunningProvider(),
      idleTimeoutMs: 100,
      idlePreemptThresholdMs: 60_000,
      maxWorkers: options?.maxWorkers,
    });
    supervisors.push(supervisor);
    const eventBus = new EventBus();
    const embedded = new EmbeddedRuntimeController(
      supervisor,
      eventBus,
      options?.eventStore,
    );
    const app = createRuntimeControlApp({
      controller: embedded,
      token: "runtime-test-token",
    });
    const fetch: RuntimeFetch = (input, init) =>
      app.fetch(input instanceof Request ? input : new Request(input, init));
    const controller = new HttpRuntimeController({
      baseUrl: "http://runtime.test",
      token: "runtime-test-token",
      fetch,
    });
    return { app, controller, embedded, eventBus };
  }

  afterEach(async () => {
    await Promise.all(
      supervisors.splice(0).map(async (supervisor) => {
        await Promise.all(
          supervisor
            .getAllProcesses()
            .map((process) => supervisor.abortProcess(process.id)),
        );
      }),
    );
    await Promise.all(
      eventDirs
        .splice(0)
        .map((eventsDir) => rm(eventsDir, { recursive: true, force: true })),
    );
    vi.restoreAllMocks();
  });

  async function collectOfflineEvents(
    controller: RuntimeController,
    sessionId: string,
    options?: Parameters<RuntimeController["subscribeSession"]>[2],
  ): Promise<Array<{ type: string; data: unknown }>> {
    const events: Array<{ type: string; data: unknown }> = [];
    let resolveComplete: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });
    const emit: RuntimeSessionEventEmitter = (type, data) => {
      events.push({ type, data });
      if (type === "complete") resolveComplete?.();
    };
    const subscription = await controller.subscribeSession(
      sessionId,
      emit,
      options,
    );
    expect(subscription).not.toBeNull();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("offline runtime replay did not complete")),
            1_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    subscription?.cleanup();
    return events;
  }

  it("rejects unauthenticated control requests", async () => {
    const { app } = createHarness();
    const response = await app.request("/status");
    expect(response.status).toBe(401);
  });

  it("propagates an aborted event request into a pending runtime subscription", async () => {
    let observedSignal: AbortSignal | undefined;
    let resolveSubscription:
      | ((
          value: Awaited<ReturnType<RuntimeController["subscribeSession"]>>,
        ) => void)
      | undefined;
    const runtimeController = {
      subscribeSession: vi.fn(
        (
          _sessionId: string,
          _emit: (eventType: string, data: unknown) => void,
          options?: { signal?: AbortSignal },
        ) => {
          observedSignal = options?.signal;
          return new Promise<
            Awaited<ReturnType<RuntimeController["subscribeSession"]>>
          >((resolve) => {
            resolveSubscription = resolve;
          });
        },
      ),
    } as unknown as RuntimeController;
    const app = createRuntimeControlApp({
      controller: runtimeController,
      token: "runtime-test-token",
    });
    const abortController = new AbortController();
    const responsePromise = app.fetch(
      new Request("http://runtime.test/events?sessionId=session-race", {
        headers: { authorization: "Bearer runtime-test-token" },
        signal: abortController.signal,
      }),
    );

    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    abortController.abort();
    expect(observedSignal?.aborted).toBe(true);
    resolveSubscription?.(null);

    await expect(responsePromise).resolves.toMatchObject({ status: 404 });
  });

  it("rejects an incompatible runtime protocol before serving the shell", async () => {
    const controller = new HttpRuntimeController({
      baseUrl: "http://runtime.test",
      token: "runtime-test-token",
      fetch: async () =>
        Response.json({
          mode: "embedded",
          protocolVersion: 999,
          processCount: 0,
          activeWorkers: 0,
          queueLength: 0,
          hasActiveWork: false,
        }),
    });

    await expect(controller.start()).rejects.toThrow(
      "Agent runtime protocol mismatch",
    );
  });

  it("round-trips immediate admission without entering the external runtime queue", async () => {
    const { controller } = createHarness({ maxWorkers: 1 });
    await controller.start();

    await controller.startSession({
      projectPath: "/tmp/http-runtime-immediate-one",
      message: { text: "one" },
    });
    await expect(
      controller.startSession({
        projectPath: "/tmp/http-runtime-immediate-two",
        message: { text: "must not queue" },
        requireImmediate: true,
      }),
    ).resolves.toEqual({ error: "immediate_start_unavailable" });
    await expect(
      controller.createSession({
        projectPath: "/tmp/http-runtime-immediate-create",
        requireImmediate: true,
      }),
    ).resolves.toEqual({ error: "immediate_start_unavailable" });
    await expect(
      controller.resumeSession({
        sessionId: "existing-http-thread",
        projectPath: "/tmp/http-runtime-immediate-resume",
        message: { text: "must not queue as a resume" },
        requireImmediate: true,
      }),
    ).resolves.toEqual({ error: "immediate_start_unavailable" });

    await expect(controller.getQueueStatus()).resolves.toMatchObject({
      activeWorkers: 1,
      queueLength: 0,
    });
    await expect(controller.listProcesses()).resolves.toHaveLength(1);
  });

  it("forwards lifecycle, state and queue operations over HTTP", async () => {
    const { controller } = createHarness();
    await controller.start();

    const started = await controller.startSession({
      projectPath: "/tmp/http-runtime-controller",
      message: { text: "hello" },
      permissionMode: "default",
    });
    expect("id" in started).toBe(true);

    const sessionId = "sessionId" in started ? started.sessionId : "";
    const processId = "id" in started ? started.id : "";
    await expect(controller.getStatus()).resolves.toMatchObject({
      mode: "external",
      activeWorkers: 1,
      processCount: 1,
    });
    await expect(
      controller.getProcessSnapshotForSession(sessionId),
    ).resolves.toMatchObject({
      id: processId,
      permissionMode: "default",
      state: "in-turn",
    });

    await expect(
      controller.setPermissionMode({ sessionId, mode: "acceptEdits" }),
    ).resolves.toMatchObject({ ok: true, permissionMode: "acceptEdits" });
    await expect(
      controller.setHold({ sessionId, hold: true }),
    ).resolves.toMatchObject({ ok: true, state: "hold" });
    await expect(
      controller.setHold({ sessionId, hold: false }),
    ).resolves.toMatchObject({ ok: true, isHeld: false });
    await expect(controller.abortProcess(processId)).resolves.toEqual({
      aborted: true,
    });
  });

  it("streams session events through the control connection", async () => {
    const { controller } = createHarness();
    const started = await controller.startSession({
      projectPath: "/tmp/http-runtime-events",
      message: { text: "hello" },
    });
    const sessionId = "sessionId" in started ? started.sessionId : "";
    const processId = "id" in started ? started.id : "";

    const connected = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("event stream did not connect")),
        1_000,
      );
      void controller
        .subscribeSession(sessionId, (eventType, data) => {
          if (eventType === "connected") {
            clearTimeout(timeout);
            resolve(data);
          }
        })
        .then((subscription) => {
          if (!subscription) reject(new Error("missing subscription"));
        }, reject);
    });

    await expect(connected).resolves.toMatchObject({
      processId,
      sessionId,
    });
    await controller.shutdown();
  });

  it("matches embedded bounded replay for an offline result, error and completion", async () => {
    const eventsDir = path.join(
      tmpdir(),
      `http-runtime-offline-replay-${randomUUID()}`,
    );
    eventDirs.push(eventsDir);
    const sessionId = "offline-session";
    const firstStore = new RuntimeEventStore({ eventsDir });
    await firstStore.append({
      processId: "older-process",
      sessionId,
      type: "message",
      data: { type: "result", uuid: "older-result", is_error: false },
      timestamp: "2026-08-08T00:00:00.000Z",
    });
    await firstStore.append({
      processId: "older-process",
      sessionId,
      type: "complete",
      data: { timestamp: "2026-08-08T00:00:01.000Z" },
      timestamp: "2026-08-08T00:00:01.000Z",
    });
    await firstStore.append({
      processId: "offline-process",
      sessionId,
      type: "message",
      data: {
        type: "user",
        uuid: "already-delivered",
        turnId: "offline-turn",
      },
      timestamp: "2026-08-08T00:01:00.000Z",
    });
    await firstStore.append({
      processId: "offline-process",
      sessionId,
      type: "message",
      data: {
        type: "result",
        uuid: "offline-result",
        turnId: "offline-turn",
        is_error: true,
      },
      timestamp: "2026-08-08T00:01:01.000Z",
    });
    await firstStore.append({
      processId: "offline-process",
      sessionId,
      type: "error",
      data: { message: "offline failure" },
      timestamp: "2026-08-08T00:01:02.000Z",
    });
    await firstStore.append({
      processId: "offline-process",
      sessionId: "different-session",
      type: "message",
      data: { type: "result", uuid: "must-not-cross-session" },
      timestamp: "2026-08-08T00:02:00.000Z",
    });
    await firstStore.flush();

    const eventStore = new RuntimeEventStore({ eventsDir });
    const { controller, embedded } = createHarness({ eventStore });
    const options = { afterSeq: 1 };
    const embeddedEvents = await collectOfflineEvents(
      embedded,
      sessionId,
      options,
    );
    const httpEvents = await collectOfflineEvents(
      controller,
      sessionId,
      options,
    );

    expect(httpEvents).toEqual(embeddedEvents);
    expect(httpEvents).toEqual([
      {
        type: "connected",
        data: {
          processId: "offline-process",
          sessionId,
          state: "idle",
          replayOnly: true,
        },
      },
      {
        type: "message",
        data: {
          type: "result",
          uuid: "offline-result",
          turnId: "offline-turn",
          is_error: true,
          isReplay: true,
        },
      },
      { type: "error", data: { message: "offline failure" } },
      {
        type: "complete",
        data: {
          timestamp: "2026-08-08T00:01:01.000Z",
          replayOnly: true,
          synthetic: true,
          reason: "journal-turn-terminal",
        },
      },
    ]);
  });

  it("returns null for an offline session with no durable events", async () => {
    const eventsDir = path.join(
      tmpdir(),
      `http-runtime-empty-replay-${randomUUID()}`,
    );
    eventDirs.push(eventsDir);
    const { controller } = createHarness({
      eventStore: new RuntimeEventStore({ eventsDir }),
    });

    await expect(
      controller.subscribeSession("missing-session", vi.fn()),
    ).resolves.toBeNull();
  });

  it("keeps worker state when the web/API app facade is recreated", async () => {
    const { controller } = createHarness();
    const started = await controller.startSession({
      projectPath: "/tmp/http-runtime-shell-reload",
      message: { text: "long turn" },
    });
    expect("id" in started).toBe(true);

    const firstShell = createApp({
      sdk: new MockClaudeSDK(),
      projectsDir: "/nonexistent/runtime-shell-one",
      runtimeController: controller,
    });
    const firstStatus = await firstShell.app.request("/api/status/workers");
    await expect(firstStatus.json()).resolves.toMatchObject({
      activeWorkers: 1,
      hasActiveWork: true,
      runtimeMode: "external",
    });

    const secondShell = createApp({
      sdk: new MockClaudeSDK(),
      projectsDir: "/nonexistent/runtime-shell-two",
      runtimeController: controller,
    });
    const secondStatus = await secondShell.app.request("/api/status/workers");
    await expect(secondStatus.json()).resolves.toMatchObject({
      activeWorkers: 1,
      hasActiveWork: true,
      runtimeMode: "external",
    });
  });

  it("forwards runtime activity events to a reconnected shell", async () => {
    const { controller, eventBus } = createHarness();
    const received = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("activity stream did not forward")),
        1_000,
      );
      void controller
        .subscribeActivity((event) => {
          if (event.type === "worker-activity-changed") {
            clearTimeout(timeout);
            resolve(event);
          }
        })
        .then((subscription) => {
          if (!subscription) reject(new Error("missing activity stream"));
          eventBus.emit({
            type: "worker-activity-changed",
            activeWorkers: 1,
            queueLength: 0,
            hasActiveWork: true,
            timestamp: new Date().toISOString(),
          });
        }, reject);
    });

    await expect(received).resolves.toMatchObject({
      activeWorkers: 1,
      hasActiveWork: true,
    });
    await controller.shutdown();
  });
});

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedRuntimeController } from "../../src/runtime/EmbeddedRuntimeController.js";
import { RuntimeEventStore } from "../../src/runtime/RuntimeEventStore.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import type {
  AgentProvider,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";

function createLongRunningProvider(): AgentProvider {
  const startSession = vi.fn(async (options: StartSessionOptions) => {
    let aborted = false;
    const sessionId = options.resumeSessionId ?? `runtime-${Date.now()}`;

    async function* iterator() {
      yield { type: "system", subtype: "init", session_id: sessionId };
      while (!aborted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
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
  });

  return {
    name: "claude",
    displayName: "Claude",
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
    startSession,
    getAvailableModels: async () => [],
  };
}

describe("EmbeddedRuntimeController", () => {
  const controllers: EmbeddedRuntimeController[] = [];
  const eventDirs: string[] = [];

  function createController(options?: {
    maxWorkers?: number;
    maxQueueSize?: number;
    eventStore?: RuntimeEventStore;
  }): EmbeddedRuntimeController {
    const supervisor = new Supervisor({
      provider: createLongRunningProvider(),
      idleTimeoutMs: 100,
      maxWorkers: options?.maxWorkers,
      maxQueueSize: options?.maxQueueSize,
    });
    const controller = new EmbeddedRuntimeController(
      supervisor,
      undefined,
      options?.eventStore,
    );
    controllers.push(controller);
    return controller;
  }

  afterEach(async () => {
    await Promise.all(
      controllers
        .splice(0)
        .map((controller) => controller.shutdown({ abortActive: true })),
    );
    await Promise.all(
      eventDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("forwards process lifecycle and status through the runtime facade", async () => {
    const controller = createController();

    const started = await controller.startSession({
      projectPath: "/tmp/runtime-controller",
      message: { text: "hello" },
      permissionMode: "default",
    });

    expect("id" in started ? started.id : undefined).toBeDefined();
    expect(await controller.listProcesses()).toHaveLength(1);
    await expect(controller.getStatus()).resolves.toMatchObject({
      mode: "embedded",
      activeWorkers: 1,
      processCount: 1,
    });

    const processId = "id" in started ? started.id : "";
    await expect(controller.abortProcess(processId)).resolves.toEqual({
      aborted: true,
    });
    await expect(controller.listProcesses()).resolves.toHaveLength(0);
  });

  it("exposes queue state without leaking WorkerQueue internals", async () => {
    const controller = createController({ maxWorkers: 1, maxQueueSize: 4 });

    await controller.startSession({
      projectPath: "/tmp/runtime-controller-one",
      message: { text: "one" },
    });
    const queued = await controller.startSession({
      projectPath: "/tmp/runtime-controller-two",
      message: { text: "two" },
    });

    expect("queued" in queued ? queued.queued : false).toBe(true);
    const queueStatus = await controller.getQueueStatus();
    expect(queueStatus).toMatchObject({
      activeWorkers: 1,
      maxWorkers: 1,
      queueLength: 1,
    });
    expect(queueStatus.queue).toHaveLength(1);

    const queueId = "queued" in queued ? queued.queueId : "";
    await expect(controller.getQueuePosition(queueId)).resolves.toBe(1);
    await expect(controller.cancelQueuedRequest(queueId)).resolves.toEqual({
      cancelled: true,
    });
  });

  it("rejects immediate-only starts before embedded queue admission", async () => {
    const controller = createController({ maxWorkers: 1, maxQueueSize: 4 });

    await controller.startSession({
      projectPath: "/tmp/runtime-immediate-one",
      message: { text: "one" },
    });
    await expect(
      controller.startSession({
        projectPath: "/tmp/runtime-immediate-two",
        message: { text: "must not queue" },
        requireImmediate: true,
      }),
    ).resolves.toEqual({ error: "immediate_start_unavailable" });
    await expect(
      controller.createSession({
        projectPath: "/tmp/runtime-immediate-create",
        requireImmediate: true,
      }),
    ).resolves.toEqual({ error: "immediate_start_unavailable" });
    await expect(
      controller.resumeSession({
        sessionId: "existing-runtime-thread",
        projectPath: "/tmp/runtime-immediate-resume",
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

  it("forwards live session controls through structured methods", async () => {
    const controller = createController();
    const started = await controller.startSession({
      projectPath: "/tmp/runtime-controller-controls",
      message: { text: "hello" },
    });
    const sessionId = "sessionId" in started ? started.sessionId : "";

    await expect(
      controller.setPermissionMode({
        sessionId,
        mode: "acceptEdits",
      }),
    ).resolves.toMatchObject({
      ok: true,
      permissionMode: "acceptEdits",
      modeVersion: 1,
    });

    await expect(
      controller.executeCodexControl({
        sessionId,
        request: { control: "thread/goal/get" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      control: "thread/goal/get",
      error: { code: "unsupported_provider" },
    });

    await expect(
      controller.queueMessage({
        sessionId,
        projectPath: "/tmp/runtime-controller-controls",
        message: { text: "follow up" },
      }),
    ).resolves.toMatchObject({
      success: true,
      restarted: false,
    });

    await expect(
      controller.setHold({
        sessionId,
        hold: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      isHeld: true,
      state: "hold",
    });

    await expect(
      controller.setHold({
        sessionId,
        hold: false,
      }),
    ).resolves.toMatchObject({
      ok: true,
      isHeld: false,
    });
  });

  it("replays journaled messages emitted while the shell is disconnected", async () => {
    const eventsDir = path.join(
      tmpdir(),
      `embedded-runtime-journal-${randomUUID()}`,
    );
    eventDirs.push(eventsDir);
    const eventStore = new RuntimeEventStore({ eventsDir });
    const controller = createController({ eventStore });
    const started = await controller.startSession({
      projectPath: "/tmp/runtime-controller-journal",
      message: { text: "initial" },
    });
    const sessionId = "sessionId" in started ? started.sessionId : "";

    await controller.queueMessage({
      sessionId,
      projectPath: "/tmp/runtime-controller-journal",
      message: { text: "during shell restart", tempId: "gap-message" },
    });
    await controller.deferMessage(sessionId, {
      text: "deferred during restart",
      tempId: "deferred-gap",
    });
    await controller.setPermissionMode({
      sessionId,
      mode: "acceptEdits",
    });
    await eventStore.flush();

    const events: Array<{ type: string; data: unknown }> = [];
    const subscription = await controller.subscribeSession(
      sessionId,
      (type, data) => events.push({ type, data }),
    );
    subscription?.cleanup();

    expect(
      events.filter(
        (event) =>
          event.type === "message" &&
          (event.data as { tempId?: string }).tempId === "gap-message",
      ),
    ).toHaveLength(1);
    expect(
      events.find(
        (event) =>
          event.type === "message" &&
          (event.data as { tempId?: string }).tempId === "gap-message",
      )?.data,
    ).toMatchObject({ isReplay: true });
    expect(events.some((event) => event.type === "deferred-queue")).toBe(true);
    expect(events).toContainEqual({
      type: "mode-change",
      data: { permissionMode: "acceptEdits", modeVersion: 1 },
    });
  });

  it("replays a durable terminal stream after restart without an active process", async () => {
    const eventsDir = path.join(
      tmpdir(),
      `embedded-runtime-offline-replay-${randomUUID()}`,
    );
    eventDirs.push(eventsDir);
    const sessionId = "restarted-session";
    const firstStore = new RuntimeEventStore({ eventsDir });
    await firstStore.append({
      processId: "old-process",
      sessionId,
      type: "message",
      data: {
        type: "user",
        tempId: "restarted-turn",
        message: { content: [] },
      },
    });
    await firstStore.append({
      processId: "old-process",
      sessionId,
      type: "message",
      data: {
        type: "system",
        subtype: "turn_complete",
        turnStatus: "completed",
      },
    });
    await firstStore.append({
      processId: "old-process",
      sessionId,
      type: "complete",
      data: { timestamp: "2026-08-08T00:00:00.000Z" },
    });
    await firstStore.flush();

    const restarted = createController({
      eventStore: new RuntimeEventStore({ eventsDir }),
    });
    const events: Array<{ type: string; data: unknown }> = [];
    const subscription = await restarted.subscribeSession(
      sessionId,
      (type, data) => events.push({ type, data }),
    );

    expect(subscription).not.toBeNull();
    expect(events[0]).toEqual({
      type: "connected",
      data: {
        processId: "old-process",
        sessionId,
        state: "idle",
        replayOnly: true,
      },
    });
    expect(events[1]).toMatchObject({
      type: "message",
      data: { type: "user", tempId: "restarted-turn", isReplay: true },
    });
    expect(events.at(-1)).toEqual({
      type: "complete",
      data: { timestamp: "2026-08-08T00:00:00.000Z" },
    });
    subscription?.cleanup();
  });

  it.each([
    [
      "result",
      {
        type: "result",
        turnId: "offline-turn",
        is_error: false,
      },
    ],
    [
      "turn_complete",
      {
        type: "system",
        subtype: "turn_complete",
        turnId: "offline-turn",
        turnStatus: "completed",
      },
    ],
    [
      "non-retryable error",
      {
        type: "error",
        turnId: "offline-turn",
        willRetry: false,
        error: "terminal failure",
      },
    ],
  ])(
    "bounds an offline %s terminal with a replay-only transport completion",
    async (_label, terminalMessage) => {
      const eventsDir = path.join(
        tmpdir(),
        `embedded-runtime-turn-terminal-${randomUUID()}`,
      );
      eventDirs.push(eventsDir);
      const eventStore = new RuntimeEventStore({ eventsDir });
      await eventStore.append({
        processId: "idle-process",
        sessionId: "idle-session",
        type: "message",
        data: { type: "user", turnId: "offline-turn", uuid: "offline-user" },
        timestamp: "2026-08-08T00:00:00.000Z",
      });
      await eventStore.append({
        processId: "idle-process",
        sessionId: "idle-session",
        type: "message",
        data: terminalMessage,
        timestamp: "2026-08-08T00:00:01.000Z",
      });
      await eventStore.append({
        processId: "idle-process",
        sessionId: "idle-session",
        type: "status",
        data: { state: "idle" },
        timestamp: "2026-08-08T00:00:02.000Z",
      });
      await eventStore.flush();
      const controller = createController({
        eventStore: new RuntimeEventStore({ eventsDir }),
      });
      const events: Array<{ type: string; data: unknown }> = [];

      const subscription = await controller.subscribeSession(
        "idle-session",
        (type, data) => events.push({ type, data }),
      );

      expect(subscription).not.toBeNull();
      expect(events.filter((event) => event.type === "complete")).toEqual([
        {
          type: "complete",
          data: {
            timestamp: "2026-08-08T00:00:01.000Z",
            replayOnly: true,
            synthetic: true,
            reason: "journal-turn-terminal",
          },
        },
      ]);
      expect(events.at(-2)).toEqual({
        type: "status",
        data: { state: "idle" },
      });
      subscription?.cleanup();
    },
  );

  it("does not let an older terminal close a partial offline user/delta turn", async () => {
    const eventsDir = path.join(
      tmpdir(),
      `embedded-runtime-partial-replay-${randomUUID()}`,
    );
    eventDirs.push(eventsDir);
    const eventStore = new RuntimeEventStore({ eventsDir });
    await eventStore.append({
      processId: "interrupted-process",
      sessionId: "interrupted-session",
      type: "message",
      data: { type: "result", turnId: "completed-turn" },
    });
    await eventStore.append({
      processId: "interrupted-process",
      sessionId: "interrupted-session",
      type: "message",
      data: { type: "user", turnId: "interrupted-turn" },
    });
    await eventStore.append({
      processId: "interrupted-process",
      sessionId: "interrupted-session",
      type: "message",
      data: {
        type: "stream_event",
        turnId: "interrupted-turn",
        delta: "partial",
      },
    });
    await eventStore.append({
      processId: "interrupted-process",
      sessionId: "interrupted-session",
      type: "message",
      data: {
        type: "error",
        turnId: "interrupted-turn",
        willRetry: true,
      },
    });
    await eventStore.flush();
    const controller = createController({
      eventStore: new RuntimeEventStore({ eventsDir }),
    });

    await expect(
      controller.subscribeSession("interrupted-session", vi.fn()),
    ).resolves.toBeNull();
  });

  it("cancels queued starts before aborting active processes during shutdown", async () => {
    const provider = createLongRunningProvider();
    const supervisor = new Supervisor({
      provider,
      maxWorkers: 1,
      maxQueueSize: 4,
      idleTimeoutMs: 100,
    });
    const controller = new EmbeddedRuntimeController(supervisor);
    controllers.push(controller);

    await controller.startSession({
      projectPath: "/tmp/runtime-shutdown-active",
      message: { text: "active" },
    });
    const queued = await controller.startSession({
      projectPath: "/tmp/runtime-shutdown-queued",
      message: { text: "queued" },
    });
    expect("queued" in queued ? queued.queued : false).toBe(true);

    await controller.shutdown({ abortActive: true });

    expect(provider.startSession).toHaveBeenCalledTimes(1);
    await expect(controller.getQueueStatus()).resolves.toMatchObject({
      activeWorkers: 0,
      queueLength: 0,
    });
    await expect(controller.listProcesses()).resolves.toHaveLength(0);
  });
});

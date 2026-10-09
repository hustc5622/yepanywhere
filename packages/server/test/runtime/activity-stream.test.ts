import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRuntimeController } from "../../src/runtime/HttpRuntimeController.js";
import { createRuntimeControlApp } from "../../src/runtime/control-server.js";
import type {
  RuntimeController,
  RuntimeProcessSnapshot,
} from "../../src/runtime/types.js";
import { type BusEvent, EventBus } from "../../src/watcher/EventBus.js";

const projectId = "project-1" as UrlProjectId;
const idleEvent: BusEvent = {
  type: "process-state-changed",
  sessionId: "session-1",
  projectId,
  activity: "idle",
  timestamp: "2026-10-08T07:06:40.000Z",
};

function activityResponse() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
    cancel,
  });
  return {
    response: new Response(body),
    writer,
    cancel,
    emit(event: BusEvent) {
      writer.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ event })}\n\n`),
      );
    },
  };
}

function createHarness() {
  const bus = new EventBus();
  const process: RuntimeProcessSnapshot = {
    id: "process-1",
    sessionId: "session-1",
    projectId,
    projectPath: "/tmp/project",
    projectName: "Project",
    sessionTitle: "Session",
    state: "idle",
    startedAt: "2026-10-08T07:00:00.000Z",
    queueDepth: 0,
    provider: "codex",
    modeVersion: 1,
    pendingInputRequest: null,
    messageHistory: [],
    supportsDynamicModels: false,
    supportsDynamicCommands: false,
    supportsSetModel: false,
  };
  const runtime = {
    subscribeActivity: vi.fn(async (listener: (event: BusEvent) => void) => ({
      cleanup: bus.subscribe(listener),
    })),
    listProcessSnapshots: vi.fn(async () => [process]),
    listRecentlyTerminatedProcesses: vi.fn(async () => [
      {
        ...process,
        id: "terminated-1",
        sessionId: "ended-session",
        state: "terminated",
      },
      { ...process, id: "older-process", state: "terminated" },
    ]),
    getWorkerActivity: vi.fn(async () => ({
      activeWorkers: 1,
      queueLength: 0,
      hasActiveWork: false,
    })),
  };
  const app = createRuntimeControlApp({
    controller: runtime as unknown as RuntimeController,
    token: "test-token",
  });
  const open = (reconcile = false) =>
    app.request(`/activity-events${reconcile ? "?reconcile=true" : ""}`, {
      headers: { authorization: "Bearer test-token" },
    });
  return { bus, runtime, process, open };
}

async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
) {
  const events: BusEvent[] = [];
  let buffer = "";
  while (events.length < count) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Stream ended before expected events");
    buffer += new TextDecoder().decode(chunk.value);
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith("data: "))
        events.push(JSON.parse(frame.slice(6)).event);
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

describe("runtime activity stream recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["EOF", "read error"])(
    "reconnects after %s and receives reconciled state",
    async (failure) => {
      const first = activityResponse();
      const second = activityResponse();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(first.response)
        .mockResolvedValue(second.response);
      const onError = vi.fn();
      const listener = vi.fn();
      const controller = new HttpRuntimeController({
        baseUrl: "http://runtime.test",
        token: "test",
        fetch,
      });
      const subscription = await controller.subscribeActivity(listener, {
        onError,
      });
      try {
        if (failure === "EOF") first.writer.close();
        else first.writer.error(new Error("connection reset"));
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), {
          timeout: 2000,
        });
        expect(fetch.mock.calls[1]?.[0]).toBe(
          "http://runtime.test/activity-events?reconcile=true",
        );
        second.emit(idleEvent);
        await vi.waitFor(() =>
          expect(listener).toHaveBeenCalledWith(idleEvent),
        );
        expect(onError).toHaveBeenCalledTimes(1);
      } finally {
        subscription?.cleanup();
      }
      await vi.waitFor(() => expect(second.cancel).toHaveBeenCalledTimes(1));
    },
  );

  it("retries a failed reconnect and cancels the active reader on shutdown", async () => {
    const first = activityResponse();
    const second = activityResponse();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockRejectedValueOnce(new Error("runtime temporarily unavailable"))
      .mockResolvedValue(second.response);
    const controller = new HttpRuntimeController({
      baseUrl: "http://runtime.test",
      token: "test",
      fetch,
    });
    const listener = vi.fn();
    const onError = vi.fn();
    await controller.subscribeActivity(listener, { onError });
    try {
      first.writer.close();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3), {
        timeout: 4000,
      });
      second.emit(idleEvent);
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(idleEvent));
      expect(onError).toHaveBeenCalledTimes(2);
    } finally {
      await controller.shutdown();
    }
    await vi.waitFor(() => expect(second.cancel).toHaveBeenCalledTimes(1));
  });

  it("does not reconnect after cleanup during backoff", async () => {
    const first = activityResponse();
    const fetch = vi.fn().mockResolvedValue(first.response);
    const onError = vi.fn();
    const controller = new HttpRuntimeController({
      baseUrl: "http://runtime.test",
      token: "test",
      fetch,
    });
    const subscription = await controller.subscribeActivity(vi.fn(), {
      onError,
    });
    first.writer.close();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    subscription?.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a late initial response after controller shutdown", async () => {
    const pending = activityResponse();
    let resolveResponse!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const controller = new HttpRuntimeController({
      baseUrl: "http://runtime.test",
      token: "test",
      fetch,
    });
    const subscription = controller.subscribeActivity(vi.fn());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await controller.shutdown();
    resolveResponse(pending.response);
    await expect(subscription).resolves.toBeNull();
    expect(pending.cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps silent activity subscriptions alive and clears heartbeat on disconnect", async () => {
    vi.useFakeTimers();
    const { open, bus } = createHarness();
    const response = await open();
    if (!response.body) throw new Error("Missing activity stream");
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      ": connected\n\n",
    );
    const heartbeat = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(new TextDecoder().decode((await heartbeat).value)).toBe(
      ": heartbeat\n\n",
    );
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(bus.subscriberCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replays snapshots then buffered events and reconciles workers that exited offline", async () => {
    const { open, bus, runtime, process } = createHarness();
    let resolveSnapshots!: (value: RuntimeProcessSnapshot[]) => void;
    runtime.listProcessSnapshots.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshots = resolve;
        }),
    );
    const response = await open(true);
    if (!response.body) throw new Error("Missing activity stream");
    const reader = response.body.getReader();
    try {
      await vi.waitFor(() => expect(resolveSnapshots).toBeDefined());
      const resumed: BusEvent = { ...idleEvent, activity: "in-turn" };
      bus.emit(resumed);
      resolveSnapshots([process]);
      const events = await readEvents(reader, 6);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "process-state-changed",
          activity: "idle",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session-status-changed",
          sessionId: "ended-session",
          ownership: { owner: "none" },
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: "session-status-changed",
          sessionId: "session-1",
          ownership: { owner: "none" },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session-updated",
          sessionId: "session-1",
        }),
      );
      expect(events.at(-1)).toEqual(resumed);
    } finally {
      await reader.cancel();
    }
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
  });
});

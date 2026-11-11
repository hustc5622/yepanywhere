import { describe, expect, it, vi } from "vitest";
import {
  type AttachableRuntime,
  attachExternalRuntime,
} from "../../src/runtime/external-runtime-attach.js";
import type { RuntimeEventRecord } from "../../src/runtime/types.js";
import type { BusEvent } from "../../src/watcher/index.js";

const quietLog = { log: () => {}, error: () => {} };

function remapRecord(): RuntimeEventRecord {
  return {
    seq: 1,
    timestamp: "2026-11-11T00:00:00.000Z",
    processId: "proc",
    sessionId: "temp",
    type: "session-id-changed",
    data: { oldSessionId: "temp", newSessionId: "real", projectId: "p" },
  };
}

function fakeRuntime(failStarts: number) {
  let starts = 0;
  const cleanup = vi.fn();
  const runtime: AttachableRuntime = {
    start: vi.fn(async () => {
      starts += 1;
      if (starts <= failStarts) throw new TypeError("fetch failed");
    }),
    updateProviderSettings: vi.fn(async () => {}),
    subscribeActivity: vi.fn(async () => ({ cleanup })),
    replay: vi.fn(async () => [remapRecord()]),
  };
  return { runtime, cleanup };
}

describe("attachExternalRuntime", () => {
  it("keeps retrying an unavailable runtime and attaches once it answers", async () => {
    const { runtime } = fakeRuntime(2);
    const applied: BusEvent[] = [];
    const onAttached = vi.fn(async () => {});
    await expect(
      attachExternalRuntime({
        runtime,
        providerSettings: () => ({ claudeRemoteExecutors: [] }),
        applyEvent: async (event) => {
          applied.push(event);
        },
        onAttached,
        initialRetryDelayMs: 1,
        log: quietLog,
      }),
    ).resolves.toBe(true);
    expect(runtime.start).toHaveBeenCalledTimes(3);
    expect(runtime.replay).toHaveBeenCalledWith({
      types: ["session-id-changed"],
    });
    expect(applied).toEqual([
      expect.objectContaining({
        type: "session-id-changed",
        oldSessionId: "temp",
        newSessionId: "real",
      }),
    ]);
    expect(onAttached).toHaveBeenCalledTimes(1);
  });

  it("reuses the activity subscription across a failed later step", async () => {
    const { runtime } = fakeRuntime(0);
    let replays = 0;
    runtime.replay = vi.fn(async () => {
      replays += 1;
      if (replays === 1) throw new Error("runtime busy");
      return [];
    });
    await attachExternalRuntime({
      runtime,
      providerSettings: () => ({ claudeRemoteExecutors: [] }),
      applyEvent: async () => {},
      onAttached: async () => {},
      initialRetryDelayMs: 1,
      log: quietLog,
    });
    expect(runtime.subscribeActivity).toHaveBeenCalledTimes(1);
  });

  it("stops retrying on abort and releases the subscription", async () => {
    const { runtime, cleanup } = fakeRuntime(0);
    runtime.replay = vi.fn(async () => {
      throw new Error("runtime wedged");
    });
    const abort = new AbortController();
    const attached = attachExternalRuntime({
      runtime,
      providerSettings: () => ({ claudeRemoteExecutors: [] }),
      applyEvent: async () => {},
      onAttached: async () => {},
      signal: abort.signal,
      initialRetryDelayMs: 60_000,
      log: quietLog,
    });
    await vi.waitFor(() => expect(runtime.replay).toHaveBeenCalled());
    abort.abort();
    await expect(attached).resolves.toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuScopeScheduler } from "../../../src/channels/feishu/scheduler.js";

describe("FeishuScopeScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces adjacent messages into one per-scope batch", async () => {
    vi.useFakeTimers();
    const onMessageBatch = vi.fn(async (_scope: string, values: string[]) =>
      values.join(","),
    );
    const scheduler = new FeishuScopeScheduler({
      debounceMs: 300,
      onMessageBatch,
    });

    const first = scheduler.enqueueMessage("scope-a", "one");
    const second = scheduler.enqueueMessage("scope-a", "two");
    await vi.advanceTimersByTimeAsync(300);

    await expect(first).resolves.toBe("one,two");
    await expect(second).resolves.toBe("one,two");
    expect(onMessageBatch).toHaveBeenCalledTimes(1);
    await scheduler.shutdown();
  });

  it("runs one operation at a time per scope and prioritizes queued stop controls", async () => {
    const scheduler = new FeishuScopeScheduler<string, string>({
      onMessageBatch: async () => "unused",
    });
    const order: string[] = [];
    let releaseRunning = () => undefined;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    const running = scheduler.enqueueControl("scope-a", async () => {
      order.push("running");
      await runningGate;
      order.push("running-done");
    });
    const normal = scheduler.enqueueControl("scope-a", async () => {
      order.push("normal");
    });
    const stop = scheduler.enqueueControl(
      "scope-a",
      async () => {
        order.push("stop");
      },
      { priority: "high" },
    );

    await Promise.resolve();
    expect(order).toEqual(["running"]);
    releaseRunning();
    await Promise.all([running, normal, stop]);
    expect(order).toEqual(["running", "running-done", "stop", "normal"]);
    await scheduler.shutdown();
  });

  it("allows independent scopes to make progress concurrently", async () => {
    const scheduler = new FeishuScopeScheduler<string, string>({
      onMessageBatch: async () => "unused",
    });
    const started: string[] = [];
    let release = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scheduler.enqueueControl("scope-a", async () => {
      started.push("a");
      await gate;
    });
    const second = scheduler.enqueueControl("scope-b", async () => {
      started.push("b");
      await gate;
    });

    await Promise.resolve();
    expect(started.sort()).toEqual(["a", "b"]);
    release();
    await Promise.all([first, second]);
    await scheduler.shutdown();
  });

  it("rejects debounced work during shutdown", async () => {
    vi.useFakeTimers();
    const scheduler = new FeishuScopeScheduler<string, string>({
      debounceMs: 300,
      onMessageBatch: async () => "done",
    });
    const pending = scheduler.enqueueMessage("scope-a", "one");
    const rejection = expect(pending).rejects.toThrow(
      "Feishu scope scheduler is shut down",
    );

    await scheduler.shutdown();
    await rejection;
    expect(scheduler.activeScopeCount).toBe(0);
  });
});

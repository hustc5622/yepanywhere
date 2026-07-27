import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientLogCollector } from "../ClientLogCollector";

// Mock fetchJSON to avoid real network calls
vi.mock("../../../api/client", () => ({
  fetchJSON: vi.fn(() => Promise.resolve({ received: 0 })),
}));

// Mock connectionManager
const stateChangeListeners = new Set<(state: string, prev: string) => void>();
vi.mock("../../connection", () => ({
  connectionManager: {
    state: "disconnected",
    on: vi.fn((event: string, cb: (state: string, prev: string) => void) => {
      if (event === "stateChange") {
        stateChangeListeners.add(cb);
      }
      return () => stateChangeListeners.delete(cb);
    }),
  },
}));

import { fetchJSON } from "../../../api/client";

describe("ClientLogCollector", () => {
  let collector: ClientLogCollector;
  let origLog: typeof console.log;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  beforeEach(() => {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    stateChangeListeners.clear();
    vi.clearAllMocks();
    collector = new ClientLogCollector();
  });

  afterEach(() => {
    collector.stop();
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  it("captures console messages and flushes with deviceId", async () => {
    await collector.start();

    console.log("[ConnectionManager] connected → reconnecting");
    console.warn("warn message");
    console.error("error message");

    await new Promise((r) => setTimeout(r, 10));

    vi.mocked(fetchJSON).mockResolvedValueOnce({ received: 4 });
    await collector.flush();

    expect(fetchJSON).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      vi.mocked(fetchJSON).mock.calls[0]?.[1]?.body as string,
    );
    // Should have ClientInfo entry + 3 console entries
    expect(body.entries.length).toBeGreaterThanOrEqual(4);
    expect(
      body.entries.some((e: { prefix: string }) => e.prefix === "[ClientInfo]"),
    ).toBe(true);
    expect(
      body.entries.some(
        (e: { prefix: string }) => e.prefix === "[ConnectionManager]",
      ),
    ).toBe(true);
  });

  it("restores console on stop", async () => {
    await collector.start();
    expect(console.log).not.toBe(origLog);

    collector.stop();
    expect(console.log).toBe(origLog);
    expect(console.warn).toBe(origWarn);
    expect(console.error).toBe(origError);
  });

  it("does not install collectors when stopped while IndexedDB is opening", async () => {
    const startPromise = collector.start();
    collector.stop();
    await startPromise;

    expect(console.log).toBe(origLog);
    expect(console.warn).toBe(origWarn);
    expect(console.error).toBe(origError);
    expect(stateChangeListeners.size).toBe(0);
  });

  it("flushes on stateChange to connected", async () => {
    await collector.start();

    console.log("test entry");
    await new Promise((r) => setTimeout(r, 10));

    vi.mocked(fetchJSON).mockResolvedValueOnce({ received: 1 });

    for (const cb of stateChangeListeners) {
      cb("connected", "reconnecting");
    }

    await new Promise((r) => setTimeout(r, 10));
    expect(fetchJSON).toHaveBeenCalledTimes(1);
  });
});

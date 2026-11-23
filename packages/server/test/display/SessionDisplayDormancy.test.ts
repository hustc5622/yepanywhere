import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DisplaySourcePage,
  SessionDisplayService,
} from "../../src/display/SessionDisplayService.js";
import type { SessionDisplayCacheState } from "../../src/display/display-timing.js";
import type { Message } from "../../src/supervisor/types.js";

const selection = { projectId: "project", sessionId: "session" };

function page(
  activity: DisplaySourcePage["activity"],
  stamp = "1",
): DisplaySourcePage {
  return {
    provider: "codex",
    messages: [
      {
        uuid: "u",
        type: "user",
        codexTurnId: "turn",
        message: { role: "user", content: "Run" },
      },
    ] as Message[],
    turnStatuses: activity === "completed" ? { turn: "completed" } : undefined,
    activity,
    stamp,
  };
}

const services: SessionDisplayService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});

function fixture(
  options: {
    activity?: DisplaySourcePage["activity"];
    maxDormantEntries?: number;
    maxDormantBytes?: number;
  } = {},
) {
  let stamp = "1";
  let activity = options.activity ?? "completed";
  const source = {
    stamp: vi.fn(async () => stamp),
    read: vi.fn(async () => page(activity, stamp)),
    detail: vi.fn(async () => [] as Message[]),
  };
  let process: { id: string } | null = null;
  const runtime = {
    getProcessForSession: vi.fn(async () => process as never),
    subscribeSession: vi.fn(async () => ({ cleanup: vi.fn() })),
  };
  const service = new SessionDisplayService({
    runtime,
    pollMs: 60_000,
    retentionMs: 1_000,
    maxDormantEntries: options.maxDormantEntries,
    maxDormantBytes: options.maxDormantBytes,
  });
  service.configureSource(source);
  services.push(service);
  return {
    service,
    source,
    runtime,
    setStamp: (value: string) => {
      stamp = value;
    },
    setActivity: (value: DisplaySourcePage["activity"]) => {
      activity = value;
    },
    setProcess: (value: { id: string } | null) => {
      process = value;
    },
  };
}

async function open(
  service: SessionDisplayService,
  target: typeof selection = selection,
) {
  const states: SessionDisplayCacheState[] = [];
  const snapshot = await service.snapshot(target, false, {
    onCacheState: (state) => states.push(state),
  });
  return { snapshot, state: states.at(-1) };
}

describe("SessionDisplayService dormant views", () => {
  it("revives a settled view after expiry without reading history", async () => {
    vi.useFakeTimers();
    const t = fixture();
    const first = await open(t.service);
    expect(first.state).toBe("miss");
    await vi.advanceTimersByTimeAsync(1_000);

    const second = await open(t.service);
    expect(second.state).toBe("revived");
    expect(t.source.read).toHaveBeenCalledTimes(1);
    // Same projection identity: clients keep their cached epoch and sequence.
    expect(second.snapshot.view.epoch).toBe(first.snapshot.view.epoch);
    expect(second.snapshot.seq).toBe(first.snapshot.seq);

    // Revived views are live again: a later open is a plain hit.
    expect((await open(t.service)).state).toBe("hit");
  });

  it("re-reads under a new epoch when the source changed while dormant", async () => {
    vi.useFakeTimers();
    const t = fixture();
    const first = await open(t.service);
    await vi.advanceTimersByTimeAsync(1_000);
    t.setStamp("2");
    const second = await open(t.service);
    expect(second.state).toBe("miss");
    expect(t.source.read).toHaveBeenCalledTimes(2);
    expect(second.snapshot.view.epoch).not.toBe(first.snapshot.view.epoch);
  });

  it("cold-initializes when a runtime process started while dormant", async () => {
    vi.useFakeTimers();
    const t = fixture();
    await open(t.service);
    await vi.advanceTimersByTimeAsync(1_000);
    t.setProcess({ id: "process" });
    expect((await open(t.service)).state).toBe("miss");
    expect(t.source.read).toHaveBeenCalledTimes(2);
    expect(t.runtime.subscribeSession).toHaveBeenCalledTimes(1);
  });

  it("drops views that may still change through live events", async () => {
    vi.useFakeTimers();
    const t = fixture({ activity: "running" });
    await open(t.service);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await open(t.service)).state).toBe("miss");
    expect(t.source.read).toHaveBeenCalledTimes(2);
  });

  it("drops views that own a live runtime subscription", async () => {
    vi.useFakeTimers();
    const t = fixture();
    t.setProcess({ id: "process" });
    await open(t.service);
    await vi.advanceTimersByTimeAsync(1_000);
    t.setProcess(null);
    expect((await open(t.service)).state).toBe("miss");
  });

  it("bounds dormant views by count and bytes", async () => {
    vi.useFakeTimers();
    const t = fixture({ maxDormantEntries: 1 });
    const a = selection;
    const b = { projectId: "project", sessionId: "other" };
    await open(t.service, a);
    await open(t.service, b);
    await vi.advanceTimersByTimeAsync(1_000);
    // Only the most recently expired view survives the count bound.
    expect((await open(t.service, a)).state).toBe("miss");

    const tiny = fixture({ maxDormantBytes: 10 });
    await open(tiny.service);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await open(tiny.service)).state).toBe("miss");

    const disabled = fixture({ maxDormantEntries: 0 });
    await open(disabled.service);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await open(disabled.service)).state).toBe("miss");
  });

  it("shares one revival between concurrent openers", async () => {
    vi.useFakeTimers();
    const t = fixture();
    await open(t.service);
    await vi.advanceTimersByTimeAsync(1_000);
    const stamps = t.source.stamp.mock.calls.length;
    const [x, y] = await Promise.all([open(t.service), open(t.service)]);
    expect([x.state, y.state].sort()).toEqual(["revived", "wait"]);
    expect(t.source.stamp.mock.calls.length - stamps).toBe(1);
    expect(t.source.read).toHaveBeenCalledTimes(1);
  });

  it("answers a subscriber holding the current projection with a marker", async () => {
    vi.useFakeTimers();
    const t = fixture();
    const first = await open(t.service);
    await vi.advanceTimersByTimeAsync(1_000);
    const known = { epoch: first.snapshot.view.epoch, seq: first.snapshot.seq };
    const events: string[] = [];
    const sub = await t.service.subscribe(
      selection,
      (type) => events.push(type),
      undefined,
      known,
    );
    expect(events).toContain("display-current");
    expect(events).not.toContain("display-snapshot");
    sub.cleanup();

    const stale: string[] = [];
    const other = await t.service.subscribe(
      selection,
      (type) => stale.push(type),
      undefined,
      { epoch: known.epoch, seq: known.seq - 1 },
    );
    expect(stale).toContain("display-snapshot");
    expect(stale).not.toContain("display-current");
    other.cleanup();
  });

  it("checks source stamp on active hit in snapshot() and subscribe()", async () => {
    vi.useFakeTimers();
    const t = fixture();
    const first = await open(t.service);
    expect(t.source.read).toHaveBeenCalledTimes(1);

    // Unchanged stamp on an active hit reuses the projection without reading.
    const warm = await open(t.service);
    expect(warm.state).toBe("hit");
    expect(t.source.read).toHaveBeenCalledTimes(1);

    // When the file changes while the entry is still active, snapshot()
    // refreshes immediately instead of returning stale memory.
    t.setStamp("2");
    t.source.read.mockResolvedValueOnce({
      ...page("completed", "2"),
      messages: [
        ...page("completed", "2").messages,
        {
          uuid: "u2",
          type: "user",
          codexTurnId: "turn-2",
          message: { role: "user", content: "Follow up" },
        } as Message,
      ],
      turnStatuses: { turn: "completed", "turn-2": "completed" },
    });
    const refreshed = await open(t.service);
    expect(refreshed.state).toBe("hit");
    expect(t.source.read).toHaveBeenCalledTimes(2);
    expect(refreshed.snapshot.nodes.some((n) => n.id === "question:u2")).toBe(
      true,
    );

    // Similarly, subscribe() refreshes on a changed stamp rather than replying
    // display-current for the client's now-stale version.
    const knownBefore = {
      epoch: refreshed.snapshot.view.epoch,
      seq: refreshed.snapshot.seq,
    };
    t.setStamp("3");
    t.source.read.mockResolvedValueOnce({
      ...page("completed", "3"),
      messages: [
        ...page("completed", "3").messages,
        {
          uuid: "u2",
          type: "user",
          codexTurnId: "turn-2",
          message: { role: "user", content: "Follow up" },
        } as Message,
        {
          uuid: "u3",
          type: "user",
          codexTurnId: "turn-3",
          message: { role: "user", content: "Third" },
        } as Message,
      ],
      turnStatuses: {
        turn: "completed",
        "turn-2": "completed",
        "turn-3": "completed",
      },
    });
    const events: Array<{ type: string; data: unknown }> = [];
    const sub = await t.service.subscribe(
      selection,
      (type, data) => events.push({ type, data }),
      undefined,
      knownBefore,
    );
    expect(events.map((e) => e.type)).toContain("display-snapshot");
    expect(events.map((e) => e.type)).not.toContain("display-current");
    const delivered = events.find((e) => e.type === "display-snapshot")?.data as
      | { nodes: Array<{ id: string }> }
      | undefined;
    expect(delivered?.nodes.some((n) => n.id === "question:u3")).toBe(true);
    sub.cleanup();
  });
});

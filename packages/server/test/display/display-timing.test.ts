import { afterEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../src/logging/logger.js", () => ({
  getLogger: () => loggerMock,
}));

import {
  type DisplaySourcePage,
  SessionDisplayService,
} from "../../src/display/SessionDisplayService.js";
import {
  type SessionDisplayCacheState,
  SessionDisplayPhaseTotals,
  type SessionDisplayTimingName,
  type SessionDisplayTimingSink,
} from "../../src/display/display-timing.js";
import type { Message } from "../../src/supervisor/types.js";

const selection = { projectId: "project", sessionId: "session" };
const page: DisplaySourcePage = {
  provider: "codex",
  messages: [
    {
      uuid: "u",
      type: "user",
      codexTurnId: "turn",
      message: { role: "user", content: "Run" },
    },
  ] as Message[],
  activity: "completed",
  stamp: "1",
};

const services: SessionDisplayService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  loggerMock.info.mockClear();
});

function observe() {
  const states: SessionDisplayCacheState[] = [];
  const phases = new Map<SessionDisplayTimingName, number>();
  const timing: SessionDisplayTimingSink = {
    add: (name, ms) => phases.set(name, (phases.get(name) ?? 0) + ms),
  };
  return {
    states,
    phases,
    observer: {
      timing,
      onCacheState: (s: SessionDisplayCacheState) => states.push(s),
    },
  };
}

function fixture(
  read: (timing?: SessionDisplayTimingSink) => Promise<DisplaySourcePage>,
  slowInitializeMs?: number,
) {
  const source = {
    stamp: vi.fn(async (_s: unknown, timing?: SessionDisplayTimingSink) => {
      timing?.add("stamp", 1);
      return "1";
    }),
    read: vi.fn(
      async (_s: unknown, _c?: string, timing?: SessionDisplayTimingSink) =>
        read(timing),
    ),
    detail: vi.fn(async () => [] as Message[]),
  };
  const runtime = {
    getProcessForSession: vi.fn(async () => null),
    subscribeSession: vi.fn(async () => null),
  };
  const service = new SessionDisplayService({
    runtime,
    pollMs: 60_000,
    slowInitializeMs,
  });
  service.configureSource(source);
  services.push(service);
  return { service, source };
}

describe("session display read observation", () => {
  it("attributes cold phases to the initializing request only", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = fixture(async (timing) => {
      timing?.add("read", 7);
      await gate;
      return page;
    });
    const first = observe();
    const second = observe();
    const cold = service.snapshot(selection, false, first.observer);
    const waiting = service.snapshot(selection, false, second.observer);
    release();
    await Promise.all([cold, waiting]);

    expect(first.states).toEqual(["miss"]);
    expect(first.phases.get("read")).toBe(7);
    // A cold read always reads the source; it has no stamp to compare.
    expect(first.phases.has("stamp")).toBe(false);
    for (const name of ["attach", "reduce", "replay"] as const)
      expect(first.phases.has(name)).toBe(true);

    expect(second.states).toEqual(["wait"]);
    expect([...second.phases.keys()]).toEqual(["wait"]);

    const warm = observe();
    await service.snapshot(selection, false, warm.observer);
    expect(warm.states).toEqual(["hit"]);
    expect(warm.phases.size).toBe(0);
  });

  it("logs a slow cold read with its phase breakdown", async () => {
    const { service } = fixture(async (timing) => {
      timing?.add("read", 3);
      return page;
    }, 0);
    await service.snapshot(selection);
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    const [fields] = loggerMock.info.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      event: "session_display_cold_read",
      sessionId: "session",
      provider: "codex",
      failed: false,
      nodeCount: 1,
    });
    expect(fields.phases).toMatchObject({ read: 3 });
    expect(fields.phases).not.toHaveProperty("stamp");

    // A warm read does not log again.
    await service.snapshot(selection);
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
  });

  it("does not log fast cold reads", async () => {
    const { service } = fixture(async () => page, 60_000);
    await service.snapshot(selection);
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it("logs failed cold reads with the error code and drops the entry", async () => {
    const failure = Object.assign(new Error("missing"), {
      code: "SESSION_NOT_FOUND",
    });
    let fail = true;
    const { service, source } = fixture(async () => {
      if (fail) throw failure;
      return page;
    }, 60_000);
    await expect(service.snapshot(selection)).rejects.toBe(failure);
    expect(loggerMock.info.mock.calls[0]?.[0]).toMatchObject({
      failed: true,
      errorCode: "SESSION_NOT_FOUND",
    });
    fail = false;
    const retry = observe();
    await service.snapshot(selection, false, retry.observer);
    expect(retry.states).toEqual(["miss"]);
    expect(source.read).toHaveBeenCalledTimes(2);
  });
});

describe("SessionDisplayPhaseTotals", () => {
  it("accumulates, forwards and rounds phase durations", () => {
    const forwarded: Array<[string, number]> = [];
    const totals = new SessionDisplayPhaseTotals({
      add: (name, ms) => forwarded.push([name, ms]),
    });
    totals.add("read", 1.234);
    totals.add("read", 2);
    totals.add("stamp", -5);
    totals.add("reduce", Number.NaN);
    expect(totals.rounded()).toEqual({ read: 3.2, stamp: 0 });
    expect(forwarded).toEqual([
      ["read", 1.234],
      ["read", 2],
      ["stamp", 0],
    ]);
  });
});

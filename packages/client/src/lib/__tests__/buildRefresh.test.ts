import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RELOADS_PER_WINDOW,
  RELOAD_COOLDOWN_MS,
  RELOAD_WINDOW_MS,
  canAutoReload,
  nextAutoReloadRecord,
  parseAutoReloadRecord,
} from "../buildRefresh";

describe("auto reload guard", () => {
  const now = 1_000_000_000;

  it("allows the first reload and documents revived from history", () => {
    expect(canAutoReload(null, now, false)).toBe(true);
    const fresh = { firstAt: now, lastAt: now, count: 1 };
    expect(canAutoReload(fresh, now + 1, false)).toBe(false);
    expect(canAutoReload(fresh, now + 1, true)).toBe(true);
  });

  it("holds back during the cooldown and after repeated reloads", () => {
    const record = { firstAt: now, lastAt: now, count: 1 };
    expect(canAutoReload(record, now + RELOAD_COOLDOWN_MS - 1, false)).toBe(
      false,
    );
    expect(canAutoReload(record, now + RELOAD_COOLDOWN_MS, false)).toBe(true);

    const exhausted = {
      firstAt: now,
      lastAt: now,
      count: MAX_RELOADS_PER_WINDOW,
    };
    expect(canAutoReload(exhausted, now + RELOAD_COOLDOWN_MS, false)).toBe(
      false,
    );
    expect(canAutoReload(exhausted, now + RELOAD_WINDOW_MS, false)).toBe(true);
  });

  it("counts reloads per window and starts a new window when it expires", () => {
    const first = nextAutoReloadRecord(null, now);
    expect(first).toEqual({ firstAt: now, lastAt: now, count: 1 });
    expect(nextAutoReloadRecord(first, now + 5)).toEqual({
      firstAt: now,
      lastAt: now + 5,
      count: 2,
    });
    expect(nextAutoReloadRecord(first, now + RELOAD_WINDOW_MS)).toEqual({
      firstAt: now + RELOAD_WINDOW_MS,
      lastAt: now + RELOAD_WINDOW_MS,
      count: 1,
    });
  });

  it("treats legacy and malformed markers as absent", () => {
    expect(parseAutoReloadRecord("1")).toBeNull();
    expect(parseAutoReloadRecord("{")).toBeNull();
    expect(parseAutoReloadRecord(null)).toBeNull();
    expect(
      parseAutoReloadRecord(
        JSON.stringify({ firstAt: 1, lastAt: 2, count: 1 }),
      ),
    ).toEqual({ firstAt: 1, lastAt: 2, count: 1 });
  });
});

describe("checkForNewBuild", () => {
  const serverBuildId = "server-build";

  async function load(navigationType: string) {
    vi.resetModules();
    vi.stubGlobal("__BUILD_ID__", "client-build");
    vi.stubGlobal("__BUILD_PROFILE__", "production");
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { type: navigationType } as PerformanceNavigationTiming,
    ]);
    const module = await import("../buildRefresh");
    const reload = vi.fn();
    module.setReloadPageForTests(reload);
    return { module, reload };
  }

  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ buildId: serverBuildId })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reloads once, then lets a stale reload result stay put", async () => {
    const first = await load("navigate");
    await expect(first.module.checkForNewBuild()).resolves.toEqual({
      status: "reloading",
      serverBuildId,
    });
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The reloaded document still runs the old bundle (e.g. a stale cache).
    const second = await load("reload");
    await expect(second.module.checkForNewBuild()).resolves.toEqual({
      status: "stale",
      serverBuildId,
    });
    expect(second.reload).not.toHaveBeenCalled();
  });

  it("reloads an old document revived from history despite an earlier reload", async () => {
    sessionStorage.setItem(
      `yep-anywhere:auto-reloaded:client-build->${serverBuildId}`,
      JSON.stringify({ firstAt: Date.now(), lastAt: Date.now(), count: 1 }),
    );
    const { module, reload } = await load("back_forward");
    await expect(module.checkForNewBuild()).resolves.toEqual({
      status: "reloading",
      serverBuildId,
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the server serves this build", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ buildId: "client-build" })),
    );
    const { module, reload } = await load("navigate");
    await expect(module.checkForNewBuild()).resolves.toEqual({
      status: "current",
      serverBuildId: "client-build",
    });
    expect(reload).not.toHaveBeenCalled();
  });
});

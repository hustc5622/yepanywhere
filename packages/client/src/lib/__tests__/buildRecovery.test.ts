import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BuildRecoveryDeps,
  checkForBuildRecovery,
  installBuildRecoveryListeners,
} from "../buildRecovery";

type MakeDepsOptions = Partial<BuildRecoveryDeps> & {
  serverBuildId?: string;
};

function buildInfoResponse(buildId: string): Response {
  return new Response(JSON.stringify({ buildId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function makeDeps(options: MakeDepsOptions = {}) {
  const serverBuildId = options.serverBuildId ?? "server-b";
  return {
    baseUrl: options.baseUrl ?? "/",
    currentBuildId: options.currentBuildId ?? "client-a",
    buildProfile: options.buildProfile ?? "stable",
    fetchImpl:
      options.fetchImpl ?? vi.fn(async () => buildInfoResponse(serverBuildId)),
    storage: options.storage ?? makeStorage(),
    reload: options.reload ?? vi.fn(),
    now: options.now ?? vi.fn(() => 123_456),
  } satisfies BuildRecoveryDeps;
}

function promiseRejectionEvent(reason: unknown): PromiseRejectionEvent {
  const event = new Event("unhandledrejection", {
    cancelable: true,
  }) as PromiseRejectionEvent;
  Object.defineProperty(event, "reason", { value: reason });
  return event;
}

const removeListeners: Array<() => void> = [];

afterEach(() => {
  for (const remove of removeListeners.splice(0)) remove();
  vi.restoreAllMocks();
});

describe("checkForBuildRecovery", () => {
  it("reloads a mismatched deployed build once with a normalized base URL", async () => {
    const deps = makeDeps({
      baseUrl: "/yep/",
      currentBuildId: "client-a",
      serverBuildId: "server-b",
    });

    await expect(
      checkForBuildRecovery("vite-preload-error", deps),
    ).resolves.toBe("reloaded");
    expect(deps.fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/^\/yep\/build-info\.json\?fresh=1&t=/),
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
    expect(deps.storage.setItem).toHaveBeenCalledWith(
      "yep-anywhere:auto-reloaded:client-a->server-b:build-mismatch",
      "1",
    );
    expect(deps.reload).toHaveBeenCalledTimes(1);

    await expect(
      checkForBuildRecovery("vite-preload-error", deps),
    ).resolves.toBe("already-reloaded");
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("normalizes a base path without a trailing slash", async () => {
    const deps = makeDeps({ baseUrl: "/yep" });

    await checkForBuildRecovery("routine", deps);

    expect(deps.fetchImpl).toHaveBeenCalledWith(
      "/yep/build-info.json?fresh=1&t=123456",
      expect.any(Object),
    );
  });

  it("reports a routine check as current when build identities match", async () => {
    const deps = makeDeps({ serverBuildId: "client-a" });

    await expect(checkForBuildRecovery("routine", deps)).resolves.toBe(
      "current",
    );
    expect(deps.storage.getItem).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("reloads once for a same-build dynamic import failure", async () => {
    const deps = makeDeps({ serverBuildId: "client-a" });

    await expect(
      checkForBuildRecovery("dynamic-import-error", deps),
    ).resolves.toBe("reloaded");
    expect(deps.storage.setItem).toHaveBeenCalledWith(
      "yep-anywhere:auto-reloaded:client-a->client-a:dynamic-import-error",
      "1",
    );
    await expect(
      checkForBuildRecovery("dynamic-import-error", deps),
    ).resolves.toBe("already-reloaded");
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when build metadata cannot be fetched", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    await expect(
      checkForBuildRecovery("dynamic-import-error", deps),
    ).resolves.toBe("unavailable");
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("is disabled for the dev profile", async () => {
    const deps = makeDeps({ buildProfile: "dev" });

    await expect(
      checkForBuildRecovery("vite-preload-error", deps),
    ).resolves.toBe("disabled");
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("stops recovery when storage cannot be read", async () => {
    const deps = makeDeps({
      storage: {
        getItem: vi.fn(() => {
          throw new Error("blocked");
        }),
        setItem: vi.fn(),
      },
    });

    await expect(
      checkForBuildRecovery("vite-preload-error", deps),
    ).resolves.toBe("unavailable");
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("writes the recovery marker before reloading", async () => {
    const storage = makeStorage();
    const reload = vi.fn();
    const deps = makeDeps({ storage, reload });

    await checkForBuildRecovery("vite-preload-error", deps);

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    const markerCallOrder = storage.setItem.mock.invocationCallOrder[0];
    const reloadCallOrder = reload.mock.invocationCallOrder[0];
    if (markerCallOrder === undefined || reloadCallOrder === undefined) {
      throw new Error("expected both marker and reload calls");
    }
    expect(markerCallOrder).toBeLessThan(reloadCallOrder);
  });

  it("stops recovery when the marker cannot be written", async () => {
    const deps = makeDeps({
      storage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error("blocked");
        }),
      },
    });

    await expect(
      checkForBuildRecovery("vite-preload-error", deps),
    ).resolves.toBe("unavailable");
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("preserves the current pathname, query, and hash by using reload", async () => {
    const navigation = {
      currentUrl: "/yep/projects/p/sessions/s?tab=files#tail",
      reload: vi.fn(),
    };
    const deps = makeDeps({ reload: navigation.reload });

    await checkForBuildRecovery("vite-preload-error", deps);

    expect(navigation.reload).toHaveBeenCalledTimes(1);
    expect(navigation.currentUrl).toBe(
      "/yep/projects/p/sessions/s?tab=files#tail",
    );
  });
});

describe("installBuildRecoveryListeners", () => {
  it("cancels a Vite preload error synchronously before recovery completes", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const deps = makeDeps({
      fetchImpl: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    });
    const remove = installBuildRecoveryListeners(deps);
    removeListeners.push(remove);
    const event = new Event("vite:preloadError", { cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(deps.reload).not.toHaveBeenCalled();
    resolveFetch?.(buildInfoResponse("client-a"));
    await vi.waitFor(() => expect(deps.reload).toHaveBeenCalledTimes(1));

    remove();
    window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a rejected Error from Safari",
      () =>
        promiseRejectionEvent(
          new Error("Importing a module script failed from /assets/page.js"),
        ),
    ],
    [
      "a rejected string from Chromium",
      () =>
        promiseRejectionEvent(
          "Failed to fetch dynamically imported module: /assets/page.js",
        ),
    ],
    [
      "an ErrorEvent message from Safari",
      () =>
        new ErrorEvent("error", {
          message: "Importing a module script failed from /assets/page.js",
        }),
    ],
    [
      "an ErrorEvent error from Chromium",
      () =>
        new ErrorEvent("error", {
          error: new Error(
            "Failed to fetch dynamically imported module: /assets/page.js",
          ),
        }),
    ],
  ])("checks the build for %s", async (_name, makeEvent) => {
    const deps = makeDeps({ serverBuildId: "client-a" });
    const remove = installBuildRecoveryListeners(deps);
    removeListeners.push(remove);

    window.dispatchEvent(makeEvent());

    await vi.waitFor(() => expect(deps.fetchImpl).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(deps.reload).toHaveBeenCalledTimes(1));
  });

  it("ignores unrelated promise rejections and window errors", async () => {
    const deps = makeDeps();
    const remove = installBuildRecoveryListeners(deps);
    removeListeners.push(remove);

    window.dispatchEvent(promiseRejectionEvent(new Error("socket closed")));
    window.dispatchEvent(
      new ErrorEvent("error", { message: "ordinary render failure" }),
    );
    await Promise.resolve();

    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });
});

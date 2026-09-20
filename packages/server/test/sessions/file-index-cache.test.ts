import { describe, expect, it, vi } from "vitest";
import { FileIndexCache } from "../../src/sessions/file-index-cache.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("file index concurrent reads", () => {
  it("coalesces cold reads and keeps session/branch keys separate", async () => {
    const cache = new FileIndexCache<string>(32);
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);
    const a = cache.get("session:a", "v1", load);
    const b = cache.get("session:a", "v1", load);
    expect(a).toBe(b);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.get("session:b", "v1", async () => "branch b")).toBe(
      "branch b",
    );
    pending.resolve("branch a");
    expect(await a).toBe("branch a");
    expect(await cache.get("session:a", "v1", load)).toBe("branch a");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)(
    "old version %s cannot displace a new result",
    async (outcome) => {
      const cache = new FileIndexCache<string>(32);
      const pending = deferred<string>();
      const old = cache.get("session", "v1", () => pending.promise);
      const caught = old.catch(() => "failed");
      expect(await cache.get("session", "v2", async () => "new")).toBe("new");
      if (outcome === "resolve") pending.resolve("old");
      else pending.reject(new Error("old failed"));
      await caught;
      const unexpected = vi.fn(async () => "rescanned");
      expect(await cache.get("session", "v2", unexpected)).toBe("new");
      expect(unexpected).not.toHaveBeenCalled();
    },
  );

  it("retries failures and bounds retained keys", async () => {
    const cache = new FileIndexCache<string>(2);
    await expect(
      cache.get("a", "v1", async () => {
        throw new Error("retry");
      }),
    ).rejects.toThrow("retry");
    expect(await cache.get("a", "v1", async () => "a")).toBe("a");
    await cache.get("b", "v1", async () => "b");
    await cache.get("a", "v2", async () => "new a");
    await cache.get("c", "v1", async () => "c");
    const load = vi.fn(async () => "b reloaded");
    expect(await cache.get("b", "v1", load)).toBe("b reloaded");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

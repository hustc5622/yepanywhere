import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withDirLock } from "../../src/utils/dirLock.js";

describe("withDirLock", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("serializes holders and releases the lock", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "dir-lock-"));
    dirs.push(dir);
    const lockPath = join(dir, "index.lock");
    let holders = 0;
    let maxHolders = 0;
    const options = { timeoutMs: 5_000, staleMs: 10_000, label: "test lock" };
    const hold = () =>
      withDirLock(lockPath, options, async () => {
        holders += 1;
        maxHolders = Math.max(maxHolders, holders);
        await new Promise((resolve) => setTimeout(resolve, 20));
        holders -= 1;
      });
    // Which caller wins mkdir first is up to the filesystem; they must
    // never hold the lock at the same time.
    await Promise.all([hold(), hold(), hold()]);
    expect(maxHolders).toBe(1);
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)(
    "times out instead of spinning on a stale lock it cannot remove",
    async () => {
      const dir = await fs.mkdtemp(join(tmpdir(), "dir-lock-stale-"));
      dirs.push(dir);
      const parent = join(dir, "readonly");
      const lockPath = join(parent, "index.lock");
      await fs.mkdir(lockPath, { recursive: true });
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, old, old);
      // A read-only parent makes removing the stale lock fail (EACCES).
      await fs.chmod(parent, 0o555);
      try {
        const started = Date.now();
        await expect(
          withDirLock(
            lockPath,
            { timeoutMs: 100, staleMs: 1_000, label: "test lock", retryMs: 10 },
            async () => "acquired",
          ),
        ).rejects.toThrow(/Timed out acquiring test lock/);
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        await fs.chmod(parent, 0o755);
      }
    },
  );
});

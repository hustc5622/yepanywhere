import { describe, expect, it, vi } from "vitest";
import {
  GitStatusSummaryCache,
  parseGitStatusSummary,
} from "../src/git-status-summary.js";

describe("parseGitStatusSummary", () => {
  it("summarizes branch state and working tree counts", () => {
    const summary = parseGitStatusSummary(
      `# branch.oid abc123456789
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 M. N... 100644 100644 100644 aaaaaa bbbbbb src/staged.ts
1 .M N... 100644 100644 100644 aaaaaa bbbbbb src/changed.ts
1 MM N... 100644 100644 100644 aaaaaa bbbbbb src/both.ts
1 .D N... 100644 100644 000000 aaaaaa bbbbbb deleted.txt
? src/new.ts
? scratch/
u UU N... 100644 100644 100644 100644 aaaaaa bbbbbb cccccc src/conflict.ts
`,
      2,
    );

    expect(summary).toEqual({
      isGitRepo: true,
      branch: "main",
      head: "abc1234",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      isClean: false,
      stagedCount: 2,
      unstagedCount: 2,
      deletedCount: 1,
      untrackedCount: 2,
      conflictedCount: 1,
      stashCount: 2,
    });
  });

  it("handles detached clean worktrees", () => {
    const summary = parseGitStatusSummary(`# branch.oid abc123
# branch.head (detached)
`);

    expect(summary).toMatchObject({
      isGitRepo: true,
      branch: null,
      head: "abc123",
      isClean: true,
      stagedCount: 0,
      unstagedCount: 0,
      deletedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      stashCount: 0,
    });
  });
});

describe("GitStatusSummaryCache", () => {
  const summaryFor = (head: string) =>
    parseGitStatusSummary(`# branch.oid ${head}\n# branch.head main\n`);

  it("serves cached summaries within the TTL without recomputing", async () => {
    const compute = vi.fn(async (_path: string) => summaryFor("aaaaaaa"));
    const cache = new GitStatusSummaryCache({ ttlMs: 1_000, compute });

    const first = await cache.get("/repo");
    const second = await cache.get("/repo");

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("recomputes after the TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const compute = vi.fn(async (_path: string) => summaryFor("aaaaaaa"));
      const cache = new GitStatusSummaryCache({ ttlMs: 1_000, compute });

      await cache.get("/repo");
      vi.advanceTimersByTime(1_500);
      await cache.get("/repo");

      expect(compute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates concurrent in-flight requests for the same path", async () => {
    let resolve: ((value: null) => void) | undefined;
    const compute = vi.fn(
      (_path: string) =>
        new Promise<null>((r) => {
          resolve = r;
        }),
    );
    const cache = new GitStatusSummaryCache({ ttlMs: 1_000, compute });

    const a = cache.get("/repo");
    const b = cache.get("/repo");
    expect(compute).toHaveBeenCalledTimes(1);

    resolve?.(null);
    expect(await a).toBeNull();
    expect(await b).toBeNull();
  });

  it("keeps separate entries per project path", async () => {
    const compute = vi.fn(async (path: string) =>
      summaryFor(path === "/a" ? "aaaaaaa" : "bbbbbbb"),
    );
    const cache = new GitStatusSummaryCache({ ttlMs: 1_000, compute });

    const a = await cache.get("/a");
    const b = await cache.get("/b");

    expect(compute).toHaveBeenCalledTimes(2);
    expect(a?.head).toBe("aaaaaaa");
    expect(b?.head).toBe("bbbbbbb");
  });

  it("recomputes after invalidate() and clear()", async () => {
    const compute = vi.fn(async (_path: string) => summaryFor("aaaaaaa"));
    const cache = new GitStatusSummaryCache({ ttlMs: 60_000, compute });

    await cache.get("/repo");
    cache.invalidate("/repo");
    await cache.get("/repo");
    cache.clear();
    await cache.get("/repo");

    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("re-runs after a rejected computation instead of caching the failure", async () => {
    const compute = vi
      .fn<(path: string) => Promise<null>>()
      .mockRejectedValueOnce(new Error("git blew up"))
      .mockResolvedValueOnce(null);
    const cache = new GitStatusSummaryCache({ ttlMs: 60_000, compute });

    await expect(cache.get("/repo")).rejects.toThrow("git blew up");
    await expect(cache.get("/repo")).resolves.toBeNull();
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

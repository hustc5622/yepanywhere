import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Recorded child-process invocations, in call order.
 *
 * The probe is the only place in the server that shells out on a timer for
 * every tracked external session, so these tests assert on the *number* of
 * spawns rather than only on the returned verdict: the regression that made
 * every HTTP request multi-second slow was a spawn storm, not a wrong answer.
 */
const calls: Array<{ command: string; args: string[] }> = [];
let psStdout = "";
let lsofStdout = "";
let psDelayMs = 0;

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  // `promisify(execFile)` resolves to `{ stdout, stderr }` only through the
  // custom promisified implementation Node attaches to the real export.
  const execFile = Object.assign(
    (_command: string, _args: string[]) => undefined,
    {
      [promisify.custom]: (command: string, args: string[]) => {
        calls.push({ command, args });
        const result = () => {
          if (command === "ps") return { stdout: psStdout, stderr: "" };
          if (command === "lsof") return { stdout: lsofStdout, stderr: "" };
          throw new Error(`unexpected command: ${command}`);
        };
        if (command === "ps" && psDelayMs > 0) {
          return new Promise((resolve) => {
            setTimeout(() => resolve(result()), psDelayMs);
          });
        }
        return Promise.resolve(result());
      },
    },
  );
  return { execFile };
});

const { hasActiveExternalProviderProcess, resetExternalProcessProbeCache } =
  await import("../../src/supervisor/externalProcessProbe.js");

function lsofFieldOutput(entries: Array<[number, string]>): string {
  return entries.map(([pid, cwd]) => `p${pid}\nfcwd\nn${cwd}`).join("\n");
}

describe("externalProcessProbe", () => {
  beforeEach(() => {
    calls.length = 0;
    psDelayMs = 0;
    resetExternalProcessProbeCache();
    psStdout = ["  101 claude", "  102 codex", "  103 unrelated-tool"].join(
      "\n",
    );
    lsofStdout = lsofFieldOutput([
      [101, "/tmp/project"],
      [102, "/tmp/other"],
    ]);
  });

  it("resolves every candidate cwd with a single batched lsof call", async () => {
    const active = await hasActiveExternalProviderProcess({
      provider: "claude",
      projectPath: "/tmp/project",
    });

    expect(active).toBe(true);
    expect(calls.filter((call) => call.command === "lsof")).toHaveLength(1);
    expect(calls.at(-1)?.args).toEqual([
      "-a",
      "-p",
      "101,102",
      "-d",
      "cwd",
      "-Fpn",
    ]);
  });

  it("distinguishes a matching provider in another project", async () => {
    await expect(
      hasActiveExternalProviderProcess({
        provider: "codex",
        projectPath: "/tmp/project",
      }),
    ).resolves.toBe(false);
  });

  it("shares one process sweep across concurrent callers", async () => {
    psDelayMs = 10;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        hasActiveExternalProviderProcess({
          provider: "claude",
          projectPath: "/tmp/project",
        }),
      ),
    );

    expect(results).toEqual(Array.from({ length: 8 }, () => true));
    expect(calls.filter((call) => call.command === "ps")).toHaveLength(1);
    expect(calls.filter((call) => call.command === "lsof")).toHaveLength(1);
  });

  it("reuses memoized cwds when the snapshot is refreshed", async () => {
    vi.useFakeTimers();
    try {
      await hasActiveExternalProviderProcess({
        provider: "claude",
        projectPath: "/tmp/project",
      });
      vi.setSystemTime(Date.now() + 5_000);

      // Serves the stale snapshot while a refresh runs in the background.
      await hasActiveExternalProviderProcess({
        provider: "claude",
        projectPath: "/tmp/project",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.filter((call) => call.command === "ps")).toHaveLength(2);
      // The known pids stay memoized, so no second lsof is spawned.
      expect(calls.filter((call) => call.command === "lsof")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports no match when no provider process is running", async () => {
    psStdout = "  103 unrelated-tool";

    await expect(
      hasActiveExternalProviderProcess({
        provider: "claude",
        projectPath: "/tmp/project",
      }),
    ).resolves.toBe(false);
  });

  it("ignores excluded pids", async () => {
    await expect(
      hasActiveExternalProviderProcess({
        provider: "claude",
        projectPath: "/tmp/project",
        excludePids: [101],
      }),
    ).resolves.toBe(false);
  });
});

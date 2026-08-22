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
const procReadlinkCalls: string[] = [];
const procCwds = new Map<number, string>();
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

vi.mock("node:fs/promises", () => ({
  readlink: (target: string) => {
    procReadlinkCalls.push(target);
    const match = target.match(/^\/proc\/(\d+)\/cwd$/);
    const cwd = match?.[1]
      ? procCwds.get(Number.parseInt(match[1], 10))
      : undefined;
    return cwd
      ? Promise.resolve(cwd)
      : Promise.reject(new Error(`unreadable proc cwd: ${target}`));
  },
}));

const { hasActiveExternalProviderProcess, resetExternalProcessProbeCache } =
  await import("../../src/supervisor/externalProcessProbe.js");

function lsofFieldOutput(entries: Array<[number, string]>): string {
  return entries.map(([pid, cwd]) => `p${pid}\nfcwd\nn${cwd}`).join("\n");
}

function expectSingleCwdSweep(): void {
  const lsofCalls = calls.filter((call) => call.command === "lsof");
  if (process.platform === "linux") {
    expect(procReadlinkCalls).toEqual(["/proc/101/cwd", "/proc/102/cwd"]);
    expect(lsofCalls).toHaveLength(0);
    return;
  }

  expect(procReadlinkCalls).toHaveLength(0);
  expect(lsofCalls).toHaveLength(1);
  expect(lsofCalls[0]?.args).toEqual([
    "-a",
    "-p",
    "101,102",
    "-d",
    "cwd",
    "-Fpn",
  ]);
}

describe("externalProcessProbe", () => {
  beforeEach(() => {
    calls.length = 0;
    procReadlinkCalls.length = 0;
    procCwds.clear();
    procCwds.set(101, "/tmp/project");
    procCwds.set(102, "/tmp/other");
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

  it("resolves every candidate cwd with one platform-specific sweep", async () => {
    const active = await hasActiveExternalProviderProcess({
      provider: "claude",
      projectPath: "/tmp/project",
    });

    expect(active).toBe(true);
    expectSingleCwdSweep();
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
    expectSingleCwdSweep();
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
      // The known pids stay memoized, so no second platform cwd sweep runs.
      expectSingleCwdSweep();
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

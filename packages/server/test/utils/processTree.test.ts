import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  OWN_PROCESS_GROUP,
  terminateProcessTree,
} from "../../src/utils/processTree.js";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("terminateProcessTree", () => {
  it("also ends helpers the child forked", async () => {
    // The child forks a long-lived helper, prints its pid, then waits.
    const child = spawn("/bin/sh", ["-c", "sleep 60 & echo $!; wait"], {
      detached: OWN_PROCESS_GROUP,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const helperPid = await new Promise<number>((resolve) => {
      child.stdout.once("data", (chunk: Buffer) =>
        resolve(Number(chunk.toString().trim())),
      );
    });
    expect(isRunning(helperPid)).toBe(true);
    await terminateProcessTree(child, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isRunning(helperPid)).toBe(false);
  });

  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const child = spawn(
      "/bin/sh",
      ["-c", "trap '' TERM; sleep 60 & echo ready; wait"],
      { detached: OWN_PROCESS_GROUP, stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const started = Date.now();
    await terminateProcessTree(child, 200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(child.signalCode).toBe("SIGKILL");
    // No member of the group survives.
    const survivors = execFileSync("ps", ["-axo", "pgid="])
      .toString()
      .split("\n")
      .filter((line) => Number(line.trim()) === child.pid);
    expect(survivors).toEqual([]);
  });
});

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVENT_LOOP_WATCHDOG_ENV,
  eventLoopWatchdogStallMs,
  startEventLoopWatchdog,
} from "../../src/maintenance/event-loop-watchdog.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "stall-fixture.ts",
);

function runFixture(stallMs: number, killAfterMs: number) {
  return new Promise<{ signal: NodeJS.Signals | null; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", fixture, String(stallMs)],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const guard = setTimeout(() => child.kill("SIGTERM"), killAfterMs);
      child.on("exit", (_code, signal) => {
        clearTimeout(guard);
        resolve({ signal, stderr });
      });
    },
  );
}

describe("event-loop watchdog", () => {
  it("kills a process stuck in synchronous code and logs the stuck stack", async () => {
    const result = await runFixture(300, 15_000);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stderr).toContain("main thread stalled");
    expect(result.stderr).toContain("spinForever");
  }, 20_000);

  it("leaves a stuck process alone when disabled", async () => {
    const result = await runFixture(0, 1_500);
    expect(result.signal).toBe("SIGTERM");
    expect(result.stderr).not.toContain("EventLoopWatchdog");
  }, 10_000);

  it("is on by default only in production and honors the override", () => {
    expect(eventLoopWatchdogStallMs({ NODE_ENV: "production" })).toBe(30_000);
    expect(eventLoopWatchdogStallMs({ NODE_ENV: "development" })).toBe(0);
    expect(
      eventLoopWatchdogStallMs({
        NODE_ENV: "production",
        [EVENT_LOOP_WATCHDOG_ENV]: "0",
      }),
    ).toBe(0);
    expect(
      eventLoopWatchdogStallMs({ [EVENT_LOOP_WATCHDOG_ENV]: "45000" }),
    ).toBe(45_000);
    expect(
      eventLoopWatchdogStallMs({
        NODE_ENV: "production",
        [EVENT_LOOP_WATCHDOG_ENV]: "soon",
      }),
    ).toBe(30_000);
  });

  it("does not start when disabled", () => {
    expect(startEventLoopWatchdog("test", 0)).toBe(false);
  });
});

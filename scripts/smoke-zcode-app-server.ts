/**
 * ZCode app-server read-only smoke test.
 *
 * Discovers the ZCode CLI, starts an app-server child, sends only read-only
 * JSON-RPC methods (workspace/readState, session/list), and shuts down
 * cleanly.  No model calls, no session/create, no DB writes.
 *
 * Usage:
 *   corepack pnpm test:zcode-app-server-smoke -- --read-only
 *   corepack pnpm test:zcode-app-server-smoke -- --read-only --summary
 *
 * Output: version/capability status + session count (when --summary).
 * Never outputs session titles, prompts, tool content, or secrets.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  discoverZCodeCli,
  resolveZCodeLaunchCommand,
} from "../packages/server/src/sdk/providers/zcode-protocol/discovery.js";

const RESPONSE_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;

const args = process.argv.slice(2);
const isReadOnly = args.includes("--read-only");
const isSummary = args.includes("--summary");

if (!isReadOnly) {
  console.error("This smoke script requires --read-only to avoid model calls.");
  process.exit(1);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.stdin?.end();
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
  });
  await Promise.race([exited, timeout]);
  if (child.exitCode === null && !child.killed) child.kill();
}

async function readOnlySmoke(
  cliPath: string,
  isCjs: boolean,
): Promise<{ sessionCount: number; modelsCount: number }> {
  const launch = resolveZCodeLaunchCommand(cliPath);
  if (launch.isCjs !== isCjs) {
    // Should not happen, but fail loudly if it does.
    throw new Error("isCjs mismatch between discovery and launch command");
  }

  const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let stdoutBuffer = "";
  let sessionCount = 0;
  let modelsCount = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (handler: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        handler();
      };
      const timeoutHandle = setTimeout(() => {
        finish(() =>
          reject(new Error("Timed out waiting for ZCode app-server response")),
        );
      }, RESPONSE_TIMEOUT_MS);

      // Drain stderr without publishing provider diagnostics. CLI diagnostics
      // may contain credentials or user paths on malformed configurations.
      child.stderr?.resume();

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          let response: {
            id?: number;
            result?: unknown;
            error?: { message?: string };
          };
          try {
            response = JSON.parse(line) as typeof response;
          } catch {
            continue;
          }

          // id=1: workspace/readState response
          if (response.id === 1) {
            if (response.error) {
              finish(() =>
                reject(
                  new Error(
                    response.error?.message ?? "workspace/readState failed",
                  ),
                ),
              );
              return;
            }
            const result = response.result as
              | {
                  models?: unknown[];
                }
              | undefined;
            modelsCount = result?.models?.length ?? 0;
            // Now send session/list.
            child.stdin?.write(
              `${JSON.stringify({
                id: 2,
                method: "session/list",
                params: {},
              })}\n`,
            );
            return;
          }

          // id=2: session/list response
          if (response.id === 2) {
            if (response.error) {
              // session/list might fail on some versions; that's OK for smoke.
              finish(resolve);
              return;
            }
            const result = response.result as
              | {
                  sessions?: unknown[];
                }
              | undefined;
            sessionCount = result?.sessions?.length ?? 0;
            finish(resolve);
          }
        }
      });

      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code, signal) =>
        finish(() =>
          reject(
            new Error(
              `ZCode app-server exited before response (code=${code ?? "null"}, signal=${signal ?? "null"})`,
            ),
          ),
        ),
      );

      // Send workspace/readState.
      // Real CLI 0.16.1 requires `workspace: {workspacePath, workspaceKey}`.
      child.stdin?.write(
        `${JSON.stringify({
          id: 1,
          method: "workspace/readState",
          params: {
            workspace: {
              workspacePath: process.cwd(),
              workspaceKey: process.cwd(),
            },
          },
        })}\n`,
      );
    });
  } finally {
    await stopChild(child);
  }

  return { sessionCount, modelsCount };
}

// =============================================================================
// Main
// =============================================================================

const discovery = await discoverZCodeCli();

if (!discovery.path || discovery.errorCode) {
  console.error(
    `ZCode CLI unavailable: ${discovery.errorCode ?? "unknown error"}`,
  );
  process.exit(1);
}

console.log(
  `ZCode CLI found: version=${discovery.version}, source=${discovery.source}, isCjs=${discovery.isCjs}`,
);

try {
  const result = await readOnlySmoke(discovery.path, discovery.isCjs);
  if (isSummary) {
    console.log(
      `ZCode app-server smoke passed: models=${result.modelsCount}, sessions=${result.sessionCount}`,
    );
  } else {
    console.log("ZCode app-server smoke passed (read-only).");
  }
} catch (error) {
  console.error(
    `ZCode app-server smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

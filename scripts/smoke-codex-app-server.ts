import { type ChildProcess, spawn } from "node:child_process";
import {
  getCodexMcpAppServerArgs,
  resolveCodexMcpThreadProfile,
} from "../packages/server/src/codex/mcp-profile.js";
import { findCodexCliPath } from "../packages/server/src/sdk/cli-detection.js";

type SmokeMode = "standard" | "clear" | "full";

const RESPONSE_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;
const MAX_STDERR_LENGTH = 64 * 1024;

function parseModes(): SmokeMode[] {
  const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
  const value = modeArg?.slice("--mode=".length) ?? "standard";
  if (value === "all") return ["standard", "clear", "full"];
  if (value === "standard" || value === "clear" || value === "full") {
    return [value];
  }
  throw new Error(`Unsupported smoke mode: ${value}`);
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

async function smokeMode(command: string, mode: SmokeMode): Promise<number> {
  const child = spawn(
    command,
    ["app-server", ...getCodexMcpAppServerArgs(mode), "--listen", "stdio://"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );
  let stdoutBuffer = "";
  let stderr = "";
  let configuredServerCount = 0;

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
          reject(
            new Error(
              `Timed out waiting for Codex app-server initialize (${mode})${stderr.trim() ? `\nstderr:\n${stderr.trim()}` : ""}`,
            ),
          ),
        );
      }, RESPONSE_TIMEOUT_MS);

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_LENGTH);
      });
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
          if (response.id !== 1 && response.id !== 2 && response.id !== 3) {
            continue;
          }
          if (response.error) {
            finish(() =>
              reject(
                new Error(
                  response.error?.message ??
                    `Codex app-server initialize failed (${mode})`,
                ),
              ),
            );
          } else if (response.id === 1) {
            child.stdin?.write(
              `${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`,
            );
            child.stdin?.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "config/read",
                params: {
                  includeLayers: false,
                  cwd: process.cwd(),
                },
              })}\n`,
            );
          } else if (response.id === 2) {
            const result = response.result as { config?: unknown } | undefined;
            const profile = resolveCodexMcpThreadProfile(mode, result?.config);
            configuredServerCount = profile.configuredServerIds.length;
            child.stdin?.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "thread/start",
                params: {
                  cwd: process.cwd(),
                  ephemeral: true,
                  config: profile.threadConfig,
                },
              })}\n`,
            );
          } else {
            finish(resolve);
          }
        }
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code, signal) => {
        finish(() =>
          reject(
            new Error(
              `Codex app-server exited before initialize (mode=${mode}, code=${code ?? "null"}, signal=${signal ?? "null"})${stderr.trim() ? `\nstderr:\n${stderr.trim()}` : ""}`,
            ),
          ),
        );
      });
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "yep-anywhere-smoke", version: "dev" },
            capabilities: null,
          },
        })}\n`,
      );
    });
  } finally {
    await stopChild(child);
  }

  return configuredServerCount;
}

const command = process.env.CODEX_PATH ?? (await findCodexCliPath());
if (!command) {
  throw new Error("Codex CLI not found; set CODEX_PATH to run the smoke test");
}

for (const mode of parseModes()) {
  const serverCount = await smokeMode(command, mode);
  console.log(
    `Codex app-server smoke passed: mode=${mode}, configuredMcpServers=${serverCount}`,
  );
}

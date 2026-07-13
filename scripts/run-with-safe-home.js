#!/usr/bin/env node

import { spawn } from "node:child_process";
import { exitIfUnsafeHome } from "./safe-home.js";

const rawArgs = process.argv.slice(2);
const stdinNull = rawArgs[0] === "--stdin-null";
const [command, ...args] = stdinNull ? rawArgs.slice(1) : rawArgs;

if (!command) {
  console.error(
    "Usage: node scripts/run-with-safe-home.js <command> [args...]",
  );
  process.exit(1);
}

exitIfUnsafeHome({ entrypoint: command });

// Node 24+ on Windows requires shell:true to spawn .cmd files (CVE-2024-27980).
// DEP0190 warns about unescaped args, but args come from package.json scripts, not user input.
const isWindows = process.platform === "win32";
const childEnv = { ...process.env };

// Vitest only defaults NODE_ENV to "test" when it is unset. Some local deploy
// shells export NODE_ENV=production, which makes React tests load prod bundles.
if (isVitestCommand(command)) {
  childEnv.NODE_ENV = "test";
}

const child = spawn(command, args, {
  stdio: [stdinNull ? "ignore" : "inherit", "inherit", "inherit"],
  env: childEnv,
  ...(isWindows ? { shell: true } : {}),
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

function isVitestCommand(command) {
  return (
    command === "vitest" ||
    command === "vitest.cmd" ||
    command.endsWith("/vitest") ||
    command.endsWith("\\vitest")
  );
}

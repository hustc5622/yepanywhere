#!/usr/bin/env node
// Cross-platform package entrypoint for the local deploy workflow.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(
  repoRoot,
  "scripts",
  process.platform === "win32" ? "deploy.ps1" : "deploy.sh",
);
const command = process.platform === "win32" ? "powershell" : "bash";
const args =
  process.platform === "win32"
    ? [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        ...process.argv.slice(2),
      ]
    : [script, ...process.argv.slice(2)];

const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Failed to launch deploy script: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

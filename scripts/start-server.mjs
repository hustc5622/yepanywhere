#!/usr/bin/env node
// Cross-platform replacement for the old bash-only `start` script:
//   "NODE_ENV=production node packages/server/dist/index.js"
//
// On Windows the `VAR=value command` syntax is not understood by cmd/PowerShell,
// so we set NODE_ENV here instead. macOS/Linux behavior is unchanged.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Preserve production behavior; allow overrides via the environment.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(
  repoRoot,
  "packages",
  "server",
  "dist",
  "index.js",
);

const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

child.on("error", (err) => {
  console.error(`Failed to start server (${serverEntry}):`, err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

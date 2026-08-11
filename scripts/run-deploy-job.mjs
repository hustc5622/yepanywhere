#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [resultPath, scriptPath, ...scriptArgs] = process.argv.slice(2);
if (!resultPath || !scriptPath) {
  console.error("Usage: run-deploy-job.mjs <result-path> <script> [args...]");
  process.exit(2);
}

async function writeResult(result) {
  const resultDir = dirname(resultPath);
  await mkdir(resultDir, { recursive: true, mode: 0o700 });
  await chmod(resultDir, 0o700).catch(() => {});
  const tempPath = `${resultPath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(tempPath, 0o600).catch(() => {});
  await rename(tempPath, resultPath);
  await chmod(resultPath, 0o600).catch(() => {});
}

const child = spawn(scriptPath, scriptArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once("error", async (error) => {
  console.error(`[deploy-runner] spawn error: ${error.message}`);
  await writeResult({
    finishedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    error: error.message,
  }).catch((writeError) => {
    console.error(`[deploy-runner] result write error: ${writeError.message}`);
  });
  process.exit(127);
});

child.once("exit", async (exitCode, signal) => {
  await writeResult({
    finishedAt: new Date().toISOString(),
    exitCode,
    signal,
  }).catch((error) => {
    console.error(`[deploy-runner] result write error: ${error.message}`);
    process.exitCode = 1;
  });
  process.exit(process.exitCode ?? (exitCode === 0 ? 0 : 1));
});

#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entryFile = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(entryFile);

export function backendForPlatform(platform) {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repoRoot, "scripts", "yep.ps1"),
      ],
    };
  }

  if (platform === "darwin") {
    return {
      command: "bash",
      args: [path.join(repoRoot, "yep.sh")],
    };
  }

  return null;
}

export async function dispatch({
  platform = process.platform,
  args = [],
  spawnImpl = spawn,
} = {}) {
  const backend = backendForPlatform(platform);
  if (!backend) {
    console.error(`Yep Anywhere 不支持的操作系统：${platform}`);
    return 1;
  }

  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    try {
      child = spawnImpl(backend.command, [...backend.args, ...args], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`无法启动 Yep Anywhere 服务脚本：${message}`);
      finish(1);
      return;
    }

    child.once("error", (error) => {
      console.error(`无法启动 Yep Anywhere 服务脚本：${error.message}`);
      finish(1);
    });
    child.once("close", (code) => finish(typeof code === "number" ? code : 1));
  });
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === entryFile;

if (isDirectRun) {
  process.exitCode = await dispatch({
    platform: process.platform,
    args: process.argv.slice(2),
  });
}

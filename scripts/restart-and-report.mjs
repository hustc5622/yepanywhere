#!/usr/bin/env node
/**
 * restart-and-report.mjs — 生产服务重启的 detached 包装器（跨平台）。
 *
 * 背景：
 *   "更新到 GitHub 最新" 走 git-pull-deploy.ts，其构建完后会用 launchctl
 *   kickstart 重启生产服务。kickstart 会杀掉当前（生产）Node 进程——也就是
 *   正在跑部署代码的进程。若用普通 spawn 跑重启命令，父进程一死，子进程的
 *   close 事件永远不触发，job 状态会卡在 succeeded/running，造成"假阴性"。
 *
 * 做法：
 *   由 deploy 代码以 detached 方式启动本脚本。本脚本独立存活于父进程之外，
 *   运行平台重启命令（yep.sh restart-prod / deploy.ps1 --restart-only），
 *   重启后再次探活 /api/version，最终把 job 状态（succeeded/failed）写回磁盘。
 *   这样即使父进程在重启中被杀，最终状态也由本脚本落盘，不会假阴性。
 *
 * 用法：
 *   node restart-and-report.mjs <jobFile> <port> <repoRoot> <restartCmd> [restartArgs...]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const [jobFile, portArg, repoRoot, restartCmd, ...restartArgs] =
  process.argv.slice(2);

if (!jobFile || !restartCmd) {
  console.error(
    "[restart-and-report] usage: node restart-and-report.mjs <jobFile> <port> <repoRoot> <restartCmd> [restartArgs...]",
  );
  process.exit(2);
}

const port = Number(portArg) || 8022;
const healthUrl = `http://127.0.0.1:${port}/api/version`;

function readJob() {
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf-8"));
  } catch {
    return {};
  }
}

function writeJob(patch) {
  const j = readJob();
  Object.assign(j, patch, { updatedAt: new Date().toISOString() });
  if (patch.status && patch.status !== "running")
    j.finishedAt = new Date().toISOString();
  fs.writeFileSync(jobFile, JSON.stringify(j, null, 2));
}

function runRestart() {
  return new Promise((resolve, reject) => {
    const child = spawn(restartCmd, restartArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `重启命令退出码 ${code}${signal ? `, signal ${signal}` : ""}`,
          ),
        );
    });
    child.on("error", reject);
  });
}

async function isHealthy() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // 服务还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  try {
    console.error(
      `\n==> [restart-and-report] 运行重启命令: ${restartCmd} ${restartArgs.join(" ")}\n`,
    );
    await runRestart();
    if (!(await isHealthy())) {
      const reason = `服务在重启后 20s 内未就绪（探活 ${healthUrl} 失败）。请检查 ~/.yep-anywhere/logs/server-launchd.err.log。`;
      console.error(`\n==> [restart-and-report] 错误: ${reason}\n`);
      writeJob({ status: "failed", exitCode: 1, errorReason: reason });
      process.exit(1);
    }
    console.error(
      `\n==> [restart-and-report] 重启成功，服务已在 ${healthUrl} 就绪\n`,
    );
    process.exit(0);
  } catch (e) {
    const reason = `服务重启失败: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`\n==> [restart-and-report] 错误: ${reason}\n`);
    writeJob({ status: "failed", exitCode: 1, errorReason: reason });
    process.exit(1);
  }
})();

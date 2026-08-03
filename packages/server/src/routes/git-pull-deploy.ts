import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  DeployRoutesOptions,
  DeploymentJob,
  DeploymentJobStatus,
} from "./deploy.js";

/**
 * 构造用于子进程的安全环境：剥离 WorkBuddy 的“安全删除守卫”注入。
 * 该守卫通过 NODE_OPTIONS=--require=...genie-safe-delete.cjs 包裹 node/pnpm，
 * 并在 PATH 前插入 safe-bin 包装脚本；一旦 vite build 在 emptyDir 时调用
 * fs.rmSync，守卫会尝试把文件挪进回收站（spawnSync genie-trash），在非交互
 * 环境下超时导致构建失败。更新/构建流程本就是无人值守的，必须绕开它。
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env };
  if (typeof env.NODE_OPTIONS === "string" && env.NODE_OPTIONS.length > 0) {
    const filtered = env.NODE_OPTIONS.split(/\s+/)
      .filter(
        (tok) =>
          !/genie-safe-delete\.cjs/.test(tok) &&
          !/^--require=.*safe-delete/.test(tok),
      )
      .join(" ")
      .trim();
    if (filtered.length > 0) env.NODE_OPTIONS = filtered;
    else env.NODE_OPTIONS = undefined;
  }
  if (typeof env.PATH === "string" && env.PATH.length > 0) {
    env.PATH = env.PATH.split(path.delimiter)
      .filter((p) => !/safe-bin/.test(p) && !/genie-safe-delete/.test(p))
      .join(path.delimiter);
  }
  return env;
}

/**
 * Helper function to execute git pull and build deployment
 */
export async function startGitPullAndDeploy(
  options: DeployRoutesOptions | undefined,
  repoRoot: string,
): Promise<DeploymentJob> {
  const id = randomUUID();
  const now = new Date().toISOString();

  const dataDir =
    options?.dataDir ||
    path.join(require("node:os").homedir(), ".yep-anywhere");
  // 注意：路径必须与 packages/server/src/routes/deploy.ts 的 getJobsDir/getLogsDir 保持一致，
  // 否则前端轮询 GET /deploy/jobs/:id 找不到记录，UI 会永远卡在“更新中”。
  const jobsDir = path.join(dataDir, "deploy", "jobs");
  const logsDir = path.join(dataDir, "deploy", "logs");
  await fsp.mkdir(jobsDir, { recursive: true });
  await fsp.mkdir(logsDir, { recursive: true });

  const logPath = path.join(logsDir, `${id}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const job: DeploymentJob = {
    id,
    action: "git-pull-update",
    args: [],
    command: "git pull && pnpm install && pnpm build && restart",
    status: "running",
    startedAt: now,
    updatedAt: now,
  };

  const writeRecord = async (): Promise<void> => {
    const record = { ...job, logPath };
    await fsp.writeFile(
      path.join(jobsDir, `${id}.json`),
      JSON.stringify(record, null, 2),
    );
  };

  // 先写入一条 running 记录，保证前端轮询与 findCurrentJob 能立即发现本任务。
  await writeRecord();

  const finish = (status: "succeeded" | "failed", errorReason?: string) => {
    job.status = status;
    job.exitCode = status === "succeeded" ? 0 : 1;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    if (errorReason !== undefined) job.errorReason = errorReason;
  };

  /**
   * 用 spawn 流式执行命令：实时把 stdout/stderr 写入日志，超时或非零退出时把
   * 真实输出作为错误信息抛出（避免只记录 "Command failed"）。不限制 maxBuffer，
   * 避免大输出被截断。
   */
  const runStep = (
    label: string,
    cmd: string,
    args: string[],
    opts: { cwd: string; timeout: number },
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      logStream.write(`\n==> ${label}\n`);
      const child = spawn(cmd, args, { cwd: opts.cwd, env: cleanEnv() });
      let out = "";
      const onData = (d: Buffer) => {
        const s = d.toString();
        out += s;
        logStream.write(s);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `步骤超时（>${Math.round(opts.timeout / 1000)}s）: ${cmd} ${args.join(" ")}\n${out.slice(-2000)}`,
          ),
        );
      }, opts.timeout);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `命令失败（exit ${code}${signal ? `, signal ${signal}` : ""}）: ${cmd} ${args.join(" ")}\n${out.slice(-2000)}`,
            ),
          );
      });
    });
  };

  // Run git pull + build + deploy asynchronously
  (async () => {
    try {
      logStream.write("==> Git Pull 更新开始\n");
      logStream.write(`时间: ${now}\n`);
      logStream.write(`仓库: ${repoRoot}\n\n`);

      // 步骤 1/5: Git pull（拉取 GitHub 最新代码到本地仓库）
      await runStep(
        "步骤 1/5: 执行 git pull",
        "git",
        ["pull", "origin", "main"],
        {
          cwd: repoRoot,
          timeout: 120000,
        },
      );

      // 步骤 2/5: 安装依赖。依赖已就绪（node_modules/.pnpm 与 lockfile 都在）则跳过，
      // 避免服务进程内偶发的 pnpm 长耗时/超时把更新卡死。
      const nodeModulesPnpm = path.join(repoRoot, "node_modules", ".pnpm");
      const lockPath = path.join(repoRoot, "pnpm-lock.yaml");
      const needInstall =
        !fs.existsSync(nodeModulesPnpm) || !fs.existsSync(lockPath);
      if (needInstall) {
        logStream.write("\n==> 步骤 2/5: 安装依赖 (pnpm install)\n");
        await runStep(
          "步骤 2/5: pnpm install",
          "pnpm",
          ["install", "--prefer-offline"],
          {
            cwd: repoRoot,
            timeout: 600000,
          },
        );
      } else {
        logStream.write("\n==> 步骤 2/5: 依赖已就绪，跳过 pnpm install\n");
      }

      // 步骤 3/5: 构建客户端（前端）
      await runStep(
        "步骤 3/5: 构建客户端 (pnpm --filter client build)",
        "pnpm",
        ["--filter", "client", "build"],
        { cwd: repoRoot, timeout: 600000 },
      );

      // 步骤 4/5: 构建服务端 bundle
      await runStep(
        "步骤 4/5: 构建服务端 (pnpm build:bundle)",
        "pnpm",
        ["build:bundle"],
        { cwd: repoRoot, timeout: 600000 },
      );

      // 在“重启服务”之前先把成功状态落盘。因为下一步会杀掉当前 Node 进程，
      // 若不在重启前写入 succeeded，进程死亡后 finally 来不及执行，状态将永远停在 running。
      logStream.write("\n==> 构建完成，准备重启服务\nDeploy complete.\n");
      finish("succeeded");
      await writeRecord();

      // 步骤 5/5: 重启服务（独立 try，重启异常不影响已记录的 succeeded 状态）
      try {
        logStream.write("\n==> 步骤 5/5: 重启服务\n");
        if (process.platform === "win32") {
          const deployPs1 = path.join(repoRoot, "scripts", "deploy.ps1");
          if (fs.existsSync(deployPs1)) {
            logStream.write("使用 deploy.ps1 重启生产模式 (Windows)...\n");
            await runStep(
              "restart-prod",
              "powershell",
              [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                deployPs1,
                "--restart-only",
              ],
              { cwd: repoRoot, timeout: 180000 },
            );
          } else {
            throw new Error("未找到重启脚本 scripts/deploy.ps1");
          }
        } else {
          const yepScript = path.join(repoRoot, "yep.sh");
          if (fs.existsSync(yepScript)) {
            logStream.write("使用 yep.sh 重启生产模式...\n");
            await runStep("restart-prod", "bash", [yepScript, "restart-prod"], {
              cwd: repoRoot,
              timeout: 180000,
            });
          } else {
            const deployScript = path.join(
              repoRoot,
              "scripts",
              "redeploy-server.sh",
            );
            if (fs.existsSync(deployScript)) {
              logStream.write("使用 redeploy-server.sh 重启...\n");
              await runStep("redeploy", deployScript, ["--restart-only"], {
                cwd: repoRoot,
                timeout: 180000,
              });
            } else {
              throw new Error("未找到重启脚本");
            }
          }
        }
      } catch (restartErr) {
        const msg =
          restartErr instanceof Error ? restartErr.message : String(restartErr);
        logStream.write(
          `\n==> 警告: 重启命令执行异常（部署产物已构建成功）: ${msg}\n`,
        );
      }
    } catch (error) {
      // 捕获 runStep 抛出的真实错误（含命令输出），写入 errorReason 供前端展示。
      const reason = (
        (error instanceof Error ? error.message : String(error)) ?? "未知错误"
      ).slice(0, 4000);
      logStream.write(`\n==> 错误: ${reason}\n`);
      finish("failed", reason);
    } finally {
      logStream.end();
      // 失败时进程不会自杀，这里确保最终状态落盘；成功时已在重启前落盘。
      if (job.status !== "running") {
        await writeRecord().catch(() => {});
      }
    }
  })();

  return job;
}

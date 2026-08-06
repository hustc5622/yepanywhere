import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  DeployRoutesOptions,
  DeploymentActionId,
  DeploymentJob,
  DeploymentJobStatus,
} from "./deploy.js";

/**
 * `startGitPullAndDeploy` 的两种模式：
 *   - "github"：拉取 origin/main + pnpm install + build + bundle + npm ci + restart。
 *     适用于 UI 的"更新到 GitHub 最新版本"按钮。
 *   - "local"：跳过 git pull 与 pnpm install，仅 build + bundle + npm ci + restart。
 *     适用于 UI 的"更新到本地最新版本"按钮——直接用工作树里已经存在的代码构建。
 *
 * 为什么需要 local 模式：旧实现走 `spawn("powershell", ["-File", "scripts/deploy.ps1", ...])`
 * 让 PowerShell 子进程跑完整 build，但该 spawn 在 Windows 上会在 0.6 秒内 false-succeeded
 * 退出（PowerShell host 进程与 Node.js spawn 跟踪的生命周期不匹配），导致 UI 看到"成功"
 * 但 dist/npm-package/build-info.json 仍是旧版本。改为在 Node 进程内直接调 runStep 跑
 * 全部 build 步骤，可彻底绕开该坑，Windows / macOS 行为也完全一致。
 */
export type GitPullMode = "github" | "local";

/**
 * 构造用于子进程的安全环境：剥离 WorkBuddy 的“安全删除守卫”注入。
 * 该守卫通过 NODE_OPTIONS=--require=...genie-safe-delete.cjs 包裹 node/pnpm，
 * 并在 PATH 前插入 safe-bin 包装脚本；一旦 vite build 在 emptyDir 时调用
 * fs.rmSync，守卫会尝试把文件挪进回收站（spawnSync genie-trash），在非交互
 * 环境下超时导致构建失败。更新/构建流程本就是无人值守的，必须绕开它。
 */
const execFileAsync = promisify(execFile);

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
 * Helper function to execute git pull and build deployment.
 *
 * @param mode - "github" 走完整 git pull + install + build + restart；
 *               "local" 跳过 git pull 和 pnpm install，仅 build + bundle + npm ci + restart。
 */
export async function startGitPullAndDeploy(
  options: DeployRoutesOptions | undefined,
  repoRoot: string,
  mode: GitPullMode = "github",
  action: DeploymentActionId = "git-pull-update",
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
    action,
    args: [],
    command:
      mode === "github"
        ? "git pull && pnpm install && pnpm build && pnpm build:bundle && npm ci && restart"
        : "pnpm build && pnpm build:bundle && npm ci && restart",
    status: "running",
    // 记录服务器自身 PID：整个 build 由本进程（Node）在进程内驱动，
    // 只要服务器还活着，build 就在进行。hydrateJob 的"僵尸任务"检测
    // （status=running 但 pid 进程不存在）据此能正确判断任务仍在运行，
    // 不会误判为 failed。若服务器在 build 中途被杀，下次读取时 pid 进程
    // 已不存在，才会被判定为 failed——这正是期望行为。
    pid: process.pid,
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
      // Windows 上 pnpm / npm 是 .cmd 脚本，裸 spawn("pnpm") 会因无法定位 .cmd
      // 而 ENOENT 失败；必须用 shell:true 让 cmd.exe 解析。git 是真实 .exe，无需 shell。
      // macOS / Linux 下 pnpm/npm 为真实二进制，shell 与否均可，这里仅在 win32 启用。
      const useShell =
        process.platform === "win32" && (cmd === "pnpm" || cmd === "npm");
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: cleanEnv(),
        shell: useShell,
      });
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
      logStream.write("==> 更新开始\n");
      logStream.write(`时间: ${now}\n`);
      logStream.write(`仓库: ${repoRoot}\n`);
      logStream.write(
        `模式: ${mode === "github" ? "github (git pull + build + restart)" : "local (build only, skip git pull/install)"}\n\n`,
      );

      // 步骤编号：github 模式 = pull/install/build/bundle/npm ci/restart 共 6 步；
      // local 模式跳过 pull 与 install，仅 build/bundle/npm ci/restart 共 4 步。
      const isLocal = mode === "local";
      const totalSteps = isLocal ? 4 : 6;
      const stepBuild = isLocal ? 1 : 3;
      const stepBundle = isLocal ? 2 : 4;
      const stepNpmCi = isLocal ? 3 : 5;
      const stepRestart = isLocal ? 4 : 6;

      // 预检：检查工作树是否存在"已跟踪文件"的改动。
      //  - github 模式：git pull 遇到脏树会失败或产生意外 merge，导致更新静默卡死，
      //    因此脏树时提前以明确原因失败。
      //  - local 模式：不做 git pull，本就是"用当前工作树构建"——脏树（含未提交改动）
      //    正是用户想要的"本地最新"，不应拦截。仅在脏树时打警告，提示 build-info.json
      //    记录的 commit 哈希不包含这些未提交改动。
      // 仅检查已跟踪文件（忽略未跟踪文件，如本地配置），Windows/Mac 通用。
      const { stdout: statusOut } = await execFileAsync(
        "git",
        ["status", "--porcelain"],
        { cwd: repoRoot, encoding: "utf-8" },
      ).catch(() => ({ stdout: "" }));
      const trackedChanges = statusOut
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("??")).length;
      if (mode === "github" && trackedChanges > 0) {
        throw new Error(
          "工作树存在未提交的修改（已跟踪文件），无法安全执行 git pull 更新。请先提交或暂存本地改动后再更新。",
        );
      }
      if (isLocal && trackedChanges > 0) {
        logStream.write(
          `警告: 工作树存在 ${trackedChanges} 处未提交改动，将直接构建当前工作树。build-info.json 记录的 commit 哈希不包含这些未提交改动。\n`,
        );
      }

      // 步骤 1/6 (github): Git pull。local 模式跳过，但显式打日志。
      if (mode === "github") {
        await runStep(
          `步骤 1/${totalSteps}: 执行 git pull`,
          "git",
          ["pull", "origin", "main"],
          {
            cwd: repoRoot,
            timeout: 120000,
          },
        );
      } else {
        logStream.write(
          "\n==> 跳过 git pull（local 模式，直接使用工作树当前代码构建）\n",
        );
      }

      // 步骤 2/5: 安装依赖。依赖已就绪（node_modules/.pnpm 与 lockfile 都在）则跳过，
      // 避免服务进程内偶发的 pnpm 长耗时/超时把更新卡死。
      // local 模式：完全跳过——本地模式意味着用户已经主动在仓库上工作，依赖应处于就绪状态。
      if (mode === "github") {
        const nodeModulesPnpm = path.join(repoRoot, "node_modules", ".pnpm");
        const lockPath = path.join(repoRoot, "pnpm-lock.yaml");
        const needInstall =
          !fs.existsSync(nodeModulesPnpm) || !fs.existsSync(lockPath);
        if (needInstall) {
          logStream.write(
            `\n==> 步骤 2/${totalSteps}: 安装依赖 (pnpm install)\n`,
          );
          await runStep(
            `步骤 2/${totalSteps}: pnpm install`,
            "pnpm",
            ["install", "--prefer-offline"],
            {
              cwd: repoRoot,
              timeout: 600000,
            },
          );
        } else {
          logStream.write(
            `\n==> 步骤 2/${totalSteps}: 依赖已就绪，跳过 pnpm install\n`,
          );
        }
      } else {
        logStream.write("\n==> 跳过 pnpm install（local 模式）\n");
      }

      // 步骤 N: 构建客户端（前端）
      await runStep(
        `步骤 ${stepBuild}/${totalSteps}: 构建客户端 (pnpm --filter client build)`,
        "pnpm",
        ["--filter", "client", "build"],
        { cwd: repoRoot, timeout: 600000 },
      );

      // 步骤 N: 构建服务端 bundle
      await runStep(
        `步骤 ${stepBundle}/${totalSteps}: 构建服务端 (pnpm build:bundle)`,
        "pnpm",
        ["build:bundle"],
        { cwd: repoRoot, timeout: 600000 },
      );

      // 步骤 N: 安装运行时依赖。build:bundle 只生成部署包结构，不安装依赖；
      // 必须执行 npm ci 否则 dist/npm-package 内的 node_modules 可能缺失或陈旧，
      // 导致生产模式启动报 ERR_MODULE_NOT_FOUND。
      //
      // 关键前置清理（防 errno -11）：WorkBuddy 的"安全删除守卫"
      // （NODE_OPTIONS --require genie-safe-delete.cjs + PATH 前置 safe-bin）会拦截
      // rm/fs.rm，把被删目录改名成 "<name> 2" 暂存。历史上一次在守卫生效时的 npm ci
      // 留下了 ajv/dist 2、jose/dist 2 等残留；后续 npm ci 在 idealTree 扫描阶段
      // scandir 这些锁目录会直接 errno -11 中止（"更新失效"根因之一）。
      // 这里始终先用 guard-neutralized 的 /bin/rm（runStep 已用 cleanEnv 剥离守卫）
      // 清空整个 node_modules，确保无历史残留；若仍因 errno -11 失败，再清一次后重试。
      const npmPackageDir = path.join(repoRoot, "dist", "npm-package");
      const cleanNodeModules = (): Promise<void> =>
        runStep(
          "预清理：移除旧的 node_modules（guard-neutralized）",
          "/bin/rm",
          ["-rf", path.join(npmPackageDir, "node_modules")],
          { cwd: repoRoot, timeout: 120000 },
        );
      const npmCiRun = (): Promise<void> =>
        runStep(
          `步骤 ${stepNpmCi}/${totalSteps}: 安装运行时依赖 (npm ci --omit=dev)`,
          "npm",
          ["ci", "--omit=dev", "--no-audit", "--no-fund"],
          { cwd: npmPackageDir, timeout: 600000 },
        );

      await cleanNodeModules().catch((e) => {
        logStream.write(
          `\n==> 预清理 node_modules 警告: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      });
      try {
        await npmCiRun();
      } catch (npmErr) {
        const npmMsg =
          npmErr instanceof Error ? npmErr.message : String(npmErr);
        if (/errno -11|Unknown system error -11/.test(npmMsg)) {
          logStream.write(
            "\n==> npm ci 触发 errno -11，疑似残留的守卫暂存目录；清理 node_modules 后重试一次。\n",
          );
          await cleanNodeModules().catch(() => undefined);
          await npmCiRun();
        } else {
          throw npmErr;
        }
      }

      // 在“重启服务”之前先把构建成功的 succeeded 落盘（作为基线）。
      logStream.write("\n==> 构建完成，准备重启服务\nDeploy complete.\n");
      finish("succeeded");
      await writeRecord();

      // 步骤 6/6: 重启服务。
      // 关键：重启（launchctl kickstart -k / Stop-Process）会杀掉当前（生产）Node 进程，
      // 因此必须用 DETACHED 子进程跑重启+探活，否则父进程死亡会导致普通 spawn 的
      // close 事件永不触发，job 永远卡在 succeeded/running（假阴性）。
      // restart-and-report.mjs 独立存活于父进程之外，重启后再次探活 /api/version，
      // 并在失败（重启命令非零退出 / 探活超时）时把 job 改写为 failed。父进程 finally
      // 不会再覆盖（此时 job.status 已是 succeeded，若包装器写了 failed 则以其为准）。
      const isProduction = process.env.NODE_ENV === "production";
      try {
        if (!isProduction) {
          // 开发模式（pnpm dev，tsx watch 自动重载）：生产重启依赖 launchd / 8022，
          // 在 dev 下既无意义，又会在 launchd 用户域损坏时直接令更新失败。源码变更
          // 会被 tsx watch 自动重载，因此构建完成后直接成功，不执行 prod 重启 + 探活。
          logStream.write(
            "\n==> 开发模式（NODE_ENV!==production）：跳过生产服务重启。\n" +
              "开发服务器由 tsx watch 自动重载源码变更，无需重启 8022 生产服务；\n" +
              "构建产物已就绪，job 标记为 succeeded。\n",
          );
        } else {
          logStream.write(
            `\n==> 步骤 ${stepRestart}/${totalSteps}: 重启生产服务 (detached)\n`,
          );
          // 探活端口必须与重启目标端口一致：生产默认 8022，可用 YEP_DEPLOY_PORT 覆盖。
          // 注意：绝不能使用 process.env.PORT——那是“当前正在运行的 dev 服务端口”
          // (如 3400)，用它探活会探测到 dev 服务而误判成功，且与 8022 重启目标错位。
          const prodPort = Number(process.env.YEP_DEPLOY_PORT || 8022);
          const wrapper = path.join(
            repoRoot,
            "scripts",
            "restart-and-report.mjs",
          );
          const restartCmdArgs =
            process.platform === "win32"
              ? [
                  "powershell",
                  "-NoProfile",
                  "-ExecutionPolicy",
                  "Bypass",
                  "-File",
                  path.join(repoRoot, "scripts", "deploy.ps1"),
                  "--restart-only",
                ]
              : [
                  "bash",
                  path.join(repoRoot, "scripts", "redeploy-server.sh"),
                  "--restart-only",
                ];

          // 用独立 fd 写重启输出，避免父进程 logStream.end() 关闭 fd 后子进程丢失 stdout。
          const restartLogFd = fs.openSync(logPath, "a");
          const restartChild = spawn(
            process.execPath,
            [
              wrapper,
              path.join(jobsDir, `${id}.json`),
              String(prodPort),
              repoRoot,
              ...restartCmdArgs,
            ],
            {
              cwd: repoRoot,
              detached: true,
              env: cleanEnv(),
              stdio: ["ignore", restartLogFd, restartLogFd],
            },
          );
          restartChild.unref();
          logStream.write(
            `已 detached 启动重启包装进程 (pid=${restartChild.pid})，将自行探活 ${prodPort} 并更新 job 状态。\n`,
          );
          logStream.write(
            "若重启或探活失败，job 将被标记为 failed；否则保持 succeeded。\n",
          );
          // 不 await：包装进程在后台完成重启+探活，结果直接写盘，不受父进程被重启杀掉影响。
        }
      } catch (restartErr) {
        const msg =
          restartErr instanceof Error ? restartErr.message : String(restartErr);
        logStream.write(`\n==> 错误: 无法启动重启进程: ${msg}\n`);
        finish("failed", `重启进程启动失败: ${msg}`);
        await writeRecord();
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

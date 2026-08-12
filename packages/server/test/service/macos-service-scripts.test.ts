import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const gitBashCandidates = [
  process.env.YEP_TEST_BASH,
  "D:\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\bin\\bash.exe",
  process.platform === "win32" ? undefined : "bash",
].filter((candidate): candidate is string => Boolean(candidate));
const bash = gitBashCandidates.find(
  (candidate) => candidate === "bash" || existsSync(candidate),
);
const tempDirs: string[] = [];

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function toBashPath(value: string) {
  if (process.platform !== "win32") return value;
  const normalized = value.replaceAll("\\", "/");
  return normalized.replace(
    /^([A-Za-z]):/,
    (_, drive: string) => `/${drive.toLowerCase()}`,
  );
}

function runBash(
  args: string[],
  options: {
    cwd?: string;
    environment?: Record<string, string>;
    pathPrefix?: string;
  } = {},
): Promise<CommandResult> {
  if (!bash) throw new Error("没有可用的 Bash");
  const commandArgs = options.pathPrefix
    ? [
        "-c",
        'export PATH="$1:$PATH"; shift; exec "$@"',
        "yep-test",
        toBashPath(options.pathPrefix),
        ...args,
      ]
    : args;

  return new Promise((resolve, reject) => {
    const child = spawn(bash, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function createExecutable(filePath: string, contents: string) {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

async function createFakeMacEnvironment() {
  const root = await mkdtemp(path.join(tmpdir(), "yep-macos-service-"));
  tempDirs.push(root);
  const binDir = path.join(root, "bin");
  const homeDir = path.join(root, "home");
  const launchctlLog = path.join(root, "launchctl.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await createExecutable(
    path.join(binDir, "uname"),
    "#!/usr/bin/env bash\necho Darwin\n",
  );
  await createExecutable(
    path.join(binDir, "id"),
    '#!/usr/bin/env bash\nif [[ "${1:-}" == "-u" ]]; then echo 501; else /usr/bin/id "$@"; fi\n',
  );
  await createExecutable(
    path.join(binDir, "launchctl"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$YEP_TEST_LAUNCHCTL_LOG"\nif [[ "${1:-}" == "print" ]]; then exit 1; fi\n',
  );
  await createExecutable(
    path.join(binDir, "lsof"),
    '#!/usr/bin/env bash\nif [[ -n "${YEP_TEST_DEV_PID_FILE:-}" && -s "$YEP_TEST_DEV_PID_FILE" ]]; then cat "$YEP_TEST_DEV_PID_FILE"; exit 0; fi\nexit 1\n',
  );
  await createExecutable(
    path.join(binDir, "curl"),
    "#!/usr/bin/env bash\nexit 0\n",
  );

  return {
    root,
    binDir,
    homeDir,
    launchctlLog,
    environment: {
      HOME: toBashPath(homeDir),
      YEP_SERVICE_STATE_DIR: toBashPath(path.join(root, "state")),
      YEP_LAUNCHD_LOG_DIR: toBashPath(path.join(root, "logs")),
      YEP_TEST_LAUNCHCTL_LOG: toBashPath(launchctlLog),
      YEP_TEST_DEV_PID_FILE: toBashPath(path.join(root, "dev.pid")),
    },
  };
}

async function createLaunchdFixture() {
  const fixture = await createFakeMacEnvironment();
  const fixtureRepo = path.join(fixture.root, "repo");
  await mkdir(path.join(fixtureRepo, "scripts"), { recursive: true });
  await mkdir(path.join(fixtureRepo, "dist", "npm-package", "dist"), {
    recursive: true,
  });
  await copyFile(
    path.join(repoRoot, "scripts", "install-launchagents.sh"),
    path.join(fixtureRepo, "scripts", "install-launchagents.sh"),
  );
  await copyFile(
    path.join(repoRoot, "scripts", "uninstall-launchagents.sh"),
    path.join(fixtureRepo, "scripts", "uninstall-launchagents.sh"),
  );
  await createExecutable(
    path.join(fixtureRepo, "dist", "npm-package", "dist", "cli.js"),
    "#!/usr/bin/env node\n",
  );
  return { ...fixture, fixtureRepo };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(!bash)("macOS 服务脚本", () => {
  it("help 使用中文列出统一命令和兼容别名", async () => {
    const result = await runBash(["yep.sh", "help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("服务进程管理");
    for (const command of [
      "start-dev",
      "stop-dev",
      "restart-dev",
      "start-prod",
      "stop-prod",
      "restart-prod",
      "stop",
      "status",
      "rebuild",
      "enable-autostart",
      "disable-autostart",
      "help",
    ]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain("enable-launchd");
  });

  it("交互菜单逐项分发全部选择并在 0 后退出", async () => {
    const yepScript = toBashPath(path.join(repoRoot, "yep.sh"));
    const script = `
source "$1"
start_dev() { printf '__CALL__start-dev:%s\\n' "$*"; }
stop_dev() { printf '__CALL__stop-dev\\n'; }
start_prod() { printf '__CALL__start-prod\\n'; }
stop_prod() { printf '__CALL__stop-prod\\n'; }
restart_prod() { printf '__CALL__restart-prod\\n'; }
status() { printf '__CALL__status\\n'; }
rebuild() { printf '__CALL__rebuild\\n'; }
enable_autostart() { printf '__CALL__enable-autostart\\n'; }
disable_autostart() { printf '__CALL__disable-autostart\\n'; }
stop_all() { printf '__CALL__stop\\n'; }
show_menu <<'EOF'
1
2
3
4
5
6
7
8
9
10
11
0
EOF
printf '__CALL__returned\\n'
`;
    const result = await runBash(["-c", script, "yep-menu-test", yepScript]);
    const calls = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("__CALL__"));

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(calls).toEqual([
      "__CALL__start-dev:",
      "__CALL__start-dev:--fg",
      "__CALL__stop-dev",
      "__CALL__start-prod",
      "__CALL__stop-prod",
      "__CALL__restart-prod",
      "__CALL__status",
      "__CALL__rebuild",
      "__CALL__enable-autostart",
      "__CALL__disable-autostart",
      "__CALL__stop",
      "__CALL__returned",
    ]);
  });

  it("start-dev 默认后台运行、关闭 stdin 并保存 dev PID 元数据", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const nohupLog = path.join(fakeMac.root, "nohup.log");
    await createExecutable(
      path.join(fakeMac.binDir, "nohup"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$$" > "$YEP_TEST_DEV_PID_FILE"\nprintf "args=%s\\n" "$*" > "$YEP_TEST_NOHUP_LOG"\nif read -r ignored; then echo stdin=open >> "$YEP_TEST_NOHUP_LOG"; else echo stdin=closed >> "$YEP_TEST_NOHUP_LOG"; fi\nsleep 3\n',
    );

    const result = await runBash(["./yep.sh", "start-dev"], {
      pathPrefix: fakeMac.binDir,
      environment: {
        ...fakeMac.environment,
        YEP_TEST_NOHUP_LOG: toBashPath(nohupLog),
      },
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const nohupInvocation = await readFile(nohupLog, "utf8");
    expect(nohupInvocation).toContain("PORT=3400");
    expect(nohupInvocation).toContain("YEP_ANYWHERE_PROFILE=dev");
    expect(nohupInvocation).toContain("pnpm dev");
    expect(nohupInvocation).toContain("stdin=closed");
    const metadata = await readFile(
      path.join(fakeMac.root, "state", "dev-process.json"),
      "utf8",
    );
    expect(metadata).toContain('"profile":"dev"');
    expect(metadata).toMatch(/"pid":\d+/);
  });

  it("start-dev 保留显式指定的 Profile", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const nohupLog = path.join(fakeMac.root, "custom-profile-nohup.log");
    await createExecutable(
      path.join(fakeMac.binDir, "nohup"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$$" > "$YEP_TEST_DEV_PID_FILE"\nprintf "args=%s\\n" "$*" > "$YEP_TEST_NOHUP_LOG"\nsleep 3\n',
    );

    const result = await runBash(["./yep.sh", "start-dev"], {
      pathPrefix: fakeMac.binDir,
      environment: {
        ...fakeMac.environment,
        YEP_ANYWHERE_PROFILE: "review",
        YEP_TEST_NOHUP_LOG: toBashPath(nohupLog),
      },
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const nohupInvocation = await readFile(nohupLog, "utf8");
    expect(nohupInvocation).not.toContain("YEP_ANYWHERE_PROFILE=dev");
    const metadata = await readFile(
      path.join(fakeMac.root, "state", "dev-process.json"),
      "utf8",
    );
    expect(metadata).toContain('"profile":"review"');
  });

  it("start-dev 在任一开发端口被未知进程占用时拒绝启动", async () => {
    const fakeMac = await createFakeMacEnvironment();
    await createExecutable(
      path.join(fakeMac.binDir, "lsof"),
      '#!/usr/bin/env bash\nif [[ "$*" == *":3401"* ]]; then echo 424242; exit 0; fi\nexit 1\n',
    );
    await createExecutable(
      path.join(fakeMac.binDir, "nohup"),
      "#!/usr/bin/env bash\n/usr/bin/sleep 3\n",
    );

    const result = await runBash(["./yep.sh", "start-dev"], {
      pathPrefix: fakeMac.binDir,
      environment: fakeMac.environment,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("3401");
    expect(result.stdout).toContain("无法确认");
  });

  it("start-dev 健康检查超时时清理本次进程和元数据", async () => {
    const fakeMac = await createFakeMacEnvironment();
    await createExecutable(
      path.join(fakeMac.binDir, "curl"),
      "#!/usr/bin/env bash\nexit 1\n",
    );
    await createExecutable(
      path.join(fakeMac.binDir, "sleep"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    await createExecutable(
      path.join(fakeMac.binDir, "nohup"),
      "#!/usr/bin/env bash\n/usr/bin/sleep 30\n",
    );

    const result = await runBash(["./yep.sh", "start-dev"], {
      pathPrefix: fakeMac.binDir,
      environment: {
        ...fakeMac.environment,
        YEP_HEALTH_CHECK_TRIES: "1",
      },
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("健康检查");
    expect(
      existsSync(path.join(fakeMac.root, "state", "dev-process.json")),
    ).toBe(false);
  });

  it("start-dev 即使健康接口成功也要求三个开发端口归属于本次进程树", async () => {
    const fakeMac = await createFakeMacEnvironment();
    await createExecutable(
      path.join(fakeMac.binDir, "nohup"),
      "#!/usr/bin/env bash\n/usr/bin/sleep 3\n",
    );

    const result = await runBash(["./yep.sh", "start-dev"], {
      pathPrefix: fakeMac.binDir,
      environment: fakeMac.environment,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("三个开发端口");
    expect(
      existsSync(path.join(fakeMac.root, "state", "dev-process.json")),
    ).toBe(false);
  });

  it("重复 start-dev 会重新核验健康和三个端口的归属", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `export PATH='${binDir}':$PATH; source '${source}'; dev_metadata_matches() { return 0; }; metadata_pid() { echo 123; }; metadata_value() { echo dev; }; get_port_pids() { echo 123; }; curl() { return 1; }; start_dev`,
      ],
      { environment: fakeMac.environment },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("健康");
  });

  it("stop-dev 拒绝结束没有可核实元数据的端口占用者", async () => {
    const fakeMac = await createFakeMacEnvironment();
    await createExecutable(
      path.join(fakeMac.binDir, "lsof"),
      "#!/usr/bin/env bash\necho 424242\n",
    );

    const result = await runBash(["./yep.sh", "stop-dev"], {
      pathPrefix: fakeMac.binDir,
      environment: fakeMac.environment,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("424242");
    expect(result.stdout).toContain("无法确认");
  });

  it("没有有效元数据时 stop-dev 和 status 检查全部开发端口", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `export PATH='${binDir}':$PATH; source '${source}'; dev_metadata_matches() { return 1; }; get_port_pids() { if [[ "$1" == "3402" ]]; then echo 424242; fi; }; stop_dev; stop_code=$?; status; exit $stop_code`,
      ],
      { environment: fakeMac.environment },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("3402");
    expect(result.stdout).toContain("配置异常");
  });

  it("status 从当前生产 plist 显示真实日志路径", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `export PATH='${binDir}':$PATH; source '${source}'; preferred_plist() { echo /tmp/active.plist; }; apply_plist_configuration() { :; }; effective_prod_profile() { echo default; }; dev_metadata_matches() { return 1; }; get_port_pids() { :; }; require_macos() { return 1; }; port_in_use() { return 1; }; plist_value() { case "$2" in StandardOutPath) echo /custom/logs/server.out.log ;; StandardErrorPath) echo /custom/logs/server.err.log ;; esac; }; status`,
      ],
      { environment: fakeMac.environment },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("/custom/logs/server.out.log");
    expect(result.stdout).toContain("/custom/logs/server.err.log");
  });

  it("stop-dev 在进程树停止后发现残留端口时返回失败", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `export PATH='${binDir}':$PATH; source '${source}'; dev_metadata_matches() { return 0; }; metadata_pid() { echo 123; }; kill_process_tree() { :; }; kill() { return 1; }; get_port_pids() { if [[ "$1" == "3401" ]]; then echo 999; fi; }; stop_dev`,
      ],
      {
        environment: fakeMac.environment,
      },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("3401");
    expect(result.stdout).toContain("999");
  });

  it("start-prod 刷新已加载定义时重新 bootstrap 而非只 kickstart", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const persistentPlist = path.join(
      fakeMac.homeDir,
      "Library",
      "LaunchAgents",
      "com.yueyuan.yepanywhere.server.plist",
    );
    await mkdir(path.dirname(persistentPlist), { recursive: true });
    await writeFile(persistentPlist, "existing", "utf8");
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `export PATH='${binDir}':$PATH; source '${source}'; require_macos() { return 0; }; check_runtime_bundle() { return 0; }; launchd_running() { return 1; }; port_in_use() { return 1; }; write_server_plist() { return 0; }; launchd_loaded() { return 0; }; wait_for_prod() { return 0; }; launchd_pid() { echo 900; }; start_prod`,
      ],
      {
        environment: {
          ...fakeMac.environment,
          YEP_DEPLOY_PORT: "19000",
        },
      },
    );

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const calls = await readFile(fakeMac.launchctlLog, "utf8");
    expect(calls).toContain("bootout");
    expect(calls).toContain("bootstrap");
  });

  it("显式 bridge 控制 URL 会刷新已有合法生产 plist", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const persistentPlist = path.join(
      fakeMac.homeDir,
      "Library",
      "LaunchAgents",
      "com.yueyuan.yepanywhere.server.plist",
    );
    await mkdir(path.dirname(persistentPlist), { recursive: true });
    await writeFile(persistentPlist, "existing", "utf8");
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `control_url="$YEP_CODEX_BRIDGE_CONTROL_URL"; unset YEP_DEPLOY_PORT YEP_DEPLOY_BASE_PATH ALLOWED_IMAGE_PATHS YEP_ANYWHERE_PROFILE YEP_ANYWHERE_DATA_DIR YEP_CODEX_BRIDGE_PORT CODEX_BRIDGE_PORT YEP_CODEX_BRIDGE_CONTROL_URL CODEX_BRIDGE_CONTROL_URL YEP_CLAUDE_BRIDGE_PORT CLAUDE_BRIDGE_PORT YEP_CLAUDE_BRIDGE_CONTROL_URL CLAUDE_BRIDGE_CONTROL_URL YEP_LAUNCHD_SERVER_LABEL YEP_LAUNCHD_NODE YEP_LAUNCHD_PATH YEP_LAUNCHD_LOG_DIR YEP_FCM_SERVICE_ACCOUNT_FILE YEP_FCM_SERVICE_ACCOUNT_JSON GOOGLE_APPLICATION_CREDENTIALS SESSION_TITLE_LLM_API_KEY LLM_API_KEY SESSION_TITLE_LLM_API_BASE LLM_API_BASE SESSION_TITLE_SUB_MODULE LLM_SUB_MODULE SESSION_TITLE_MODEL SESSION_TITLE_TIMEOUT_MS SESSION_TITLE_GENERATION; export YEP_CODEX_BRIDGE_CONTROL_URL="$control_url"; export PATH='${binDir}':$PATH; source '${source}'; require_macos() { return 0; }; check_runtime_bundle() { return 0; }; plist_valid() { return 0; }; launchd_running() { return 1; }; port_in_use() { return 1; }; write_server_plist() { echo __PLIST_REWRITTEN__; return 0; }; launchd_loaded() { return 0; }; wait_for_prod() { return 0; }; launchd_pid() { echo 900; }; start_prod`,
      ],
      {
        environment: {
          ...fakeMac.environment,
          YEP_CODEX_BRIDGE_CONTROL_URL: "http://127.0.0.1:19991",
        },
      },
    );

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("__PLIST_REWRITTEN__");
    const calls = await readFile(fakeMac.launchctlLog, "utf8");
    expect(calls).toContain("bootout");
    expect(calls).toContain("bootstrap");
  });

  it("运行中的生产服务收到显式控制 URL 时先刷新 plist 再重新 bootstrap", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const persistentPlist = path.join(
      fakeMac.homeDir,
      "Library",
      "LaunchAgents",
      "com.yueyuan.yepanywhere.server.plist",
    );
    await mkdir(path.dirname(persistentPlist), { recursive: true });
    await writeFile(persistentPlist, "existing", "utf8");
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `export PATH='${binDir}':$PATH; source '${source}'; require_macos() { return 0; }; check_runtime_bundle() { return 0; }; apply_plist_configuration() { :; }; launchd_running() { return 0; }; port_in_use() { return 0; }; write_server_plist() { echo __RUNNING_PLIST_REWRITTEN__; return 0; }; launchd_loaded() { return 0; }; wait_for_prod() { return 0; }; launchd_pid() { echo 900; }; start_prod`,
      ],
      {
        environment: {
          ...fakeMac.environment,
          YEP_CODEX_BRIDGE_CONTROL_URL: "http://127.0.0.1:19991",
        },
      },
    );

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("__RUNNING_PLIST_REWRITTEN__");
    const calls = await readFile(fakeMac.launchctlLog, "utf8");
    expect(calls).toContain("bootout");
    expect(calls).toContain("bootstrap");
  });

  it("BASE_PATH 也会触发现有生产 plist 刷新", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const persistentPlist = path.join(
      fakeMac.homeDir,
      "Library",
      "LaunchAgents",
      "com.yueyuan.yepanywhere.server.plist",
    );
    await mkdir(path.dirname(persistentPlist), { recursive: true });
    await writeFile(persistentPlist, "existing", "utf8");
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `base_path="$BASE_PATH"; unset YEP_DEPLOY_PORT YEP_DEPLOY_BASE_PATH ALLOWED_IMAGE_PATHS YEP_ANYWHERE_PROFILE YEP_ANYWHERE_DATA_DIR YEP_CODEX_BRIDGE_PORT CODEX_BRIDGE_PORT YEP_CODEX_BRIDGE_CONTROL_URL CODEX_BRIDGE_CONTROL_URL YEP_CLAUDE_BRIDGE_PORT CLAUDE_BRIDGE_PORT YEP_CLAUDE_BRIDGE_CONTROL_URL CLAUDE_BRIDGE_CONTROL_URL YEP_LAUNCHD_SERVER_LABEL YEP_LAUNCHD_NODE YEP_LAUNCHD_PATH YEP_LAUNCHD_LOG_DIR YEP_FCM_SERVICE_ACCOUNT_FILE YEP_FCM_SERVICE_ACCOUNT_JSON GOOGLE_APPLICATION_CREDENTIALS SESSION_TITLE_LLM_API_KEY LLM_API_KEY SESSION_TITLE_LLM_API_BASE LLM_API_BASE SESSION_TITLE_SUB_MODULE LLM_SUB_MODULE SESSION_TITLE_MODEL SESSION_TITLE_TIMEOUT_MS SESSION_TITLE_GENERATION BASE_PATH; export BASE_PATH="$base_path"; export PATH='${binDir}':$PATH; source '${source}'; require_macos() { return 0; }; check_runtime_bundle() { return 0; }; plist_valid() { return 0; }; launchd_running() { return 1; }; port_in_use() { return 1; }; write_server_plist() { echo __BASE_PATH_REWRITTEN__; return 0; }; launchd_loaded() { return 1; }; wait_for_prod() { return 0; }; launchd_pid() { echo 900; }; start_prod`,
      ],
      {
        environment: {
          ...fakeMac.environment,
          BASE_PATH: "/review",
        },
      },
    );

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("__BASE_PATH_REWRITTEN__");
  });

  it("plist 校验拒绝畸形 XML、错误动作、不可执行 Node 和越界端口", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const malformed = path.join(fakeMac.root, "malformed.plist");
    const wrongAction = path.join(fakeMac.root, "wrong-action.plist");
    const missingNode = path.join(fakeMac.root, "missing-node.plist");
    const zeroPort = path.join(fakeMac.root, "zero-port.plist");
    const highPort = path.join(fakeMac.root, "high-port.plist");
    const validAction = path.join(fakeMac.root, "valid-action.plist");
    const fakeNode = path.join(fakeMac.binDir, "node");
    const fakePlutil = path.join(fakeMac.binDir, "plutil");
    const fakeBuddy = path.join(fakeMac.binDir, "PlistBuddy");
    await writeFile(
      malformed,
      `<string>com.yueyuan.yepanywhere.server</string>\n${toBashPath(path.join(repoRoot, "dist", "npm-package", "dist", "cli.js"))}\n<key>RunAtLoad</key>\n<key>KeepAlive</key>\n`,
      "utf8",
    );
    await writeFile(
      wrongAction,
      `<string>com.yueyuan.yepanywhere.server</string>\n${toBashPath(path.join(repoRoot, "dist", "npm-package", "dist", "cli.js"))}\n<key>RunAtLoad</key>\n<key>KeepAlive</key>\n`,
      "utf8",
    );
    await writeFile(validAction, "valid plist fixture", "utf8");
    await writeFile(missingNode, "missing node fixture", "utf8");
    await writeFile(zeroPort, "zero port fixture", "utf8");
    await writeFile(highPort, "high port fixture", "utf8");
    await createExecutable(fakeNode, "#!/usr/bin/env bash\nexit 0\n");
    await createExecutable(
      fakePlutil,
      '#!/usr/bin/env bash\n[[ "$2" != *malformed.plist ]]\n',
    );
    await createExecutable(
      fakeBuddy,
      `#!/usr/bin/env bash\nkey="$2"\nplist="$3"\ncase "$key" in\n  *Label*) echo com.yueyuan.yepanywhere.server ;;\n  *ProgramArguments:0*) if [[ "$plist" == *missing-node.plist ]]; then echo /missing/node; else echo '${toBashPath(fakeNode)}'; fi ;;\n  *ProgramArguments:1*) if [[ "$plist" == *wrong-action.plist ]]; then echo /wrong/cli.js; else echo '${toBashPath(path.join(repoRoot, "dist", "npm-package", "dist", "cli.js"))}'; fi ;;\n  *ProgramArguments:2*) echo --port ;;\n  *ProgramArguments:3*|*EnvironmentVariables:YEP_DEPLOY_PORT*) if [[ "$plist" == *zero-port.plist ]]; then echo 0; elif [[ "$plist" == *high-port.plist ]]; then echo 999999; else echo 8022; fi ;;\n  *WorkingDirectory*) echo '${toBashPath(repoRoot)}' ;;\n  *RunAtLoad*|*KeepAlive*) echo true ;;\nesac\n`,
    );
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const command = `source '${source}'; plist_valid '${toBashPath(malformed)}'; malformed_code=$?; plist_valid '${toBashPath(wrongAction)}'; wrong_code=$?; plist_valid '${toBashPath(missingNode)}'; node_code=$?; plist_valid '${toBashPath(zeroPort)}'; zero_code=$?; plist_valid '${toBashPath(highPort)}'; high_code=$?; plist_valid '${toBashPath(validAction)}'; valid_code=$?; [[ $malformed_code -ne 0 && $wrong_code -ne 0 && $node_code -ne 0 && $zero_code -ne 0 && $high_code -ne 0 && $valid_code -eq 0 ]]`;
    const result = await runBash(["-c", command], {
      environment: {
        ...fakeMac.environment,
        YEP_PLUTIL_BIN: toBashPath(fakePlutil),
        YEP_PLISTBUDDY_BIN: toBashPath(fakeBuddy),
      },
    });

    expect(result.code).toBe(0);
  }, 20_000);

  it("stop-prod 在 bootout 后端口仍被占用时返回失败", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const source = toBashPath(path.join(repoRoot, "yep.sh"));
    const binDir = toBashPath(fakeMac.binDir);
    const result = await runBash(
      [
        "-c",
        `export PATH='${binDir}':$PATH; source '${source}'; require_macos() { return 0; }; calls=0; launchd_loaded() { calls=$((calls + 1)); [[ $calls -eq 1 ]]; }; get_port_pids() { echo 999; }; stop_prod`,
      ],
      {
        environment: {
          ...fakeMac.environment,
          YEP_STOP_WAIT_TRIES: "1",
        },
      },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("999");
    expect(result.stdout).toContain("仍被占用");
  });

  it("安装器可把相同生产定义写到会话 plist 而不加载", async () => {
    const fixture = await createLaunchdFixture();
    const persistentPlist = path.join(
      fixture.homeDir,
      "Library",
      "LaunchAgents",
      "com.yueyuan.yepanywhere.server.plist",
    );
    const sessionPlist = path.join(
      fixture.root,
      "state",
      "com.yueyuan.yepanywhere.server.plist",
    );
    const commonArgs = ["--server-only", "--no-start", "--server-plist"];
    const environment = {
      ...fixture.environment,
      YEP_LAUNCHD_NODE: "/usr/bin/true",
      YEP_ANYWHERE_PROFILE: "review",
      YEP_ANYWHERE_DATA_DIR: toBashPath(
        path.join(fixture.root, "production data"),
      ),
    };

    const persistentResult = await runBash(
      [
        "scripts/install-launchagents.sh",
        ...commonArgs,
        toBashPath(persistentPlist),
      ],
      {
        cwd: fixture.fixtureRepo,
        pathPrefix: fixture.binDir,
        environment,
      },
    );
    const sessionResult = await runBash(
      [
        "scripts/install-launchagents.sh",
        ...commonArgs,
        toBashPath(sessionPlist),
      ],
      {
        cwd: fixture.fixtureRepo,
        pathPrefix: fixture.binDir,
        environment,
      },
    );

    expect(persistentResult.code, persistentResult.stderr).toBe(0);
    expect(sessionResult.code, sessionResult.stderr).toBe(0);
    const persistentContent = await readFile(persistentPlist, "utf8");
    const sessionContent = await readFile(sessionPlist, "utf8");
    expect(sessionContent).toBe(persistentContent);
    expect(sessionContent).toContain("<key>RunAtLoad</key>");
    expect(sessionContent).toContain("<key>KeepAlive</key>");
    expect(sessionContent).toContain("<key>YEP_ANYWHERE_PROFILE</key>");
    expect(sessionContent).toContain("<string>review</string>");
    expect(sessionContent).toContain("<key>YEP_ANYWHERE_DATA_DIR</key>");
    expect(existsSync(fixture.launchctlLog)).toBe(false);
  });

  it("卸载器关闭服务器自启时只删除持久 plist，不停止当前实例", async () => {
    const fixture = await createLaunchdFixture();
    const plist = path.join(
      fixture.homeDir,
      "Library",
      "LaunchAgents",
      "com.yueyuan.yepanywhere.server.plist",
    );
    await mkdir(path.dirname(plist), { recursive: true });
    await writeFile(plist, "fixture", "utf8");

    const result = await runBash(
      ["scripts/uninstall-launchagents.sh", "--server-only", "--no-stop"],
      {
        cwd: fixture.fixtureRepo,
        pathPrefix: fixture.binDir,
        environment: fixture.environment,
      },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(fixture.launchctlLog)).toBe(false);
  });

  it("暂存构建失败时不卸载生产 LaunchAgent 或触碰生产 Bundle", async () => {
    const fakeMac = await createFakeMacEnvironment();
    const pnpmLog = path.join(fakeMac.root, "pnpm.log");
    await createExecutable(
      path.join(fakeMac.binDir, "pnpm"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$YEP_TEST_PNPM_LOG"\nif [[ "$*" == *"build:bundle"* ]]; then printf "__BUILD_OUTPUT__%s\\n" "${YEP_BUNDLE_OUTPUT_DIR:-}"; exit 7; fi\nexit 0\n',
    );

    const result = await runBash(["./yep.sh", "rebuild"], {
      pathPrefix: fakeMac.binDir,
      environment: {
        ...fakeMac.environment,
        YEP_TEST_PNPM_LOG: toBashPath(pnpmLog),
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("npm-package-staging-");
    const buildOutput = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("__BUILD_OUTPUT__"))
      ?.slice("__BUILD_OUTPUT__".length);
    expect(buildOutput).toContain("npm-package-staging-");
    expect(buildOutput).not.toBe(
      toBashPath(path.join(repoRoot, "dist", "npm-package")),
    );
    const launchctlCalls = existsSync(fakeMac.launchctlLog)
      ? await readFile(fakeMac.launchctlLog, "utf8")
      : "";
    expect(launchctlCalls).not.toContain("bootout");
  });
});

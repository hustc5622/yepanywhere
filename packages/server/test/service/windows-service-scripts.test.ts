import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const yepScript = path.join(repoRoot, "scripts", "yep.ps1");
const installTaskScript = path.join(
  repoRoot,
  "scripts",
  "install-task-scheduler.ps1",
);
const runProdScript = path.join(repoRoot, "scripts", "run-yepanywhere.ps1");
const deployScript = path.join(repoRoot, "scripts", "deploy.ps1");
const tempDirs: string[] = [];

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function psLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShellCommand(
  command: string,
  environment: Record<string, string> = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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

async function captureTaskDefinition(
  scriptArgs: string[],
  environment: Record<string, string> = {},
) {
  let taskEnvironment = environment;
  if (!environment.YEP_SERVICE_CONFIG_PATH) {
    const configDir = await mkdtemp(path.join(tmpdir(), "yep-task-config-"));
    tempDirs.push(configDir);
    taskEnvironment = {
      ...environment,
      YEP_SERVICE_CONFIG_PATH: path.join(configDir, "service-config.json"),
    };
  }
  const recordMarker = "__TASK_DEFINITION__";
  const harness = `
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
  $global:record = [ordered]@{
    TriggerCreated = $false
    TriggerUser = $null
    PrincipalUserId = $null
  RegisteredTriggerCount = -1
  RestartCount = 0
  MultipleInstances = $null
  ExecutionTimeLimit = $null
  Started = $false
  ActionArgument = $null
}
function Test-Path {
  param($Path)
  if ([string]$Path -like '*dist\\npm-package\\dist\\cli.js') { return $true }
  return & $global:realTestPath -LiteralPath $Path
}
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'powershell.exe' } }
function New-TimeSpan {
  param([int]$Minutes = 0, [int]$Hours = 0, [int]$Seconds = 0)
  return [pscustomobject]@{ Minutes = $Minutes; Hours = $Hours; Seconds = $Seconds }
}
function New-ScheduledTaskAction {
  param($Execute, $Argument, $WorkingDirectory)
  $global:record['ActionArgument'] = $Argument
  return [pscustomobject]@{ Execute = $Execute; Argument = $Argument; WorkingDirectory = $WorkingDirectory }
}
function New-ScheduledTaskTrigger {
  param([switch]$AtLogOn, [string]$User)
  $global:record['TriggerCreated'] = [bool]$AtLogOn
  $global:record['TriggerUser'] = $User
  return [pscustomobject]@{ AtLogOn = [bool]$AtLogOn; User = $User; Enabled = $true }
}
function New-ScheduledTaskSettingsSet {
  param(
    [switch]$AllowStartIfOnBatteries,
    [switch]$DontStopIfGoingOnBatteries,
    [int]$RestartCount,
    $RestartInterval,
    $ExecutionTimeLimit,
    [string]$MultipleInstances
  )
  $global:record['RestartCount'] = $RestartCount
  $global:record['MultipleInstances'] = $MultipleInstances
  $global:record['ExecutionTimeLimit'] = $ExecutionTimeLimit
  return [pscustomobject]@{}
}
function New-ScheduledTaskPrincipal {
  param($UserId, $LogonType, $RunLevel)
  $global:record['PrincipalUserId'] = $UserId
  return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}
function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
  $global:record['RegisteredTriggerCount'] = if ($PSBoundParameters.ContainsKey('Trigger')) { @($Trigger).Count } else { 0 }
  return [pscustomobject]@{ TaskName = $TaskName }
}
function Start-ScheduledTask { param($TaskName) $global:record['Started'] = $true }
& ${psLiteral(installTaskScript)} ${scriptArgs.map(psLiteral).join(" ")}
Write-Output ('${recordMarker}' + ($global:record | ConvertTo-Json -Compress -Depth 4))
`;
  const result = await runPowerShellCommand(harness, taskEnvironment);
  const markerLine = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(recordMarker));
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(markerLine).toBeDefined();
  return JSON.parse(markerLine?.slice(recordMarker.length) ?? "{}") as {
    TriggerCreated: boolean;
    TriggerUser: string | null;
    PrincipalUserId: string | null;
    RegisteredTriggerCount: number;
    RestartCount: number;
    MultipleInstances: string | null;
    Started: boolean;
    ActionArgument: string;
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "win32")("Windows 服务脚本", () => {
  it("help 使用中文列出统一命令", async () => {
    const result = await runPowerShellCommand(`& ${psLiteral(yepScript)} help`);

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
    expect(result.stdout).not.toContain("Show service");
  });

  it("stop-dev 拒绝结束无法确认身份的端口占用进程", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-service-state-"));
    tempDirs.push(stateDir);
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("缺少测试端口");

    try {
      const result = await runPowerShellCommand(
        `& ${psLiteral(yepScript)} stop-dev`,
        {
          YEP_DEV_PORT: String(address.port),
          YEP_LAUNCHD_LOG_DIR: stateDir,
        },
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(String(address.port));
      expect(result.stdout).toContain("无法确认");
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("start-prod 不把运行中的任务和未知端口占用者误报为受管服务", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-prod-state-"));
    tempDirs.push(stateDir);
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("缺少测试端口");
    const harness = `
function Test-Path {
  param($Path)
  return ([string]$Path -like '*dist\\npm-package\\dist\\cli.js')
}
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Running'
    Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = 'run-yepanywhere.ps1' })
    Triggers = @()
  }
}
& ${psLiteral(yepScript)} start-prod
`;

    try {
      const result = await runPowerShellCommand(harness, {
        YEP_DEPLOY_PORT: String(address.port),
        YEP_LAUNCHD_LOG_DIR: stateDir,
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(String(address.port));
      expect(result.stdout).toContain("无法确认");
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("start-prod 不把只有健康响应但没有受管 PID 和监听端口的任务报为成功", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-prod-no-pid-"));
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        Version: 1,
        ServerPort: "61990",
        BasePath: "/",
        Profile: null,
        DataDir: null,
        AllowedImagePaths: null,
        CodexPort: "4510",
        ClaudePort: "4520",
      }),
      "utf8",
    );
    const harness = `
$global:taskState = 'Ready'
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
function Test-Path {
  param($Path)
  if ([string]$Path -like '*dist\\npm-package\\dist\\cli.js') { return $true }
  return & $global:realTestPath -LiteralPath $Path
}
function netstat { }
function Start-Sleep { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = $global:taskState
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = 'powershell.exe'
      Arguments = '-File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
    })
    Triggers = @()
  }
}
function Start-ScheduledTask { $global:taskState = 'Running' }
function Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
& ${psLiteral(yepScript)} start-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
      YEP_PROD_READY_TRIES: "1",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("PID");
  });

  it("start-prod 和 status 在受管端口健康检查失败时都报告异常", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-prod-unhealthy-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const configPath = path.join(stateDir, "service-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        Version: 1,
        ServerPort: "61990",
        BasePath: "/",
        Profile: null,
        DataDir: null,
        AllowedImagePaths: null,
        CodexPort: "4510",
        ClaudePort: "4520",
      }),
      "utf8",
    );
    await writeFile(
      path.join(stateDir, "prod-process.json"),
      JSON.stringify({
        Version: 1,
        Mode: "prod",
        Processes: [{ Role: "server", Pid: 424242, StartTimeUtc: fixedStart }],
      }),
      "utf8",
    );
    const cliJs = path.join(repoRoot, "dist", "npm-package", "dist", "cli.js");
    const commonHarness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
function Test-Path {
  param($Path)
  return ([string]$Path -like '*dist\\npm-package\\dist\\cli.js') -or ([string]$Path -like '*service-config.json') -or ([string]$Path -like '*prod-process.json')
}
function netstat { Write-Output 'TCP 127.0.0.1:61990 0.0.0.0:0 LISTENING 424242' }
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 424242) { return [pscustomobject]@{ Id = 424242; StartTime = $global:fixedStart; ProcessName = 'node' } }
  return $null
}
function Get-CimInstance {
  return [pscustomobject]@{ ProcessId = 424242; ParentProcessId = 0; CommandLine = '${cliJs.replaceAll("'", "''")} --port 61990' }
}
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Running'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
      WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
    })
    Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
    Triggers = @()
  }
}
function Get-ScheduledTaskInfo { return [pscustomobject]@{ LastTaskResult = 0 } }
function Invoke-WebRequest { throw 'unhealthy' }
`;

    const start = await runPowerShellCommand(
      `${commonHarness}\n& ${psLiteral(yepScript)} start-prod`,
      {
        YEP_LAUNCHD_LOG_DIR: stateDir,
        YEP_SERVICE_CONFIG_PATH: configPath,
      },
    );
    const status = await runPowerShellCommand(
      `${commonHarness}\n& ${psLiteral(yepScript)} status`,
      {
        YEP_LAUNCHD_LOG_DIR: stateDir,
        YEP_SERVICE_CONFIG_PATH: configPath,
      },
    );

    expect(start.code).toBe(1);
    expect(start.stdout).toContain("异常");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("生产模式：配置异常");
  });

  it("开发服务健康检查超时时清理启动器和 PID 元数据", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-dev-timeout-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
$global:killed = $false
function netstat { }
function Start-Sleep { }
function Invoke-WebRequest { throw 'not healthy' }
function Start-Process {
  return [pscustomobject]@{ Id = 424242; StartTime = $global:fixedStart }
}
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 424242 -and -not $global:killed) { return [pscustomobject]@{ Id = 424242; StartTime = $global:fixedStart; ProcessName = 'powershell' } }
  return $null
}
function Get-CimInstance {
  if ($global:killed) { return @() }
  return [pscustomobject]@{ ProcessId = 424242; CommandLine = '${yepScript.replaceAll("'", "''")} __run-dev'; ParentProcessId = 0 }
}
function taskkill.exe { Write-Host '__TASKKILL__'; $global:killed = $true; & cmd.exe /c exit 0 }
& ${psLiteral(yepScript)} start-dev
`;
    const result = await runPowerShellCommand(harness, {
      YEP_DEV_PORT: "61991",
      YEP_DEV_MAINT_PORT: "61992",
      YEP_DEV_VITE_PORT: "61993",
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("__TASKKILL__");
    expect(existsSync(path.join(stateDir, "dev-process.json"))).toBe(false);
  });

  it("重复 start-dev 要求健康检查和三个开发端口都归属于元数据进程树", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-dev-ready-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    await writeFile(
      path.join(stateDir, "dev-process.json"),
      JSON.stringify({
        Version: 1,
        Mode: "dev",
        Profile: "dev",
        Processes: [
          { Role: "launcher", Pid: 424242, StartTimeUtc: fixedStart },
        ],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
function netstat { Write-Output 'TCP 127.0.0.1:61991 0.0.0.0:0 LISTENING 424242' }
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 424242) { return [pscustomobject]@{ Id = 424242; StartTime = $global:fixedStart; ProcessName = 'powershell' } }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  return [pscustomobject]@{ ProcessId = 424242; ParentProcessId = 0; CommandLine = '${yepScript.replaceAll("'", "''")} __run-dev' }
}
function Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
function Start-Process { throw '__UNEXPECTED_START__' }
& ${psLiteral(yepScript)} start-dev
`;
    const result = await runPowerShellCommand(harness, {
      YEP_DEV_PORT: "61991",
      YEP_DEV_MAINT_PORT: "61992",
      YEP_DEV_VITE_PORT: "61993",
      YEP_LAUNCHD_LOG_DIR: stateDir,
    });

    expect(result.code).toBe(1);
    expect(result.stdout, result.stderr).toContain("三个开发端口");
  });

  it("stop-prod 拒绝停止动作异常的同名计划任务", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-invalid-task-"));
    tempDirs.push(stateDir);
    const harness = `
function netstat { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Running'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{ Execute = 'cmd.exe'; Arguments = '/c unrelated.cmd' })
    Triggers = @()
  }
}
function Stop-ScheduledTask { Write-Host '__STOPPED_INVALID_TASK__' }
& ${psLiteral(yepScript)} stop-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("配置异常");
    expect(result.stdout).not.toContain("__STOPPED_INVALID_TASK__");
  });

  it("stop-prod 在计划任务停止命令失败时不进入进程清理", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-task-stop-failed-"),
    );
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    const harness = `
function netstat { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Running'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
      WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
    })
    Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
    Triggers = @()
  }
}
function Stop-ScheduledTask { throw 'access denied' }
function taskkill.exe { Write-Output '__UNEXPECTED_TASKKILL__' }
& ${psLiteral(yepScript)} stop-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("停止计划任务失败");
    expect(result.stdout).not.toContain("__UNEXPECTED_TASKKILL__");
  });

  it("stop-prod 等待计划任务离开 Running，超时则不进入进程清理", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-task-still-running-"),
    );
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    const harness = `
function netstat { }
function Start-Sleep { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Running'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
      WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
    })
    Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
    Triggers = @()
  }
}
function Stop-ScheduledTask { Write-Output '__STOP_REQUESTED__' }
function taskkill.exe { Write-Output '__UNEXPECTED_TASKKILL__' }
& ${psLiteral(yepScript)} stop-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
      YEP_TASK_STOP_WAIT_TRIES: "1",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("仍在运行");
    expect(result.stdout).not.toContain("__UNEXPECTED_TASKKILL__");
  });

  it("stop-prod 在请求停止计划任务前快照进程树以发现重挂父进程的子进程", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-task-reparented-child-"),
    );
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const configPath = path.join(stateDir, "service-config.json");
    const stateFile = path.join(stateDir, "prod-process.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        Processes: [{ Pid: 100, Role: "supervisor", StartTimeUtc: fixedStart }],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
$global:taskStopped = $false
function netstat { }
function Start-Sleep { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = $(if ($global:taskStopped) { 'Ready' } else { 'Running' })
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
      WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
    })
    Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
    Triggers = @()
  }
}
function Stop-ScheduledTask { $global:taskStopped = $true }
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 100 -and -not $global:taskStopped) { return [pscustomobject]@{ Id = 100; StartTime = $global:fixedStart; ProcessName = 'powershell' } }
  if ($Id -eq 101) { return [pscustomobject]@{ Id = 101; StartTime = $global:fixedStart.AddSeconds(1); ProcessName = 'node' } }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @([pscustomobject]@{ ProcessId = 101; ParentProcessId = $(if ($global:taskStopped) { 0 } else { 100 }); CommandLine = 'node child-worker.js' })
  if (-not $global:taskStopped) {
    $items = @([pscustomobject]@{ ProcessId = 100; ParentProcessId = 0; CommandLine = '${runProdScript.replaceAll("'", "''")}' }) + $items
  }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { $_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function taskkill.exe { & cmd.exe /c exit 0 }
& ${psLiteral(yepScript)} stop-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("101");
    expect(existsSync(stateFile)).toBe(true);
  });

  it("进程树批量枚举失败时 stop-prod 安全失败且不调用 taskkill", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-snapshot-failed-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const stateFile = path.join(stateDir, "prod-process.json");
    const killMarker = path.join(stateDir, "taskkill.txt");
    await writeFile(
      stateFile,
      JSON.stringify({
        Processes: [{ Pid: 100, Role: "supervisor", StartTimeUtc: fixedStart }],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
function netstat { }
function Get-ScheduledTask { return $null }
function Get-Process {
  return [pscustomobject]@{ Id = 100; StartTime = $global:fixedStart; ProcessName = 'powershell' }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if ($Filter) {
    return [pscustomobject]@{ ProcessId = 100; ParentProcessId = 0; CommandLine = '${runProdScript.replaceAll("'", "''")}' }
  }
  throw 'tree enumeration failed'
}
function taskkill.exe { [IO.File]::WriteAllText($env:YEP_TEST_KILL_MARKER, 'called'); & cmd.exe /c exit 0 }
& ${psLiteral(yepScript)} stop-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
      YEP_TEST_KILL_MARKER: killMarker,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("无法枚举");
    expect(existsSync(killMarker)).toBe(false);
    expect(existsSync(stateFile)).toBe(true);
  });

  it("缺失持久服务配置时监督器安全失败且 status 报配置异常", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-missing-config-"));
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "missing-service-config.json");
    const startMarkerPath = path.join(stateDir, "unexpected-start.txt");
    const supervisorHarness = `
function Test-Path {
  param($Path)
  return ([string]$Path -like '*dist\\npm-package*')
}
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'node.exe' } }
function Get-NetTCPConnection { return @() }
function Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
function node { & cmd.exe /c exit 0 }
function Start-Process {
  [IO.File]::WriteAllText($env:YEP_TEST_START_MARKER, 'started')
  return [pscustomobject]@{ Id = 100; StartTime = [DateTime]::UtcNow; HasExited = $true }
}
& ${psLiteral(runProdScript)} -ConfigPath ${psLiteral(configPath)}
`;

    const supervisor = await runPowerShellCommand(supervisorHarness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_TEST_START_MARKER: startMarkerPath,
    });
    expect(supervisor.code).toBe(1);
    expect(supervisor.stdout).toContain("配置");
    expect(existsSync(startMarkerPath)).toBe(false);

    const statusHarness = `
function netstat { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Ready'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = 'powershell.exe'
      Arguments = '-File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
    })
    Triggers = @([pscustomobject]@{
      Enabled = $true
      UserId = "$env:USERDOMAIN\\$env:USERNAME"
      CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
    })
  }
}
function Get-ScheduledTaskInfo { return [pscustomobject]@{ LastTaskResult = 0 } }
& ${psLiteral(yepScript)} status
`;
    const status = await runPowerShellCommand(statusHarness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
    });

    expect(status.code).toBe(0);
    expect(status.stdout).toContain("生产自启动：配置异常");
  });

  it("已存在但为空或 schema 无效的服务配置会原样保留且拒绝注册任务", async () => {
    const invalidConfigs = [
      "",
      "{}",
      JSON.stringify({
        Version: 1,
        ServerPort: "8022",
        BasePath: "/",
        Profile: {},
        DataDir: null,
        AllowedImagePaths: null,
        CodexPort: "4510",
        ClaudePort: "4520",
      }),
    ];

    for (const [index, contents] of invalidConfigs.entries()) {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-invalid-config-"),
      );
      tempDirs.push(stateDir);
      const configPath = path.join(stateDir, "service-config.json");
      const registerMarker = path.join(stateDir, "registered.txt");
      await writeFile(configPath, contents, "utf8");
      const harness = `
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
function Test-Path {
  param($Path)
  if ([string]$Path -like '*dist\\npm-package\\dist\\cli.js') { return $true }
  return & $global:realTestPath -LiteralPath $Path
}
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'powershell.exe' } }
function Register-ScheduledTask { [IO.File]::WriteAllText($env:YEP_TEST_REGISTER_MARKER, 'registered') }
& ${psLiteral(installTaskScript)} --manual-only
`;
      const result = await runPowerShellCommand(harness, {
        YEP_SERVICE_CONFIG_PATH: configPath,
        YEP_TEST_REGISTER_MARKER: registerMarker,
      });

      expect(
        result.code,
        `case ${index}: ${result.stderr || result.stdout}`,
      ).toBe(1);
      expect(await readFile(configPath, "utf8")).toBe(contents);
      expect(existsSync(registerMarker)).toBe(false);
    }
  });

  it("监督器拒绝对象类型的可空配置字段且不会启动进程", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-object-config-"));
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    const startMarker = path.join(stateDir, "started.txt");
    await writeFile(
      configPath,
      JSON.stringify({
        Version: 1,
        ServerPort: "8022",
        BasePath: "/",
        Profile: { Name: "default" },
        DataDir: null,
        AllowedImagePaths: null,
        CodexPort: "4510",
        ClaudePort: "4520",
      }),
      "utf8",
    );
    const harness = `
function Test-Path { return $true }
function Start-Process { [IO.File]::WriteAllText($env:YEP_TEST_START_MARKER, 'started') }
& ${psLiteral(runProdScript)} -ConfigPath ${psLiteral(configPath)}
`;
    const result = await runPowerShellCommand(harness, {
      YEP_TEST_START_MARKER: startMarker,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("配置");
    expect(existsSync(startMarker)).toBe(false);
  });

  it("taskkill 失败且进程仍存活时 stop-prod 保留元数据并返回失败", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-stop-residual-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const stateFile = path.join(stateDir, "prod-process.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        Processes: [
          {
            Pid: 424242,
            Role: "supervisor",
            StartTimeUtc: fixedStart,
          },
        ],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
function netstat { }
function Get-ScheduledTask { return $null }
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 424242) { return [pscustomobject]@{ Id = 424242; StartTime = $global:fixedStart; ProcessName = 'powershell' } }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  return [pscustomobject]@{
    ProcessId = 424242
    ParentProcessId = 0
    CommandLine = '${runProdScript.replaceAll("'", "''")}'
  }
}
function taskkill.exe { Write-Output '__TASKKILL_FAILED__'; & cmd.exe /c exit 5 }
function Start-Sleep { }
& ${psLiteral(yepScript)} stop-prod
`;

    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("__TASKKILL_FAILED__");
    expect(result.stdout).toContain("仍在运行");
    expect(existsSync(stateFile)).toBe(true);
  });

  it("stop-prod 只终止已核实的生产根进程而不重复 taskkill 子进程", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-stop-tree-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const stateFile = path.join(stateDir, "prod-process.json");
    const killLogPath = path.join(stateDir, "kill.log");
    await writeFile(
      stateFile,
      JSON.stringify({
        Processes: [
          { Pid: 100, Role: "supervisor", StartTimeUtc: fixedStart },
          { Pid: 101, Role: "server", StartTimeUtc: fixedStart },
          { Pid: 102, Role: "codex-bridge", StartTimeUtc: fixedStart },
        ],
      }),
      "utf8",
    );
    const cliJs = path.join(repoRoot, "dist", "npm-package", "dist", "cli.js");
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
$global:killed = $false
function netstat { }
function Get-ScheduledTask { return $null }
function Get-Process {
  param($Id, $ErrorAction)
  if (-not $global:killed -and $Id -in @(100, 101, 102)) {
    return [pscustomobject]@{ Id = $Id; StartTime = $global:fixedStart; ProcessName = 'node' }
  }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if ($global:killed) { return @() }
  $items = @(
    [pscustomobject]@{ ProcessId = 100; ParentProcessId = 0; CommandLine = '${runProdScript.replaceAll("'", "''")}' },
    [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100; CommandLine = '${cliJs.replaceAll("'", "''")} --port 8022' },
    [pscustomobject]@{ ProcessId = 102; ParentProcessId = 100; CommandLine = '${cliJs.replaceAll("'", "''")} --codex-bridge-only' }
  )
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { $_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function taskkill.exe {
  param($PidFlag, $TargetPid, $TreeFlag, $ForceFlag)
  [IO.File]::AppendAllText($env:YEP_TEST_KILL_LOG, "__KILL__$TargetPid;")
  if ([int]$TargetPid -eq 100) { $global:killed = $true; & cmd.exe /c exit 0 } else { & cmd.exe /c exit 5 }
}
function Start-Sleep { }
& ${psLiteral(yepScript)} stop-prod
`;

    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
      YEP_TEST_KILL_LOG: killLogPath,
    });
    const killLog = await readFile(killLogPath, "utf8");

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(killLog).toContain("__KILL__100");
    expect(killLog).not.toContain("__KILL__101");
    expect(killLog).not.toContain("__KILL__102");
    expect(existsSync(stateFile)).toBe(false);
  });

  it("stop-prod 用停止前快照发现根进程退出后重挂父进程的残留子进程", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-reparented-child-"),
    );
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const stateFile = path.join(stateDir, "prod-process.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        Processes: [{ Pid: 100, Role: "supervisor", StartTimeUtc: fixedStart }],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
$global:rootKilled = $false
function netstat { }
function Get-ScheduledTask { return $null }
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 100 -and -not $global:rootKilled) { return [pscustomobject]@{ Id = 100; StartTime = $global:fixedStart; ProcessName = 'powershell' } }
  if ($Id -eq 101) { return [pscustomobject]@{ Id = 101; StartTime = $global:fixedStart.AddSeconds(1); ProcessName = 'node' } }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @([pscustomobject]@{ ProcessId = 101; ParentProcessId = $(if ($global:rootKilled) { 0 } else { 100 }); CommandLine = 'node child-worker.js' })
  if (-not $global:rootKilled) {
    $items = @([pscustomobject]@{ ProcessId = 100; ParentProcessId = 0; CommandLine = '${runProdScript.replaceAll("'", "''")}' }) + $items
  }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { $_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function taskkill.exe { $global:rootKilled = $true; & cmd.exe /c exit 0 }
function Start-Sleep { }
& ${psLiteral(yepScript)} stop-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("101");
    expect(existsSync(stateFile)).toBe(true);
  });

  it("start-prod 修复缺失配置时保留登录自启动意图且核验安装结果", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-repair-autostart-"),
    );
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "missing-service-config.json");
    const installArgsPath = path.join(stateDir, "install-args.txt");
    const harness = `
function Test-Path {
  param($Path)
  return ([string]$Path -like '*dist\\npm-package\\dist\\cli.js')
}
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'powershell.exe' } }
function netstat { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Ready'
    Actions = @([pscustomobject]@{
      Execute = 'powershell.exe'
      Arguments = '-File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
    })
    Triggers = @([pscustomobject]@{
      Enabled = $true
      CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
    })
  }
}
function powershell.exe {
  param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  [IO.File]::WriteAllText($env:YEP_TEST_INSTALL_ARGS, ($Arguments -join ' '))
  & cmd.exe /c exit 0
}
function Start-ScheduledTask { param($TaskName) Write-Output '__TASK_STARTED__' }
function Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
& ${psLiteral(yepScript)} start-prod
`;

    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
      YEP_TEST_INSTALL_ARGS: installArgsPath,
    });
    const installArgs = await readFile(installArgsPath, "utf8");

    expect(result.code, result.stderr || result.stdout).toBe(1);
    expect(result.stdout).toContain("配置仍无效");
    expect(installArgs).toContain("--enable-autostart");
    expect(installArgs).not.toContain("--manual-only");
  });

  it("人工生产任务没有登录触发器且不会在注册时启动", async () => {
    const definition = await captureTaskDefinition(["--manual-only"]);

    expect(definition.RegisteredTriggerCount).toBe(0);
    expect(definition.Started).toBe(false);
    expect(definition.RestartCount).toBe(999);
    expect(definition.MultipleInstances).toBe("IgnoreNew");
    expect(definition.ActionArgument).toContain("run-yepanywhere.ps1");
    expect(definition.ActionArgument).toContain("-WindowStyle Hidden");
  });

  it("自启动任务只增加登录触发器而不启动当前实例", async () => {
    const definition = await captureTaskDefinition(["--enable-autostart"]);

    expect(definition.TriggerCreated).toBe(true);
    expect(definition.TriggerUser).toBe(definition.PrincipalUserId);
    expect(definition.RegisteredTriggerCount).toBe(1);
    expect(definition.Started).toBe(false);
    expect(definition.RestartCount).toBe(999);
    expect(definition.MultipleInstances).toBe("IgnoreNew");
  });

  it("既有任意用户登录触发器会被 status 判异常并按当前用户自启动意图修复", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-wrong-trigger-user-"),
    );
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    const installArgsPath = path.join(stateDir, "install-args.txt");
    await writeFile(
      configPath,
      JSON.stringify({
        Version: 1,
        ServerPort: "61990",
        BasePath: "/",
        Profile: null,
        DataDir: null,
        AllowedImagePaths: null,
        CodexPort: "4510",
        ClaudePort: "4520",
      }),
      "utf8",
    );
    const commonHarness = `
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
function Test-Path {
  param($Path)
  if ([string]$Path -like '*dist\\npm-package\\dist\\cli.js') { return $true }
  return & $global:realTestPath -LiteralPath $Path
}
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'powershell.exe' } }
function netstat { }
function Start-Sleep { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Ready'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = 'powershell.exe'
      Arguments = '-File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
    })
    Triggers = @([pscustomobject]@{
      Enabled = $true
      UserId = ''
      CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
    })
  }
}
function Get-ScheduledTaskInfo { return [pscustomobject]@{ LastTaskResult = 0 } }
`;
    const status = await runPowerShellCommand(
      `${commonHarness}\n& ${psLiteral(yepScript)} status`,
      {
        YEP_LAUNCHD_LOG_DIR: stateDir,
        YEP_SERVICE_CONFIG_PATH: configPath,
      },
    );
    const start = await runPowerShellCommand(
      `${commonHarness}
function powershell.exe {
  param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  [IO.File]::WriteAllText($env:YEP_TEST_INSTALL_ARGS, ($Arguments -join ' '))
  & cmd.exe /c exit 1
}
function Start-ScheduledTask { Write-Output '__UNEXPECTED_START__' }
& ${psLiteral(yepScript)} start-prod`,
      {
        YEP_LAUNCHD_LOG_DIR: stateDir,
        YEP_SERVICE_CONFIG_PATH: configPath,
        YEP_TEST_INSTALL_ARGS: installArgsPath,
      },
    );

    expect(status.code).toBe(0);
    expect(status.stdout).toContain("生产自启动：配置异常");
    expect(start.code).toBe(1);
    expect(start.stdout).not.toContain("__UNEXPECTED_START__");
    expect(existsSync(installArgsPath)).toBe(true);
    expect(await readFile(installArgsPath, "utf8")).toContain(
      "--enable-autostart",
    );
  });

  it("Task Scheduler 规范化为本地用户名和 null Triggers 时仍识别人工任务", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-normalized-manual-task-"),
    );
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        Version: 1,
        ServerPort: "61990",
        BasePath: "/",
        Profile: null,
        DataDir: null,
        AllowedImagePaths: null,
        CodexPort: "4510",
        ClaudePort: "4520",
      }),
      "utf8",
    );
    const harness = `
function netstat { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Ready'
    Principal = [pscustomobject]@{ UserId = $env:USERNAME }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
      WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
    })
    Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
    Triggers = $null
  }
}
function Get-ScheduledTaskInfo { return [pscustomobject]@{ LastTaskResult = 0 } }
& ${psLiteral(yepScript)} status
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("生产自启动：已关闭");
    expect(result.stdout).not.toContain("生产自启动：配置异常");
  });

  it("近似任务动作、错误工作目录或 Parallel 设置会被判异常且拒绝停止", async () => {
    const variants = ["fake-exe", "backup-script", "wrong-cwd", "parallel"];
    for (const variant of variants) {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-invalid-definition-"),
      );
      tempDirs.push(stateDir);
      const configPath = path.join(stateDir, "service-config.json");
      const stopMarker = path.join(stateDir, "stopped.txt");
      await writeFile(
        configPath,
        JSON.stringify({
          Version: 1,
          ServerPort: "61990",
          BasePath: "/",
          Profile: null,
          DataDir: null,
          AllowedImagePaths: null,
          CodexPort: "4510",
          ClaudePort: "4520",
        }),
        "utf8",
      );
      const commonHarness = `
$global:taskState = 'Running'
$action = [pscustomobject]@{
  Execute = (Get-Command powershell.exe).Source
  Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
  WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
}
$settings = [pscustomobject]@{
  MultipleInstances = 'IgnoreNew'
  RestartCount = 999
  RestartInterval = 'PT1M'
  ExecutionTimeLimit = 'PT0S'
}
switch ($env:YEP_TEST_TASK_VARIANT) {
  'fake-exe' { $action.Execute = 'C:\\fake\\notpowershell-helper.exe' }
  'backup-script' { $action.Arguments = $action.Arguments.Replace('run-yepanywhere.ps1', 'run-yepanywhere.ps1.bak') }
  'wrong-cwd' { $action.WorkingDirectory = 'C:\\unrelated' }
  'parallel' { $settings.MultipleInstances = 'Parallel' }
}
function netstat { }
function Start-Sleep { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = $global:taskState
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @($action)
    Settings = $settings
    Triggers = @()
  }
}
function Get-ScheduledTaskInfo { return [pscustomobject]@{ LastTaskResult = 0 } }
`;
      const status = await runPowerShellCommand(
        `${commonHarness}\n& ${psLiteral(yepScript)} status`,
        {
          YEP_LAUNCHD_LOG_DIR: stateDir,
          YEP_SERVICE_CONFIG_PATH: configPath,
          YEP_TEST_TASK_VARIANT: variant,
        },
      );
      const stop = await runPowerShellCommand(
        `${commonHarness}
function Stop-ScheduledTask {
  [IO.File]::WriteAllText($env:YEP_TEST_STOP_MARKER, 'stopped')
  $global:taskState = 'Ready'
}
& ${psLiteral(yepScript)} stop-prod`,
        {
          YEP_LAUNCHD_LOG_DIR: stateDir,
          YEP_SERVICE_CONFIG_PATH: configPath,
          YEP_TEST_TASK_VARIANT: variant,
          YEP_TEST_STOP_MARKER: stopMarker,
        },
      );

      expect(
        status.stdout,
        `${variant}: ${status.stderr || status.stdout}`,
      ).toContain("生产自启动：配置异常");
      expect(stop.code).toBe(1);
      expect(existsSync(stopMarker)).toBe(false);
    }
  }, 20_000);

  it("计划任务持久化生产端口、Profile 和数据目录", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-task-config-"));
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    const dataDir = path.join(stateDir, "production data");

    const definition = await captureTaskDefinition(["--manual-only"], {
      YEP_DEPLOY_PORT: "19000",
      YEP_ANYWHERE_PROFILE: "review",
      YEP_ANYWHERE_DATA_DIR: dataDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
    });

    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      ServerPort: string;
      Profile: string;
      DataDir: string;
    };
    expect(config).toMatchObject({
      ServerPort: "19000",
      Profile: "review",
      DataDir: dataDir,
    });
    expect(definition.ActionArgument).toContain("-ConfigPath");
    expect(definition.ActionArgument).toContain(configPath);
  });

  it("生产监督器在关键进程退出后清理同实例并返回非零", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-prod-state-"));
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        Version: 1,
        ServerPort: "8022",
        BasePath: "/",
        Profile: "review",
        DataDir: stateDir,
        AllowedImagePaths: null,
        CodexPort: "4510",
        ClaudePort: "4520",
      }),
      "utf8",
    );
    const harness = `
$global:started = @()
$global:failed = $false
function Test-Path { param($Path) return $true }
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'node.exe' } }
function Get-NetTCPConnection { return @() }
function Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
function node { & cmd.exe /c exit 0 }
function npm { throw '监督器不应安装运行依赖' }
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
  $process = [pscustomobject]@{ Id = 100 + $global:started.Count; StartTime = [DateTime]::UtcNow; HasExited = $false }
  $global:started += $process
  return $process
}
function Start-Sleep { $global:failed = $true; if ($global:started.Count -gt 1) { $global:started[1].HasExited = $true } }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) Write-Output "__STOPPED__$Id" }
& ${psLiteral(runProdScript)}
`;

    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("关键进程");
    expect(result.stdout).toContain("__STOPPED__100");
    expect(result.stdout).toContain("__STOPPED__102");
  });

  it("暂存构建失败时不停止生产进程或触碰生产 Bundle", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-deploy-state-"));
    tempDirs.push(stateDir);
    const harness = `
function Test-Path { param($Path) return ([string]$Path -ne $env:YEP_SERVICE_CONFIG_PATH) }
function Remove-Item { param($LiteralPath, [switch]$Recurse, [switch]$Force, $ErrorAction, $Path) }
function netstat { Write-Output '  TCP    0.0.0.0:8022    0.0.0.0:0    LISTENING    4242' }
function Get-Process { param($Id, $ErrorAction) return [pscustomobject]@{ Id = $Id; ProcessName = 'fake-prod' } }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) Write-Output "__STOPPED__$Id" }
function Start-Sleep { }
function node {
  Write-Output '0.4.29'
  & cmd.exe /c exit 0
}
function pnpm {
  param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  if ($Arguments -contains 'build:bundle') {
    Write-Host "__BUILD_OUTPUT__$env:YEP_BUNDLE_OUTPUT_DIR"
    & cmd.exe /c exit 7
  } else {
    & cmd.exe /c exit 0
  }
}
& ${psLiteral(deployScript)} --server-only --skip-checks
`;

    const result = await runPowerShellCommand(harness, {
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });
    const outputLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("__BUILD_OUTPUT__"));
    const buildOutput = outputLine?.slice("__BUILD_OUTPUT__".length) ?? "";

    expect(result.code).not.toBe(0);
    expect(buildOutput, result.stderr || result.stdout).toContain("staging");
    expect(path.resolve(buildOutput)).not.toBe(
      path.join(repoRoot, "dist", "npm-package"),
    );
    expect(result.stdout).not.toContain("__STOPPED__");
  });
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminPasswordService } from "../../src/auth/AdminPasswordService.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const yepScript = path.join(repoRoot, "scripts", "yep.ps1");
const installTaskScript = path.join(
  repoRoot,
  "scripts",
  "install-task-scheduler.ps1",
);
const runProdScript = path.join(repoRoot, "scripts", "run-yepanywhere.ps1");
const watchdogScript = path.join(repoRoot, "scripts", "watch-yepanywhere.ps1");
const productionRuntimeScript = path.join(
  repoRoot,
  "scripts",
  "production-runtime.ps1",
);
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
  TriggerClass = $null
  TriggerRepetitionInterval = $null
  TriggerRepetitionDuration = $null
  RestartCount = 0
  RestartInterval = $null
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
  param([switch]$AtLogOn, [string]$User, [switch]$Once, $At, $RepetitionInterval)
  if ($AtLogOn) {
    $global:record['TriggerCreated'] = $true
    $global:record['TriggerUser'] = $User
    return [pscustomobject]@{
      AtLogOn = $true
      User = $User
      Enabled = $true
      Repetition = $null
      CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
    }
  }
  return [pscustomobject]@{
    Repetition = [pscustomobject]@{
      Interval = $RepetitionInterval
      Duration = ''
      StopAtDurationEnd = $false
    }
  }
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
  $global:record['RestartInterval'] = $RestartInterval
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
  if ($PSBoundParameters.ContainsKey('Trigger')) {
    $registeredTrigger = @($Trigger) | Select-Object -First 1
    $global:record['TriggerClass'] = [string]$registeredTrigger.CimClass.CimClassName
    $global:record['TriggerRepetitionInterval'] = $registeredTrigger.Repetition.Interval
    $global:record['TriggerRepetitionDuration'] = [string]$registeredTrigger.Repetition.Duration
  }
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
    TriggerClass: string | null;
    TriggerRepetitionInterval: {
      Minutes: number;
      Hours: number;
      Seconds: number;
    } | null;
    TriggerRepetitionDuration: string | null;
    RestartCount: number;
    RestartInterval: { Minutes: number; Hours: number; Seconds: number } | null;
    MultipleInstances: string | null;
    ExecutionTimeLimit: {
      Minutes: number;
      Hours: number;
      Seconds: number;
    } | null;
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
      "setup-admin-password",
      "help",
    ]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).not.toContain("Show service");
  });

  it.each([
    { name: "failed", childExit: 23, expectedExit: 1 },
    { name: "successful", childExit: 0, expectedExit: 0 },
  ])(
    "rebuild exposes $name deploy output and exit status",
    async ({ name, childExit, expectedExit }) => {
      const fixtureRoot = await mkdtemp(
        path.join(tmpdir(), "yep-rebuild-cli-"),
      );
      tempDirs.push(fixtureRoot);
      const scriptsDir = await mkdtemp(path.join(fixtureRoot, "scripts-"));
      const fixtureYep = path.join(scriptsDir, "yep.ps1");
      const marker = `__REBUILD_CHILD_${name.toUpperCase()}__`;
      await Promise.all([
        copyFile(yepScript, fixtureYep),
        copyFile(
          productionRuntimeScript,
          path.join(scriptsDir, "production-runtime.ps1"),
        ),
        copyFile(
          path.join(repoRoot, "scripts", "service-config.ps1"),
          path.join(scriptsDir, "service-config.ps1"),
        ),
        writeFile(
          path.join(scriptsDir, "deploy.ps1"),
          `Write-Output ${psLiteral(marker)}\nexit ${childExit}\n`,
          "utf8",
        ),
      ]);

      const result = await runPowerShellCommand(
        `& ${psLiteral(fixtureYep)} rebuild`,
        {
          YEP_LAUNCHD_LOG_DIR: fixtureRoot,
          YEP_SERVICE_CONFIG_PATH: path.join(
            fixtureRoot,
            "missing-service-config.json",
          ),
        },
      );

      expect.soft(result.stdout).toContain(marker);
      expect.soft(result.code).toBe(expectedExit);
    },
  );

  it("setup-admin-password 通过 PowerShell 隐藏输入设置管理员密码", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-admin-command-"));
    tempDirs.push(stateDir);
    const password = "测试-integration-only-admin-password";
    const adminFilePath = path.join(stateDir, ".yep-anywhere", "admin.json");
    const harness = `
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  if (-not $AsSecureString) { throw 'Expected hidden PowerShell input' }
  return ConvertTo-SecureString ${psLiteral(password)} -AsPlainText -Force
}
. ${psLiteral(yepScript)} help
if (-not (Cmd-SetupAdminPassword)) { exit 1 }
`;

    const result = await runPowerShellCommand(harness, {
      APPDATA: stateDir,
      HOME: stateDir,
      LOCALAPPDATA: stateDir,
      USERPROFILE: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      Buffer.from(password, "utf8").toString("base64"),
    );
    const adminPasswordService = new AdminPasswordService({
      filePath: adminFilePath,
    });
    await expect(adminPasswordService.verifyPassword(password)).resolves.toBe(
      true,
    );
  });

  it("setup-admin-password 输入不一致时失败且不写入管理员配置", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-admin-mismatch-"));
    tempDirs.push(stateDir);
    const password = "first-integration-password";
    const confirmation = "second-integration-password";
    const adminFilePath = path.join(stateDir, ".yep-anywhere", "admin.json");
    const harness = `
$global:passwordInputs = @(
  (ConvertTo-SecureString ${psLiteral(password)} -AsPlainText -Force),
  (ConvertTo-SecureString ${psLiteral(confirmation)} -AsPlainText -Force)
)
$global:passwordInputIndex = 0
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  if (-not $AsSecureString) { throw 'Expected hidden PowerShell input' }
  $value = $global:passwordInputs[$global:passwordInputIndex]
  $global:passwordInputIndex++
  return $value
}
. ${psLiteral(yepScript)} help
if (Cmd-SetupAdminPassword) { exit 1 }
`;

    const result = await runPowerShellCommand(harness, {
      APPDATA: stateDir,
      HOME: stateDir,
      LOCALAPPDATA: stateDir,
      USERPROFILE: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    for (const value of [password, confirmation]) {
      expect(output).not.toContain(value);
      expect(output).not.toContain(
        Buffer.from(value, "utf8").toString("base64"),
      );
    }
    await expect(readFile(adminFilePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("交互菜单逐项分发全部选择并在 q 后退出", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-menu-dispatch-"));
    tempDirs.push(stateDir);
    const markerPath = path.join(stateDir, "menu.log");
    const harness = `
. ${psLiteral(yepScript)} help
$global:choices = @('1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'd', 'h', 'q')
$global:choiceIndex = 0
function Add-MenuMarker([string]$value) {
  [IO.File]::AppendAllText($env:YEP_TEST_MENU_MARKER, $value + [Environment]::NewLine)
}
function Read-Host { $choice = $global:choices[$global:choiceIndex]; $global:choiceIndex++; return $choice }
function Cmd-StartDev { Add-MenuMarker 'start-dev'; return $true }
function Cmd-StopDev { Add-MenuMarker 'stop-dev'; return $true }
function Cmd-RestartDev { Add-MenuMarker 'restart-dev'; return $true }
function Cmd-StartProd { Add-MenuMarker 'start-prod'; return $true }
function Cmd-StopProd { Add-MenuMarker 'stop-prod'; return $true }
function Cmd-RestartProd { Add-MenuMarker 'restart-prod'; return $true }
function Cmd-Stop { Add-MenuMarker 'stop'; return $true }
function Cmd-Status { Add-MenuMarker 'status'; return $true }
function Cmd-Rebuild { Add-MenuMarker 'rebuild'; return $true }
function Cmd-EnableAutostart { Add-MenuMarker 'enable-autostart'; return $true }
function Cmd-DisableAutostart { Add-MenuMarker 'disable-autostart'; return $true }
function Show-Help { Add-MenuMarker 'help' }
Show-Menu
Add-MenuMarker 'returned'
`;

    const result = await runPowerShellCommand(harness, {
      YEP_TEST_MENU_MARKER: markerPath,
    });
    const markers = (await readFile(markerPath, "utf8")).trim().split(/\r?\n/);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(markers).toEqual([
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
      "returned",
    ]);
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
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  return ([string]$candidate -like '*dist\\npm-package\\dist\\cli.js')
}
function Get-Content { return '{"buildId":"build-1"}' }
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  if ([int]$LocalPort -eq ${address.port}) { return [pscustomobject]@{ OwningProcess = ${process.pid} } }
  return @()
}
function Invoke-WebRequest { throw 'not healthy' }
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
$global:realGetContent = Get-Command Get-Content -CommandType Cmdlet
function Test-Path {
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\dist\\cli.js') { return $true }
  return & $global:realTestPath -LiteralPath $candidate
}
function Get-Content {
  param($Path, $LiteralPath, [switch]$Raw, $Encoding)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\build-info.json') { return '{"buildId":"build-1"}' }
  $arguments = @{ LiteralPath = $candidate }
  if ($Raw) { $arguments.Raw = $true }
  if ($Encoding) { $arguments.Encoding = $Encoding }
  return & $global:realGetContent @arguments
}
function netstat { }
function Get-NetTCPConnection { return @() }
function Start-Sleep { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = $global:taskState
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${watchdogScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
      WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
    })
    Settings = [pscustomobject]@{
      MultipleInstances = 'IgnoreNew'
      RestartCount = 999
      RestartInterval = 'PT1M'
      ExecutionTimeLimit = 'PT0S'
    }
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
    expect(result.stdout).toContain("PID 元数据");
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
        RepoRoot: repoRoot,
        BundlePath: path.join(repoRoot, "dist", "npm-package"),
        Processes: [{ Role: "server", Pid: 424242, StartTimeUtc: fixedStart }],
      }),
      "utf8",
    );
    const cliJs = path.join(repoRoot, "dist", "npm-package", "dist", "cli.js");
    const commonHarness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
$global:realGetContent = Get-Command Get-Content -CommandType Cmdlet
function Test-Path {
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  return ([string]$candidate -like '*dist\\npm-package\\dist\\cli.js') -or ([string]$candidate -like '*service-config.json') -or ([string]$candidate -like '*prod-process.json')
}
function Get-Content {
  param($Path, $LiteralPath, [switch]$Raw, $Encoding)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\build-info.json') { return '{"buildId":"build-1"}' }
  $arguments = @{ LiteralPath = $candidate }
  if ($Raw) { $arguments.Raw = $true }
  if ($Encoding) { $arguments.Encoding = $Encoding }
  return & $global:realGetContent @arguments
}
function netstat { Write-Output 'TCP 127.0.0.1:61990 0.0.0.0:0 LISTENING 424242' }
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  if ([int]$LocalPort -in @(61990, 61991)) { return [pscustomobject]@{ OwningProcess = 424242 } }
  return @()
}
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 424242) { return [pscustomobject]@{ Id = 424242; StartTime = $global:fixedStart; ProcessName = 'node' } }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  return [pscustomobject]@{ ProcessId = 424242; ParentProcessId = 0; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = '${cliJs.replaceAll("'", "''")} --port 61990' }
}
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Running'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${watchdogScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
      WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
    })
    Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
    Triggers = @()
  }
}
function Get-ScheduledTaskInfo { return [pscustomobject]@{ LastTaskResult = 0 } }
function Invoke-WebRequest { throw 'unhealthy' }
function taskkill.exe { Write-Output '__TASKKILL_FAILED__'; & cmd.exe /c exit 5 }
function Start-Sleep { }
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
    expect(start.stdout).toContain("verified-stale");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("verified-stale");
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
function Get-NetTCPConnection { return @() }
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
function Get-NetTCPConnection { return @() }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Running'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${watchdogScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
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
function Get-NetTCPConnection { return @() }
function Start-Sleep { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Running'
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${watchdogScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
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

  it("stop-prod 为严格 v2 一次迁移接受同 repo direct action 并清理已验证子进程", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-task-reparented-child-"),
    );
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const configPath = path.join(stateDir, "service-config.json");
    const stateFile = path.join(stateDir, "prod-process.json");
    const bundleDir = path.join(repoRoot, "dist", "npm-package");
    const cliJs = path.join(bundleDir, "dist", "cli.js");
    await writeFile(
      configPath,
      JSON.stringify({
        Version: 1,
        ServerPort: "8022",
        BasePath: "/",
        Profile: null,
        DataDir: null,
        AllowedImagePaths: null,
        CodexPort: "4510",
        ClaudePort: "4520",
      }),
      "utf8",
    );
    const fingerprint = await runPowerShellCommand(
      `. ${psLiteral(productionRuntimeScript)}
$expectation = New-YepProductionExpectation -RepoRoot ${psLiteral(repoRoot)} -BundlePath ${psLiteral(bundleDir)} -BuildId 'build-1' -BasePath '/' -Profile $null -DataDir $null -AllowedImagePaths "$env:TEMP,$env:USERPROFILE\\Downloads" -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath ${psLiteral(runProdScript)}
Write-Output $expectation.ConfigFingerprint`,
    );
    if (fingerprint.code !== 0)
      throw new Error(fingerprint.stderr || fingerprint.stdout);
    const supervisorCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript}" -ConfigPath "${configPath}"`;
    const serverCommand = `node.exe "${cliJs}" --port 8022`;
    await writeFile(
      stateFile,
      JSON.stringify({
        Version: 2,
        Mode: "prod",
        SupervisorInstanceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        Supervisor: {
          Role: "supervisor",
          Pid: 100,
          StartTimeUtc: fixedStart,
          ExecutablePath:
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          CommandLine: supervisorCommand,
        },
        BuildId: "build-1",
        ConfigFingerprint: fingerprint.stdout.trim(),
        RepoRoot: repoRoot,
        BundlePath: bundleDir,
        Profile: null,
        DataDir: null,
        BasePath: "",
        Ports: {
          Server: 8022,
          Maintenance: 8023,
          Codex: 4510,
          Claude: 4520,
        },
        Bridges: { Codex: "disabled", Claude: "disabled" },
        Processes: [
          {
            Role: "server",
            Pid: 101,
            StartTimeUtc: "2026-08-11T00:00:01Z",
            ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
            CommandLine: serverCommand,
          },
        ],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
$global:taskStopped = $false
$global:childKilled = $false
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
$global:realGetContent = Get-Command Get-Content -CommandType Cmdlet
function Test-Path {
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\dist\\cli.js') { return $true }
  return & $global:realTestPath -LiteralPath $candidate
}
function Get-Content {
  param($Path, $LiteralPath, [switch]$Raw, $Encoding)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\build-info.json') { return '{"buildId":"build-1"}' }
  $arguments = @{ LiteralPath = $candidate }
  if ($Raw) { $arguments.Raw = $true }
  if ($Encoding) { $arguments.Encoding = $Encoding }
  return & $global:realGetContent @arguments
}
function netstat { }
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  if (-not $global:childKilled -and [int]$LocalPort -in @(8022, 8023)) {
    return [pscustomobject]@{ OwningProcess = 101 }
  }
  return @()
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction)
  if ([string]$Uri -like '*/api/version') { return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"build-1"}}' } }
  return [pscustomobject]@{ StatusCode = 200; Content = '{}' }
}
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
function Stop-ScheduledTask {
  $global:taskStopped = $true
  Write-Host '__TASK_STOPPED__'
}
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 100 -and -not $global:taskStopped) { return [pscustomobject]@{ Id = 100; StartTime = $global:fixedStart; ProcessName = 'powershell' } }
  if ($Id -eq 101 -and -not $global:childKilled) { return [pscustomobject]@{ Id = 101; StartTime = $global:fixedStart.AddSeconds(1); ProcessName = 'node' } }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @()
  if (-not $global:childKilled) {
    $items += [pscustomobject]@{ ProcessId = 101; ParentProcessId = $(if ($global:taskStopped) { 0 } else { 100 }); ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = '${serverCommand.replaceAll("'", "''")}' }
  }
  if (-not $global:taskStopped) {
    $items = @([pscustomobject]@{ ProcessId = 100; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = '${supervisorCommand.replaceAll("'", "''")}' }) + $items
  }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { $_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function taskkill.exe {
  param($PidFlag, $TargetPid, $TreeFlag, $ForceFlag)
  if (Test-Path -LiteralPath ${psLiteral(stateFile)}) { Write-Output '__STATE_PRESENT_AT_KILL__' }
  Write-Output "__KILL__$TargetPid"
  if ([int]$TargetPid -eq 101) { $global:childKilled = $true }
  & cmd.exe /c exit 0
}
& ${psLiteral(yepScript)} stop-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
      YEP_START_BRIDGES: "true",
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("__TASK_STOPPED__");
    expect(result.stdout).toContain("__STATE_PRESENT_AT_KILL__");
    expect(result.stdout).toContain("__KILL__101");
    expect(result.stdout.indexOf("__TASK_STOPPED__")).toBeLessThan(
      result.stdout.indexOf("__KILL__101"),
    );
    expect(existsSync(stateFile)).toBe(false);
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
        Version: 1,
        Mode: "prod",
        RepoRoot: repoRoot,
        BundlePath: path.join(repoRoot, "dist", "npm-package"),
        Processes: [{ Pid: 100, Role: "supervisor", StartTimeUtc: fixedStart }],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
function netstat { }
function Get-NetTCPConnection { return @() }
function Get-ScheduledTask { return $null }
function Get-Process {
  return [pscustomobject]@{ Id = 100; StartTime = $global:fixedStart; ProcessName = 'powershell' }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if ($Filter) {
    return [pscustomobject]@{ ProcessId = 100; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = '${runProdScript.replaceAll("'", "''")} -ConfigPath test.json' }
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
    expect(result.stdout).toContain("无法完整枚举");
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
function Get-NetTCPConnection { return @() }
function Invoke-WebRequest { throw 'not running' }
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

  it("保留句柄终止失败且进程仍存活时 stop-prod 保留元数据并返回失败", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-stop-residual-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const stateFile = path.join(stateDir, "prod-process.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        Version: 1,
        Mode: "prod",
        RepoRoot: repoRoot,
        BundlePath: path.join(repoRoot, "dist", "npm-package"),
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
function Get-NetTCPConnection { return @() }
function Get-ScheduledTask { return $null }
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq 424242) {
    $process = [pscustomobject]@{ Id = 424242; StartTime = $global:fixedStart; ProcessName = 'powershell'; SafeHandle = [pscustomobject]@{ IsInvalid = $false; IsClosed = $false } }
    $process | Add-Member ScriptProperty Handle { return [IntPtr]424243 }
    $process | Add-Member ScriptProperty HasExited { return $false }
    $process | Add-Member ScriptMethod Kill { Write-Host '__HANDLE_KILL_FAILED__'; throw 'kill failed' }
    $process | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return $false }
    $process | Add-Member ScriptMethod Dispose { }
    return $process
  }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  return [pscustomobject]@{
    ProcessId = 424242
    ParentProcessId = 0
    CreationDate = $global:fixedStart
    ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    CommandLine = '${runProdScript.replaceAll("'", "''")} -ConfigPath test.json'
  }
}
function taskkill.exe { Write-Output '__UNEXPECTED_TASKKILL__'; & cmd.exe /c exit 5 }
function Start-Sleep { }
& ${psLiteral(yepScript)} stop-prod
`;

    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("__HANDLE_KILL_FAILED__");
    expect(result.stdout).not.toContain("__UNEXPECTED_TASKKILL__");
    expect(result.stdout).toContain("仍在运行");
    expect(existsSync(stateFile)).toBe(true);
  });

  it("保留句柄确认同一进程已退出时 stop-prod 成功", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-stop-vanished-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const vanishedPid = 2147483000;
    const stateFile = path.join(stateDir, "prod-process.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        Version: 1,
        Mode: "prod",
        RepoRoot: repoRoot,
        BundlePath: path.join(repoRoot, "dist", "npm-package"),
        Processes: [
          {
            Pid: vanishedPid,
            Role: "supervisor",
            StartTimeUtc: fixedStart,
          },
        ],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
$global:getProcessCalls = 0
function netstat { }
function Get-NetTCPConnection { return @() }
function Get-ScheduledTask { return $null }
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -eq ${vanishedPid}) {
    $global:getProcessCalls++
    if ($global:getProcessCalls -le 3) {
      $process = [pscustomobject]@{ Id = ${vanishedPid}; StartTime = $global:fixedStart; ProcessName = 'powershell'; SafeHandle = [pscustomobject]@{ IsInvalid = $false; IsClosed = $false } }
      $process | Add-Member ScriptProperty Handle { return [IntPtr]${vanishedPid} }
      $process | Add-Member ScriptProperty HasExited { return $true }
      $process | Add-Member ScriptMethod Kill { Write-Host '__UNEXPECTED_HANDLE_KILL__' }
      $process | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return $true }
      $process | Add-Member ScriptMethod Dispose { }
      return $process
    }
  }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  return [pscustomobject]@{
    ProcessId = ${vanishedPid}
    ParentProcessId = 0
    CreationDate = $global:fixedStart
    ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    CommandLine = '${runProdScript.replaceAll("'", "''")} -ConfigPath test.json'
  }
}
function Start-Sleep { }
& ${psLiteral(yepScript)} stop-prod
`;

    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).not.toContain("NativeCommandError");
    expect(result.stdout).toContain("生产模式已停止");
    expect(result.stdout).not.toContain("__UNEXPECTED_HANDLE_KILL__");
    expect(existsSync(stateFile)).toBe(false);
  });

  it("stop-prod 通过保留句柄逐一终止已核实的 legacy 进程", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-stop-tree-"));
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const stateFile = path.join(stateDir, "prod-process.json");
    const killLogPath = path.join(stateDir, "kill.log");
    await writeFile(
      stateFile,
      JSON.stringify({
        Version: 1,
        Mode: "prod",
        RepoRoot: repoRoot,
        BundlePath: path.join(repoRoot, "dist", "npm-package"),
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
$global:alive = @{ 100 = $true; 101 = $true; 102 = $true }
function netstat { }
function Get-NetTCPConnection { return @() }
function Get-ScheduledTask { return $null }
function Get-Process {
  param($Id, $ErrorAction)
  if (-not $global:alive[[int]$Id]) { return $null }
  $process = [pscustomobject]@{ Id = [int]$Id; StartTime = $global:fixedStart; ProcessName = 'node'; SafeHandle = [pscustomobject]@{ IsInvalid = $false; IsClosed = $false } }
  $process | Add-Member ScriptProperty Handle { return [IntPtr]([int]$this.Id + 1) }
  $process | Add-Member ScriptProperty HasExited { return -not [bool]$global:alive[[int]$this.Id] }
  $process | Add-Member ScriptMethod Kill {
    [IO.File]::AppendAllText($env:YEP_TEST_KILL_LOG, "__KILL__$($this.Id);")
    $global:alive[[int]$this.Id] = $false
  }
  $process | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return [bool]$this.HasExited }
  $process | Add-Member ScriptMethod Dispose { }
  return $process
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @(
    [pscustomobject]@{ ProcessId = 100; ParentProcessId = 0; CreationDate = $global:fixedStart; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = '${runProdScript.replaceAll("'", "''")} -ConfigPath test.json' },
    [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100; CreationDate = $global:fixedStart; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = '${cliJs.replaceAll("'", "''")} --port 8022' },
    [pscustomobject]@{ ProcessId = 102; ParentProcessId = 100; CreationDate = $global:fixedStart; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = '${cliJs.replaceAll("'", "''")} --codex-bridge-only' }
  ) | Where-Object { $global:alive[[int]$_.ProcessId] }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { $_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function taskkill.exe { [IO.File]::AppendAllText($env:YEP_TEST_KILL_LOG, '__UNEXPECTED_TASKKILL__;') }
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
    expect(killLog).toContain("__KILL__101");
    expect(killLog).toContain("__KILL__102");
    expect(killLog).not.toContain("__UNEXPECTED_TASKKILL__");
    expect(existsSync(stateFile)).toBe(false);
  });

  it("stop-prod 用停止前快照清理根进程退出后重挂父进程的残留子进程", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "yep-reparented-child-"),
    );
    tempDirs.push(stateDir);
    const fixedStart = "2026-08-11T00:00:00Z";
    const stateFile = path.join(stateDir, "prod-process.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        Version: 1,
        Mode: "prod",
        RepoRoot: repoRoot,
        BundlePath: path.join(repoRoot, "dist", "npm-package"),
        Processes: [{ Pid: 100, Role: "supervisor", StartTimeUtc: fixedStart }],
      }),
      "utf8",
    );
    const harness = `
$global:fixedStart = [DateTime]::Parse('${fixedStart}')
$global:rootKilled = $false
$global:childKilled = $false
function netstat { }
function Get-NetTCPConnection { return @() }
function Get-ScheduledTask { return $null }
function Get-Process {
  param($Id, $ErrorAction)
  if (($Id -eq 100 -and $global:rootKilled) -or ($Id -eq 101 -and $global:childKilled)) { return $null }
  if ($Id -notin @(100, 101)) { return $null }
  $process = [pscustomobject]@{ Id = [int]$Id; StartTime = $global:fixedStart.AddSeconds([int]$Id - 100); ProcessName = 'node'; SafeHandle = [pscustomobject]@{ IsInvalid = $false; IsClosed = $false } }
  $process | Add-Member ScriptProperty Handle { return [IntPtr]([int]$this.Id + 1) }
  $process | Add-Member ScriptProperty HasExited {
    if ([int]$this.Id -eq 100) { return [bool]$global:rootKilled }
    return [bool]$global:childKilled
  }
  $process | Add-Member ScriptMethod Kill {
    if ([int]$this.Id -eq 100) { $global:rootKilled = $true }
    if ([int]$this.Id -eq 101) { $global:childKilled = $true }
    Write-Host "__KILL__$($this.Id)"
  }
  $process | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return [bool]$this.HasExited }
  $process | Add-Member ScriptMethod Dispose { }
  return $process
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @()
  if (-not $global:childKilled) {
    $items += [pscustomobject]@{ ProcessId = 101; ParentProcessId = $(if ($global:rootKilled) { 0 } else { 100 }); CreationDate = $global:fixedStart.AddSeconds(1); CommandLine = 'node child-worker.js' }
  }
  if (-not $global:rootKilled) {
    $items = @([pscustomobject]@{ ProcessId = 100; ParentProcessId = 0; CreationDate = $global:fixedStart; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = '${runProdScript.replaceAll("'", "''")} -ConfigPath test.json' }) + $items
  }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { $_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function taskkill.exe { Write-Output '__UNEXPECTED_TASKKILL__' }
function Start-Sleep { }
& ${psLiteral(yepScript)} stop-prod
`;
    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: path.join(stateDir, "service-config.json"),
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("__KILL__101");
    expect(result.stdout).not.toContain("__UNEXPECTED_TASKKILL__");
    expect(existsSync(stateFile)).toBe(false);
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
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  return ([string]$candidate -like '*dist\\npm-package\\dist\\cli.js')
}
function Get-Content { return '{"buildId":"build-1"}' }
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'powershell.exe' } }
function netstat { }
function Get-NetTCPConnection { return @() }
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
    expect(definition.RestartInterval).toEqual({
      Minutes: 1,
      Hours: 0,
      Seconds: 0,
    });
    expect(definition.MultipleInstances).toBe("IgnoreNew");
    expect(definition.ExecutionTimeLimit).toEqual({
      Minutes: 0,
      Hours: 0,
      Seconds: 0,
    });
    expect(definition.ActionArgument).toContain("watch-yepanywhere.ps1");
    expect(definition.ActionArgument).toContain("-WindowStyle Hidden");
  });

  it("自启动任务只增加登录触发器而不启动当前实例", async () => {
    const definition = await captureTaskDefinition(["--enable-autostart"]);

    expect(definition.TriggerCreated).toBe(true);
    expect(definition.TriggerUser).toBe(definition.PrincipalUserId);
    expect(definition.RegisteredTriggerCount).toBe(1);
    expect(definition.TriggerClass).toBe("MSFT_TaskLogonTrigger");
    expect(definition.TriggerRepetitionInterval).toBeNull();
    expect(definition.TriggerRepetitionDuration).toBe("");
    expect(definition.Started).toBe(false);
    expect(definition.RestartCount).toBe(999);
    expect(definition.MultipleInstances).toBe("IgnoreNew");
    expect(definition.ActionArgument).toContain(watchdogScript);
    expect(definition.ActionArgument).not.toContain(runProdScript);
  });

  it("用真实 Windows provider 构造不会在 stop 后复活的登录触发器", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-real-trigger-"));
    tempDirs.push(stateDir);
    const configPath = path.join(stateDir, "service-config.json");
    const marker = "__REAL_TRIGGER__";
    const harness = `
Import-Module ScheduledTasks -Force -ErrorAction Stop
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
$global:registeredTrigger = $null
$global:mockRegisterCalled = $false
function Test-Path {
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\dist\\cli.js') { return $true }
  return & $global:realTestPath -LiteralPath $candidate
}
function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
  if ([string]$TaskName -ne 'YepAnywhereServer') { throw '__UNEXPECTED_TASK_NAME__' }
  $global:mockRegisterCalled = $true
  $global:registeredTrigger = @($Trigger) | Select-Object -First 1
}
$registerCommand = Get-Command Register-ScheduledTask -ErrorAction Stop
if ([string]$registerCommand.ModuleName -eq 'ScheduledTasks') { throw '__UNSAFE_REAL_REGISTER__' }
& ${psLiteral(installTaskScript)} --enable-autostart
if (-not $global:mockRegisterCalled) { throw '__MOCK_REGISTER_NOT_CALLED__' }
$record = [ordered]@{
  Class = [string]$global:registeredTrigger.CimClass.CimClassName
  Interval = [string]$global:registeredTrigger.Repetition.Interval
  Duration = [string]$global:registeredTrigger.Repetition.Duration
}
Write-Output ('${marker}' + ($record | ConvertTo-Json -Compress))
`;

    const result = await runPowerShellCommand(harness, {
      YEP_SERVICE_CONFIG_PATH: configPath,
    });
    const markerLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(marker));
    const definition = JSON.parse(markerLine?.slice(marker.length) ?? "{}") as {
      Class?: string;
      Interval?: string;
      Duration?: string;
    };

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(definition).toEqual({
      Class: "MSFT_TaskLogonTrigger",
      Interval: "",
      Duration: "",
    });
  });

  it("watchdog 在 inner supervisor 退出后重启并保留接管入口", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-watchdog-"));
    tempDirs.push(stateDir);
    const isolatedWatchdog = path.join(stateDir, "watch-yepanywhere.ps1");
    const isolatedSupervisor = path.join(stateDir, "run-yepanywhere.ps1");
    const configPath = path.join(stateDir, "service-config.json");
    const launchLog = path.join(stateDir, "launches.log");
    const adoptionMarker = path.join(stateDir, "managed-child.marker");
    await copyFile(watchdogScript, isolatedWatchdog);
    await writeFile(configPath, "{}", "utf8");
    await writeFile(
      isolatedSupervisor,
      `param([string]$ConfigPath)
$mode = if (Test-Path -LiteralPath $env:YEP_TEST_ADOPTION_MARKER) { 'adopt' } else {
  [IO.File]::WriteAllText($env:YEP_TEST_ADOPTION_MARKER, 'managed-child-survived')
  'start'
}
[IO.File]::AppendAllText($env:YEP_TEST_WATCHDOG_LOG, (([string]$PID) + '|' + $ConfigPath + '|' + $mode + [Environment]::NewLine))
Start-Sleep -Seconds 300
`,
      "utf8",
    );
    const marker = "__WATCHDOG_RESULT__";
    const harness = `
$watchdog = $null
$ownedInnerPids = New-Object 'System.Collections.Generic.HashSet[int]'
try {
  $watchdog = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '"${isolatedWatchdog.replaceAll("'", "''")}"',
    '-ConfigPath', '"${configPath.replaceAll("'", "''")}"'
  ) -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ((-not (Test-Path -LiteralPath $env:YEP_TEST_WATCHDOG_LOG)) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $env:YEP_TEST_WATCHDOG_LOG)) { throw 'first inner launch missing' }
  Start-Sleep -Seconds 2
  $beforeKill = @(Get-Content -LiteralPath $env:YEP_TEST_WATCHDOG_LOG)
  $firstPid = [int](([string]$beforeKill[0] -split '\\|')[0])
  [void]$ownedInnerPids.Add($firstPid)
  $firstInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $firstPid" -ErrorAction Stop
  if ([string]$firstInfo.CommandLine -notlike '*${isolatedSupervisor.replaceAll("'", "''")}*') {
    throw 'refusing to terminate unbound inner process'
  }
  $first = Get-Process -Id $firstPid -ErrorAction Stop
  [void]$first.Handle
  $first.Kill()
  if (-not $first.WaitForExit(10000)) { throw 'first inner did not exit' }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 100
    $afterRestart = @(Get-Content -LiteralPath $env:YEP_TEST_WATCHDOG_LOG)
  } while ($afterRestart.Count -lt 2 -and [DateTime]::UtcNow -lt $deadline)
  if ($afterRestart.Count -lt 2) { throw 'watchdog did not restart inner' }
  $secondPid = [int](([string]$afterRestart[1] -split '\\|')[0])
  [void]$ownedInnerPids.Add($secondPid)
  $record = [ordered]@{
    BeforeKill = $beforeKill.Count
    AfterRestart = $afterRestart.Count
    FirstPid = $firstPid
    SecondPid = $secondPid
    WatchdogAlive = -not $watchdog.HasExited
    Modes = @($afterRestart | ForEach-Object { ([string]$_ -split '\\|')[2] })
    Configs = @($afterRestart | ForEach-Object { ([string]$_ -split '\\|')[1] })
  }
  Write-Output ('${marker}' + ($record | ConvertTo-Json -Compress -Depth 4))
} finally {
  if ($watchdog -and -not $watchdog.HasExited) {
    [void]$watchdog.Handle
    $watchdog.Kill()
    [void]$watchdog.WaitForExit(10000)
  }
  foreach ($ownedPid in @($ownedInnerPids)) {
    $ownedInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownedPid" -ErrorAction SilentlyContinue
    if ($ownedInfo -and [string]$ownedInfo.CommandLine -like '*${isolatedSupervisor.replaceAll("'", "''")}*') {
      $owned = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
      if ($owned) {
        [void]$owned.Handle
        $owned.Kill()
        [void]$owned.WaitForExit(10000)
        $owned.Dispose()
      }
    }
  }
}
`;

    const result = await runPowerShellCommand(harness, {
      YEP_TEST_WATCHDOG_LOG: launchLog,
      YEP_TEST_ADOPTION_MARKER: adoptionMarker,
    });
    const markerLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(marker));
    const record = JSON.parse(markerLine?.slice(marker.length) ?? "{}") as {
      BeforeKill?: number;
      AfterRestart?: number;
      FirstPid?: number;
      SecondPid?: number;
      WatchdogAlive?: boolean;
      Modes?: string[];
      Configs?: string[];
    };

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(record.BeforeKill).toBe(1);
    expect(record.AfterRestart).toBe(2);
    expect(record.FirstPid).not.toBe(record.SecondPid);
    expect(record.WatchdogAlive).toBe(true);
    expect(record.Modes).toEqual(["start", "adopt"]);
    expect(record.Configs).toEqual([configPath, configPath]);
  }, 45_000);

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
$global:realGetContent = Get-Command Get-Content -CommandType Cmdlet
function Test-Path {
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\dist\\cli.js') { return $true }
  return & $global:realTestPath -LiteralPath $candidate
}
function Get-Content {
  param($Path, $LiteralPath, [switch]$Raw, $Encoding)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\build-info.json') { return '{"buildId":"build-1"}' }
  $arguments = @{ LiteralPath = $candidate }
  if ($Raw) { $arguments.Raw = $true }
  if ($Encoding) { $arguments.Encoding = $Encoding }
  return & $global:realGetContent @arguments
}
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'powershell.exe' } }
function netstat { }
function Get-NetTCPConnection { return @() }
function Invoke-WebRequest { throw 'not running' }
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
function Get-NetTCPConnection { return @() }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = 'Ready'
    Principal = [pscustomobject]@{ UserId = $env:USERNAME }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${watchdogScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
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

  it("近似任务动作、错误工作目录、Parallel 或周期触发器会被判异常且拒绝停止", async () => {
    const variants = [
      "fake-exe",
      "backup-script",
      "wrong-cwd",
      "parallel",
      "direct-supervisor",
      "repeating-trigger",
    ];
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
  Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${watchdogScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
  WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
}
$settings = [pscustomobject]@{
  MultipleInstances = 'IgnoreNew'
  RestartCount = 999
  RestartInterval = 'PT1M'
  ExecutionTimeLimit = 'PT0S'
}
$triggers = @()
switch ($env:YEP_TEST_TASK_VARIANT) {
  'fake-exe' { $action.Execute = 'C:\\fake\\notpowershell-helper.exe' }
  'backup-script' { $action.Arguments = $action.Arguments.Replace('watch-yepanywhere.ps1', 'watch-yepanywhere.ps1.bak') }
  'wrong-cwd' { $action.WorkingDirectory = 'C:\\unrelated' }
  'parallel' { $settings.MultipleInstances = 'Parallel' }
  'direct-supervisor' { $action.Arguments = $action.Arguments.Replace('watch-yepanywhere.ps1', 'run-yepanywhere.ps1') }
  'repeating-trigger' {
    $triggers = @([pscustomobject]@{
      Enabled = $true
      UserId = "$env:USERDOMAIN\\$env:USERNAME"
      Repetition = [pscustomobject]@{ Interval = 'PT1M'; Duration = ''; StopAtDurationEnd = $false }
      CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
    })
  }
}
function netstat { }
function Get-NetTCPConnection { return @() }
function Invoke-WebRequest { throw 'not running' }
function Start-Sleep { }
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = $global:taskState
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @($action)
    Settings = $settings
    Triggers = @($triggers)
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
  }, 30_000);

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
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
$global:realGetContent = Get-Command Get-Content -CommandType Cmdlet
function Test-Path {
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package*') { return $true }
  return & $global:realTestPath -LiteralPath $candidate
}
function Get-Content {
  param($Path, $LiteralPath, [switch]$Raw, $Encoding)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -like '*dist\\npm-package\\build-info.json') { return '{"buildId":"build-1"}' }
  $arguments = @{ LiteralPath = $candidate }
  if ($Raw) { $arguments.Raw = $true }
  if ($Encoding) { $arguments.Encoding = $Encoding }
  return & $global:realGetContent @arguments
}
function Get-Command { param($Name) return [pscustomobject]@{ Source = 'C:\\Program Files\\nodejs\\node.exe' } }
function Get-TestRole([int]$ProcessId) {
  switch ($ProcessId) { 100 { 'server' } 101 { 'failed-bridge' } 102 { 'remaining-bridge' } default { 'supervisor' } }
}
function Get-TestCommand([int]$ProcessId) {
  switch ($ProcessId) {
    100 { return 'node.exe "${path.join(repoRoot, "dist", "npm-package", "dist", "cli.js").replaceAll("'", "''")}" --port 8022' }
    101 { return 'node.exe "${path.join(repoRoot, "dist", "npm-package", "dist", "cli.js").replaceAll("'", "''")}" --codex-bridge-only' }
    102 { return 'node.exe "${path.join(repoRoot, "dist", "npm-package", "dist", "cli.js").replaceAll("'", "''")}" --claude-bridge-only' }
    default { return 'powershell.exe -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"' }
  }
}
function Get-Process {
  param($Id, $ErrorAction)
  if ([int]$Id -eq $PID) { return [pscustomobject]@{ Id = $PID; StartTime = $global:fixedStart; HasExited = $false } }
  return @($global:started | Where-Object { [int]$_.Id -eq [int]$Id -and -not $_.HasExited }) | Select-Object -First 1
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @([pscustomobject]@{ ProcessId = $PID; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = Get-TestCommand $PID })
  foreach ($process in @($global:started | Where-Object { -not $_.HasExited })) {
    $items += [pscustomobject]@{ ProcessId = [int]$process.Id; ParentProcessId = $PID; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = Get-TestCommand ([int]$process.Id) }
  }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return @($items)
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  $owner = switch ([int]$LocalPort) {
    8022 { 100 }
    8023 { 100 }
    4510 { 101 }
    4520 { 102 }
    default { 0 }
  }
  $process = @($global:started | Where-Object { [int]$_.Id -eq $owner -and -not $_.HasExited }) | Select-Object -First 1
  if (-not $process) { return @() }
  return [pscustomobject]@{ OwningProcess = $owner }
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction)
  if ([string]$Uri -like '*/api/version') { return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"build-1"}}' } }
  return [pscustomobject]@{ StatusCode = 200; Content = '{}' }
}
function node { & cmd.exe /c exit 0 }
function npm { throw '监督器不应安装运行依赖' }
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
  $process = [pscustomobject]@{ Id = 100 + $global:started.Count; StartTime = $global:fixedStart.AddSeconds(1 + $global:started.Count); HasExited = $false }
  $global:started += $process
  return $process
}
function Start-Sleep { if ($global:started.Count -gt 1) { $global:started[1].HasExited = $true } }
function Stop-Process { Write-Output '__UNEXPECTED_STOP_PROCESS__' }
function taskkill.exe {
  param($PidFlag, $TargetPid, $TreeFlag, $ForceFlag)
  $process = @($global:started | Where-Object { [int]$_.Id -eq [int]$TargetPid }) | Select-Object -First 1
  if ($process) { $process.HasExited = $true }
  Write-Output "__STOPPED__$(Get-TestRole ([int]$TargetPid))"
  & cmd.exe /c exit 0
}
& ${psLiteral(runProdScript)} -ConfigPath ${psLiteral(configPath)}
`;

    const result = await runPowerShellCommand(harness, {
      YEP_LAUNCHD_LOG_DIR: stateDir,
      YEP_SERVICE_CONFIG_PATH: configPath,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("关键进程");
    expect(result.stdout).toContain("__STOPPED__server");
    expect(result.stdout).toContain("__STOPPED__remaining-bridge");
    expect(result.stdout).not.toContain("__UNEXPECTED_STOP_PROCESS__");
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

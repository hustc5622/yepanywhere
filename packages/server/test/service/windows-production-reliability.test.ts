import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const runtimeScript = path.join(repoRoot, "scripts", "production-runtime.ps1");
const yepScript = path.join(repoRoot, "scripts", "yep.ps1");
const runProdScript = path.join(repoRoot, "scripts", "run-yepanywhere.ps1");
const watchdogScript = path.join(repoRoot, "scripts", "watch-yepanywhere.ps1");
const serverIndex = path.join(
  repoRoot,
  "packages",
  "server",
  "src",
  "index.ts",
);
const bundleDir = path.join(repoRoot, "dist", "npm-package");
const cliJs = path.join(bundleDir, "dist", "cli.js");
const tempDirs: string[] = [];

function psLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(
  command: string,
  environment: Record<string, string> = {},
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
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
      child.once("close", (code) =>
        resolve({ code: code ?? 1, stdout, stderr }),
      );
    },
  );
}

function validManifest() {
  return {
    Version: 2,
    Mode: "prod",
    SupervisorInstanceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    Supervisor: {
      Role: "supervisor",
      Pid: 1200,
      StartTimeUtc: "2026-08-17T08:00:00Z",
      ExecutablePath: "C:\\Windows\\powershell.exe",
      CommandLine:
        'powershell.exe -File "C:\\repo\\scripts\\run-yepanywhere.ps1" -ConfigPath "C:\\state\\service-config.json"',
    },
    BuildId: "build-1",
    ConfigFingerprint:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    RepoRoot: "C:\\repo",
    BundlePath: "C:\\repo\\dist\\npm-package",
    Profile: "default",
    DataDir: null,
    BasePath: "",
    Ports: { Server: 8022, Maintenance: 8023, Codex: 4510, Claude: 4520 },
    Bridges: { Codex: "managed", Claude: "external" },
    Processes: [
      {
        Role: "server",
        Pid: 1201,
        StartTimeUtc: "2026-08-17T08:00:01Z",
        ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
        CommandLine:
          'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js" --port 8022',
      },
      {
        Role: "codex-bridge",
        Pid: 1202,
        StartTimeUtc: "2026-08-17T08:00:02Z",
        ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
        CommandLine:
          'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js" --codex-bridge-only',
      },
    ],
  };
}

async function createCliFixture(
  scenario:
    | "healthy"
    | "degraded-adoptable"
    | "verified-stale"
    | "unknown-conflict"
    | "stopped",
) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "yep-cli-state-"));
  tempDirs.push(stateDir);
  const configPath = path.join(stateDir, "service-config.json");
  const manifestPath = path.join(stateDir, "prod-process.json");
  await writeFile(
    configPath,
    JSON.stringify({
      Version: 1,
      ServerPort: "8022",
      BasePath: "/",
      Profile: "default",
      DataDir: null,
      AllowedImagePaths: "C:\\images",
      CodexPort: "4510",
      ClaudePort: "4520",
    }),
    "utf8",
  );
  const fingerprintResult = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$expectation = New-YepProductionExpectation -RepoRoot ${psLiteral(repoRoot)} -BundlePath ${psLiteral(bundleDir)} -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths 'C:\\images' -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath ${psLiteral(runProdScript)}
Write-Output $expectation.ConfigFingerprint
`);
  if (fingerprintResult.code !== 0) {
    throw new Error(fingerprintResult.stderr || fingerprintResult.stdout);
  }
  const processEntries = [
    {
      Role: "server",
      Pid: 1201,
      StartTimeUtc: "2026-08-17T08:00:01Z",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: `node.exe "${cliJs}" --port 8022`,
    },
    {
      Role: "codex-bridge",
      Pid: 1202,
      StartTimeUtc: "2026-08-17T08:00:02Z",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: `node.exe "${cliJs}" --codex-bridge-only`,
    },
    {
      Role: "claude-bridge",
      Pid: 1203,
      StartTimeUtc: "2026-08-17T08:00:03Z",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: `node.exe "${cliJs}" --claude-bridge-only`,
    },
  ];
  const manifest = {
    Version: 2,
    Mode: "prod",
    SupervisorInstanceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    Supervisor: {
      Role: "supervisor",
      Pid: 1200,
      StartTimeUtc: "2026-08-17T08:00:00Z",
      ExecutablePath:
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      CommandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript}" -ConfigPath "${configPath}"`,
    },
    BuildId: scenario === "verified-stale" ? "old-build" : "build-1",
    ConfigFingerprint: fingerprintResult.stdout.trim(),
    RepoRoot: repoRoot,
    BundlePath: bundleDir,
    Profile: "default",
    DataDir: null,
    BasePath: "",
    Ports: { Server: 8022, Maintenance: 8023, Codex: 4510, Claude: 4520 },
    Bridges: { Codex: "managed", Claude: "managed" },
    Processes: processEntries,
  };
  if (scenario !== "stopped") {
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  }
  return { stateDir, configPath, manifestPath, manifest };
}

function cliProviderHarness(scenario: string, configPath: string) {
  const taskState = scenario === "healthy" ? "Running" : "Ready";
  const lastTaskResult = scenario === "degraded-adoptable" ? "0xC000013A" : "0";
  return `
$global:scenario = '${scenario}'
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
$global:realGetContent = Get-Command Get-Content -CommandType Cmdlet
function Test-Path {
  param($Path, $LiteralPath)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  if ([string]$candidate -eq ${psLiteral(cliJs)}) { return $true }
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
function Get-Process {
  param($Id, $ErrorAction)
  if ($global:scenario -eq 'stopped') { return $null }
  if ($global:scenario -eq 'degraded-adoptable' -and [int]$Id -eq 1200) { return $null }
  if ([int]$Id -eq 9999) { return [pscustomobject]@{ Id = 9999; StartTime = $global:fixedStart; ProcessName = 'other' } }
  if ([int]$Id -notin @(1200, 1201, 1202, 1203)) { return $null }
  return [pscustomobject]@{ Id = [int]$Id; StartTime = $global:fixedStart.AddSeconds([int]$Id - 1200); ProcessName = 'test' }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @(
    [pscustomobject]@{ ProcessId = 1200; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"' },
    [pscustomobject]@{ ProcessId = 1201; ParentProcessId = 1200; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "${cliJs.replaceAll("'", "''")}" --port 8022' },
    [pscustomobject]@{ ProcessId = 1202; ParentProcessId = 1200; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "${cliJs.replaceAll("'", "''")}" --codex-bridge-only' },
    [pscustomobject]@{ ProcessId = 1203; ParentProcessId = 1200; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "${cliJs.replaceAll("'", "''")}" --claude-bridge-only' }
  )
  if ($global:scenario -eq 'stopped') { return @() }
  if ($global:scenario -eq 'degraded-adoptable') { $items = @($items | Where-Object { $_.ProcessId -ne 1200 }) }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  if ($global:scenario -eq 'stopped') { return @() }
  $owner = switch ([int]$LocalPort) { 8022 { $(if ($global:scenario -eq 'unknown-conflict') { 9999 } else { 1201 }) } 8023 { 1201 } 4510 { 1202 } 4520 { 1203 } default { 0 } }
  if ($owner -eq 0) { return @() }
  return [pscustomobject]@{ OwningProcess = $owner }
}
function netstat {
  if ($global:scenario -eq 'stopped') { return }
  $owner = if ($global:scenario -eq 'unknown-conflict') { 9999 } else { 1201 }
  Write-Output "TCP 127.0.0.1:8022 0.0.0.0:0 LISTENING $owner"
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction)
  if ([string]$Uri -like '*/api/version') { return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"build-1"}}' } }
  return [pscustomobject]@{ StatusCode = 200; Content = '{}' }
}
function Get-ScheduledTask {
  return [pscustomobject]@{
    State = '${taskState}'
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
function Get-ScheduledTaskInfo { return [pscustomobject]@{ LastTaskResult = '${lastTaskResult}' } }
function Stop-ScheduledTask { Write-Output '__UNEXPECTED_TASK_STOP__' }
function Start-ScheduledTask { Write-Output '__UNEXPECTED_TASK_START__' }
function taskkill.exe { Write-Output '__UNEXPECTED_KILL__'; & cmd.exe /c exit 0 }
`;
}

async function createTransitionFixture(
  scenario:
    | "healthy"
    | "degraded-adoptable"
    | "verified-stale"
    | "unknown-conflict"
    | "stopped",
) {
  const fixture = await createCliFixture(scenario);
  const isolatedScriptsDir = path.join(fixture.stateDir, "scripts");
  const installMarkerPath = path.join(fixture.stateDir, "task-installer.txt");
  const installTaskScript = path.join(
    isolatedScriptsDir,
    "install-task-scheduler.ps1",
  );
  await mkdir(isolatedScriptsDir);
  await writeFile(
    installTaskScript,
    `param([string]$Mode)
[IO.File]::WriteAllText($env:YEP_TEST_TASK_INSTALL_MARKER, [Environment]::CommandLine)
exit 0
`,
    "utf8",
  );
  const healthyManifestPath = path.join(
    fixture.stateDir,
    "healthy-after-start.json",
  );
  await writeFile(
    healthyManifestPath,
    JSON.stringify({ ...fixture.manifest, BuildId: "build-1" }),
    "utf8",
  );
  if (scenario === "verified-stale") {
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({
        Version: 1,
        Mode: "prod",
        RepoRoot: repoRoot,
        BundlePath: bundleDir,
        Processes: [
          {
            Role: "supervisor",
            Pid: 1200,
            StartTimeUtc: "2026-08-17T08:00:00Z",
          },
          {
            Role: "server",
            Pid: 1201,
            StartTimeUtc: "2026-08-17T08:00:01Z",
          },
        ],
      }),
      "utf8",
    );
  }
  return {
    ...fixture,
    healthyManifestPath,
    installTaskScript,
    installMarkerPath,
  };
}

function transitionProviderHarness(
  scenario: string,
  configPath: string,
  manifestPath: string,
  healthyManifestPath: string,
) {
  return `${cliProviderHarness(scenario, configPath)}
$global:taskState = $(if ($global:scenario -eq 'healthy') { 'Running' } else { 'Ready' })
$global:taskStartCalled = $false
$global:taskStopCalled = $false
$global:kills = @()
$global:pidTaskkills = @()
$global:alive = @{
  1200 = ($global:scenario -in @('healthy', 'verified-stale', 'unknown-conflict'))
  1201 = ($global:scenario -ne 'stopped')
  1202 = ($global:scenario -in @('healthy', 'degraded-adoptable', 'unknown-conflict'))
  1203 = ($global:scenario -in @('healthy', 'degraded-adoptable', 'unknown-conflict'))
}
function Get-Process {
  param($Id, $ErrorAction)
  $processId = [int]$Id
  if ($processId -eq 9999) { return [pscustomobject]@{ Id = 9999; StartTime = $global:fixedStart; ProcessName = 'other' } }
  if (-not $global:alive[$processId]) { return $null }
  $process = [pscustomobject]@{
    Id = $processId
    StartTime = $global:fixedStart.AddSeconds($processId - 1200)
    ProcessName = 'test'
    SafeHandle = [pscustomobject]@{ IsInvalid = $false; IsClosed = $false }
  }
  $process | Add-Member -MemberType ScriptProperty -Name Handle -Value { return [IntPtr]([int]$this.Id + 1) }
  $process | Add-Member -MemberType ScriptProperty -Name HasExited -Value { return -not [bool]$global:alive[[int]$this.Id] }
  $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
    $global:kills += [int]$this.Id
    $global:alive[[int]$this.Id] = $false
  }
  $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Milliseconds) return [bool]$this.HasExited }
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
  return $process
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $serverParent = if ($global:scenario -eq 'verified-stale') { 0 } else { 1200 }
  $items = @(
    [pscustomobject]@{ ProcessId = 1200; ParentProcessId = 0; CreationDate = $global:fixedStart; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"' },
    [pscustomobject]@{ ProcessId = 1201; ParentProcessId = $serverParent; CreationDate = $global:fixedStart.AddSeconds(1); ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "${cliJs.replaceAll("'", "''")}" --port 8022' },
    [pscustomobject]@{ ProcessId = 1202; ParentProcessId = 1200; CreationDate = $global:fixedStart.AddSeconds(2); ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "${cliJs.replaceAll("'", "''")}" --codex-bridge-only' },
    [pscustomobject]@{ ProcessId = 1203; ParentProcessId = 1200; CreationDate = $global:fixedStart.AddSeconds(3); ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "${cliJs.replaceAll("'", "''")}" --claude-bridge-only' }
  ) | Where-Object { $global:alive[[int]$_.ProcessId] }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return @($items)
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  $owner = switch ([int]$LocalPort) {
    8022 { if ($global:scenario -eq 'unknown-conflict') { 9999 } elseif ($global:alive[1201]) { 1201 } else { 0 } }
    8023 { if ($global:alive[1201]) { 1201 } else { 0 } }
    4510 { if ($global:alive[1202]) { 1202 } else { 0 } }
    4520 { if ($global:alive[1203]) { 1203 } else { 0 } }
    default { 0 }
  }
  if ($owner -eq 0) { return @() }
  return [pscustomobject]@{ OwningProcess = $owner }
}
function netstat {
  if (-not $global:alive[1201] -and $global:scenario -ne 'unknown-conflict') { return }
  $owner = if ($global:scenario -eq 'unknown-conflict') { 9999 } else { 1201 }
  Write-Output "TCP 127.0.0.1:8022 0.0.0.0:0 LISTENING $owner"
}
function Get-ScheduledTask {
  $actionScript = if ($global:scenario -eq 'verified-stale') {
    '${runProdScript.replaceAll("'", "''")}'
  } else {
    '${watchdogScript.replaceAll("'", "''")}'
  }
  return [pscustomobject]@{
    State = $global:taskState
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -ConfigPath "{1}"' -f $actionScript, '${configPath.replaceAll("'", "''")}')
      WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
    })
    Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
    Triggers = @()
  }
}
function Start-ScheduledTask {
  param($TaskName)
  $global:taskStartCalled = $true
  $global:taskState = 'Running'
  $global:scenario = 'healthy'
  foreach ($processId in @(1200, 1201, 1202, 1203)) { $global:alive[$processId] = $true }
  Copy-Item -LiteralPath ${psLiteral(healthyManifestPath)} -Destination ${psLiteral(manifestPath)} -Force
}
function Stop-ScheduledTask {
  param($TaskName, $ErrorAction)
  $global:taskStopCalled = $true
  $global:taskState = 'Ready'
  $global:alive[1200] = $false
}
function taskkill.exe {
  param($PidFlag, $TargetPid, $TreeFlag, $ForceFlag)
  $processId = [int]$TargetPid
  $global:pidTaskkills += $processId
  $global:kills += $processId
  $global:alive[$processId] = $false
  & cmd.exe /c exit 0
}
function Start-Sleep { }
`;
}

async function runTransition(
  scenario: Parameters<typeof createTransitionFixture>[0],
  command: "start-prod" | "stop-prod",
) {
  const fixture = await createTransitionFixture(scenario);
  const functionName =
    command === "start-prod" ? "Cmd-StartProd" : "Cmd-StopProd";
  return runPowerShell(
    `${transitionProviderHarness(
      scenario,
      fixture.configPath,
      fixture.manifestPath,
      fixture.healthyManifestPath,
    )}
. ${psLiteral(yepScript)} help
$InstallTaskScript = ${psLiteral(fixture.installTaskScript)}
$before = Get-Process -Id 1201 -ErrorAction SilentlyContinue
$success = ${functionName}
$after = Get-Process -Id 1201 -ErrorAction SilentlyContinue
Write-Output "__SERVER_BEFORE__$($before.Id)"
Write-Output "__SERVER_AFTER__$($after.Id)"
if ($global:taskStartCalled) { Write-Output '__TASK_STARTED__' }
if ($global:taskStopCalled) { Write-Output '__TASK_STOPPED__' }
foreach ($processId in $global:kills) { Write-Output "__KILL__$processId" }
foreach ($processId in $global:pidTaskkills) { Write-Output "__PID_KILL__$processId" }
if ([IO.File]::Exists($env:YEP_TEST_TASK_INSTALL_MARKER)) {
  Write-Output ("__ISOLATED_TASK_INSTALLER__" + [IO.File]::ReadAllText($env:YEP_TEST_TASK_INSTALL_MARKER))
}
if (-not $success) { exit 1 }
`,
    {
      YEP_LAUNCHD_LOG_DIR: fixture.stateDir,
      YEP_SERVICE_CONFIG_PATH: fixture.configPath,
      YEP_PROD_READY_TRIES: "1",
      YEP_TASK_STOP_WAIT_TRIES: "1",
      YEP_TEST_TASK_INSTALL_MARKER: fixture.installMarkerPath,
    },
  );
}

async function runLegacyStopScenario(
  scenario:
    | "supervisor-disappears"
    | "server-reused"
    | "descendant-reused"
    | "disappeared-then-reused"
    | "supervisor-exits-before-snapshot"
    | "descendant-replaced-before-binding"
    | "replacement-before-termination"
    | "missing-creation-date"
    | "invalid-creation-date"
    | "snapshot-failure"
    | "listener-after-kill"
    | "unknown-owner"
    | "unrelated-task",
  command: "stop-prod" | "start-prod" = "stop-prod",
) {
  const fixture = await createCliFixture("verified-stale");
  const legacyRepo = "C:\\legacy-main";
  const legacyBundle = `${legacyRepo}\\dist\\npm-package`;
  const legacyRunScript = `${legacyRepo}\\scripts\\run-yepanywhere.ps1`;
  const legacyCli = `${legacyBundle}\\dist\\cli.js`;
  await writeFile(
    fixture.manifestPath,
    JSON.stringify({
      Version: 1,
      Mode: "prod",
      RepoRoot: legacyRepo,
      BundlePath: legacyBundle,
      Processes: [
        {
          Role: "supervisor",
          Pid: 1200,
          StartTimeUtc: "2026-08-17T08:00:00Z",
        },
        {
          Role: "server",
          Pid: 1201,
          StartTimeUtc: "2026-08-17T08:00:01Z",
        },
      ],
    }),
    "utf8",
  );
  return runPowerShell(
    `${cliProviderHarness("verified-stale", fixture.configPath)}
$global:legacyStopScenario = '${scenario}'
$global:taskState = 'Running'
$global:taskStopped = $false
$global:alive = @{ 1200 = $true; 1201 = $true; 1300 = ($global:legacyStopScenario -in @('supervisor-exits-before-snapshot', 'descendant-replaced-before-binding')) }
$global:generation = @{ 1200 = 0; 1201 = 0; 1300 = 0 }
$global:serverGetCalls = 0
$global:supervisorGetCalls = 0
$global:supervisorRefreshSeen = $false
$global:replacementTriggered = $false
function Get-MockStartTime {
  param([int]$ProcessId)
  $offset = $ProcessId - 1200 + [int]$global:generation[$ProcessId]
  if ($global:taskStopped -and $global:legacyStopScenario -eq 'disappeared-then-reused' -and
      $ProcessId -eq 1200 -and $global:supervisorGetCalls -ge 3) { $offset += 30 }
  if ($global:taskStopped -and $global:legacyStopScenario -in @('server-reused', 'descendant-reused') -and
      $ProcessId -eq 1201) { $offset += 30 }
  return $global:fixedStart.AddSeconds($offset)
}
function Get-Process {
  param($Id, $ErrorAction)
  $processId = [int]$Id
  if ($processId -eq 9999) { return [pscustomobject]@{ Id = 9999; StartTime = $global:fixedStart; ProcessName = 'other' } }
  if (-not $global:alive[$processId]) { return $null }
  if ($processId -eq 1201) { $global:serverGetCalls++ }
  if ($processId -eq 1200) { $global:supervisorGetCalls++ }
  if ($global:taskStopped -and $global:legacyStopScenario -eq 'disappeared-then-reused' -and $processId -eq 1200) {
    if ($global:supervisorGetCalls -le 3) { return $null }
  }
  $process = [pscustomobject]@{
    Id = $processId
    StartTime = Get-MockStartTime -ProcessId $processId
    ProcessName = 'test'
    BoundGeneration = [int]$global:generation[$processId]
    SafeHandle = [pscustomobject]@{ IsInvalid = $false; IsClosed = $false }
    Disposed = $false
  }
  $process | Add-Member -MemberType ScriptProperty -Name Handle -Value {
    Write-Host "__HANDLE_OPEN__$($this.Id):$($this.BoundGeneration)"
    return [IntPtr]([int]$this.Id + 1)
  }
  $process | Add-Member -MemberType ScriptProperty -Name HasExited -Value {
    return (-not [bool]$global:alive[[int]$this.Id]) -or
      ([int]$global:generation[[int]$this.Id] -ne [int]$this.BoundGeneration)
  }
  $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
    $processId = [int]$this.Id
    if ($global:legacyStopScenario -eq 'replacement-before-termination' -and $processId -eq 1201 -and
        -not $global:replacementTriggered) {
      $global:alive[$processId] = $false
      $global:generation[$processId] = [int]$global:generation[$processId] + 30
      $global:alive[$processId] = $true
      $global:replacementTriggered = $true
      Write-Host "__REPLACED_BEFORE_TERMINATION__$processId"
    }
    if ($global:alive[$processId] -and
        [int]$global:generation[$processId] -eq [int]$this.BoundGeneration) {
      $global:alive[$processId] = $false
      Write-Host "__HANDLE_KILL__$processId"
      Write-Host "__KILL__$processId"
    } else {
      Write-Host "__HANDLE_SKIP__$processId"
    }
  }
  $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Milliseconds) return [bool]$this.HasExited }
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    if (-not $this.Disposed) {
      $this.Disposed = $true
      Write-Host "__DISPOSE__$($this.Id):$($this.BoundGeneration)"
    }
  }
  return $process
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if ($global:legacyStopScenario -eq 'snapshot-failure' -and $global:taskStopped -and -not $Filter) { throw 'snapshot failed' }
  $serverParent = if ($global:taskStopped -and -not $global:alive[1200]) { 0 } else { 1200 }
  $supervisorParent = if ($global:taskStopped -and $global:legacyStopScenario -eq 'disappeared-then-reused' -and $global:supervisorGetCalls -ge 3) { 1201 } else { 0 }
  $items = @(
    [pscustomobject]@{ ProcessId = 1200; ParentProcessId = $supervisorParent; CreationDate = Get-MockStartTime -ProcessId 1200; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${legacyRunScript}" -ConfigPath "${fixture.configPath.replaceAll("'", "''")}"' },
    [pscustomobject]@{ ProcessId = 1201; ParentProcessId = $serverParent; CreationDate = Get-MockStartTime -ProcessId 1201; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "${legacyCli}" --port 8022' },
    [pscustomobject]@{ ProcessId = 1300; ParentProcessId = 1201; CreationDate = Get-MockStartTime -ProcessId 1300; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe idle-child.js' }
  ) | Where-Object { $global:alive[[int]$_.ProcessId] }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    $item = @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
    if ($global:legacyStopScenario -eq 'supervisor-exits-before-snapshot' -and $global:taskStopped -and
        $wanted -eq 1200 -and -not $global:supervisorRefreshSeen) {
      $global:supervisorRefreshSeen = $true
      $global:alive[1200] = $false
    }
    return $item
  }
  if ($global:legacyStopScenario -eq 'descendant-replaced-before-binding' -and $global:taskStopped -and
      -not $global:replacementTriggered) {
    $global:generation[1300] = [int]$global:generation[1300] + 30
    $global:replacementTriggered = $true
    Write-Host '__DESCENDANT_REPLACED_BEFORE_BINDING__1300'
  }
  if ($global:taskStopped -and $global:legacyStopScenario -eq 'missing-creation-date') {
    foreach ($item in $items) { $item.PSObject.Properties.Remove('CreationDate') }
  }
  if ($global:taskStopped -and $global:legacyStopScenario -eq 'invalid-creation-date') {
    foreach ($item in $items) { $item.CreationDate = 'not-a-date' }
  }
  return @($items)
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  if ($global:taskStopped -and $global:legacyStopScenario -eq 'unknown-owner' -and [int]$LocalPort -eq 8022) {
    return [pscustomobject]@{ OwningProcess = 9999 }
  }
  if ($global:taskStopped -and $global:legacyStopScenario -eq 'listener-after-kill' -and -not $global:alive[1201] -and [int]$LocalPort -eq 8022) {
    return [pscustomobject]@{ OwningProcess = 9999 }
  }
  if ($global:taskStopped -and $global:legacyStopScenario -in @('server-reused', 'descendant-reused', 'disappeared-then-reused')) { return @() }
  if (-not $global:alive[1201]) { return @() }
  if ([int]$LocalPort -in @(8022, 8023)) { return [pscustomobject]@{ OwningProcess = 1201 } }
  return @()
}
function Get-ScheduledTask {
  $taskRepo = if ($global:legacyStopScenario -eq 'unrelated-task') { 'C:\\unrelated' } else { '${legacyRepo}' }
  $taskRunScript = Join-Path $taskRepo 'scripts\\run-yepanywhere.ps1'
  return [pscustomobject]@{
    State = $global:taskState
    Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
    Actions = @([pscustomobject]@{
      Execute = (Get-Command powershell.exe).Source
      Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $taskRunScript + '" -ConfigPath "${fixture.configPath.replaceAll("'", "''")}"'
      WorkingDirectory = $taskRepo
    })
    Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
    Triggers = @()
  }
}
function Stop-ScheduledTask {
  param($TaskName, $ErrorAction)
  Write-Output '__TASK_STOPPED__'
  $global:taskState = 'Ready'
  $global:taskStopped = $true
  if ($global:legacyStopScenario -notin @('descendant-reused', 'disappeared-then-reused', 'supervisor-exits-before-snapshot')) { $global:alive[1200] = $false }
}
function taskkill.exe {
  param($PidFlag, $TargetPid, $TreeFlag, $ForceFlag)
  $processId = [int]$TargetPid
  if ($global:legacyStopScenario -eq 'replacement-before-termination' -and $processId -eq 1201 -and
      -not $global:replacementTriggered) {
    $global:alive[$processId] = $false
    $global:generation[$processId] = [int]$global:generation[$processId] + 30
    $global:alive[$processId] = $true
    $global:replacementTriggered = $true
    Write-Output "__REPLACED_BEFORE_TERMINATION__$processId"
  }
  if ($TreeFlag -eq '/T' -or $ForceFlag -eq '/T') { Write-Output "__TREE_KILL__$processId" }
  Write-Output "__PID_KILL__$processId"
  Write-Output "__KILL__$processId"
  if ($global:legacyStopScenario -eq 'replacement-before-termination' -and $processId -eq 1201) {
    Write-Output "__REPLACEMENT_KILLED__$processId"
  }
  $global:alive[$processId] = $false
  & cmd.exe /c exit 0
}
. ${psLiteral(yepScript)} help
${command === "start-prod" ? "function Ensure-ProductionTask { return $true }\nfunction Start-ScheduledTask { Write-Output '__TASK_STARTED__' }\nfunction Wait-ProductionInstanceReady { return $true }" : ""}
$success = ${command === "start-prod" ? "Cmd-StartProd" : "Cmd-StopProd"}
if ($global:taskStopped) { Write-Output '__TASK_STOPPED__' }
if (-not $success) { exit 1 }
`,
    {
      YEP_LAUNCHD_LOG_DIR: fixture.stateDir,
      YEP_SERVICE_CONFIG_PATH: fixture.configPath,
      YEP_TASK_STOP_WAIT_TRIES: "1",
    },
  );
}

function requireResult<T>(results: Map<string, T>, scenario: string) {
  const result = results.get(scenario);
  if (!result) throw new Error(`Missing result for ${scenario}`);
  return result;
}

function supervisorProviderHarness(scenario: string, configPath: string) {
  return `
$global:scenario = '${scenario}'
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
$global:realTestPath = Get-Command Test-Path -CommandType Cmdlet
$global:realGetContent = Get-Command Get-Content -CommandType Cmdlet
$global:processes = @{}
$global:processGetCalls = @{}
$global:nextPid = 1301
$global:capturedMaintenancePort = $null
foreach ($processId in @(1200, 1201, 1202, 1203)) {
  $present = switch ($global:scenario) {
    { $_ -in @('degraded-adoptable', 'adoption-pid-reused') } { $processId -ne 1200 }
    'stopped' { $false }
    'readiness-build-mismatch' { $false }
    'partial-identity' { $false }
    'partial-second-start' { $false }
    'partial-first-manifest' { $false }
    'external-bridge' { $false }
    'bridge-conflict' { $false }
    default { $true }
  }
  if ($present) {
    $process = [pscustomobject]@{
      Id = $processId
      StartTime = $global:fixedStart.AddSeconds($processId - 1200)
      HasExited = $false
      SafeHandle = [pscustomobject]@{ IsInvalid = $false; IsClosed = $false }
    }
    $process | Add-Member -MemberType ScriptProperty -Name Handle -Value { return [IntPtr]([int]$this.Id + 1) }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
    $global:processes[$processId] = $process
  }
}
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
  switch ($ProcessId) {
    { $_ -in @(1201, 1301) } { return 'server' }
    { $_ -in @(1202, 1302) } { return 'codex-bridge' }
    { $_ -in @(1203, 1303) } { return 'claude-bridge' }
    default { return 'supervisor' }
  }
}
function Get-TestCommand([int]$ProcessId) {
  if ($ProcessId -eq 1200) {
    return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
  }
  switch (Get-TestRole $ProcessId) {
    'server' { return 'node.exe "${cliJs.replaceAll("'", "''")}" --port 8022' }
    'codex-bridge' { return 'node.exe "${cliJs.replaceAll("'", "''")}" --codex-bridge-only' }
    'claude-bridge' { return 'node.exe "${cliJs.replaceAll("'", "''")}" --claude-bridge-only' }
    default { return 'powershell.exe -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"' }
  }
}
function Get-Process {
  param($Id, $ErrorAction)
  $processId = [int]$Id
  if ($processId -eq $PID) {
    return [pscustomobject]@{ Id = $PID; StartTime = $global:fixedStart.AddMinutes(1); HasExited = $false }
  }
  if ($processId -eq 9999) {
    return [pscustomobject]@{ Id = 9999; StartTime = $global:fixedStart; HasExited = $false }
  }
  $global:processGetCalls[$processId] = [int]$global:processGetCalls[$processId] + 1
  if ($global:scenario -eq 'adoption-pid-reused' -and $processId -eq 1201 -and
      [int]$global:processGetCalls[$processId] -eq 2) {
    $replacement = [pscustomobject]@{
      Id = $processId
      StartTime = $global:fixedStart.AddSeconds(31)
      HasExited = $false
      SafeHandle = [pscustomobject]@{ IsInvalid = $false; IsClosed = $false }
    }
    $replacement | Add-Member -MemberType ScriptProperty -Name Handle -Value { return [IntPtr]([int]$this.Id + 1) }
    $replacement | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
    $global:processes[$processId] = $replacement
    Write-Host '__ADOPTION_PID_REUSED__1201'
  }
  return $global:processes[$processId]
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @([pscustomobject]@{
    ProcessId = $PID
    ParentProcessId = 0
    ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    CommandLine = Get-TestCommand $PID
  })
  foreach ($process in @($global:processes.Values)) {
    $role = Get-TestRole ([int]$process.Id)
    $parentId = if ($role -eq 'supervisor') { 0 } elseif ([int]$process.Id -lt 1300) { 1200 } else { $PID }
    $items += [pscustomobject]@{
      ProcessId = [int]$process.Id
      ParentProcessId = $parentId
      CreationDate = $process.StartTime
      ExecutablePath = if ($role -eq 'supervisor') { 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' } else { 'C:\\Program Files\\nodejs\\node.exe' }
      CommandLine = Get-TestCommand ([int]$process.Id)
    }
  }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    if ($global:scenario -eq 'partial-identity' -and $wanted -eq 1301) { return $null }
    return @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return @($items)
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  $port = [int]$LocalPort
  if ($global:scenario -eq 'unknown-conflict' -and $port -eq 8022) {
    return [pscustomobject]@{ OwningProcess = 9999 }
  }
  if ($global:scenario -in @('external-bridge', 'bridge-conflict') -and $port -eq 4510) {
    return [pscustomobject]@{ OwningProcess = 9999 }
  }
  $role = switch ($port) { 8022 { 'server' } 8023 { 'server' } 4510 { 'codex-bridge' } 4520 { 'claude-bridge' } default { '' } }
  $owner = @($global:processes.Values | Where-Object { (Get-TestRole ([int]$_.Id)) -eq $role }) | Select-Object -First 1
  if (-not $owner) { return @() }
  return [pscustomobject]@{ OwningProcess = [int]$owner.Id }
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction)
  Write-Host "__HEALTH__$Uri"
  if ($global:scenario -eq 'bridge-conflict' -and [string]$Uri -like '*:4510/status') { throw 'unhealthy bridge' }
  if ([string]$Uri -like '*/api/version') {
    $buildId = if ($global:scenario -eq 'readiness-build-mismatch' -and $global:processes.ContainsKey(1301)) { 'old-build' } else { 'build-1' }
    return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"' + $buildId + '"}}' }
  }
  return [pscustomobject]@{ StatusCode = 200; Content = '{}' }
}
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
  $role = if ($ArgumentList -contains '--codex-bridge-only') { 'codex-bridge' } elseif ($ArgumentList -contains '--claude-bridge-only') { 'claude-bridge' } else { 'server' }
  if ($global:scenario -eq 'partial-second-start' -and $role -eq 'codex-bridge') { throw 'mock second Start-Process failure' }
  $processId = switch ($role) { 'server' { 1301 } 'codex-bridge' { 1302 } default { 1303 } }
  $process = [pscustomobject]@{ Id = $processId; StartTime = $global:fixedStart.AddMinutes(2).AddSeconds($processId - 1300); HasExited = $false }
  $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
    $this.HasExited = $true
    Write-Host "__KILL_EXACT__$($this.Id)"
  }
  $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { }
  $global:processes[$processId] = $process
  if ($global:scenario -eq 'partial-first-manifest' -and $role -eq 'claude-bridge') {
    Remove-Item -LiteralPath $env:YEP_LAUNCHD_LOG_DIR -Force
    [IO.File]::WriteAllText($env:YEP_LAUNCHD_LOG_DIR, 'block manifest parent')
  }
  if ($role -eq 'server') { Write-Host "__MAINTENANCE_ENV__$env:MAINTENANCE_PORT" }
  Write-Host "__START_CHILD__$role"
  return $process
}
function taskkill.exe {
  param($PidFlag, $TargetPid, $TreeFlag, $ForceFlag)
  $target = [int]$TargetPid
  Write-Output "__KILL_VERIFIED__$target"
  if ($target -eq 1200) {
    foreach ($processId in @(1200, 1201, 1202, 1203)) { $global:processes.Remove($processId) }
  } else {
    $global:processes.Remove($target)
  }
  & cmd.exe /c exit 0
}
function Start-Sleep {
  param($Milliseconds, $Seconds)
  if ($PSBoundParameters.ContainsKey('Seconds')) { exit 0 }
}
& ${psLiteral(runProdScript)} -ConfigPath ${psLiteral(configPath)}
`;
}

async function runSupervisorScenario(
  scenario:
    | "healthy"
    | "degraded-adoptable"
    | "adoption-pid-reused"
    | "verified-stale"
    | "unknown-conflict"
    | "stopped"
    | "readiness-build-mismatch"
    | "partial-identity"
    | "partial-second-start"
    | "partial-first-manifest"
    | "external-bridge"
    | "bridge-conflict",
) {
  const fixture = await createCliFixture(
    scenario === "adoption-pid-reused"
      ? "degraded-adoptable"
      : scenario === "external-bridge" ||
          scenario === "bridge-conflict" ||
          scenario === "readiness-build-mismatch" ||
          scenario.startsWith("partial-")
        ? "stopped"
        : scenario,
  );
  const result = await runPowerShell(
    supervisorProviderHarness(scenario, fixture.configPath),
    {
      YEP_LAUNCHD_LOG_DIR: scenario.startsWith("partial-")
        ? path.join(fixture.stateDir, "logs")
        : fixture.stateDir,
      YEP_SERVICE_CONFIG_PATH: fixture.configPath,
    },
  );
  return { ...fixture, result };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "win32")(
  "Windows production runtime identity",
  () => {
    it("atomically writes a BOM-free v2 manifest and leaves no temp file", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-atomic-"),
      );
      tempDirs.push(stateDir);
      const manifestPath = path.join(stateDir, "prod-process.json");
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$first = [ordered]@{ Version = 2; Mode = 'prod'; BuildId = 'first' }
$second = [ordered]@{ Version = 2; Mode = 'prod'; BuildId = 'second' }
Write-YepJsonAtomic -Path $env:YEP_TEST_MANIFEST -Value $first
Write-YepJsonAtomic -Path $env:YEP_TEST_MANIFEST -Value $second
$tempCount = @(Get-ChildItem -Path ($env:YEP_TEST_MANIFEST + '.tmp.*') -ErrorAction SilentlyContinue).Count
Write-Output "__TEMP_COUNT__$tempCount"
`,
        { YEP_TEST_MANIFEST: manifestPath },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
        Version: 2,
        Mode: "prod",
        BuildId: "second",
      });
      expect(result.stdout).toContain("__TEMP_COUNT__0");
      expect((await readFile(manifestPath))[0]).not.toBe(0xef);
    });

    it("rejects a v2 process entry without ExecutablePath", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-schema-"),
      );
      tempDirs.push(stateDir);
      const manifestPath = path.join(stateDir, "prod-process.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          Version: 2,
          Mode: "prod",
          Processes: [
            {
              Role: "server",
              Pid: 42,
              StartTimeUtc: "2026-08-17T00:00:00Z",
              CommandLine: "node cli.js --port 8022",
            },
          ],
        }),
        "utf8",
      );
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$read = Read-YepProcessManifest -Path $env:YEP_TEST_MANIFEST
Write-Output ('__READ__' + $read.Status)
`,
        { YEP_TEST_MANIFEST: manifestPath },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("__READ__invalid");
    });

    it.each([
      ["v1 null process", { Version: 1, Mode: "prod", Processes: [null] }],
      ["v2 null supervisor", { ...validManifest(), Supervisor: null }],
      ["v2 null process", { ...validManifest(), Processes: [null] }],
    ])(
      "returns invalid rather than throwing for %s",
      async (_name, manifest) => {
        const stateDir = await mkdtemp(
          path.join(tmpdir(), "yep-runtime-null-schema-"),
        );
        tempDirs.push(stateDir);
        const manifestPath = path.join(stateDir, "prod-process.json");
        await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

        const result = await runPowerShell(
          `
$ErrorActionPreference = 'Stop'
. ${psLiteral(runtimeScript)}
$read = Read-YepProcessManifest -Path $env:YEP_TEST_MANIFEST
Write-Output ('__READ__' + $read.Status)
`,
          { YEP_TEST_MANIFEST: manifestPath },
        );

        expect(result.code, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).toContain("__READ__invalid");
      },
    );

    it("treats a confirmed free port as having no listeners with the real Windows provider", async () => {
      const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
. ${psLiteral(runtimeScript)}
$listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), 0
$listener.Start()
$port = [int]$listener.LocalEndpoint.Port
$listener.Stop()
$pids = @(Get-YepListeningPids -Port $port)
Write-Output ('__FREE_PORT__' + $port)
Write-Output ('__PIDS__' + (ConvertTo-Json -InputObject $pids -Compress))
`);

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toMatch(/__FREE_PORT__\d+/);
      expect(result.stdout).toContain("__PIDS__[]");
    });

    it("binds a real Windows process only within CIM timestamp precision", async () => {
      const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
. ${psLiteral(runtimeScript)}
$ownedProcess = $null
$bound = $null
$negative = $null
try {
  $targetPid = [int]$PID
  $targetCim = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction Stop
  $probe = Get-Process -Id $targetPid -ErrorAction Stop
  try { $targetStart = $probe.StartTime.ToUniversalTime() } finally { $probe.Dispose() }
  $creation = ([DateTime]$targetCim.CreationDate).ToUniversalTime()
  $delta = [Math]::Abs([long]($targetStart.Ticks - $creation.Ticks))

  for ($attempt = 0; ($delta -eq 0) -and ($attempt -lt 20); $attempt++) {
    $child = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru
    try {
      $candidateCim = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)" -ErrorAction Stop
      $candidateStart = $child.StartTime.ToUniversalTime()
      $candidateCreation = ([DateTime]$candidateCim.CreationDate).ToUniversalTime()
      $candidateDelta = [Math]::Abs([long]($candidateStart.Ticks - $candidateCreation.Ticks))
      if ($candidateDelta -gt 0) {
        $ownedProcess = $child
        $targetPid = [int]$child.Id
        $targetCim = $candidateCim
        $targetStart = $candidateStart
        $delta = $candidateDelta
        $child = $null
      }
    } finally {
      if ($child) {
        if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(5000) }
        $child.Dispose()
      }
    }
  }
  if (($delta -lt 1) -or ($delta -gt 9)) { throw "unexpected provider precision delta: $delta" }

  $bound = New-YepBoundProcessSnapshotEntry -ProcessInfo $targetCim -Role 'descendant'
  $negativeInfo = [pscustomobject]@{ ProcessId = $targetPid; CreationDate = $targetStart.AddTicks(10) }
  $negative = New-YepBoundProcessSnapshotEntry -ProcessInfo $negativeInfo -Role 'descendant'
  Write-Output "__REAL_DELTA__$delta"
  Write-Output "__REAL_BIND__$($bound.Status)"
  Write-Output "__TEN_TICK_BIND__$($negative.Status)"
} finally {
  if ($bound -and $bound.Entry) { Close-YepBoundProcessSnapshot -Snapshot @($bound.Entry) }
  if ($negative -and $negative.Entry) { Close-YepBoundProcessSnapshot -Snapshot @($negative.Entry) }
  if ($ownedProcess) {
    if (-not $ownedProcess.HasExited) { $ownedProcess.Kill(); $null = $ownedProcess.WaitForExit(5000) }
    $ownedProcess.Dispose()
  }
}
`);

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const delta = Number(result.stdout.match(/__REAL_DELTA__(\d+)/)?.[1]);
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(9);
      expect(result.stdout).toContain("__REAL_BIND__bound");
      expect(result.stdout).toContain("__TEN_TICK_BIND__mismatch");
    });

    it("fails closed when the Windows listener provider genuinely fails", async () => {
      const result = await runPowerShell(`
. ${psLiteral(runtimeScript)}
function Get-NetTCPConnection { throw 'provider failure' }
$pids = @(Get-YepListeningPids -Port 65000)
Write-Output ('__PIDS__' + (ConvertTo-Json -InputObject $pids -Compress))
`);

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("__PIDS__[0]");
    });

    it("accepts only the complete v2 manifest contract", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-v2-contract-"),
      );
      tempDirs.push(stateDir);
      const manifestPath = path.join(stateDir, "prod-process.json");
      await writeFile(manifestPath, JSON.stringify(validManifest()), "utf8");
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$valid = Read-YepProcessManifest -Path $env:YEP_TEST_MANIFEST
Write-Output ('__VALID__' + $valid.Status)
$manifest = Get-Content -LiteralPath $env:YEP_TEST_MANIFEST -Raw | ConvertFrom-Json
$manifest.Processes += $manifest.Processes[0]
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $env:YEP_TEST_MANIFEST
$duplicate = Read-YepProcessManifest -Path $env:YEP_TEST_MANIFEST
Write-Output ('__DUPLICATE__' + $duplicate.Status)
`,
        { YEP_TEST_MANIFEST: manifestPath },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("__VALID__valid-v2");
      expect(result.stdout).toContain("__DUPLICATE__invalid");
    });

    it("rejects non-adjacent maintenance ports and supervisor PID collisions", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-v2-boundaries-"),
      );
      tempDirs.push(stateDir);
      const valid = validManifest();
      await Promise.all([
        writeFile(
          path.join(stateDir, "maintenance.json"),
          JSON.stringify({
            ...valid,
            Ports: { ...valid.Ports, Maintenance: 9000 },
          }),
          "utf8",
        ),
        writeFile(
          path.join(stateDir, "pid-collision.json"),
          JSON.stringify({
            ...valid,
            Processes: [
              { ...valid.Processes[0], Pid: valid.Supervisor.Pid },
              valid.Processes[1],
            ],
          }),
          "utf8",
        ),
      ]);
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$statuses = [ordered]@{}
foreach ($name in @('maintenance', 'pid-collision')) {
  $read = Read-YepProcessManifest -Path (Join-Path $env:YEP_TEST_STATE_DIR ($name + '.json'))
  $statuses[$name] = $read.Status
}
Write-Output ('__STATUSES__' + ($statuses | ConvertTo-Json -Compress))
`,
        { YEP_TEST_STATE_DIR: stateDir },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const line = result.stdout
        .split(/\r?\n/)
        .find((value) => value.startsWith("__STATUSES__"));
      expect(JSON.parse(line?.slice("__STATUSES__".length) ?? "{}")).toEqual({
        maintenance: "invalid",
        "pid-collision": "invalid",
      });
    });

    it("rejects a production expectation with a non-adjacent maintenance port", async () => {
      const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
. ${psLiteral(runtimeScript)}
try {
  New-YepProductionExpectation -RepoRoot 'C:\\repo' -BundlePath 'C:\\repo\\dist\\npm-package' -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 9000 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1' | Out-Null
  Write-Output '__EXPECTATION__accepted'
} catch {
  Write-Output '__EXPECTATION__rejected'
}
`);

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("__EXPECTATION__rejected");
    });

    it("reads the bundle build ID and hashes ordered config identity", async () => {
      const bundleDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-build-id-"),
      );
      tempDirs.push(bundleDir);
      await writeFile(
        path.join(bundleDir, "build-info.json"),
        JSON.stringify({ buildId: "build-42" }),
        "utf8",
      );
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$identity = [ordered]@{ RepoRoot = 'C:\\repo'; ServerPort = 8022 }
Write-Output ('__BUILD__' + (Get-YepBundleBuildId -BundlePath $env:YEP_TEST_BUNDLE))
Write-Output ('__HASH__' + (Get-YepConfigFingerprint -ConfigIdentity $identity))
`,
        { YEP_TEST_BUNDLE: bundleDir },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("__BUILD__build-42");
      expect(result.stdout).toContain(
        "__HASH__f9b005c83ec8db42f3c45b0b900d4c4655291ca3a6db247e275ba8ee4e26a675",
      );
    });

    it("normalizes one shared production expectation", async () => {
      const result = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\repo\\.' -BundlePath 'C:\\repo\\dist\\npm-package\\.' -BuildId 'build-1' -BasePath '/remote/' -Profile 'default' -DataDir $null -AllowedImagePaths 'C:\\images' -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1'
$expectation | ConvertTo-Json -Compress -Depth 8
`);

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const expectation = JSON.parse(result.stdout.trim());
      expect(expectation).toMatchObject({
        RepoRoot: "C:\\repo",
        BundlePath: "C:\\repo\\dist\\npm-package",
        BasePath: "/remote",
        ServerBaseUrl: "http://127.0.0.1:8022/remote",
        CliPath: "C:\\repo\\dist\\npm-package\\dist\\cli.js",
        ConfigFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    });

    it("rejects near-match role command tokens", async () => {
      const result = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
$global:command = ''
$global:executable = 'C:\\Program Files\\nodejs\\node.exe'
function Get-Process { param($Id, $ErrorAction) return [pscustomobject]@{ Id = [int]$Id; StartTime = $global:fixedStart } }
function Get-CimInstance { return [pscustomobject]@{ ProcessId = 1200; ParentProcessId = 0; ExecutablePath = $global:executable; CommandLine = $global:command } }
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\repo' -BundlePath 'C:\\repo\\dist\\npm-package' -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1'
$cases = @(
  [pscustomobject]@{ Name = 'cli-suffix'; Role = 'server'; Command = 'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js.evil" --port 8022' },
  [pscustomobject]@{ Name = 'bridge-flag-suffix'; Role = 'codex-bridge'; Command = 'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js" --codex-bridge-only-extra' },
  [pscustomobject]@{ Name = 'run-script-suffix'; Role = 'supervisor'; Command = 'powershell.exe -File "C:\\repo\\scripts\\run-yepanywhere.ps1.evil" -ConfigPath "C:\\state\\service-config.json"' },
  [pscustomobject]@{ Name = 'config-flag-suffix'; Role = 'supervisor'; Command = 'powershell.exe -File "C:\\repo\\scripts\\run-yepanywhere.ps1" -ConfigPathExtra "C:\\state\\service-config.json"' }
)
$results = [ordered]@{}
foreach ($case in $cases) {
  $global:command = $case.Command
  $global:executable = if ($case.Role -eq 'supervisor') { 'C:\\Windows\\powershell.exe' } else { 'C:\\Program Files\\nodejs\\node.exe' }
  $entry = [pscustomobject]@{
    Role = $case.Role
    Pid = 1200
    StartTimeUtc = $global:fixedStart.ToUniversalTime().ToString('o')
    ExecutablePath = $global:executable
    CommandLine = $global:command
  }
  $results[$case.Name] = Test-YepProcessIdentity -Entry $entry -Expectation $expectation
}
Write-Output ('__RESULTS__' + ($results | ConvertTo-Json -Compress))
`);

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const line = result.stdout
        .split(/\r?\n/)
        .find((value) => value.startsWith("__RESULTS__"));
      expect(JSON.parse(line?.slice("__RESULTS__".length) ?? "{}")).toEqual({
        "cli-suffix": false,
        "bridge-flag-suffix": false,
        "run-script-suffix": false,
        "config-flag-suffix": false,
      });
    });

    it("classifies the five production states and strict legacy v1", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-states-"),
      );
      tempDirs.push(stateDir);
      const expectationSeed = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\repo' -BundlePath 'C:\\repo\\dist\\npm-package' -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1'
Write-Output $expectation.ConfigFingerprint
`);
      expect(
        expectationSeed.code,
        expectationSeed.stderr || expectationSeed.stdout,
      ).toBe(0);
      const fingerprint = expectationSeed.stdout.trim();
      const healthy = {
        ...validManifest(),
        ConfigFingerprint: fingerprint,
      };
      await Promise.all([
        writeFile(
          path.join(stateDir, "healthy.json"),
          JSON.stringify(healthy),
          "utf8",
        ),
        writeFile(
          path.join(stateDir, "build-mismatch.json"),
          JSON.stringify({ ...healthy, BuildId: "old-build" }),
          "utf8",
        ),
        writeFile(
          path.join(stateDir, "legacy.json"),
          JSON.stringify({
            Version: 1,
            Mode: "prod",
            RepoRoot: "C:\\repo",
            BundlePath: "C:\\repo\\dist\\npm-package",
            Processes: [
              {
                Role: "supervisor",
                Pid: 1200,
                StartTimeUtc: "2026-08-17T08:00:00Z",
              },
              {
                Role: "server",
                Pid: 1201,
                StartTimeUtc: "2026-08-17T08:00:01Z",
              },
            ],
          }),
          "utf8",
        ),
      ]);
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$global:scenario = ''
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
function Get-Process {
  param($Id, $ErrorAction)
  if ($global:scenario -eq 'nothing' -or ($global:scenario -eq 'supervisorMissing' -and [int]$Id -eq 1200)) { return $null }
  $offset = switch ([int]$Id) { 1200 { 0 } 1201 { 1 } 1202 { 2 } default { 3 } }
  return [pscustomobject]@{ Id = [int]$Id; StartTime = $global:fixedStart.AddSeconds($offset); ProcessName = 'test' }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @(
    [pscustomobject]@{ ProcessId = 1200; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\powershell.exe'; CommandLine = 'powershell.exe -File "C:\\repo\\scripts\\run-yepanywhere.ps1" -ConfigPath "C:\\state\\service-config.json"' },
    [pscustomobject]@{ ProcessId = 1201; ParentProcessId = 1200; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js" --port 8022' },
    [pscustomobject]@{ ProcessId = 1202; ParentProcessId = 1200; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js" --codex-bridge-only' }
  )
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  if ($global:scenario -eq 'nothing') { return @() }
  if ($global:scenario -eq 'unknownServerPortOwner' -and [int]$LocalPort -eq 8022) { return [pscustomobject]@{ OwningProcess = 9999 } }
  $owner = switch ([int]$LocalPort) { 8022 { 1201 } 8023 { 1201 } 4510 { 1202 } default { 9998 } }
  return [pscustomobject]@{ OwningProcess = $owner }
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction)
  if ([string]$Uri -like '*/api/version') { return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"build-1"}}' } }
  return [pscustomobject]@{ StatusCode = 200; Content = '{}' }
}
function Stop-Process { Write-Output '__UNEXPECTED_STOP__' }
function taskkill.exe { Write-Output '__UNEXPECTED_TASKKILL__' }
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\repo' -BundlePath 'C:\\repo\\dist\\npm-package' -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1'
$states = [ordered]@{}
foreach ($case in @(
  @('allMatched', 'healthy.json'),
  @('supervisorMissing', 'healthy.json'),
  @('buildMismatch', 'build-mismatch.json'),
  @('unknownServerPortOwner', 'healthy.json'),
  @('nothingRunning', 'missing.json'),
  @('verifiedLegacyV1', 'legacy.json')
)) {
  $global:scenario = if ($case[0] -eq 'nothingRunning') { 'nothing' } else { $case[0] }
  $inspection = Get-YepProductionInspection -ManifestPath (Join-Path $env:YEP_TEST_STATE_DIR $case[1]) -Expectation $expectation
  $states[$case[0]] = $inspection.State
}
Write-Output ('__STATES__' + ($states | ConvertTo-Json -Compress))
`,
        { YEP_TEST_STATE_DIR: stateDir },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const statesLine = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("__STATES__"));
      expect(statesLine).toBeDefined();
      expect(
        JSON.parse(statesLine?.slice("__STATES__".length) ?? "{}"),
      ).toEqual({
        allMatched: "healthy",
        supervisorMissing: "degraded-adoptable",
        buildMismatch: "verified-stale",
        unknownServerPortOwner: "unknown-conflict",
        nothingRunning: "stopped",
        verifiedLegacyV1: "verified-stale",
      });
      expect(result.stdout).not.toContain("__UNEXPECTED_STOP__");
      expect(result.stdout).not.toContain("__UNEXPECTED_TASKKILL__");
    });

    it("trusts only normalized self-consistent v1 paths across worktrees", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-v1-worktree-"),
      );
      tempDirs.push(stateDir);
      const legacyRepo = "C:\\legacy-main";
      const legacyBundle = `${legacyRepo}\\dist\\npm-package`;
      const processes = [
        {
          Role: "supervisor",
          Pid: 1200,
          StartTimeUtc: "2026-08-17T08:00:00Z",
        },
        {
          Role: "server",
          Pid: 1201,
          StartTimeUtc: "2026-08-17T08:00:01Z",
        },
        {
          Role: "codex-bridge",
          Pid: 1202,
          StartTimeUtc: "2026-08-17T08:00:02Z",
        },
        {
          Role: "claude-bridge",
          Pid: 1203,
          StartTimeUtc: "2026-08-17T08:00:03Z",
        },
      ];
      const valid = {
        Version: 1,
        Mode: "prod",
        RepoRoot: `${legacyRepo}\\.`,
        BundlePath: `${legacyBundle}\\.`,
        Processes: processes,
      };
      const { RepoRoot: _repoRoot, ...missingPath } = valid;
      await Promise.all(
        Object.entries({
          valid,
          "trailing-separators": {
            ...valid,
            RepoRoot: `${legacyRepo}\\`,
            BundlePath: `${legacyBundle}\\`,
          },
          "missing-path": missingPath,
          "malformed-path": { ...valid, RepoRoot: { path: legacyRepo } },
          "relative-path": { ...valid, RepoRoot: "legacy-main" },
          "inconsistent-path": {
            ...valid,
            BundlePath: "C:\\other\\dist\\npm-package",
          },
          "role-mismatch": {
            ...valid,
            Processes: processes.map((entry) =>
              entry.Role === "server" ? { ...entry, Role: "worker" } : entry,
            ),
          },
          "start-mismatch": valid,
          "command-mismatch": valid,
        }).map(([name, manifest]) =>
          writeFile(
            path.join(stateDir, `${name}.json`),
            JSON.stringify(manifest),
            "utf8",
          ),
        ),
      );

      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
$global:scenario = ''
function Get-Process {
  param($Id, $ErrorAction)
  $offset = [int]$Id - 1200
  if ($global:scenario -eq 'start-mismatch' -and [int]$Id -eq 1201) { $offset += 10 }
  return [pscustomobject]@{ Id = [int]$Id; StartTime = $global:fixedStart.AddSeconds($offset) }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $serverCommand = if ($global:scenario -eq 'command-mismatch') { 'node.exe C:\\other\\cli.js --port 8022' } else { 'node.exe "C:\\legacy-main\\dist\\npm-package\\dist\\cli.js" --port 8022' }
  $items = @(
    [pscustomobject]@{ ProcessId = 1200; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\powershell.exe'; CommandLine = 'powershell.exe -File "C:\\legacy-main\\scripts\\run-yepanywhere.ps1" -ConfigPath "C:\\state\\service-config.json"' },
    [pscustomobject]@{ ProcessId = 1201; ParentProcessId = 1200; ExecutablePath = 'C:\\node.exe'; CommandLine = $serverCommand },
    [pscustomobject]@{ ProcessId = 1202; ParentProcessId = 1200; ExecutablePath = 'C:\\node.exe'; CommandLine = 'node.exe "C:\\legacy-main\\dist\\npm-package\\dist\\cli.js" --codex-bridge-only' },
    [pscustomobject]@{ ProcessId = 1203; ParentProcessId = 1200; ExecutablePath = 'C:\\node.exe'; CommandLine = 'node.exe "C:\\legacy-main\\dist\\npm-package\\dist\\cli.js" --claude-bridge-only' }
  )
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  if ([int]$LocalPort -eq 8022) { return [pscustomobject]@{ OwningProcess = 1201 } }
  return @()
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction)
  if ([string]$Uri -like '*/api/version') { return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"p0-build"}}' } }
  return [pscustomobject]@{ StatusCode = 503; Content = '{}' }
}
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\isolated-worktree' -BundlePath 'C:\\isolated-worktree\\dist\\npm-package' -BuildId 'p1-build' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\isolated-worktree\\scripts\\run-yepanywhere.ps1'
$states = [ordered]@{}
foreach ($name in @('valid', 'trailing-separators', 'missing-path', 'malformed-path', 'relative-path', 'inconsistent-path', 'role-mismatch', 'start-mismatch', 'command-mismatch')) {
  $global:scenario = $name
  $inspection = Get-YepProductionInspection -ManifestPath (Join-Path $env:YEP_TEST_STATE_DIR ($name + '.json')) -Expectation $expectation
  $states[$name] = $inspection.State
}
Write-Output ('__STATES__' + ($states | ConvertTo-Json -Compress))
`,
        { YEP_TEST_STATE_DIR: stateDir },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const line = result.stdout
        .split(/\r?\n/)
        .find((value) => value.startsWith("__STATES__"));
      expect(JSON.parse(line?.slice("__STATES__".length) ?? "{}")).toEqual({
        valid: "verified-stale",
        "trailing-separators": "verified-stale",
        "missing-path": "unknown-conflict",
        "malformed-path": "unknown-conflict",
        "relative-path": "unknown-conflict",
        "inconsistent-path": "unknown-conflict",
        "role-mismatch": "unknown-conflict",
        "start-mismatch": "unknown-conflict",
        "command-mismatch": "unknown-conflict",
      });
    });

    it("emits only contracted reason tokens for legacy path and stop inspection", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-v1-reasons-"),
      );
      tempDirs.push(stateDir);
      const manifestPath = path.join(stateDir, "invalid-path.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          Version: 1,
          Mode: "prod",
          RepoRoot: "relative-repo",
          BundlePath: "relative-repo\\dist\\npm-package",
          Processes: [
            {
              Role: "supervisor",
              Pid: 1200,
              StartTimeUtc: "2026-08-17T08:00:00Z",
            },
          ],
        }),
        "utf8",
      );
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
function Get-Process { return $null }
function Get-CimInstance { return @() }
function Get-NetTCPConnection { return @() }
function Invoke-WebRequest { throw 'not running' }
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\isolated-worktree' -BundlePath 'C:\\isolated-worktree\\dist\\npm-package' -BuildId 'p1-build' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\isolated-worktree\\scripts\\run-yepanywhere.ps1'
$invalid = Get-YepProductionInspection -ManifestPath ${psLiteral(manifestPath)} -Expectation $expectation
$entry = [pscustomobject]@{ Role = 'supervisor'; Pid = 1200; StartTimeUtc = '2026-08-17T08:00:00Z' }
$manifest = [pscustomobject]@{ Version = 1; Mode = 'prod'; RepoRoot = 'C:\\legacy-main'; BundlePath = 'C:\\legacy-main\\dist\\npm-package'; Processes = @($entry) }
$trusted = [pscustomobject]@{ State = 'verified-stale'; Manifest = $manifest; VerifiedSupervisor = $entry; VerifiedProcesses = @(); UnknownPortOwners = @() }
$refreshed = Get-YepTrustedLegacyStopInspection -Inspection $trusted -Expectation $expectation
$reasons = @($invalid.Reasons) + @($refreshed.Reasons) | Select-Object -Unique
Write-Output ('__REASONS__' + ($reasons | ConvertTo-Json -Compress))
`,
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const line = result.stdout
        .split(/\r?\n/)
        .find((value) => value.startsWith("__REASONS__"));
      const reasons = JSON.parse(
        line?.slice("__REASONS__".length) ?? "[]",
      ) as string[];
      const allowed = new Set([
        "manifest-missing",
        "manifest-invalid",
        "legacy-v1",
        "supervisor-missing",
        "process-identity-mismatch",
        "build-mismatch",
        "config-mismatch",
        "role-missing",
        "main-unhealthy",
        "maintenance-unhealthy",
        "bridge-unhealthy",
        "unknown-port-owner",
      ]);
      expect(
        reasons.filter((reason) => !allowed.has(reason)),
        JSON.stringify(reasons),
      ).toEqual([]);
    });

    it("rejects each PID-reuse identity mismatch and reports its listener", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-pid-reuse-"),
      );
      tempDirs.push(stateDir);
      const manifestPath = path.join(stateDir, "manifest.json");
      const fingerprintResult = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\repo' -BundlePath 'C:\\repo\\dist\\npm-package' -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $false -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1'
Write-Output $expectation.ConfigFingerprint
`);
      expect(
        fingerprintResult.code,
        fingerprintResult.stderr || fingerprintResult.stdout,
      ).toBe(0);
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...validManifest(),
          ConfigFingerprint: fingerprintResult.stdout.trim(),
          Bridges: { Codex: "disabled", Claude: "disabled" },
          Processes: [validManifest().Processes[0]],
        }),
        "utf8",
      );
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$global:scenario = ''
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
function Get-Process {
  param($Id, $ErrorAction)
  $start = $global:fixedStart.AddSeconds($(if ([int]$Id -eq 1201) { 1 } else { 0 }))
  if ($global:scenario -eq 'StartTimeUtc' -and [int]$Id -eq 1201) { $start = $start.AddSeconds(10) }
  return [pscustomobject]@{ Id = [int]$Id; StartTime = $start; ProcessName = 'test' }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $pidValue = if ($Filter -match '([0-9]+)') { [int]$matches[1] } else { 1201 }
  if ($pidValue -eq 1200) { return [pscustomobject]@{ ProcessId = 1200; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\powershell.exe'; CommandLine = 'powershell.exe -File "C:\\repo\\scripts\\run-yepanywhere.ps1" -ConfigPath "C:\\state\\service-config.json"' } }
  $path = if ($global:scenario -eq 'ExecutablePath') { 'C:\\Other\\node.exe' } else { 'C:\\Program Files\\nodejs\\node.exe' }
  $command = if ($global:scenario -eq 'CommandLine') { 'node.exe other.js --port 8022' } else { 'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js" --port 8022' }
  return [pscustomobject]@{ ProcessId = 1201; ParentProcessId = 1200; ExecutablePath = $path; CommandLine = $command }
}
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) return [pscustomobject]@{ OwningProcess = 1201 } }
function Invoke-WebRequest { param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction) return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"build-1"}}' } }
function Stop-Process { Write-Output '__UNEXPECTED_STOP__' }
function taskkill.exe { Write-Output '__UNEXPECTED_TASKKILL__' }
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\repo' -BundlePath 'C:\\repo\\dist\\npm-package' -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $false -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1'
$results = [ordered]@{}
foreach ($case in @('StartTimeUtc', 'ExecutablePath', 'CommandLine')) {
  $global:scenario = $case
  $inspection = Get-YepProductionInspection -ManifestPath $env:YEP_TEST_MANIFEST -Expectation $expectation
  $results[$case] = [ordered]@{
    VerifiedRoles = @($inspection.VerifiedProcesses | ForEach-Object { $_.Role })
    UnknownPortOwners = @($inspection.UnknownPortOwners)
  }
}
Write-Output ('__REUSE__' + ($results | ConvertTo-Json -Compress -Depth 6))
`,
        { YEP_TEST_MANIFEST: manifestPath },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const reuseLine = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("__REUSE__"));
      expect(reuseLine).toBeDefined();
      const reuse = JSON.parse(reuseLine?.slice("__REUSE__".length) ?? "{}");
      for (const field of ["StartTimeUtc", "ExecutablePath", "CommandLine"]) {
        expect(reuse[field].VerifiedRoles).not.toContain("server");
        expect(reuse[field].UnknownPortOwners).toEqual(
          expect.arrayContaining([{ Port: 8022, Pid: 1201 }]),
        );
      }
      expect(result.stdout).not.toContain("__UNEXPECTED_STOP__");
      expect(result.stdout).not.toContain("__UNEXPECTED_TASKKILL__");
    });

    it("treats a mismatched managed bridge listener as unknown even when unhealthy", async () => {
      const stateDir = await mkdtemp(
        path.join(tmpdir(), "yep-runtime-bridge-owner-"),
      );
      tempDirs.push(stateDir);
      const manifestPath = path.join(stateDir, "manifest.json");
      const fingerprintResult = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\repo' -BundlePath 'C:\\repo\\dist\\npm-package' -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1'
Write-Output $expectation.ConfigFingerprint
`);
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...validManifest(),
          ConfigFingerprint: fingerprintResult.stdout.trim(),
        }),
        "utf8",
      );
      const result = await runPowerShell(
        `
. ${psLiteral(runtimeScript)}
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
function Get-Process { param($Id, $ErrorAction) return [pscustomobject]@{ Id = [int]$Id; StartTime = $global:fixedStart.AddSeconds($(if ([int]$Id -eq 1200) { 0 } elseif ([int]$Id -eq 1201) { 1 } else { 2 })) } }
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $items = @(
    [pscustomobject]@{ ProcessId = 1200; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\powershell.exe'; CommandLine = 'powershell.exe -File "C:\\repo\\scripts\\run-yepanywhere.ps1" -ConfigPath "C:\\state\\service-config.json"' },
    [pscustomobject]@{ ProcessId = 1201; ParentProcessId = 1200; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js" --port 8022' },
    [pscustomobject]@{ ProcessId = 1202; ParentProcessId = 1200; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = 'node.exe "C:\\repo\\dist\\npm-package\\dist\\cli.js" --codex-bridge-only' }
  )
  $wanted = if ($Filter -match '([0-9]+)') { [int]$matches[1] } else { 0 }
  return @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  $owner = switch ([int]$LocalPort) { 8022 { 1201 } 8023 { 1201 } 4510 { 9999 } default { 9998 } }
  return [pscustomobject]@{ OwningProcess = $owner }
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction)
  if ([string]$Uri -like '*/api/version') { return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"build-1"}}' } }
  if ([string]$Uri -like '*:4510/status') { return [pscustomobject]@{ StatusCode = 503; Content = '{}' } }
  return [pscustomobject]@{ StatusCode = 200; Content = '{}' }
}
function Stop-Process { Write-Output '__UNEXPECTED_STOP__' }
function taskkill.exe { Write-Output '__UNEXPECTED_TASKKILL__' }
$expectation = New-YepProductionExpectation -RepoRoot 'C:\\repo' -BundlePath 'C:\\repo\\dist\\npm-package' -BuildId 'build-1' -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths $null -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath 'C:\\repo\\scripts\\run-yepanywhere.ps1'
$inspection = Get-YepProductionInspection -ManifestPath $env:YEP_TEST_MANIFEST -Expectation $expectation
Write-Output ('__INSPECTION__' + ([ordered]@{ State = $inspection.State; UnknownPortOwners = @($inspection.UnknownPortOwners) } | ConvertTo-Json -Compress -Depth 4))
`,
        { YEP_TEST_MANIFEST: manifestPath },
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const line = result.stdout
        .split(/\r?\n/)
        .find((value) => value.startsWith("__INSPECTION__"));
      const inspection = JSON.parse(
        line?.slice("__INSPECTION__".length) ?? "{}",
      );
      expect(inspection.State).toBe("unknown-conflict");
      expect(inspection.UnknownPortOwners).toEqual(
        expect.arrayContaining([{ Port: 4510, Pid: 9999 }]),
      );
      expect(result.stdout).not.toContain("__UNEXPECTED_STOP__");
      expect(result.stdout).not.toContain("__UNEXPECTED_TASKKILL__");
    });

    it("stops only snapshotted verified roots and then a reparented child", async () => {
      const result = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
$global:rootKilled = $false
$global:serverKilled = $false
$global:reparentedKilled = $false
function Get-Process {
  param($Id, $ErrorAction)
  if ([int]$Id -eq 100 -and -not $global:rootKilled) { return [pscustomobject]@{ Id = 100; StartTime = $global:fixedStart } }
  if ([int]$Id -eq 101 -and -not $global:serverKilled) { return [pscustomobject]@{ Id = 101; StartTime = $global:fixedStart.AddSeconds(1) } }
  if ([int]$Id -eq 102 -and -not $global:reparentedKilled) { return [pscustomobject]@{ Id = 102; StartTime = $global:fixedStart.AddSeconds(2) } }
  return $null
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  return @(
    [pscustomobject]@{ ProcessId = 100; ParentProcessId = 0 },
    [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100 },
    [pscustomobject]@{ ProcessId = 102; ParentProcessId = 101 }
  )
}
function taskkill.exe {
  param($PidFlag, $TargetPid, $TreeFlag, $ForceFlag)
  if ([int]$TargetPid -eq 100) {
    $global:rootKilled = $true
    $global:serverKilled = $true
    Write-Output '__KILL__supervisor'
  } elseif ([int]$TargetPid -eq 101) {
    Write-Output '__KILL__server-child-twice'
  } elseif ([int]$TargetPid -eq 102) {
    $global:reparentedKilled = $true
    Write-Output '__KILL__reparented-child'
  }
  & cmd.exe /c exit 0
}
function Start-Sleep { }
$inspection = [pscustomobject]@{
  VerifiedSupervisor = [pscustomobject]@{ Role = 'supervisor'; Pid = 100; StartTimeUtc = $global:fixedStart.ToUniversalTime().ToString('o') }
  VerifiedProcesses = @([pscustomobject]@{ Role = 'server'; Pid = 101; StartTimeUtc = $global:fixedStart.AddSeconds(1).ToUniversalTime().ToString('o') })
  UnknownPortOwners = @()
}
if (-not (Stop-YepVerifiedProcessGroup -Inspection $inspection)) { exit 1 }
`);

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("__KILL__supervisor");
      expect(result.stdout).toContain("__KILL__reparented-child");
      expect(result.stdout).not.toContain("__KILL__server-child-twice");
    });

    it("refuses cleanup before any kill for unknown owners or incomplete enumeration", async () => {
      const runCase = (unknownOwner: boolean) =>
        runPowerShell(`
. ${psLiteral(runtimeScript)}
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
function Get-Process { return [pscustomobject]@{ Id = 100; StartTime = $global:fixedStart } }
function Get-CimInstance { ${unknownOwner ? "return @([pscustomobject]@{ ProcessId = 100; ParentProcessId = 0 })" : "throw 'enumeration failed'"} }
function taskkill.exe { Write-Output '__KILL__'; & cmd.exe /c exit 0 }
$inspection = [pscustomobject]@{
  VerifiedSupervisor = [pscustomobject]@{ Role = 'supervisor'; Pid = 100; StartTimeUtc = $global:fixedStart.ToUniversalTime().ToString('o') }
  VerifiedProcesses = @()
  UnknownPortOwners = @(${unknownOwner ? "[pscustomobject]@{ Port = 8022; Pid = 9999 }" : ""})
}
if (-not (Stop-YepVerifiedProcessGroup -Inspection $inspection)) { exit 1 }
`);

      const [unknownCleanup, incompleteCleanup] = await Promise.all([
        runCase(true),
        runCase(false),
      ]);
      expect(unknownCleanup.code).not.toBe(0);
      expect(unknownCleanup.stdout).not.toContain("__KILL__");
      expect(incompleteCleanup.code).not.toBe(0);
      expect(incompleteCleanup.stdout).not.toContain("__KILL__");
    });

    it("fails cleanup when a verified PID remains after taskkill", async () => {
      const result = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$global:fixedStart = [DateTime]::Parse('2026-08-17T08:00:00Z')
function Get-Process { return [pscustomobject]@{ Id = 100; StartTime = $global:fixedStart } }
function Get-CimInstance { return @([pscustomobject]@{ ProcessId = 100; ParentProcessId = 0 }) }
function taskkill.exe { Write-Output '__KILL__still-running'; & cmd.exe /c exit 5 }
$inspection = [pscustomobject]@{
  VerifiedSupervisor = [pscustomobject]@{ Role = 'supervisor'; Pid = 100; StartTimeUtc = $global:fixedStart.ToUniversalTime().ToString('o') }
  VerifiedProcesses = @()
  UnknownPortOwners = @()
}
if (-not (Stop-YepVerifiedProcessGroup -Inspection $inspection)) { exit 1 }
`);

      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("__KILL__still-running");
    });
  },
);

describe.skipIf(process.platform !== "win32")(
  "Windows production supervisor adoption",
  () => {
    it("adopts a verified orphan process group without starting or killing children", async () => {
      const { result, manifestPath, manifest } =
        await runSupervisorScenario("degraded-adoptable");

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("已接管现有生产进程组");
      expect(result.stdout).not.toContain("__START_CHILD__");
      expect(result.stdout).not.toContain("__KILL_");
      const adopted = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(adopted.SupervisorInstanceId).not.toBe(
        manifest.SupervisorInstanceId,
      );
      expect(
        adopted.Processes.find(
          (process: { Role: string }) => process.Role === "server",
        )?.Pid,
      ).toBe(1201);
    });

    it("refuses to adopt a reused PID after inspecting the original generation", async () => {
      const { result, manifestPath, manifest } = await runSupervisorScenario(
        "adoption-pid-reused",
      );

      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("__ADOPTION_PID_REUSED__1201");
      expect(result.stdout).not.toContain("已接管现有生产进程组");
      expect(result.stdout).not.toContain("__KILL_");
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
        SupervisorInstanceId: manifest.SupervisorInstanceId,
      });
    });

    it("handles healthy, stale, conflicting, and stopped initial states exactly", async () => {
      const [healthy, stale, conflict, stopped] = await Promise.all([
        runSupervisorScenario("healthy"),
        runSupervisorScenario("verified-stale"),
        runSupervisorScenario("unknown-conflict"),
        runSupervisorScenario("stopped"),
      ]);

      expect(
        healthy.result.code,
        healthy.result.stderr || healthy.result.stdout,
      ).not.toBe(0);
      expect(healthy.result.stdout).toContain("healthy");
      expect(healthy.result.stdout).not.toContain("__START_CHILD__");
      expect(healthy.result.stdout).not.toContain("__KILL_");
      expect(stale.result.code, stale.result.stderr).toBe(0);
      expect(stale.result.stdout).toContain("verified-stale");
      expect(stale.result.stdout).toContain("__KILL_VERIFIED__");
      expect(stale.result.stdout).toContain("__START_CHILD__server");
      expect(conflict.result.code).not.toBe(0);
      expect(conflict.result.stdout).toContain("unknown-conflict");
      expect(conflict.result.stdout).not.toContain("__KILL_");
      expect(conflict.result.stdout).not.toContain("__START_CHILD__");
      expect(stopped.result.code, stopped.result.stderr).toBe(0);
      expect(stopped.result.stdout).toContain("__START_CHILD__server");
      expect(stopped.result.stdout).not.toContain("__KILL_");
    });

    it("sets and verifies loopback maintenance readiness in the v2 manifest", async () => {
      const { result, manifestPath } = await runSupervisorScenario("stopped");

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("__MAINTENANCE_ENV__8023");
      expect(result.stdout).toContain(
        "__HEALTH__http://127.0.0.1:8022/api/version",
      );
      expect(result.stdout).toContain("__HEALTH__http://127.0.0.1:8023/health");
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
        Version: 2,
        Ports: { Server: 8022, Maintenance: 8023 },
      });
      expect(await readFile(serverIndex, "utf8")).toMatch(
        /startMaintenanceServer\(\{[\s\S]*?host:\s*"127\.0\.0\.1"/,
      );
    });

    it("rejects a healthy main endpoint serving the wrong build", async () => {
      const { result } = await runSupervisorScenario(
        "readiness-build-mismatch",
      );

      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("buildId build-1");
      expect(result.stdout).toContain("__KILL_VERIFIED__");
    });

    it("rolls back exact launched process objects when startup fails before a manifest exists", async () => {
      const cases = [
        {
          scenario: "partial-identity" as const,
          killed: ["__KILL_EXACT__1301"],
        },
        {
          scenario: "partial-second-start" as const,
          killed: ["__KILL_EXACT__1301"],
        },
        {
          scenario: "partial-first-manifest" as const,
          killed: [
            "__KILL_EXACT__1301",
            "__KILL_EXACT__1302",
            "__KILL_EXACT__1303",
          ],
        },
      ];

      for (const testCase of cases) {
        const { result } = await runSupervisorScenario(testCase.scenario);
        expect(
          result.code,
          `${testCase.scenario}: ${result.stderr || result.stdout}`,
        ).not.toBe(0);
        for (const marker of testCase.killed) {
          expect(result.stdout, testCase.scenario).toContain(marker);
        }
        expect(result.stdout).not.toContain("__KILL_VERIFIED__");
      }
    }, 15_000);

    it("keeps healthy external bridges unmanaged and rejects unknown occupied bridges", async () => {
      const external = await runSupervisorScenario("external-bridge");
      const conflict = await runSupervisorScenario("bridge-conflict");

      expect(external.result.code, external.result.stderr).toBe(0);
      expect(external.result.stdout).toContain(
        "__HEALTH__http://127.0.0.1:4510/status",
      );
      expect(external.result.stdout).not.toContain(
        "__START_CHILD__codex-bridge",
      );
      expect(
        JSON.parse(await readFile(external.manifestPath, "utf8")),
      ).toMatchObject({ Bridges: { Codex: "external" } });
      expect(conflict.result.code).not.toBe(0);
      expect(conflict.result.stdout).toContain("unknown-conflict");
      expect(conflict.result.stdout).not.toContain("__START_CHILD__");
      expect(conflict.result.stdout).not.toContain("__KILL_");
    });
  },
);

describe.skipIf(process.platform !== "win32")(
  "Windows production CLI state model",
  () => {
    it("reports the incident and every production state without treating degraded as stopped", async () => {
      const results = new Map<
        string,
        Awaited<ReturnType<typeof runPowerShell>>
      >();
      for (const scenario of [
        "healthy",
        "degraded-adoptable",
        "verified-stale",
        "unknown-conflict",
        "stopped",
      ] as const) {
        const fixture = await createCliFixture(scenario);
        results.set(
          scenario,
          await runPowerShell(
            `${cliProviderHarness(scenario, fixture.configPath)}
& ${psLiteral(yepScript)} status`,
            {
              YEP_LAUNCHD_LOG_DIR: fixture.stateDir,
              YEP_SERVICE_CONFIG_PATH: fixture.configPath,
            },
          ),
        );
      }

      const healthy = requireResult(results, "healthy");
      const degraded = requireResult(results, "degraded-adoptable");
      const stale = requireResult(results, "verified-stale");
      const conflict = requireResult(results, "unknown-conflict");
      const stopped = requireResult(results, "stopped");
      for (const result of results.values()) {
        expect(result.code, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).not.toContain("__UNEXPECTED_");
      }
      expect(degraded.stdout).toContain("degraded-adoptable");
      expect(degraded.stdout).toContain("监督器缺失");
      expect(degraded.stdout).toContain("Ready");
      expect(degraded.stdout).toContain("0xC000013A");
      expect(degraded.stdout).not.toContain("生产模式：已停止");
      expect(degraded.stdout).not.toMatch(/监督器.*(?:崩溃|退出|停止原因)/);
      expect(stale.stdout).toContain("verified-stale");
      expect(conflict.stdout).toContain("unknown-conflict");
      expect(stopped.stdout).toContain("生产模式：已停止");
      expect(healthy.stdout).toContain("healthy");
    }, 30_000);

    it("starts each production state with adoption, verified cleanup, or fail-closed behavior", async () => {
      const results = new Map<
        string,
        Awaited<ReturnType<typeof runPowerShell>>
      >();
      for (const scenario of [
        "healthy",
        "degraded-adoptable",
        "verified-stale",
        "unknown-conflict",
        "stopped",
      ] as const) {
        results.set(scenario, await runTransition(scenario, "start-prod"));
      }

      const healthy = requireResult(results, "healthy");
      const degraded = requireResult(results, "degraded-adoptable");
      const stale = requireResult(results, "verified-stale");
      const conflict = requireResult(results, "unknown-conflict");
      const stopped = requireResult(results, "stopped");
      expect(healthy.code, healthy.stderr || healthy.stdout).toBe(0);
      expect(healthy.stdout).not.toContain("__TASK_STARTED__");
      expect(healthy.stdout).not.toContain("__KILL__");
      expect(degraded.code, degraded.stderr || degraded.stdout).toBe(0);
      expect(degraded.stdout).toContain("__TASK_STARTED__");
      expect(degraded.stdout).toContain("__SERVER_BEFORE__1201");
      expect(degraded.stdout).toContain("__SERVER_AFTER__1201");
      expect(degraded.stdout).not.toContain("__KILL__");
      expect(stale.code, stale.stderr || stale.stdout).toBe(0);
      expect(stale.stdout).toContain("__KILL__1200");
      expect(stale.stdout).toContain("__KILL__1201");
      expect(stale.stdout).not.toContain("__KILL__1202");
      expect(stale.stdout).not.toContain("__PID_KILL__");
      expect(stale.stdout).toContain("__ISOLATED_TASK_INSTALLER__");
      expect(stale.stdout).toContain("--manual-only");
      expect(stale.stdout).toContain("__TASK_STARTED__");
      expect(conflict.code).not.toBe(0);
      expect(conflict.stdout).toContain("unknown-conflict");
      expect(conflict.stdout).not.toContain("__TASK_STARTED__");
      expect(conflict.stdout).not.toContain("__KILL__");
      expect(stopped.code, stopped.stderr || stopped.stdout).toBe(0);
      expect(stopped.stdout).toContain("__TASK_STARTED__");
      expect(stopped.stdout).not.toContain("__KILL__");
    }, 30_000);

    it("stops each production state with task-first cleanup or fail-closed behavior", async () => {
      const results = new Map<
        string,
        Awaited<ReturnType<typeof runPowerShell>>
      >();
      for (const scenario of [
        "healthy",
        "degraded-adoptable",
        "verified-stale",
        "unknown-conflict",
        "stopped",
      ] as const) {
        results.set(scenario, await runTransition(scenario, "stop-prod"));
      }

      const healthy = requireResult(results, "healthy");
      const degraded = requireResult(results, "degraded-adoptable");
      const stale = requireResult(results, "verified-stale");
      const conflict = requireResult(results, "unknown-conflict");
      const stopped = requireResult(results, "stopped");
      expect(healthy.code, healthy.stderr || healthy.stdout).toBe(0);
      expect(healthy.stdout).toContain("__TASK_STOPPED__");
      expect(healthy.stdout).toContain("__KILL__1201");
      expect(degraded.code, degraded.stderr || degraded.stdout).toBe(0);
      expect(degraded.stdout).not.toContain("__TASK_STOPPED__");
      expect(degraded.stdout).toContain("__KILL__1201");
      expect(stale.code, stale.stderr || stale.stdout).toBe(0);
      expect(stale.stdout).not.toContain("__TASK_STOPPED__");
      expect(stale.stdout).toContain("__KILL__1200");
      expect(stale.stdout).toContain("__KILL__1201");
      expect(conflict.code).not.toBe(0);
      expect(conflict.stdout).toContain("unknown-conflict");
      expect(conflict.stdout).not.toContain("__TASK_STOPPED__");
      expect(conflict.stdout).not.toContain("__KILL__");
      expect(stopped.code, stopped.stderr || stopped.stdout).toBe(0);
      expect(stopped.stdout).not.toContain("__TASK_STOPPED__");
      expect(stopped.stdout).not.toContain("__KILL__");
    }, 30_000);

    it("stops only a pre-verified legacy task and rechecks identities after it exits", async () => {
      const disappeared = await runLegacyStopScenario("supervisor-disappears");
      const reused = await runLegacyStopScenario("server-reused");
      const descendantReused = await runLegacyStopScenario("descendant-reused");
      const unknown = await runLegacyStopScenario("unknown-owner");
      const unrelated = await runLegacyStopScenario("unrelated-task");

      expect(disappeared.code, disappeared.stderr || disappeared.stdout).toBe(
        0,
      );
      expect(disappeared.stdout).toContain("__TASK_STOPPED__");
      expect(disappeared.stdout).not.toContain("__KILL__1200");
      expect(disappeared.stdout).toContain("__KILL__1201");

      expect(reused.code, reused.stderr || reused.stdout).not.toBe(0);
      expect(reused.stdout).toContain("__TASK_STOPPED__");
      expect(reused.stdout).not.toContain("__KILL__1200");
      expect(reused.stdout).not.toContain("__KILL__1201");
      expect(reused.stdout).toContain("unknown-conflict");

      expect(descendantReused.stdout).not.toContain("__KILL__1200");
      expect(descendantReused.stdout).not.toContain("__KILL__1201");
      expect(descendantReused.code).not.toBe(0);
      expect(descendantReused.stdout).toContain("unknown-conflict");

      expect(unknown.code).not.toBe(0);
      expect(unknown.stdout).toContain("__TASK_STOPPED__");
      expect(unknown.stdout).toContain("unknown-conflict");
      expect(unknown.stdout).not.toContain("__KILL__");
      expect(unknown.stdout).toContain("__DISPOSE__1201:0");

      expect(unrelated.code).not.toBe(0);
      expect(unrelated.stdout).not.toContain("__TASK_STOPPED__");
      expect(unrelated.stdout).not.toContain("__KILL__");
    }, 30_000);

    it("never sweeps a disappeared legacy PID reused before cleanup snapshot", async () => {
      const reused = await runLegacyStopScenario("disappeared-then-reused");

      expect(reused.stdout).not.toContain("__KILL__1200");
      expect(reused.stdout).not.toContain("__KILL__1201");
      expect(reused.stdout).not.toContain("__TREE_KILL__");
      expect(reused.code, reused.stderr || reused.stdout).not.toBe(0);
    });

    it("never starts by sweeping a legacy PID replacement", async () => {
      const result = await runLegacyStopScenario(
        "replacement-before-termination",
        "start-prod",
      );

      expect(result.stdout).toContain("__REPLACED_BEFORE_TERMINATION__1201");
      expect(result.stdout).not.toContain("__PID_KILL__");
      expect(result.stdout).not.toContain("__REPLACEMENT_KILLED__1201");
      expect(result.stdout).not.toContain("__TASK_STARTED__");
      expect(result.code).not.toBe(0);
    });

    it("cleans a reparented server when its refreshed supervisor exits before snapshot", async () => {
      const result = await runLegacyStopScenario(
        "supervisor-exits-before-snapshot",
      );

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).not.toContain("__KILL__1200");
      expect(result.stdout).toContain("__KILL__1201");
      expect(result.stdout).toContain("__KILL__1300");
      expect(result.stdout).toContain("__HANDLE_OPEN__1201:0");
      expect(result.stdout).toContain("__HANDLE_OPEN__1300:0");
      expect(result.stdout).toContain("__DISPOSE__1201:0");
      expect(result.stdout).toContain("__DISPOSE__1300:0");
      expect(result.stdout).not.toContain("__PID_KILL__");
      expect(result.stdout).not.toContain("__TREE_KILL__");
    });

    it("fails closed when the trusted legacy snapshot cannot be enumerated", async () => {
      const result = await runLegacyStopScenario("snapshot-failure");

      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("__KILL__");
    });

    it("rejects a descendant replacement between CIM snapshot and handle binding", async () => {
      const result = await runLegacyStopScenario(
        "descendant-replaced-before-binding",
      );

      expect(result.stdout).toContain(
        "__DESCENDANT_REPLACED_BEFORE_BINDING__1300",
      );
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("__KILL__1201");
      expect(result.stdout).not.toContain("__KILL__1300");
      expect(result.stdout).toContain("__HANDLE_OPEN__1300:30");
      expect(result.stdout).toContain("__DISPOSE__1300:30");
    });

    it("never kills a replacement created immediately before handle termination", async () => {
      const result = await runLegacyStopScenario(
        "replacement-before-termination",
      );

      expect(result.stdout).toContain("__REPLACED_BEFORE_TERMINATION__1201");
      expect(result.stdout).toContain("__HANDLE_OPEN__1201:0");
      expect(result.stdout).toContain("__HANDLE_SKIP__1201");
      expect(result.stdout).toContain("__DISPOSE__1201:0");
      expect(result.stdout).not.toContain("__PID_KILL__");
      expect(result.stdout).not.toContain("__REPLACEMENT_KILLED__1201");
      expect(result.code).not.toBe(0);
    });

    it("fails closed when CIM creation identity is absent or unparseable", async () => {
      const missing = await runLegacyStopScenario("missing-creation-date");
      const invalid = await runLegacyStopScenario("invalid-creation-date");

      for (const result of [missing, invalid]) {
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain("__KILL__");
      }
    });

    it("does not report success when a new listener appears after exact cleanup", async () => {
      const result = await runLegacyStopScenario("listener-after-kill");

      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("__KILL__1201");
      expect(result.stdout).not.toContain("__KILL__9999");
    });
  },
);

type DeploymentScenario =
  | "active-work"
  | "queued-work"
  | "malformed-active-workers"
  | "malformed-queue-length"
  | "malformed-has-active-work"
  | "build-failure"
  | "start-new-failure"
  | "verify-new-failure"
  | "maintenance-failure"
  | "exchange-first-move-failure"
  | "exchange-first-move-partial-failure"
  | "exchange-first-move-recovery-verify-failure"
  | "exchange-second-move-failure"
  | "exchange-recovery-verify-failure"
  | "rollback-start-failure"
  | "rollback-verify-failure"
  | "stop-new-failure"
  | "success"
  | "post-start-inspection-failure"
  | "task-not-running"
  | "missing-build-listener"
  | "malformed-manifest-listener"
  | "untrusted-manifest-listener"
  | "stopped-running-task"
  | "stopped-old-bundle"
  | "v2-direct-task-migration"
  | "legacy-worktree-preflight"
  | "unknown-conflict";

async function runDeploymentScenario(
  scenario: DeploymentScenario,
  {
    firstInstall = false,
    incompleteProduction = false,
  }: { firstInstall?: boolean; incompleteProduction?: boolean } = {},
) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "yep-deployment-"));
  tempDirs.push(fixtureRoot);
  const scriptsDir = path.join(fixtureRoot, "scripts");
  const distRoot = path.join(fixtureRoot, "dist");
  const productionDir = path.join(distRoot, "npm-package");
  const operationsPath = path.join(fixtureRoot, "operations.log");
  const configPath = path.join(fixtureRoot, "service-config.json");
  const legacyRepo = path.join(fixtureRoot, "legacy-main");
  const legacyBundle = path.join(legacyRepo, "dist", "npm-package");
  const legacyManifest = {
    Version: 1,
    Mode: "prod",
    RepoRoot: legacyRepo,
    BundlePath: legacyBundle,
    Processes: [
      {
        Role: "supervisor",
        Pid: 1200,
        StartTimeUtc: "2026-08-17T08:00:00Z",
      },
      {
        Role: "server",
        Pid: 1201,
        StartTimeUtc: "2026-08-17T08:00:01Z",
      },
    ],
  };
  const usesRealInspection = [
    "legacy-worktree-preflight",
    "missing-build-listener",
    "malformed-manifest-listener",
    "untrusted-manifest-listener",
  ].includes(scenario);
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(distRoot, { recursive: true });
  await copyFile(
    path.join(repoRoot, "scripts", "deploy.ps1"),
    path.join(scriptsDir, "deploy.ps1"),
  );
  if (usesRealInspection) {
    await copyFile(
      runtimeScript,
      path.join(scriptsDir, "production-runtime.ps1"),
    );
  } else {
    await writeFile(
      path.join(scriptsDir, "production-runtime.ps1"),
      `function Test-YepProperty {
  param($Value, [string]$Name)
  return ($null -ne $Value) -and ($null -ne $Value.PSObject.Properties[$Name])
}
function Test-YepInteger {
  param($Value)
  return ($Value -is [byte]) -or ($Value -is [sbyte]) -or ($Value -is [int16]) -or
    ($Value -is [uint16]) -or ($Value -is [int32]) -or ($Value -is [uint32]) -or
    ($Value -is [int64]) -or ($Value -is [uint64])
}
function Get-YepBundleBuildId {
  param([string]$BundlePath)
  return [string]((Get-Content -LiteralPath (Join-Path $BundlePath 'build-info.json') -Raw | ConvertFrom-Json).buildId)
}
function Get-YepListeningPids {
  param([int]$Port)
  if ($env:YEP_TEST_SCENARIO -eq 'missing-build-listener') { return @(9999) }
  return @()
}
function New-YepProductionExpectation {
  param($RepoRoot, $BundlePath, $BuildId, $BasePath, $Profile, $DataDir, $AllowedImagePaths,
    $ServerPort, $MaintenancePort, $CodexPort, $ClaudePort, $CodexControlUrl,
    $ClaudeControlUrl, $StartBridges, $RunScriptPath)
  return [pscustomobject]@{ BundlePath = $BundlePath; BuildId = $BuildId }
}
function Get-YepProductionInspection {
  param($ManifestPath, $Expectation)
  $state = if ($Expectation.BuildId -eq 'build-old') {
    if ($env:YEP_TEST_SCENARIO -eq 'unknown-conflict') { 'unknown-conflict' }
    elseif ($env:YEP_TEST_SCENARIO -in @('stopped-running-task', 'stopped-old-bundle')) { 'stopped' }
    else { 'healthy' }
  } elseif ($env:YEP_TEST_SCENARIO -eq 'post-start-inspection-failure') {
    'verified-stale'
  } else {
    'healthy'
  }
  return [pscustomobject]@{
    State = $state
    Manifest = [pscustomobject]@{ Version = 2 }
    VerifiedSupervisor = [pscustomobject]@{ Role = 'supervisor' }
    VerifiedProcesses = @([pscustomobject]@{ Role = 'server' })
    UnknownPortOwners = @()
    MainHealthy = ($state -eq 'healthy')
    MaintenanceHealthy = ($state -eq 'healthy')
    RunningBuildId = $Expectation.BuildId
    Reasons = @()
  }
}
`,
      "utf8",
    );
  }
  await writeFile(
    configPath,
    JSON.stringify({
      Version: 1,
      ServerPort: "8022",
      BasePath: "/",
      Profile: "default",
      DataDir: null,
      AllowedImagePaths: null,
      CodexPort: "4510",
      ClaudePort: "4520",
    }),
    "utf8",
  );
  let directMigrationBuildId = "";
  if (scenario === "v2-direct-task-migration") {
    directMigrationBuildId = (
      JSON.parse(
        await readFile(path.join(bundleDir, "build-info.json"), "utf8"),
      ) as { buildId: string }
    ).buildId;
    const fingerprint = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$expectation = New-YepProductionExpectation -RepoRoot ${psLiteral(repoRoot)} -BundlePath ${psLiteral(bundleDir)} -BuildId ${psLiteral(directMigrationBuildId)} -BasePath '/' -Profile 'default' -DataDir $null -AllowedImagePaths "$env:TEMP,$env:USERPROFILE\\Downloads" -ServerPort 8022 -MaintenancePort 8023 -CodexPort 4510 -ClaudePort 4520 -CodexControlUrl 'http://127.0.0.1:4510' -ClaudeControlUrl 'http://127.0.0.1:4520' -StartBridges $true -RunScriptPath ${psLiteral(runProdScript)}
Write-Output $expectation.ConfigFingerprint
`);
    if (fingerprint.code !== 0)
      throw new Error(fingerprint.stderr || fingerprint.stdout);
    await writeFile(
      path.join(fixtureRoot, "prod-process.json"),
      JSON.stringify({
        Version: 2,
        Mode: "prod",
        SupervisorInstanceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        Supervisor: {
          Role: "supervisor",
          Pid: 1200,
          StartTimeUtc: "2026-08-17T08:00:00Z",
          ExecutablePath:
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          CommandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript}" -ConfigPath "${configPath}"`,
        },
        BuildId: directMigrationBuildId,
        ConfigFingerprint: fingerprint.stdout.trim(),
        RepoRoot: repoRoot,
        BundlePath: bundleDir,
        Profile: "default",
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
            Pid: 1201,
            StartTimeUtc: "2026-08-17T08:00:01Z",
            ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
            CommandLine: `node.exe "${cliJs}" --port 8022`,
          },
        ],
      }),
      "utf8",
    );
  }
  if (scenario === "legacy-worktree-preflight") {
    await writeFile(
      path.join(fixtureRoot, "prod-process.json"),
      JSON.stringify(legacyManifest),
      "utf8",
    );
  } else if (scenario === "malformed-manifest-listener") {
    await writeFile(
      path.join(fixtureRoot, "prod-process.json"),
      JSON.stringify({ Version: 1, Mode: "prod", Processes: [null] }),
      "utf8",
    );
  } else if (scenario === "untrusted-manifest-listener") {
    await writeFile(
      path.join(fixtureRoot, "prod-process.json"),
      JSON.stringify({
        ...legacyManifest,
        BundlePath: path.join(fixtureRoot, "untrusted", "npm-package"),
      }),
      "utf8",
    );
  }
  if (!firstInstall) {
    await mkdir(path.join(productionDir, "dist"), { recursive: true });
    if (incompleteProduction) {
      await writeFile(
        path.join(productionDir, "incomplete.txt"),
        "old",
        "utf8",
      );
    } else {
      await writeFile(
        path.join(productionDir, "build-info.json"),
        JSON.stringify({ buildId: "build-old", gitCommit: "old" }),
        "utf8",
      );
      await writeFile(
        path.join(productionDir, "dist", "cli.js"),
        "old",
        "utf8",
      );
    }
  }

  const deployScript = path.join(scriptsDir, "deploy.ps1");
  const harness = `
$global:realGetCommand = Get-Command -CommandType Cmdlet
$global:realMoveItem = Get-Command Move-Item -CommandType Cmdlet
$global:realRemoveItem = Get-Command Remove-Item -CommandType Cmdlet
$global:newPublished = $false
$global:rollbackRestored = $false
$global:taskStopped = $false
$global:serviceRunning = ${
    (firstInstall && !usesRealInspection) ||
    incompleteProduction ||
    scenario === "stopped-old-bundle"
      ? "$false"
      : "$true"
  }
function Add-DeploymentOperation([string]$Name) {
  [IO.File]::AppendAllText($env:YEP_TEST_OPERATIONS, $Name + [Environment]::NewLine)
}
function Get-Process {
  param($Id, $ErrorAction)
  if (-not $global:serviceRunning) { return $null }
  if ($env:YEP_TEST_SCENARIO -eq 'v2-direct-task-migration') {
    if ([int]$Id -eq 1200 -and -not $global:taskStopped) {
      return [pscustomobject]@{ Id = 1200; StartTime = [DateTime]::Parse('2026-08-17T08:00:00Z') }
    }
    if ([int]$Id -eq 1201) {
      return [pscustomobject]@{ Id = 1201; StartTime = [DateTime]::Parse('2026-08-17T08:00:01Z') }
    }
    return $null
  }
  $basePid = if ($global:newPublished) { 2200 } else { 1200 }
  if ([int]$Id -notin @($basePid, ($basePid + 1))) { return $null }
  return [pscustomobject]@{ Id = [int]$Id; StartTime = [DateTime]::Parse('2026-08-17T08:00:00Z').AddSeconds([int]$Id - $basePid) }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if (-not $global:serviceRunning) { return @() }
  if ($env:YEP_TEST_SCENARIO -eq 'v2-direct-task-migration' -and -not $global:newPublished) {
    $items = @([pscustomobject]@{
      ProcessId = 1201; ParentProcessId = $(if ($global:taskStopped) { 0 } else { 1200 })
      ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
      CommandLine = 'node.exe "${cliJs.replaceAll("'", "''")}" --port 8022'
    })
    if (-not $global:taskStopped) {
      $items = @([pscustomobject]@{
        ProcessId = 1200; ParentProcessId = 0
        ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
      }) + $items
    }
  } elseif ($global:newPublished) {
    $items = @(
      [pscustomobject]@{ ProcessId = 2200; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\powershell.exe'; CommandLine = 'powershell.exe -File "${path.join(scriptsDir, "run-yepanywhere.ps1").replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"' },
      [pscustomobject]@{ ProcessId = 2201; ParentProcessId = 2200; ExecutablePath = 'C:\\node.exe'; CommandLine = 'node.exe "${path.join(productionDir, "dist", "cli.js").replaceAll("'", "''")}" --port 8022' }
    )
  } else {
    $items = @(
      [pscustomobject]@{ ProcessId = 1200; ParentProcessId = 0; ExecutablePath = 'C:\\Windows\\powershell.exe'; CommandLine = 'powershell.exe -File "${path.join(legacyRepo, "scripts", "run-yepanywhere.ps1").replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"' },
      [pscustomobject]@{ ProcessId = 1201; ParentProcessId = 1200; ExecutablePath = 'C:\\node.exe'; CommandLine = 'node.exe "${path.join(legacyBundle, "dist", "cli.js").replaceAll("'", "''")}" --port 8022' }
    )
  }
  if ($Filter -match '([0-9]+)') {
    $wanted = [int]$matches[1]
    return @($items | Where-Object { [int]$_.ProcessId -eq $wanted }) | Select-Object -First 1
  }
  return $items
}
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  if (-not $global:serviceRunning) { return @() }
  if ([int]$LocalPort -eq 8022 -or ($global:newPublished -and [int]$LocalPort -eq 8023)) {
    return [pscustomobject]@{ OwningProcess = $(if ($global:newPublished) { 2201 } else { 1201 }) }
  }
  return @()
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec, $ErrorAction)
  if ([string]$Uri -like '*/api/version') {
    $buildId = if ($global:newPublished) { 'build-new' } elseif ($env:YEP_TEST_SCENARIO -eq 'v2-direct-task-migration') { '${directMigrationBuildId}' } else { 'build-old' }
    return [pscustomobject]@{ StatusCode = 200; Content = '{"build":{"buildId":"' + $buildId + '"}}' }
  }
  if ($env:YEP_TEST_SCENARIO -eq 'v2-direct-task-migration' -and [string]$Uri -like '*/health') {
    return [pscustomobject]@{ StatusCode = 200; Content = '{}' }
  }
  if ($global:newPublished -and [string]$Uri -like '*/health') { return [pscustomobject]@{ StatusCode = 200; Content = '{}' } }
  return [pscustomobject]@{ StatusCode = 503; Content = '{}' }
}
function Get-Command {
  param($Name, $CommandType)
  if ([string]$Name -eq 'powershell.exe') { return [pscustomobject]@{ Source = 'Invoke-YepCommandMock' } }
  return & $global:realGetCommand @PSBoundParameters
}
function Move-Item {
  param($LiteralPath, $Destination)
  $sourceName = Split-Path -Leaf ([string]$LiteralPath)
  $destinationName = Split-Path -Leaf ([string]$Destination)
  if ($sourceName -eq 'npm-package' -and $destinationName -like 'npm-package-rollback-*') {
    Add-DeploymentOperation 'move-old-to-rollback'
    if ($env:YEP_TEST_SCENARIO -eq 'exchange-first-move-partial-failure') {
      & $global:realMoveItem -LiteralPath $LiteralPath -Destination $Destination
      throw 'mock production-to-rollback partial move failure'
    }
    if ($env:YEP_TEST_SCENARIO -in @('exchange-first-move-failure', 'exchange-first-move-recovery-verify-failure')) {
      throw 'mock production-to-rollback move failure'
    }
  } elseif ($sourceName -like 'npm-package-staging-*' -and $destinationName -eq 'npm-package') {
    Add-DeploymentOperation 'move-staging-to-production'
    if ($env:YEP_TEST_SCENARIO -in @('exchange-second-move-failure', 'exchange-recovery-verify-failure')) {
      throw 'mock staging-to-production move failure'
    }
    $global:newPublished = $true
  } elseif ($sourceName -eq 'npm-package' -and $destinationName -like 'npm-package-failed-*') {
    Add-DeploymentOperation 'move-new-to-failed'
  } elseif ($sourceName -like 'npm-package-rollback-*' -and $destinationName -eq 'npm-package') {
    Add-DeploymentOperation 'move-rollback-to-production'
    $global:rollbackRestored = $true
    $global:newPublished = $false
  } else {
    Add-DeploymentOperation "move-$sourceName-to-$destinationName"
  }
  & $global:realMoveItem -LiteralPath $LiteralPath -Destination $Destination
}
function Remove-Item {
  param($LiteralPath, [switch]$Recurse, [switch]$Force, $ErrorAction, $Path)
  $candidate = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
  $name = Split-Path -Leaf ([string]$candidate)
  if ($name -like 'npm-package-rollback-*') { Add-DeploymentOperation 'remove-rollback' }
  elseif ($name -like 'npm-package-staging-*') { Add-DeploymentOperation 'remove-staging' }
  $parameters = @{ LiteralPath = $candidate }
  if ($Recurse) { $parameters.Recurse = $true }
  if ($Force) { $parameters.Force = $true }
  if ($ErrorAction) { $parameters.ErrorAction = $ErrorAction }
  & $global:realRemoveItem @parameters
}
function Invoke-YepCommandMock {
  param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  $command = [string]$Arguments[-1]
  if ($command -eq 'stop-prod') {
    $operation = if ($global:newPublished) { 'stop-new' } else { 'stop-old' }
    Add-DeploymentOperation $operation
    if ($operation -eq 'stop-old' -and $env:YEP_TEST_SCENARIO -eq 'v2-direct-task-migration') {
      & ${psLiteral(yepScript)} stop-prod
      if ($LASTEXITCODE -ne 0) { return }
      $global:serviceRunning = $false
      & cmd.exe /c exit 0
      return
    }
    if ($operation -eq 'stop-new' -and $env:YEP_TEST_SCENARIO -eq 'stop-new-failure') {
      & cmd.exe /c exit 9
      return
    }
    $global:serviceRunning = $false
  } elseif ($command -eq 'start-prod') {
    $operation = if ($global:rollbackRestored -or -not $global:newPublished) { 'start-old' } else { 'start-new' }
    Add-DeploymentOperation $operation
    if (($operation -eq 'start-new' -and $env:YEP_TEST_SCENARIO -eq 'start-new-failure') -or
        ($operation -eq 'start-old' -and $env:YEP_TEST_SCENARIO -eq 'rollback-start-failure')) {
      & cmd.exe /c exit 8
      return
    }
    $global:serviceRunning = $true
    $global:taskStopped = $false
    if ($env:YEP_TEST_SCENARIO -eq 'legacy-worktree-preflight' -and $global:newPublished) {
      $newExpectation = New-YepProductionExpectation -RepoRoot $RepoRoot -BundlePath $ProductionDir -BuildId 'build-new' -BasePath $ServerBasePath -Profile $ProductionProfile -DataDir $ProductionDataDir -AllowedImagePaths $ProductionAllowedImagePaths -ServerPort ([int]$ServerPort) -MaintenancePort $MaintenancePort -CodexPort ([int]$CodexPort) -ClaudePort ([int]$ClaudePort) -CodexControlUrl $ProductionCodexControlUrl -ClaudeControlUrl $ProductionClaudeControlUrl -StartBridges ($env:YEP_START_BRIDGES -ne 'false') -RunScriptPath $RunProdScript
      $manifest = [ordered]@{
        Version = 2
        Mode = 'prod'
        SupervisorInstanceId = 'f90b66e1-52eb-4bb6-bf82-8e40d1588d68'
        Supervisor = [ordered]@{
          Role = 'supervisor'; Pid = 2200; StartTimeUtc = '2026-08-17T08:00:00.0000000Z'
          ExecutablePath = 'C:\\Windows\\powershell.exe'
          CommandLine = 'powershell.exe -File "${path.join(scriptsDir, "run-yepanywhere.ps1").replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
        }
        BuildId = 'build-new'
        ConfigFingerprint = $newExpectation.ConfigFingerprint
        RepoRoot = $newExpectation.RepoRoot
        BundlePath = $newExpectation.BundlePath
        Profile = $newExpectation.Profile
        DataDir = $newExpectation.DataDir
        BasePath = ''
        Ports = [ordered]@{ Server = 8022; Maintenance = 8023; Codex = 4510; Claude = 4520 }
        Bridges = [ordered]@{ Codex = 'disabled'; Claude = 'disabled' }
        Processes = @([ordered]@{
          Role = 'server'; Pid = 2201; StartTimeUtc = '2026-08-17T08:00:01.0000000Z'
          ExecutablePath = 'C:\\node.exe'
          CommandLine = 'node.exe "${path.join(productionDir, "dist", "cli.js").replaceAll("'", "''")}" --port 8022'
        })
      }
      [IO.File]::WriteAllText(${psLiteral(path.join(fixtureRoot, "prod-process.json"))}, ($manifest | ConvertTo-Json -Depth 10))
    }
  }
  & cmd.exe /c exit 0
}
function Invoke-RestMethod {
  param($Uri, $Method, $TimeoutSec, $ErrorAction)
  Add-DeploymentOperation 'idle-check'
  if ($env:YEP_TEST_SCENARIO -eq 'active-work') {
    return [pscustomobject]@{ activeWorkers = 1; queueLength = 0; hasActiveWork = $true }
  }
  if ($env:YEP_TEST_SCENARIO -eq 'queued-work') {
    return [pscustomobject]@{ activeWorkers = 0; queueLength = 1; hasActiveWork = $false }
  }
  if ($env:YEP_TEST_SCENARIO -eq 'malformed-active-workers') {
    return [pscustomobject]@{ activeWorkers = '0'; queueLength = 0; hasActiveWork = $false }
  }
  if ($env:YEP_TEST_SCENARIO -eq 'malformed-queue-length') {
    return [pscustomobject]@{ activeWorkers = 0; queueLength = '0'; hasActiveWork = $false }
  }
  if ($env:YEP_TEST_SCENARIO -eq 'malformed-has-active-work') {
    return [pscustomobject]@{ activeWorkers = 0; queueLength = 0; hasActiveWork = 'false' }
  }
  return [pscustomobject]@{ activeWorkers = 0; queueLength = 0; hasActiveWork = $false }
}
function Get-ScheduledTask {
  param($TaskName, $ErrorAction)
  $state = if ($global:serviceRunning -and -not ($env:YEP_TEST_SCENARIO -eq 'task-not-running' -and $global:newPublished)) { 'Running' } else { 'Ready' }
  if ($env:YEP_TEST_SCENARIO -eq 'v2-direct-task-migration' -and -not $global:newPublished) {
    return [pscustomobject]@{
      State = $(if ($global:taskStopped) { 'Ready' } else { $state })
      Principal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\\$env:USERNAME" }
      Actions = @([pscustomobject]@{
        Execute = 'Invoke-YepCommandMock'
        Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runProdScript.replaceAll("'", "''")}" -ConfigPath "${configPath.replaceAll("'", "''")}"'
        WorkingDirectory = '${repoRoot.replaceAll("'", "''")}'
      })
      Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
      Triggers = @()
    }
  }
  return [pscustomobject]@{ State = $state }
}
function Stop-ScheduledTask {
  param($TaskName, $ErrorAction)
  if ($env:YEP_TEST_SCENARIO -ne 'v2-direct-task-migration') { throw '__UNEXPECTED_TASK_STOP__' }
  $global:taskStopped = $true
}
function taskkill.exe {
  param($PidFlag, $TargetPid, $TreeFlag, $ForceFlag)
  if ($env:YEP_TEST_SCENARIO -ne 'v2-direct-task-migration' -or [int]$TargetPid -ne 1201) {
    Write-Output '__UNEXPECTED_TASKKILL__'
    & cmd.exe /c exit 1
    return
  }
  $global:serviceRunning = $false
  & cmd.exe /c exit 0
}
function node {
  $Arguments = @($args)
  if ($Arguments[0] -eq '-p') { Write-Output '0.4.29'; & cmd.exe /c exit 0; return }
  $buildInfoIndex = [Array]::IndexOf([object[]]$Arguments, '--build-info')
  $expected = Get-Content -LiteralPath $Arguments[$buildInfoIndex + 1] -Raw | ConvertFrom-Json
  $isNew = [string]$expected.buildId -eq 'build-new'
  if ($isNew) {
    $hasMaintenance = [Array]::IndexOf([object[]]$Arguments, '--maintenance-url') -ge 0
    if (-not $hasMaintenance -or $env:YEP_TEST_SCENARIO -in @('verify-new-failure', 'maintenance-failure', 'rollback-start-failure', 'rollback-verify-failure', 'stop-new-failure')) {
      Add-DeploymentOperation 'verify-new-failed'
      Write-Error 'new deployment smoke failed'
      & cmd.exe /c exit 7
      return
    }
    Add-DeploymentOperation 'verify-new'
  } else {
    Add-DeploymentOperation 'verify-old'
    if ($env:YEP_TEST_SCENARIO -in @('rollback-verify-failure', 'exchange-recovery-verify-failure', 'exchange-first-move-recovery-verify-failure')) {
      Write-Error 'rollback verification failed'
      & cmd.exe /c exit 6
      return
    }
  }
  & cmd.exe /c exit 0
}
function pnpm {
  param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  if ($Arguments -contains 'build:bundle') {
    [IO.Directory]::CreateDirectory((Join-Path $env:YEP_BUNDLE_OUTPUT_DIR 'dist')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $env:YEP_BUNDLE_OUTPUT_DIR 'dist/cli.js'), 'new')
    [IO.File]::WriteAllText((Join-Path $env:YEP_BUNDLE_OUTPUT_DIR 'build-info.json'), '{"buildId":"build-new","gitCommit":"new"}')
    if ($env:YEP_TEST_SCENARIO -eq 'build-failure') { & cmd.exe /c exit 7; return }
  }
  & cmd.exe /c exit 0
}
function npm { & cmd.exe /c exit 0 }
& ${psLiteral(deployScript)} --server-only --skip-checks
`;
  const result = await runPowerShell(harness, {
    YEP_LAUNCHD_LOG_DIR: fixtureRoot,
    YEP_SERVICE_CONFIG_PATH: configPath,
    YEP_TEST_OPERATIONS: operationsPath,
    YEP_TEST_SCENARIO: scenario,
  });
  const operations = await readFile(operationsPath, "utf8")
    .then((value) => value.trim().split(/\r?\n/).filter(Boolean))
    .catch(() => [] as string[]);
  const entries = await readdir(distRoot);
  const productionBuild = await readFile(
    path.join(productionDir, "build-info.json"),
    "utf8",
  )
    .then((value) => JSON.parse(value).buildId as string)
    .catch(() => null);
  return { result, operations, entries, productionBuild };
}

describe.skipIf(process.platform !== "win32")(
  "Windows transactional production deployment",
  () => {
    it.each([
      ["active-work", "hasActiveWork=True"],
      ["queued-work", "queueLength=1"],
    ] as const)(
      "refuses %s before stopping or mutating production directories",
      async (scenario, message) => {
        const deployment = await runDeploymentScenario(scenario);

        expect(deployment.result.code).not.toBe(0);
        expect(deployment.result.stdout).toContain(message);
        expect(deployment.operations).toEqual(["idle-check", "remove-staging"]);
        expect(deployment.productionBuild).toBe("build-old");
      },
    );

    it.each([
      "malformed-active-workers",
      "malformed-queue-length",
      "malformed-has-active-work",
    ] as const)(
      "refuses %s before stopping or mutating production directories",
      async (scenario) => {
        const deployment = await runDeploymentScenario(scenario);

        expect(deployment.result.code).not.toBe(0);
        expect(deployment.result.stdout).toContain("/api/status/workers");
        expect(deployment.operations).toEqual(["idle-check", "remove-staging"]);
        expect(deployment.productionBuild).toBe("build-old");
      },
    );

    it("leaves current production and its service untouched when staging fails", async () => {
      const deployment = await runDeploymentScenario("build-failure");

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.operations).not.toContain("stop-old");
      expect(
        deployment.operations.every(
          (operation) => !operation.startsWith("move-"),
        ),
      ).toBe(true);
      expect(deployment.productionBuild).toBe("build-old");
    });

    it.each(["stopped-running-task", "stopped-old-bundle"] as const)(
      "stops %s before exchanging its existing production directory",
      async (scenario) => {
        const deployment = await runDeploymentScenario(scenario);

        expect(deployment.result.code).toBe(0);
        expect(deployment.operations).toEqual([
          "stop-old",
          "move-old-to-rollback",
          "move-staging-to-production",
          "start-new",
          "verify-new",
          "remove-rollback",
        ]);
      },
    );

    it("restores and verifies the old bundle when the new service fails to start", async () => {
      const deployment = await runDeploymentScenario("start-new-failure");

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.operations).toEqual([
        "idle-check",
        "stop-old",
        "move-old-to-rollback",
        "move-staging-to-production",
        "start-new",
        "stop-new",
        "move-new-to-failed",
        "move-rollback-to-production",
        "start-old",
        "verify-old",
      ]);
      expect(deployment.productionBuild).toBe("build-old");
    });

    it.each([
      [
        "exchange-first-move-failure",
        [
          "idle-check",
          "stop-old",
          "move-old-to-rollback",
          "start-old",
          "verify-old",
          "remove-staging",
        ],
      ],
      [
        "exchange-first-move-partial-failure",
        [
          "idle-check",
          "stop-old",
          "move-old-to-rollback",
          "move-rollback-to-production",
          "start-old",
          "verify-old",
          "remove-staging",
        ],
      ],
    ] as const)(
      "recovers the valid old service after %s",
      async (scenario, expectedOperations) => {
        const deployment = await runDeploymentScenario(scenario);

        expect(deployment.result.code).not.toBe(0);
        expect(deployment.operations).toEqual(expectedOperations);
        expect(deployment.operations).not.toContain("remove-rollback");
        expect(deployment.productionBuild).toBe("build-old");
      },
    );

    it("reports both first-move and old-service recovery failures", async () => {
      const deployment = await runDeploymentScenario(
        "exchange-first-move-recovery-verify-failure",
      );

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.result.stdout).toContain(
        "mock production-to-rollback move failure",
      );
      expect(deployment.result.stdout).toContain(
        "rollback verification failed",
      );
      expect(deployment.operations).toEqual([
        "idle-check",
        "stop-old",
        "move-old-to-rollback",
        "start-old",
        "verify-old",
        "remove-staging",
      ]);
      expect(deployment.productionBuild).toBe("build-old");
    });

    it("restores, restarts, and verifies the old bundle when exchange fails after stop", async () => {
      const deployment = await runDeploymentScenario(
        "exchange-second-move-failure",
      );

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.operations).toEqual([
        "idle-check",
        "stop-old",
        "move-old-to-rollback",
        "move-staging-to-production",
        "move-rollback-to-production",
        "start-old",
        "verify-old",
        "remove-staging",
      ]);
      expect(deployment.productionBuild).toBe("build-old");
    });

    it("reports both exchange and old-service recovery failures", async () => {
      const deployment = await runDeploymentScenario(
        "exchange-recovery-verify-failure",
      );

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.result.stdout).toContain(
        "mock staging-to-production move failure",
      );
      expect(deployment.result.stdout).toContain(
        "rollback verification failed",
      );
      expect(deployment.operations).toEqual([
        "idle-check",
        "stop-old",
        "move-old-to-rollback",
        "move-staging-to-production",
        "move-rollback-to-production",
        "start-old",
        "verify-old",
        "remove-staging",
      ]);
      expect(deployment.productionBuild).toBe("build-old");
    });

    it("restores but does not restart an invalid old bundle after exchange fails", async () => {
      const deployment = await runDeploymentScenario(
        "exchange-second-move-failure",
        { incompleteProduction: true },
      );

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.operations).toEqual([
        "stop-old",
        "move-old-to-rollback",
        "move-staging-to-production",
        "move-rollback-to-production",
        "remove-staging",
      ]);
      expect(deployment.operations).not.toContain("start-old");
      expect(deployment.operations).not.toContain("verify-old");
      expect(deployment.productionBuild).toBeNull();
    });

    it.each(["verify-new-failure", "maintenance-failure"] as const)(
      "rolls back after %s in the required order",
      async (scenario) => {
        const deployment = await runDeploymentScenario(scenario);

        expect(deployment.result.code).not.toBe(0);
        expect(deployment.operations).toEqual([
          "idle-check",
          "stop-old",
          "move-old-to-rollback",
          "move-staging-to-production",
          "start-new",
          "verify-new-failed",
          "stop-new",
          "move-new-to-failed",
          "move-rollback-to-production",
          "start-old",
          "verify-old",
        ]);
        expect(deployment.operations).not.toContain("remove-rollback");
        expect(deployment.productionBuild).toBe("build-old");
      },
    );

    it.each(["post-start-inspection-failure", "task-not-running"] as const)(
      "rolls back before smoke verification when %s occurs",
      async (scenario) => {
        const deployment = await runDeploymentScenario(scenario);

        expect(deployment.result.code).not.toBe(0);
        expect(deployment.operations).toEqual([
          "idle-check",
          "stop-old",
          "move-old-to-rollback",
          "move-staging-to-production",
          "start-new",
          "stop-new",
          "move-new-to-failed",
          "move-rollback-to-production",
          "start-old",
          "verify-old",
        ]);
      },
    );

    it.each(["rollback-start-failure", "rollback-verify-failure"] as const)(
      "preserves old, failed-new, manifests, and logs when %s occurs",
      async (scenario) => {
        const deployment = await runDeploymentScenario(scenario);

        expect(deployment.result.code).not.toBe(0);
        expect(deployment.result.stdout).toContain("原始部署错误");
        expect(deployment.result.stdout).toContain("回滚错误");
        expect(deployment.operations).not.toContain("remove-rollback");
        expect(deployment.productionBuild).toBe("build-old");
        expect(
          deployment.entries.some((entry) =>
            entry.startsWith("npm-package-failed-"),
          ),
        ).toBe(true);
      },
    );

    it("does not move either bundle if stopping the failed new group fails", async () => {
      const deployment = await runDeploymentScenario("stop-new-failure");
      const stopIndex = deployment.operations.indexOf("stop-new");

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.operations.slice(stopIndex + 1)).toEqual([]);
      expect(deployment.productionBuild).toBe("build-new");
      expect(
        deployment.entries.some((entry) =>
          entry.startsWith("npm-package-rollback-"),
        ),
      ).toBe(true);
    });

    it("deletes the rollback bundle only after every new-build check passes", async () => {
      const deployment = await runDeploymentScenario("success");

      expect(
        deployment.result.code,
        deployment.result.stderr || deployment.result.stdout,
      ).toBe(0);
      expect(deployment.operations).toEqual([
        "idle-check",
        "stop-old",
        "move-old-to-rollback",
        "move-staging-to-production",
        "start-new",
        "verify-new",
        "remove-rollback",
      ]);
      expect(deployment.productionBuild).toBe("build-new");
    });

    it("rebuild stop-old migrates a verified v2 direct task through the real CLI", async () => {
      const deployment = await runDeploymentScenario(
        "v2-direct-task-migration",
      );

      expect(
        deployment.result.code,
        deployment.result.stderr || deployment.result.stdout,
      ).toBe(0);
      expect(deployment.result.stdout).toContain("正在停止生产计划任务实例");
      expect(deployment.operations).toEqual([
        "idle-check",
        "stop-old",
        "move-old-to-rollback",
        "move-staging-to-production",
        "start-new",
        "verify-new",
        "remove-rollback",
      ]);
      expect(deployment.productionBuild).toBe("build-new");
    });

    it("preserves the failed new bundle and stays stopped on a failed first install", async () => {
      const deployment = await runDeploymentScenario("verify-new-failure", {
        firstInstall: true,
      });

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.operations).toEqual([
        "move-staging-to-production",
        "start-new",
        "verify-new-failed",
        "stop-new",
        "move-new-to-failed",
      ]);
      expect(deployment.result.stdout).toContain("没有可回滚的旧 Bundle");
      expect(deployment.productionBuild).toBeNull();
      expect(
        deployment.entries.some((entry) =>
          entry.startsWith("npm-package-failed-"),
        ),
      ).toBe(true);
    });

    it("preserves but does not restart an incomplete previous production directory", async () => {
      const deployment = await runDeploymentScenario("verify-new-failure", {
        incompleteProduction: true,
      });

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.operations).toEqual([
        "stop-old",
        "move-old-to-rollback",
        "move-staging-to-production",
        "start-new",
        "verify-new-failed",
        "stop-new",
        "move-new-to-failed",
      ]);
      expect(deployment.result.stdout).toContain("没有可回滚的旧 Bundle");
      expect(deployment.productionBuild).toBeNull();
      expect(
        deployment.entries.some((entry) =>
          entry.startsWith("npm-package-rollback-"),
        ),
      ).toBe(true);
    });

    it("fails closed on unknown-conflict before the idle check or production mutation", async () => {
      const deployment = await runDeploymentScenario("unknown-conflict");

      expect(deployment.result.code).not.toBe(0);
      expect(deployment.result.stdout).toContain("unknown-conflict");
      expect(deployment.operations).toEqual(["remove-staging"]);
      expect(
        deployment.entries.some((entry) =>
          entry.startsWith("npm-package-staging-"),
        ),
      ).toBe(false);
      expect(deployment.productionBuild).toBe("build-old");
    });

    it("migrates a verified legacy service when the target worktree has no bundle", async () => {
      const deployment = await runDeploymentScenario(
        "legacy-worktree-preflight",
        { firstInstall: true },
      );

      expect(
        deployment.result.code,
        deployment.result.stderr || deployment.result.stdout,
      ).toBe(0);
      expect(deployment.operations).toEqual([
        "idle-check",
        "stop-old",
        "move-staging-to-production",
        "start-new",
        "verify-new",
      ]);
      expect(deployment.productionBuild).toBe("build-new");
    });

    it.each([
      "missing-build-listener",
      "malformed-manifest-listener",
      "untrusted-manifest-listener",
    ] as const)(
      "keeps %s fail-closed when the target worktree has no bundle",
      async (scenario) => {
        const deployment = await runDeploymentScenario(scenario, {
          firstInstall: true,
        });

        expect(deployment.result.code).not.toBe(0);
        expect(deployment.result.stdout).toContain("unknown-conflict");
        expect(deployment.operations).toEqual(["remove-staging"]);
        expect(deployment.operations).not.toContain("stop-old");
        expect(
          deployment.operations.some((operation) =>
            operation.startsWith("move-"),
          ),
        ).toBe(false);
        expect(deployment.productionBuild).toBeNull();
      },
    );
  },
);

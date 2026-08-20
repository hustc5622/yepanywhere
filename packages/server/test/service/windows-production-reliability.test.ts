import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const runtimeScript = path.join(repoRoot, "scripts", "production-runtime.ps1");
const yepScript = path.join(repoRoot, "scripts", "yep.ps1");
const runProdScript = path.join(repoRoot, "scripts", "run-yepanywhere.ps1");
const watchdogScript = path.join(repoRoot, "scripts", "watch-yepanywhere.ps1");
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

function requireResult<T>(results: Map<string, T>, scenario: string) {
  const result = results.get(scenario);
  if (!result) throw new Error(`Missing result for ${scenario}`);
  return result;
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
  },
);

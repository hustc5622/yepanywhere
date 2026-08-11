# Yep Anywhere Windows 服务进程管理入口（兼容 Windows PowerShell 5.1）。

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = [string](Resolve-Path (Join-Path $ScriptDir ".."))
$ThisScript = Join-Path $ScriptDir "yep.ps1"
$RunProdScript = Join-Path $ScriptDir "run-yepanywhere.ps1"
$InstallTaskScript = Join-Path $ScriptDir "install-task-scheduler.ps1"
$DisableTaskScript = Join-Path $ScriptDir "uninstall-task-scheduler.ps1"
$DeployScript = Join-Path $ScriptDir "deploy.ps1"
$PowerShellExe = (Get-Command powershell.exe).Source
. (Join-Path $ScriptDir "service-config.ps1")
$ServiceConfigPath = if ($env:YEP_SERVICE_CONFIG_PATH) {
  $env:YEP_SERVICE_CONFIG_PATH
} else {
  Join-Path $env:USERPROFILE ".yep-anywhere/service-config.json"
}
$CurrentUserId = "$env:USERDOMAIN\$env:USERNAME"
$CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ExpectedTaskArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunProdScript`" -ConfigPath `"$ServiceConfigPath`""

$ServiceConfig = $null
$ServiceConfigError = $null
function Update-ServiceConfigState {
  $script:ServiceConfig = $null
  $script:ServiceConfigError = $null
  if (Test-Path $ServiceConfigPath) {
    try {
      $script:ServiceConfig = Get-Content -LiteralPath $ServiceConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not (Test-ServiceConfigSchema $script:ServiceConfig)) {
        $script:ServiceConfigError = "字段、版本、类型或端口无效"
      }
    } catch {
      $script:ServiceConfigError = "无法解析：$_"
    }
  } else {
    $script:ServiceConfigError = "文件不存在"
  }
}
Update-ServiceConfigState

function Test-ServiceConfigReady { return $null -eq $ServiceConfigError }
$HasProductionConfigOverrides = [bool]($env:YEP_DEPLOY_PORT -or $env:YEP_DEPLOY_BASE_PATH -or
  $env:YEP_ANYWHERE_PROFILE -or $env:YEP_ANYWHERE_DATA_DIR -or $env:ALLOWED_IMAGE_PATHS -or
  $env:YEP_CODEX_BRIDGE_PORT -or $env:YEP_CLAUDE_BRIDGE_PORT)

$DevMainPort = if ($env:YEP_DEV_PORT) { $env:YEP_DEV_PORT } else { "3400" }
$DevMaintPort = if ($env:YEP_DEV_MAINT_PORT) { $env:YEP_DEV_MAINT_PORT } else { "3401" }
$DevVitePort = if ($env:YEP_DEV_VITE_PORT) { $env:YEP_DEV_VITE_PORT } else { "3402" }
$ServerPort = if ($env:YEP_DEPLOY_PORT) {
  $env:YEP_DEPLOY_PORT
} elseif ($ServiceConfig -and $ServiceConfig.ServerPort) {
  [string]$ServiceConfig.ServerPort
} else {
  "8022"
}
$CodexPort = if ($env:YEP_CODEX_BRIDGE_PORT) { $env:YEP_CODEX_BRIDGE_PORT } else { "4510" }
$ClaudePort = if ($env:YEP_CLAUDE_BRIDGE_PORT) { $env:YEP_CLAUDE_BRIDGE_PORT } else { "4520" }

$TaskName = "YepAnywhereServer"
$LogDir = if ($env:YEP_LAUNCHD_LOG_DIR) {
  $env:YEP_LAUNCHD_LOG_DIR
} elseif ($env:YEP_ANYWHERE_DATA_DIR) {
  Join-Path $env:YEP_ANYWHERE_DATA_DIR "logs"
} else {
  Join-Path $env:USERPROFILE ".yep-anywhere/logs"
}
$ProdLogDir = if ($env:YEP_LAUNCHD_LOG_DIR) {
  $env:YEP_LAUNCHD_LOG_DIR
} elseif ($env:YEP_ANYWHERE_DATA_DIR) {
  Join-Path $env:YEP_ANYWHERE_DATA_DIR "logs"
} elseif ($ServiceConfig -and $ServiceConfig.DataDir) {
  Join-Path ([string]$ServiceConfig.DataDir) "logs"
} else {
  Join-Path $env:USERPROFILE ".yep-anywhere/logs"
}
$DevStateFile = Join-Path $LogDir "dev-process.json"
$ProdStateFile = Join-Path $ProdLogDir "prod-process.json"
$CliJs = Join-Path $RepoRoot "dist/npm-package/dist/cli.js"

function Write-Info($message) { Write-Host "==> $message" -ForegroundColor Green }
function Write-WarningMessage($message) { Write-Host "警告：$message" -ForegroundColor Yellow }
function Write-ErrorMessage($message) { Write-Host "错误：$message" -ForegroundColor Red }
function Write-Detail($message) { Write-Host "    $message" -ForegroundColor DarkGray }

function Ensure-LogDir {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

function Get-ListeningPids($port) {
  $pids = @()
  $lines = netstat -ano -p TCP 2>$null
  foreach ($line in $lines) {
    if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      if ($matches[1] -eq [string]$port) {
        $pids += [int]$matches[2]
      }
    }
  }
  return @($pids | Sort-Object -Unique)
}

function Get-StateFile($mode) {
  if ($mode -eq "dev") { return $DevStateFile }
  return $ProdStateFile
}

function Read-ProcessState($mode) {
  $stateFile = Get-StateFile $mode
  if (-not (Test-Path $stateFile)) { return $null }
  try {
    return Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-WarningMessage "进程元数据损坏：$stateFile"
    return $null
  }
}

function Write-ProcessState($mode, $state) {
  Ensure-LogDir
  $stateFile = Get-StateFile $mode
  $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

function Remove-ProcessState($mode) {
  $stateFile = Get-StateFile $mode
  if (Test-Path $stateFile) {
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
  }
}

function Get-ProcessCommand($processId) {
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-ProcessDescendsFrom($processId, $ancestorId) {
  $current = [int]$processId
  for ($depth = 0; $depth -lt 32 -and $current -gt 0; $depth++) {
    if ($current -eq [int]$ancestorId) { return $true }
    $processInfo = Get-ProcessCommand $current
    if (-not $processInfo -or -not $processInfo.ParentProcessId) { return $false }
    $current = [int]$processInfo.ParentProcessId
  }
  return $false
}

function Test-PortOwnerMatchesEntries($processId, $entries) {
  foreach ($entry in @($entries)) {
    if ([int]$entry.Pid -eq [int]$processId -or (Test-ProcessDescendsFrom $processId ([int]$entry.Pid))) {
      return $true
    }
  }
  return $false
}

function Test-ContainsIgnoreCase($value, $expected) {
  if (-not $value -or -not $expected) { return $false }
  return $value.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-ProcessIdentity($entry, $mode) {
  if (-not $entry -or -not $entry.Pid) { return $false }
  $process = Get-Process -Id ([int]$entry.Pid) -ErrorAction SilentlyContinue
  if (-not $process) { return $false }

  if ($entry.StartTimeUtc) {
    try {
      $expectedStart = [DateTime]::Parse([string]$entry.StartTimeUtc).ToUniversalTime()
      $actualStart = $process.StartTime.ToUniversalTime()
      if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 1) {
        return $false
      }
    } catch {
      return $false
    }
  }

  $processInfo = Get-ProcessCommand ([int]$entry.Pid)
  if (-not $processInfo -or -not $processInfo.CommandLine) { return $false }
  $commandLine = [string]$processInfo.CommandLine

  if ($mode -eq "dev") {
    return (Test-ContainsIgnoreCase $commandLine $ThisScript) -and
      (Test-ContainsIgnoreCase $commandLine "__run-dev")
  }

  switch ([string]$entry.Role) {
    "supervisor" { return Test-ContainsIgnoreCase $commandLine $RunProdScript }
    "server" {
      return (Test-ContainsIgnoreCase $commandLine $CliJs) -and
        (Test-ContainsIgnoreCase $commandLine "--port")
    }
    "codex-bridge" {
      return (Test-ContainsIgnoreCase $commandLine $CliJs) -and
        (Test-ContainsIgnoreCase $commandLine "--codex-bridge-only")
    }
    "claude-bridge" {
      return (Test-ContainsIgnoreCase $commandLine $CliJs) -and
        (Test-ContainsIgnoreCase $commandLine "--claude-bridge-only")
    }
    default { return $false }
  }
}

function Get-VerifiedEntries($mode) {
  $state = Read-ProcessState $mode
  if (-not $state) { return @() }
  $verified = @()
  foreach ($entry in @($state.Processes)) {
    if (Test-ProcessIdentity $entry $mode) { $verified += $entry }
  }
  return @($verified)
}

function Show-UnknownPortOwner($port, $processId) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $name = if ($process) { $process.ProcessName } else { "未知进程" }
  Write-ErrorMessage "端口 $port 由 PID $processId（$name）占用，但无法确认属于 Yep Anywhere；拒绝停止该进程。"
  Write-Detail "请人工核实进程身份，或释放该端口后重试。"
}

function Wait-PortReleased($port, $tries = 40) {
  for ($index = 0; $index -lt $tries; $index++) {
    if ((Get-ListeningPids $port).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Test-HealthEndpoint($url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 -ErrorAction Stop
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-Health($url, $tries = 60) {
  for ($index = 0; $index -lt $tries; $index++) {
    if (Test-HealthEndpoint $url) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Test-PortsOwnedByEntries($ports, $entries) {
  if (@($entries).Count -eq 0) { return $false }
  foreach ($port in $ports) {
    $portPids = @(Get-ListeningPids $port)
    if ($portPids.Count -eq 0) { return $false }
    foreach ($processId in $portPids) {
      if (-not (Test-PortOwnerMatchesEntries $processId $entries)) { return $false }
    }
  }
  return $true
}

function Test-DevInstanceReady($entries) {
  return (Test-HealthEndpoint "http://127.0.0.1:$DevMainPort/api/version") -and
    (Test-PortsOwnedByEntries @($DevMainPort, $DevMaintPort, $DevVitePort) $entries)
}

function Get-ManagedProcessSnapshot($entries) {
  if (@($entries).Count -eq 0) {
    return [pscustomobject]@{ Complete = $true; Processes = @() }
  }
  $candidatePids = @($entries | ForEach-Object { [int]$_.Pid })
  try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    foreach ($entry in @($entries)) {
      if (@($processes | Where-Object { [int]$_.ProcessId -eq [int]$entry.Pid }).Count -eq 0) {
        return [pscustomobject]@{ Complete = $false; Processes = @() }
      }
    }
    foreach ($processInfo in $processes) {
      foreach ($entry in @($entries)) {
        $currentId = [int]$processInfo.ProcessId
        $descendsFromEntry = $false
        for ($depth = 0; $depth -lt 32 -and $currentId -gt 0; $depth++) {
          if ($currentId -eq [int]$entry.Pid) {
            $descendsFromEntry = $true
            break
          }
          $currentInfo = @($processes | Where-Object { [int]$_.ProcessId -eq $currentId }) | Select-Object -First 1
          if (-not $currentInfo -or -not $currentInfo.ParentProcessId) { break }
          $currentId = [int]$currentInfo.ParentProcessId
        }
        if ($descendsFromEntry) {
          $candidatePids += [int]$processInfo.ProcessId
          break
        }
      }
    }
  } catch {
    return [pscustomobject]@{ Complete = $false; Processes = @() }
  }

  $snapshot = @()
  foreach ($processId in @($candidatePids | Sort-Object -Unique)) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
      $snapshot += [pscustomobject]@{
        Pid = [int]$processId
        StartTimeUtc = $process.StartTime.ToUniversalTime().ToString("o")
      }
    }
  }
  return [pscustomobject]@{ Complete = $true; Processes = @($snapshot) }
}

function Get-RemainingManagedPids($snapshot) {
  if (@($snapshot).Count -eq 0) { return @() }
  $remaining = @()
  foreach ($entry in @($snapshot)) {
    $process = Get-Process -Id ([int]$entry.Pid) -ErrorAction SilentlyContinue
    if ($process) {
      try {
        $expectedStart = [DateTime]::Parse([string]$entry.StartTimeUtc).ToUniversalTime()
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -le 1) {
          $remaining += [int]$entry.Pid
        }
      } catch {
        $remaining += [int]$entry.Pid
      }
    }
  }
  return @($remaining | Sort-Object -Unique)
}

function Get-RootManagedEntries($entries) {
  $roots = @()
  foreach ($candidate in @($entries)) {
    $isDescendant = $false
    foreach ($other in @($entries)) {
      if ([int]$candidate.Pid -ne [int]$other.Pid -and
          (Test-ProcessDescendsFrom ([int]$candidate.Pid) ([int]$other.Pid))) {
        $isDescendant = $true
        break
      }
    }
    if (-not $isDescendant) { $roots += $candidate }
  }
  return @($roots)
}

function Stop-VerifiedMode($mode, $ports, $knownEntries = $null, $knownSnapshot = $null) {
  if ($null -eq $knownEntries) {
    $verified = @(Get-VerifiedEntries $mode)
  } else {
    $verified = @($knownEntries)
  }
  $killTargets = Get-RootManagedEntries $verified
  $snapshotResult = if ($null -eq $knownSnapshot) { Get-ManagedProcessSnapshot $verified } else { $knownSnapshot }
  if (-not $snapshotResult.Complete) {
    Write-ErrorMessage "无法枚举完整的 $mode 进程树；为避免遗漏残留进程，未执行停止。"
    return $false
  }
  $processSnapshot = @($snapshotResult.Processes)
  $killFailed = $false
  foreach ($entry in $killTargets) {
    $killOutput = @(& taskkill.exe /PID ([int]$entry.Pid) /T /F 2>&1)
    $killExitCode = $LASTEXITCODE
    if ($killExitCode -eq 0) {
      Write-Detail "已停止 $mode 进程 PID $($entry.Pid)（$($entry.Role)）。"
    } elseif (Get-Process -Id ([int]$entry.Pid) -ErrorAction SilentlyContinue) {
      $killFailed = $true
      Write-WarningMessage "停止 PID $($entry.Pid) 失败（taskkill 退出码 $killExitCode）：$($killOutput -join ' ')"
    } else {
      Write-Detail "进程 PID $($entry.Pid) 已在停止期间退出。"
    }
  }

  $remaining = @()
  for ($attempt = 0; $attempt -lt 8; $attempt++) {
    $remaining = @(Get-RemainingManagedPids $processSnapshot)
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($remaining.Count -gt 0) {
    Write-ErrorMessage "停止后仍在运行的 $mode 进程树 PID：$($remaining -join ',')。"
  }

  if ($verified.Count -gt 0) {
    foreach ($port in $ports) { Wait-PortReleased $port 8 | Out-Null }
  }
  $unknown = $false
  foreach ($port in $ports) {
    foreach ($processId in @(Get-ListeningPids $port)) {
      Show-UnknownPortOwner $port $processId
      $unknown = $true
    }
  }

  $success = -not $killFailed -and $remaining.Count -eq 0 -and -not $unknown
  if ($success) { Remove-ProcessState $mode }
  return $success
}

function Test-PortsAvailableForMode($mode, $ports) {
  $verified = @(Get-VerifiedEntries $mode)
  $safe = $true
  foreach ($port in $ports) {
    foreach ($processId in @(Get-ListeningPids $port)) {
      if (-not (Test-PortOwnerMatchesEntries $processId $verified)) {
        Show-UnknownPortOwner $port $processId
        $safe = $false
      }
    }
  }
  return $safe
}

function Get-Task {
  return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function ConvertTo-NormalizedTaskPath($value) {
  if ([string]::IsNullOrWhiteSpace([string]$value)) { return $null }
  try {
    return [IO.Path]::GetFullPath([string]$value).TrimEnd([char[]]@('\', '/'))
  } catch {
    return $null
  }
}

function Test-TaskPathEquals($actual, $expected) {
  $normalizedActual = ConvertTo-NormalizedTaskPath $actual
  $normalizedExpected = ConvertTo-NormalizedTaskPath $expected
  return $null -ne $normalizedActual -and $null -ne $normalizedExpected -and
    [string]::Equals($normalizedActual, $normalizedExpected, [StringComparison]::OrdinalIgnoreCase)
}

function Test-TaskAction($task) {
  if (-not $task) { return $false }
  $actions = @($task.Actions)
  if ($actions.Count -ne 1) { return $false }
  $action = $actions[0]
  return (Test-TaskPathEquals $action.Execute $PowerShellExe) -and
    [string]::Equals([string]$action.Arguments, $ExpectedTaskArguments, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-TaskPathEquals $action.WorkingDirectory $RepoRoot)
}

function ConvertTo-TaskTimeSpan($value) {
  if ($value -is [TimeSpan]) { return $value }
  if ([string]::IsNullOrWhiteSpace([string]$value)) { return $null }
  try {
    return [System.Xml.XmlConvert]::ToTimeSpan([string]$value)
  } catch {
    try {
      return [TimeSpan]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture)
    } catch {
      return $null
    }
  }
}

function Test-TaskSettings($task) {
  if (-not $task -or -not $task.Settings) { return $false }
  $restartCount = 0
  if (-not [int]::TryParse([string]$task.Settings.RestartCount, [ref]$restartCount)) { return $false }
  $restartInterval = ConvertTo-TaskTimeSpan $task.Settings.RestartInterval
  $executionTimeLimit = ConvertTo-TaskTimeSpan $task.Settings.ExecutionTimeLimit
  return [string]::Equals([string]$task.Settings.MultipleInstances, "IgnoreNew", [StringComparison]::OrdinalIgnoreCase) -and
    $restartCount -eq 999 -and
    $null -ne $restartInterval -and $restartInterval -eq [TimeSpan]::FromMinutes(1) -and
    $null -ne $executionTimeLimit -and $executionTimeLimit -eq [TimeSpan]::Zero
}

function Test-CurrentTaskUser($userId) {
  if ([string]::IsNullOrWhiteSpace([string]$userId)) { return $false }
  try {
    $account = New-Object Security.Principal.NTAccount([string]$userId)
    $sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
    return [string]::Equals($sid, $CurrentUserSid, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Test-TaskPrincipal($task) {
  return $task -and $task.Principal -and (Test-CurrentTaskUser $task.Principal.UserId)
}

function Test-TaskHasAnyEnabledLogonTrigger($task) {
  if (-not $task) { return $false }
  foreach ($trigger in @($task.Triggers | Where-Object { $null -ne $_ })) {
    $className = if ($trigger.CimClass) { [string]$trigger.CimClass.CimClassName } else { "" }
    if ((Test-ContainsIgnoreCase $className "LogonTrigger") -and $trigger.Enabled -ne $false) {
      return $true
    }
  }
  return $false
}

function Test-TaskDefinition($task) {
  if (-not (Test-TaskAction $task) -or
      -not (Test-TaskPrincipal $task) -or
      -not (Test-TaskSettings $task)) { return $false }
  $logonTriggerCount = 0
  foreach ($trigger in @($task.Triggers | Where-Object { $null -ne $_ })) {
    $className = if ($trigger.CimClass) { [string]$trigger.CimClass.CimClassName } else { "" }
    if (-not (Test-ContainsIgnoreCase $className "LogonTrigger") -or
        $trigger.Enabled -eq $false -or
        -not (Test-CurrentTaskUser $trigger.UserId)) {
      return $false
    }
    $logonTriggerCount++
  }
  return $logonTriggerCount -le 1
}

function Get-AutostartState($task) {
  if (-not $task) { return "disabled" }
  if (-not (Test-TaskDefinition $task)) { return "invalid" }
  if (-not (Test-ServiceConfigReady)) { return "invalid" }
  if (Test-TaskHasLogonTrigger $task) { return "enabled" }
  return "disabled"
}

function Test-TaskHasLogonTrigger($task) {
  if (-not (Test-TaskDefinition $task)) { return $false }
  foreach ($trigger in @($task.Triggers)) {
    $className = if ($trigger.CimClass) { [string]$trigger.CimClass.CimClassName } else { "" }
    if ((Test-ContainsIgnoreCase $className "LogonTrigger") -and
        $trigger.Enabled -ne $false -and
        (Test-CurrentTaskUser $trigger.UserId)) {
      return $true
    }
  }
  return $false
}

function Test-ProductionInstanceReady {
  if (-not (Test-ServiceConfigReady)) { return $false }
  $task = Get-Task
  if (-not $task -or $task.State -ne "Running" -or -not (Test-TaskDefinition $task)) {
    return $false
  }
  $entries = @(Get-VerifiedEntries "prod")
  $serverEntries = @($entries | Where-Object { $_.Role -eq "server" })
  if (-not (Test-PortsOwnedByEntries @($ServerPort) $serverEntries)) { return $false }
  return Test-HealthEndpoint "http://127.0.0.1:$ServerPort/api/version"
}

function Wait-ProductionInstanceReady {
  $tries = 60
  if ($env:YEP_PROD_READY_TRIES) {
    $parsedTries = 0
    if ([int]::TryParse($env:YEP_PROD_READY_TRIES, [ref]$parsedTries) -and $parsedTries -gt 0) {
      $tries = $parsedTries
    }
  }
  for ($attempt = 0; $attempt -lt $tries; $attempt++) {
    if (Test-ProductionInstanceReady) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Invoke-TaskInstaller($mode) {
  & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $InstallTaskScript $mode
  return $LASTEXITCODE -eq 0
}

function Ensure-ProductionTask {
  $task = Get-Task
  if ($task -and (Test-TaskDefinition $task) -and (Test-ServiceConfigReady) -and -not $HasProductionConfigOverrides) {
    return $true
  }
  $mode = if (Test-TaskHasAnyEnabledLogonTrigger $task) {
    "--enable-autostart"
  } else {
    "--manual-only"
  }
  Write-Info "正在安装或修复生产计划任务与持久服务配置……"
  if (-not (Invoke-TaskInstaller $mode)) { return $false }
  Update-ServiceConfigState
  if (-not (Test-ServiceConfigReady)) {
    Write-ErrorMessage "任务安装后生产服务配置仍无效：$ServiceConfigPath（$ServiceConfigError）"
    return $false
  }
  return $true
}

function Cmd-RunDev {
  Set-Location $RepoRoot
  $env:PORT = [string]$DevMainPort
  if (-not $env:YEP_ANYWHERE_PROFILE -and -not $env:YEP_ANYWHERE_DATA_DIR) {
    $env:YEP_ANYWHERE_PROFILE = "dev"
  }
  & pnpm dev
  exit $LASTEXITCODE
}

function Cmd-StartDev([string[]]$commandArgs = @()) {
  $foreground = $false
  foreach ($arg in $commandArgs) {
    if ($arg -eq "--fg") { $foreground = $true }
    elseif ($arg -eq "--bg") { $foreground = $false }
    else {
      Write-ErrorMessage "start-dev 不支持参数：$arg"
      return $false
    }
  }

  $verified = @(Get-VerifiedEntries "dev")
  if ($verified.Count -gt 0) {
    if (Test-DevInstanceReady $verified) {
      Write-WarningMessage "开发模式已在运行（PID $($verified[0].Pid)，端口 $DevMainPort/$DevMaintPort/$DevVitePort）。"
      return $true
    }
    Write-ErrorMessage "已核实的开发启动器仍在运行，但健康检查或三个开发端口的进程归属异常；拒绝重复启动。"
    return $false
  }
  if (-not (Test-PortsAvailableForMode "dev" @($DevMainPort, $DevMaintPort, $DevVitePort))) {
    return $false
  }

  if ($foreground) {
    Write-Info "以前台方式启动开发模式；按 Ctrl+C 停止。"
    Cmd-RunDev
    return $true
  }

  Ensure-LogDir
  $outLog = Join-Path $LogDir "dev-console.out.log"
  $errLog = Join-Path $LogDir "dev-console.err.log"
  $process = Start-Process -FilePath $PowerShellExe `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$ThisScript`"", "__run-dev") `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru
  $state = [ordered]@{
    Version = 1
    Mode = "dev"
    Profile = if ($env:YEP_ANYWHERE_PROFILE) { $env:YEP_ANYWHERE_PROFILE } else { "dev" }
    RepoRoot = $RepoRoot
    LogPath = $outLog
    Processes = @([ordered]@{
      Role = "launcher"
      Pid = $process.Id
      StartTimeUtc = $process.StartTime.ToUniversalTime().ToString("o")
    })
  }
  Write-ProcessState "dev" $state

  if (-not (Wait-Health "http://127.0.0.1:$DevMainPort/api/version")) {
    Write-ErrorMessage "开发模式未在 15 秒内响应（端口 $DevMainPort）。"
    Write-Detail "日志：$outLog / $errLog"
    Write-WarningMessage "正在清理本次已核实的开发启动器……"
    Stop-VerifiedMode "dev" @($DevMainPort, $DevMaintPort, $DevVitePort) | Out-Null
    return $false
  }
  $startedEntries = @(Get-VerifiedEntries "dev")
  if (-not (Test-PortsOwnedByEntries @($DevMainPort, $DevMaintPort, $DevVitePort) $startedEntries)) {
    Write-ErrorMessage "开发模式健康检查已响应，但三个开发端口没有全部归属于本次启动的进程树。"
    Write-WarningMessage "正在清理本次已核实的开发启动器……"
    Stop-VerifiedMode "dev" @($DevMainPort, $DevMaintPort, $DevVitePort) | Out-Null
    return $false
  }
  Write-Info "开发模式已在后台运行（端口 $DevMainPort，PID $($process.Id)）。"
  Write-Detail "Profile：$($state.Profile)；日志：$outLog / $errLog"
  return $true
}

function Cmd-StopDev {
  $ports = @($DevMainPort, $DevMaintPort, $DevVitePort)
  $verified = @(Get-VerifiedEntries "dev")
  if ($verified.Count -eq 0) {
    $unknown = $false
    foreach ($port in $ports) {
      foreach ($processId in @(Get-ListeningPids $port)) {
        Show-UnknownPortOwner $port $processId
        $unknown = $true
      }
    }
    if ($unknown) { return $false }
    Write-WarningMessage "开发模式当前未运行。"
    Remove-ProcessState "dev"
    return $true
  }
  Write-Info "正在停止开发模式……"
  return Stop-VerifiedMode "dev" $ports
}

function Cmd-StartProd {
  if (-not (Test-Path $CliJs)) {
    Write-ErrorMessage "未找到生产 Bundle：$CliJs"
    Write-Detail "请先执行 rebuild。"
    return $false
  }
  if (Test-ProductionInstanceReady) {
    Write-WarningMessage "生产模式已由计划任务运行（端口 $ServerPort）。"
    return $true
  }

  $task = Get-Task
  $verified = @(Get-VerifiedEntries "prod")
  $serverPids = @($verified | Where-Object { $_.Role -eq "server" } | ForEach-Object { [int]$_.Pid })
  $portPids = @(Get-ListeningPids $ServerPort)
  $managedPort = @($portPids | Where-Object { $serverPids -contains [int]$_ }).Count -gt 0

  if ($portPids.Count -gt 0) {
    if ($managedPort) {
      Write-ErrorMessage "生产端口 $ServerPort 的 PID 元数据可核实，但计划任务状态或动作配置异常；拒绝重复启动。"
    } else {
      foreach ($processId in $portPids) { Show-UnknownPortOwner $ServerPort $processId }
    }
    return $false
  }
  if ($task -and $task.State -eq "Running") {
    Write-ErrorMessage "计划任务 $TaskName 显示运行中，但没有可核实的生产监听进程；请先检查状态和日志。"
    return $false
  }
  if (-not (Test-PortsAvailableForMode "prod" @($ServerPort))) { return $false }
  if (-not (Ensure-ProductionTask)) { return $false }

  Write-Info "正在通过计划任务启动生产模式……"
  Start-ScheduledTask -TaskName $TaskName
  if (-not (Wait-ProductionInstanceReady)) {
    Write-ErrorMessage "生产模式启动后，任务状态、动作、配置、PID 元数据、监听端口或健康检查未能在 15 秒内全部就绪。"
    Write-Detail "日志目录：$ProdLogDir"
    return $false
  }
  Write-Info "生产模式已启动（计划任务 $TaskName，端口 $ServerPort）。"
  return $true
}

function Cmd-StopProd {
  $task = Get-Task
  $verified = @(Get-VerifiedEntries "prod")
  if (-not $task -and $verified.Count -eq 0 -and (Get-ListeningPids $ServerPort).Count -eq 0) {
    Write-WarningMessage "生产模式当前未运行。"
    Remove-ProcessState "prod"
    return $true
  }

  if ($task -and -not (Test-TaskDefinition $task)) {
    Write-ErrorMessage "同名计划任务 $TaskName 的动作配置异常；为避免停止无关任务，已拒绝操作。"
    return $false
  }

  $processSnapshot = Get-ManagedProcessSnapshot $verified
  if (-not $processSnapshot.Complete) {
    Write-ErrorMessage "无法枚举完整的 prod 进程树；未发送计划任务停止请求。"
    return $false
  }

  Write-Info "正在停止生产计划任务实例……"
  if ($task -and $task.State -eq "Running") {
    try {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
    } catch {
      Write-ErrorMessage "停止计划任务失败：$_"
      return $false
    }
    $stopTries = 40
    if ($env:YEP_TASK_STOP_WAIT_TRIES) {
      $parsedStopTries = 0
      if ([int]::TryParse($env:YEP_TASK_STOP_WAIT_TRIES, [ref]$parsedStopTries) -and $parsedStopTries -gt 0) {
        $stopTries = $parsedStopTries
      }
    }
    $taskStopped = $false
    for ($attempt = 0; $attempt -lt $stopTries; $attempt++) {
      $currentTask = Get-Task
      if (-not $currentTask -or $currentTask.State -ne "Running") {
        $taskStopped = $true
        break
      }
      Start-Sleep -Milliseconds 250
    }
    if (-not $taskStopped) {
      Write-ErrorMessage "计划任务 $TaskName 在停止请求后仍在运行；未清理生产进程。"
      return $false
    }
  }
  return Stop-VerifiedMode "prod" @($ServerPort) $verified $processSnapshot
}

function Cmd-RestartDev([string[]]$commandArgs = @()) {
  if (-not (Cmd-StopDev)) { return $false }
  return Cmd-StartDev $commandArgs
}

function Cmd-RestartProd {
  if (-not (Cmd-StopProd)) { return $false }
  return Cmd-StartProd
}

function Cmd-Stop {
  $devStopped = Cmd-StopDev
  $prodStopped = Cmd-StopProd
  return $devStopped -and $prodStopped
}

function Cmd-Rebuild {
  Write-Info "开始暂存重构建；验证完成前不会停止生产服务。"
  & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $DeployScript --server-only
  return $LASTEXITCODE -eq 0
}

function Cmd-EnableAutostart {
  Write-Info "正在启用生产模式登录自启动……"
  if (-not (Invoke-TaskInstaller "--enable-autostart")) { return $false }
  Write-Detail "当前生产运行状态未改变。"
  return $true
}

function Cmd-DisableAutostart {
  Write-Info "正在关闭生产模式登录自启动……"
  & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $DisableTaskScript
  return $LASTEXITCODE -eq 0
}

function Cmd-Status {
  Write-Host "Yep Anywhere 服务状态" -ForegroundColor Cyan
  Write-Detail "操作系统：Windows；服务管理器：Task Scheduler"

  $devState = Read-ProcessState "dev"
  $devProfile = if ($devState -and $devState.Profile) { [string]$devState.Profile } else { "dev" }
  $devEntries = @(Get-VerifiedEntries "dev")
  $devRunning = Test-DevInstanceReady $devEntries
  if ($devRunning) {
    Write-Info "开发模式：运行中"
    Write-Detail "端口：$DevMainPort；PID：$($devEntries[0].Pid)；Profile：$devProfile"
  } else {
    Write-WarningMessage "开发模式：已停止"
  }
  Write-Detail "日志：$LogDir\dev-console.out.log / dev-console.err.log"

  $task = Get-Task
  $taskInfo = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue } else { $null }
  $prodState = Read-ProcessState "prod"
  $prodProfile = if ($prodState -and $prodState.Profile) { [string]$prodState.Profile } else { "default" }
  $prodEntries = @(Get-VerifiedEntries "prod")
  $prodPids = Get-ListeningPids $ServerPort
  $verifiedServerPids = @($prodEntries | Where-Object { $_.Role -eq "server" } | ForEach-Object { [int]$_.Pid })
  $prodRunning = Test-ProductionInstanceReady
  if ($prodRunning) {
    Write-Info "生产模式：运行中"
  } elseif ($task -and $task.State -eq "Running") {
    Write-ErrorMessage "生产模式：配置异常（任务运行状态、动作、PID 元数据或监听端口不一致）"
  } else {
    Write-WarningMessage "生产模式：已停止"
  }
  $lastResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { "无" }
  Write-Detail "端口：$ServerPort；PID：$($prodPids -join ',')；Profile：$prodProfile"
  Write-Detail "计划任务：$(if ($task) { '已安装' } else { '未安装' })；最近结果：$lastResult"
  if ($task -and -not (Test-ServiceConfigReady)) {
    Write-ErrorMessage "生产服务配置异常：$ServiceConfigPath（$ServiceConfigError）"
  }
  Write-Detail "日志：$ProdLogDir\server.out.log / server.err.log"

  switch (Get-AutostartState $task) {
    "enabled" { Write-Info "生产自启动：已启用" }
    "disabled" { Write-WarningMessage "生产自启动：已关闭" }
    default { Write-ErrorMessage "生产自启动：配置异常" }
  }

  foreach ($port in @($DevMainPort, $DevMaintPort, $DevVitePort, $ServerPort)) {
    foreach ($processId in @(Get-ListeningPids $port)) {
      $known = (Test-PortOwnerMatchesEntries $processId $devEntries) -or
        (Test-PortOwnerMatchesEntries $processId $prodEntries)
      if (-not $known) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        $name = if ($process) { $process.ProcessName } else { "未知进程" }
        Write-WarningMessage "端口 $port 被未纳管进程占用：PID $processId（$name）。"
      }
    }
  }
  return $true
}

function Show-Help {
  Write-Host "Yep Anywhere Windows 服务进程管理" -ForegroundColor Cyan
  Write-Host @"

用法：
  powershell scripts/yep.ps1 [命令]

命令：
  start-dev [--fg]  启动开发模式（默认后台；--fg 前台）
  stop-dev          停止开发模式
  restart-dev [--fg] 重启开发模式
  start-prod        通过 YepAnywhereServer 计划任务启动生产模式
  stop-prod         停止生产模式，不改变登录自启动
  restart-prod      通过同一计划任务重启生产模式
  stop              停止开发和生产模式，不改变登录自启动
  status            查看开发、生产和登录自启动三类状态
  rebuild           暂存构建、验证、交换并重启生产模式
  enable-autostart  启用生产模式登录自启动，不启动当前实例
  disable-autostart 关闭生产模式登录自启动，不停止当前实例
  help              显示本帮助

端口：开发 $DevMainPort/$DevMaintPort/$DevVitePort；生产 $ServerPort；桥接 $CodexPort/$ClaudePort
日志：$LogDir
"@
}

function Show-Menu {
  while ($true) {
    Write-Host ""
    Write-Host "Yep Anywhere Windows 服务进程管理" -ForegroundColor Cyan
    Write-Host "  1) 启动开发模式"
    Write-Host "  2) 停止开发模式"
    Write-Host "  3) 重启开发模式"
    Write-Host "  4) 启动生产模式"
    Write-Host "  5) 停止生产模式"
    Write-Host "  6) 重启生产模式"
    Write-Host "  7) 停止全部运行模式"
    Write-Host "  8) 查看状态"
    Write-Host "  9) 重构建生产模式"
    Write-Host "  a) 启用登录自启动"
    Write-Host "  d) 关闭登录自启动"
    Write-Host "  h) 帮助"
    Write-Host "  q) 退出"
    $choice = Read-Host "请选择"
    switch ($choice) {
      "1" { Cmd-StartDev | Out-Null }
      "2" { Cmd-StopDev | Out-Null }
      "3" { Cmd-RestartDev | Out-Null }
      "4" { Cmd-StartProd | Out-Null }
      "5" { Cmd-StopProd | Out-Null }
      "6" { Cmd-RestartProd | Out-Null }
      "7" { Cmd-Stop | Out-Null }
      "8" { Cmd-Status | Out-Null }
      "9" { Cmd-Rebuild | Out-Null }
      "a" { Cmd-EnableAutostart | Out-Null }
      "d" { Cmd-DisableAutostart | Out-Null }
      "h" { Show-Help }
      "q" { return }
      default { Write-WarningMessage "未知选项：$choice" }
    }
  }
}

$command = if ($args.Count -gt 0) { [string]$args[0] } else { "" }
$commandArgs = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)]) } else { @() }
$success = $true
switch ($command) {
  "__run-dev" { Cmd-RunDev }
  "start-dev" { $success = Cmd-StartDev $commandArgs }
  "stop-dev" { $success = Cmd-StopDev }
  "restart-dev" { $success = Cmd-RestartDev $commandArgs }
  "start-prod" { $success = Cmd-StartProd }
  "stop-prod" { $success = Cmd-StopProd }
  "restart-prod" { $success = Cmd-RestartProd }
  "stop" { $success = Cmd-Stop }
  "status" { $success = Cmd-Status }
  "rebuild" { $success = Cmd-Rebuild }
  "enable-autostart" { $success = Cmd-EnableAutostart }
  "disable-autostart" { $success = Cmd-DisableAutostart }
  "help" { Show-Help }
  "" { Show-Menu }
  default {
    Write-ErrorMessage "未知命令：$command"
    Write-Host "可用命令：start-dev stop-dev restart-dev start-prod stop-prod restart-prod stop status rebuild enable-autostart disable-autostart help"
    exit 2
  }
}

if (-not $success) { exit 1 }

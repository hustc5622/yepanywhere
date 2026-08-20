# YepAnywhereServer 计划任务的唯一生产监督器（Windows PowerShell 5.1）。

param(
  [switch]$WaitForServer, # 保留旧参数兼容；监督器始终等待全部关键进程。
  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = [string](Resolve-Path (Join-Path $ScriptDir ".."))
$BundleDir = Join-Path $RepoRoot "dist/npm-package"
$CliJs = Join-Path $BundleDir "dist/cli.js"
. (Join-Path $ScriptDir "service-config.ps1")
. (Join-Path $ScriptDir "production-runtime.ps1")
if (-not $ConfigPath) {
  $ConfigPath = if ($env:YEP_SERVICE_CONFIG_PATH) {
    $env:YEP_SERVICE_CONFIG_PATH
  } else {
    Join-Path $env:USERPROFILE ".yep-anywhere/service-config.json"
  }
}
if (-not (Test-Path $ConfigPath)) {
  Write-Host "[Yep Anywhere] 错误：缺少生产服务配置：$ConfigPath" -ForegroundColor Red
  exit 1
}
try {
  $serviceConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-ServiceConfigSchema $serviceConfig $ConfigPath
} catch {
  Write-Host "[Yep Anywhere] 错误：生产服务配置无效：$_" -ForegroundColor Red
  exit 1
}
function Get-ServiceConfigValue($environmentValue, $propertyName, $defaultValue) {
  if ($null -ne $environmentValue -and [string]$environmentValue -ne "") { return [string]$environmentValue }
  if ($serviceConfig -and $null -ne $serviceConfig.$propertyName -and [string]$serviceConfig.$propertyName -ne "") {
    return [string]$serviceConfig.$propertyName
  }
  return $defaultValue
}
$ServerPort = Get-ServiceConfigValue $env:YEP_DEPLOY_PORT "ServerPort" "8022"
$MaintenancePort = ([int]$ServerPort) + 1
$CodexPort = Get-ServiceConfigValue $env:YEP_CODEX_BRIDGE_PORT "CodexPort" $(if ($env:CODEX_BRIDGE_PORT) { $env:CODEX_BRIDGE_PORT } else { "4510" })
$ClaudePort = Get-ServiceConfigValue $env:YEP_CLAUDE_BRIDGE_PORT "ClaudePort" $(if ($env:CLAUDE_BRIDGE_PORT) { $env:CLAUDE_BRIDGE_PORT } else { "4520" })
foreach ($portValue in @($ServerPort, $MaintenancePort, $CodexPort, $ClaudePort)) {
  if (-not (Test-ServicePortValue $portValue)) {
    Write-Host "[Yep Anywhere] 错误：生产服务端口无效：$portValue" -ForegroundColor Red
    exit 1
  }
}
$ServerBasePath = Get-ServiceConfigValue $env:YEP_DEPLOY_BASE_PATH "BasePath" "/"
if ([string]::IsNullOrWhiteSpace($ServerBasePath) -or -not $ServerBasePath.StartsWith("/")) {
  Write-Host "[Yep Anywhere] 错误：生产服务 BasePath 必须以 / 开头。" -ForegroundColor Red
  exit 1
}
$configuredProfile = Get-ServiceConfigValue $env:YEP_ANYWHERE_PROFILE "Profile" $null
$configuredDataDir = Get-ServiceConfigValue $env:YEP_ANYWHERE_DATA_DIR "DataDir" $null
if (-not $env:YEP_ANYWHERE_PROFILE -and $configuredProfile) { $env:YEP_ANYWHERE_PROFILE = $configuredProfile }
if (-not $env:YEP_ANYWHERE_DATA_DIR -and $configuredDataDir) { $env:YEP_ANYWHERE_DATA_DIR = $configuredDataDir }
if (-not $env:ALLOWED_IMAGE_PATHS) {
  $configuredAllowedPaths = Get-ServiceConfigValue $null "AllowedImagePaths" $null
  if ($configuredAllowedPaths) { $env:ALLOWED_IMAGE_PATHS = $configuredAllowedPaths }
}
if ($ServerBasePath -eq "/") {
  $ServerBasePath = ""
} else {
  $ServerBasePath = "/" + $ServerBasePath.TrimStart("/").TrimEnd("/")
}
$ServerBaseUrl = "http://127.0.0.1:${ServerPort}${ServerBasePath}"
$LogDir = if ($env:YEP_LAUNCHD_LOG_DIR) {
  $env:YEP_LAUNCHD_LOG_DIR
} elseif ($env:YEP_ANYWHERE_DATA_DIR) {
  Join-Path $env:YEP_ANYWHERE_DATA_DIR "logs"
} else {
  Join-Path $env:USERPROFILE ".yep-anywhere/logs"
}
$StateFile = Join-Path $LogDir "prod-process.json"
$Managed = @()
$Launched = @()
$BridgeModes = [ordered]@{ Codex = "disabled"; Claude = "disabled" }
$OwnsManagedGroup = $false
$Expectation = $null
$SupervisorIdentity = $null
$SupervisorInstanceId = [guid]::NewGuid().ToString()

function Write-YepLog($message) { Write-Host "[Yep Anywhere] $message" }

function Test-ListeningPort($port) {
  try {
    return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop).Count -gt 0
  } catch {
    return $false
  }
}

function Wait-Health($url, $tries = 60, $expectedBuildId = $null) {
  for ($index = 0; $index -lt $tries; $index++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 -ErrorAction Stop
      if ($response.StatusCode -eq 200) {
        if (-not $expectedBuildId) { return $true }
        $body = [string]$response.Content | ConvertFrom-Json
        if ([string]$body.build.buildId -ceq [string]$expectedBuildId) { return $true }
      }
    } catch { }
    if ($index + 1 -lt $tries) { Start-Sleep -Milliseconds 250 }
  }
  return $false
}

function Assert-BundleReady {
  $required = @(
    $CliJs,
    (Join-Path $BundleDir "package.json"),
    (Join-Path $BundleDir "npm-shrinkwrap.json"),
    (Join-Path $BundleDir "node_modules/@hono/node-ws/package.json"),
    (Join-Path $BundleDir "node_modules/pino/package.json")
  )
  foreach ($path in $required) {
    if (-not (Test-Path $path)) {
      throw "生产 Bundle 或运行依赖不完整：$path。请先执行 rebuild。"
    }
  }
}

function Set-ProductionEnvironment {
  $env:NODE_ENV = "production"
  $env:MAINTENANCE_PORT = [string]$MaintenancePort
  if (-not $env:BASE_PATH) { $env:BASE_PATH = $ServerBasePath }
  if (-not $env:ALLOWED_IMAGE_PATHS) { $env:ALLOWED_IMAGE_PATHS = "$env:TEMP,$env:USERPROFILE\Downloads" }
  $env:YEP_DEPLOY_REPO_ROOT = $RepoRoot
  $env:YEP_CODEX_BRIDGE_MODE = "external"
  if (-not $env:YEP_CODEX_BRIDGE_CONTROL_URL) { $env:YEP_CODEX_BRIDGE_CONTROL_URL = "http://127.0.0.1:$CodexPort" }
  $env:YEP_CODEX_BRIDGE_PORT = $CodexPort
  if (-not $env:YEP_CLAUDE_BRIDGE_CONTROL_URL) { $env:YEP_CLAUDE_BRIDGE_CONTROL_URL = "http://127.0.0.1:$ClaudePort" }
  $env:YEP_CLAUDE_BRIDGE_PORT = $ClaudePort
  $env:YEP_SERVER_URL = $ServerBaseUrl
}

function Add-ManagedProcess($role, $arguments, $outLog, $errLog) {
  $nodeBin = (Get-Command node).Source
  $argumentList = @("`"$CliJs`"") + $arguments
  $process = Start-Process -FilePath $nodeBin `
    -ArgumentList $argumentList `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru
  $started = [pscustomobject]@{
    Role = $role
    Process = $process
    Pid = $process.Id
    StartTimeUtc = $process.StartTime.ToUniversalTime()
  }
  $script:Launched += $started
  $identity = New-YepProcessIdentity -Role $role -ProcessId $process.Id
  if (-not $identity) { throw "无法记录新启动的 $role 进程身份（PID $($process.Id)）。" }
  $script:Managed += [pscustomobject]@{
    Role = $started.Role
    Process = $started.Process
    Pid = $started.Pid
    Identity = $identity
  }
  Write-YepLog "已启动 $role，PID $($process.Id)。"
}

function Write-ProductionManifest {
  $manifest = [ordered]@{
    Version = 2
    Mode = "prod"
    SupervisorInstanceId = $SupervisorInstanceId
    Supervisor = $SupervisorIdentity
    BuildId = $Expectation.BuildId
    ConfigFingerprint = $Expectation.ConfigFingerprint
    RepoRoot = $Expectation.RepoRoot
    BundlePath = $Expectation.BundlePath
    Profile = $Expectation.Profile
    DataDir = $Expectation.DataDir
    BasePath = $Expectation.BasePath
    Ports = [ordered]@{
      Server = [int]$ServerPort
      Maintenance = [int]$MaintenancePort
      Codex = [int]$CodexPort
      Claude = [int]$ClaudePort
    }
    Bridges = [ordered]@{ Codex = $BridgeModes.Codex; Claude = $BridgeModes.Claude }
    Processes = @($Managed | ForEach-Object { $_.Identity })
  }
  Write-YepJsonAtomic -Path $StateFile -Value $manifest
}

function Resolve-BridgeMode($name, $port, $controlUrl) {
  if ($env:YEP_START_BRIDGES -eq "false") { return "disabled" }
  if (Test-ListeningPort $port) {
    if (-not (Wait-Health ($controlUrl.TrimEnd("/") + "/status") 1)) {
      throw "unknown-conflict：$name bridge 端口 $port 已占用但健康检查失败。"
    }
    Write-YepLog "$name bridge 端口 $port 已有健康外部实例，本监督器不接管。"
    return "external"
  }
  return "managed"
}

function Test-ManagedGroupStopped {
  foreach ($item in $Managed) {
    if (Get-Process -Id $item.Pid -ErrorAction SilentlyContinue) { return $false }
  }
  return (-not (Test-ListeningPort $ServerPort)) -and (-not (Test-ListeningPort $MaintenancePort))
}

function Stop-UnmanifestedProcesses {
  $stopped = $true
  foreach ($item in $Launched) {
    try {
      if ($item.Process.HasExited) { continue }
      if ($item.Process.StartTime.ToUniversalTime() -ne $item.StartTimeUtc) {
        $stopped = $false
        continue
      }
      $item.Process.Kill()
      $item.Process.WaitForExit() | Out-Null
      if ($item.Process.HasExited) {
        Write-YepLog "已回滚未写入清单的 $($item.Role)，PID $($item.Pid)。"
      } else {
        $stopped = $false
      }
    } catch {
      $stopped = $false
      Write-YepLog "回滚未写入清单的 $($item.Role)（PID $($item.Pid)）失败：$_"
    }
  }
  return $stopped
}

try {
  Assert-BundleReady
  Set-ProductionEnvironment
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $buildId = Get-YepBundleBuildId -BundlePath $BundleDir
  $profile = if ($env:YEP_ANYWHERE_PROFILE) { [string]$env:YEP_ANYWHERE_PROFILE } else { $null }
  $dataDir = if ($env:YEP_ANYWHERE_DATA_DIR) { [string]$env:YEP_ANYWHERE_DATA_DIR } else { $null }
  $Expectation = New-YepProductionExpectation `
    -RepoRoot $RepoRoot `
    -BundlePath $BundleDir `
    -BuildId $buildId `
    -BasePath $ServerBasePath `
    -Profile $profile `
    -DataDir $dataDir `
    -AllowedImagePaths $env:ALLOWED_IMAGE_PATHS `
    -ServerPort ([int]$ServerPort) `
    -MaintenancePort ([int]$MaintenancePort) `
    -CodexPort ([int]$CodexPort) `
    -ClaudePort ([int]$ClaudePort) `
    -CodexControlUrl $env:YEP_CODEX_BRIDGE_CONTROL_URL `
    -ClaudeControlUrl $env:YEP_CLAUDE_BRIDGE_CONTROL_URL `
    -StartBridges ($env:YEP_START_BRIDGES -ne "false") `
    -RunScriptPath $MyInvocation.MyCommand.Definition
  $SupervisorIdentity = New-YepProcessIdentity -Role "supervisor" -ProcessId $PID
  if (-not $SupervisorIdentity) { throw "无法记录当前生产监督器身份。" }

  $inspection = Get-YepProductionInspection -ManifestPath $StateFile -Expectation $Expectation
  switch ($inspection.State) {
    "healthy" {
      throw "生产状态为 healthy；拒绝启动第二个监督器。"
    }
    "degraded-adoptable" {
      $BridgeModes.Codex = [string]$inspection.Manifest.Bridges.Codex
      $BridgeModes.Claude = [string]$inspection.Manifest.Bridges.Claude
      $adopted = @()
      $retainAdopted = $false
      try {
        foreach ($entry in @($inspection.VerifiedProcesses)) {
          try {
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$entry.Pid)" -ErrorAction Stop
          } catch { $processInfo = $null }
          if (-not $processInfo) { throw "接管时已验证进程消失：$($entry.Role)（PID $($entry.Pid)）。" }
          $bound = New-YepBoundProcessSnapshotEntry -ProcessInfo $processInfo -Role ([string]$entry.Role)
          if ($bound.Status -ne 'bound') {
            throw "接管时进程身份无法绑定：$($entry.Role)（PID $($entry.Pid)）。"
          }
          $adopted += [pscustomobject]@{
            Role = [string]$entry.Role
            Process = $bound.Entry.Process
            Pid = [int]$entry.Pid
            Identity = $entry
          }
          try {
            $storedStart = [DateTimeOffset]::Parse([string]$entry.StartTimeUtc).UtcDateTime
            $boundStart = [DateTimeOffset]::Parse([string]$bound.Entry.StartTimeUtc).UtcDateTime
            $storedPath = [IO.Path]::GetFullPath([string]$entry.ExecutablePath)
            $livePath = [IO.Path]::GetFullPath([string]$processInfo.ExecutablePath)
          } catch { throw "接管时进程身份无效：$($entry.Role)（PID $($entry.Pid)）。" }
          if (($storedStart.Ticks -ne $boundStart.Ticks) -or
              (-not [string]::Equals($storedPath, $livePath, [StringComparison]::OrdinalIgnoreCase)) -or
              (-not [string]::Equals([string]$entry.CommandLine, [string]$processInfo.CommandLine, [StringComparison]::Ordinal)) -or
              (-not (Test-YepRoleCommand -Role ([string]$entry.Role) -CommandLine ([string]$processInfo.CommandLine) -Expectation $Expectation))) {
            throw "接管时进程身份已变化：$($entry.Role)（PID $($entry.Pid)）。"
          }
        }
        $Managed += $adopted
        $retainAdopted = $true
      } finally {
        if (-not $retainAdopted) { Close-YepBoundProcessSnapshot -Snapshot $adopted }
      }
      $OwnsManagedGroup = $true
      Write-ProductionManifest
      Write-YepLog "已接管现有生产进程组；子进程 PID 保持不变。"
    }
    "verified-stale" {
      Write-YepLog "检测到 verified-stale；正在清理已验证生产进程组。"
      if (-not (Stop-YepVerifiedProcessGroup -Inspection $inspection)) {
        throw "verified-stale 清理失败；未启动新进程。"
      }
      $inspection = Get-YepProductionInspection -ManifestPath $StateFile -Expectation $Expectation
      if ($inspection.State -ne "stopped") {
        throw "verified-stale 清理后状态为 $($inspection.State)，未达到 stopped。"
      }
    }
    "unknown-conflict" {
      throw "生产状态为 unknown-conflict；拒绝启动或清理任何进程。"
    }
    "stopped" { }
    default { throw "无法识别生产状态：$($inspection.State)" }
  }

  if ($inspection.State -ne "degraded-adoptable") {
    $BridgeModes.Codex = Resolve-BridgeMode "Codex" ([int]$CodexPort) $env:YEP_CODEX_BRIDGE_CONTROL_URL
    $BridgeModes.Claude = Resolve-BridgeMode "Claude" ([int]$ClaudePort) $env:YEP_CLAUDE_BRIDGE_CONTROL_URL
    Add-ManagedProcess "server" @("--port", [string]$ServerPort) `
      (Join-Path $LogDir "server.out.log") `
      (Join-Path $LogDir "server.err.log")
    if ($BridgeModes.Codex -eq "managed") {
      Add-ManagedProcess "codex-bridge" @("--codex-bridge-only") `
        (Join-Path $LogDir "codex-bridge.out.log") `
        (Join-Path $LogDir "codex-bridge.err.log")
    }
    if ($BridgeModes.Claude -eq "managed") {
      Add-ManagedProcess "claude-bridge" @("--claude-bridge-only") `
        (Join-Path $LogDir "claude-bridge.out.log") `
        (Join-Path $LogDir "claude-bridge.err.log")
    }
    Write-ProductionManifest
    $OwnsManagedGroup = $true
    if (-not (Wait-Health "$ServerBaseUrl/api/version" 60 $buildId)) {
      throw "生产服务未在 15 秒内以 buildId $buildId 响应：$ServerBaseUrl/api/version。"
    }
    if (-not (Wait-Health "http://127.0.0.1:$MaintenancePort/health")) {
      throw "生产维护服务未在 15 秒内响应：http://127.0.0.1:$MaintenancePort/health。"
    }
    foreach ($bridge in @(
        @("Codex", $BridgeModes.Codex, $env:YEP_CODEX_BRIDGE_CONTROL_URL),
        @("Claude", $BridgeModes.Claude, $env:YEP_CLAUDE_BRIDGE_CONTROL_URL)
      )) {
      if (($bridge[1] -eq "managed") -and
          (-not (Wait-Health ($bridge[2].TrimEnd("/") + "/status")))) {
        throw "$($bridge[0]) bridge 未在 15 秒内响应。"
      }
    }
    Write-ProductionManifest
  }
  Write-YepLog "生产实例已就绪；监督器开始监控 $($Managed.Count) 个关键进程。"

  while ($true) {
    foreach ($item in $Managed) {
      if ($item.Process.HasExited) {
        throw "关键进程 $($item.Role)（PID $($item.Pid)）已退出。"
      }
    }
    Start-Sleep -Seconds 2
  }
} catch {
  Write-YepLog "错误：$_"
  if ($OwnsManagedGroup -and $Expectation) {
    $cleanupInspection = Get-YepProductionInspection -ManifestPath $StateFile -Expectation $Expectation
    $cleaned = Stop-YepVerifiedProcessGroup -Inspection $cleanupInspection -ExcludeProcessId $PID
    if ($cleaned -and (Test-ManagedGroupStopped)) {
      Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    } else {
      Write-YepLog "已保留生产清单，供下次启动继续核验或清理。"
    }
  } elseif ($Launched.Count -gt 0 -and (-not (Stop-UnmanifestedProcesses))) {
    Write-YepLog "未写入清单的启动进程未能全部安全回滚。"
  }
  exit 1
}

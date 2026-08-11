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
$CodexPort = Get-ServiceConfigValue $env:YEP_CODEX_BRIDGE_PORT "CodexPort" $(if ($env:CODEX_BRIDGE_PORT) { $env:CODEX_BRIDGE_PORT } else { "4510" })
$ClaudePort = Get-ServiceConfigValue $env:YEP_CLAUDE_BRIDGE_PORT "ClaudePort" $(if ($env:CLAUDE_BRIDGE_PORT) { $env:CLAUDE_BRIDGE_PORT } else { "4520" })
foreach ($portValue in @($ServerPort, $CodexPort, $ClaudePort)) {
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

function Write-YepLog($message) { Write-Host "[Yep Anywhere] $message" }

function Test-ListeningPort($port) {
  try {
    return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop).Count -gt 0
  } catch {
    return $false
  }
}

function Wait-Health($url, $tries = 60) {
  for ($index = 0; $index -lt $tries; $index++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 -ErrorAction Stop
      if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 250
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
  $script:Managed += [pscustomobject]@{
    Role = $role
    Process = $process
    Pid = $process.Id
    StartTimeUtc = $process.StartTime.ToUniversalTime().ToString("o")
  }
  Write-YepLog "已启动 $role，PID $($process.Id)。"
}

function Write-ProcessMetadata {
  $supervisor = Get-Process -Id $PID -ErrorAction SilentlyContinue
  $processes = @()
  if ($supervisor) {
    $processes += [ordered]@{
      Role = "supervisor"
      Pid = $PID
      StartTimeUtc = $supervisor.StartTime.ToUniversalTime().ToString("o")
    }
  }
  foreach ($item in $Managed) {
    $processes += [ordered]@{
      Role = $item.Role
      Pid = $item.Pid
      StartTimeUtc = $item.StartTimeUtc
    }
  }
  [ordered]@{
    Version = 1
    Mode = "prod"
    Profile = if ($env:YEP_ANYWHERE_DATA_DIR) { "custom-data-dir" } elseif ($env:YEP_ANYWHERE_PROFILE) { $env:YEP_ANYWHERE_PROFILE } else { "default" }
    DataDir = if ($env:YEP_ANYWHERE_DATA_DIR) { $env:YEP_ANYWHERE_DATA_DIR } else { $null }
    RepoRoot = $RepoRoot
    BundlePath = $BundleDir
    LogPath = $LogDir
    Processes = $processes
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Stop-ManagedProcesses {
  foreach ($item in $Managed) {
    if (-not $item.Process.HasExited) {
      try {
        Stop-Process -Id $item.Pid -Force -ErrorAction SilentlyContinue
        Write-YepLog "已清理 $($item.Role)，PID $($item.Pid)。"
      } catch {
        Write-YepLog "清理 PID $($item.Pid) 失败：$_"
      }
    }
  }
}

try {
  Assert-BundleReady
  Set-ProductionEnvironment
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

  if (Test-ListeningPort $ServerPort) {
    throw "生产端口 $ServerPort 已被占用；为避免误用未知进程，监督器拒绝启动。"
  }

  Add-ManagedProcess "server" @("--port", [string]$ServerPort) `
    (Join-Path $LogDir "server.out.log") `
    (Join-Path $LogDir "server.err.log")

  if ($env:YEP_START_BRIDGES -ne "false") {
    if (Test-ListeningPort $CodexPort) {
      Write-YepLog "Codex bridge 端口 $CodexPort 已有外部实例，本监督器不接管。"
    } else {
      Add-ManagedProcess "codex-bridge" @("--codex-bridge-only") `
        (Join-Path $LogDir "codex-bridge.out.log") `
        (Join-Path $LogDir "codex-bridge.err.log")
    }
    if (Test-ListeningPort $ClaudePort) {
      Write-YepLog "Claude bridge 端口 $ClaudePort 已有外部实例，本监督器不接管。"
    } else {
      Add-ManagedProcess "claude-bridge" @("--claude-bridge-only") `
        (Join-Path $LogDir "claude-bridge.out.log") `
        (Join-Path $LogDir "claude-bridge.err.log")
    }
  }

  Write-ProcessMetadata
  if (-not (Wait-Health "$ServerBaseUrl/api/version")) {
    throw "生产服务未在 15 秒内响应：$ServerBaseUrl/api/version。"
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
  Stop-ManagedProcesses
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
  exit 1
}

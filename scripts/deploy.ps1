# Yep Anywhere Windows 暂存构建与生产部署入口（Windows PowerShell 5.1）。

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = [string](Resolve-Path (Join-Path $ScriptDir ".."))
$DistRoot = Join-Path $RepoRoot "dist"
$ProductionDir = Join-Path $DistRoot "npm-package"
$ProductionCli = Join-Path $ProductionDir "dist/cli.js"
$YepScript = Join-Path $ScriptDir "yep.ps1"
$VerifyDeployScript = Join-Path $ScriptDir "verify-deploy.mjs"
$PowerShellExe = (Get-Command powershell.exe).Source
$ServiceConfigPath = if ($env:YEP_SERVICE_CONFIG_PATH) {
  $env:YEP_SERVICE_CONFIG_PATH
} else {
  Join-Path $env:USERPROFILE ".yep-anywhere/service-config.json"
}
$ServiceConfig = $null
if (Test-Path $ServiceConfigPath) {
  $ServiceConfig = Get-Content -LiteralPath $ServiceConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
$ServerPort = if ($env:YEP_DEPLOY_PORT) {
  $env:YEP_DEPLOY_PORT
} elseif ($ServiceConfig -and $ServiceConfig.ServerPort) {
  [string]$ServiceConfig.ServerPort
} else {
  "8022"
}
$ServerBasePath = if ($env:YEP_DEPLOY_BASE_PATH) {
  $env:YEP_DEPLOY_BASE_PATH
} elseif ($ServiceConfig -and $ServiceConfig.BasePath) {
  [string]$ServiceConfig.BasePath
} else {
  "/"
}
if ($ServerBasePath -eq "/") { $ServerBasePath = "" } else { $ServerBasePath = "/" + $ServerBasePath.TrimStart("/").TrimEnd("/") }
$ServerBaseUrl = "http://127.0.0.1:${ServerPort}${ServerBasePath}"

$DoBuild = $true
$DoRestart = $true
$RunChecks = $true
$RequestedServerWork = $true
$ApkRequested = $false

function Write-Info($message) { Write-Host "==> $message" -ForegroundColor Green }
function Write-WarningMessage($message) { Write-Host "警告：$message" -ForegroundColor Yellow }
function Write-ErrorMessage($message) { Write-Host "错误：$message" -ForegroundColor Red }
function Write-Detail($message) { Write-Host "    $message" -ForegroundColor DarkGray }

function Show-Usage {
  Write-Host @"
Yep Anywhere Windows 部署

参数：
  --server-only       完整检查、暂存构建、交换并重启生产模式
  --restart-only      不构建，只通过计划任务重启现有生产 Bundle
  --server-build-only 暂存构建并交换，但不启动生产模式
  --no-restart        构建后不启动生产模式
  --skip-checks       跳过 lint/typecheck（仍构建并校验 Bundle）
  --codex-bridge-only / --claude-bridge-only
                      兼容参数；为保持单一生命周期，将重启完整生产任务
"@
}

foreach ($arg in $args) {
  switch ($arg) {
    "--server-only" { $RequestedServerWork = $true }
    "--restart-only" { $DoBuild = $false; $DoRestart = $true; $RunChecks = $false }
    "--server-build-only" { $DoBuild = $true; $DoRestart = $false }
    "--no-restart" { $DoRestart = $false }
    "--skip-checks" { $RunChecks = $false }
    "--no-server" { $RequestedServerWork = $false }
    "--codex-bridge-only" { $RequestedServerWork = $true; $DoBuild = $false; $DoRestart = $true; $RunChecks = $false }
    "--claude-bridge-only" { $RequestedServerWork = $true; $DoBuild = $false; $DoRestart = $true; $RunChecks = $false }
    "--restart-codex-bridge" { $RequestedServerWork = $true; $DoRestart = $true }
    "--restart-claude-bridge" { $RequestedServerWork = $true; $DoRestart = $true }
    "--preserve-codex-bridge" { }
    "--no-apk" { $ApkRequested = $false }
    "--apk-only" { $RequestedServerWork = $false; $ApkRequested = $true }
    "--debug" { $ApkRequested = $true }
    "--release" { $ApkRequested = $true }
    "--no-install" { }
    "--no-build" { $ApkRequested = $true }
    "--device" { $ApkRequested = $true }
    "--git-pull" { }
    "-s" { $ApkRequested = $true }
    "-h" { Show-Usage; exit 0 }
    "--help" { Show-Usage; exit 0 }
    default { Write-ErrorMessage "未知参数：$arg"; exit 2 }
  }
}

if ($ApkRequested) {
  Write-WarningMessage "Windows 工具链不支持本脚本构建 APK；已跳过。"
}
if (-not $RequestedServerWork) {
  Write-Info "没有需要执行的服务端部署操作。"
  exit 0
}

function Assert-LastExitCode($commandName) {
  if ($LASTEXITCODE -ne 0) {
    throw "$commandName 失败，退出码：$LASTEXITCODE"
  }
}

function Assert-ManagedDistPath($candidate, $requiredPrefix) {
  $full = [IO.Path]::GetFullPath([string]$candidate)
  $dist = [IO.Path]::GetFullPath([string]$DistRoot).TrimEnd('\') + '\'
  if (-not $full.StartsWith($dist, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作 dist 目录之外的路径：$full"
  }
  $name = Split-Path -Leaf $full
  if (-not $name.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作名称异常的目录：$full"
  }
  return $full
}

function Remove-StagingDirectory($stagingDir) {
  $safePath = Assert-ManagedDistPath $stagingDir "npm-package-staging-"
  if (Test-Path $safePath) {
    Remove-Item -LiteralPath $safePath -Recurse -Force
  }
}

function Invoke-Checks {
  Write-Info "运行 lint 和完整 TypeScript 检查……"
  Push-Location $RepoRoot
  try {
    & pnpm lint
    Assert-LastExitCode "pnpm lint"
    & pnpm --filter shared build
    Assert-LastExitCode "shared build"
    & pnpm -r --filter "!@yep-anywhere/mobile" exec tsc --noEmit
    Assert-LastExitCode "递归 TypeScript 检查"
  } finally {
    Pop-Location
  }
}

function Build-StagedBundle($stagingDir) {
  $safeStaging = Assert-ManagedDistPath $stagingDir "npm-package-staging-"
  Remove-StagingDirectory $safeStaging
  New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null

  Push-Location $RepoRoot
  $previousOutput = $env:YEP_BUNDLE_OUTPUT_DIR
  try {
    $version = node -p "require('./package.json').version"
    Assert-LastExitCode "读取项目版本"
    $env:NPM_VERSION = $version
    $env:YEP_BUNDLE_OUTPUT_DIR = $safeStaging
    Write-Info "构建完整暂存 Bundle：$safeStaging"
    & pnpm build:bundle | Out-Host
    Assert-LastExitCode "pnpm build:bundle"
  } finally {
    if ($null -eq $previousOutput) {
      Remove-Item Env:\YEP_BUNDLE_OUTPUT_DIR -ErrorAction SilentlyContinue
    } else {
      $env:YEP_BUNDLE_OUTPUT_DIR = $previousOutput
    }
    Pop-Location
  }

  $stagingCli = Join-Path $safeStaging "dist/cli.js"
  if (-not (Test-Path $stagingCli)) {
    throw "暂存 Bundle 缺少 CLI：$stagingCli"
  }

  Write-Info "在暂存 Bundle 安装锁定的生产依赖……"
  Push-Location $safeStaging
  try {
    & npm ci --omit=dev --no-audit --no-fund | Out-Host
    Assert-LastExitCode "npm ci --omit=dev"
  } finally {
    Pop-Location
  }

  Write-Info "验证暂存 Bundle 完整性……"
  Push-Location $RepoRoot
  try {
    & pnpm bundle:verify $safeStaging | Out-Host
    Assert-LastExitCode "pnpm bundle:verify"
  } finally {
    Pop-Location
  }
  return $safeStaging
}

function Publish-StagedBundle($stagingDir) {
  $safeStaging = Assert-ManagedDistPath $stagingDir "npm-package-staging-"
  $safeProduction = Assert-ManagedDistPath $ProductionDir "npm-package"
  $backupDir = Assert-ManagedDistPath (Join-Path $DistRoot ("npm-package-swap-" + [guid]::NewGuid().ToString("N"))) "npm-package-swap-"
  $movedOld = $false

  try {
    if (Test-Path $safeProduction) {
      Move-Item -LiteralPath $safeProduction -Destination $backupDir
      $movedOld = $true
    }
    Move-Item -LiteralPath $safeStaging -Destination $safeProduction
  } catch {
    if ($movedOld -and -not (Test-Path $safeProduction) -and (Test-Path $backupDir)) {
      Move-Item -LiteralPath $backupDir -Destination $safeProduction
    }
    throw
  }

  if (Test-Path $backupDir) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force
  }
  Write-Info "暂存 Bundle 已交换到生产目录。"
}

function Invoke-YepCommand($command) {
  & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $YepScript $command
  Assert-LastExitCode "yep.ps1 $command"
}

function Verify-RunningBuild {
  $buildInfo = Join-Path $ProductionDir "build-info.json"
  if (-not (Test-Path $buildInfo)) { throw "生产 Bundle 缺少 build-info.json" }
  & node $VerifyDeployScript --base-url $ServerBaseUrl --build-info $buildInfo
  Assert-LastExitCode "生产 buildId 验证"
}

Write-Info "部署计划"
Write-Detail "暂存构建：$DoBuild"
Write-Detail "生产重启：$DoRestart"
Write-Detail "预检：$RunChecks"

$stagingDir = $null
try {
  if ($DoBuild) {
    if ($RunChecks) { Invoke-Checks }
    $stagingDir = Join-Path $DistRoot ("npm-package-staging-" + [guid]::NewGuid().ToString("N"))
    $stagingDir = Build-StagedBundle $stagingDir

    if ($DoRestart) {
      Write-Info "暂存构建与验证全部通过；现在停止生产任务实例。"
      Invoke-YepCommand "stop-prod"
    } else {
      $task = Get-ScheduledTask -TaskName "YepAnywhereServer" -ErrorAction SilentlyContinue
      if ($task -and $task.State -eq "Running") {
        throw "生产任务仍在运行；--server-build-only 不允许在线交换 Bundle。"
      }
    }

    Publish-StagedBundle $stagingDir
    $stagingDir = $null
  } elseif ($DoRestart) {
    Invoke-YepCommand "stop-prod"
  }

  if ($DoRestart) {
    Invoke-YepCommand "start-prod"
    Verify-RunningBuild
  }
} catch {
  Write-ErrorMessage "部署失败：$_"
  if ($stagingDir) {
    try { Remove-StagingDirectory $stagingDir } catch { Write-WarningMessage "清理暂存目录失败：$_" }
  }
  exit 1
}

Write-Info "部署完成。"

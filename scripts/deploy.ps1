# Yep Anywhere Windows 暂存构建与生产部署入口（Windows PowerShell 5.1）。

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = [string](Resolve-Path (Join-Path $ScriptDir ".."))
$DistRoot = Join-Path $RepoRoot "dist"
$ProductionDir = Join-Path $DistRoot "npm-package"
$ProductionCli = Join-Path $ProductionDir "dist/cli.js"
$YepScript = Join-Path $ScriptDir "yep.ps1"
$RunProdScript = Join-Path $ScriptDir "run-yepanywhere.ps1"
$VerifyDeployScript = Join-Path $ScriptDir "verify-deploy.mjs"
. (Join-Path $ScriptDir "production-runtime.ps1")
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
$MaintenancePort = ([int]$ServerPort) + 1
$CodexPort = if ($env:YEP_CODEX_BRIDGE_PORT) {
  $env:YEP_CODEX_BRIDGE_PORT
} elseif ($ServiceConfig -and $ServiceConfig.CodexPort) {
  [string]$ServiceConfig.CodexPort
} else {
  "4510"
}
$ClaudePort = if ($env:YEP_CLAUDE_BRIDGE_PORT) {
  $env:YEP_CLAUDE_BRIDGE_PORT
} elseif ($ServiceConfig -and $ServiceConfig.ClaudePort) {
  [string]$ServiceConfig.ClaudePort
} else {
  "4520"
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
$ProductionProfile = if ($env:YEP_ANYWHERE_PROFILE) {
  $env:YEP_ANYWHERE_PROFILE
} elseif ($ServiceConfig -and $ServiceConfig.Profile) {
  [string]$ServiceConfig.Profile
} else {
  $null
}
$ProductionDataDir = if ($env:YEP_ANYWHERE_DATA_DIR) {
  $env:YEP_ANYWHERE_DATA_DIR
} elseif ($ServiceConfig -and $ServiceConfig.DataDir) {
  [string]$ServiceConfig.DataDir
} else {
  $null
}
$ProductionAllowedImagePaths = if ($env:ALLOWED_IMAGE_PATHS) {
  $env:ALLOWED_IMAGE_PATHS
} elseif ($ServiceConfig -and $ServiceConfig.AllowedImagePaths) {
  [string]$ServiceConfig.AllowedImagePaths
} else {
  "$env:TEMP,$env:USERPROFILE\Downloads"
}
$ProductionCodexControlUrl = if ($env:YEP_CODEX_BRIDGE_CONTROL_URL) {
  $env:YEP_CODEX_BRIDGE_CONTROL_URL
} else {
  "http://127.0.0.1:$CodexPort"
}
$ProductionClaudeControlUrl = if ($env:YEP_CLAUDE_BRIDGE_CONTROL_URL) {
  $env:YEP_CLAUDE_BRIDGE_CONTROL_URL
} else {
  "http://127.0.0.1:$ClaudePort"
}
$ProdLogDir = if ($env:YEP_LAUNCHD_LOG_DIR) {
  $env:YEP_LAUNCHD_LOG_DIR
} elseif ($ProductionDataDir) {
  Join-Path $ProductionDataDir "logs"
} else {
  Join-Path $env:USERPROFILE ".yep-anywhere/logs"
}
$ProdStateFile = Join-Path $ProdLogDir "prod-process.json"

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
  $nameAllowed = if ($requiredPrefix -eq "npm-package") {
    $name.Equals("npm-package", [StringComparison]::OrdinalIgnoreCase)
  } else {
    $name.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)
  }
  if (-not $nameAllowed) {
    throw "拒绝操作名称异常的目录：$full"
  }
  return $full
}

function Get-DeploymentInspection($bundlePath) {
  $safeBundle = Assert-ManagedDistPath $bundlePath "npm-package"
  $buildInfoPath = Join-Path $safeBundle "build-info.json"
  $mainPids = @()
  $maintenancePids = @()
  if (-not (Test-Path -LiteralPath $buildInfoPath)) {
    if (-not (Test-Path -LiteralPath $ProdStateFile)) {
      $mainPids = @(Get-YepListeningPids -Port ([int]$ServerPort))
      $maintenancePids = @(Get-YepListeningPids -Port $MaintenancePort)
      if ($mainPids.Count -eq 0 -and $maintenancePids.Count -eq 0) {
        return [pscustomobject]@{ State = "stopped"; Reasons = @("manifest-missing") }
      }
      return [pscustomobject]@{
        State = "unknown-conflict"
        Reasons = @("unknown-port-owner")
        UnknownPortOwners = @($mainPids + $maintenancePids)
      }
    }
    $buildId = "bundle-missing"
  } else {
    try {
      $buildId = Get-YepBundleBuildId -BundlePath $safeBundle
    } catch {
      $mainPids = @(Get-YepListeningPids -Port ([int]$ServerPort))
      $maintenancePids = @(Get-YepListeningPids -Port $MaintenancePort)
      if ($mainPids.Count -gt 0 -or $maintenancePids.Count -gt 0) {
        return [pscustomobject]@{
          State = "unknown-conflict"
          Reasons = @("build-mismatch", "unknown-port-owner")
          UnknownPortOwners = @($mainPids + $maintenancePids)
        }
      }
      throw
    }
  }
  $expectation = New-YepProductionExpectation `
    -RepoRoot $RepoRoot `
    -BundlePath $safeBundle `
    -BuildId $buildId `
    -BasePath $ServerBasePath `
    -Profile $ProductionProfile `
    -DataDir $ProductionDataDir `
    -AllowedImagePaths $ProductionAllowedImagePaths `
    -ServerPort ([int]$ServerPort) `
    -MaintenancePort $MaintenancePort `
    -CodexPort ([int]$CodexPort) `
    -ClaudePort ([int]$ClaudePort) `
    -CodexControlUrl $ProductionCodexControlUrl `
    -ClaudeControlUrl $ProductionClaudeControlUrl `
    -StartBridges ($env:YEP_START_BRIDGES -ne "false") `
    -RunScriptPath $RunProdScript
  return Get-YepProductionInspection -ManifestPath $ProdStateFile -Expectation $expectation
}

function Assert-ProductionIdle {
  $workersUrl = "$ServerBaseUrl/api/status/workers"
  try {
    $workers = Invoke-RestMethod -Uri $workersUrl -Method Get -TimeoutSec 5 -ErrorAction Stop
  } catch {
    throw "无法确认当前生产服务是否有执行中的 AI 回合；拒绝停机：$workersUrl：$_"
  }
  if ((-not (Test-YepProperty $workers 'activeWorkers')) -or (-not (Test-YepInteger $workers.activeWorkers)) -or
      (-not (Test-YepProperty $workers 'queueLength')) -or (-not (Test-YepInteger $workers.queueLength)) -or
      (-not (Test-YepProperty $workers 'hasActiveWork')) -or ($workers.hasActiveWork -isnot [bool])) {
    throw "生产 /api/status/workers 返回无效 readiness payload；拒绝停机：$workersUrl"
  }
  if ($workers.hasActiveWork -eq $true -or [int]$workers.queueLength -gt 0) {
    throw "当前仍有 AI 回合或排队消息（hasActiveWork=$($workers.hasActiveWork), queueLength=$($workers.queueLength)）；拒绝部署。"
  }
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

function Start-BundleTransaction($stagingDir, [bool]$RestartOnExchangeFailure) {
  $safeStaging = Assert-ManagedDistPath $stagingDir "npm-package-staging-"
  $safeProduction = Assert-ManagedDistPath $ProductionDir "npm-package"
  $rollbackDir = Assert-ManagedDistPath (Join-Path $DistRoot ("npm-package-rollback-" + [guid]::NewGuid().ToString("N"))) "npm-package-rollback-"
  $movedOld = $false
  $rollbackAvailable = $false
  $previousBuildId = $null

  if (Test-Path -LiteralPath (Join-Path $safeProduction "build-info.json")) {
    try {
      $previousBuildId = Get-YepBundleBuildId -BundlePath $safeProduction
      $rollbackAvailable = $true
    } catch { }
  }

  try {
    if (Test-Path $safeProduction) {
      Move-Item -LiteralPath $safeProduction -Destination $rollbackDir
      $movedOld = $true
    }
    Move-Item -LiteralPath $safeStaging -Destination $safeProduction
  } catch {
    $exchangeError = $_.Exception.Message
    $recoveryErrors = @()
    $restoredOld = $false
    $productionExists = Test-Path -LiteralPath $safeProduction
    $rollbackExists = Test-Path -LiteralPath $rollbackDir
    if ((-not $productionExists) -and $rollbackExists) {
      try {
        Move-Item -LiteralPath $rollbackDir -Destination $safeProduction
        $productionExists = $true
      } catch {
        $recoveryErrors += "恢复旧 Bundle 失败：$($_.Exception.Message)"
      }
    } elseif ($productionExists -and $rollbackExists) {
      $recoveryErrors += "生产目录与旧 Bundle 回滚目录同时存在；已保留现场。"
    } elseif ((-not $productionExists) -and ($movedOld -or $rollbackAvailable)) {
      $recoveryErrors += "旧 Bundle 与生产目录均不存在；无法恢复。"
    }
    if ($rollbackAvailable -and $productionExists) {
      try {
        $restoredOld = [string]::Equals(
          [string](Get-YepBundleBuildId -BundlePath $safeProduction),
          [string]$previousBuildId,
          [StringComparison]::Ordinal
        )
      } catch { $restoredOld = $false }
      if (-not $restoredOld) { $recoveryErrors += "恢复后的生产 Bundle 与原旧 Bundle 不一致。" }
    }
    if ($RestartOnExchangeFailure -and $rollbackAvailable -and $restoredOld) {
      try {
        Invoke-YepCommand "start-prod"
        Verify-RunningBuild -BundlePath $safeProduction
      } catch {
        $recoveryErrors += "恢复旧服务失败：$($_.Exception.Message)"
      }
    }
    if ($recoveryErrors.Count -gt 0) {
      throw "Bundle 交换错误：$exchangeError；交换恢复错误：$($recoveryErrors -join '；')"
    }
    throw "Bundle 交换错误：$exchangeError"
  }

  Write-Info "暂存 Bundle 已交换到生产目录；旧 Bundle 保留到运行验证完成。"
  return [pscustomobject]@{
    ProductionDir = $safeProduction
    RollbackDir = $rollbackDir
    PreviousProductionExisted = $movedOld
    RollbackAvailable = $rollbackAvailable
    NewBuildInfo = Join-Path $safeProduction "build-info.json"
  }
}

function Complete-BundleTransaction($transaction) {
  $safeProduction = Assert-ManagedDistPath $transaction.ProductionDir "npm-package"
  $safeRollback = Assert-ManagedDistPath $transaction.RollbackDir "npm-package-rollback-"
  if (-not (Test-Path -LiteralPath $safeProduction)) {
    throw "提交部署事务时生产 Bundle 不存在：$safeProduction"
  }
  if (Test-Path -LiteralPath $safeRollback) {
    Remove-Item -LiteralPath $safeRollback -Recurse -Force
  }
}

function Restore-BundleTransaction($transaction, $deploymentError) {
  $safeProduction = Assert-ManagedDistPath $transaction.ProductionDir "npm-package"
  $safeRollback = Assert-ManagedDistPath $transaction.RollbackDir "npm-package-rollback-"
  $failedDir = Assert-ManagedDistPath (Join-Path $DistRoot ("npm-package-failed-" + [guid]::NewGuid().ToString("N"))) "npm-package-failed-"
  try {
    Invoke-YepCommand "stop-prod"
    if (Test-Path -LiteralPath $safeProduction) {
      Move-Item -LiteralPath $safeProduction -Destination $failedDir
    }
    if (-not $transaction.RollbackAvailable) {
      Write-WarningMessage "原始部署错误：$deploymentError"
      Write-WarningMessage "没有可回滚的旧 Bundle；失败的新 Bundle 已保留在 $failedDir，生产服务保持停止。"
      return
    }
    if (-not (Test-Path -LiteralPath $safeRollback)) {
      throw "旧 Bundle 回滚目录不存在：$safeRollback"
    }
    Move-Item -LiteralPath $safeRollback -Destination $safeProduction
    Invoke-YepCommand "start-prod"
    Verify-RunningBuild -BundlePath $safeProduction
    Write-WarningMessage "原始部署错误：$deploymentError"
    Write-WarningMessage "已自动恢复并验证旧 Bundle；失败的新 Bundle 保留在 $failedDir。"
  } catch {
    throw "原始部署错误：$deploymentError；回滚错误：$($_.Exception.Message)"
  }
}

function Invoke-YepCommand($command) {
  & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $YepScript $command
  Assert-LastExitCode "yep.ps1 $command"
}

function Verify-RunningBuild($BundlePath = $ProductionDir) {
  $safeBundle = Assert-ManagedDistPath $BundlePath "npm-package"
  $buildInfo = Join-Path $safeBundle "build-info.json"
  if (-not (Test-Path $buildInfo)) { throw "生产 Bundle 缺少 build-info.json" }
  & node $VerifyDeployScript `
    --base-url $ServerBaseUrl `
    --maintenance-url "http://127.0.0.1:$MaintenancePort" `
    --build-info $buildInfo
  Assert-LastExitCode "生产 buildId/readiness 冒烟验证"
}

Write-Info "部署计划"
Write-Detail "暂存构建：$DoBuild"
Write-Detail "生产重启：$DoRestart"
Write-Detail "预检：$RunChecks"

$stagingDir = $null
$cleanupStaging = $false
$transaction = $null
try {
  if ($DoBuild) {
    if ($RunChecks) { Invoke-Checks }
    $stagingDir = Join-Path $DistRoot ("npm-package-staging-" + [guid]::NewGuid().ToString("N"))
    $cleanupStaging = $true
    $stagingDir = Build-StagedBundle $stagingDir

    $inspection = Get-DeploymentInspection $ProductionDir
    if ($inspection.State -eq "unknown-conflict") {
      throw "生产状态为 unknown-conflict；拒绝停止服务或移动 Bundle。"
    }

    if ($DoRestart) {
      $task = Get-ScheduledTask -TaskName "YepAnywhereServer" -ErrorAction SilentlyContinue
      if ($inspection.State -ne "stopped") {
        Write-Info "暂存构建与验证全部通过；正在确认生产服务空闲。"
        Assert-ProductionIdle
      }
      if ($inspection.State -ne "stopped" -or
          ($task -and $task.State -eq "Running") -or
          (Test-Path -LiteralPath $ProductionDir)) {
        Invoke-YepCommand "stop-prod"
      }
    } else {
      $task = Get-ScheduledTask -TaskName "YepAnywhereServer" -ErrorAction SilentlyContinue
      if ($inspection.State -ne "stopped" -or ($task -and $task.State -eq "Running")) {
        throw "生产任务仍在运行；--server-build-only 不允许在线交换 Bundle。"
      }
    }

    $transaction = Start-BundleTransaction $stagingDir $DoRestart
    $cleanupStaging = $false
    $stagingDir = $null
    if (-not $DoRestart) {
      Complete-BundleTransaction $transaction
      $transaction = $null
    }
  } elseif ($DoRestart) {
    $inspection = Get-DeploymentInspection $ProductionDir
    if ($inspection.State -eq "unknown-conflict") {
      throw "生产状态为 unknown-conflict；拒绝停止服务。"
    }
    $task = Get-ScheduledTask -TaskName "YepAnywhereServer" -ErrorAction SilentlyContinue
    if ($inspection.State -ne "stopped") { Assert-ProductionIdle }
    if ($inspection.State -ne "stopped" -or ($task -and $task.State -eq "Running")) {
      Invoke-YepCommand "stop-prod"
    }
  }

  if ($DoRestart) {
    Invoke-YepCommand "start-prod"
    $inspection = Get-DeploymentInspection $ProductionDir
    if ($inspection.State -ne "healthy") {
      throw "生产启动后状态不是 healthy：$($inspection.State)（$(@($inspection.Reasons) -join ',')）"
    }
    $task = Get-ScheduledTask -TaskName "YepAnywhereServer" -ErrorAction SilentlyContinue
    if (-not $task -or $task.State -ne "Running") {
      throw "生产启动后计划任务不是 Running。"
    }
    Verify-RunningBuild -BundlePath $ProductionDir
    if ($transaction) {
      Complete-BundleTransaction $transaction
      $transaction = $null
    }
  }
} catch {
  $deploymentError = $_.Exception.Message
  Write-ErrorMessage "部署失败：$deploymentError"
  if ($transaction) {
    try {
      Restore-BundleTransaction $transaction $deploymentError
    } catch {
      Write-ErrorMessage $_.Exception.Message
    }
  }
  if ($cleanupStaging -and $stagingDir) {
    try { Remove-StagingDirectory $stagingDir } catch { Write-WarningMessage "清理暂存目录失败：$_" }
  }
  exit 1
}

Write-Info "部署完成。"

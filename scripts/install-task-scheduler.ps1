# 为 Yep Anywhere 注册当前用户的生产计划任务。
# 默认启用登录自启动；--manual-only 只保留可人工启动的任务动作。

$ErrorActionPreference = "Stop"

$TaskName = "YepAnywhereServer"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$RunScript = Join-Path $ScriptDir "run-yepanywhere.ps1"
$CliJs = Join-Path $RepoRoot "dist/npm-package/dist/cli.js"
. (Join-Path $ScriptDir "service-config.ps1")
$ServiceConfigPath = if ($env:YEP_SERVICE_CONFIG_PATH) {
  $env:YEP_SERVICE_CONFIG_PATH
} else {
  Join-Path $env:USERPROFILE ".yep-anywhere/service-config.json"
}
$EnableAutostart = $true

foreach ($arg in $args) {
  switch ($arg) {
    "--manual-only" { $EnableAutostart = $false }
    "--enable-autostart" { $EnableAutostart = $true }
    "--no-start" { } # 兼容旧参数；注册任务从不隐式启动当前实例。
    "-h" {
      Write-Host "用法：install-task-scheduler.ps1 [--manual-only|--enable-autostart]"
      exit 0
    }
    "--help" {
      Write-Host "用法：install-task-scheduler.ps1 [--manual-only|--enable-autostart]"
      exit 0
    }
    default {
      Write-Host "错误：未知参数 $arg" -ForegroundColor Red
      exit 2
    }
  }
}

if (-not (Test-Path $CliJs)) {
  Write-Host "错误：未找到生产 Bundle：$CliJs" -ForegroundColor Red
  Write-Host "请先执行重构建，再配置生产计划任务。" -ForegroundColor Red
  exit 1
}

$existingConfig = $null
if (Test-Path $ServiceConfigPath) {
  try {
    $existingConfig = Get-Content -LiteralPath $ServiceConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-ServiceConfigSchema $existingConfig $ServiceConfigPath
  } catch {
    Write-Host "错误：生产服务配置损坏或字段无效：$ServiceConfigPath" -ForegroundColor Red
    exit 1
  }
}

function Get-ConfiguredValue($environmentValue, $propertyName, $defaultValue) {
  if ($null -ne $environmentValue -and [string]$environmentValue -ne "") {
    return [string]$environmentValue
  }
  if ($existingConfig -and $null -ne $existingConfig.$propertyName -and [string]$existingConfig.$propertyName -ne "") {
    return [string]$existingConfig.$propertyName
  }
  return $defaultValue
}

$serviceConfig = [pscustomobject][ordered]@{
  Version = 1
  ServerPort = Get-ConfiguredValue $env:YEP_DEPLOY_PORT "ServerPort" "8022"
  BasePath = Get-ConfiguredValue $env:YEP_DEPLOY_BASE_PATH "BasePath" "/"
  Profile = Get-ConfiguredValue $env:YEP_ANYWHERE_PROFILE "Profile" $null
  DataDir = Get-ConfiguredValue $env:YEP_ANYWHERE_DATA_DIR "DataDir" $null
  AllowedImagePaths = Get-ConfiguredValue $env:ALLOWED_IMAGE_PATHS "AllowedImagePaths" $null
  CodexPort = Get-ConfiguredValue $env:YEP_CODEX_BRIDGE_PORT "CodexPort" "4510"
  ClaudePort = Get-ConfiguredValue $env:YEP_CLAUDE_BRIDGE_PORT "ClaudePort" "4520"
}
try {
  Assert-ServiceConfigSchema $serviceConfig $ServiceConfigPath
} catch {
  Write-Host "错误：生产服务配置字段无效：$_" -ForegroundColor Red
  exit 1
}
$configParent = Split-Path -Parent $ServiceConfigPath
New-Item -ItemType Directory -Force -Path $configParent | Out-Null
$configTemp = "$ServiceConfigPath.tmp.$([guid]::NewGuid().ToString('N'))"
try {
  $configJson = $serviceConfig | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($configTemp, $configJson, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $configTemp -Destination $ServiceConfigPath -Force
} finally {
  if (Test-Path $configTemp) { Remove-Item -LiteralPath $configTemp -Force -ErrorAction SilentlyContinue }
}

if ($ServiceConfigPath.Contains('"')) {
  throw "服务配置路径不能包含双引号：$ServiceConfigPath"
}

$powershellExe = (Get-Command powershell.exe).Source
$argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunScript`" -ConfigPath `"$ServiceConfigPath`""
$action = New-ScheduledTaskAction `
  -Execute $powershellExe `
  -Argument $argument `
  -WorkingDirectory $RepoRoot
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

$register = @{
  TaskName = $TaskName
  Action = $action
  Settings = $settings
  Principal = $principal
  Force = $true
}
if ($EnableAutostart) {
  $register.Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
}

Register-ScheduledTask @register | Out-Null

if ($EnableAutostart) {
  Write-Host "已启用生产模式登录自启动：$TaskName" -ForegroundColor Green
} else {
  Write-Host "已注册生产任务（登录自启动关闭）：$TaskName" -ForegroundColor Green
}
Write-Host "任务动作：$RunScript" -ForegroundColor DarkGray
Write-Host "注册操作不会启动或停止当前生产实例。" -ForegroundColor DarkGray

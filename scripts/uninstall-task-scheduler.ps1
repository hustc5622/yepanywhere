# 关闭 Yep Anywhere 生产模式登录自启动，但保留可人工启动的任务动作。

$ErrorActionPreference = "Stop"

$TaskName = "YepAnywhereServer"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$InstallScript = Join-Path $ScriptDir "install-task-scheduler.ps1"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "生产模式登录自启动已经关闭；计划任务尚未安装。" -ForegroundColor Yellow
  exit 0
}

$powershellExe = (Get-Command powershell.exe).Source
& $powershellExe -NoProfile -ExecutionPolicy Bypass -File $InstallScript --manual-only
if ($LASTEXITCODE -ne 0) {
  throw "关闭登录自启动失败，退出码：$LASTEXITCODE"
}

Write-Host "已关闭生产模式登录自启动，当前生产实例未停止。" -ForegroundColor Green

# YepAnywhereServer 计划任务的常驻 watchdog（Windows PowerShell 5.1）。

param([string]$ConfigPath)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RunScript = Join-Path $ScriptDir "run-yepanywhere.ps1"
$PowerShellExe = (Get-Command powershell.exe).Source

while ($true) {
  try {
    & $PowerShellExe `
      -NoProfile `
      -ExecutionPolicy Bypass `
      -WindowStyle Hidden `
      -File $RunScript `
      -ConfigPath $ConfigPath
  } catch {
    Write-Host "[Yep Anywhere] watchdog 启动生产监督器失败：$_" -ForegroundColor Red
  }
  Start-Sleep -Seconds 5
}

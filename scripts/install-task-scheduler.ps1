# Install a Windows Scheduled Task that starts Yep Anywhere at user logon.
#
# Windows counterpart of scripts/install-launchagents.sh (macOS LaunchAgent).
# The LaunchAgent runs with RunAtLoad + KeepAlive in the user's gui domain; here
# we use a logon-triggered Scheduled Task scoped to the current user, with
# "restart on failure" to approximate launchd's KeepAlive.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-task-scheduler.ps1
#   (optionally with --no-start to register without starting immediately)

$ErrorActionPreference = "Stop"

$TaskName = "YepAnywhereServer"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$RunScript = Join-Path $ScriptDir "run-yepanywhere.ps1"
$CliJs = Join-Path $RepoRoot "dist/npm-package/dist/cli.js"
$StartNow = $true

foreach ($a in $args) {
  if ($a -eq "--no-start") { $StartNow = $false }
  elseif ($a -eq "-h" -or $a -eq "--help") {
    Write-Host "Install Yep Anywhere logon Scheduled Task.`nOptions:`n  --no-start   Register without starting the task immediately"
    exit 0
  }
}

if (-not (Test-Path $CliJs)) {
  Write-Host "ERROR: bundled CLI not found at $CliJs" -ForegroundColor Red
  Write-Host "Run 'pnpm build:bundle' (or 'pnpm deploy --server-only') once to build dist/npm-package, then retry." -ForegroundColor Red
  exit 1
}

$psExe = (Get-Command powershell).Source
$argString = "-NoProfile -ExecutionPolicy Bypass -File `"$RunScript`" -WaitForServer"

$action = New-ScheduledTaskAction -Execute $psExe -Argument $argString -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)

# Current user principal (like macOS gui/<uid> domain). Start the task on demand
# so the user doesn't have to log off/on to get the server running.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "==> Installed Scheduled Task '$TaskName' (logon trigger, current user)." -ForegroundColor Green
Write-Host "    launches: $RunScript" -ForegroundColor DarkGray
Write-Host "    logs:     $env:USERPROFILE\.yep-anywhere\logs\*.log" -ForegroundColor DarkGray

if ($StartNow) {
  Write-Host "==> Starting task now ..." -ForegroundColor Green
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "    Task started. The server will launch in the background." -ForegroundColor DarkGray
}

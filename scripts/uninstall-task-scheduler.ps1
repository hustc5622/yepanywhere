# Uninstall the Yep Anywhere logon Scheduled Task (Windows counterpart of
# scripts/uninstall-launchagents.sh). Stops and removes the task; the running
# server processes are left untouched (stop them separately if desired).

$ErrorActionPreference = "Stop"

$TaskName = "YepAnywhereServer"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "No Scheduled Task named '$TaskName' is installed; nothing to do." -ForegroundColor Yellow
  exit 0
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "==> Uninstalled Scheduled Task '$TaskName'." -ForegroundColor Green
Write-Host "    Note: any already-running server/bridge processes were not killed." -ForegroundColor DarkGray

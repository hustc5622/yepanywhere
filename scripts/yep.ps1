# Yep Anywhere ops helper for Windows - functional counterpart of the macOS yep.sh.
#
# Provides the same service-management subcommands yep.sh exposes on macOS:
#   status / start-dev / start-prod / stop / restart-dev / restart-prod /
#   rebuild / enable-autostart / disable-autostart / help
#
# How it maps to macOS:
#   macOS yep.sh drives launchd (LaunchAgent) and uses lsof/ps/pkill.
#   Windows yep.ps1 drives detached background processes (scripts/run-yepanywhere.ps1
#   for prod, `pnpm dev` for dev) and a logon Scheduled Task
#   (scripts/install-task-scheduler.ps1) for autostart.
#
# Port layout matches yep.sh exactly:
#   Dev:    main 3400, maintenance 3401, Vite 3402
#   Prod:   8022 (Bundle entry dist/npm-package/dist/cli.js)
#   Bridges: Codex 4510, Claude 4520
#
# The in-app deploy/restart paths do NOT depend on this file; it is a developer
# convenience kept parallel to yep.sh. The macOS scripts are untouched.
#
# Usage:
#   powershell scripts/yep.ps1                 # interactive menu
#   powershell scripts/yep.ps1 status
#   powershell scripts/yep.ps1 start-dev [--fg|--bg]
#   powershell scripts/yep.ps1 start-prod
#   powershell scripts/yep.ps1 stop
#   powershell scripts/yep.ps1 restart-dev
#   powershell scripts/yep.ps1 restart-prod
#   powershell scripts/yep.ps1 rebuild
#   powershell scripts/yep.ps1 enable-autostart
#   powershell scripts/yep.ps1 disable-autostart
#   powershell scripts/yep.ps1 help

$ErrorActionPreference = "Stop"

# Prefer PowerShell 7 (pwsh) if present, otherwise fall back to Windows PowerShell 5.1.
$PwshExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")

# ---- Port layout (identical to yep.sh) ----
$DevMainPort   = if ($env:YEP_DEV_PORT)   { $env:YEP_DEV_PORT }   else { "3400" }
$DevMaintPort  = if ($env:YEP_DEV_MAINT_PORT) { $env:YEP_DEV_MAINT_PORT } else { "3401" }
$DevVitePort   = if ($env:YEP_DEV_VITE_PORT)  { $env:YEP_DEV_VITE_PORT }  else { "3402" }
$ServerPort    = if ($env:YEP_DEPLOY_PORT) { $env:YEP_DEPLOY_PORT } else { "8022" }
$CodexPort     = if ($env:YEP_CODEX_BRIDGE_PORT)  { $env:YEP_CODEX_BRIDGE_PORT }  else { "4510" }
$ClaudePort    = if ($env:YEP_CLAUDE_BRIDGE_PORT) { $env:YEP_CLAUDE_BRIDGE_PORT } else { "4520" }

$TaskName = "YepAnywhereServer"
$LogDir   = if ($env:YEP_LAUNCHD_LOG_DIR) { $env:YEP_LAUNCHD_LOG_DIR } else { Join-Path $env:USERPROFILE ".yep-anywhere/logs" }

function log($m)  { Write-Host "==> $m" -ForegroundColor Green }
function warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function dim($m)  { Write-Host "    $m" -ForegroundColor DarkGray }

function Get-ListeningPids($port) {
  $pids = @()
  $lines = netstat -ano -p TCP 2>$null
  foreach ($line in $lines) {
    if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      if ($matches[1] -eq $port) { $pids += [int]$matches[2] }
    }
  }
  return ($pids | Sort-Object -Unique)
}

function Stop-Pids($pids, $label) {
  foreach ($procId in $pids) {
    try {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      dim "killed $label PID $procId"
    } catch { dim "failed to kill PID $procId : $_" }
  }
}

function Ensure-LogDir {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

function Cmd-Status {
  log "Service status"
  dim "Ports: dev main=$DevMainPort maint=$DevMaintPort vite=$DevVitePort | prod=$ServerPort | codex=$CodexPort claude=$ClaudePort"
  ""
  $ports = @(
    @($DevMainPort,  "Dev main server"),
    @($DevMaintPort, "Dev maintenance server"),
    @($DevVitePort,  "Vite dev server"),
    @($ServerPort,   "Production server (Bundle)"),
    @($CodexPort,    "Codex bridge"),
    @($ClaudePort,   "Claude bridge")
  )
  foreach ($p in $ports) {
    $port = $p[0]; $name = $p[1]
    $pids = Get-ListeningPids $port
    if ($pids.Count -gt 0) { dim "$name : LISTENING on :$port (PID $($pids -join ','))" }
    else { warn "$name : not listening on :$port" }
  }
  ""
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $state = if ($info) { $info.LastTaskResult } else { "n/a" }
    dim "autostart task '$TaskName' : installed (last result $state)"
  } else {
    warn "autostart task '$TaskName' : not installed"
  }
  ""
  dim "Logs:"
  dim "  prod/server:     $LogDir\server.out.log / server.err.log"
  dim "  dev console:     $LogDir\dev-console.out.log / dev-console.err.log"
}

function Cmd-Stop {
  log "Stopping all Yep Anywhere services ..."
  Stop-Pids (Get-ListeningPids $DevMainPort)  "dev-main"
  Stop-Pids (Get-ListeningPids $DevMaintPort) "dev-maint"
  Stop-Pids (Get-ListeningPids $DevVitePort)  "vite"
  Stop-Pids (Get-ListeningPids $ServerPort)   "server"
  Stop-Pids (Get-ListeningPids $CodexPort)    "codex-bridge"
  Stop-Pids (Get-ListeningPids $ClaudePort)   "claude-bridge"
  log "Stop signal sent."
}

function Cmd-StartDev {
  param([string[]]$CommandArgs = @())

  $mode = "bg"
  if ($CommandArgs -contains "--fg") { $mode = "fg" }
  if ($CommandArgs -contains "--bg") { $mode = "bg" }

  if (Get-ListeningPids $DevMainPort) {
    warn "Dev main port $DevMainPort already in use; stopping dev services first ..."
    Stop-Pids (Get-ListeningPids $DevMainPort)  "dev-main"
    Stop-Pids (Get-ListeningPids $DevMaintPort) "dev-maint"
    Stop-Pids (Get-ListeningPids $DevVitePort)  "vite"
    Start-Sleep -Seconds 2
  }

  $env:PORT = $DevMainPort
  if ($mode -eq "fg") {
    log "Starting dev mode in foreground (Ctrl+C to stop). Access http://localhost:$DevMainPort"
    & pnpm dev
  } else {
    Ensure-LogDir
    $outLog = Join-Path $LogDir "dev-console.out.log"
    $errLog = Join-Path $LogDir "dev-console.err.log"
    log "Starting dev mode in background (PORT=$DevMainPort) ..."
    dim "Access: http://localhost:$DevMainPort   Logs: $outLog / $errLog"
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","pnpm dev" `
      -WorkingDirectory $RepoRoot -WindowStyle Hidden `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    Start-Sleep -Seconds 4
    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
      log "Dev started in background (PID $($proc.Id))."
    } else {
      warn "Dev process exited; check $errLog"
    }
  }
}

function Cmd-StartProd {
  if ((Get-ListeningPids $ServerPort).Count -gt 0) {
    warn "Production port $ServerPort is already in use; leaving the running service unchanged."
    return
  }

  log "Starting Yep Anywhere (prod, port $ServerPort) in the background ..."
  & $PwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "run-yepanywhere.ps1")
  dim "Access: http://127.0.0.1:$ServerPort/"
}

function Cmd-RestartDev {
  log "Restarting dev mode (background) ..."
  Stop-Pids (Get-ListeningPids $DevMainPort)  "dev-main"
  Stop-Pids (Get-ListeningPids $DevMaintPort) "dev-maint"
  Stop-Pids (Get-ListeningPids $DevVitePort)  "vite"
  Start-Sleep -Seconds 2
  Cmd-StartDev
}

function Cmd-RestartProd {
  log "Restarting Yep Anywhere (prod) ..."
  & $PwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "deploy.ps1") --restart-only --no-apk
}

function Cmd-Rebuild {
  log "Rebuilding bundle and restarting Yep Anywhere (prod) ..."
  & $PwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "deploy.ps1") --server-only
}

function Cmd-EnableAutostart {
  log "Installing logon Scheduled Task for autostart ..."
  & $PwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "install-task-scheduler.ps1")
}

function Cmd-DisableAutostart {
  log "Removing logon Scheduled Task ..."
  & $PwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "uninstall-task-scheduler.ps1")
}

function Show-Help {
  Write-Host "Yep Anywhere (Windows) - project management helper" -ForegroundColor Cyan
  Write-Host @"

Usage:
  powershell scripts/yep.ps1 [command]

Commands:
  status            Show service / autostart status (all 6 ports)
  start-dev         Start dev mode (port $DevMainPort). Optional: --fg / --bg
  start-prod        Start production server (port $ServerPort, Bundle)
  stop              Stop all services (dev + prod + bridges)
  restart-dev       Restart dev mode (background)
  restart-prod      Restart production server (no rebuild)
  rebuild           Lint + typecheck + build bundle + restart prod
  enable-autostart  Install logon Scheduled Task (auto-start on login)
  disable-autostart Remove the logon Scheduled Task
  help              Show this help

Port layout (matches yep.sh):
  Dev:    main $DevMainPort, maintenance $DevMaintPort, Vite $DevVitePort
  Prod:   $ServerPort (dist/npm-package/dist/cli.js)
  Bridges: Codex $CodexPort, Claude $ClaudePort

Notes:
  - macOS uses yep.sh (launchd-based); this is its Windows equivalent.
  - macOS scripts are unchanged; both platforms are supported.
"@
}

function Show-Menu {
  while ($true) {
    Write-Host ""
    Write-Host "Yep Anywhere (Windows) - choose an action:" -ForegroundColor Cyan
    Write-Host "  1) status            Show service / autostart status"
    Write-Host "  2) start-dev         Start dev mode (port $DevMainPort)"
    Write-Host "  3) start-prod        Start production server (port $ServerPort)"
    Write-Host "  4) stop              Stop all services"
    Write-Host "  5) restart-dev       Restart dev mode"
    Write-Host "  6) restart-prod      Restart production server"
    Write-Host "  7) rebuild           Rebuild bundle and restart"
    Write-Host "  8) enable-autostart  Install logon autostart task"
    Write-Host "  9) disable-autostart Remove logon autostart task"
    Write-Host "  h) help              Show help"
    Write-Host "  q) quit"
    $choice = Read-Host "Selection"
    switch ($choice) {
      "1" { Cmd-Status }
      "2" { Cmd-StartDev }
      "3" { Cmd-StartProd }
      "4" { Cmd-Stop }
      "5" { Cmd-RestartDev }
      "6" { Cmd-RestartProd }
      "7" { Cmd-Rebuild }
      "8" { Cmd-EnableAutostart }
      "9" { Cmd-DisableAutostart }
      "h" { Show-Help }
      "q" { return }
      default { warn "Unknown selection." }
    }
    if ($choice -eq "q") { return }
  }
}

$cmd = if ($args.Count -gt 0) { $args[0] } else { "" }
$commandArgs = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)]) } else { @() }
switch ($cmd) {
  "status"            { Cmd-Status }
  "start-dev"         { Cmd-StartDev -CommandArgs $commandArgs }
  "start-prod"        { Cmd-StartProd }
  "stop"              { Cmd-Stop }
  "restart-dev"       { Cmd-RestartDev }
  "restart-prod"      { Cmd-RestartProd }
  "rebuild"           { Cmd-Rebuild }
  "enable-autostart"  { Cmd-EnableAutostart }
  "disable-autostart" { Cmd-DisableAutostart }
  "help"              { Show-Help }
  ""                  { Show-Menu }
  default {
    warn "Unknown command: $cmd"
    Write-Host "Available: status start-dev start-prod stop restart-dev restart-prod rebuild enable-autostart disable-autostart help"
    exit 2
  }
}

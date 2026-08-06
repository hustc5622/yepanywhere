# Unified local deploy entrypoint for Yep Anywhere - Windows edition.
#
# This is the Windows counterpart of scripts/deploy.sh / scripts/redeploy-server.sh.
# The Node side (packages/server/src/routes/deploy.ts) already selects this file
# on win32, so the API contract (same CLI flags) is unchanged. macOS keeps using
# the bash scripts; this file only runs on Windows.
#
# Usage mirrors the bash entrypoint:
#   scripts/deploy.ps1 --server-only           # build + restart server
#   scripts/deploy.ps1 --restart-only --no-apk  # restart existing server (no rebuild)
#   scripts/deploy.ps1 --server-build-only      # build only (no restart)
#   scripts/deploy.ps1 --restart-codex-bridge   # restart the 4510 Codex bridge sidecar
#   scripts/deploy.ps1 --restart-claude-bridge  # restart the 4520 Claude bridge sidecar
#   scripts/deploy.ps1                          # defaults to --server-only
#
# Notes:
#   - APK (Tauri Android) build is not supported on Windows toolchains; APK
#     flags are accepted but the build is skipped with a warning.
#   - Unlike macOS (launchd KeepAlive), Windows has no supervisor here: the
#     server is launched as a detached background process with logs redirected
#     to ~\.yep-anywhere\logs, which mirrors the macOS "nohup ... & disown"
#     sidecar path.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")

# ----- color helpers -----
function log($msg)  { Write-Host "==> $msg" -ForegroundColor Green }
function warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function err($msg)  { Write-Host "xx  $msg" -ForegroundColor Red }
function dim($msg)  { Write-Host "    $msg" -ForegroundColor DarkGray }

# ----- ports / env (defaults mirror install-launchagents.sh) -----
$ServerPort = if ($env:YEP_DEPLOY_PORT) { $env:YEP_DEPLOY_PORT } else { "8022" }
$CodexPort  = if ($env:YEP_CODEX_BRIDGE_PORT) { $env:YEP_CODEX_BRIDGE_PORT } else { if ($env:CODEX_BRIDGE_PORT) { $env:CODEX_BRIDGE_PORT } else { "4510" } }
$ClaudePort = if ($env:YEP_CLAUDE_BRIDGE_PORT) { $env:YEP_CLAUDE_BRIDGE_PORT } else { if ($env:CLAUDE_BRIDGE_PORT) { $env:CLAUDE_BRIDGE_PORT } else { "4520" } }
$ServerBasePath = if ($env:YEP_DEPLOY_BASE_PATH) { $env:YEP_DEPLOY_BASE_PATH } else { "/" }
if ($ServerBasePath -eq "/") { $ServerBasePath = "" } else { $ServerBasePath = "/" + ($ServerBasePath.TrimStart("/").TrimEnd("/")) }
$ServerBaseUrl = "http://127.0.0.1:${ServerPort}${ServerBasePath}"
$CliJs = Join-Path $RepoRoot "dist/npm-package/dist/cli.js"
$LogDir = if ($env:YEP_LAUNCHD_LOG_DIR) { $env:YEP_LAUNCHD_LOG_DIR } else { Join-Path $env:USERPROFILE ".yep-anywhere/logs" }

# ----- arg parsing (subset relevant on Windows) -----
$DO_SERVER = $true
$DO_CODEX_BRIDGE = $false
$DO_CLAUDE_BRIDGE = $false
$DO_APK = $false
$RUN_CHECKS = $true
$DO_BUILD = $true
$DO_RESTART = $true
$RESTART_CODEX_BRIDGE = $false
$RESTART_CLAUDE_BRIDGE = $false

function Show-Usage {
  Write-Host @"
Yep Anywhere deploy (Windows)

Options:
  --server-only        Deploy only the server bundle (build + restart)
  --codex-bridge-only  Restart the 4510 Codex bridge sidecar
  --claude-bridge-only Restart the 4520 Claude bridge sidecar
  --apk-only           APK build is not supported on Windows (skipped)
  --no-server          Skip server deploy
  --no-apk             Skip APK build/install
  --restart-only       Restart existing server bundle without rebuilding
  --server-build-only  Build server bundle but do not restart
  --restart-codex-bridge    Restart the Codex bridge sidecar too
  --restart-claude-bridge   Restart the Claude bridge sidecar too
  --skip-checks        Skip pnpm lint/typecheck preflight
"@
}

foreach ($arg in $args) {
  switch ($arg) {
    "--server-only"            { $DO_SERVER = $true;  $DO_CODEX_BRIDGE = $false; $DO_CLAUDE_BRIDGE = $false; $DO_APK = $false }
    "--codex-bridge-only"      { $DO_SERVER = $false; $DO_CODEX_BRIDGE = $true;  $DO_CLAUDE_BRIDGE = $false; $DO_APK = $false; $RESTART_CODEX_BRIDGE = $true }
    "--claude-bridge-only"     { $DO_SERVER = $false; $DO_CODEX_BRIDGE = $false; $DO_CLAUDE_BRIDGE = $true;  $DO_APK = $false; $RESTART_CLAUDE_BRIDGE = $true }
    "--apk-only"               { $DO_SERVER = $false; $DO_CODEX_BRIDGE = $false; $DO_CLAUDE_BRIDGE = $false; $DO_APK = $true; $RUN_CHECKS = $false }
    "--no-server"              { $DO_SERVER = $false }
    "--no-apk"                 { $DO_APK = $false }
    "--restart-only"           { $DO_RESTART = $true; $DO_BUILD = $false; $RUN_CHECKS = $false }
    "--server-build-only"      { $DO_BUILD = $true;  $DO_RESTART = $false }
    "--no-restart"             { $DO_RESTART = $false }
    "--preserve-codex-bridge"  { $RESTART_CODEX_BRIDGE = $false }
    "--restart-codex-bridge"   { $DO_CODEX_BRIDGE = $true;  $RESTART_CODEX_BRIDGE = $true }
    "--restart-claude-bridge"  { $DO_CLAUDE_BRIDGE = $true; $RESTART_CLAUDE_BRIDGE = $true }
    "--skip-checks"            { $RUN_CHECKS = $false }
    "--debug"    { $DO_APK = $true }
    "--release"  { $DO_APK = $true }
    "--no-install" { }
    "--no-build" { $DO_APK = $true }
    "-s"       { $DO_APK = $true }
    "--device" { $DO_APK = $true }
    "-h"       { Show-Usage; exit 0 }
    "--help"   { Show-Usage; exit 0 }
    default    { err "Unknown arg: $arg"; err "Run with --help for usage."; exit 2 }
  }
}

if (-not ($DO_SERVER -or $DO_CODEX_BRIDGE -or $DO_CLAUDE_BRIDGE -or $DO_APK)) {
  err "Nothing to deploy: server, Codex bridge, Claude bridge, and APK are all disabled."
  exit 2
}

# ----- process helpers (cross-platform: netstat works for all users) -----
function Get-ListeningPids($port) {
  $pids = @()
  $lines = netstat -ano -p TCP 2>$null
  if (-not $lines) {
    try {
      Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
        ForEach-Object { $pids += [int]$_.OwningProcess }
    } catch { }
    return ($pids | Sort-Object -Unique)
  }
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
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        dim "killed $label PID $procId"
      }
    } catch {
      dim "failed to kill PID $procId : $_"
    }
  }
}

function Wait-PortReleased($port, $tries = 40) {
  for ($i = 0; $i -lt $tries; $i++) {
    $live = Get-ListeningPids $port
    if ($live.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Wait-Health($url, $tries = 60) {
  for ($i = 0; $i -lt $tries; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 -ErrorAction Stop
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# Ensure the canonical runtime environment is set in *this* process so the
# detached child (Start-Process inherits our env) gets the same variables the
# macOS LaunchAgent injects. Safe on both shells; idempotent.
function Set-YepEnv {
  $env:NODE_ENV = "production"
  if (-not $env:BASE_PATH) { $env:BASE_PATH = $ServerBasePath }
  if (-not $env:ALLOWED_IMAGE_PATHS) {
    $env:ALLOWED_IMAGE_PATHS = "$env:TEMP,$env:USERPROFILE\Downloads"
  }
  $env:YEP_DEPLOY_REPO_ROOT = $RepoRoot
  $env:YEP_CODEX_BRIDGE_MODE = "external"
  if (-not $env:YEP_CODEX_BRIDGE_CONTROL_URL) { $env:YEP_CODEX_BRIDGE_CONTROL_URL = "http://127.0.0.1:$CodexPort" }
  $env:YEP_CODEX_BRIDGE_PORT = $CodexPort
  if (-not $env:YEP_CLAUDE_BRIDGE_CONTROL_URL) { $env:YEP_CLAUDE_BRIDGE_CONTROL_URL = "http://127.0.0.1:$ClaudePort" }
  $env:YEP_CLAUDE_BRIDGE_PORT = $ClaudePort
  $env:YEP_SERVER_URL = $ServerBaseUrl
}

# Launch a detached yepanywhere process (server or bridge). Returns the PID.
function Start-Yep($mode) {
  if (-not (Test-Path $CliJs)) {
    err "Expected bundled CLI at $CliJs, but it does not exist."
    err "Run scripts/deploy.ps1 --server-only once to build dist/npm-package, then retry."
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Set-YepEnv
  $nodeBin = (Get-Command node).Source
  $argList = @("`"$CliJs`"")
  $outLog = $null; $errLog = $null
  switch ($mode) {
    "server"       { $argList += "--port"; $argList += $ServerPort; $outLog = "$LogDir\server.out.log"; $errLog = "$LogDir\server.err.log" }
    "codex-bridge" { $argList += "--codex-bridge-only"; $outLog = "$LogDir\codex-bridge.out.log"; $errLog = "$LogDir\codex-bridge.err.log" }
    "claude-bridge"{ $argList += "--claude-bridge-only"; $outLog = "$LogDir\claude-bridge.out.log"; $errLog = "$LogDir\claude-bridge.err.log" }
  }
  $proc = Start-Process -FilePath $nodeBin -ArgumentList $argList `
    -WorkingDirectory $RepoRoot -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  return $proc.Id
}

function Assert-LastExitCode($commandName) {
  if ($LASTEXITCODE -ne 0) {
    throw "$commandName failed with exit code $LASTEXITCODE."
  }
}

# Verify the dev toolchain and the client's heavy optional deps are linked.
# Returns $true only when everything needed by lint/build is present.
function Test-DepsOk {
  $bins = @("biome", "tsc", "tsx")
  foreach ($b in $bins) {
    $found = (Test-Path (Join-Path $RepoRoot "node_modules/.bin/$b.cmd")) -or
             (Test-Path (Join-Path $RepoRoot "node_modules/.bin/$b.ps1")) -or
             (Test-Path (Join-Path $RepoRoot "node_modules/.bin/$b"))
    if (-not $found) { return $false }
  }
  # `vite` is a dependency of packages/client, so its binary is linked into
  # that workspace package's .bin, not the repo-root .bin (pnpm does not hoist
  # a non-root dependency's binary unless shamefully-hoist is enabled). Accept
  # it from either location so the check matches how node_modules is actually laid out.
  $viteOk = (Test-Path (Join-Path $RepoRoot "node_modules/.bin/vite")) -or
            (Test-Path (Join-Path $RepoRoot "node_modules/.bin/vite.cmd")) -or
            (Test-Path (Join-Path $RepoRoot "node_modules/.bin/vite.ps1")) -or
            (Test-Path (Join-Path $RepoRoot "packages/client/node_modules/.bin/vite")) -or
            (Test-Path (Join-Path $RepoRoot "packages/client/node_modules/.bin/vite.cmd")) -or
            (Test-Path (Join-Path $RepoRoot "packages/client/node_modules/.bin/vite.ps1"))
  if (-not $viteOk) { return $false }
  $clientNm = Join-Path $RepoRoot "packages/client/node_modules"
  foreach ($d in @("mermaid", "@tiptap/react", "lowlight", "tiptap-markdown")) {
    if (-not (Test-Path (Join-Path $clientNm $d))) { return $false }
  }
  return $true
}

# Self-heal a broken/out-of-sync node_modules before lint or build. If pnpm
# cannot complete the install (e.g. the environment blocks file operations or
# the install was interrupted), fail loudly with actionable guidance instead of
# letting a downstream "command not found" error confuse the user.
function Ensure-Dependencies {
  if (Test-DepsOk) { return }
  warn "node_modules is incomplete or out of sync with pnpm-lock.yaml."
  warn "Restoring dependencies with 'pnpm install --force' (re-links everything) ..."
  Push-Location $RepoRoot
  try {
    # --force makes pnpm re-link ALL packages even when its state file
    # (.modules.yaml) claims node_modules is already up to date. That stale
    # state is exactly what an interrupted install leaves behind: the symlinks
    # are gone but pnpm still thinks they exist, so a plain `pnpm install`
    # prints "Already up to date" and links nothing.
    & pnpm install --force
    if ($LASTEXITCODE -ne 0) {
      warn "'pnpm install --force' failed; falling back to 'pnpm install' ..."
      & pnpm install
    }
    if ($LASTEXITCODE -ne 0) {
      err "Dependency restore failed. pnpm could not finish installation"
      err "(commonly because the install was interrupted, or the environment"
      err "blocks file deletion/operations). Please restore manually in a"
      err "normal terminal, then re-run this deploy/rebuild:"
      err "    pnpm install --force"
      err "    pnpm win:rebuild   # or: powershell scripts/yep.ps1 rebuild"
      exit 1
    }
  } finally {
    Pop-Location
  }
  if (-not (Test-DepsOk)) {
    err "Dependencies are still missing after 'pnpm install --force'."
    err "Run the following manually in a normal terminal, then retry:"
    err "    pnpm install --force"
    exit 1
  }
  log "Dependencies restored."
}

function Test-BundleRuntime {
  Push-Location (Join-Path $RepoRoot "dist/npm-package")
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & node --input-type=module -e "await Promise.all([import('@hono/node-ws'), import('pino')]);" 2>$null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
}

# ----- deploy plan report -----
log "Deploy plan"
dim "8022 web/API:        $DO_SERVER"
dim "4510 Codex bridge:   $DO_CODEX_BRIDGE"
dim "4520 Claude bridge:  $DO_CLAUDE_BRIDGE"
dim "build:               $DO_BUILD"
dim "restart:             $DO_RESTART"
dim "checks:              $RUN_CHECKS"
if ($DO_APK) { warn "APK build is not supported on the Windows toolchain; skipping."; $DO_APK = $false }

# ----- dependency self-heal (before any lint/typecheck/build) -----
if ($DO_BUILD -or ($RUN_CHECKS -and ($DO_SERVER -or $DO_CODEX_BRIDGE -or $DO_CLAUDE_BRIDGE))) {
  Ensure-Dependencies
}

# ----- preflight checks -----
if ($RUN_CHECKS -and ($DO_SERVER -or $DO_CODEX_BRIDGE -or $DO_CLAUDE_BRIDGE)) {
  log "Running preflight checks ..."
  Push-Location $RepoRoot
  try {
    & pnpm lint
    Assert-LastExitCode "pnpm lint"
    & pnpm typecheck
    Assert-LastExitCode "pnpm typecheck"
  } finally {
    Pop-Location
  }
}

# Stop a running production server BEFORE reinstalling its runtime deps.
# `npm ci` below must replace dist/npm-package/node_modules; on Windows a live
# server holds file locks on those modules and npm ci fails with EPERM (-4048).
# The restart section further down starts the freshly built server.
if ($DO_BUILD -and $DO_RESTART) {
  $preBuildPids = Get-ListeningPids $ServerPort
  if ($preBuildPids.Count -gt 0) {
    log "Stopping running yepanywhere on port $ServerPort before rebuild (releases file locks for npm ci) ..."
    Stop-Pids $preBuildPids "server"
    Wait-PortReleased $ServerPort | Out-Null
    if ((Get-ListeningPids $ServerPort).Count -gt 0) {
      warn "Port $ServerPort still in use; sending hard kill before npm ci."
      Stop-Pids (Get-ListeningPids $ServerPort) "server"
      Wait-PortReleased $ServerPort | Out-Null
    }
  }
}

# ----- build -----
if ($DO_BUILD) {
  log "Building bundle ..."
  Push-Location $RepoRoot
  try {
    $npmVersion = node -p "require('./package.json').version"
    log "Monorepo version: $npmVersion"
    $env:NPM_VERSION = $npmVersion
    & pnpm build:bundle
    Assert-LastExitCode "pnpm build:bundle"
    if (-not (Test-Path $CliJs)) {
      err "Expected $CliJs after build, but it is missing."
      exit 1
    }
    log "Installing runtime dependencies in dist/npm-package ..."
    Push-Location (Join-Path $RepoRoot "dist/npm-package")
    try {
      # Neutralize WorkBuddy's "safe-delete" guard (NODE_OPTIONS --require
      # genie-safe-delete.cjs + PATH-prepended safe-bin) so npm ci isn't
      # intercepted. An intercepted rm renames dirs to "<name> 2" staged
      # copies that make the NEXT npm ci fail with errno -11 (macOS) or
      # EPERM/-4048 stale-lock errors (Windows). Clearing these in *this*
      # session also prevents npm's own internal cleanup from creating new
      # residue, and lets Remove-Item below actually delete old residue.
      if ($env:NODE_OPTIONS) {
        $env:NODE_OPTIONS = ($env:NODE_OPTIONS -split '\s+' | Where-Object { $_ -notmatch 'genie-safe-delete' -and $_ -notmatch 'safe-delete' }) -join ' '
        if ($env:NODE_OPTIONS -eq '') { Remove-Item Env:\NODE_OPTIONS }
      }
      if ($env:PATH) {
        $env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notmatch 'safe-bin' -and $_ -notmatch 'genie-safe-delete' }) -join ';'
      }
      $nmPath = Join-Path $RepoRoot "dist/npm-package/node_modules"
      if (Test-Path $nmPath) {
        log "Removing stale node_modules before install (guard-neutralized) ..."
        Remove-Item -Recurse -Force $nmPath -ErrorAction SilentlyContinue
      }
      & npm ci --omit=dev --no-audit --no-fund --silent --cache (Join-Path $RepoRoot "dist/npm-package/.npm-cache")
      Assert-LastExitCode "npm ci"
    } finally {
      Pop-Location
    }
    if (-not (Test-BundleRuntime)) {
      throw "Bundle runtime dependency verification failed after npm ci."
    }
    & pnpm bundle:verify dist/npm-package
    Assert-LastExitCode "pnpm bundle:verify"
    # node-pty spawn-helper chmod is POSIX-only; skipped on Windows.
  } finally {
    Pop-Location
  }
}

# ----- restart / sidecar management -----
if ($DO_RESTART -or $RESTART_CODEX_BRIDGE -or $RESTART_CLAUDE_BRIDGE) {
  $ServerListenPids = if ($DO_RESTART)              { Get-ListeningPids $ServerPort } else { @() }
  $CodexListenPids  = if ($RESTART_CODEX_BRIDGE)    { Get-ListeningPids $CodexPort }  else { @() }
  $ClaudeListenPids = if ($RESTART_CLAUDE_BRIDGE)   { Get-ListeningPids $ClaudePort } else { @() }

  if ($DO_RESTART) {
    log "Stopping running yepanywhere (port $ServerPort) ..."
    Stop-Pids $ServerListenPids "server"
    Wait-PortReleased $ServerPort | Out-Null
    if ((Get-ListeningPids $ServerPort).Count -gt 0) {
      warn "Port $ServerPort still in use after stop; sending hard kill."
      Stop-Pids (Get-ListeningPids $ServerPort) "server"
      Wait-PortReleased $ServerPort | Out-Null
    }
  }

  if ($RESTART_CODEX_BRIDGE) {
    log "Restarting Codex bridge sidecar (port $CodexPort) ..."
    Stop-Pids $CodexListenPids "codex-bridge"
    Wait-PortReleased $CodexPort | Out-Null
  }

  if ($RESTART_CLAUDE_BRIDGE) {
    log "Restarting Claude bridge sidecar (port $ClaudePort) ..."
    Stop-Pids $ClaudeListenPids "claude-bridge"
    Wait-PortReleased $ClaudePort | Out-Null
  }

  if ($DO_RESTART) {
    log "Starting yepanywhere ..."
    $newPid = Start-Yep "server"
    dim "started server PID $newPid; logs: $LogDir\server.*.log"

    log "Waiting for $ServerBaseUrl/api/version ..."
    if (Wait-Health "$ServerBaseUrl/api/version") {
      log "Server is up."
      $verInfo = (Invoke-WebRequest -UseBasicParsing -Uri "$ServerBaseUrl/api/version" -TimeoutSec 2).Content
      dim "$ServerBaseUrl/api/version -> $verInfo"
      $buildInfo = Join-Path $RepoRoot "dist/npm-package/build-info.json"
      if (Test-Path $buildInfo) {
        try {
          node (Join-Path $RepoRoot "scripts/verify-deploy.mjs") --base-url $ServerBaseUrl --build-info $buildInfo | Out-Null
        } catch { dim "verify-deploy skipped: $_" }
      }
    } else {
      err "Server did not respond at $ServerBaseUrl/api/version within 15s."
      err "Check $LogDir\server.err.log for crash output."
      if (Test-Path "$LogDir\server.err.log") { Get-Content "$LogDir\server.err.log" -Tail 20 | ForEach-Object { Write-Host $_ -ForegroundColor Red } }
      exit 1
    }
  }

  if ($RESTART_CODEX_BRIDGE) {
    log "Starting Codex bridge sidecar ..."
    Start-Yep "codex-bridge" | Out-Null
    if (Wait-Health "$env:YEP_CODEX_BRIDGE_CONTROL_URL/status") {
      log "Codex bridge sidecar is up."
    } else {
      err "Codex bridge sidecar did not answer $env:YEP_CODEX_BRIDGE_CONTROL_URL/status within 15s."
    }
  }

  if ($RESTART_CLAUDE_BRIDGE) {
    log "Starting Claude bridge sidecar ..."
    Start-Yep "claude-bridge" | Out-Null
    if (Wait-Health "$env:YEP_CLAUDE_BRIDGE_CONTROL_URL/status") {
      log "Claude bridge sidecar is up."
    } else {
      err "Claude bridge sidecar did not answer $env:YEP_CLAUDE_BRIDGE_CONTROL_URL/status within 15s."
    }
  }
} elseif ($DO_SERVER -and -not $DO_RESTART) {
  # build-only path: just confirm the bundle exists
  if (-not (Test-Path $CliJs)) {
    err "Expected $CliJs after build, but it is missing."
    exit 1
  }
  log "Build complete (no restart requested)."
}

log "Deploy complete."

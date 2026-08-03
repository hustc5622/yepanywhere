# Canonical Windows launcher for Yep Anywhere server (+ optional bridges).
#
# This is the Windows counterpart of the macOS LaunchAgent program
# (scripts/install-launchagents.sh writes a plist that runs
# `node dist/npm-package/dist/cli.js --port 8022`). It is invoked by:
#   - the logon Scheduled Task installed via install-task-scheduler.ps1
#   - (and can be run manually to start the server in the background)
#
# Each component is launched as a detached, hidden background process with logs
# redirected to ~\.yep-anywhere\logs, mirroring macOS launchd stdout/stderr logs.
# There is no KeepAlive supervisor on Windows; the Scheduled Task's
# "restart on failure" setting approximates launchd's KeepAlive.

param([switch]$WaitForServer)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")

$ServerPort = if ($env:YEP_DEPLOY_PORT) { $env:YEP_DEPLOY_PORT } else { "8022" }
$CodexPort  = if ($env:YEP_CODEX_BRIDGE_PORT) { $env:YEP_CODEX_BRIDGE_PORT } else { if ($env:CODEX_BRIDGE_PORT) { $env:CODEX_BRIDGE_PORT } else { "4510" } }
$ClaudePort = if ($env:YEP_CLAUDE_BRIDGE_PORT) { $env:YEP_CLAUDE_BRIDGE_PORT } else { if ($env:CLAUDE_BRIDGE_PORT) { $env:CLAUDE_BRIDGE_PORT } else { "4520" } }
$ServerBasePath = if ($env:YEP_DEPLOY_BASE_PATH) { $env:YEP_DEPLOY_BASE_PATH } else { "/" }
if ($ServerBasePath -eq "/") { $ServerBasePath = "" } else { $ServerBasePath = "/" + ($ServerBasePath.TrimStart("/").TrimEnd("/")) }
$ServerBaseUrl = "http://127.0.0.1:${ServerPort}${ServerBasePath}"
$CliJs = Join-Path $RepoRoot "dist/npm-package/dist/cli.js"
$LogDir = if ($env:YEP_LAUNCHD_LOG_DIR) { $env:YEP_LAUNCHD_LOG_DIR } else { Join-Path $env:USERPROFILE ".yep-anywhere/logs" }

function Write-YepLog($msg) { Write-Host "[yepanywhere] $msg" }

if (-not (Test-Path $CliJs)) {
  Write-YepLog "ERROR: bundled CLI not found at $CliJs"
  Write-YepLog "Run 'pnpm build:bundle' (or 'pnpm deploy --server-only') once to build dist/npm-package, then retry."
  exit 1
}

# Ensure runtime dependencies are installed (mirrors yep.sh ensure_runtime_dependencies).
# Uses --ignore-scripts so the cross-platform postinstall (a no-op on Windows) is skipped.
$BundleDir = Join-Path $RepoRoot "dist/npm-package"

function Test-RuntimeDependencies {
  if (-not (Test-Path (Join-Path $BundleDir "node_modules"))) { return $false }

  Push-Location $BundleDir
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Import both the web server integration and logger. They exercise the
    # transitive dependencies that previously let a partial npm install pass.
    $ErrorActionPreference = "Continue"
    & node --input-type=module -e "await Promise.all([import('@hono/node-ws'), import('pino')]);" 2>$null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
}

function Ensure-RuntimeDependencies {
  if (Test-RuntimeDependencies) { return }

  Write-YepLog "Runtime dependencies are missing or incomplete; reinstalling with npm ci ..."
  Push-Location $BundleDir
  try {
    & npm ci --omit=dev --no-audit --no-fund --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-RuntimeDependencies)) {
    throw "Bundle runtime dependency verification failed after npm ci."
  }
}

Ensure-RuntimeDependencies

# Inject the same runtime env the macOS LaunchAgent provides.
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

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$nodeBin = (Get-Command node).Source

function Start-Detached($mode, $outLog, $errLog, $extraArgs) {
  $argList = @("`"$CliJs`"") + $extraArgs
  $proc = Start-Process -FilePath $nodeBin -ArgumentList $argList `
    -WorkingDirectory $RepoRoot -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  return $proc.Id
}

function Test-ListeningPort($port) {
  try {
    return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop).Count -gt 0
  } catch {
    return $false
  }
}

if (Test-ListeningPort $ServerPort) {
  Write-YepLog "Server port $ServerPort is already listening; leaving it unchanged."
  $serverPid = $null
} else {
  Write-YepLog "Starting server on port $ServerPort (logs: $LogDir) ..."
  $serverPid = Start-Detached "server" "$LogDir\server.out.log" "$LogDir\server.err.log" @("--port", $ServerPort)
  Write-YepLog "server PID $serverPid -> $ServerBaseUrl"
}

# Bridges are started by default, mirroring macOS install-launchagents.sh.
if ($env:YEP_START_BRIDGES -ne "false") {
  if (Test-ListeningPort $CodexPort) {
    Write-YepLog "Codex bridge port $CodexPort is already listening; leaving it unchanged."
  } else {
    Write-YepLog "Starting Codex bridge on port $CodexPort ..."
    $codexPid = Start-Detached "codex-bridge" "$LogDir\codex-bridge.out.log" "$LogDir\codex-bridge.err.log" @("--codex-bridge-only")
    Write-YepLog "codex bridge PID $codexPid"
  }

  if (Test-ListeningPort $ClaudePort) {
    Write-YepLog "Claude bridge port $ClaudePort is already listening; leaving it unchanged."
  } else {
    Write-YepLog "Starting Claude bridge on port $ClaudePort ..."
    $claudePid = Start-Detached "claude-bridge" "$LogDir\claude-bridge.out.log" "$LogDir\claude-bridge.err.log" @("--claude-bridge-only")
    Write-YepLog "claude bridge PID $claudePid"
  }
} else {
  Write-YepLog "Bridges disabled (YEP_START_BRIDGES=false); starting server only."
}

Write-YepLog "Done. Processes are detached and will keep running after this script exits."
if ($WaitForServer -and $serverPid) {
  Wait-Process -Id $serverPid
  exit 1
}
exit 0

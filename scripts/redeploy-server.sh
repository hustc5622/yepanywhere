#!/usr/bin/env bash
# Rebuild the yepanywhere server bundle from the monorepo and restart the
# running server process so the new code takes effect.
#
# Usage:
#   scripts/redeploy-server.sh           # full rebuild + restart 8022, preserve Codex bridge
#   scripts/redeploy-server.sh --restart # restart only (skip rebuild)
#   scripts/redeploy-server.sh --no-restart # rebuild only (skip restart)
#   scripts/redeploy-server.sh --preserve-codex-bridge
#                                      # explicit default: keep 4510 as sidecar
#   scripts/redeploy-server.sh --restart-codex-bridge
#                                      # restart the 4510 Codex bridge sidecar too
#   scripts/redeploy-server.sh --no-restart --restart-codex-bridge
#                                      # rebuild + restart only the 4510 sidecar
#   scripts/redeploy-server.sh --embedded-codex-bridge
#                                      # legacy: run 4510 inside 8022
#   scripts/redeploy-server.sh --allow-yep-session-interrupt
#                                      # force 8022 cutover even with active work
#
# Assumes:
#   - You want to keep the relay process and frp tunnel running. This script
#     only touches the yepanywhere server itself.
#
# Side effects of restart:
#   - APK / web clients disconnect for ~3-5s (auto-reconnect, no relogin).
#   - In-progress SDK sessions (running claude subprocesses) are killed.
#   - 4510 Codex bridge sessions are preserved by default. If 4510 is still
#     embedded in the 8022 process, preserving it while restarting 8022 is
#     impossible; choose --restart-codex-bridge to migrate/restart it.
#   - Persisted session jsonl is unaffected.

set -euo pipefail

# Resolve repo root from script location so this works no matter where it's invoked.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Color helpers (skipped if not a tty).
if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

log()  { echo -e "${C_GREEN}==>${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!!${C_RESET}  $*" >&2; }
err()  { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim()  { echo -e "${C_DIM}    $*${C_RESET}"; }

# shellcheck source=scripts/lib/node.sh
source "$SCRIPT_DIR/lib/node.sh"
# shellcheck source=scripts/lib/pnpm.sh
source "$SCRIPT_DIR/lib/pnpm.sh"
# shellcheck source=scripts/lib/deploy-lock.sh
source "$SCRIPT_DIR/lib/deploy-lock.sh"
# shellcheck source=scripts/lib/deploy-npm.sh
source "$SCRIPT_DIR/lib/deploy-npm.sh"

# ----- args -----
DO_BUILD=true
DO_RESTART=true
USE_CODEX_BRIDGE_SIDECAR=true
RESTART_CODEX_BRIDGE=false
ALLOW_YEP_SESSION_INTERRUPT=false
SERVER_PORT="${YEP_DEPLOY_PORT:-8022}"
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/yep}"
SERVER_ALLOWED_IMAGE_PATHS="${ALLOWED_IMAGE_PATHS:-/tmp,$HOME/Downloads}"
if [[ "$SERVER_BASE_PATH" == "/" ]]; then
  SERVER_BASE_PATH=""
else
  SERVER_BASE_PATH="/${SERVER_BASE_PATH#/}"
  SERVER_BASE_PATH="${SERVER_BASE_PATH%/}"
fi
SERVER_BASE_URL="http://127.0.0.1:${SERVER_PORT}${SERVER_BASE_PATH}"
SERVER_LAUNCHD_LABEL="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
SERVER_LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${SERVER_LAUNCHD_LABEL}.plist"
SERVER_LAUNCHD_LOG_DIR="${YEP_LAUNCHD_LOG_DIR:-$HOME/.yep-anywhere/logs}"
SERVER_CLI_JS="$REPO_ROOT/dist/npm-package/dist/cli.js"
LAUNCHD_RUNTIME_DIR="${YEP_LAUNCHD_RUNTIME_DIR:-$HOME/.yep-anywhere/runtime/npm-package}"
LAUNCHD_SERVER_CLI_JS="$LAUNCHD_RUNTIME_DIR/dist/cli.js"
CODEX_BRIDGE_LAUNCHD_LABEL="${YEP_LAUNCHD_BRIDGE_LABEL:-com.yueyuan.yepanywhere.codex-bridge}"
CODEX_BRIDGE_LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${CODEX_BRIDGE_LAUNCHD_LABEL}.plist"
for arg in "$@"; do
  case "$arg" in
    --restart)    DO_BUILD=false ;;
    --no-restart) DO_RESTART=false ;;
    --preserve-codex-bridge)
      USE_CODEX_BRIDGE_SIDECAR=true
      RESTART_CODEX_BRIDGE=false
      ;;
    --restart-codex-bridge)
      USE_CODEX_BRIDGE_SIDECAR=true
      RESTART_CODEX_BRIDGE=true
      ;;
    --allow-yep-session-interrupt)
      ALLOW_YEP_SESSION_INTERRUPT=true
      ;;
    --embedded-codex-bridge|--no-preserve-codex-bridge)
      USE_CODEX_BRIDGE_SIDECAR=false
      RESTART_CODEX_BRIDGE=true
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      err "Unknown arg: $arg"
      exit 2
      ;;
  esac
done

# ----- preflight -----
acquire_deploy_lock
ensure_project_node

# Pull version from the monorepo root package.json so the bundle reports the
# real version (build-bundle.ts otherwise falls back to a hardcoded string).
NPM_VERSION="$(node -p "require('./package.json').version")"
log "Monorepo version: ${NPM_VERSION}"

pid_sets_overlap() {
  local a="$1"
  local b="$2"
  local left right
  for left in $a; do
    for right in $b; do
      if [[ "$left" == "$right" ]]; then
        return 0
      fi
    done
  done
  return 1
}

server_activity_state() {
  local response

  if ! lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    printf '%s' "stopped"
    return 0
  fi
  if ! response="$(curl -fsS --max-time 3 "${SERVER_BASE_URL}/api/status/workers" 2>/dev/null)"; then
    printf '%s' "unknown"
    return 0
  fi

  printf '%s' "$response" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(raw);
    const active = data.runtimeMode !== "external" &&
      (data.hasActiveWork === true || Number(data.queueLength || 0) > 0);
    process.stdout.write(active ? "active" : "idle");
  } catch {
    process.stdout.write("unknown");
  }
});
'
}

wait_for_yep_sessions_before_cutover() {
  local state announced=false elapsed=0

  if $ALLOW_YEP_SESSION_INTERRUPT; then
    warn "Active Yep-managed work may be interrupted because --allow-yep-session-interrupt was provided."
    return 0
  fi

  while true; do
    state="$(server_activity_state)"
    case "$state" in
      stopped|idle)
        if $announced; then
          log "Yep-managed work is idle; continuing the 8022 cutover."
        fi
        return 0
        ;;
      active)
        if ! $announced; then
          log "Waiting for active Yep-managed work before replacing 8022 ..."
          echo "YEP_DEPLOY_WAITING_FOR_IDLE"
          dim "use --allow-yep-session-interrupt only when an intentional interruption is acceptable"
          announced=true
        elif (( elapsed % 30 == 0 )); then
          dim "still waiting for active work (${elapsed}s)"
        fi
        sleep 1
        elapsed=$((elapsed + 1))
        ;;
      *)
        err "Port ${SERVER_PORT} is listening, but ${SERVER_BASE_URL}/api/status/workers could not be verified."
        err "Refusing to stop an unverified service. Check the configured port/base path, or use --allow-yep-session-interrupt to force the cutover."
        return 1
        ;;
    esac
  done
}

wait_port_released() {
  local port="$1"
  for _ in $(seq 1 20); do
    if ! lsof -iTCP:"${port}" -sTCP:LISTEN -t >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

server_process_pids() {
  local port="$1"
  {
    pgrep -f "${SERVER_CLI_JS} --port ${port}" 2>/dev/null || true
    pgrep -f "${LAUNCHD_SERVER_CLI_JS} --port ${port}" 2>/dev/null || true
  } | sort -u
}

parent_pid() {
  local pid="$1"
  ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true
}

command_for_pid() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

dev_supervisor_pids_for_server_listeners() {
  local listen_pids="$1"
  local pid current parent cmd
  for pid in $listen_pids; do
    current="$pid"
    for _ in $(seq 1 8); do
      parent="$(parent_pid "$current")"
      [[ -z "$parent" || "$parent" == "1" || "$parent" == "$current" ]] && break
      cmd="$(command_for_pid "$parent")"
      if [[ "$cmd" == *"$REPO_ROOT/scripts/dev.js"* ||
        "$cmd" == *"$REPO_ROOT/scripts/dev-8022.js"* ]]; then
        printf '%s\n' "$parent"
      fi
      current="$parent"
    done
  done | sort -u
}

wait_server_processes_stopped() {
  local port="$1"
  for _ in $(seq 1 20); do
    if [[ -z "$(server_process_pids "$port")" ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

launchd_domain() {
  printf 'gui/%s' "$(id -u)"
}

launchd_label_loaded() {
  local label="$1"

  [[ "$(uname -s)" == "Darwin" ]] || return 1
  command -v launchctl >/dev/null 2>&1 || return 1
  launchctl print "$(launchd_domain)/${label}" >/dev/null 2>&1
}

kickstart_launchd_label() {
  local label="$1"

  # Every caller has already stopped the process it is replacing. Do not use
  # `-k` here: it introduces a second forced termination during deployment
  # and makes the launch sequence race the process cleanup above.
  launchctl kickstart "$(launchd_domain)/${label}"
}

reload_launchd_label_from_plist() {
  local label="$1"
  local plist="$2"
  local domain
  domain="$(launchd_domain)"

  [[ -f "$plist" ]] || return 1

  # kickstart only restarts the definition already cached by launchd. Reload
  # the plist after the old process has been safely stopped so environment
  # changes written during deploy take effect without a start-stop-start race.
  if launchd_label_loaded "$label"; then
    if ! launchctl bootout "$domain/$label" >/dev/null 2>&1; then
      launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || return 1
    fi
  fi

  launchctl enable "$domain/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$plist"
}

tail_server_launchagent_logs() {
  local stdout_log="$SERVER_LAUNCHD_LOG_DIR/server-launchd.out.log"
  local stderr_log="$SERVER_LAUNCHD_LOG_DIR/server-launchd.err.log"

  err "LaunchAgent logs: $stdout_log and $stderr_log"
  if [[ -f "$stderr_log" ]]; then
    err "Last 40 lines of LaunchAgent stderr:"
    tail -40 "$stderr_log" >&2 || true
  fi
  if [[ -f "$stdout_log" ]]; then
    # The normal stdout contains session prompts and transcript metadata.
    # Restrict failure output to server lifecycle/error records so a deploy
    # failure does not echo unrelated session content into the terminal.
    err "Recent LaunchAgent startup/error records:"
    rg -a '\[Server\]|\[NetworkBinding\]|Failed to start|ERROR|\[Shutdown\]' "$stdout_log" \
      | tail -40 >&2 || true
  fi
  if command -v launchctl >/dev/null 2>&1; then
    err "LaunchAgent status:"
    launchctl print "$(launchd_domain)/${SERVER_LAUNCHD_LABEL}" >&2 || true
  fi
}

server_node_bin() {
  local node_bin="${YEP_LAUNCHD_NODE:-}"
  local plist="$HOME/Library/LaunchAgents/${SERVER_LAUNCHD_LABEL}.plist"

  # Prefer the runtime recorded in the server plist. It is chosen during
  # installation to match the native runtime dependencies, whereas the shell
  # PATH used for deploy may point at a different Node.js major version.
  if [[ -z "$node_bin" && -f "$plist" ]] && command -v plutil >/dev/null 2>&1; then
    node_bin="$(plutil -extract 'ProgramArguments.0' raw "$plist" 2>/dev/null || true)"
  fi
  if [[ -z "$node_bin" ]]; then
    node_bin="$(command -v node 2>/dev/null || true)"
  fi
  if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    err "Could not find an executable Node.js runtime for the fallback server."
    return 1
  fi
  printf '%s' "$node_bin"
}

start_server_fallback() {
  local node_bin
  node_bin="$(server_node_bin)" || return 1

  if [[ ! -f "$SERVER_CLI_JS" ]]; then
    err "Cannot start fallback server: bundled CLI is missing at $SERVER_CLI_JS"
    return 1
  fi

  log "Starting yepanywhere outside LaunchAgent (logs: /tmp/yep-server.log) ..."
  if ! $USE_CODEX_BRIDGE_SIDECAR; then
    BASE_PATH="${SERVER_BASE_PATH:-/}" \
      ALLOWED_IMAGE_PATHS="$SERVER_ALLOWED_IMAGE_PATHS" \
      env -u YEP_DEPLOY_LOCK_HELD -u YEP_DEPLOY_LOCK_OWNED \
      nohup "$node_bin" "$SERVER_CLI_JS" --port "$SERVER_PORT" >/tmp/yep-server.log 2>&1 & disown
    return 0
  fi

  BASE_PATH="${SERVER_BASE_PATH:-/}" \
    ALLOWED_IMAGE_PATHS="$SERVER_ALLOWED_IMAGE_PATHS" \
    YEP_CODEX_BRIDGE_MODE=external \
    YEP_CODEX_BRIDGE_CONTROL_URL="$CODEX_BRIDGE_HTTP_URL" \
    YEP_CODEX_BRIDGE_PORT="$CODEX_BRIDGE_PORT" \
    env -u YEP_DEPLOY_LOCK_HELD -u YEP_DEPLOY_LOCK_OWNED -u YEP_CLAUDE_BRIDGE_URL -u CLAUDE_BRIDGE_URL -u YEP_CLAUDE_SERVER_URL -u CLAUDE_SERVER_URL \
    nohup "$node_bin" "$SERVER_CLI_JS" --port "$SERVER_PORT" >/tmp/yep-server.log 2>&1 & disown
}

stop_launchagent_server_for_fallback() {
  local pids
  pids="$(server_process_pids "$SERVER_PORT")"
  [[ -z "$pids" ]] && return 0

  warn "LaunchAgent server did not become ready; stopping PID(s): ${pids//$'\n'/, }"
  kill $pids 2>/dev/null || true
  wait_server_processes_stopped "$SERVER_PORT" || true

  pids="$(server_process_pids "$SERVER_PORT")"
  if [[ -n "$pids" ]]; then
    warn "LaunchAgent server did not stop after SIGTERM; sending SIGKILL to PID(s): ${pids//$'\n'/, }"
    kill -9 $pids 2>/dev/null || true
    wait_server_processes_stopped "$SERVER_PORT" || true
  fi
}

start_codex_bridge_sidecar() {
  local bridge_port="$1"
  local bridge_url="$2"
  local node_bin

  if [[ "$(uname -s)" == "Darwin" && -f "$CODEX_BRIDGE_LAUNCHD_PLIST" ]] &&
    command -v launchctl >/dev/null 2>&1; then
    log "Reloading Codex bridge LaunchAgent ${CODEX_BRIDGE_LAUNCHD_LABEL} on ${bridge_url} ..."
    if ! reload_launchd_label_from_plist "$CODEX_BRIDGE_LAUNCHD_LABEL" "$CODEX_BRIDGE_LAUNCHD_PLIST"; then
      warn "Could not reload Codex bridge LaunchAgent; using a direct sidecar process."
      node_bin="$(server_node_bin)" || return 1
      YEP_CODEX_BRIDGE_PORT="$bridge_port" \
        env -u YEP_DEPLOY_LOCK_HELD -u YEP_DEPLOY_LOCK_OWNED \
        nohup "$node_bin" "$SERVER_CLI_JS" --codex-bridge-only >/tmp/yep-codex-bridge.log 2>&1 & disown
    fi
  else
    node_bin="$(server_node_bin)" || return 1
    log "Starting Codex bridge sidecar on ${bridge_url} (logs: /tmp/yep-codex-bridge.log) ..."
    YEP_CODEX_BRIDGE_PORT="$bridge_port" \
      env -u YEP_DEPLOY_LOCK_HELD -u YEP_DEPLOY_LOCK_OWNED \
      nohup "$node_bin" "$SERVER_CLI_JS" --codex-bridge-only >/tmp/yep-codex-bridge.log 2>&1 & disown
  fi

  for _ in $(seq 1 60); do
    if curl -fsS "${bridge_url}/status" >/dev/null 2>&1; then
      log "Codex bridge sidecar is up."
      return 0
    fi
    sleep 0.25
  done

  err "Codex bridge sidecar didn't answer ${bridge_url}/status within 15s."
  tail -20 /tmp/yep-codex-bridge.log >&2 || true
  return 1
}

runtime_dependencies_installed() {
  [[ -d "$REPO_ROOT/dist/npm-package/node_modules" ]] || return 1
  (
    cd "$REPO_ROOT/dist/npm-package"
    npm ls --omit=dev --depth=0 --silent >/dev/null 2>&1
  )
}

install_runtime_dependencies() {
  local npm_registry
  npm_registry="$(deploy_npm_registry)"
  log "Installing runtime dependencies in dist/npm-package ..."
  dim "npm registry: ${npm_registry}"
  dim "npm network: direct (inherited proxy settings disabled)"
  (
    cd "$REPO_ROOT/dist/npm-package"
    run_deploy_npm_direct install --omit=dev --no-audit --no-fund --prefer-offline
  )
  chmod +x "$REPO_ROOT"/dist/npm-package/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
}

sync_launchd_runtime_if_installed() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0

  local agents_dir="$HOME/Library/LaunchAgents"
  if [[ ! -f "$agents_dir/${SERVER_LAUNCHD_LABEL}.plist" &&
    ! -f "$agents_dir/${CODEX_BRIDGE_LAUNCHD_LABEL}.plist" ]]; then
    return 0
  fi

  log "Syncing the LaunchAgent runtime from the new bundle ..."
  YEP_LAUNCHD_RUNTIME_DIR="$LAUNCHD_RUNTIME_DIR" "$SCRIPT_DIR/sync-launchd-runtime.sh"
}

refresh_installed_bridge_launchagents() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0

  if [[ ! -f "$CODEX_BRIDGE_LAUNCHD_PLIST" ]]; then
    return 0
  fi

  log "Refreshing the installed Codex bridge LaunchAgent definition without restarting it ..."
  "$SCRIPT_DIR/install-launchagents.sh" --bridge-only --no-start
}

ensure_bundle_ready() {
  if [[ ! -f "$SERVER_CLI_JS" ]]; then
    err "Expected $SERVER_CLI_JS, but it's missing. Rebuild before restarting."
    return 1
  fi

  chmod +x "$SERVER_CLI_JS"
  if ! runtime_dependencies_installed; then
    warn "Bundled runtime dependencies are missing or incomplete; repairing them before restart."
    install_runtime_dependencies
  fi
}

# ----- build -----
if $DO_BUILD; then
  ensure_pnpm
  log "Building bundle (NPM_VERSION=${NPM_VERSION}) ..."
  BASE_PATH="${SERVER_BASE_PATH:-/}" NPM_VERSION="$NPM_VERSION" pnpm build:bundle

  # build-bundle.ts stages the self-contained package but does not install its
  # runtime dependencies. Local deployment must do that before promotion.
  install_runtime_dependencies

  # Verify the bundle actually reports the version we asked for. Catches
  # silent build issues (e.g. NPM_VERSION not picked up by build-bundle).
  ACTUAL_VERSION="$(node "$SERVER_CLI_JS" --version 2>&1 | head -1 | awk '{print $NF}' || true)"
  if [[ "$ACTUAL_VERSION" != "v${NPM_VERSION}" && "$ACTUAL_VERSION" != "${NPM_VERSION}" ]]; then
    warn "Bundle reports version '${ACTUAL_VERSION}' but expected 'v${NPM_VERSION}'."
  fi

  # Running LaunchAgents are not restarted here; this updates what their next
  # launch will execute and retains the former runtime as `.previous` for rollback.
  sync_launchd_runtime_if_installed
fi

if $DO_RESTART || $RESTART_CODEX_BRIDGE; then
  ensure_bundle_ready
fi
if $DO_BUILD || $DO_RESTART || $RESTART_CODEX_BRIDGE; then
  refresh_installed_bridge_launchagents
fi

# ----- restart -----
if $DO_RESTART; then
  wait_for_yep_sessions_before_cutover
fi

if $DO_RESTART || $RESTART_CODEX_BRIDGE; then
  CODEX_BRIDGE_PORT="${YEP_CODEX_BRIDGE_PORT:-${CODEX_BRIDGE_PORT:-4510}}"
  CODEX_BRIDGE_HTTP_URL="${YEP_CODEX_BRIDGE_CONTROL_URL:-${CODEX_BRIDGE_CONTROL_URL:-http://127.0.0.1:${CODEX_BRIDGE_PORT}}}"
  SERVER_LISTEN_PIDS="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  SERVER_PROCESS_PIDS="$(server_process_pids "$SERVER_PORT")"
  DEV_SUPERVISOR_PIDS="$(dev_supervisor_pids_for_server_listeners "$SERVER_LISTEN_PIDS")"
  CODEX_BRIDGE_LISTEN_PIDS="$(lsof -iTCP:"${CODEX_BRIDGE_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
else
  CODEX_BRIDGE_PORT=""
  CODEX_BRIDGE_HTTP_URL=""
  SERVER_LISTEN_PIDS=""
  SERVER_PROCESS_PIDS=""
  DEV_SUPERVISOR_PIDS=""
  CODEX_BRIDGE_LISTEN_PIDS=""
fi

if $DO_RESTART; then
  START_CODEX_BRIDGE_AFTER_STOP=false

  if $USE_CODEX_BRIDGE_SIDECAR; then
    if $RESTART_CODEX_BRIDGE; then
      START_CODEX_BRIDGE_AFTER_STOP=true
      if [[ -n "$CODEX_BRIDGE_LISTEN_PIDS" ]]; then
        warn "Restarting Codex bridge on port ${CODEX_BRIDGE_PORT}; active cf / codex --remote sessions will disconnect."
      else
        dim "Codex bridge sidecar is not running; it will be started."
      fi
    elif [[ -n "$CODEX_BRIDGE_LISTEN_PIDS" ]] && ! pid_sets_overlap "$SERVER_LISTEN_PIDS" "$CODEX_BRIDGE_LISTEN_PIDS"; then
      dim "preserving Codex bridge on port ${CODEX_BRIDGE_PORT} (PID ${CODEX_BRIDGE_LISTEN_PIDS//$'\n'/, })"
    else
      if [[ -n "$CODEX_BRIDGE_LISTEN_PIDS" ]]; then
        err "Cannot restart 8022 without affecting 4510: port ${CODEX_BRIDGE_PORT} is owned by the web server process."
        err "Run again with --restart-codex-bridge to migrate/restart 4510, or start a 4510 sidecar first."
        exit 1
      else
        START_CODEX_BRIDGE_AFTER_STOP=true
        dim "Codex bridge sidecar is not running; it will be started after the web server stops."
      fi
    fi
  elif [[ -n "$CODEX_BRIDGE_LISTEN_PIDS" ]]; then
    warn "Starting Codex bridge embedded in the web server; active cf / codex --remote sessions will disconnect."
  fi

  log "Stopping running yepanywhere ..."
  if [[ -n "$DEV_SUPERVISOR_PIDS" ]]; then
    dim "stopping dev hot-reload supervisor(s): ${DEV_SUPERVISOR_PIDS//$'\n'/, }"
    kill $DEV_SUPERVISOR_PIDS 2>/dev/null || true
    wait_port_released "$SERVER_PORT" || true
    SERVER_LISTEN_PIDS="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  fi
  if [[ -n "$SERVER_LISTEN_PIDS" ]]; then
    kill $SERVER_LISTEN_PIDS 2>/dev/null || true
  fi
  if [[ -n "$SERVER_PROCESS_PIDS" ]]; then
    kill $SERVER_PROCESS_PIDS 2>/dev/null || true
  fi
  if { ! $USE_CODEX_BRIDGE_SIDECAR || $RESTART_CODEX_BRIDGE; } &&
    [[ -n "$CODEX_BRIDGE_LISTEN_PIDS" ]] &&
    ! pid_sets_overlap "$SERVER_LISTEN_PIDS" "$CODEX_BRIDGE_LISTEN_PIDS"; then
    kill $CODEX_BRIDGE_LISTEN_PIDS 2>/dev/null || true
  fi
  # Wait briefly for the old process to release the port.
  wait_port_released "$SERVER_PORT" || true
  wait_server_processes_stopped "$SERVER_PORT" || true

  LISTEN_PIDS="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  if [[ -n "$LISTEN_PIDS" ]]; then
    warn "Port ${SERVER_PORT} is still held by PID(s): ${LISTEN_PIDS//$'\n'/, }. Sending SIGTERM ..."
    kill $LISTEN_PIDS 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi

  SERVER_PROCESS_PIDS="$(server_process_pids "$SERVER_PORT")"
  if [[ -n "$SERVER_PROCESS_PIDS" ]]; then
    warn "Yep Anywhere server process(es) for port ${SERVER_PORT} are still running: ${SERVER_PROCESS_PIDS//$'\n'/, }. Sending SIGTERM ..."
    kill $SERVER_PROCESS_PIDS 2>/dev/null || true
    wait_server_processes_stopped "$SERVER_PORT" || true
  fi

  LISTEN_PIDS="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  if [[ -n "$LISTEN_PIDS" ]]; then
    warn "Port ${SERVER_PORT} did not release after SIGTERM. Sending SIGKILL to PID(s): ${LISTEN_PIDS//$'\n'/, }"
    kill -9 $LISTEN_PIDS 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi

  SERVER_PROCESS_PIDS="$(server_process_pids "$SERVER_PORT")"
  if [[ -n "$SERVER_PROCESS_PIDS" ]]; then
    warn "Yep Anywhere server process(es) for port ${SERVER_PORT} did not stop after SIGTERM. Sending SIGKILL to PID(s): ${SERVER_PROCESS_PIDS//$'\n'/, }"
    kill -9 $SERVER_PROCESS_PIDS 2>/dev/null || true
    wait_server_processes_stopped "$SERVER_PORT" || true
  fi

  if lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    err "Port ${SERVER_PORT} is still in use after stopping the old server."
    exit 1
  fi
  SERVER_PROCESS_PIDS="$(server_process_pids "$SERVER_PORT")"
  if [[ -n "$SERVER_PROCESS_PIDS" ]]; then
    err "Yep Anywhere server process(es) for port ${SERVER_PORT} are still running after stop: ${SERVER_PROCESS_PIDS//$'\n'/, }"
    exit 1
  fi

  if $USE_CODEX_BRIDGE_SIDECAR && $START_CODEX_BRIDGE_AFTER_STOP; then
    wait_port_released "$CODEX_BRIDGE_PORT" || true
    if lsof -iTCP:"${CODEX_BRIDGE_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
      err "Codex bridge port ${CODEX_BRIDGE_PORT} is still in use; cannot start sidecar."
      exit 1
    fi
    start_codex_bridge_sidecar "$CODEX_BRIDGE_PORT" "$CODEX_BRIDGE_HTTP_URL"
  fi

  log "Starting yepanywhere ..."
  # Mount under the configured base path so a reverse proxy can forward the
  # service cleanly. The Hono app + client bundle both pick up BASE_PATH.
  # APK / direct-mode tcp tunnel callers are unaffected — they hit ws://host:8022
  # which still serves /yep/api/ws; only the URL prefix changes, not the port.
  STARTED_SERVER_WITH_LAUNCHAGENT=false
  if [[ "$(uname -s)" == "Darwin" && -f "$SERVER_LAUNCHD_PLIST" ]] &&
    command -v launchctl >/dev/null 2>&1; then
    if launchd_label_loaded "$SERVER_LAUNCHD_LABEL"; then
      dim "reloading LaunchAgent ${SERVER_LAUNCHD_LABEL} from $SERVER_LAUNCHD_PLIST"
    else
      dim "loading LaunchAgent ${SERVER_LAUNCHD_LABEL} from $SERVER_LAUNCHD_PLIST"
    fi
    if reload_launchd_label_from_plist "$SERVER_LAUNCHD_LABEL" "$SERVER_LAUNCHD_PLIST"; then
      dim "using LaunchAgent ${SERVER_LAUNCHD_LABEL}; abnormal exits are restarted with launchd throttling"
      STARTED_SERVER_WITH_LAUNCHAGENT=true
    else
      warn "Could not reload LaunchAgent ${SERVER_LAUNCHD_LABEL}; using direct server process"
      start_server_fallback
    fi
  else
    dim "LaunchAgent ${SERVER_LAUNCHD_LABEL} is not loaded; using direct server process"
    start_server_fallback
  fi

  # Health-check loop. Tries up to 15s; the server usually answers within 2s
  # but Tauri activity / large data dirs can stretch first-boot.
  # /yep/api/version is a small JSON endpoint that exists on every server build —
  # /api/health doesn't (unmatched routes fall through to the SPA shell).
  # The /yep prefix matches the BASE_PATH set above.
  log "Waiting for ${SERVER_BASE_URL}/api/version ..."
  HEALTH_OK=false
  for _ in $(seq 1 60); do
    if curl -fsS "${SERVER_BASE_URL}/api/version" >/dev/null 2>&1; then
      HEALTH_OK=true
      break
    fi
    sleep 0.25
  done

  # Some macOS launchd/xpcproxy combinations leave Node.js alive but stuck
  # before application code runs. The same CLI works when started outside
  # launchd, so use a direct process for this deployment instead of leaving
  # 8022 unavailable.
  if ! $HEALTH_OK && $STARTED_SERVER_WITH_LAUNCHAGENT; then
    warn "LaunchAgent ${SERVER_LAUNCHD_LABEL} did not become ready; retrying outside launchd."
    tail_server_launchagent_logs
    stop_launchagent_server_for_fallback
    start_server_fallback

    for _ in $(seq 1 60); do
      if curl -fsS "${SERVER_BASE_URL}/api/version" >/dev/null 2>&1; then
        HEALTH_OK=true
        break
      fi
      sleep 0.25
    done
  fi

  if $HEALTH_OK; then
    log "Server is up."
    # Show what the freshly started server reports.
    SERVER_VERSION_LINE="$(curl -fsS "${SERVER_BASE_URL}/api/version" 2>/dev/null | node -e 'let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => { const d=JSON.parse(raw); console.log(`current=${d.current} protocol=${d.resumeProtocolVersion} buildId=${d.build?.buildId ?? "missing"}`); })' 2>/dev/null || true)"
    dim "${SERVER_BASE_URL}/api/version → ${SERVER_VERSION_LINE}"

    LISTEN_PID="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    if [[ -n "$LISTEN_PID" ]]; then
      LISTEN_CMD="$(ps -p "$LISTEN_PID" -o command= 2>/dev/null || true)"
      dim "pid ${LISTEN_PID}: ${LISTEN_CMD}"
    fi

    log "Verifying deployed server/client build metadata ..."
    node scripts/verify-deploy.mjs \
      --base-url "$SERVER_BASE_URL" \
      --build-info "$REPO_ROOT/dist/npm-package/build-info.json"

    # Relay (4400) was retired in favor of self-hosted frp tcp tunnels.
    # Skipping relay status check — see INFRA.md.
  else
    err "Server didn't answer ${SERVER_BASE_URL}/api/version within 15s."
    if launchd_label_loaded "$SERVER_LAUNCHD_LABEL"; then
      tail_server_launchagent_logs
    else
      err "Fallback server log: /tmp/yep-server.log"
      tail -80 /tmp/yep-server.log >&2 || true
    fi
    exit 1
  fi
fi

if ! $DO_RESTART && $RESTART_CODEX_BRIDGE; then
  log "Restarting Codex bridge sidecar on port ${CODEX_BRIDGE_PORT} ..."
  if [[ -n "$SERVER_LISTEN_PIDS" ]] &&
    [[ -n "$CODEX_BRIDGE_LISTEN_PIDS" ]] &&
    pid_sets_overlap "$SERVER_LISTEN_PIDS" "$CODEX_BRIDGE_LISTEN_PIDS"; then
    err "Cannot restart only 4510: port ${CODEX_BRIDGE_PORT} is owned by the 8022 web/API process."
    err "Redeploy 8022 with --restart-codex-bridge once to split it into a sidecar."
    exit 1
  fi

  if [[ -n "$CODEX_BRIDGE_LISTEN_PIDS" ]]; then
    kill $CODEX_BRIDGE_LISTEN_PIDS 2>/dev/null || true
    wait_port_released "$CODEX_BRIDGE_PORT" || true
  fi

  LISTEN_PIDS="$(lsof -iTCP:"${CODEX_BRIDGE_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  if [[ -n "$LISTEN_PIDS" ]]; then
    warn "Codex bridge port ${CODEX_BRIDGE_PORT} is still held by PID(s): ${LISTEN_PIDS//$'\n'/, }. Sending SIGKILL ..."
    kill -9 $LISTEN_PIDS 2>/dev/null || true
    wait_port_released "$CODEX_BRIDGE_PORT" || true
  fi

  if lsof -iTCP:"${CODEX_BRIDGE_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    err "Codex bridge port ${CODEX_BRIDGE_PORT} is still in use after stopping the old sidecar."
    exit 1
  fi

  start_codex_bridge_sidecar "$CODEX_BRIDGE_PORT" "$CODEX_BRIDGE_HTTP_URL"
fi

log "Done."

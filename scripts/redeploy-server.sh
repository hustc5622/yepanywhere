#!/usr/bin/env bash
# Rebuild the yepanywhere server bundle from the monorepo and restart the
# running server process so the new code takes effect.
#
# Usage:
#   scripts/redeploy-server.sh           # full rebuild + restart 8022, preserve bridge sidecars
#   scripts/redeploy-server.sh --restart # restart only (skip rebuild)
#   scripts/redeploy-server.sh --no-restart # rebuild only (skip restart)
#   scripts/redeploy-server.sh --preserve-codex-bridge
#                                      # explicit default: keep 4510 as sidecar
#   scripts/redeploy-server.sh --restart-codex-bridge
#                                      # restart the 4510 Codex bridge sidecar too
#   scripts/redeploy-server.sh --no-restart --restart-codex-bridge
#                                      # rebuild + restart only the 4510 sidecar
#   scripts/redeploy-server.sh --no-restart --restart-opencode-bridge
#                                      # rebuild + restart only the 4520 sidecar
#   scripts/redeploy-server.sh --embedded-codex-bridge
#                                      # legacy: run 4510 inside 8022
#
# Assumes:
#   - Global `yepanywhere` command is pnpm-linked to dist/npm-package
#     (one-time: `pnpm link --global` from repo root).
#   - You want to keep the relay process and frp tunnel running. This script
#     only touches the yepanywhere server itself.
#
# Side effects of restart:
#   - APK / web clients disconnect for ~3-5s (auto-reconnect, no relogin).
#   - In-progress SDK sessions (running claude subprocesses) are killed.
#   - 4510 Codex bridge sessions are preserved by default. If 4510 is still
#     embedded in the 8022 process, preserving it while restarting 8022 is
#     impossible; choose --restart-codex-bridge to migrate/restart it.
#   - 4520 OpenCode bridge sessions are preserved by default. Choose
#     --restart-opencode-bridge to restart that sidecar too.
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

# ----- args -----
DO_BUILD=true
DO_RESTART=true
USE_CODEX_BRIDGE_SIDECAR=true
RESTART_CODEX_BRIDGE=false
RESTART_OPENCODE_BRIDGE=false
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
CODEX_BRIDGE_LAUNCHD_LABEL="${YEP_LAUNCHD_BRIDGE_LABEL:-com.yueyuan.yepanywhere.codex-bridge}"
OPENCODE_BRIDGE_LAUNCHD_LABEL="${YEP_LAUNCHD_OPENCODE_BRIDGE_LABEL:-com.yueyuan.yepanywhere.opencode-bridge}"
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
    --restart-opencode-bridge)
      RESTART_OPENCODE_BRIDGE=true
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
# Pull version from the monorepo root package.json so the bundle reports the
# real version (build-bundle.ts otherwise falls back to a hardcoded string).
NPM_VERSION="$(node -p "require('./package.json').version")"
log "Monorepo version: ${NPM_VERSION}"

# Count running SDK children before we kill the server so the user knows
# what they're about to interrupt. Shown only, not used to abort.
if $DO_RESTART; then
  SDK_COUNT="$(pgrep -fa 'claude-agent-sdk' 2>/dev/null | grep -c . || true)"
  if [[ "$SDK_COUNT" -gt 0 ]]; then
    warn "About to kill the running yepanywhere server. ${SDK_COUNT} active SDK claude subprocess(es) will be terminated."
  fi
fi

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
  pgrep -f "${REPO_ROOT}/dist/npm-package/dist/cli.js --port ${port}" 2>/dev/null | sort -u || true
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

  launchctl kickstart -k "$(launchd_domain)/${label}"
}

start_codex_bridge_sidecar() {
  local bridge_port="$1"
  local bridge_url="$2"

  if launchd_label_loaded "$CODEX_BRIDGE_LAUNCHD_LABEL"; then
    log "Starting Codex bridge LaunchAgent ${CODEX_BRIDGE_LAUNCHD_LABEL} on ${bridge_url} ..."
    kickstart_launchd_label "$CODEX_BRIDGE_LAUNCHD_LABEL"
  else
    log "Starting Codex bridge sidecar on ${bridge_url} (logs: /tmp/yep-codex-bridge.log) ..."
    YEP_CODEX_BRIDGE_PORT="$bridge_port" nohup yepanywhere --codex-bridge-only >/tmp/yep-codex-bridge.log 2>&1 & disown
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

start_opencode_bridge_sidecar() {
  local bridge_port="$1"
  local bridge_url="$2"
  local server_url="$3"

  if launchd_label_loaded "$OPENCODE_BRIDGE_LAUNCHD_LABEL"; then
    log "Starting OpenCode bridge LaunchAgent ${OPENCODE_BRIDGE_LAUNCHD_LABEL} on ${bridge_url} ..."
    kickstart_launchd_label "$OPENCODE_BRIDGE_LAUNCHD_LABEL"
  else
    log "Starting OpenCode bridge sidecar on ${bridge_url} (logs: /tmp/yep-opencode-bridge.log) ..."
    YEP_OPENCODE_BRIDGE_PORT="$bridge_port" \
      YEP_SERVER_URL="$server_url" \
      nohup yepanywhere --opencode-bridge-only >/tmp/yep-opencode-bridge.log 2>&1 & disown
  fi

  for _ in $(seq 1 60); do
    if curl -fsS "${bridge_url}/status" >/dev/null 2>&1; then
      log "OpenCode bridge sidecar is up."
      return 0
    fi
    sleep 0.25
  done

  err "OpenCode bridge sidecar didn't answer ${bridge_url}/status within 15s."
  tail -20 /tmp/yep-opencode-bridge.log >&2 || true
  return 1
}

# ----- build -----
if $DO_BUILD; then
  log "Building bundle (NPM_VERSION=${NPM_VERSION}) ..."
  NPM_VERSION="$NPM_VERSION" pnpm build:bundle

  # The build sometimes drops the +x bit on the CLI entry — restore it so
  # node's shebang launcher works.
  if [[ -f dist/npm-package/dist/cli.js ]]; then
    chmod +x dist/npm-package/dist/cli.js
  else
    err "Expected dist/npm-package/dist/cli.js after build, but it's missing."
    exit 1
  fi

  # build-bundle.ts only stages the package for publishing — it doesn't
  # install runtime dependencies. When npm publishes, `npm i -g yepanywhere`
  # installs the dependencies for end users; for local dev we have to do
  # it ourselves, otherwise `yepanywhere` boots with ERR_MODULE_NOT_FOUND.
  log "Installing runtime dependencies in dist/npm-package ..."
  (cd dist/npm-package && npm install --omit=dev --no-audit --no-fund --silent)
  chmod +x dist/npm-package/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

  # Sanity-check the linked global command resolves to our bundle.
  GLOBAL_BIN="$(command -v yepanywhere 2>/dev/null || true)"
  if [[ -z "$GLOBAL_BIN" ]]; then
    warn "'yepanywhere' command not on PATH. Run 'pnpm link --global' from the repo root, then re-run this script."
  else
    RESOLVED="$(readlink -f "$GLOBAL_BIN" 2>/dev/null || echo "$GLOBAL_BIN")"
    EXPECTED="$REPO_ROOT/dist/npm-package/dist/cli.js"
    if [[ "$RESOLVED" != "$EXPECTED" ]]; then
      warn "'yepanywhere' resolves to $RESOLVED, not $EXPECTED"
      warn "Restart will launch the wrong build. Run 'pnpm link --global' to fix."
    fi
  fi

  # Verify the bundle actually reports the version we asked for. Catches
  # silent build issues (e.g. NPM_VERSION not picked up by build-bundle).
  ACTUAL_VERSION="$(yepanywhere --version 2>&1 | head -1 | awk '{print $NF}' || true)"
  if [[ "$ACTUAL_VERSION" != "v${NPM_VERSION}" && "$ACTUAL_VERSION" != "${NPM_VERSION}" ]]; then
    warn "Bundle reports version '${ACTUAL_VERSION}' but expected 'v${NPM_VERSION}'."
  fi
fi

# ----- restart -----
if $DO_RESTART || $RESTART_CODEX_BRIDGE || $RESTART_OPENCODE_BRIDGE; then
  CODEX_BRIDGE_PORT="${YEP_CODEX_BRIDGE_PORT:-${CODEX_BRIDGE_PORT:-4510}}"
  CODEX_BRIDGE_HTTP_URL="${YEP_CODEX_BRIDGE_CONTROL_URL:-${CODEX_BRIDGE_CONTROL_URL:-http://127.0.0.1:${CODEX_BRIDGE_PORT}}}"
  OPENCODE_BRIDGE_PORT="${YEP_OPENCODE_BRIDGE_PORT:-${OPENCODE_BRIDGE_PORT:-4520}}"
  OPENCODE_BRIDGE_HTTP_URL="${YEP_OPENCODE_BRIDGE_CONTROL_URL:-${OPENCODE_BRIDGE_CONTROL_URL:-http://127.0.0.1:${OPENCODE_BRIDGE_PORT}}}"
  SERVER_LISTEN_PIDS="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  SERVER_PROCESS_PIDS="$(server_process_pids "$SERVER_PORT")"
  CODEX_BRIDGE_LISTEN_PIDS="$(lsof -iTCP:"${CODEX_BRIDGE_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  OPENCODE_BRIDGE_LISTEN_PIDS="$(lsof -iTCP:"${OPENCODE_BRIDGE_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
else
  CODEX_BRIDGE_PORT=""
  CODEX_BRIDGE_HTTP_URL=""
  OPENCODE_BRIDGE_PORT=""
  OPENCODE_BRIDGE_HTTP_URL=""
  SERVER_LISTEN_PIDS=""
  SERVER_PROCESS_PIDS=""
  CODEX_BRIDGE_LISTEN_PIDS=""
  OPENCODE_BRIDGE_LISTEN_PIDS=""
fi

if $DO_RESTART; then
  START_CODEX_BRIDGE_AFTER_STOP=false
  START_OPENCODE_BRIDGE_AFTER_STOP=false

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

  if $RESTART_OPENCODE_BRIDGE; then
    START_OPENCODE_BRIDGE_AFTER_STOP=true
    if [[ -n "$OPENCODE_BRIDGE_LISTEN_PIDS" ]]; then
      warn "Restarting OpenCode bridge on port ${OPENCODE_BRIDGE_PORT}; active bridge clients may disconnect."
    else
      dim "OpenCode bridge sidecar is not running; it will be started."
    fi
  elif [[ -n "$OPENCODE_BRIDGE_LISTEN_PIDS" ]] && ! pid_sets_overlap "$SERVER_LISTEN_PIDS" "$OPENCODE_BRIDGE_LISTEN_PIDS"; then
    dim "preserving OpenCode bridge on port ${OPENCODE_BRIDGE_PORT} (PID ${OPENCODE_BRIDGE_LISTEN_PIDS//$'\n'/, })"
  elif [[ -n "$OPENCODE_BRIDGE_LISTEN_PIDS" ]]; then
    err "Cannot restart 8022 without affecting 4520: port ${OPENCODE_BRIDGE_PORT} is owned by the web server process."
    err "Run again with --restart-opencode-bridge to restart it too."
    exit 1
  fi

  log "Stopping running yepanywhere ..."
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
  if $RESTART_OPENCODE_BRIDGE &&
    [[ -n "$OPENCODE_BRIDGE_LISTEN_PIDS" ]] &&
    ! pid_sets_overlap "$SERVER_LISTEN_PIDS" "$OPENCODE_BRIDGE_LISTEN_PIDS"; then
    kill $OPENCODE_BRIDGE_LISTEN_PIDS 2>/dev/null || true
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

  if $START_OPENCODE_BRIDGE_AFTER_STOP; then
    wait_port_released "$OPENCODE_BRIDGE_PORT" || true
    if lsof -iTCP:"${OPENCODE_BRIDGE_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
      err "OpenCode bridge port ${OPENCODE_BRIDGE_PORT} is still in use; cannot start sidecar."
      exit 1
    fi
    start_opencode_bridge_sidecar "$OPENCODE_BRIDGE_PORT" "$OPENCODE_BRIDGE_HTTP_URL" "$SERVER_BASE_URL"
  fi

  log "Starting yepanywhere ..."
  # Mount under /yep so Caddy at air.yueyuan.uk/yep/* reverse-proxies into us
  # cleanly (see INFRA.md). The Hono app + client bundle both pick up BASE_PATH.
  # APK / direct-mode tcp tunnel callers are unaffected — they hit ws://host:8022
  # which still serves /yep/api/ws; only the URL prefix changes, not the port.
  if launchd_label_loaded "$SERVER_LAUNCHD_LABEL"; then
    dim "using LaunchAgent ${SERVER_LAUNCHD_LABEL}; KeepAlive is not required"
    kickstart_launchd_label "$SERVER_LAUNCHD_LABEL"
  elif $USE_CODEX_BRIDGE_SIDECAR; then
    dim "LaunchAgent ${SERVER_LAUNCHD_LABEL} is not loaded; falling back to nohup (logs: /tmp/yep-server.log)"
    BASE_PATH="${SERVER_BASE_PATH:-/}" \
      ALLOWED_IMAGE_PATHS="$SERVER_ALLOWED_IMAGE_PATHS" \
      YEP_CODEX_BRIDGE_MODE=external \
      YEP_CODEX_BRIDGE_CONTROL_URL="$CODEX_BRIDGE_HTTP_URL" \
      YEP_CODEX_BRIDGE_PORT="$CODEX_BRIDGE_PORT" \
      YEP_OPENCODE_BRIDGE_CONTROL_URL="$OPENCODE_BRIDGE_HTTP_URL" \
      YEP_OPENCODE_BRIDGE_PORT="$OPENCODE_BRIDGE_PORT" \
      nohup yepanywhere --port "$SERVER_PORT" >/tmp/yep-server.log 2>&1 & disown
  else
    dim "LaunchAgent ${SERVER_LAUNCHD_LABEL} is not loaded; falling back to nohup (logs: /tmp/yep-server.log)"
    BASE_PATH="${SERVER_BASE_PATH:-/}" \
      ALLOWED_IMAGE_PATHS="$SERVER_ALLOWED_IMAGE_PATHS" \
      nohup yepanywhere --port "$SERVER_PORT" >/tmp/yep-server.log 2>&1 & disown
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
    err "Server didn't answer /yep/api/version within 15s. Check /tmp/yep-server.log for crashes."
    tail -20 /tmp/yep-server.log >&2 || true
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

if ! $DO_RESTART && $RESTART_OPENCODE_BRIDGE; then
  log "Restarting OpenCode bridge sidecar on port ${OPENCODE_BRIDGE_PORT} ..."
  if [[ -n "$SERVER_LISTEN_PIDS" ]] &&
    [[ -n "$OPENCODE_BRIDGE_LISTEN_PIDS" ]] &&
    pid_sets_overlap "$SERVER_LISTEN_PIDS" "$OPENCODE_BRIDGE_LISTEN_PIDS"; then
    err "Cannot restart only 4520: port ${OPENCODE_BRIDGE_PORT} is owned by the 8022 web/API process."
    err "Redeploy 8022 with --restart-opencode-bridge to restart both."
    exit 1
  fi

  if [[ -n "$OPENCODE_BRIDGE_LISTEN_PIDS" ]]; then
    kill $OPENCODE_BRIDGE_LISTEN_PIDS 2>/dev/null || true
    wait_port_released "$OPENCODE_BRIDGE_PORT" || true
  fi

  LISTEN_PIDS="$(lsof -iTCP:"${OPENCODE_BRIDGE_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  if [[ -n "$LISTEN_PIDS" ]]; then
    warn "OpenCode bridge port ${OPENCODE_BRIDGE_PORT} is still held by PID(s): ${LISTEN_PIDS//$'\n'/, }. Sending SIGKILL ..."
    kill -9 $LISTEN_PIDS 2>/dev/null || true
    wait_port_released "$OPENCODE_BRIDGE_PORT" || true
  fi

  if lsof -iTCP:"${OPENCODE_BRIDGE_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    err "OpenCode bridge port ${OPENCODE_BRIDGE_PORT} is still in use after stopping the old sidecar."
    exit 1
  fi

  start_opencode_bridge_sidecar "$OPENCODE_BRIDGE_PORT" "$OPENCODE_BRIDGE_HTTP_URL" "$SERVER_BASE_URL"
fi

log "Done."

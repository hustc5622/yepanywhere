#!/usr/bin/env bash
# Uninstall the macOS LaunchAgents created by scripts/install-launchagents.sh.

set -euo pipefail

SERVER_LABEL="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
BRIDGE_LABEL="${YEP_LAUNCHD_BRIDGE_LABEL:-com.yueyuan.yepanywhere.codex-bridge}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
USER_DOMAIN="gui/$(id -u)"

if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

log()  { echo -e "${C_GREEN}==>${C_RESET} $*"; }
err()  { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim()  { echo -e "${C_DIM}    $*${C_RESET}"; }

usage() {
  sed -n '2,3p' "$0" | sed 's/^# *//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown arg: $1"
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "LaunchAgents are only available on macOS."
  exit 1
fi

uninstall_agent() {
  local label="$1"
  local plist="$LAUNCH_AGENTS_DIR/$label.plist"

  launchctl bootout "$USER_DOMAIN/$label" >/dev/null 2>&1 || true
  launchctl bootout "$USER_DOMAIN" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
  dim "removed $plist"
}

log "Uninstalling Yep Anywhere LaunchAgents ..."
uninstall_agent "$SERVER_LABEL"
uninstall_agent "$BRIDGE_LABEL"
log "Uninstalled LaunchAgents."

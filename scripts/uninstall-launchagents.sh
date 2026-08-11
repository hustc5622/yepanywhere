#!/usr/bin/env bash
# Remove persistent macOS LaunchAgent definitions, optionally preserving loaded instances.

set -euo pipefail

SERVER_LABEL="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
BRIDGE_LABEL="${YEP_LAUNCHD_BRIDGE_LABEL:-com.yueyuan.yepanywhere.codex-bridge}"
CLAUDE_BRIDGE_LABEL="${YEP_LAUNCHD_CLAUDE_BRIDGE_LABEL:-com.yueyuan.yepanywhere.claude-bridge}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
USER_DOMAIN="gui/$(id -u)"
STOP_NOW=true
REMOVE_SERVER=true
REMOVE_CODEX_BRIDGE=true
REMOVE_CLAUDE_BRIDGE=true

if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_RED="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_RED=""; C_DIM=""; C_RESET=""
fi

log() { echo -e "${C_GREEN}==>${C_RESET} $*"; }
err() { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim() { echo -e "${C_DIM}    $*${C_RESET}"; }

usage() {
  cat <<'EOF'
Usage:
  scripts/uninstall-launchagents.sh [--server-only|--bridge-only|--claude-bridge-only|--bridges-only] [--no-stop]

Options:
  --server-only          Remove only the persistent server plist
  --bridge-only          Remove only the persistent Codex bridge plist
  --claude-bridge-only   Remove only the persistent Claude bridge plist
  --bridges-only         Remove both persistent bridge plists
  --no-stop              Do not unload or stop currently loaded instances
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-only)
      REMOVE_SERVER=true
      REMOVE_CODEX_BRIDGE=false
      REMOVE_CLAUDE_BRIDGE=false
      shift
      ;;
    --bridge-only|--codex-bridge-only)
      REMOVE_SERVER=false
      REMOVE_CODEX_BRIDGE=true
      REMOVE_CLAUDE_BRIDGE=false
      shift
      ;;
    --claude-bridge-only)
      REMOVE_SERVER=false
      REMOVE_CODEX_BRIDGE=false
      REMOVE_CLAUDE_BRIDGE=true
      shift
      ;;
    --bridges-only)
      REMOVE_SERVER=false
      REMOVE_CODEX_BRIDGE=true
      REMOVE_CLAUDE_BRIDGE=true
      shift
      ;;
    --no-stop)
      STOP_NOW=false
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

  if $STOP_NOW; then
    launchctl bootout "$USER_DOMAIN/$label" >/dev/null 2>&1 || true
    launchctl bootout "$USER_DOMAIN" "$plist" >/dev/null 2>&1 || true
  fi
  rm -f "$plist"
  dim "removed $plist"
}

log "Removing Yep Anywhere persistent LaunchAgent definitions ..."
$REMOVE_SERVER && uninstall_agent "$SERVER_LABEL"
$REMOVE_CODEX_BRIDGE && uninstall_agent "$BRIDGE_LABEL"
$REMOVE_CLAUDE_BRIDGE && uninstall_agent "$CLAUDE_BRIDGE_LABEL"
if ! $STOP_NOW; then
  dim "currently loaded instances were left unchanged"
fi
log "Persistent LaunchAgent definitions removed."

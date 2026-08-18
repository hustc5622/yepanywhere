#!/usr/bin/env bash
# Audit and, with explicit authorization, remove the retired OpenCode sidecar
# LaunchAgent and Yep forwarder plugin. The database and reference source tree
# are always left untouched.

set -euo pipefail
umask 077

MODE="dry-run"
case "${1:---dry-run}" in
  --dry-run) ;;
  --apply) MODE="apply" ;;
  -h|--help)
    cat <<'EOF'
Usage: scripts/retire-opencode-integration.sh [--dry-run|--apply]

  --dry-run  Report retired runtime artifacts without changing them (default)
  --apply    Remove the retired plugin and LaunchAgent after safety checks

The script never modifies opencode.db, drops indexes, vacuums data, or removes
references/opencode. Running --apply requires separate operator authorization.
EOF
    exit 0
    ;;
  *)
    echo "Unknown option: ${1}" >&2
    exit 2
    ;;
esac
if [[ $# -gt 1 ]]; then
  echo "Only one option is accepted." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BRIDGE_PORT="${YEP_RETIRED_OPENCODE_BRIDGE_PORT:-4520}"
SERVER_PORT="${YEP_RETIRED_OPENCODE_SERVER_PORT:-4521}"
BRIDGE_URL="${YEP_RETIRED_OPENCODE_BRIDGE_URL:-http://127.0.0.1:${BRIDGE_PORT}}"
LAUNCHD_LABEL="${YEP_RETIRED_OPENCODE_LAUNCHD_LABEL:-com.yueyuan.yepanywhere.opencode-bridge}"
PLIST_PATH="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
PLUGIN_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin/yep-bridge.ts"
DB_PATH="${OPENCODE_DB_PATH:-${OPENCODE_DATA_DIR:-$HOME/.local/share/opencode}/opencode.db}"
REFERENCE_PATH="${YEP_RETIRED_OPENCODE_REFERENCE_PATH:-$REPO_ROOT/references/opencode}"
USER_DOMAIN="gui/$(id -u)"

listener_pids() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

join_pids() {
  local pids="$1"
  if [[ -z "$pids" ]]; then
    printf '%s' "none"
  else
    printf '%s' "${pids//$'\n'/,}"
  fi
}

status_json=""
status_known=false
session_count="unknown"
active_count="unknown"
pending_count="unknown"
bridge_connected="unknown"
if command -v curl >/dev/null 2>&1; then
  status_json="$(curl -fsS --connect-timeout 1 --max-time 2 "${BRIDGE_URL}/status" 2>/dev/null || true)"
fi
if [[ -n "$status_json" ]] && command -v node >/dev/null 2>&1; then
  parsed_status="$(printf '%s' "$status_json" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(raw);
    const active = Number.isInteger(value.sessionCount) ? value.sessionCount : null;
    const pending = Number.isInteger(value.pendingInputCount) ? value.pendingInputCount : null;
    if (active === null || pending === null) process.exit(1);
    process.stdout.write(`${active}\t${pending}\t${String(value.opencodeConnected ?? "unknown")}`);
  } catch {
    process.exit(1);
  }
});
' 2>/dev/null || true)"
  if [[ -n "$parsed_status" ]]; then
    IFS=$'\t' read -r session_count pending_count bridge_connected <<<"$parsed_status"
    status_known=true
  fi
fi

views_known=false
views_json=""
if command -v curl >/dev/null 2>&1; then
  views_json="$(curl -fsS --connect-timeout 1 --max-time 3 "${BRIDGE_URL}/session-views" 2>/dev/null || true)"
fi
if [[ -n "$views_json" ]] && command -v node >/dev/null 2>&1; then
  active_count="$(printf '%s' "$views_json" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value.sessions)) process.exit(1);
    process.stdout.write(String(value.sessions.filter((item) => item?.active === true).length));
  } catch {
    process.exit(1);
  }
});
' 2>/dev/null || true)"
  if [[ "$active_count" =~ ^[0-9]+$ ]]; then
    views_known=true
  else
    active_count="unknown"
  fi
fi

bridge_pids="$(listener_pids "$BRIDGE_PORT")"
server_pids="$(listener_pids "$SERVER_PORT")"

echo "Retired OpenCode integration audit (${MODE})"
echo "  bridge status: reachable=${status_known}, sessions=${session_count}, active=${active_count}, pending=${pending_count}, connected=${bridge_connected}"
echo "  ${BRIDGE_PORT} listener PIDs: $(join_pids "$bridge_pids")"
echo "  ${SERVER_PORT} listener PIDs: $(join_pids "$server_pids")"
echo "  LaunchAgent plist: $PLIST_PATH ($( [[ -f "$PLIST_PATH" ]] && printf present || printf absent ))"
echo "  forwarder plugin: $PLUGIN_PATH ($( [[ -f "$PLUGIN_PATH" ]] && printf present || printf absent ))"

EXPECTED_INDEXES=(
  yep_session_time_updated_id_idx
  yep_message_time_updated_session_idx
  yep_part_time_updated_session_idx
  yep_message_session_time_updated_idx
  yep_part_session_time_updated_idx
)
if [[ -f "$DB_PATH" ]] && command -v sqlite3 >/dev/null 2>&1; then
  present_indexes="$(sqlite3 -readonly "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'yep_%' ORDER BY name;" 2>/dev/null || true)"
  echo "  Yep helper indexes in $DB_PATH: ${present_indexes//$'\n'/, }"
elif [[ -f "$DB_PATH" ]]; then
  echo "  Yep helper indexes in $DB_PATH: not queried (sqlite3 unavailable)"
else
  echo "  Yep helper indexes: database absent at $DB_PATH"
fi
echo "  known helper index names: ${EXPECTED_INDEXES[*]}"
if [[ -d "$REFERENCE_PATH" ]]; then
  reference_size="$(du -sh "$REFERENCE_PATH" 2>/dev/null | awk '{print $1}' || true)"
  echo "  reference source: $REFERENCE_PATH (${reference_size:-size unavailable}; retained)"
else
  echo "  reference source: $REFERENCE_PATH (absent)"
fi

if [[ "$MODE" == "dry-run" ]]; then
  echo "Dry-run complete. No changes were made."
  exit 0
fi

if [[ "$status_known" != true && ( -n "$bridge_pids" || -n "$server_pids" ) ]]; then
  echo "Refusing --apply: a retired listener exists but bridge session status is unavailable." >&2
  exit 1
fi
if [[ "$views_known" != true && -n "$bridge_pids" ]]; then
  echo "Refusing --apply: active bridge sessions could not be enumerated." >&2
  exit 1
fi
if [[ "$status_known" == true && "$views_known" == true ]] &&
  (( active_count > 0 || pending_count > 0 )); then
  echo "Refusing --apply: active=${active_count}, pending=${pending_count}." >&2
  exit 1
fi

if [[ -f "$PLUGIN_PATH" ]]; then
  rm -f -- "$PLUGIN_PATH"
  echo "Removed forwarder plugin: $PLUGIN_PATH"
else
  echo "Forwarder plugin already absent: $PLUGIN_PATH"
fi

if [[ -f "$PLIST_PATH" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "$USER_DOMAIN/$LAUNCHD_LABEL" >/dev/null 2>&1 || true
    launchctl bootout "$USER_DOMAIN" "$PLIST_PATH" >/dev/null 2>&1 || true
  fi
fi
remaining_bridge_pids="$(listener_pids "$BRIDGE_PORT")"
if [[ -n "$remaining_bridge_pids" ]]; then
  kill $remaining_bridge_pids 2>/dev/null || true
  for _ in $(seq 1 40); do
    [[ -z "$(listener_pids "$BRIDGE_PORT")" ]] && break
    sleep 0.25
  done
fi
if [[ -n "$(listener_pids "$BRIDGE_PORT")" ]]; then
  echo "Refusing to continue: ${BRIDGE_PORT} still listens after graceful termination; no force signal was sent." >&2
  exit 1
fi
if [[ -f "$PLIST_PATH" ]]; then
  rm -f -- "$PLIST_PATH"
  echo "Removed LaunchAgent plist: $PLIST_PATH"
else
  echo "LaunchAgent plist already absent: $PLIST_PATH"
fi

if [[ -n "$(listener_pids "$SERVER_PORT")" ]]; then
  echo "Warning: ${SERVER_PORT} still has a listener; no signal was sent." >&2
fi
echo "Apply complete. Database, helper indexes, and reference source were not modified."

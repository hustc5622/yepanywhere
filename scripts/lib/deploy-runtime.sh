#!/usr/bin/env bash

# Read only the runtime wiring, never credentials or unrelated plist values.
runtime_plist_value() {
  local plist="$1" key="$2" value
  [[ -f "$plist" ]] || return 0
  value="$(plutil -extract "EnvironmentVariables.$key" raw "$plist" 2>/dev/null)" || return 0
  printf '%s' "$value"
}

# Keep the selected deployment topology when launchd falls back to nohup or
# an installer refreshes unrelated settings. Explicit process env wins.
resolve_deploy_runtime() {
  local plist="$1" server_port="$2"
  DEPLOY_RUNTIME_MODE="${YEP_RUNTIME_MODE:-$(runtime_plist_value "$plist" YEP_RUNTIME_MODE)}"
  DEPLOY_RUNTIME_MODE="${DEPLOY_RUNTIME_MODE:-embedded}"
  case "$DEPLOY_RUNTIME_MODE" in
    embedded|external) ;;
    *) echo "Invalid agent runtime mode: $DEPLOY_RUNTIME_MODE" >&2; return 1 ;;
  esac
  DEPLOY_RUNTIME_PORT="${YEP_RUNTIME_PORT:-$(runtime_plist_value "$plist" YEP_RUNTIME_PORT)}"
  DEPLOY_RUNTIME_PORT="${DEPLOY_RUNTIME_PORT:-$((server_port + 3))}"
  DEPLOY_RUNTIME_URL="${YEP_RUNTIME_CONTROL_URL:-$(runtime_plist_value "$plist" YEP_RUNTIME_CONTROL_URL)}"
  DEPLOY_RUNTIME_URL="${DEPLOY_RUNTIME_URL:-http://127.0.0.1:$DEPLOY_RUNTIME_PORT}"
  DEPLOY_RUNTIME_TOKEN_FILE="${YEP_RUNTIME_TOKEN_FILE:-$(runtime_plist_value "$plist" YEP_RUNTIME_TOKEN_FILE)}"
}

verify_deploy_runtime() {
  local base_url="$1" expected_mode="$2" actual_mode
  actual_mode="$(curl -fsS --max-time 5 "$base_url/api/status/workers" | node -e '
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try { process.stdout.write(JSON.parse(raw).runtimeMode || "unknown"); }
  catch { process.exitCode = 1; }
});
')" || return 1
  if [[ "$actual_mode" != "$expected_mode" ]]; then
    echo "Agent runtime mode mismatch: expected $expected_mode, got $actual_mode" >&2
    return 1
  fi
}

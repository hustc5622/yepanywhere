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

# Same default as packages/server/src/config.ts. Empty when the plist omits it.
deploy_runtime_token_file() {
  if [[ -n "${DEPLOY_RUNTIME_TOKEN_FILE:-}" ]]; then
    printf '%s' "$DEPLOY_RUNTIME_TOKEN_FILE"
    return 0
  fi
  if [[ -n "${YEP_RUNTIME_TOKEN_FILE:-}" ]]; then
    printf '%s' "$YEP_RUNTIME_TOKEN_FILE"
    return 0
  fi
  local data_dir="${YEP_ANYWHERE_DATA_DIR:-}"
  if [[ -z "$data_dir" ]]; then
    if [[ -n "${YEP_ANYWHERE_PROFILE:-}" ]]; then
      data_dir="${HOME}/.yep-anywhere-${YEP_ANYWHERE_PROFILE}"
    else
      data_dir="${HOME}/.yep-anywhere"
    fi
  fi
  printf '%s' "${data_dir}/runtime/token"
}

# Password login makes the web probe return 401. Ask the loopback runtime
# control port with the on-disk bearer token instead of treating that as an
# unknown listener. The control process reports mode "embedded" even when it
# is the external worker; the deployment mode comes from the LaunchAgent.
# The token is written into a 0600 curl config and is not placed on argv.
#
# Sets DEPLOY_WORKER_STATUS_JSON on success. Sets DEPLOY_WORKER_PROBE_FAILURE
# to auth-embedded or auth-external when the 401 cannot be resolved.
deploy_worker_status_behind_auth() {
  local base_url="$1"
  local http_code token_file token token_cfg workers curl_ok=0
  DEPLOY_WORKER_STATUS_JSON=""
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    "${base_url}/api/status/workers" 2>/dev/null || true)"
  if [[ "$http_code" != "401" ]]; then
    DEPLOY_WORKER_PROBE_FAILURE=""
    return 1
  fi

  local plist="${SERVER_LAUNCHD_PLIST:-$HOME/Library/LaunchAgents/${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}.plist}"
  local server_port="${SERVER_PORT:-8022}"
  if ! resolve_deploy_runtime "$plist" "$server_port"; then
    DEPLOY_WORKER_PROBE_FAILURE=auth
    return 1
  fi
  if [[ "$DEPLOY_RUNTIME_MODE" != "external" ]]; then
    DEPLOY_WORKER_PROBE_FAILURE=auth-embedded
    return 1
  fi

  token_file="$(deploy_runtime_token_file)"
  if [[ ! -f "$token_file" ]]; then
    DEPLOY_WORKER_PROBE_FAILURE=auth-external
    return 1
  fi
  token="$(<"$token_file")" || token=""
  token="${token//$'\n'/}"
  if [[ ! "$token" =~ ^[A-Za-z0-9_-]+$ ]]; then
    DEPLOY_WORKER_PROBE_FAILURE=auth-external
    return 1
  fi

  token_cfg="$(mktemp)"
  printf 'header = "Authorization: Bearer %s"\n' "$token" >"$token_cfg"
  chmod 600 "$token_cfg" || true
  workers="$(curl -fsS --max-time 3 --config "$token_cfg" \
    "${DEPLOY_RUNTIME_URL%/}/workers" 2>/dev/null)" || curl_ok=$?
  rm -f "$token_cfg"
  if (( curl_ok != 0 )); then
    DEPLOY_WORKER_PROBE_FAILURE=auth-external
    return 1
  fi

  DEPLOY_WORKER_STATUS_JSON="$(
    printf '%s' "$workers" | DEPLOY_RUNTIME_MODE="$DEPLOY_RUNTIME_MODE" node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let data;
  try { data = JSON.parse(raw); }
  catch { process.exit(1); }
  const mode = process.env.DEPLOY_RUNTIME_MODE;
  if (mode !== "external" || !data || typeof data.hasActiveWork !== "boolean" ||
      !Number.isInteger(data.queueLength) || data.queueLength < 0) {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    hasActiveWork: data.hasActiveWork,
    queueLength: data.queueLength,
    runtimeMode: mode,
  }));
});
'
  )" || {
    DEPLOY_WORKER_STATUS_JSON=""
    DEPLOY_WORKER_PROBE_FAILURE=auth-external
    return 1
  }
  DEPLOY_WORKER_PROBE_FAILURE=""
}

verify_deploy_runtime() {
  local base_url="$1" expected_mode="$2" actual_mode body curl_status=0
  body="$(curl -fsS --max-time 5 "${base_url}/api/status/workers" 2>/dev/null)" || curl_status=$?
  if (( curl_status != 0 )); then
    body=""
    if (( curl_status == 22 )); then
      deploy_worker_status_behind_auth "$base_url" || true
      body="${DEPLOY_WORKER_STATUS_JSON:-}"
    fi
    [[ -n "$body" ]] || return 1
  fi
  actual_mode="$(printf '%s' "$body" | node -e '
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

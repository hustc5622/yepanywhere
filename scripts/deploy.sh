#!/usr/bin/env bash
# Unified local deploy entrypoint for Yep Anywhere.
#
# With no arguments, this script opens an interactive deploy wizard.
# Passing any flag keeps the non-interactive behavior for aliases/automation.
#
# Usage:
#   scripts/deploy.sh                         # interactive wizard
#   scripts/deploy.sh --server-only           # non-interactive server deploy
#   scripts/deploy.sh --dev-server            # replace 8022 with dev hot reload
#   scripts/deploy.sh --codex-bridge-only     # non-interactive 4510 bridge deploy
#   scripts/deploy.sh --opencode-bridge-only    # non-interactive 4520 bridge deploy
#   scripts/deploy.sh --apk-only --debug
#   scripts/deploy.sh --restart-only --no-apk
#   scripts/deploy.sh --skip-checks --no-install
#
# Optional local deploy config:
#   .env.deploy.local                         # git-ignored KEY=value file
#   ./google-services.json                    # copied into the Android app if present
#   ./firebase-service-account*.json          # used for server FCM if env is unset

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

log()  { echo -e "${C_GREEN}==>${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!!${C_RESET}  $*" >&2; }
err()  { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim()  { echo -e "${C_DIM}    $*${C_RESET}"; }

LOADED_DEPLOY_ENV_FILE=""
DISCOVERED_FCM_SERVICE_ACCOUNT_FILE=""

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_deploy_env_file() {
  local env_file="${YEP_DEPLOY_ENV_FILE:-$REPO_ROOT/.env.deploy.local}"

  if [[ ! -f "$env_file" ]]; then
    if [[ -n "${YEP_DEPLOY_ENV_FILE:-}" ]]; then
      err "YEP_DEPLOY_ENV_FILE was set, but the file does not exist: $env_file"
      exit 1
    fi
    return
  fi

  local raw_line line key value
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    line="$(trim_whitespace "$raw_line")"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    if [[ "$line" == export[[:space:]]* ]]; then
      line="$(trim_whitespace "${line#export}")"
    fi
    if [[ "$line" != *=* ]]; then
      warn "Skipping invalid deploy env line in $env_file: $raw_line"
      continue
    fi

    key="$(trim_whitespace "${line%%=*}")"
    value="$(trim_whitespace "${line#*=}")"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      warn "Skipping invalid deploy env key in $env_file: $key"
      continue
    fi
    if [[ -n "${!key+x}" ]]; then
      continue
    fi

    if [[ ${#value} -ge 2 && "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:$((${#value} - 2))}"
    elif [[ ${#value} -ge 2 && "$value" == \'* && "$value" == *\' ]]; then
      value="${value:1:$((${#value} - 2))}"
    fi
    export "$key=$value"
  done <"$env_file"

  LOADED_DEPLOY_ENV_FILE="$env_file"
}

resolve_local_path() {
  local value="$1"
  case "$value" in
    "") return 1 ;;
    /*) printf '%s' "$value" ;;
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${value#~/}" ;;
    *) printf '%s/%s' "$REPO_ROOT" "$value" ;;
  esac
}

normalize_path_env_var() {
  local key="$1"
  local value="${!key:-}"
  [[ -z "$value" ]] && return
  export "$key=$(resolve_local_path "$value")"
}

discover_fcm_service_account_file() {
  if [[ -n "${YEP_FCM_SERVICE_ACCOUNT_FILE:-}" ||
    -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ||
    -n "${YEP_FCM_SERVICE_ACCOUNT_JSON:-}" ]]; then
    return
  fi

  local candidate
  for candidate in "$REPO_ROOT/firebase-service-account.json" "$REPO_ROOT"/firebase-service-account*.json; do
    [[ -f "$candidate" ]] || continue
    export YEP_FCM_SERVICE_ACCOUNT_FILE="$candidate"
    DISCOVERED_FCM_SERVICE_ACCOUNT_FILE="$candidate"
    return
  done
}

usage() {
  sed -n '2,18p' "$0" | sed 's/^# *//'
  cat <<'EOF'

Options:
  --server-only       Deploy only the server bundle
  --dev-server        Replace 8022 with dev hot reload (pnpm dev:8022 --replace)
  --allow-yep-session-interrupt
                      Allow --dev-server to interrupt active Yep-managed work
  --codex-bridge-only Deploy only the 4510 Codex bridge sidecar
  --opencode-bridge-only
                      Deploy only the 4520 OpenCode CLI bridge sidecar
  --apk-only          Build/install only the APK
  --no-server         Skip server deploy
  --no-apk            Skip APK build/install
  --restart-only      Restart existing server bundle without rebuilding it
  --server-build-only Build server bundle but do not restart
  --preserve-codex-bridge
                      Keep the Codex bridge sidecar alive while restarting the web server (default)
  --restart-codex-bridge
                      Restart the Codex bridge sidecar too; disconnects active cf sessions
  --restart-opencode-bridge
                      Restart the OpenCode CLI bridge sidecar too; the bridge manages its paired 4521 OpenCode server
  --embedded-codex-bridge
                      Legacy mode: run the Codex bridge inside the web server
  --skip-checks       Skip pnpm lint/typecheck preflight

APK options passed through:
  --debug, --release, --no-install, --no-build, -s/--device <device-id>

Native push deploy config:
  YEP_DEPLOY_ENV_FILE              Env file to load (default: .env.deploy.local)
  ALLOWED_IMAGE_PATHS              Extra local media paths for /api/local-image
                                   (default: /tmp,$HOME/Downloads)
  YEP_ANDROID_GOOGLE_SERVICES_JSON Source path copied to Android app google-services.json
  YEP_FCM_SERVICE_ACCOUNT_FILE     Firebase service account JSON path for server FCM
  YEP_FCM_SERVICE_ACCOUNT_JSON     Raw Firebase service account JSON for server FCM
  GOOGLE_APPLICATION_CREDENTIALS   Fallback Firebase service account JSON path
  YEP_SYNC_NATIVE_PUSH_LAUNCHAGENT=false
                                    Disable automatic server LaunchAgent FCM env sync
  YEP_REQUIRE_NATIVE_PUSH=true     Fail deploy when native push prerequisites are missing

AI session title deploy config:
  SESSION_TITLE_LLM_API_KEY        OpenAI-compatible API key for title generation
  LLM_API_KEY                      Fallback API key for title generation
  SESSION_TITLE_LLM_API_BASE       OpenAI-compatible API base for title generation
  LLM_API_BASE                     Fallback API base for title generation
  SESSION_TITLE_SUB_MODULE         X-Sub-Module header for title generation
  LLM_SUB_MODULE                   Fallback X-Sub-Module header for title generation
  SESSION_TITLE_MODEL              Title model (default: deepseek-v4-pro)
  SESSION_TITLE_GENERATION=false   Disable title generation
  SESSION_TITLE_TIMEOUT_MS         Title request timeout in milliseconds
  YEP_SYNC_SESSION_TITLE_LAUNCHAGENT=false
                                    Disable automatic server LaunchAgent title env sync
  YEP_REQUIRE_SESSION_TITLE_GENERATION=true
                                    Fail deploy when title generation is not configured
EOF
}

load_deploy_env_file
normalize_path_env_var "YEP_ANDROID_GOOGLE_SERVICES_JSON"
normalize_path_env_var "YEP_ANDROID_GOOGLE_SERVICES_TARGET"
normalize_path_env_var "YEP_FCM_SERVICE_ACCOUNT_FILE"
normalize_path_env_var "GOOGLE_APPLICATION_CREDENTIALS"
discover_fcm_service_account_file

DO_SERVER=true
DO_DEV_SERVER=false
ALLOW_YEP_SESSION_INTERRUPT=false
DO_CODEX_BRIDGE=false
DO_OPENCODE_BRIDGE=false
DO_APK=true
RUN_CHECKS=true
SERVER_ARGS=()
APK_ARGS=()
ANDROID_GOOGLE_SERVICES_TARGET="${YEP_ANDROID_GOOGLE_SERVICES_TARGET:-$REPO_ROOT/packages/mobile/src-tauri/gen/android/app/google-services.json}"
ANDROID_GOOGLE_SERVICES_SOURCE="${YEP_ANDROID_GOOGLE_SERVICES_JSON:-$REPO_ROOT/google-services.json}"
REQUIRE_NATIVE_PUSH="${YEP_REQUIRE_NATIVE_PUSH:-false}"
SYNC_NATIVE_PUSH_LAUNCHAGENT="${YEP_SYNC_NATIVE_PUSH_LAUNCHAGENT:-true}"
REQUIRE_SESSION_TITLE_GENERATION="${YEP_REQUIRE_SESSION_TITLE_GENERATION:-false}"
SYNC_SESSION_TITLE_LAUNCHAGENT="${YEP_SYNC_SESSION_TITLE_LAUNCHAGENT:-true}"
SERVER_ALLOWED_IMAGE_PATHS="${ALLOWED_IMAGE_PATHS:-/tmp,$HOME/Downloads}"
NEED_SERVER_LAUNCHAGENT_SYNC=false
SERVER_LAUNCHAGENT_SYNC_REASONS=()

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

is_falsey() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|n|off) return 0 ;;
    *) return 1 ;;
  esac
}

shell_quote() {
  printf '%q' "$1"
}

mark_server_launchagent_sync_needed() {
  local reason="$1"
  local existing

  NEED_SERVER_LAUNCHAGENT_SYNC=true
  for existing in "${SERVER_LAUNCHAGENT_SYNC_REASONS[@]-}"; do
    [[ "$existing" == "$reason" ]] && return
  done
  SERVER_LAUNCHAGENT_SYNC_REASONS+=("$reason")
}

server_args_contain() {
  local needle="$1"
  local arg
  for arg in "${SERVER_ARGS[@]-}"; do
    [[ "$arg" == "$needle" ]] && return 0
  done
  return 1
}

apk_args_contain() {
  local needle="$1"
  local arg
  for arg in "${APK_ARGS[@]-}"; do
    [[ "$arg" == "$needle" ]] && return 0
  done
  return 1
}

server_deploy_restarts() {
  $DO_SERVER || return 1
  ! server_args_contain "--no-restart"
}

apk_builds() {
  $DO_APK || return 1
  ! apk_args_contain "--no-build"
}

ask_yes_no() {
  local prompt="$1"
  local default="$2"
  local reply
  local reply_lc

  while true; do
    if [[ "$default" == "yes" ]]; then
      read -r -p "$prompt [Y/n] " reply
      reply="${reply:-y}"
    else
      read -r -p "$prompt [y/N] " reply
      reply="${reply:-n}"
    fi

    reply_lc="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    case "$reply_lc" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) warn "Please answer y or n." ;;
    esac
  done
}

choose_apk_build_type() {
  local reply
  local reply_lc

  echo
  log "APK build type"
  dim "release: production-signed build; slower, smaller, requires keystore.properties."
  dim "debug: development-signed build; faster, cannot update over a release-signed install."

  while true; do
    read -r -p "Choose APK build type: 1) release  2) debug  [1] " reply
    reply="${reply:-1}"
    reply_lc="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    case "$reply_lc" in
      1|r|release)
        APK_ARGS+=(--release)
        return
        ;;
      2|d|debug)
        APK_ARGS+=(--debug)
        return
        ;;
      *) warn "Please choose 1/release or 2/debug." ;;
    esac
  done
}

configure_interactive() {
  DO_SERVER=false
  DO_CODEX_BRIDGE=false
  DO_OPENCODE_BRIDGE=false
  DO_APK=false
  RUN_CHECKS=false
  SERVER_ARGS=()
  APK_ARGS=()

  log "Interactive deploy"
  dim "Press Enter to accept the default shown in brackets."

  echo
  log "8022 web/API server"
  dim "8022 is the main Yep Anywhere service: it serves the /yep web UI, REST APIs,"
  dim "and the browser/mobile WebSocket endpoint used by the frontend."
  dim "Redeploying it rebuilds the server/client bundle and restarts only that web/API service."
  if ask_yes_no "Redeploy 8022 web/API server?" "yes"; then
    DO_SERVER=true
    RUN_CHECKS=true
  fi

  echo
  log "4510 Codex bridge"
  dim "4510 is the local WebSocket bridge used by cf / codex --remote sessions."
  dim "Choosing no leaves the existing 4510 process untouched."
  dim "Choosing yes restarts 4510 and disconnects active cf / codex --remote sessions."
  if ask_yes_no "Redeploy 4510 Codex bridge service?" "no"; then
    DO_CODEX_BRIDGE=true
    RUN_CHECKS=true
    SERVER_ARGS+=(--restart-codex-bridge)
  fi

  echo
  log "4520 OpenCode bridge"
  dim "4520 is the local HTTP bridge used by OpenCode CLI clients."
  dim "The bridge manages its paired OpenCode server starting at 4521."
  dim "Choosing no leaves the existing 4520 process untouched."
  dim "Choosing yes restarts 4520; active terminal wrapper sessions may disconnect."
  if ask_yes_no "Redeploy 4520 OpenCode bridge service?" "no"; then
    DO_OPENCODE_BRIDGE=true
    RUN_CHECKS=true
    SERVER_ARGS+=(--restart-opencode-bridge)
  fi

  echo
  log "Android APK"
  dim "This rebuilds the Tauri Android APK and installs it onto a connected adb device."
  dim "Device selection and signature-mismatch handling are delegated to scripts/rebuild-apk.sh."
  if ask_yes_no "Build APK and install it?" "no"; then
    DO_APK=true
    choose_apk_build_type
  fi
}

sync_android_google_services() {
  if ! apk_builds; then
    return 0
  fi

  if [[ -n "${YEP_ANDROID_GOOGLE_SERVICES_JSON:-}" && ! -f "$ANDROID_GOOGLE_SERVICES_SOURCE" ]]; then
    err "YEP_ANDROID_GOOGLE_SERVICES_JSON was set, but the file does not exist: $ANDROID_GOOGLE_SERVICES_SOURCE"
    exit 1
  fi

  if [[ ! -f "$ANDROID_GOOGLE_SERVICES_SOURCE" ]]; then
    return
  fi
  if [[ "$ANDROID_GOOGLE_SERVICES_SOURCE" == "$ANDROID_GOOGLE_SERVICES_TARGET" ]]; then
    return
  fi

  mkdir -p "$(dirname "$ANDROID_GOOGLE_SERVICES_TARGET")"
  if [[ ! -f "$ANDROID_GOOGLE_SERVICES_TARGET" ]] ||
    ! cmp -s "$ANDROID_GOOGLE_SERVICES_SOURCE" "$ANDROID_GOOGLE_SERVICES_TARGET"; then
    cp "$ANDROID_GOOGLE_SERVICES_SOURCE" "$ANDROID_GOOGLE_SERVICES_TARGET"
    dim "native push APK config: copied $(shell_quote "$ANDROID_GOOGLE_SERVICES_SOURCE") -> $(shell_quote "$ANDROID_GOOGLE_SERVICES_TARGET")"
  fi
}

check_native_push_preflight() {
  local missing=0

  if apk_builds; then
    if [[ -f "$ANDROID_GOOGLE_SERVICES_TARGET" ]]; then
      dim "native push APK config: $ANDROID_GOOGLE_SERVICES_TARGET"
    else
      warn "native push APK config is missing: $ANDROID_GOOGLE_SERVICES_TARGET"
      warn "APK build can continue, but Android native push token registration will be unavailable."
      missing=1
    fi
  elif $DO_APK; then
    dim "native push APK config: skipped because APK build is disabled by --no-build"
  fi

  if $DO_SERVER; then
    local fcm_file="${YEP_FCM_SERVICE_ACCOUNT_FILE:-${GOOGLE_APPLICATION_CREDENTIALS:-}}"
    local fcm_json="${YEP_FCM_SERVICE_ACCOUNT_JSON:-}"
    local shell_has_fcm=false

    if [[ -n "$fcm_file" ]]; then
      if [[ ! -f "$fcm_file" ]]; then
        err "FCM service account file does not exist: $fcm_file"
        exit 1
      fi
      shell_has_fcm=true
    elif [[ -n "$fcm_json" ]]; then
      shell_has_fcm=true
    fi

    local server_label="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
    local launchd_loaded=false
    local launchd_has_fcm=false
    local launchd_has_current_fcm=false

    if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
      local user_domain="gui/$(id -u)"
      local launchd_state
      launchd_state="$(launchctl print "$user_domain/$server_label" 2>/dev/null || true)"
      if [[ -n "$launchd_state" ]]; then
        launchd_loaded=true
        case "$launchd_state" in
          *YEP_FCM_SERVICE_ACCOUNT_FILE*|*YEP_FCM_SERVICE_ACCOUNT_JSON*|*GOOGLE_APPLICATION_CREDENTIALS*)
            launchd_has_fcm=true
            ;;
        esac
        if [[ -n "$fcm_file" && "$launchd_state" == *"$fcm_file"* ]]; then
          launchd_has_current_fcm=true
        elif [[ -n "$fcm_json" && "$launchd_state" == *YEP_FCM_SERVICE_ACCOUNT_JSON* ]]; then
          launchd_has_current_fcm=true
        elif ! $shell_has_fcm && $launchd_has_fcm; then
          launchd_has_current_fcm=true
        fi
      fi
    fi

    if $launchd_loaded; then
      if $launchd_has_current_fcm; then
        dim "native push server config: LaunchAgent $server_label has FCM credentials"
      elif $shell_has_fcm && server_deploy_restarts && is_truthy "$SYNC_NATIVE_PUSH_LAUNCHAGENT"; then
        mark_server_launchagent_sync_needed "native push"
        if $launchd_has_fcm; then
          dim "native push server config: LaunchAgent $server_label will be refreshed before server restart"
        else
          dim "native push server config: LaunchAgent $server_label will be updated before server restart"
        fi
      else
        warn "native push server config is missing from loaded LaunchAgent $server_label."
        warn "Redeploy uses the LaunchAgent environment, so current shell FCM variables will not affect the restarted server."
        missing=1
        if [[ -n "$fcm_file" ]]; then
          if ! server_deploy_restarts; then
            dim "server deploy is build-only, so LaunchAgent env was not auto-synced"
          elif ! is_truthy "$SYNC_NATIVE_PUSH_LAUNCHAGENT"; then
            dim "YEP_SYNC_NATIVE_PUSH_LAUNCHAGENT is disabled"
          else
            dim "persist it with: YEP_FCM_SERVICE_ACCOUNT_FILE=$(shell_quote "$fcm_file") scripts/install-launchagents.sh --server-only"
          fi
        else
          dim "persist it with: YEP_FCM_SERVICE_ACCOUNT_FILE=/path/to/firebase-service-account.json scripts/install-launchagents.sh --server-only"
        fi
      fi
    elif $shell_has_fcm; then
      dim "native push server config: FCM credentials supplied in current environment"
    else
      warn "native push server config is missing from the current environment."
      warn "Native Android devices can subscribe locally, but server-side FCM delivery will fail until credentials are configured."
      missing=1
      dim "set one of: YEP_FCM_SERVICE_ACCOUNT_FILE, YEP_FCM_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS"
    fi
  fi

  if [[ "$missing" -ne 0 ]]; then
    dim "set YEP_REQUIRE_NATIVE_PUSH=true to make deploy fail fast when native push prerequisites are missing"
    if is_truthy "$REQUIRE_NATIVE_PUSH"; then
      err "Native push prerequisites are missing and YEP_REQUIRE_NATIVE_PUSH=true."
      exit 1
    fi
  fi
}

check_session_title_preflight() {
  $DO_SERVER || return 0

  local title_api_key="${SESSION_TITLE_LLM_API_KEY:-${LLM_API_KEY:-}}"
  local shell_has_title_key=false
  local shell_requests_title_disable=false
  local missing=0

  if [[ -n "$title_api_key" ]]; then
    shell_has_title_key=true
  fi
  if [[ -n "${SESSION_TITLE_GENERATION+x}" ]] && is_falsey "$SESSION_TITLE_GENERATION"; then
    shell_requests_title_disable=true
  fi

  local server_label="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
  local launchd_loaded=false
  local launchd_has_title_config=false
  local launchd_has_title_key=false

  if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    local user_domain="gui/$(id -u)"
    local launchd_state
    launchd_state="$(launchctl print "$user_domain/$server_label" 2>/dev/null || true)"
    if [[ -n "$launchd_state" ]]; then
      launchd_loaded=true
      case "$launchd_state" in
        *SESSION_TITLE_LLM_API_KEY*|*LLM_API_KEY*)
          launchd_has_title_key=true
          launchd_has_title_config=true
          ;;
      esac
      case "$launchd_state" in
        *SESSION_TITLE_GENERATION*|*SESSION_TITLE_LLM_API_BASE*|*LLM_API_BASE*|*SESSION_TITLE_SUB_MODULE*|*LLM_SUB_MODULE*|*SESSION_TITLE_MODEL*|*SESSION_TITLE_TIMEOUT_MS*)
          launchd_has_title_config=true
          ;;
      esac
    fi
  fi

  if $launchd_loaded; then
    if { $shell_has_title_key || $shell_requests_title_disable; } &&
      server_deploy_restarts &&
      is_truthy "$SYNC_SESSION_TITLE_LAUNCHAGENT"; then
      mark_server_launchagent_sync_needed "session titles"
      if $launchd_has_title_config; then
        dim "session title config: LaunchAgent $server_label will be refreshed before server restart"
      else
        dim "session title config: LaunchAgent $server_label will be updated before server restart"
      fi
    elif $launchd_has_title_key; then
      dim "session title config: LaunchAgent $server_label has an LLM API key"
    elif $shell_requests_title_disable; then
      dim "session title config: disabled by SESSION_TITLE_GENERATION=$SESSION_TITLE_GENERATION"
      if server_deploy_restarts && ! is_truthy "$SYNC_SESSION_TITLE_LAUNCHAGENT"; then
        dim "YEP_SYNC_SESSION_TITLE_LAUNCHAGENT is disabled; LaunchAgent env was not updated"
      fi
    else
      warn "session title config is missing from loaded LaunchAgent $server_label."
      warn "Redeploy uses the LaunchAgent environment, so current shell LLM variables will not affect the restarted server unless they are synced."
      missing=1
      if $shell_has_title_key; then
        if ! server_deploy_restarts; then
          dim "server deploy is build-only, so LaunchAgent env was not auto-synced"
        elif ! is_truthy "$SYNC_SESSION_TITLE_LAUNCHAGENT"; then
          dim "YEP_SYNC_SESSION_TITLE_LAUNCHAGENT is disabled"
        else
          dim "persist it with: SESSION_TITLE_LLM_API_KEY=<redacted> scripts/install-launchagents.sh --server-only"
        fi
      else
        dim "set SESSION_TITLE_LLM_API_KEY or LLM_API_KEY in .env.deploy.local or the deploying shell"
      fi
    fi
  elif $shell_has_title_key; then
    dim "session title config: LLM API key supplied in current environment"
  elif $shell_requests_title_disable; then
    dim "session title config: disabled by SESSION_TITLE_GENERATION=$SESSION_TITLE_GENERATION"
  else
    warn "session title generation is not configured in the current environment."
    warn "AI-generated aiTitle values will remain disabled until an LLM API key is available to the server."
    missing=1
    dim "set SESSION_TITLE_LLM_API_KEY or LLM_API_KEY in .env.deploy.local or the deploying shell"
  fi

  if [[ "$missing" -ne 0 ]]; then
    dim "set YEP_REQUIRE_SESSION_TITLE_GENERATION=true to make deploy fail fast when title generation is missing"
    if is_truthy "$REQUIRE_SESSION_TITLE_GENERATION"; then
      err "Session title generation is missing and YEP_REQUIRE_SESSION_TITLE_GENERATION=true."
      exit 1
    fi
  fi
}

check_local_media_preflight() {
  $DO_SERVER || return 0

  local server_label="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
  local expected="$SERVER_ALLOWED_IMAGE_PATHS"
  local launchd_state=""
  local plist="$HOME/Library/LaunchAgents/$server_label.plist"
  local plist_content=""

  if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    local user_domain="gui/$(id -u)"
    launchd_state="$(launchctl print "$user_domain/$server_label" 2>/dev/null || true)"
  fi

  if [[ -n "$launchd_state" ]]; then
    if [[ "$launchd_state" == *"ALLOWED_IMAGE_PATHS"* && "$launchd_state" == *"$expected"* ]]; then
      dim "local media config: LaunchAgent $server_label allows $expected"
      return 0
    fi

    if server_deploy_restarts; then
      mark_server_launchagent_sync_needed "local media paths"
      dim "local media config: LaunchAgent $server_label will be updated with ALLOWED_IMAGE_PATHS=$expected"
    else
      warn "local media config in loaded LaunchAgent $server_label does not include ALLOWED_IMAGE_PATHS=$expected."
      dim "server deploy is build-only, so LaunchAgent env was not auto-synced"
    fi
    return 0
  fi

  if [[ -f "$plist" ]]; then
    plist_content="$(cat "$plist")"
    if [[ "$plist_content" == *"<key>ALLOWED_IMAGE_PATHS</key>"* && "$plist_content" == *"$expected"* ]]; then
      dim "local media config: LaunchAgent plist allows $expected"
      return 0
    fi

    if server_deploy_restarts; then
      mark_server_launchagent_sync_needed "local media paths"
      dim "local media config: LaunchAgent plist will be updated with ALLOWED_IMAGE_PATHS=$expected"
    else
      warn "local media config in $plist does not include ALLOWED_IMAGE_PATHS=$expected."
      dim "server deploy is build-only, so LaunchAgent env was not auto-synced"
    fi
  fi
}

ensure_server_bundle_for_launchagent_sync() {
  local cli_js="$REPO_ROOT/dist/npm-package/dist/cli.js"

  if server_args_contain "--restart"; then
    [[ -f "$cli_js" ]] && return
    err "Cannot sync the server LaunchAgent before restart because $cli_js is missing."
    err "Run a non-restart-only server deploy once so the bundle can be built."
    exit 1
  fi

  log "Building server bundle before LaunchAgent env sync ..."
  scripts/redeploy-server.sh --no-restart
  SERVER_ARGS+=("--restart")
}

sync_server_launchagent_env_if_needed() {
  if ! $NEED_SERVER_LAUNCHAGENT_SYNC; then
    return 0
  fi
  ensure_server_bundle_for_launchagent_sync

  log "Syncing env into the 8022 server LaunchAgent ..."
  if [[ ${#SERVER_LAUNCHAGENT_SYNC_REASONS[@]} -gt 0 ]]; then
    dim "reasons: ${SERVER_LAUNCHAGENT_SYNC_REASONS[*]}"
  fi
  dim "4510 Codex bridge and 4520 OpenCode bridge are not touched"
  scripts/install-launchagents.sh --server-only
}

start_dev_server() {
  local server_port="${YEP_DEPLOY_PORT:-8022}"
  local raw_base_path="${YEP_DEPLOY_BASE_PATH:-/yep}"
  local server_base_path
  local server_base_url
  local dev_log="${YEP_DEV_8022_LOG:-/tmp/yep-dev-8022.log}"

  if [[ "$raw_base_path" == "/" ]]; then
    server_base_path=""
  else
    server_base_path="/${raw_base_path#/}"
    server_base_path="${server_base_path%/}"
  fi
  server_base_url="http://127.0.0.1:${server_port}${server_base_path}"

  log "Starting 8022 dev hot reload ..."
  dim "server: ${server_base_url}"
  dim "log:    ${dev_log}"
  dim "mode:   pnpm dev:8022 --replace"

  local dev_args=(dev:8022 --replace)
  if $ALLOW_YEP_SESSION_INTERRUPT; then
    dev_args+=(--allow-yep-session-interrupt)
  fi

  : >"$dev_log"
  PORT="$server_port" \
    BASE_PATH="${server_base_path:-/}" \
    ALLOWED_IMAGE_PATHS="$SERVER_ALLOWED_IMAGE_PATHS" \
    nohup pnpm "${dev_args[@]}" >"$dev_log" 2>&1 &
  local dev_pid=$!
  disown "$dev_pid" 2>/dev/null || true

  log "Waiting for ${server_base_url}/api/version ..."
  for _ in $(seq 1 120); do
    if dev_server_ready "${server_base_url}/api/version" &&
      dev_frontend_ready "${server_base_url}/" "${server_base_path:-/}"; then
      log "8022 dev hot reload is running."
      echo "Deploy complete."
      return 0
    fi
    if ! kill -0 "$dev_pid" 2>/dev/null; then
      err "Dev hot reload process exited before ${server_base_url}/api/version became ready."
      tail -80 "$dev_log" >&2 || true
      return 1
    fi
    sleep 0.25
  done

  err "Dev hot reload did not answer ${server_base_url}/api/version within 30s."
  tail -80 "$dev_log" >&2 || true
  return 1
}

dev_frontend_ready() {
  local frontend_url="$1"
  local expected_base_path="${2:-/yep}"
  local body
  local vite_client_path
  body="$(curl -fsS "$frontend_url" 2>/dev/null)" || return 1
  if [[ "$expected_base_path" == "/" || -z "$expected_base_path" ]]; then
    vite_client_path="/@vite/client"
  else
    vite_client_path="${expected_base_path%/}/@vite/client"
  fi
  [[ "$body" == *"$vite_client_path"* ]]
}

dev_server_ready() {
  local version_url="$1"
  local body
  body="$(curl -fsS "$version_url" 2>/dev/null)" || return 1
  YEP_VERSION_JSON="$body" node -e '
const info = JSON.parse(process.env.YEP_VERSION_JSON || "{}");
const build = info && info.build;
process.exit(build && build.source === "dev" && build.nodeEnv === "development" ? 0 : 1);
' >/dev/null 2>&1
}

if [[ $# -eq 0 ]]; then
  if [[ -t 0 ]]; then
    configure_interactive
  else
    err "No arguments were provided, and stdin is not a terminal."
    err "Run scripts/deploy.sh from a terminal for the interactive wizard, or pass flags for non-interactive use."
    exit 2
  fi
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --server-only)
        DO_SERVER=true
        DO_DEV_SERVER=false
        DO_CODEX_BRIDGE=false
        DO_OPENCODE_BRIDGE=false
        DO_APK=false
        shift
        ;;
      --dev-server)
        DO_SERVER=true
        DO_DEV_SERVER=true
        DO_CODEX_BRIDGE=false
        DO_OPENCODE_BRIDGE=false
        DO_APK=false
        RUN_CHECKS=false
        shift
        ;;
      --allow-yep-session-interrupt)
        ALLOW_YEP_SESSION_INTERRUPT=true
        shift
        ;;
      --codex-bridge-only)
        DO_SERVER=false
        DO_CODEX_BRIDGE=true
        DO_OPENCODE_BRIDGE=false
        DO_APK=false
        SERVER_ARGS+=(--restart-codex-bridge)
        shift
        ;;
      --opencode-bridge-only)
        DO_SERVER=false
        DO_CODEX_BRIDGE=false
        DO_OPENCODE_BRIDGE=true
        DO_APK=false
        SERVER_ARGS+=(--restart-opencode-bridge)
        shift
        ;;
      --apk-only)
        DO_SERVER=false
        DO_CODEX_BRIDGE=false
        DO_OPENCODE_BRIDGE=false
        DO_APK=true
        RUN_CHECKS=false
        shift
        ;;
      --no-server)
        DO_SERVER=false
        shift
        ;;
      --no-apk)
        DO_APK=false
        shift
        ;;
      --restart-only)
        SERVER_ARGS+=(--restart)
        RUN_CHECKS=false
        shift
        ;;
      --server-build-only)
        SERVER_ARGS+=(--no-restart)
        shift
        ;;
      --preserve-codex-bridge)
        SERVER_ARGS+=(--preserve-codex-bridge)
        shift
        ;;
      --restart-codex-bridge)
        DO_CODEX_BRIDGE=true
        SERVER_ARGS+=(--restart-codex-bridge)
        shift
        ;;
      --restart-opencode-bridge)
        DO_OPENCODE_BRIDGE=true
        SERVER_ARGS+=(--restart-opencode-bridge)
        shift
        ;;
      --embedded-codex-bridge|--no-preserve-codex-bridge)
        SERVER_ARGS+=("$1")
        shift
        ;;
      --skip-checks)
        RUN_CHECKS=false
        shift
        ;;
      --debug|--release|--no-install|--no-build)
        APK_ARGS+=("$1")
        shift
        ;;
      -s|--device)
        if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
          err "$1 requires a device id argument."
          exit 2
        fi
        APK_ARGS+=("$1" "$2")
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        err "Unknown arg: $1"
        err "Run with --help for usage."
        exit 2
        ;;
    esac
  done
fi

if ! $DO_SERVER && ! $DO_CODEX_BRIDGE && ! $DO_OPENCODE_BRIDGE && ! $DO_APK; then
  err "Nothing to deploy: 8022 server, 4510 bridge, 4520 bridge, and APK are all disabled."
  exit 2
fi

log "Deploy plan"
dim "8022 web/API:        $DO_SERVER"
dim "8022 dev hot reload: $DO_DEV_SERVER"
dim "allow session interrupt: $ALLOW_YEP_SESSION_INTERRUPT"
dim "4510 Codex bridge:   $DO_CODEX_BRIDGE"
dim "4520 OpenCode bridge:  $DO_OPENCODE_BRIDGE"
dim "server args:         ${SERVER_ARGS[*]:-}"
dim "apk:                 $DO_APK ${APK_ARGS[*]:-}"
dim "checks:              $RUN_CHECKS"
if [[ -n "$LOADED_DEPLOY_ENV_FILE" ]]; then
  dim "deploy env:        $LOADED_DEPLOY_ENV_FILE"
fi
if [[ -n "$DISCOVERED_FCM_SERVICE_ACCOUNT_FILE" ]]; then
  dim "server FCM:        auto-detected $DISCOVERED_FCM_SERVICE_ACCOUNT_FILE"
fi
if [[ -n "${SESSION_TITLE_LLM_API_KEY:-${LLM_API_KEY:-}}" ]]; then
  dim "session titles:    LLM API key available in deploy env"
elif [[ -n "${SESSION_TITLE_GENERATION+x}" ]] && is_falsey "$SESSION_TITLE_GENERATION"; then
  dim "session titles:    disabled by deploy env"
fi

if ! $DO_DEV_SERVER; then
  log "Checking native push deploy prerequisites ..."
  sync_android_google_services
  check_native_push_preflight
  log "Checking session title deploy prerequisites ..."
  check_session_title_preflight
  log "Checking local media deploy prerequisites ..."
  check_local_media_preflight
fi

if $RUN_CHECKS && { $DO_SERVER || $DO_CODEX_BRIDGE || $DO_OPENCODE_BRIDGE; }; then
  log "Running preflight checks ..."
  pnpm lint
  pnpm typecheck
fi

if ! $DO_DEV_SERVER; then
  sync_server_launchagent_env_if_needed
fi

if $DO_DEV_SERVER; then
  start_dev_server
elif $DO_SERVER || $DO_CODEX_BRIDGE || $DO_OPENCODE_BRIDGE; then
  log "Deploying server services ..."
  if ! $DO_SERVER; then
    SERVER_ARGS+=(--no-restart)
  fi
  if [[ ${#SERVER_ARGS[@]} -gt 0 ]]; then
    scripts/redeploy-server.sh "${SERVER_ARGS[@]}"
  else
    scripts/redeploy-server.sh
  fi
else
  warn "Skipping server services deploy."
fi

if $DO_APK; then
  log "Building/installing APK ..."
  if [[ ${#APK_ARGS[@]} -gt 0 ]]; then
    scripts/rebuild-apk.sh "${APK_ARGS[@]}"
  else
    scripts/rebuild-apk.sh
  fi
else
  warn "Skipping APK build/install."
fi

log "Deploy complete."

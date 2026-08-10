#!/usr/bin/env bash
# Install macOS LaunchAgents that start Yep Anywhere once when this user logs in.
#
# The 8022 server restarts only after an abnormal exit. Intentional shutdowns
# and deploys exit successfully and remain under the user's control.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

log()  { echo -e "${C_GREEN}==>${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!!${C_RESET}  $*" >&2; }
err()  { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim()  { echo -e "${C_DIM}    $*${C_RESET}"; }

# The plist is rebuilt from the current environment, so the local deploy env
# file must be loaded before any credential-bearing variable is resolved below.
# Otherwise a standalone run silently drops secrets that scripts/deploy.sh
# would have supplied, and the reinstalled LaunchAgent loses them.
# shellcheck source=scripts/lib/deploy-env.sh
source "$SCRIPT_DIR/lib/deploy-env.sh"
load_deploy_env_file

SERVER_LABEL="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
BRIDGE_LABEL="${YEP_LAUNCHD_BRIDGE_LABEL:-com.yueyuan.yepanywhere.codex-bridge}"
OPENCODE_BRIDGE_LABEL="${YEP_LAUNCHD_OPENCODE_BRIDGE_LABEL:-com.yueyuan.yepanywhere.opencode-bridge}"
SERVER_PORT="${YEP_DEPLOY_PORT:-8022}"
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/yep}"
SERVER_ALLOWED_IMAGE_PATHS="${ALLOWED_IMAGE_PATHS:-/tmp,$HOME/Downloads}"
SERVER_ALLOWED_HOSTS="${ALLOWED_HOSTS:-}"
BRIDGE_PORT="${YEP_CODEX_BRIDGE_PORT:-${CODEX_BRIDGE_PORT:-4510}}"
BRIDGE_URL="${YEP_CODEX_BRIDGE_CONTROL_URL:-${CODEX_BRIDGE_CONTROL_URL:-http://127.0.0.1:${BRIDGE_PORT}}}"
CODEX_CLI_PATH="${YEP_CODEX_PATH:-${CODEX_PATH:-}}"
OPENCODE_BRIDGE_PORT="${YEP_OPENCODE_BRIDGE_PORT:-${OPENCODE_BRIDGE_PORT:-4520}}"
OPENCODE_BRIDGE_URL="${YEP_OPENCODE_BRIDGE_CONTROL_URL:-${OPENCODE_BRIDGE_CONTROL_URL:-http://127.0.0.1:${OPENCODE_BRIDGE_PORT}}}"
OPENCODE_SERVER_HOST="${YEP_OPENCODE_HOST:-127.0.0.1}"
OPENCODE_SERVER_START_PORT="${YEP_OPENCODE_SERVER_START_PORT:-${YEP_OPENCODE_PORT:-${OPENCODE_SERVER_START_PORT:-${OPENCODE_PORT:-$((OPENCODE_BRIDGE_PORT + 1))}}}}"
OPENCODE_BRIDGE_UPSTREAM_URL="${YEP_OPENCODE_BRIDGE_UPSTREAM_URL:-${OPENCODE_BRIDGE_UPSTREAM_URL:-}}"
SERVER_URL="http://127.0.0.1:${SERVER_PORT}${SERVER_BASE_PATH}"
if [[ -n "${YEP_LAUNCHD_NODE:-}" ]]; then
  NODE_BIN="$YEP_LAUNCHD_NODE"
elif [[ -n "${NVM_BIN:-}" && -x "$NVM_BIN/node" ]]; then
  NODE_BIN="$NVM_BIN/node"
else
  # launchd does not initialize the interactive shell, and a Homebrew Node
  # ahead of NVM on PATH can be incompatible with the installed native deps.
  # Prefer the locally managed NVM runtime when one is available.
  NVM_NODE_BIN="$(find "$HOME/.nvm/versions/node" -path '*/bin/node' -type f -print 2>/dev/null | sort | tail -n 1)"
  NODE_BIN="${NVM_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
fi
SOURCE_BUNDLE_DIR="$REPO_ROOT/dist/npm-package"
SOURCE_CLI_JS="$SOURCE_BUNDLE_DIR/dist/cli.js"
LAUNCHD_RUNTIME_DIR="${YEP_LAUNCHD_RUNTIME_DIR:-$HOME/.yep-anywhere/runtime/npm-package}"
CLI_JS="$LAUNCHD_RUNTIME_DIR/dist/cli.js"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="${YEP_LAUNCHD_LOG_DIR:-$HOME/.yep-anywhere/logs}"
USER_DOMAIN="gui/$(id -u)"
START_NOW=true
INSTALL_SERVER=true
INSTALL_CODEX_BRIDGE=true
INSTALL_OPENCODE_BRIDGE=true

usage() {
  sed -n '2,6p' "$0" | sed 's/^# *//'
  cat <<'EOF'

Usage:
  scripts/install-launchagents.sh [--server-only|--bridge-only|--opencode-bridge-only] [--no-start]

Options:
  --server-only                Write/reload only the 8022 server LaunchAgent
  --bridge-only, --codex-bridge-only
                               Write/reload only the 4510 Codex bridge LaunchAgent
  --opencode-bridge-only         Write/reload only the 4520 OpenCode bridge LaunchAgent
  --bridges-only               Write/reload both bridge LaunchAgents
  --no-start                   Write plist file(s) without unloading or starting LaunchAgents

Environment overrides:
  YEP_DEPLOY_PORT              Main server port (default: 8022)
  YEP_DEPLOY_BASE_PATH         Main server base path (default: /yep)
  ALLOWED_IMAGE_PATHS          Extra local media paths for /api/local-image
                               (default: /tmp,$HOME/Downloads)
  YEP_CODEX_BRIDGE_PORT        Codex bridge port (default: 4510)
  YEP_OPENCODE_BRIDGE_PORT       OpenCode bridge port (default: 4520)
  YEP_OPENCODE_SERVER_START_PORT OpenCode managed server start port (default: 4521)
  YEP_OPENCODE_BRIDGE_UPSTREAM_URL
                               Optional external OpenCode server URL observed by the bridge
  YEP_LAUNCHD_NODE             Absolute node binary path
  YEP_LAUNCHD_PATH             PATH stored in the LaunchAgent environment
  YEP_CODEX_PATH               Absolute Codex CLI path stored for server/bridge detection
  YEP_LAUNCHD_RUNTIME_DIR      Bundle copy used by LaunchAgents
                               (default: ~/.yep-anywhere/runtime/npm-package)
  YEP_LAUNCHD_LOG_DIR          LaunchAgent stdout/stderr log directory
  ALLOWED_HOSTS                Comma-separated public hostnames/IPs accepted by the server
  YEP_FCM_SERVICE_ACCOUNT_FILE Firebase service account JSON path for Android native push
  YEP_FCM_SERVICE_ACCOUNT_JSON Raw Firebase service account JSON for Android native push
  GOOGLE_APPLICATION_CREDENTIALS
                               Fallback Firebase service account JSON path
  SESSION_TITLE_LLM_API_KEY    OpenAI-compatible API key for AI session titles
  LLM_API_KEY                  Shared fallback API key for session titles and OpenCode
  SESSION_TITLE_LLM_API_BASE   OpenAI-compatible API base for AI session titles
  LLM_API_BASE                 Shared fallback API base for session titles and OpenCode
  SESSION_TITLE_SUB_MODULE     X-Sub-Module header for AI session titles
  LLM_SUB_MODULE               Shared fallback X-Sub-Module header for session titles and OpenCode
  OPENCODE_LLM_API_KEY         API key for managed OpenCode model requests
  OPENCODE_LLM_API_BASE        API base for managed OpenCode model requests
  OPENCODE_LLM_SUB_MODULE      X-Sub-Module header for managed OpenCode model requests
  NEW_LLM_API_KEY              Secondary API key exposed to custom OpenCode providers
  SESSION_TITLE_MODEL          Model for AI session titles (default: deepseek-v4-pro)
  SESSION_TITLE_GENERATION     Set false to disable AI session titles
  SESSION_TITLE_TIMEOUT_MS     Request timeout for AI session title generation
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --no-start)
      START_NOW=false
      shift
      ;;
    --server-only)
      INSTALL_SERVER=true
      INSTALL_CODEX_BRIDGE=false
      INSTALL_OPENCODE_BRIDGE=false
      shift
      ;;
    --bridge-only|--codex-bridge-only)
      INSTALL_SERVER=false
      INSTALL_CODEX_BRIDGE=true
      INSTALL_OPENCODE_BRIDGE=false
      shift
      ;;
    --opencode-bridge-only)
      INSTALL_SERVER=false
      INSTALL_CODEX_BRIDGE=false
      INSTALL_OPENCODE_BRIDGE=true
      shift
      ;;
    --bridges-only)
      INSTALL_SERVER=false
      INSTALL_CODEX_BRIDGE=true
      INSTALL_OPENCODE_BRIDGE=true
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

if ! $INSTALL_SERVER && ! $INSTALL_CODEX_BRIDGE && ! $INSTALL_OPENCODE_BRIDGE; then
  err "Nothing to install: server and bridges are all disabled."
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "LaunchAgents are only available on macOS."
  exit 1
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  err "Could not find an executable node binary. Set YEP_LAUNCHD_NODE=/absolute/path/to/node."
  exit 1
fi

if [[ -n "$CODEX_CLI_PATH" && ( "$CODEX_CLI_PATH" != /* || ! -x "$CODEX_CLI_PATH" ) ]]; then
  err "YEP_CODEX_PATH/CODEX_PATH must be an absolute executable path: $CODEX_CLI_PATH"
  exit 1
fi

if [[ ! -f "$SOURCE_CLI_JS" ]]; then
  err "Expected bundled CLI at $SOURCE_CLI_JS, but it does not exist."
  err "Run scripts/deploy.sh --server-only once to build dist/npm-package, then retry."
  exit 1
fi

if [[ ! -d "$SOURCE_BUNDLE_DIR/node_modules" ]]; then
  warn "Runtime dependencies are missing from $SOURCE_BUNDLE_DIR/node_modules."
  warn "Run scripts/deploy.sh --server-only before relying on the LaunchAgents."
fi

FCM_SERVICE_ACCOUNT_FILE="${YEP_FCM_SERVICE_ACCOUNT_FILE:-${GOOGLE_APPLICATION_CREDENTIALS:-}}"
FCM_SERVICE_ACCOUNT_JSON="${YEP_FCM_SERVICE_ACCOUNT_JSON:-}"
if [[ -n "$FCM_SERVICE_ACCOUNT_FILE" && ! -f "$FCM_SERVICE_ACCOUNT_FILE" ]]; then
  err "FCM service account file does not exist: $FCM_SERVICE_ACCOUNT_FILE"
  exit 1
fi
SESSION_TITLE_API_KEY="${SESSION_TITLE_LLM_API_KEY:-${LLM_API_KEY:-}}"
SESSION_TITLE_API_BASE="${SESSION_TITLE_LLM_API_BASE:-${LLM_API_BASE:-}}"
SESSION_TITLE_SUB_MODULE_VALUE="${SESSION_TITLE_SUB_MODULE:-${LLM_SUB_MODULE:-}}"
OPENCODE_API_KEY="${OPENCODE_LLM_API_KEY:-${LLM_API_KEY:-}}"
OPENCODE_API_BASE="${OPENCODE_LLM_API_BASE:-${LLM_API_BASE:-}}"
OPENCODE_LLM_SUB_MODULE_VALUE="${OPENCODE_LLM_SUB_MODULE:-${LLM_SUB_MODULE:-}}"

chmod +x "$SOURCE_CLI_JS" 2>/dev/null || true
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

log "Syncing LaunchAgent runtime outside the repository ..."
YEP_LAUNCHD_RUNTIME_DIR="$LAUNCHD_RUNTIME_DIR" "$SCRIPT_DIR/sync-launchd-runtime.sh"
if [[ ! -x "$CLI_JS" ]]; then
  err "LaunchAgent runtime sync did not produce an executable CLI at $CLI_JS."
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"

normalize_launchd_path() {
  local raw_path="$1"
  local filter_transient="$2"
  local normalized="$NODE_DIR"
  local entry
  local entries=()

  IFS=':' read -r -a entries <<<"$raw_path"
  for entry in "${entries[@]}"; do
    [[ -z "$entry" || "$entry" == "$NODE_DIR" ]] && continue
    if [[ "$filter_transient" == "true" ]]; then
      case "$entry" in
        "$HOME/.codex/tmp/"*|*/codex-path|/var/run/com.apple.security.cryptexd/codex.system/bootstrap/*|/pkg/env/global/bin)
          continue
          ;;
      esac
    fi
    case ":$normalized:" in
      *":$entry:"*) ;;
      *) normalized="$normalized:$entry" ;;
    esac
  done

  printf '%s' "$normalized"
}

DEFAULT_LAUNCHD_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ -n "${YEP_LAUNCHD_PATH:-}" ]]; then
  # An explicit override is authoritative; only deduplicate it and pin the
  # selected Node runtime first so child `node`/`npx` calls match ProgramArguments.
  LAUNCHD_PATH="$(normalize_launchd_path "$YEP_LAUNCHD_PATH" false)"
else
  # Deploys are often launched from Codex itself. Do not persist Codex's
  # per-process wrapper directories into a long-lived LaunchAgent plist.
  LAUNCHD_PATH="$(normalize_launchd_path "${PATH:-$DEFAULT_LAUNCHD_PATH}" true)"
fi

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

write_header() {
  local path="$1"
  local label="$2"
  local stdout_path="$3"
  local stderr_path="$4"

  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '%s\n' '  <key>Label</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$label")"
    printf '%s\n' '  <key>RunAtLoad</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>WorkingDirectory</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$LAUNCHD_RUNTIME_DIR")"
    printf '%s\n' '  <key>StandardOutPath</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$stdout_path")"
    printf '%s\n' '  <key>StandardErrorPath</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$stderr_path")"
  } >"$path"
}

append_env() {
  local path="$1"
  shift

  {
    printf '%s\n' '  <key>EnvironmentVariables</key>'
    printf '%s\n' '  <dict>'
    while [[ $# -gt 0 ]]; do
      local key="$1"
      local value="$2"
      shift 2
      printf '    <key>%s</key>\n' "$(xml_escape "$key")"
      printf '    <string>%s</string>\n' "$(xml_escape "$value")"
    done
    printf '%s\n' '  </dict>'
  } >>"$path"
}

append_program_arguments() {
  local path="$1"
  shift

  {
    printf '%s\n' '  <key>ProgramArguments</key>'
    printf '%s\n' '  <array>'
    for arg in "$@"; do
      printf '    <string>%s</string>\n' "$(xml_escape "$arg")"
    done
    printf '%s\n' '  </array>'
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } >>"$path"
}

append_server_recovery_policy() {
  local path="$1"

  {
    printf '%s\n' '  <key>KeepAlive</key>'
    printf '%s\n' '  <dict>'
    printf '%s\n' '    <key>SuccessfulExit</key>'
    printf '%s\n' '    <false/>'
    printf '%s\n' '  </dict>'
    # Avoid rapid restart loops while still recovering promptly from a crash.
    printf '%s\n' '  <key>ThrottleInterval</key>'
    printf '%s\n' '  <integer>10</integer>'
  } >>"$path"
}

write_bridge_plist() {
  local plist="$LAUNCH_AGENTS_DIR/$BRIDGE_LABEL.plist"
  local env_args=(
    "NODE_ENV" "production"
    "PATH" "$LAUNCHD_PATH"
    "YEP_DEPLOY_REPO_ROOT" "$REPO_ROOT"
    "YEP_CODEX_BRIDGE_PORT" "$BRIDGE_PORT"
  )
  if [[ -n "$CODEX_CLI_PATH" ]]; then
    env_args+=("YEP_CODEX_PATH" "$CODEX_CLI_PATH")
  fi

  write_header "$plist" "$BRIDGE_LABEL" "$LOG_DIR/codex-bridge-launchd.out.log" "$LOG_DIR/codex-bridge-launchd.err.log"
  append_env "$plist" "${env_args[@]}"
  append_program_arguments "$plist" "$NODE_BIN" "$CLI_JS" "--codex-bridge-only"
  echo "$plist"
}

write_opencode_bridge_plist() {
  local plist="$LAUNCH_AGENTS_DIR/$OPENCODE_BRIDGE_LABEL.plist"
  local env_args=(
    "NODE_ENV" "production"
    "PATH" "$LAUNCHD_PATH"
    "YEP_DEPLOY_REPO_ROOT" "$REPO_ROOT"
    "YEP_OPENCODE_BRIDGE_PORT" "$OPENCODE_BRIDGE_PORT"
    "YEP_OPENCODE_SERVER_START_PORT" "$OPENCODE_SERVER_START_PORT"
    "YEP_SERVER_URL" "$SERVER_URL"
  )
  if [[ -n "$OPENCODE_BRIDGE_UPSTREAM_URL" ]]; then
    env_args+=("YEP_OPENCODE_BRIDGE_UPSTREAM_URL" "$OPENCODE_BRIDGE_UPSTREAM_URL")
  fi
  if [[ -n "$OPENCODE_API_KEY" ]]; then
    env_args+=("OPENCODE_LLM_API_KEY" "$OPENCODE_API_KEY")
  fi
  if [[ -n "$OPENCODE_API_BASE" ]]; then
    env_args+=("OPENCODE_LLM_API_BASE" "$OPENCODE_API_BASE")
  fi
  if [[ -n "$OPENCODE_LLM_SUB_MODULE_VALUE" ]]; then
    env_args+=("OPENCODE_LLM_SUB_MODULE" "$OPENCODE_LLM_SUB_MODULE_VALUE")
  fi
  if [[ -n "${NEW_LLM_API_KEY:-}" ]]; then
    env_args+=("NEW_LLM_API_KEY" "$NEW_LLM_API_KEY")
  fi

  write_header "$plist" "$OPENCODE_BRIDGE_LABEL" "$LOG_DIR/opencode-bridge-launchd.out.log" "$LOG_DIR/opencode-bridge-launchd.err.log"
  append_env "$plist" "${env_args[@]}"
  append_program_arguments "$plist" "$NODE_BIN" "$CLI_JS" "--opencode-bridge-only"
  echo "$plist"
}

write_server_plist() {
  local plist="$LAUNCH_AGENTS_DIR/$SERVER_LABEL.plist"
  local env_args=(
    "NODE_ENV" "production"
    "PATH" "$LAUNCHD_PATH"
    "BASE_PATH" "$SERVER_BASE_PATH"
    "ALLOWED_IMAGE_PATHS" "$SERVER_ALLOWED_IMAGE_PATHS"
    "YEP_DEPLOY_REPO_ROOT" "$REPO_ROOT"
    "YEP_CODEX_BRIDGE_MODE" "external"
    "YEP_CODEX_BRIDGE_CONTROL_URL" "$BRIDGE_URL"
    "YEP_CODEX_BRIDGE_PORT" "$BRIDGE_PORT"
    "YEP_OPENCODE_BRIDGE_CONTROL_URL" "$OPENCODE_BRIDGE_URL"
    "YEP_OPENCODE_BRIDGE_PORT" "$OPENCODE_BRIDGE_PORT"
    "YEP_OPENCODE_SERVER_START_PORT" "$OPENCODE_SERVER_START_PORT"
  )
  if [[ -n "$CODEX_CLI_PATH" ]]; then
    env_args+=("YEP_CODEX_PATH" "$CODEX_CLI_PATH")
  fi
  if [[ -n "$OPENCODE_BRIDGE_UPSTREAM_URL" ]]; then
    env_args+=("YEP_OPENCODE_BRIDGE_UPSTREAM_URL" "$OPENCODE_BRIDGE_UPSTREAM_URL")
  fi
  if [[ -n "$SERVER_ALLOWED_HOSTS" ]]; then
    env_args+=("ALLOWED_HOSTS" "$SERVER_ALLOWED_HOSTS")
  fi

  if [[ -n "$FCM_SERVICE_ACCOUNT_FILE" ]]; then
    env_args+=("YEP_FCM_SERVICE_ACCOUNT_FILE" "$FCM_SERVICE_ACCOUNT_FILE")
  elif [[ -n "$FCM_SERVICE_ACCOUNT_JSON" ]]; then
    env_args+=("YEP_FCM_SERVICE_ACCOUNT_JSON" "$FCM_SERVICE_ACCOUNT_JSON")
  fi

  if [[ -n "$SESSION_TITLE_API_KEY" ]]; then
    env_args+=("SESSION_TITLE_LLM_API_KEY" "$SESSION_TITLE_API_KEY")
  fi
  if [[ -n "$SESSION_TITLE_API_BASE" ]]; then
    env_args+=("SESSION_TITLE_LLM_API_BASE" "$SESSION_TITLE_API_BASE")
  fi
  if [[ -n "$SESSION_TITLE_SUB_MODULE_VALUE" ]]; then
    env_args+=("SESSION_TITLE_SUB_MODULE" "$SESSION_TITLE_SUB_MODULE_VALUE")
  fi
  if [[ -n "$OPENCODE_API_KEY" ]]; then
    env_args+=("OPENCODE_LLM_API_KEY" "$OPENCODE_API_KEY")
  fi
  if [[ -n "$OPENCODE_API_BASE" ]]; then
    env_args+=("OPENCODE_LLM_API_BASE" "$OPENCODE_API_BASE")
  fi
  if [[ -n "$OPENCODE_LLM_SUB_MODULE_VALUE" ]]; then
    env_args+=("OPENCODE_LLM_SUB_MODULE" "$OPENCODE_LLM_SUB_MODULE_VALUE")
  fi
  if [[ -n "${NEW_LLM_API_KEY:-}" ]]; then
    env_args+=("NEW_LLM_API_KEY" "$NEW_LLM_API_KEY")
  fi
  if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    env_args+=("DEEPSEEK_API_KEY" "$DEEPSEEK_API_KEY")
  fi
  if [[ -n "${SESSION_TITLE_MODEL:-}" ]]; then
    env_args+=("SESSION_TITLE_MODEL" "$SESSION_TITLE_MODEL")
  fi
  if [[ -n "${SESSION_TITLE_GENERATION+x}" ]]; then
    env_args+=("SESSION_TITLE_GENERATION" "$SESSION_TITLE_GENERATION")
  fi
  if [[ -n "${SESSION_TITLE_TIMEOUT_MS:-}" ]]; then
    env_args+=("SESSION_TITLE_TIMEOUT_MS" "$SESSION_TITLE_TIMEOUT_MS")
  fi

  write_header "$plist" "$SERVER_LABEL" "$LOG_DIR/server-launchd.out.log" "$LOG_DIR/server-launchd.err.log"
  append_server_recovery_policy "$plist"
  append_env "$plist" "${env_args[@]}"
  append_program_arguments "$plist" "$NODE_BIN" "$CLI_JS" "--port" "$SERVER_PORT"
  echo "$plist"
}

reload_agent() {
  local label="$1"
  local plist="$2"
  local old_pid=""

  if ! $START_NOW; then
    dim "wrote $plist; active LaunchAgent was not reloaded"
    return
  fi
  old_pid="$(launchctl print "$USER_DOMAIN/$label" 2>/dev/null |
    awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
  launchctl bootout "$USER_DOMAIN/$label" >/dev/null 2>&1 || true
  launchctl bootout "$USER_DOMAIN" "$plist" >/dev/null 2>&1 || true
  if [[ -n "$old_pid" ]]; then
    for _ in $(seq 1 40); do
      if ! kill -0 "$old_pid" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
  fi
  launchctl bootstrap "$USER_DOMAIN" "$plist"
  launchctl enable "$USER_DOMAIN/$label"
  launchctl kickstart -k "$USER_DOMAIN/$label"
}

log "Installing Yep Anywhere LaunchAgents ..."

if $INSTALL_OPENCODE_BRIDGE; then
  OPENCODE_PLUGIN_INSTALLER="$REPO_ROOT/dist/npm-package/scripts/install-opencode-yep-plugin.sh"
  if [[ ! -x "$OPENCODE_PLUGIN_INSTALLER" ]]; then
    err "Expected bundled OpenCode plugin installer at $OPENCODE_PLUGIN_INSTALLER."
    err "Run scripts/deploy.sh --server-only once to rebuild dist/npm-package, then retry."
    exit 1
  fi
  log "Syncing the OpenCode forwarder plugin ..."
  "$OPENCODE_PLUGIN_INSTALLER"
fi

if $INSTALL_CODEX_BRIDGE; then
  BRIDGE_PLIST="$(write_bridge_plist)"
  reload_agent "$BRIDGE_LABEL" "$BRIDGE_PLIST"
fi

if $INSTALL_OPENCODE_BRIDGE; then
  OPENCODE_BRIDGE_PLIST="$(write_opencode_bridge_plist)"
  reload_agent "$OPENCODE_BRIDGE_LABEL" "$OPENCODE_BRIDGE_PLIST"
fi

if $INSTALL_SERVER; then
  SERVER_PLIST="$(write_server_plist)"
  reload_agent "$SERVER_LABEL" "$SERVER_PLIST"
fi

log "Installed LaunchAgents."
if $INSTALL_SERVER; then
  dim "server: $SERVER_LABEL -> http://127.0.0.1:${SERVER_PORT}${SERVER_BASE_PATH}"
else
  dim "server: skipped"
fi
if $INSTALL_CODEX_BRIDGE; then
  dim "codex bridge:  $BRIDGE_LABEL -> $BRIDGE_URL"
else
  dim "codex bridge:  skipped"
fi
if $INSTALL_OPENCODE_BRIDGE; then
  dim "opencode bridge: $OPENCODE_BRIDGE_LABEL -> $OPENCODE_BRIDGE_URL"
  dim "opencode bridge yep server: $SERVER_URL"
  if [[ -n "$OPENCODE_BRIDGE_UPSTREAM_URL" ]]; then
    dim "opencode server: external $OPENCODE_BRIDGE_UPSTREAM_URL"
  else
    dim "opencode server: managed from port $OPENCODE_SERVER_START_PORT"
  fi
else
  dim "opencode bridge: skipped"
fi
dim "logs:   $LOG_DIR/*-launchd.*.log"
dim "runtime: $LAUNCHD_RUNTIME_DIR"
if $INSTALL_SERVER; then
  if [[ -n "$FCM_SERVICE_ACCOUNT_FILE" ]]; then
    dim "native push: server FCM credentials from $FCM_SERVICE_ACCOUNT_FILE"
  elif [[ -n "$FCM_SERVICE_ACCOUNT_JSON" ]]; then
    dim "native push: server FCM credentials from YEP_FCM_SERVICE_ACCOUNT_JSON"
  else
    warn "native push: no server FCM credentials were stored in the server LaunchAgent."
  fi
  if [[ -n "$SESSION_TITLE_API_KEY" ]]; then
    dim "session titles: LLM API key stored as SESSION_TITLE_LLM_API_KEY"
    if [[ -n "${SESSION_TITLE_MODEL:-}" ]]; then
      dim "session titles: model $SESSION_TITLE_MODEL"
    fi
    if [[ -n "$SESSION_TITLE_SUB_MODULE_VALUE" ]]; then
      dim "session titles: submodule $SESSION_TITLE_SUB_MODULE_VALUE"
    fi
  elif [[ -n "${SESSION_TITLE_GENERATION+x}" ]]; then
    dim "session titles: SESSION_TITLE_GENERATION=$SESSION_TITLE_GENERATION"
  else
    warn "session titles: no LLM API key was stored in the server LaunchAgent."
  fi
  if [[ -n "$SERVER_ALLOWED_HOSTS" ]]; then
    dim "allowed hosts: $SERVER_ALLOWED_HOSTS"
  fi
fi
dim "8022 restarts after abnormal exits only (10s launchd throttle); bridge agents start at login only."

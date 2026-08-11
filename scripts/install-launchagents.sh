#!/usr/bin/env bash
# 安装 macOS LaunchAgent，在当前用户登录期间持续守护 Yep Anywhere。
# 如需停止托管服务，请运行 scripts/uninstall-launchagents.sh 或 bash yep.sh stop。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# LaunchAgent labels (历史原因使用 yueyuan，可通过环境变量自定义)
SERVER_LABEL="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
BRIDGE_LABEL="${YEP_LAUNCHD_BRIDGE_LABEL:-com.yueyuan.yepanywhere.codex-bridge}"
CLAUDE_BRIDGE_LABEL="${YEP_LAUNCHD_CLAUDE_BRIDGE_LABEL:-com.yueyuan.yepanywhere.claude-bridge}"
SERVER_PORT="${YEP_DEPLOY_PORT:-8022}"
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/}"
SERVER_ALLOWED_IMAGE_PATHS="${ALLOWED_IMAGE_PATHS:-/tmp,$HOME/Downloads}"
BRIDGE_PORT="${YEP_CODEX_BRIDGE_PORT:-${CODEX_BRIDGE_PORT:-4510}}"
BRIDGE_URL="${YEP_CODEX_BRIDGE_CONTROL_URL:-${CODEX_BRIDGE_CONTROL_URL:-http://127.0.0.1:${BRIDGE_PORT}}}"
CLAUDE_BRIDGE_PORT="${YEP_CLAUDE_BRIDGE_PORT:-${CLAUDE_BRIDGE_PORT:-4520}}"
CLAUDE_BRIDGE_URL="${YEP_CLAUDE_BRIDGE_CONTROL_URL:-${CLAUDE_BRIDGE_CONTROL_URL:-http://127.0.0.1:${CLAUDE_BRIDGE_PORT}}}"
SERVER_URL="http://127.0.0.1:${SERVER_PORT}${SERVER_BASE_PATH}"
NODE_BIN="${YEP_LAUNCHD_NODE:-$(command -v node 2>/dev/null || true)}"
CLI_JS="$REPO_ROOT/dist/npm-package/dist/cli.js"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="${YEP_LAUNCHD_LOG_DIR:-$HOME/.yep-anywhere/logs}"
SERVER_PLIST_PATH="${YEP_LAUNCHD_SERVER_PLIST:-$LAUNCH_AGENTS_DIR/$SERVER_LABEL.plist}"
USER_DOMAIN="gui/$(id -u)"
START_NOW=true
INSTALL_SERVER=true
INSTALL_CODEX_BRIDGE=true
INSTALL_CLAUDE_BRIDGE=true

if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

log()  { echo -e "${C_GREEN}==>${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!!${C_RESET}  $*" >&2; }
err()  { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim()  { echo -e "${C_DIM}    $*${C_RESET}"; }

usage() {
  sed -n '2,6p' "$0" | sed 's/^# *//'
  cat <<'EOF'

Usage:
  scripts/install-launchagents.sh [--server-only|--bridge-only|--claude-bridge-only] [--no-start] [--server-plist PATH]

Options:
  --server-only                Write/reload only the 8022 server LaunchAgent
  --bridge-only, --codex-bridge-only
                               Write/reload only the 4510 Codex bridge LaunchAgent
  --claude-bridge-only         Write/reload only the 4520 Claude bridge LaunchAgent
  --bridges-only               Write/reload both bridge LaunchAgents
  --no-start                   Write plist file(s) without unloading or starting LaunchAgents
  --server-plist PATH          Write the server definition to PATH

Environment overrides:
  YEP_DEPLOY_PORT              Main server port (default: 8022)
  YEP_DEPLOY_BASE_PATH         Main server base path (default: /)
  ALLOWED_IMAGE_PATHS          Extra local media paths for /api/local-image
                               (default: /tmp,$HOME/Downloads)
  YEP_CODEX_BRIDGE_PORT        Codex bridge port (default: 4510)
  YEP_CLAUDE_BRIDGE_PORT       Claude bridge port (default: 4520)
  YEP_LAUNCHD_NODE             Absolute node binary path
  YEP_LAUNCHD_PATH             PATH stored in the LaunchAgent environment
  YEP_LAUNCHD_LOG_DIR          LaunchAgent stdout/stderr log directory
  YEP_FCM_SERVICE_ACCOUNT_FILE Firebase service account JSON path for Android native push
  YEP_FCM_SERVICE_ACCOUNT_JSON Raw Firebase service account JSON for Android native push
  GOOGLE_APPLICATION_CREDENTIALS
                               Fallback Firebase service account JSON path
  SESSION_TITLE_LLM_API_KEY    OpenAI-compatible API key for AI session titles
  LLM_API_KEY                  Fallback API key for AI session titles
  SESSION_TITLE_LLM_API_BASE   OpenAI-compatible API base for AI session titles
  LLM_API_BASE                 Fallback API base for AI session titles
  SESSION_TITLE_SUB_MODULE     X-Sub-Module header for AI session titles
  LLM_SUB_MODULE               Fallback X-Sub-Module header for AI session titles
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
    --server-plist)
      if [[ $# -lt 2 || -z "$2" ]]; then
        err "--server-plist requires a path"
        exit 2
      fi
      SERVER_PLIST_PATH="$2"
      shift 2
      ;;
    --server-only)
      INSTALL_SERVER=true
      INSTALL_CODEX_BRIDGE=false
      INSTALL_CLAUDE_BRIDGE=false
      shift
      ;;
    --bridge-only|--codex-bridge-only)
      INSTALL_SERVER=false
      INSTALL_CODEX_BRIDGE=true
      INSTALL_CLAUDE_BRIDGE=false
      shift
      ;;
    --claude-bridge-only)
      INSTALL_SERVER=false
      INSTALL_CODEX_BRIDGE=false
      INSTALL_CLAUDE_BRIDGE=true
      shift
      ;;
    --bridges-only)
      INSTALL_SERVER=false
      INSTALL_CODEX_BRIDGE=true
      INSTALL_CLAUDE_BRIDGE=true
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

if ! $INSTALL_SERVER && ! $INSTALL_CODEX_BRIDGE && ! $INSTALL_CLAUDE_BRIDGE; then
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

if [[ ! -f "$CLI_JS" ]]; then
  err "Expected bundled CLI at $CLI_JS, but it does not exist."
  err "Run scripts/deploy.sh --server-only once to build dist/npm-package, then retry."
  exit 1
fi

if [[ ! -d "$REPO_ROOT/dist/npm-package/node_modules" ]]; then
  warn "Runtime dependencies are missing from dist/npm-package/node_modules."
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

chmod +x "$CLI_JS" 2>/dev/null || true
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR" "$(dirname "$SERVER_PLIST_PATH")"

LAUNCHD_PATH="${YEP_LAUNCHD_PATH:-${PATH:-/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin}}"
NODE_DIR="$(dirname "$NODE_BIN")"
case ":$LAUNCHD_PATH:" in
  *":$NODE_DIR:"*) ;;
  *) LAUNCHD_PATH="$NODE_DIR:$LAUNCHD_PATH" ;;
esac

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
    printf '%s\n' '  <key>KeepAlive</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>WorkingDirectory</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$REPO_ROOT")"
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

write_bridge_plist() {
  local plist="$LAUNCH_AGENTS_DIR/$BRIDGE_LABEL.plist"
  write_header "$plist" "$BRIDGE_LABEL" "$LOG_DIR/codex-bridge-launchd.out.log" "$LOG_DIR/codex-bridge-launchd.err.log"
  append_env "$plist" \
    "NODE_ENV" "production" \
    "PATH" "$LAUNCHD_PATH" \
    "YEP_DEPLOY_REPO_ROOT" "$REPO_ROOT" \
    "YEP_CODEX_BRIDGE_PORT" "$BRIDGE_PORT"
  append_program_arguments "$plist" "$NODE_BIN" "$CLI_JS" "--codex-bridge-only"
  echo "$plist"
}

write_claude_bridge_plist() {
  local plist="$LAUNCH_AGENTS_DIR/$CLAUDE_BRIDGE_LABEL.plist"
  write_header "$plist" "$CLAUDE_BRIDGE_LABEL" "$LOG_DIR/claude-bridge-launchd.out.log" "$LOG_DIR/claude-bridge-launchd.err.log"
  append_env "$plist" \
    "NODE_ENV" "production" \
    "PATH" "$LAUNCHD_PATH" \
    "YEP_DEPLOY_REPO_ROOT" "$REPO_ROOT" \
    "YEP_CLAUDE_BRIDGE_PORT" "$CLAUDE_BRIDGE_PORT" \
    "YEP_SERVER_URL" "$SERVER_URL"
  append_program_arguments "$plist" "$NODE_BIN" "$CLI_JS" "--claude-bridge-only"
  echo "$plist"
}

write_server_plist() {
  local plist="$SERVER_PLIST_PATH"
  local env_args=(
    "NODE_ENV" "production"
    "PATH" "$LAUNCHD_PATH"
    "YEP_DEPLOY_PORT" "$SERVER_PORT"
    "BASE_PATH" "$SERVER_BASE_PATH"
    "ALLOWED_IMAGE_PATHS" "$SERVER_ALLOWED_IMAGE_PATHS"
    "YEP_DEPLOY_REPO_ROOT" "$REPO_ROOT"
    "YEP_CODEX_BRIDGE_MODE" "external"
    "YEP_CODEX_BRIDGE_CONTROL_URL" "$BRIDGE_URL"
    "YEP_CODEX_BRIDGE_PORT" "$BRIDGE_PORT"
    "YEP_CLAUDE_BRIDGE_CONTROL_URL" "$CLAUDE_BRIDGE_URL"
    "YEP_CLAUDE_BRIDGE_PORT" "$CLAUDE_BRIDGE_PORT"
  )

  if [[ -n "${YEP_ANYWHERE_PROFILE:-}" ]]; then
    env_args+=("YEP_ANYWHERE_PROFILE" "$YEP_ANYWHERE_PROFILE")
  fi
  if [[ -n "${YEP_ANYWHERE_DATA_DIR:-}" ]]; then
    env_args+=("YEP_ANYWHERE_DATA_DIR" "$YEP_ANYWHERE_DATA_DIR")
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
  append_env "$plist" "${env_args[@]}"
  append_program_arguments "$plist" "$NODE_BIN" "$CLI_JS" "--port" "$SERVER_PORT"
  echo "$plist"
}

reload_agent() {
  local label="$1"
  local plist="$2"

  if ! $START_NOW; then
    dim "wrote $plist; active LaunchAgent was not reloaded"
    return
  fi
  launchctl bootout "$USER_DOMAIN/$label" >/dev/null 2>&1 || true
  launchctl bootout "$USER_DOMAIN" "$plist" >/dev/null 2>&1 || true
  # 显式检测 bootstrap 失败：launchd 用户域状态损坏（如多次失败 bootstrap 后报
  # "Input/output error"）或 plist 非法都会让 bootstrap 退出非 0。必须让错误冒泡，
  # 否则上层 yep.sh/deploy.sh 会误以为 LaunchAgent 已加载，造成"假成功"。
  if ! launchctl bootstrap "$USER_DOMAIN" "$plist" 2>/tmp/yep-bootstrap-err.log; then
    # 注：${label:-} 而非 $label —— bash 在 set -u 下、local 变量于失败分支内引用时
    # 偶发报 "unbound variable"，会掩盖下方真实 launchd 错误，故用安全默认。
    err "launchctl bootstrap 失败（label=${label:-}）。常见原因：launchd 用户域状态损坏或 plist 非法。"
    [ -s /tmp/yep-bootstrap-err.log ] && err "$(cat /tmp/yep-bootstrap-err.log)"
    return 1
  fi
  launchctl enable "$USER_DOMAIN/$label"
  launchctl kickstart -k "$USER_DOMAIN/$label"
}

log "Installing Yep Anywhere LaunchAgents ..."

if $INSTALL_CODEX_BRIDGE; then
  BRIDGE_PLIST="$(write_bridge_plist)"
  reload_agent "$BRIDGE_LABEL" "$BRIDGE_PLIST"
fi

if $INSTALL_CLAUDE_BRIDGE; then
  CLAUDE_BRIDGE_PLIST="$(write_claude_bridge_plist)"
  reload_agent "$CLAUDE_BRIDGE_LABEL" "$CLAUDE_BRIDGE_PLIST"
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
if $INSTALL_CLAUDE_BRIDGE; then
  dim "claude bridge: $CLAUDE_BRIDGE_LABEL -> $CLAUDE_BRIDGE_URL"
  dim "claude bridge server: $SERVER_URL"
else
  dim "claude bridge: skipped"
fi
dim "logs:   $LOG_DIR/*-launchd.*.log"
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
fi
dim "KeepAlive 已启用；当前用户登录期间，launchd 会在服务退出后自动重启。"

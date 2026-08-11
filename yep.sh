#!/usr/bin/env bash

# Yep Anywhere macOS 服务进程管理。

set -uo pipefail

DEV_PORT="${YEP_DEV_PORT:-3400}"
PROD_PORT="${YEP_DEPLOY_PORT:-8022}"
DEV_MAIN_PORT="$DEV_PORT"
DEV_MAINTENANCE_PORT=$((DEV_PORT + 1))
DEV_VITE_PORT=$((DEV_PORT + 2))
DEV_PORTS=("$DEV_MAIN_PORT" "$DEV_MAINTENANCE_PORT" "$DEV_VITE_PORT")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
DIST_DIR="$PROJECT_ROOT/dist"
BUNDLE_DIR="$DIST_DIR/npm-package"
BUNDLE_CLI="$BUNDLE_DIR/dist/cli.js"
BUNDLE_CLIENT_DIST="$BUNDLE_DIR/client-dist"
BUNDLE_BUILD_INFO="$BUNDLE_DIR/build-info.json"
DATA_DIR="${YEP_ANYWHERE_DATA_DIR:-$HOME/.yep-anywhere}"
LOG_DIR="${YEP_LAUNCHD_LOG_DIR:-$DATA_DIR/logs}"
STATE_DIR="${YEP_SERVICE_STATE_DIR:-$DATA_DIR/service}"
DEV_LOG_FILE="${YEP_DEV_LOG_FILE:-$LOG_DIR/dev-console.log}"
DEV_METADATA="$STATE_DIR/dev-process.json"
PROD_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-${BASE_PATH:-/}}"
PROD_ALLOWED_IMAGE_PATHS="${ALLOWED_IMAGE_PATHS:-/tmp,$HOME/Downloads}"
HAS_PROD_OVERRIDES=false
PROD_OVERRIDE_NAMES=(
    YEP_DEPLOY_PORT YEP_DEPLOY_BASE_PATH BASE_PATH ALLOWED_IMAGE_PATHS
    YEP_ANYWHERE_PROFILE YEP_ANYWHERE_DATA_DIR
    YEP_CODEX_BRIDGE_PORT CODEX_BRIDGE_PORT
    YEP_CODEX_BRIDGE_CONTROL_URL CODEX_BRIDGE_CONTROL_URL
    YEP_CLAUDE_BRIDGE_PORT CLAUDE_BRIDGE_PORT
    YEP_CLAUDE_BRIDGE_CONTROL_URL CLAUDE_BRIDGE_CONTROL_URL
    YEP_LAUNCHD_SERVER_LABEL YEP_LAUNCHD_NODE YEP_LAUNCHD_PATH YEP_LAUNCHD_LOG_DIR
    YEP_FCM_SERVICE_ACCOUNT_FILE YEP_FCM_SERVICE_ACCOUNT_JSON GOOGLE_APPLICATION_CREDENTIALS
    SESSION_TITLE_LLM_API_KEY LLM_API_KEY
    SESSION_TITLE_LLM_API_BASE LLM_API_BASE
    SESSION_TITLE_SUB_MODULE LLM_SUB_MODULE
    SESSION_TITLE_MODEL SESSION_TITLE_TIMEOUT_MS
)
for override_name in "${PROD_OVERRIDE_NAMES[@]}"; do
    if [[ -n "${!override_name:-}" ]]; then
        HAS_PROD_OVERRIDES=true
        break
    fi
done
if [[ -n "${SESSION_TITLE_GENERATION+x}" ]]; then
    HAS_PROD_OVERRIDES=true
fi

LAUNCHD_SERVICE="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
LAUNCHD_DOMAIN="gui/$(id -u)"
PERSISTENT_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_SERVICE}.plist"
SESSION_PLIST="$STATE_DIR/${LAUNCHD_SERVICE}.plist"
PLUTIL_BIN="${YEP_PLUTIL_BIN:-/usr/bin/plutil}"
PLIST_BUDDY_BIN="${YEP_PLISTBUDDY_BIN:-/usr/libexec/PlistBuddy}"

print_success() { echo -e "${GREEN}✓${NC} $*"; }
print_error() { echo -e "${RED}✗${NC} $*"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $*"; }
print_info() { echo -e "${CYAN}ℹ${NC} $*"; }
print_header() { echo -e "\n${BLUE}===${NC} $* ${BLUE}===${NC}\n"; }

normalize_base_path() {
    local raw="${1:-/}"
    if [[ -z "$raw" || "$raw" == "/" ]]; then
        echo "/"
        return
    fi
    raw="/${raw#/}"
    echo "${raw%/}"
}

prod_base_url() {
    local base_path
    base_path="$(normalize_base_path "$PROD_BASE_PATH")"
    if [[ "$base_path" == "/" ]]; then
        echo "http://127.0.0.1:${PROD_PORT}"
    else
        echo "http://127.0.0.1:${PROD_PORT}${base_path}"
    fi
}

ensure_dirs() {
    mkdir -p "$LOG_DIR" "$STATE_DIR"
}

require_macos() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        print_error "launchd 服务管理仅支持 macOS"
        return 1
    fi
    if ! command -v launchctl >/dev/null 2>&1; then
        print_error "找不到 launchctl"
        return 1
    fi
}

get_port_pids() {
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

port_in_use() {
    [[ -n "$(get_port_pids "$1")" ]]
}

port_has_pid() {
    local port="$1"
    local expected_pid="$2"
    local pid
    for pid in $(get_port_pids "$port"); do
        if [[ "$pid" == "$expected_pid" ]]; then
            return 0
        fi
    done
    return 1
}

process_start_time() {
    ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

process_command() {
    ps -p "$1" -o command= 2>/dev/null || true
}

metadata_value() {
    local key="$1"
    local file="$2"
    sed -n "s/.*\"${key}\":\"\([^\"]*\)\".*/\1/p" "$file" 2>/dev/null | head -1
}

metadata_pid() {
    sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$DEV_METADATA" 2>/dev/null | head -1
}

write_dev_metadata() {
    local pid="$1"
    local profile="$2"
    local start_time
    start_time="$(process_start_time "$pid")"
    ensure_dirs
    umask 077
    printf '{"pid":%s,"startTime":"%s","role":"development","profile":"%s"}\n' \
        "$pid" "$start_time" "$profile" > "$DEV_METADATA"
}

dev_metadata_matches() {
    [[ -f "$DEV_METADATA" ]] || return 1
    local pid stored_start current_start command
    pid="$(metadata_pid)"
    stored_start="$(metadata_value startTime "$DEV_METADATA")"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    current_start="$(process_start_time "$pid")"
    [[ -n "$stored_start" && "$current_start" == "$stored_start" ]] || return 1
    command="$(process_command "$pid")"
    case "$command" in
        *pnpm*dev*|*scripts/dev.js*|*tsx*) return 0 ;;
        *) return 1 ;;
    esac
}

process_descends_from() {
    local pid="$1"
    local ancestor="$2"
    local depth=0
    while [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 && $depth -lt 32 ]]; do
        if [[ "$pid" == "$ancestor" ]]; then
            return 0
        fi
        pid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]')"
        depth=$((depth + 1))
    done
    return 1
}

dev_ports_match_metadata() {
    local root_pid="$1"
    local port port_pids pid
    for port in "${DEV_PORTS[@]}"; do
        port_pids="$(get_port_pids "$port")"
        [[ -n "$port_pids" ]] || return 1
        for pid in $port_pids; do
            process_descends_from "$pid" "$root_pid" || return 1
        done
    done
}

dev_instance_healthy() {
    local root_pid="$1"
    curl -fsS "http://127.0.0.1:${DEV_MAIN_PORT}/api/version" >/dev/null 2>&1 \
        && dev_ports_match_metadata "$root_pid"
}

kill_process_tree() {
    local pid="$1"
    local signal="${2:-TERM}"
    local child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        kill_process_tree "$child" "$signal"
    done
    kill -"$signal" "$pid" 2>/dev/null || true
}

wait_for_dev_health() {
    local count=0
    local max_attempts="${YEP_HEALTH_CHECK_TRIES:-60}"
    while [[ $count -lt $max_attempts ]]; do
        if curl -fsS "http://127.0.0.1:${DEV_MAIN_PORT}/api/version" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.25
        count=$((count + 1))
    done
    return 1
}

start_dev() {
    local foreground=false
    local profile="${YEP_ANYWHERE_PROFILE:-dev}"
    local profile_env=()
    if [[ -z "${YEP_ANYWHERE_PROFILE:-}" && -z "${YEP_ANYWHERE_DATA_DIR:-}" ]]; then
        profile_env=("YEP_ANYWHERE_PROFILE=dev")
    fi
    if [[ "${1:-}" == "--fg" ]]; then
        foreground=true
        shift
    fi
    if [[ $# -gt 0 ]]; then
        print_error "start-dev 仅支持 --fg"
        return 2
    fi

    print_header "启动开发服务"
    if dev_metadata_matches; then
        local existing_pid
        existing_pid="$(metadata_pid)"
        if dev_instance_healthy "$existing_pid"; then
            print_success "开发服务已在运行 (PID: $existing_pid, Profile: $(metadata_value profile "$DEV_METADATA"))"
            return 0
        fi
        print_error "开发服务元数据存在，但健康检查或三个开发端口的进程归属异常；拒绝重复启动"
        return 1
    fi

    local port port_pids
    for port in "${DEV_PORTS[@]}"; do
        port_pids="$(get_port_pids "$port")"
        if [[ -n "$port_pids" ]]; then
            print_error "端口 $port 已被占用，无法确认占用者属于 Yep Anywhere 开发服务"
            print_info "占用进程 PID: $port_pids"
            return 1
        fi
    done

    rm -f "$DEV_METADATA"
    cd "$PROJECT_ROOT" || return 1
    if $foreground; then
        print_info "以前台模式启动；按 Ctrl+C 停止"
        env PORT="$DEV_PORT" "${profile_env[@]}" pnpm dev
        return $?
    fi

    ensure_dirs
    print_info "后台启动开发服务，Profile: $profile"
    nohup env PORT="$DEV_PORT" "${profile_env[@]}" pnpm dev \
        </dev/null >"$DEV_LOG_FILE" 2>&1 &
    local pid=$!
    write_dev_metadata "$pid" "$profile"
    sleep 1
    if kill -0 "$pid" 2>/dev/null && wait_for_dev_health && dev_instance_healthy "$pid"; then
        print_success "开发服务已在后台启动 (PID: $pid)"
        print_info "日志: $DEV_LOG_FILE"
        return 0
    fi

    print_error "开发服务健康检查或三个开发端口的进程归属异常，正在清理本次启动的进程树"
    kill_process_tree "$pid" TERM
    sleep 0.5
    if kill -0 "$pid" 2>/dev/null; then
        kill_process_tree "$pid" KILL
    fi
    rm -f "$DEV_METADATA"
    local residual_port residual_pids
    for residual_port in "${DEV_PORTS[@]}"; do
        residual_pids="$(get_port_pids "$residual_port")"
        if [[ -n "$residual_pids" ]]; then
            print_error "清理后端口 $residual_port 仍被占用，PID: $residual_pids"
        fi
    done
    print_error "开发服务启动失败，请检查日志: $DEV_LOG_FILE"
    return 1
}

stop_dev() {
    print_header "停止开发服务"
    if dev_metadata_matches; then
        local pid attempts
        pid="$(metadata_pid)"
        print_info "停止已核实的开发进程 PID: $pid"
        kill_process_tree "$pid" TERM
        attempts=0
        while kill -0 "$pid" 2>/dev/null && [[ $attempts -lt 10 ]]; do
            sleep 0.5
            attempts=$((attempts + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            print_warning "开发进程未及时退出，正在强制结束已核实的进程树"
            kill_process_tree "$pid" KILL
        fi
        rm -f "$DEV_METADATA"
        local residual=false
        local port port_pids
        for port in "${DEV_PORTS[@]}"; do
            port_pids="$(get_port_pids "$port")"
            if [[ -n "$port_pids" ]]; then
                print_error "停止后端口 $port 仍被占用，PID: $port_pids"
                residual=true
            fi
        done
        if $residual; then
            return 1
        fi
        print_success "开发服务已停止"
        return 0
    fi

    local port port_pids unknown=false
    for port in "${DEV_PORTS[@]}"; do
        port_pids="$(get_port_pids "$port")"
        if [[ -n "$port_pids" ]]; then
            print_error "端口 $port 仍被占用，但无法确认占用者属于 Yep Anywhere 开发服务"
            print_info "占用进程 PID: $port_pids；为避免误杀，未结束任何进程"
            unknown=true
        fi
    done
    $unknown && return 1

    rm -f "$DEV_METADATA"
    print_success "开发服务未运行"
}

launchd_loaded() {
    launchctl print "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" >/dev/null 2>&1
}

launchd_pid() {
    launchctl print "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" 2>/dev/null \
        | awk -F '= ' '/^[[:space:]]*pid = / {print $2; exit}'
}

launchd_running() {
    local plist
    plist="$(preferred_plist)"
    plist_valid "$plist" || return 1
    launchd_loaded || return 1
    local pid
    pid="$(launchd_pid)"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    port_has_pid "$PROD_PORT" "$pid" || return 1
    curl -fsS "$(prod_base_url)/api/version" >/dev/null 2>&1
}

wait_for_prod() {
    local attempts="${1:-60}"
    local count=0
    while [[ $count -lt $attempts ]]; do
        if launchd_running; then
            return 0
        fi
        sleep 0.25
        count=$((count + 1))
    done
    return 1
}

check_runtime_bundle() {
    if [[ ! -f "$BUNDLE_CLI" \
        || ! -f "$BUNDLE_CLIENT_DIST/index.html" \
        || ! -f "$BUNDLE_BUILD_INFO" \
        || ! -d "$BUNDLE_DIR/node_modules" ]]; then
        print_error "生产 Bundle 不完整或运行时依赖缺失"
        print_info "请先运行: pnpm yep rebuild"
        return 1
    fi
}

write_server_plist() {
    local plist="$1"
    check_runtime_bundle || return 1
    ensure_dirs
    YEP_DEPLOY_PORT="$PROD_PORT" \
        YEP_DEPLOY_BASE_PATH="$(normalize_base_path "$PROD_BASE_PATH")" \
        ALLOWED_IMAGE_PATHS="$PROD_ALLOWED_IMAGE_PATHS" \
        "$PROJECT_ROOT/scripts/install-launchagents.sh" \
        --server-only --no-start --server-plist "$plist"
}

preferred_plist() {
    if [[ -f "$PERSISTENT_PLIST" ]]; then
        echo "$PERSISTENT_PLIST"
    else
        echo "$SESSION_PLIST"
    fi
}

plist_value() {
    local plist="$1"
    local key="$2"
    if [[ -x "$PLIST_BUDDY_BIN" && -f "$plist" ]]; then
        "$PLIST_BUDDY_BIN" -c "Print :$key" "$plist" 2>/dev/null || true
    fi
}

effective_prod_log_path() {
    local plist="$1"
    local key="$2"
    local fallback="$3"
    local stored_path
    stored_path="$(plist_value "$plist" "$key")"
    if [[ -n "$stored_path" ]]; then
        echo "$stored_path"
    else
        echo "$fallback"
    fi
}

apply_plist_configuration() {
    local plist="$1"
    [[ -f "$plist" ]] || return 0
    if [[ -z "${YEP_DEPLOY_PORT:-}" ]]; then
        local stored_port
        stored_port="$(plist_value "$plist" "ProgramArguments:3")"
        if [[ "$stored_port" =~ ^[0-9]+$ ]]; then
            PROD_PORT="$stored_port"
        fi
    fi
    if [[ -z "${YEP_DEPLOY_BASE_PATH:-}" ]]; then
        local stored_base_path
        stored_base_path="$(plist_value "$plist" "EnvironmentVariables:BASE_PATH")"
        if [[ -n "$stored_base_path" ]]; then
            PROD_BASE_PATH="$stored_base_path"
        fi
    fi
}

effective_prod_profile() {
    local plist="$1"
    local data_dir profile
    data_dir="$(plist_value "$plist" "EnvironmentVariables:YEP_ANYWHERE_DATA_DIR")"
    profile="$(plist_value "$plist" "EnvironmentVariables:YEP_ANYWHERE_PROFILE")"
    if [[ -n "$data_dir" ]]; then
        echo "custom-data-dir"
    elif [[ -n "$profile" ]]; then
        echo "$profile"
    else
        echo "default"
    fi
}

prepare_server_plist() {
    local plist="$1"
    PLIST_UPDATED=false
    if [[ -f "$plist" ]] && plist_valid "$plist" && ! $HAS_PROD_OVERRIDES; then
        return 0
    fi
    write_server_plist "$plist" || return 1
    PLIST_UPDATED=true
}

start_prod() {
    print_header "启动生产服务"
    require_macos || return 1
    check_runtime_bundle || return 1

    local plist
    plist="$(preferred_plist)"
    apply_plist_configuration "$plist"

    local was_running=false
    if launchd_running; then
        was_running=true
    fi
    if $was_running && ! $HAS_PROD_OVERRIDES; then
        print_success "生产服务已由 LaunchAgent 运行 (PID: $(launchd_pid))"
        return 0
    fi

    prepare_server_plist "$plist" || return 1

    local loaded_pid="" loaded_owns_port=false
    if launchd_loaded; then
        loaded_pid="$(launchd_pid)"
        if [[ "$loaded_pid" =~ ^[0-9]+$ ]] && port_has_pid "$PROD_PORT" "$loaded_pid"; then
            loaded_owns_port=true
        fi
    fi
    if port_in_use "$PROD_PORT" && ! $was_running && ! $loaded_owns_port; then
        print_error "端口 $PROD_PORT 已被占用，但无法确认占用者属于生产 LaunchAgent"
        print_info "占用进程 PID: $(get_port_pids "$PROD_PORT")；未结束任何进程"
        return 1
    fi

    if launchd_loaded; then
        if $PLIST_UPDATED; then
            launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" || return 1
            launchctl bootstrap "$LAUNCHD_DOMAIN" "$plist" || return 1
            launchctl enable "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" || return 1
            launchctl kickstart -k "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" || return 1
        else
            launchctl kickstart -k "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" || return 1
        fi
    else
        launchctl bootstrap "$LAUNCHD_DOMAIN" "$plist" || return 1
        launchctl enable "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" || return 1
        launchctl kickstart -k "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" || return 1
    fi

    if wait_for_prod 60; then
        print_success "生产服务已启动 (PID: $(launchd_pid), Profile: $(effective_prod_profile "$plist"))"
        print_info "访问地址: $(prod_base_url)"
        print_info "日志: $(effective_prod_log_path "$plist" StandardOutPath "$LOG_DIR/server-launchd.out.log")"
        return 0
    fi
    print_error "LaunchAgent 已加载，但生产端口 $PROD_PORT 未开始监听"
    print_info "错误日志: $(effective_prod_log_path "$plist" StandardErrorPath "$LOG_DIR/server-launchd.err.log")"
    return 1
}

stop_prod() {
    print_header "停止生产服务"
    require_macos || return 1
    local plist
    plist="$(preferred_plist)"
    apply_plist_configuration "$plist"
    if launchd_loaded; then
        launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_SERVICE" || return 1
        if launchd_loaded; then
            print_error "生产 LaunchAgent 卸载失败"
            return 1
        fi
        local attempts=0
        local max_attempts="${YEP_STOP_WAIT_TRIES:-20}"
        while port_in_use "$PROD_PORT" && [[ $attempts -lt $max_attempts ]]; do
            sleep 0.25
            attempts=$((attempts + 1))
        done
        if port_in_use "$PROD_PORT"; then
            print_error "LaunchAgent 已卸载，但生产端口 $PROD_PORT 仍被占用，PID: $(get_port_pids "$PROD_PORT")"
            return 1
        fi
        print_success "当前生产实例已停止；自启动配置未更改"
        return 0
    fi
    if port_in_use "$PROD_PORT"; then
        print_error "端口 $PROD_PORT 被占用，但生产 LaunchAgent 未加载，无法确认进程身份"
        print_info "占用进程 PID: $(get_port_pids "$PROD_PORT")；未结束任何进程"
        return 1
    fi
    print_success "生产服务未运行；自启动配置未更改"
}

enable_autostart() {
    print_header "启用登录自启动"
    require_macos || return 1
    if ! $HAS_PROD_OVERRIDES && [[ -f "$SESSION_PLIST" ]] && plist_valid "$SESSION_PLIST"; then
        mkdir -p "$(dirname "$PERSISTENT_PLIST")"
        cp "$SESSION_PLIST" "$PERSISTENT_PLIST" || return 1
    elif ! $HAS_PROD_OVERRIDES && [[ -f "$PERSISTENT_PLIST" ]] && plist_valid "$PERSISTENT_PLIST"; then
        :
    else
        write_server_plist "$PERSISTENT_PLIST" || return 1
    fi
    print_success "已安装或修复持久 LaunchAgent 配置"
    print_info "当前生产实例未启动或重启；下次登录时自动启动"
}

disable_autostart() {
    print_header "关闭登录自启动"
    require_macos || return 1
    if [[ -f "$PERSISTENT_PLIST" ]] && launchd_loaded; then
        ensure_dirs
        cp "$PERSISTENT_PLIST" "$SESSION_PLIST" || return 1
    fi
    "$PROJECT_ROOT/scripts/uninstall-launchagents.sh" --server-only --no-stop || return 1
    print_success "持久 LaunchAgent 配置已删除"
    print_info "当前已加载的生产实例未停止"
}

plist_valid() {
    local plist="$1"
    [[ -f "$plist" ]] || return 1
    [[ -x "$PLUTIL_BIN" && -x "$PLIST_BUDDY_BIN" ]] || return 1
    "$PLUTIL_BIN" -lint "$plist" >/dev/null 2>&1 || return 1

    local label node cli port_flag port working_dir run_at_load keep_alive env_port extra_arg
    label="$(plist_value "$plist" Label)"
    node="$(plist_value "$plist" ProgramArguments:0)"
    cli="$(plist_value "$plist" ProgramArguments:1)"
    port_flag="$(plist_value "$plist" ProgramArguments:2)"
    port="$(plist_value "$plist" ProgramArguments:3)"
    extra_arg="$(plist_value "$plist" ProgramArguments:4)"
    working_dir="$(plist_value "$plist" WorkingDirectory)"
    run_at_load="$(plist_value "$plist" RunAtLoad)"
    keep_alive="$(plist_value "$plist" KeepAlive)"
    env_port="$(plist_value "$plist" EnvironmentVariables:YEP_DEPLOY_PORT)"

    [[ "$label" == "$LAUNCHD_SERVICE" \
        && "$node" == /* \
        && -x "$node" \
        && "$cli" == "$BUNDLE_CLI" \
        && "$port_flag" == "--port" \
        && "$port" =~ ^[0-9]+$ \
        && "$port" -ge 1 \
        && "$port" -le 65535 \
        && "$env_port" == "$port" \
        && -z "$extra_arg" \
        && "$working_dir" == "$PROJECT_ROOT" \
        && "$run_at_load" == "true" \
        && "$keep_alive" == "true" ]]
}

status() {
    print_header "服务状态"
    local dev_pid="" prod_pid=""
    local active_plist
    active_plist="$(preferred_plist)"
    apply_plist_configuration "$active_plist"
    local prod_profile
    prod_profile="$(effective_prod_profile "$active_plist")"
    if dev_metadata_matches; then
        dev_pid="$(metadata_pid)"
        if dev_instance_healthy "$dev_pid"; then
            print_success "开发运行: 是 (PID: $dev_pid, Profile: $(metadata_value profile "$DEV_METADATA"), 端口: ${DEV_PORTS[*]})"
        else
            print_warning "开发运行: 配置异常；PID 元数据、健康检查或三个开发端口的进程归属不一致"
        fi
    else
        local dev_port dev_port_pids dev_anomaly=false
        for dev_port in "${DEV_PORTS[@]}"; do
            dev_port_pids="$(get_port_pids "$dev_port")"
            if [[ -n "$dev_port_pids" ]]; then
                print_warning "开发运行: 配置异常；端口 $dev_port 被 PID $dev_port_pids 占用，身份无法核实"
                dev_anomaly=true
            fi
        done
        if $dev_anomaly; then
            :
        else
        print_info "开发运行: 否 (Profile: dev, 端口: $DEV_PORT)"
        fi
    fi

    if [[ -f "$PERSISTENT_PLIST" || -f "$SESSION_PLIST" ]]; then
        print_info "plist 已安装: 是"
    else
        print_info "plist 已安装: 否"
    fi
    if [[ -f "$PERSISTENT_PLIST" ]]; then
        if plist_valid "$PERSISTENT_PLIST"; then
            print_success "登录自启动: 已启用 ($PERSISTENT_PLIST)"
        else
            print_warning "持久 plist 配置异常：路径或动作与当前 Bundle 不一致"
        fi
    else
        print_info "登录自启动: 已关闭"
    fi
    if [[ -f "$SESSION_PLIST" ]] && ! plist_valid "$SESSION_PLIST"; then
        print_warning "会话 plist 配置异常：路径或动作与当前 Bundle 不一致"
    fi

    if require_macos >/dev/null 2>&1 && launchd_loaded; then
        prod_pid="$(launchd_pid)"
        print_info "LaunchAgent 当前加载: 是${prod_pid:+ (PID: $prod_pid)}"
        if launchd_running; then
            print_success "生产运行: 是 (PID: $prod_pid, Profile: $prod_profile, 端口: $PROD_PORT)"
        else
            print_warning "生产运行: 否；LaunchAgent 已加载但端口未由其监听"
        fi
    else
        print_info "LaunchAgent 当前加载: 否"
        if port_in_use "$PROD_PORT"; then
            print_warning "生产运行: 配置异常；端口 $PROD_PORT 被 PID $(get_port_pids "$PROD_PORT") 占用，身份无法核实"
        else
            print_info "生产运行: 否 (Profile: $prod_profile, 端口: $PROD_PORT)"
        fi
    fi

    echo "  开发日志: $DEV_LOG_FILE"
    echo "  生产输出日志: $(effective_prod_log_path "$active_plist" StandardOutPath "$LOG_DIR/server-launchd.out.log")"
    echo "  生产错误日志: $(effective_prod_log_path "$active_plist" StandardErrorPath "$LOG_DIR/server-launchd.err.log")"
}

stop_all() {
    local result=0
    stop_dev || result=1
    stop_prod || result=1
    return "$result"
}

restart_dev() {
    stop_dev || return 1
    start_dev "$@"
}

restart_prod() {
    stop_prod || return 1
    start_prod
}

safe_remove_temp() {
    local target="$1"
    case "$target" in
        "$DIST_DIR"/npm-package-staging-*|"$DIST_DIR"/npm-package-swap-*)
            rm -rf -- "$target"
            ;;
        *)
            print_error "拒绝清理未核实的临时路径: $target"
            return 1
            ;;
    esac
}

verify_staging_bundle() {
    local staging="$1"
    [[ -f "$staging/dist/cli.js" \
        && -f "$staging/client-dist/index.html" \
        && -f "$staging/build-info.json" \
        && -f "$staging/package.json" \
        && -f "$staging/npm-shrinkwrap.json" \
        && -d "$staging/node_modules" ]]
}

swap_staging_bundle() {
    local staging="$1"
    local swap=""
    if [[ -e "$BUNDLE_DIR" ]]; then
        swap="$(mktemp -d "$DIST_DIR/npm-package-swap-XXXXXX")" || return 1
        rmdir "$swap" || return 1
        mv "$BUNDLE_DIR" "$swap" || return 1
    fi
    if ! mv "$staging" "$BUNDLE_DIR"; then
        if [[ -n "$swap" && -e "$swap" ]]; then
            mv "$swap" "$BUNDLE_DIR" || true
        fi
        return 1
    fi
    if [[ -n "$swap" && -e "$swap" ]]; then
        safe_remove_temp "$swap" || return 1
    fi
}

rebuild() {
    print_header "安全重构建生产 Bundle"
    cd "$PROJECT_ROOT" || return 1
    mkdir -p "$DIST_DIR"
    local staging
    staging="$(mktemp -d "$DIST_DIR/npm-package-staging-XXXXXX")" || return 1
    print_info "暂存目录: $staging"

    if ! pnpm lint; then
        print_error "Lint 失败；当前生产服务和 Bundle 未更改"
        safe_remove_temp "$staging"
        return 1
    fi
    if ! pnpm typecheck; then
        print_error "类型检查失败；当前生产服务和 Bundle 未更改"
        safe_remove_temp "$staging"
        return 1
    fi
    if ! YEP_BUNDLE_OUTPUT_DIR="$staging" pnpm build:bundle; then
        print_error "暂存 Bundle 构建失败；当前生产服务和 Bundle 未更改"
        safe_remove_temp "$staging"
        return 1
    fi
    if ! (cd "$staging" && npm ci --omit=dev --no-audit --no-fund); then
        print_error "暂存运行时依赖安装失败；当前生产服务和 Bundle 未更改"
        safe_remove_temp "$staging"
        return 1
    fi
    if ! pnpm bundle:verify "$staging" || ! verify_staging_bundle "$staging"; then
        print_error "暂存 Bundle 校验失败；当前生产服务和 Bundle 未更改"
        safe_remove_temp "$staging"
        return 1
    fi

    chmod +x "$staging/dist/cli.js" 2>/dev/null || true
    chmod +x "$staging"/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
    print_success "暂存 Bundle 已完整构建并校验"

    stop_prod || {
        print_error "无法安全停止当前生产实例；暂存 Bundle 未交换"
        safe_remove_temp "$staging"
        return 1
    }
    if ! swap_staging_bundle "$staging"; then
        print_error "生产 Bundle 交换失败"
        safe_remove_temp "$staging" 2>/dev/null || true
        return 1
    fi
    print_success "生产 Bundle 已原子交换"

    start_prod || {
        print_error "新 Bundle 已安装，但生产服务启动失败；未自动回滚"
        return 1
    }
    if node "$PROJECT_ROOT/scripts/verify-deploy.mjs" \
        --base-url "$(prod_base_url)" --build-info "$BUNDLE_BUILD_INFO"; then
        print_success "重构建完成，运行中的 buildId 已核对"
        return 0
    fi
    print_error "生产服务已启动，但 buildId 核对失败"
    return 1
}

show_help() {
    cat <<EOF
Yep Anywhere 服务进程管理（macOS）

用法:
  bash yep.sh [命令]

命令:
  start-dev [--fg]   启动开发服务；默认后台，--fg 前台
  stop-dev           仅停止已核实的开发服务
  restart-dev [--fg] 重启开发服务
  start-prod         通过 launchd 启动生产服务
  stop-prod          停止当前生产实例，保留自启动配置
  restart-prod       重启生产服务
  stop               停止开发和生产实例，不改变自启动配置
  status             显示安装、加载、运行、自启动、PID、端口和日志
  rebuild            暂存构建、安装依赖、校验后交换并重启生产
  enable-autostart   安装或修复登录自启动，不启动当前实例
  disable-autostart  删除登录自启动，不停止当前实例
  help               显示帮助

兼容别名:
  enable-launchd     等同 enable-autostart

Profile 与端口:
  dev=$DEV_PORT，prod=$PROD_PORT
EOF
}

show_menu() {
    while true; do
        echo ""
        echo "Yep Anywhere 服务进程管理"
        echo "  1) 启动开发服务（后台）"
        echo "  2) 前台启动开发服务"
        echo "  3) 停止开发服务"
        echo "  4) 启动生产服务"
        echo "  5) 停止生产服务"
        echo "  6) 重启生产服务"
        echo "  7) 查看状态"
        echo "  8) 安全重构建"
        echo "  9) 启用登录自启动"
        echo " 10) 关闭登录自启动"
        echo " 11) 停止开发和生产实例"
        echo "  0) 退出"
        read -r -p "请选择: " choice || return 1
        case "$choice" in
            1) start_dev ;;
            2) start_dev --fg ;;
            3) stop_dev ;;
            4) start_prod ;;
            5) stop_prod ;;
            6) restart_prod ;;
            7) status ;;
            8) rebuild ;;
            9) enable_autostart ;;
            10) disable_autostart ;;
            11) stop_all ;;
            0) return 0 ;;
            *) print_error "无效选择" ;;
        esac
    done
}

main() {
    local command="${1:-menu}"
    if [[ $# -gt 0 ]]; then
        shift
    fi
    case "$command" in
        start-dev) start_dev "$@" ;;
        stop-dev) stop_dev "$@" ;;
        restart-dev) restart_dev "$@" ;;
        start-prod) start_prod "$@" ;;
        stop-prod) stop_prod "$@" ;;
        restart-prod) restart_prod "$@" ;;
        stop) stop_all "$@" ;;
        status) status "$@" ;;
        rebuild) rebuild "$@" ;;
        enable-autostart|enable-launchd) enable_autostart "$@" ;;
        disable-autostart) disable_autostart "$@" ;;
        menu) show_menu ;;
        help|-h|--help) show_help ;;
        *)
            print_error "未知命令: $command"
            show_help
            return 1
            ;;
    esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi

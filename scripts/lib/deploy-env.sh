#!/usr/bin/env bash

# Load the git-ignored local deploy env file (.env.deploy.local by default) so
# every deploy entry point sees the same credentials. Values already present in
# the environment always win, so an explicit shell variable is never overridden.
#
# Callers must define `err` and `warn`, and must set REPO_ROOT, before calling
# load_deploy_env_file.

: "${LOADED_DEPLOY_ENV_FILE:=}"

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Routing keys the LaunchAgents carry (install-launchagents.sh
# build_provider_env_args). Yep's own processes run with them, and so does
# every shell or agent Yep starts. Credentials are deliberately not listed:
# a key that only ever lived in a deploying shell must not be lost just
# because the next deploy ran from a Yep terminal.
YEP_LAUNCHD_INHERITED_ROUTING_KEYS=(YEP_AGY_PROXY NO_PROXY)

# Value of `key` in the environment of the running LaunchAgent `label`
# (macOS `ps eww`; values without spaces, which routing URLs are). Fails when
# the job or the key is absent.
running_launchagent_env_value() {
  local label="$1" key="$2" pid
  pid="$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | awk '$1 == "pid" && $2 == "=" {print $3; exit}')"
  [[ -n "$pid" ]] || return 1
  ps eww -o command= -p "$pid" 2>/dev/null | tr ' ' '\n' | awk -v prefix="$key=" 'index($0, prefix) == 1 {print substr($0, length(prefix) + 1); found = 1; exit} END {exit !found}'
}

# A deploy started from a terminal or agent inside Yep inherits the running
# deployment's env. Such a value is not an explicit override: if it were
# kept, removing or changing the key in the env file could never take effect,
# because the reinstalled plist would copy the old value back. Drop routing
# keys whose value equals the one in the server/runtime LaunchAgent plist or
# in the running server/runtime process (the plist may already have been
# edited while the process still carries the old value), so the env file
# decides. A value the deploying shell set differently is kept.
drop_env_inherited_from_running_yep() {
  [[ -n "${YEP_DEPLOY_REPO_ROOT:-}" ]] || return 0
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local labels=(
    "${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
    "${YEP_LAUNCHD_RUNTIME_LABEL:-com.yueyuan.yepanywhere.runtime}"
  )
  local key label plist deployed inherited
  for key in "${YEP_LAUNCHD_INHERITED_ROUTING_KEYS[@]}"; do
    [[ -n "${!key+x}" ]] || continue
    inherited=false
    for label in "${labels[@]}"; do
      plist="$HOME/Library/LaunchAgents/$label.plist"
      if [[ -f "$plist" ]] &&
        deployed="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$key" "$plist" 2>/dev/null)" &&
        [[ "$deployed" == "${!key}" ]]; then
        inherited=true
        break
      fi
      if deployed="$(running_launchagent_env_value "$label" "$key")" &&
        [[ "$deployed" == "${!key}" ]]; then
        inherited=true
        break
      fi
    done
    if $inherited; then
      unset "$key"
      warn "Ignoring $key inherited from the running Yep; the deploy env file decides it"
    fi
  done
}

load_deploy_env_file() {
  local env_file="${YEP_DEPLOY_ENV_FILE:-$REPO_ROOT/.env.deploy.local}"
  local file_precedence="${YEP_DEPLOY_ENV_FILE_PRECEDENCE:-false}"

  drop_env_inherited_from_running_yep

  if [[ ! -f "$env_file" ]]; then
    if [[ -n "${YEP_DEPLOY_ENV_FILE:-}" ]]; then
      err "YEP_DEPLOY_ENV_FILE was set, but the file does not exist: $env_file"
      exit 1
    fi
    return
  fi

  # These files routinely contain API keys and service-account JSON. Tighten
  # an existing permissive mode before reading it; this is idempotent and does
  # not change the file contents.
  if ! chmod 600 "$env_file" 2>/dev/null; then
    warn "Could not restrict deploy env permissions to 600: $env_file"
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
    case "$key" in
      YEP_DEPLOY_ENV_FILE_PRECEDENCE|YEP_DEPLOY_LOCK_HELD|YEP_DEPLOY_LOCK_OWNED)
        warn "Skipping reserved deploy env key in $env_file: $key"
        continue
        ;;
    esac
    if [[ -n "${!key+x}" && "$file_precedence" != "true" ]]; then
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

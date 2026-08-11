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

load_deploy_env_file() {
  local env_file="${YEP_DEPLOY_ENV_FILE:-$REPO_ROOT/.env.deploy.local}"
  local file_precedence="${YEP_DEPLOY_ENV_FILE_PRECEDENCE:-false}"

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

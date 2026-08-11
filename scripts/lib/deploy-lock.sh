#!/usr/bin/env bash

# Serialize all mutations of the built bundle, LaunchAgent runtime, and local
# service processes. Callers must set REPO_ROOT and define err/warn first.

: "${YEP_DEPLOY_LOCK_OWNED:=false}"

deploy_lock_dir() {
  if [[ -n "${YEP_DEPLOY_LOCK_DIR:-}" ]]; then
    printf '%s' "$YEP_DEPLOY_LOCK_DIR"
  else
    # Profiles and custom data directories isolate application state, but the
    # default deploy targets still share the repository bundle, LaunchAgent
    # runtime, labels, and local service ports. Keep their mutation lock global
    # to the current user unless a caller explicitly supplies an isolated lock.
    printf '%s/.yep-anywhere/deploy/operation.lock' "$HOME"
  fi
}

read_deploy_lock_pid() {
  local owner_file="$1/owner"
  [[ -f "$owner_file" ]] || return 1
  awk -F= '$1 == "pid" { print $2; exit }' "$owner_file"
}

deploy_lock_pid_is_ancestor() {
  local expected="$1"
  local current="$$"
  local parent=""

  while [[ -n "$current" && "$current" != "1" ]]; do
    [[ "$current" == "$expected" ]] && return 0
    parent="$(ps -p "$current" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)"
    [[ -z "$parent" || "$parent" == "$current" ]] && break
    current="$parent"
  done
  return 1
}

release_deploy_lock() {
  [[ "$YEP_DEPLOY_LOCK_OWNED" == "true" ]] || return 0

  local lock_dir="${YEP_DEPLOY_LOCK_HELD:-}"
  local owner_pid=""
  [[ -n "$lock_dir" ]] || return 0
  owner_pid="$(read_deploy_lock_pid "$lock_dir" 2>/dev/null || true)"
  if [[ "$owner_pid" == "$$" ]]; then
    rm -f "$lock_dir/owner"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
  YEP_DEPLOY_LOCK_OWNED=false
}

acquire_deploy_lock() {
  local lock_dir parent_dir owner_pid stale_dir
  lock_dir="$(deploy_lock_dir)"

  if [[ "${YEP_DEPLOY_LOCK_HELD:-}" == "$lock_dir" ]]; then
    owner_pid="$(read_deploy_lock_pid "$lock_dir" 2>/dev/null || true)"
    if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" 2>/dev/null &&
      deploy_lock_pid_is_ancestor "$owner_pid"; then
      return 0
    fi
    unset YEP_DEPLOY_LOCK_HELD
  fi
  if [[ "$lock_dir" != /* || "$lock_dir" == "/" ]]; then
    err "YEP_DEPLOY_LOCK_DIR must be an absolute, non-root path: $lock_dir"
    return 1
  fi

  parent_dir="$(dirname "$lock_dir")"
  mkdir -p "$parent_dir"
  chmod 700 "$parent_dir" 2>/dev/null || true

  if ! mkdir "$lock_dir" 2>/dev/null; then
    owner_pid="$(read_deploy_lock_pid "$lock_dir" 2>/dev/null || true)"
    if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" 2>/dev/null; then
      err "Another Yep Anywhere deployment is already running (PID $owner_pid)."
      err "Lock: $lock_dir"
      return 1
    fi

    stale_dir="${lock_dir}.stale.$$.$RANDOM"
    if ! mv "$lock_dir" "$stale_dir" 2>/dev/null; then
      err "Deployment lock changed while checking it; retry the deployment."
      return 1
    fi
    warn "Removing stale deployment lock${owner_pid:+ from PID $owner_pid}: $lock_dir"
    rm -f "$stale_dir/owner"
    if ! rmdir "$stale_dir" 2>/dev/null; then
      err "Stale deployment lock contains unexpected files: $stale_dir"
      return 1
    fi
    if ! mkdir "$lock_dir" 2>/dev/null; then
      err "Another deployment acquired the lock first; retry later."
      return 1
    fi
  fi

  chmod 700 "$lock_dir" 2>/dev/null || true
  umask 077
  {
    printf 'pid=%s\n' "$$"
    printf 'startedAt=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'repoRoot=%s\n' "$REPO_ROOT"
    printf 'command=%s\n' "$0"
  } >"$lock_dir/owner"
  chmod 600 "$lock_dir/owner" 2>/dev/null || true

  export YEP_DEPLOY_LOCK_HELD="$lock_dir"
  YEP_DEPLOY_LOCK_OWNED=true
  trap release_deploy_lock EXIT
}

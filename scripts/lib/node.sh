#!/usr/bin/env bash

# Use the exact Node.js version pinned by this repository even when a deploy is
# started by a shell or LaunchAgent whose PATH selects another runtime.
ensure_project_node() {
  local nvm_version_file="$REPO_ROOT/.nvmrc"
  local node_version_file="$REPO_ROOT/.node-version"
  [[ -f "$nvm_version_file" ]] || return 0

  local expected_version node_version_pin current_version
  expected_version="$(tr -d '[:space:]' <"$nvm_version_file")"
  [[ -n "$expected_version" ]] || return 0
  expected_version="${expected_version#v}"

  if [[ -f "$node_version_file" ]]; then
    node_version_pin="$(tr -d '[:space:]' <"$node_version_file")"
    node_version_pin="${node_version_pin#v}"
    if [[ "$node_version_pin" != "$expected_version" ]]; then
      err ".nvmrc requires v$expected_version but .node-version requires v$node_version_pin. Align the repository pins before deploying."
      return 1
    fi
  fi

  current_version="$(node --version 2>/dev/null || true)"
  if [[ "$current_version" == "v$expected_version" ]]; then
    return 0
  fi

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local nvm_script="$nvm_dir/nvm.sh"
  if [[ ! -s "$nvm_script" ]]; then
    err "Node v$expected_version is required by .nvmrc, but NVM is unavailable at $nvm_script."
    return 1
  fi

  export NVM_DIR="$nvm_dir"
  local had_nounset=false
  local source_status=0
  case "$-" in
    *u*)
      had_nounset=true
      set +u
      ;;
  esac
  # shellcheck source=/dev/null
  source "$nvm_script" || source_status=$?
  if $had_nounset; then
    set -u
  fi
  if [[ "$source_status" -ne 0 ]]; then
    err "Failed to load NVM from $nvm_script."
    return "$source_status"
  fi

  if ! nvm use --silent "$expected_version"; then
    err "Node v$expected_version is required by .nvmrc. Install it with: nvm install $expected_version"
    return 1
  fi

  current_version="$(node --version 2>/dev/null || true)"
  if [[ "$current_version" != "v$expected_version" ]]; then
    err "NVM selected $current_version, but .nvmrc requires v$expected_version."
    return 1
  fi
  dim "node: using $current_version from .nvmrc"
}

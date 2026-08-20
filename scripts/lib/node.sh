#!/usr/bin/env bash

# Put one directory first on PATH, dropping any other occurrence of it so the
# entry is unambiguous. Bash's command hash is cleared because a command that
# already ran in this shell would otherwise keep resolving to its old location.
prepend_to_path() {
  local dir="$1"
  local rebuilt="" entry
  local old_ifs="$IFS"
  # Split on ':' with globbing off: an unquoted expansion would otherwise let a
  # PATH entry containing a glob character expand into matching filenames.
  local had_noglob=false
  case "$-" in *f*) had_noglob=true ;; esac
  set -f
  IFS=':'
  for entry in $PATH; do
    [[ -z "$entry" || "$entry" == "$dir" ]] && continue
    rebuilt="${rebuilt:+$rebuilt:}$entry"
  done
  IFS="$old_ifs"
  $had_noglob || set +f
  export PATH="$dir${rebuilt:+:$rebuilt}"
  hash -r 2>/dev/null || true
}

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
  local target_bin=""
  if [[ -x "$nvm_dir/versions/node/v$expected_version/bin/node" ]]; then
    target_bin="$nvm_dir/versions/node/v$expected_version/bin"
  else
    target_bin="$(load_nvm_node_bin "$nvm_dir" "$expected_version")" || return 1
  fi

  if [[ -z "$target_bin" || ! -x "$target_bin/node" ]]; then
    err "Node v$expected_version is required by .nvmrc. Install it with: nvm install $expected_version"
    return 1
  fi

  local target_version
  target_version="$("$target_bin/node" --version 2>/dev/null || true)"
  if [[ -z "$target_version" ]]; then
    err "$target_bin/node is not runnable. Reinstall it with: nvm install $expected_version"
    return 1
  fi

  # An .nvmrc naming an exact version must resolve to exactly that version. A
  # pin that is an alias or a partial version ("22", "lts/*") is whatever NVM
  # resolved it to, which is the whole point of writing it that way.
  case "$expected_version" in
    [0-9]*.[0-9]*.[0-9]*)
      if [[ "$target_version" != "v$expected_version" ]]; then
        err "Resolved $target_bin/node as $target_version, but .nvmrc requires v$expected_version."
        return 1
      fi
      ;;
  esac

  # Select the runtime by editing PATH directly rather than leaving it to
  # `nvm use`. When PATH already contains an NVM bin directory, `nvm use`
  # rewrites that entry in place instead of moving it to the front, so any
  # other Node earlier on PATH (a Homebrew install, for example) keeps winning
  # while NVM still reports success.
  prepend_to_path "$target_bin"

  current_version="$(node --version 2>/dev/null || true)"
  if [[ "$current_version" != "$target_version" ]]; then
    err "Selected $target_bin/node ($target_version), but 'node' still resolves to ${current_version:-none} at $(command -v node 2>/dev/null || echo 'no node on PATH')."
    return 1
  fi
  dim "node: using $current_version from .nvmrc ($target_bin)"
}

# Resolve the bin directory for a pinned version through NVM. Used only when the
# version is not already installed under its exact directory name, which is what
# an .nvmrc holding an alias or a partial version looks like.
load_nvm_node_bin() {
  local nvm_dir="$1"
  local expected_version="$2"
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

  local resolved
  resolved="$(nvm which "$expected_version" 2>/dev/null || true)"
  if [[ -z "$resolved" || ! -x "$resolved" ]]; then
    err "Node v$expected_version is required by .nvmrc. Install it with: nvm install $expected_version"
    return 1
  fi
  dirname "$resolved"
}

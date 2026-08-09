#!/usr/bin/env bash

# Select the pnpm release pinned by packageManager. Prefer the repository's
# Corepack shim so LaunchAgents and non-interactive shells do not inherit an
# unrelated global pnpm by accident.
ensure_pnpm() {
  local package_json="$REPO_ROOT/package.json"
  local expected_version
  expected_version="$(node -p "require(process.argv[1]).packageManager?.replace(/^pnpm@/, '') || ''" "$package_json")"
  if [[ -z "$expected_version" ]]; then
    err "package.json must pin pnpm through packageManager before deployment."
    return 1
  fi

  local actual_version=""
  if command -v corepack >/dev/null 2>&1; then
    local shim_dir="$REPO_ROOT/scripts/corepack-shims"
    if [[ ! -x "$shim_dir/pnpm" ]]; then
      err "Corepack pnpm shim is missing or not executable: $shim_dir/pnpm"
      return 1
    fi
    actual_version="$(corepack pnpm --version)"
    export PATH="$shim_dir:$PATH"
    dim "pnpm: using repository Corepack shim ($actual_version)"
  elif command -v pnpm >/dev/null 2>&1; then
    actual_version="$(pnpm --version)"
    dim "pnpm: Corepack unavailable; using global pnpm $actual_version"
  else
    err "pnpm is not on PATH and Corepack is unavailable. Install the pinned toolchain, then retry."
    return 1
  fi

  if [[ "$actual_version" != "$expected_version" ]]; then
    err "pnpm $expected_version is required by packageManager, but the selected executable reports $actual_version."
    return 1
  fi
}

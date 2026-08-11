#!/usr/bin/env bash
# Copy the built bundle out of macOS privacy-protected project directories
# before a LaunchAgent starts it. Background jobs can otherwise hang while
# opening files under locations such as ~/Desktop.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE_BUNDLE_DIR="$REPO_ROOT/dist/npm-package"
RUNTIME_INPUT="${YEP_LAUNCHD_RUNTIME_DIR:-$HOME/.yep-anywhere/runtime/npm-package}"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

is_runtime_bundle() {
  local candidate="$1"
  [[ -d "$candidate" && -f "$candidate/dist/cli.js" && -f "$candidate/package.json" ]]
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "LaunchAgent runtime sync is only supported on macOS."
fi
if [[ "$RUNTIME_INPUT" != /* ]]; then
  fail "YEP_LAUNCHD_RUNTIME_DIR must be an absolute path: $RUNTIME_INPUT"
fi

RUNTIME_NAME="$(basename "$RUNTIME_INPUT")"
RUNTIME_PARENT_INPUT="$(dirname "$RUNTIME_INPUT")"
if [[ -z "$RUNTIME_NAME" || "$RUNTIME_NAME" == "." || "$RUNTIME_NAME" == ".." || "$RUNTIME_PARENT_INPUT" == "/" ]]; then
  fail "Refusing unsafe LaunchAgent runtime target: $RUNTIME_INPUT"
fi

mkdir -p "$RUNTIME_PARENT_INPUT"
RUNTIME_PARENT="$(cd "$RUNTIME_PARENT_INPUT" && pwd -P)"
RUNTIME_BUNDLE_DIR="$RUNTIME_PARENT/$RUNTIME_NAME"
PREVIOUS_BUNDLE_DIR="$RUNTIME_BUNDLE_DIR.previous"
HOME_REAL="$(cd "$HOME" && pwd -P)"

if [[ "$RUNTIME_BUNDLE_DIR" == "$HOME_REAL" || "$RUNTIME_PARENT" == "/" ]]; then
  fail "Refusing unsafe LaunchAgent runtime target: $RUNTIME_BUNDLE_DIR"
fi
case "$RUNTIME_BUNDLE_DIR/" in
  "$REPO_ROOT/"*)
    fail "LaunchAgent runtime must stay outside the repository: $RUNTIME_BUNDLE_DIR"
    ;;
esac

if [[ ! -f "$SOURCE_BUNDLE_DIR/dist/cli.js" ]]; then
  fail "Built bundle is missing: $SOURCE_BUNDLE_DIR/dist/cli.js"
fi
if [[ ! -f "$SOURCE_BUNDLE_DIR/package.json" ]]; then
  fail "Built bundle metadata is missing: $SOURCE_BUNDLE_DIR/package.json"
fi
if [[ ! -d "$SOURCE_BUNDLE_DIR/node_modules" ]]; then
  fail "Built bundle runtime dependencies are missing: $SOURCE_BUNDLE_DIR/node_modules"
fi
if [[ -L "$RUNTIME_BUNDLE_DIR" || -L "$PREVIOUS_BUNDLE_DIR" ]]; then
  fail "Refusing symlinked LaunchAgent runtime target."
fi
if [[ -e "$RUNTIME_BUNDLE_DIR" ]] && ! is_runtime_bundle "$RUNTIME_BUNDLE_DIR"; then
  fail "Refusing to replace an unrecognized LaunchAgent runtime: $RUNTIME_BUNDLE_DIR"
fi
if [[ -e "$PREVIOUS_BUNDLE_DIR" ]] && ! is_runtime_bundle "$PREVIOUS_BUNDLE_DIR"; then
  fail "Refusing to replace an unrecognized previous runtime: $PREVIOUS_BUNDLE_DIR"
fi

bundles_match() {
  local source="$1"
  local target="$2"

  cmp -s "$source/package.json" "$target/package.json" || return 1
  cmp -s "$source/dist/cli.js" "$target/dist/cli.js" || return 1
  if [[ -f "$source/build-info.json" || -f "$target/build-info.json" ]]; then
    [[ -f "$source/build-info.json" && -f "$target/build-info.json" ]] || return 1
    cmp -s "$source/build-info.json" "$target/build-info.json" || return 1
  fi
}

if [[ -d "$RUNTIME_BUNDLE_DIR/node_modules" ]] &&
  bundles_match "$SOURCE_BUNDLE_DIR" "$RUNTIME_BUNDLE_DIR"; then
  chmod +x "$RUNTIME_BUNDLE_DIR/dist/cli.js"
  printf 'runtime=%s\n' "$RUNTIME_BUNDLE_DIR"
  printf 'unchanged=true\n'
  if [[ -d "$PREVIOUS_BUNDLE_DIR" ]]; then
    printf 'previous=%s\n' "$PREVIOUS_BUNDLE_DIR"
  fi
  exit 0
fi

STAGING_DIR="$(mktemp -d "$RUNTIME_PARENT/.${RUNTIME_NAME}.sync.XXXXXX")"
RETIRED_PREVIOUS_DIR=""
CURRENT_MOVED=false
PUBLISHED=false

cleanup() {
  if ! $PUBLISHED; then
    if [[ -d "$STAGING_DIR" ]]; then
      rm -rf "$STAGING_DIR"
    fi
    if $CURRENT_MOVED && [[ ! -e "$RUNTIME_BUNDLE_DIR" && -d "$PREVIOUS_BUNDLE_DIR" ]]; then
      mv "$PREVIOUS_BUNDLE_DIR" "$RUNTIME_BUNDLE_DIR"
    fi
    if [[ -n "$RETIRED_PREVIOUS_DIR" && -d "$RETIRED_PREVIOUS_DIR" && ! -e "$PREVIOUS_BUNDLE_DIR" ]]; then
      mv "$RETIRED_PREVIOUS_DIR" "$PREVIOUS_BUNDLE_DIR"
    fi
  fi
}
trap cleanup EXIT

ditto "$SOURCE_BUNDLE_DIR" "$STAGING_DIR"
chmod +x "$STAGING_DIR/dist/cli.js"
if ! is_runtime_bundle "$STAGING_DIR" || [[ ! -d "$STAGING_DIR/node_modules" ]]; then
  fail "Staged LaunchAgent runtime is incomplete: $STAGING_DIR"
fi

if [[ -d "$PREVIOUS_BUNDLE_DIR" ]]; then
  RETIRED_PREVIOUS_DIR="$(mktemp -d "$RUNTIME_PARENT/.${RUNTIME_NAME}.retired.XXXXXX")"
  rmdir "$RETIRED_PREVIOUS_DIR"
  mv "$PREVIOUS_BUNDLE_DIR" "$RETIRED_PREVIOUS_DIR"
fi
if [[ -d "$RUNTIME_BUNDLE_DIR" ]]; then
  mv "$RUNTIME_BUNDLE_DIR" "$PREVIOUS_BUNDLE_DIR"
  CURRENT_MOVED=true
fi

if ! mv "$STAGING_DIR" "$RUNTIME_BUNDLE_DIR"; then
  fail "Failed to publish the staged LaunchAgent runtime."
fi
PUBLISHED=true

if [[ -n "$RETIRED_PREVIOUS_DIR" && -d "$RETIRED_PREVIOUS_DIR" ]]; then
  if $CURRENT_MOVED; then
    rm -rf "$RETIRED_PREVIOUS_DIR"
  else
    mv "$RETIRED_PREVIOUS_DIR" "$PREVIOUS_BUNDLE_DIR"
  fi
fi

printf 'runtime=%s\n' "$RUNTIME_BUNDLE_DIR"
if [[ -d "$PREVIOUS_BUNDLE_DIR" ]]; then
  printf 'previous=%s\n' "$PREVIOUS_BUNDLE_DIR"
fi

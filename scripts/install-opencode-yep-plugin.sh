#!/bin/bash
# Install the Yep Anywhere forwarder plugin into the global OpenCode plugin
# directory so that default `opencode` TUI sessions (which expose no HTTP
# server) report permission/question requests to the Yep bridge on 4520.
#
# Usage: scripts/install-opencode-yep-plugin.sh [--uninstall]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO_ROOT/packages/server/resources/opencode-plugin/yep-bridge.ts"
TARGET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin"
TARGET="$TARGET_DIR/yep-bridge.ts"

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -f "$TARGET" ]]; then
    rm "$TARGET"
    echo "Removed $TARGET"
  else
    echo "Not installed: $TARGET"
  fi
  exit 0
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "Plugin source not found: $SOURCE" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE" "$TARGET"
echo "Installed $TARGET"
echo "New opencode instances will now report approvals to the Yep bridge (4520)."
echo "Override the bridge URL with YEP_OPENCODE_BRIDGE_URL if needed."

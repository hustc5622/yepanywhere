#!/bin/bash
# Install the Yep Anywhere bridge plugin for ZCode (`zcode tui`).
#
# What it does:
#   1. Copies packages/server/resources/zcode-plugin into
#      ~/.zcode/plugins/yep-bridge/ and expands hooks/hooks.json with the
#      absolute node/hook-entry paths of THIS machine.
#   2. Writes ~/.zcode/yep-bridge.json with a random shared token and the Yep
#      server URL the plugin posts hook events to.
#   3. Registers the plugin directory in the `plugins.dirs` array of
#      ~/.zcode/cli/config.json (the file is backed up first).
#
# After install, every new `zcode` instance reports session lifecycle and
# permission requests to the Yep server; PermissionRequest decisions made in
# the Yep client take precedence over the native TUI popup.
#
# Usage (repository): scripts/install-zcode-yep-plugin.sh [--url URL] [--uninstall]
# Usage (npm):        yepanywhere-zcode-plugin [--url URL] [--uninstall]
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -d "$PACKAGE_ROOT/resources/zcode-plugin" ]]; then
  # Published npm package layout.
  SOURCE_DIR="$PACKAGE_ROOT/resources/zcode-plugin"
else
  # Source repository layout.
  SOURCE_DIR="$PACKAGE_ROOT/packages/server/resources/zcode-plugin"
fi

ZCODE_HOME="${ZCODE_HOME:-$HOME/.zcode}"
TARGET_DIR="$ZCODE_HOME/plugins/yep-bridge"
CONFIG_FILE="$ZCODE_HOME/cli/config.json"
BRIDGE_CONFIG="$ZCODE_HOME/yep-bridge.json"

SERVER_URL="${YEP_ZCODE_BRIDGE_URL:-http://127.0.0.1:8022/yep}"
ACTION="install"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) ACTION="uninstall"; shift ;;
    --url) SERVER_URL="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$ACTION" == "uninstall" ]]; then
  if [[ -d "$TARGET_DIR" ]]; then
    rm -rf "$TARGET_DIR"
    echo "Removed $TARGET_DIR"
  else
    echo "Not installed: $TARGET_DIR"
  fi
  if [[ -f "$BRIDGE_CONFIG" ]]; then
    rm "$BRIDGE_CONFIG"
    echo "Removed $BRIDGE_CONFIG (bridge token revoked)"
  fi
  if [[ -f "$CONFIG_FILE" ]] && grep -q "$TARGET_DIR" "$CONFIG_FILE" 2>/dev/null; then
    cp "$CONFIG_FILE" "$CONFIG_FILE.yep-backup-$(date +%Y%m%d%H%M%S)"
    node -e '
      const fs = require("node:fs");
      const file = process.argv[1];
      const dir = process.argv[2];
      const config = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (config.plugins && Array.isArray(config.plugins.dirs)) {
        config.plugins.dirs = config.plugins.dirs.filter((d) => d !== dir);
      }
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
    ' "$CONFIG_FILE" "$TARGET_DIR"
    echo "Removed plugin dir from $CONFIG_FILE (backup saved next to it)"
  fi
  exit 0
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Plugin source not found: $SOURCE_DIR" >&2
  exit 1
fi
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is required (ZCode runs hook commands through node)" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR/hooks"
cp "$SOURCE_DIR/hook-entry.mjs" "$TARGET_DIR/hook-entry.mjs"
mkdir -p "$TARGET_DIR/.zcode-plugin"
cp "$SOURCE_DIR/.zcode-plugin/plugin.json" "$TARGET_DIR/.zcode-plugin/plugin.json"

# Expand hook placeholders with this machine's absolute paths.
sed -e "s|__YEP_NODE__|$NODE_BIN|g" \
    -e "s|__YEP_HOOK_ENTRY__|$TARGET_DIR/hook-entry.mjs|g" \
    "$SOURCE_DIR/hooks/hooks.json" > "$TARGET_DIR/hooks/hooks.json"

# Shared token + server URL. An existing token is preserved so a re-install
# does not invalidate the running config.
if [[ -f "$BRIDGE_CONFIG" ]]; then
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const url = process.argv[2];
    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    config.serverUrl = url;
    if (typeof config.token !== "string" || config.token.length === 0) {
      config.token = require("node:crypto").randomBytes(24).toString("hex");
    }
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  ' "$BRIDGE_CONFIG" "$SERVER_URL"
  chmod 600 "$BRIDGE_CONFIG"
  echo "Updated server URL in $BRIDGE_CONFIG (existing token preserved)"
else
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const url = process.argv[2];
    const token = require("node:crypto").randomBytes(24).toString("hex");
    fs.writeFileSync(
      file,
      JSON.stringify({ serverUrl: url, token }, null, 2),
      { mode: 0o600 },
    );
  ' "$BRIDGE_CONFIG" "$SERVER_URL"
  chmod 600 "$BRIDGE_CONFIG"
  echo "Wrote $BRIDGE_CONFIG (random shared token, mode 600)"
fi

# Register the plugin directory via plugins.dirs. The config file is backed
# up BEFORE modification; on first use it is created with an empty skeleton.
mkdir -p "$(dirname "$CONFIG_FILE")"
if [[ -f "$CONFIG_FILE" ]]; then
  cp "$CONFIG_FILE" "$CONFIG_FILE.yep-backup-$(date +%Y%m%d%H%M%S)"
  echo "Backed up $CONFIG_FILE"
fi
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const dir = process.argv[2];
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf-8")); } catch {}
  if (typeof config !== "object" || config === null || Array.isArray(config)) config = {};
  if (typeof config.plugins !== "object" || config.plugins === null) config.plugins = {};
  if (!Array.isArray(config.plugins.dirs)) config.plugins.dirs = [];
  if (!config.plugins.dirs.includes(dir)) config.plugins.dirs.push(dir);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
' "$CONFIG_FILE" "$TARGET_DIR"
chmod 600 "$CONFIG_FILE"

echo "Installed ZCode plugin: $TARGET_DIR"
echo "Registered in: $CONFIG_FILE (plugins.dirs)"
echo "Server URL: $SERVER_URL (override with YEP_ZCODE_BRIDGE_URL or --url)"
echo "New zcode instances will report session activity and permission requests to Yep."

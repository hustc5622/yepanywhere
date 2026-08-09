#!/usr/bin/env bash
# Rebuild the yepanywhere mobile APK from the monorepo and (optionally) install
# it onto a connected Android device via adb.
#
# Usage:
#   scripts/rebuild-apk.sh                       # debug build + auto-install onto the lone connected device
#   scripts/rebuild-apk.sh -s <device-id>        # install onto a specific device (adb devices to list)
#   scripts/rebuild-apk.sh --device <device-id>  # same as -s, long form
#   scripts/rebuild-apk.sh --release             # production release build (slower, smaller; needs keystore.properties)
#   scripts/rebuild-apk.sh --no-install          # build only, skip adb install
#   scripts/rebuild-apk.sh --no-build            # install the existing APK without rebuilding
#   scripts/rebuild-apk.sh -h | --help
#
# Assumes:
#   - Toolchain is installed in the standard Homebrew locations (see SELF-BUILD.md).
#     The script exports JAVA_HOME / ANDROID_HOME / NDK_HOME / PATH on its own
#     because tauri's child processes do NOT inherit your interactive zshrc.
#   - For release builds, packages/mobile/src-tauri/gen/android/keystore.properties
#     is already configured (one-time setup; see SELF-BUILD.md "Release packaging").
#
# Notes:
#   - Switching between --debug and release on the same device hits
#     INSTALL_FAILED_UPDATE_INCOMPATIBLE because the signing certs differ. The
#     script detects that signature mismatch error and tells you to uninstall
#     the existing APK first (it does NOT auto-uninstall — that wipes app data,
#     which usually is NOT what you want).
#   - The build does not touch the running yepanywhere server. Front-end-only
#     edits become visible the moment the new APK is launched on the phone.

set -euo pipefail

# Resolve repo root from script location so this works no matter where it's invoked.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/packages/mobile"

# Color helpers (skipped if not a tty).
if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_CYAN="\033[36m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_DIM=""; C_RESET=""
fi

log()  { echo -e "${C_GREEN}==>${C_RESET} $*"; }
info() { echo -e "${C_CYAN}::${C_RESET}  $*"; }
warn() { echo -e "${C_YELLOW}!!${C_RESET}  $*" >&2; }
err()  { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim()  { echo -e "${C_DIM}    $*${C_RESET}"; }

# shellcheck source=scripts/lib/node.sh
source "$SCRIPT_DIR/lib/node.sh"
# shellcheck source=scripts/lib/pnpm.sh
source "$SCRIPT_DIR/lib/pnpm.sh"

# ----- args -----
BUILD_TYPE="release"      # release | debug
DEVICE_ID=""              # passed to adb -s
DO_BUILD=true
DO_INSTALL=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--device)
      if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
        err "$1 requires a device id argument. Run 'adb devices' to see options."
        exit 2
      fi
      DEVICE_ID="$2"
      shift 2
      ;;
    --debug)        BUILD_TYPE="debug"; shift ;;
    --release)      BUILD_TYPE="release"; shift ;;
    --no-install)   DO_INSTALL=false; shift ;;
    --no-build)     DO_BUILD=false; shift ;;
    -h|--help)
      # Print the leading comment block as the help text.
      sed -n '2,28p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      err "Unknown arg: $1"
      err "Run with -h for usage."
      exit 2
      ;;
  esac
done

# ----- toolchain (must come before any pnpm/tauri/adb call) -----
# These match SELF-BUILD.md. If a user has them in a non-standard location
# they can pre-export and the script will respect their override since we
# only set if unset.
: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@17}"
: "${ANDROID_HOME:=/opt/homebrew/share/android-commandlinetools}"
: "${NDK_HOME:=$ANDROID_HOME/ndk/28.2.13676358}"
export JAVA_HOME ANDROID_HOME NDK_HOME
export PATH="$HOME/.cargo/bin:$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Sanity-check the toolchain only when we'll need it.
if $DO_BUILD; then
  if ! [[ -x "$JAVA_HOME/bin/java" ]]; then
    err "JDK not found at $JAVA_HOME. Install with: brew install openjdk@17"
    exit 1
  fi
  if ! [[ -d "$ANDROID_HOME/platform-tools" ]]; then
    err "Android SDK not found at $ANDROID_HOME. See SELF-BUILD.md '全新机器从零安装'."
    exit 1
  fi
  if ! [[ -d "$NDK_HOME" ]]; then
    warn "NDK not found at $NDK_HOME. The build may fail; check 'sdkmanager --list_installed | grep ndk'."
  fi
fi

# ----- device selection (only matters when installing) -----
# Done BEFORE the build so a missing device doesn't waste 1-3 minutes of compile.
ADB_TARGET_FLAGS=()
if $DO_INSTALL; then
  if ! command -v adb >/dev/null 2>&1; then
    err "adb is not on PATH (looked for $ANDROID_HOME/platform-tools/adb)."
    exit 1
  fi

  # adb devices output looks like:
  #   List of devices attached
  #   emulator-5554   device
  #   1A2B3C4D        device
  # Skip the header line and any with state != 'device' (offline / unauthorized).
  DEVICE_LINES="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}')"
  DEVICE_COUNT="$(printf '%s\n' "$DEVICE_LINES" | grep -c . || true)"

  if [[ -n "$DEVICE_ID" ]]; then
    # User specified a device. Verify it's actually connected before we burn
    # time on the build.
    if ! grep -qx "$DEVICE_ID" <<<"$DEVICE_LINES"; then
      err "Device '$DEVICE_ID' is not in 'adb devices' (or its state is not 'device')."
      err "Currently connected:"
      adb devices >&2 || true
      exit 1
    fi
    ADB_TARGET_FLAGS=(-s "$DEVICE_ID")
    info "Targeting device: $DEVICE_ID"
  else
    case "$DEVICE_COUNT" in
      0)
        warn "No connected adb devices. Install will be skipped — pass --no-install to silence this, or"
        warn "connect a device (USB or 'adb connect <ip>:5555') and re-run."
        DO_INSTALL=false
        ;;
      1)
        # Pull the only device id without using mapfile (mac default bash 3.2).
        DEVICE_ID="$DEVICE_LINES"
        ADB_TARGET_FLAGS=(-s "$DEVICE_ID")
        info "Auto-targeting the only connected device: $DEVICE_ID"
        ;;
      *)
        err "Multiple devices connected (${DEVICE_COUNT}). Specify one with -s <device-id>:"
        adb devices >&2 || true
        exit 1
        ;;
    esac
  fi
fi

# ----- build -----
APK_NAME="app-universal-${BUILD_TYPE}.apk"
APK_PATH="$MOBILE_DIR/src-tauri/gen/android/app/build/outputs/apk/universal/${BUILD_TYPE}/${APK_NAME}"

if $DO_BUILD; then
  ensure_project_node
  ensure_pnpm
  # Version stamping:
  # - versionName follows the monorepo version (tauri.conf.json points at the
  #   root package.json), so installers show e.g. 0.4.29 instead of 0.1.0.
  # - versionCode must increase for every build a device might see, or the
  #   package installer shows "0.4.29 -> 0.4.29" style sidegrades for changed
  #   binaries. Derive it from the commit count so every commit gets a fresh,
  #   monotonic code (dirty rebuilds of one commit share a code, which Android
  #   treats as a reinstall of the same version - fine for dev).
  #   The 100000 offset keeps script builds strictly above tauri's default
  #   versionCode math (major*1000000+minor*1000+patch, ~4029 for 0.4.29), so
  #   an accidental direct `pnpm tauri android build` can never leapfrog the
  #   script's numbering; it would fail as a downgrade instead.
  APP_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
  GIT_COMMIT_COUNT="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
  VERSION_CODE="$((100000 + GIT_COMMIT_COUNT))"

  log "Building Android APK (${BUILD_TYPE}) ..."
  dim "  cwd: $MOBILE_DIR"
  dim "  versionName=$APP_VERSION versionCode=$VERSION_CODE"
  dim "  JAVA_HOME=$JAVA_HOME"
  dim "  ANDROID_HOME=$ANDROID_HOME"
  dim "  NDK_HOME=$NDK_HOME"

  # `pnpm tauri android build --apk` produces release; `--debug --apk` produces debug.
  # `--apk` keeps it from also producing the AAB (which we don't ship).
  # Surface the profile to the frontend build (tauri's beforeBuildCommand →
  # `pnpm prepare-frontend` → vite) so the in-app build stamp can show
  # debug vs release — they're otherwise byte-identical frontends.
  export YEP_BUILD_PROFILE="$BUILD_TYPE"
  VERSION_CONFIG="{\"bundle\":{\"android\":{\"versionCode\":$VERSION_CODE}}}"
  if [[ "$BUILD_TYPE" == "debug" ]]; then
    (cd "$MOBILE_DIR" && pnpm tauri android build --debug --apk --config "$VERSION_CONFIG")
  else
    (cd "$MOBILE_DIR" && pnpm tauri android build --apk --config "$VERSION_CONFIG")
  fi

  if [[ ! -f "$APK_PATH" ]]; then
    err "Build finished but expected APK is missing: $APK_PATH"
    err "Look in src-tauri/gen/android/app/build/outputs/apk/ for what was actually produced."
    exit 1
  fi

  APK_SIZE="$(du -h "$APK_PATH" | cut -f1)"
  log "Built ${APK_SIZE}: $APK_PATH"
fi

# ----- install -----
if $DO_INSTALL; then
  if [[ ! -f "$APK_PATH" ]]; then
    err "Cannot install: APK not found at $APK_PATH"
    err "Run without --no-build, or check what's in src-tauri/gen/android/app/build/outputs/apk/."
    exit 1
  fi

  log "Installing onto $DEVICE_ID ..."
  # -r = reinstall keeping data, -t = allow test packages (debug builds set this flag).
  # We capture stderr so we can give a friendlier hint on the common signature-
  # mismatch failure.
  set +e
  INSTALL_OUT="$(adb "${ADB_TARGET_FLAGS[@]}" install -r -t "$APK_PATH" 2>&1)"
  INSTALL_RC=$?
  set -e

  echo "$INSTALL_OUT"

  if [[ $INSTALL_RC -ne 0 ]]; then
    if grep -qE "INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match" <<<"$INSTALL_OUT"; then
      err "Signature mismatch — the device has a copy of this app signed with a different key."
      err "(Most commonly: switching between --debug and release.)"
      err ""
      err "To install the new build, uninstall the existing copy first:"
      err "  adb ${ADB_TARGET_FLAGS[*]} uninstall com.yepanywhere.mobile.local"
      err ""
      err "⚠  This wipes the app's local data (login state, drafts, settings)."
      err "   Re-run this script after uninstalling."
    fi
    exit "$INSTALL_RC"
  fi

  log "Installed. Launch 'Yep Anywhere' on the device."
fi

log "Done."

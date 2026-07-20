#!/usr/bin/env bash
set -euo pipefail

APP_NAME="kitty-cef-helper"
HELPER_NAME="kitty-cef-helper Helper"
HELPER_BUNDLE_ID="com.kitty-webui.cef-helper.helper"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CEF_ROOT="${CEF_ROOT:-}"
if [[ -z "$CEF_ROOT" ]]; then
  cat >&2 <<'MSG'
CEF_ROOT is required.

Point it at an extracted CEF binary distribution, for example:
  CEF_ROOT=$HOME/vendor/cef_binary_... ./scripts/build-cef-helper.sh
MSG
  exit 2
fi

EXTRA_CMAKE_ARGS_ARRAY=()
if [[ -n "${EXTRA_CMAKE_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  EXTRA_CMAKE_ARGS_ARRAY=($EXTRA_CMAKE_ARGS)
fi

# Step 1: Build libcef_dll_wrapper (if not already built)
if [[ ! -f "$CEF_ROOT/build/libcef_dll_wrapper/libcef_dll_wrapper.a" ]]; then
  echo "Building libcef_dll_wrapper..."
  cmake -S "$CEF_ROOT" -B "$CEF_ROOT/build" -DCMAKE_BUILD_TYPE=Release "${EXTRA_CMAKE_ARGS_ARRAY[@]}"
  cmake --build "$CEF_ROOT/build" --config Release --target libcef_dll_wrapper -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
fi

# Step 2: Build Rust core crate
CEF_CORE_DIR="$ROOT/native/cef-core"
echo "Building kitty-cef-core (Rust)..."
(cd "$CEF_CORE_DIR" && cargo build --release)
CEF_CORE_LIB="$CEF_CORE_DIR/target/release/libkitty_cef_core.a"
if [[ ! -f "$CEF_CORE_LIB" ]]; then
  echo "Rust core lib not found at $CEF_CORE_LIB" >&2
  exit 2
fi

# Step 3: Build kitty-cef-helper binary via CMake
BUILD_DIR="$ROOT/native/cef-helper/build"
BINARY="$BUILD_DIR/kitty-cef-helper"
cmake -S "$ROOT/native/cef-helper" -B "$BUILD_DIR" -DCEF_ROOT="$CEF_ROOT" -DCEF_CORE_LIB="$CEF_CORE_LIB" -DCMAKE_BUILD_TYPE=Release

# Older versions of this script replaced the CMake output with a convenience
# shell wrapper. CMake then considered the target up to date on the next build,
# causing that wrapper to be copied into the app bundle as its executable.
if [[ -f "$BINARY" ]] && [[ "$(file -b "$BINARY")" == *"shell script"* ]]; then
  rm -f "$BINARY"
fi
cmake --build "$BUILD_DIR" --config Release --target kitty-cef-helper

# Step 3: Create macOS app bundle (required for CEF ICU data resolution)
APP_DIR="$ROOT/native/cef-helper/${APP_NAME}.app"
APP_CONTENTS="$APP_DIR/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_FRAMEWORKS="$APP_CONTENTS/Frameworks"
APP_RESOURCES="$APP_CONTENTS/Resources"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Frameworks"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy the actual compiled binary (before we overwrite the build output with a wrapper)
cp "$BUILD_DIR/kitty-cef-helper" "$APP_MACOS/$APP_NAME"

# Copy CEF framework into the app bundle
if [[ -d "$CEF_ROOT/Release/Chromium Embedded Framework.framework" ]]; then
  rm -rf "$APP_FRAMEWORKS/Chromium Embedded Framework.framework"
  cp -a "$CEF_ROOT/Release/Chromium Embedded Framework.framework" "$APP_FRAMEWORKS/"
else
  echo "Missing Chromium Embedded Framework.framework under $CEF_ROOT/Release" >&2
  exit 2
fi

# Some CEF distributions still ship extra resources outside the framework.
# Copy them if present; ignore missing paths because macOS CEF often embeds them
# inside Chromium Embedded Framework.framework/Resources.
if [[ -d "$CEF_ROOT/Resources" ]]; then
  rsync -a "$CEF_ROOT/Resources/" "$APP_RESOURCES/"
fi

# Create Info.plist
cat > "$APP_CONTENTS/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>com.kitty-webui.cef-helper</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
PLIST

make_helper_app() {
  local helper_app_name="$1"
  local helper_bundle_id="$2"
  local helper_app="$APP_FRAMEWORKS/${helper_app_name}.app"
  local helper_contents="$helper_app/Contents"
  local helper_macos="$helper_contents/MacOS"
  local helper_frameworks="$helper_contents/Frameworks"

  mkdir -p "$helper_macos" "$helper_frameworks" "$helper_contents/Resources"

  cp "$BUILD_DIR/kitty-cef-helper" "$helper_macos/$helper_app_name"
  chmod +x "$helper_macos/$helper_app_name"

  # Nested helper apps need to resolve the same CEF framework as the main app.
  # Symlink back to the parent app's Contents/Frameworks copy.
  ln -sfn "../../../Chromium Embedded Framework.framework" \
    "$helper_frameworks/Chromium Embedded Framework.framework"

  cat > "$helper_contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${helper_app_name}</string>
  <key>CFBundleIdentifier</key>
  <string>${helper_bundle_id}</string>
  <key>CFBundleName</key>
  <string>${helper_app_name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
PLIST
}

# CEF can use a single explicit browser_subprocess_path, but creating the
# conventional helper variants keeps macOS/Chromium process lookup happy.
make_helper_app "$HELPER_NAME" "$HELPER_BUNDLE_ID"
make_helper_app "${HELPER_NAME} (GPU)" "${HELPER_BUNDLE_ID}.gpu"
make_helper_app "${HELPER_NAME} (Renderer)" "${HELPER_BUNDLE_ID}.renderer"
make_helper_app "${HELPER_NAME} (Plugin)" "${HELPER_BUNDLE_ID}.plugin"

# Clear quarantine and ad-hoc sign the app bundle. Unsigned/quarantined nested
# helper apps are a common cause of renderer/GPU subprocess launch failures.
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true
if command -v codesign >/dev/null 2>&1 && [[ "${KITTY_WEB_UI_SKIP_CODESIGN:-0}" != "1" ]]; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "binary: $BUILD_DIR/kitty-cef-helper"
echo "main app: $APP_DIR"
echo "subprocess: $APP_FRAMEWORKS/$HELPER_NAME.app/Contents/MacOS/$HELPER_NAME"

#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$BRIDGE_DIR/../.." && pwd)"
BUILD_DIR="$BRIDGE_DIR/.build/macos"
DIST_DIR="$BRIDGE_DIR/dist"
VERSION="${BRIDGE_VERSION:-0.1.0}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
APP_NAME="MusicBrainz Explorer Bridge"
APP_PATH="$DIST_DIR/$APP_NAME.app"
SERVICE_NAME="MusicBrainzExplorerBridgeService"
ARCH="$(uname -m)"
DMG_PATH="$DIST_DIR/MusicBrainz-Explorer-Bridge-$VERSION-macOS-$ARCH.dmg"
SIGN_IDENTITY="${CODESIGN_IDENTITY:--}"

rm -rf "$BUILD_DIR" "$APP_PATH" "$DMG_PATH"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

"$PYTHON_BIN" -m venv "$BUILD_DIR/venv"
"$BUILD_DIR/venv/bin/python" -m pip install --quiet --upgrade pip
"$BUILD_DIR/venv/bin/python" -m pip install --quiet "pyinstaller>=6,<7"

PYINSTALLER_ARGS=(
  --noconfirm --clean --onedir --console
  --name "$SERVICE_NAME"
  --distpath "$BUILD_DIR/pyinstaller-dist"
  --workpath "$BUILD_DIR/pyinstaller-work"
  --specpath "$BUILD_DIR"
)
if [[ "$SIGN_IDENTITY" != "-" ]]; then
  PYINSTALLER_ARGS+=(--codesign-identity "$SIGN_IDENTITY")
fi
"$BUILD_DIR/venv/bin/pyinstaller" "${PYINSTALLER_ARGS[@]}" \
  "$BRIDGE_DIR/musicards_upnp_bridge.py"

mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources/bridge"
cp "$SCRIPT_DIR/Info.plist" "$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP_PATH/Contents/Info.plist"
cp -R "$BUILD_DIR/pyinstaller-dist/$SERVICE_NAME/"* "$APP_PATH/Contents/Resources/bridge/"

swiftc -swift-version 5 -framework AppKit \
  -target "${ARCH}-apple-macosx13.0" \
  "$SCRIPT_DIR/main.swift" -o "$APP_PATH/Contents/MacOS/MusicBrainzExplorerBridge"

ICONSET="$BUILD_DIR/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$REPO_DIR/icon.png" \
    --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$REPO_DIR/icon.png" \
    --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP_PATH/Contents/Resources/AppIcon.icns"

if [[ "$SIGN_IDENTITY" == "-" ]]; then
  codesign --force --deep --sign - "$APP_PATH"
else
  codesign --force --deep --options runtime --timestamp \
    --sign "$SIGN_IDENTITY" "$APP_PATH"
fi
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

STAGING_DIR="$BUILD_DIR/dmg"
mkdir -p "$STAGING_DIR"
cp -R "$APP_PATH" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING_DIR" \
  -ov -format UDZO "$DMG_PATH" >/dev/null
if [[ "$SIGN_IDENTITY" != "-" ]]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_PATH"
fi

echo "Built: $DMG_PATH"
echo "Architecture: $ARCH"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  echo "Signing: ad hoc (local testing only)"
else
  echo "Signing: $SIGN_IDENTITY"
fi

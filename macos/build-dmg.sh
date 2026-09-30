#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'Build this DMG on macOS.' >&2; exit 1; }
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
BUILD_DIR="$ROOT/build/macos"
STAGE="$(mktemp -d /tmp/chatgpt-computer-build.XXXXXX)"
cleanup() { [[ "$STAGE" == /tmp/chatgpt-computer-build.* ]] && rm -rf -- "$STAGE"; }
trap cleanup EXIT

cd "$ROOT"
corepack pnpm@11.20.0 install --frozen-lockfile
corepack pnpm@11.20.0 typecheck
corepack pnpm@11.20.0 build
corepack pnpm@11.20.0 exec tsx --test test/config.test.ts test/filesystem-policy.test.ts test/http.test.ts test/stdio.test.ts test/tools.test.ts > "$STAGE/core-tests.log" 2>&1 || { tail -n 80 "$STAGE/core-tests.log"; exit 1; }
node --test macos/*.test.mjs > "$STAGE/mac-tests.log" 2>&1 || { tail -n 80 "$STAGE/mac-tests.log"; exit 1; }
tail -n 8 "$STAGE/core-tests.log"
tail -n 8 "$STAGE/mac-tests.log"
corepack pnpm@11.20.0 --filter @platform-modules/chatgpt-mcp deploy --prod --legacy "$STAGE/deploy"
python3 scripts/install-tunnel.py --destination "$STAGE/tunnel"

mkdir -p "$STAGE/dmg" "$BUILD_DIR"
APP="$STAGE/dmg/ChatGPT Computer.app"
osacompile -o "$APP" "$ROOT/macos/Launcher.applescript"
RUNTIME="$APP/Contents/Resources/runtime"
mkdir -p "$RUNTIME"
cp "$(command -v node)" "$RUNTIME/node"
cp -R "$ROOT/dist" "$RUNTIME/dist"
cp -R "$STAGE/deploy/node_modules" "$RUNTIME/node_modules"
cp "$STAGE/tunnel/tunnel-client" "$RUNTIME/tunnel-client"
cp "$STAGE/tunnel/cloudflared" "$RUNTIME/cloudflared"
cp "$ROOT/macos/manager-core.mjs" "$ROOT/macos/bridge-status.mjs" "$ROOT/macos/manager.mjs" "$ROOT/macos/open-manager.mjs" "$ROOT/macos/manager.html" "$ROOT/macos/run-tunnel.sh" "$RUNTIME/"
cp "$ROOT/LICENSE" "$RUNTIME/LICENSE"
chmod 755 "$RUNTIME/node" "$RUNTIME/tunnel-client" "$RUNTIME/cloudflared" "$RUNTIME/run-tunnel.sh"
codesign --force --deep --sign - "$APP"
ln -s /Applications "$STAGE/dmg/Applications"
hdiutil create -volname 'ChatGPT Computer' -srcfolder "$STAGE/dmg" -format UDZO -ov "$BUILD_DIR/ChatGPT Computer.dmg"
echo "Created $BUILD_DIR/ChatGPT Computer.dmg"

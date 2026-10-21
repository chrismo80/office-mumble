#!/bin/sh
# Build the desktop app for this platform and start it. The app already knows which server it belongs to —
# the address is baked in at build time — so nothing else is needed here, and nothing has to be named:
# app-build asks the same way every app script does.
#
#   OFFICE_MUMBLE_CERT=<file>   optional, instead of asking the server for its certificate
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
STEPS="$HERE/steps"
ROOT=$(cd "$HERE/../.." && pwd)

printf '\n== the desktop app\n'
sh "$STEPS/app-build.sh" --app-only

BIN="$ROOT/client/src-tauri/target/release/office-mumble-shell"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) BIN="$BIN.exe" ;;
esac
if [ ! -x "$BIN" ]; then
  echo "no app at $BIN — the build did not leave one" >&2
  exit 1
fi

printf '\n== the app\n'
case "$(uname -s)" in
  Darwin)
    # The bundle is what macOS expects: an icon in the dock and a real window, not a stray process.
    APP="$ROOT/client/src-tauri/target/release/bundle/macos/office-mumble.app"
    if [ -d "$APP" ]; then
      open "$APP"
      echo "started: $APP"
    else
      nohup "$BIN" >/dev/null 2>&1 &
      echo "started: $BIN"
    fi
    ;;
  *)
    nohup "$BIN" >/dev/null 2>&1 &
    echo "started: $BIN"
    ;;
esac

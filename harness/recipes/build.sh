#!/bin/sh
# Everything this machine can build: the server, the browser client, the harness pages, and the desktop app
# when a server is named. Builds only — nothing is started.
#
#   recipes/build.sh              all of it
#   recipes/build.sh --no-app     all of it except the app, even when a server is named
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
STEPS="$HERE/steps"
APP=1

for arg in "$@"; do
  case "$arg" in
    --no-app) APP=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

printf '\n== the server (release)\n'
sh "$STEPS/server-build.sh"

printf '\n== the browser client\n'
sh "$STEPS/web-build.sh"

printf '\n== the harness pages\n'
sh "$STEPS/sheet-build.sh"

printf '\n== the desktop app\n'
if [ "$APP" -eq 0 ]; then
  echo '  skipped: --no-app'
elif [ -z "${OFFICE_MUMBLE_SERVER:-}" ]; then
  echo '  skipped: no office named — start-app and pack-app ask for one, and build it'
else
  sh "$STEPS/app-build.sh"
fi

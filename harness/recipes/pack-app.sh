#!/bin/sh
# Pack the desktop app for this platform: the browser client first, then the app around it. The office it is
# for is asked the same way every app script asks — no parameter needed.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
STEPS="$HERE/steps"

printf '\n== the browser client\n'
sh "$STEPS/web-build.sh"
printf '\n== the desktop app\n'
sh "$STEPS/app-build.sh"

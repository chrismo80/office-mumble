#!/bin/sh
# Put a freshly built floor in place. The command after changing the server: stop, build, start — in that
# order, so the new binary is what starts.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
STEPS="$HERE/steps"

printf '\n== stopping\n'
sh "$STEPS/server-stop.sh"
printf '\n== the server (release)\n'
sh "$STEPS/server-build.sh"
printf '\n== starting\n'
sh "$STEPS/server-start.sh"

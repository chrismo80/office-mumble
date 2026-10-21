#!/bin/sh
# Build the floor and leave it running — the one command for "make it and let me look". No app, no harness
# pages: the browser is enough to look at it.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
STEPS="$HERE/steps"

printf '\n== the server (release)\n'
sh "$STEPS/server-build.sh"
printf '\n== the browser client\n'
sh "$STEPS/web-build.sh"
printf '\n== the floor\n'
sh "$STEPS/server-start.sh"

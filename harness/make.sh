#!/bin/sh
# Everything this machine can build — a name for recipes/build.sh, which is where the work is described.
#
#   harness/make.sh              the server, the browser client, the harness pages, the desktop app
#   harness/make.sh --no-app     everything except the desktop app
#
# The actions are in harness/recipes/steps, the scenarios in harness/recipes. Run a scenario directly to repeat
# it: recipes/serve.sh, recipes/restart.sh, recipes/pack-app.sh. Nothing here starts or stops a server unless the
# scenario says so.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

case "${1:-}" in
  -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
esac

exec sh "$HERE/recipes/build.sh" "$@"

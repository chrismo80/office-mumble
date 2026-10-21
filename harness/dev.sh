#!/bin/sh
# Start the office on this machine for working on it: the floor rebuilt and restarted, then the app rebuilt and
# started out of the build folder. Nothing is installed — installers come from office.sh, and a dev build has no
# business in /Applications.
#
# Any word goes to the harness runner instead: dev.sh walkers --count 4
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

if [ $# -gt 0 ]; then
  cd "$HERE/.." || exit 1
  exec node harness/run.mjs "$@"
fi

exec sh "$HERE/recipes/local.sh"

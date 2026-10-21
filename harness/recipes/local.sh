#!/bin/sh
# The whole office on this machine, freshly built and running: the floor restarted, then the app rebuilt and
# started against it. The one to run while working on the code and wanting to look at the result.
#
# It is restart plus start-app and nothing of its own — the two know how to do their parts.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

sh "$HERE/restart.sh"
sh "$HERE/start-app.sh"

#!/bin/sh
# The office, ready to hand out — a name for recipes/office.sh, which says what it does.
#
#   harness/office.sh                    this machine is the server: build it, start it, and — on a Mac — build
#                                        the Mac app for it, into handout/
#   harness/office.sh --server <host>    build the Mac app for the server running at <host>
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
exec sh "$HERE/recipes/office.sh" "$@"

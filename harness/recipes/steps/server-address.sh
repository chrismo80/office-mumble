#!/bin/sh
# Which office the app is for. Asked in this order: what the environment says, what was named last time, what
# runs on this machine. The answer is printed on one line, so the scripts above can be run without a parameter.
#
#   OFFICE_MUMBLE_SERVER=<host or host:port>   names it, and is remembered
#
# Only a named office is remembered. This machine's address is worked out anew on every run, because it is the
# one that changes: a new lease from the router, another network, a laptop carried home.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/net.sh"
STATE="$ROOT/.office-mumble"
KEPT="$STATE/server"
PORT=${OFFICE_MUMBLE_PORT:-8787}

server=${OFFICE_MUMBLE_SERVER:-}
if [ -n "$server" ]; then
  mkdir -p "$STATE"
  printf '%s\n' "$server" > "$KEPT"
elif [ -f "$KEPT" ]; then
  server=$(head -n 1 "$KEPT")
else
  # Nothing named: this machine, by its address on the network rather than by localhost. The app carries this
  # address, and localhost would mean "a server on whatever machine I am running on" — true only where the
  # floor lives.
  server="$(lan_ip):$PORT"
  echo "no office named: building for this machine — $server (OFFICE_MUMBLE_SERVER=<host> names another, and is kept)" >&2
fi
printf '%s\n' "$server"

#!/bin/sh
# Whether the floor is up, on which port, and since when.
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/net.sh"
PORT=${OFFICE_MUMBLE_PORT:-8787}
PID_FILE="$ROOT/.office-mumble/server.pid"

pid=$(port_pid "$PORT")
if [ -z "$pid" ]; then
  echo "not listening on $PORT"
  exit 1
fi
echo "listening on https://$(lan_ip):$PORT/"
echo "pid $pid, up since $(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')"
if port_answers "$PORT"; then
  echo 'answering https, certificate served'
else
  echo 'the port is open but it does not answer https yet'
fi

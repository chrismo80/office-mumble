#!/bin/sh
# Stop the floor started by server-start.sh. Falls back to whoever holds the port, so a server started by hand
# is still stopped, and never kills anything but that one process and the processes it started.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/net.sh"
PORT=${OFFICE_MUMBLE_PORT:-8787}
PID_FILE="$ROOT/.office-mumble/server.pid"

pid=''
if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE")
  rm -f "$PID_FILE"
fi
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  pid=$(port_pid "$PORT")
fi
if [ -z "$pid" ]; then
  echo "nothing is listening on $PORT"
  exit 0
fi

# The server's own children go with it: on Linux the kernel ends the demo colleague with the server, on macOS
# nothing does, and it would go on holding the log open and dialling a floor that is gone.
pkill -P "$pid" 2>/dev/null || true
kill "$pid" 2>/dev/null || true
tries=0
while [ "$tries" -lt 50 ] && kill -0 "$pid" 2>/dev/null; do
  sleep 0.1
  tries=$((tries + 1))
done
if kill -0 "$pid" 2>/dev/null; then
  echo "still running after 5 s (pid $pid); not killing it harder" >&2
  exit 1
fi
echo "stopped (pid $pid)"

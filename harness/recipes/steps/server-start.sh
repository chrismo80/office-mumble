#!/bin/sh
# Start the floor in the background: a log and a pid file beside the certificate, and wait until it answers.
# Refuses to start a second one. Settings come from the environment, with the usual defaults:
#   OFFICE_MUMBLE_PORT (8787)  OFFICE_MUMBLE_PLAN (fixtures/floor-t1.json)  OFFICE_MUMBLE_CERT_DIR (.office-mumble)
#   OFFICE_MUMBLE_VOICES_DIR (harness/dummy/public)  OFFICE_MUMBLE_DEMO_VOICE  OFFICE_MUMBLE_DEMO_NAME
#
# The certificate is the server's own business: it issues one when there is none, when the pair cannot work, or
# when it no longer names this machine. When it did, the lines it wrote are repeated here, because they mean
# every app built against the old one has to be built again.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/net.sh"
PORT=${OFFICE_MUMBLE_PORT:-8787}
STATE="$ROOT/.office-mumble"
PID_FILE="$STATE/server.pid"
LOG="$STATE/server.log"
mkdir -p "$STATE"

# Asked of the port, not of the pid file: a floor started by hand or by run.mjs has none, and a second one would
# fail to bind while the first answered for it.
if port_answers "$PORT"; then
  pid=$(port_pid "$PORT")
  echo "already running on port $PORT${pid:+, pid $pid}"
  exit 0
fi
holder=$(port_pid "$PORT")
if [ -n "$holder" ]; then
  echo "port $PORT is held by pid $holder, which does not answer https — not starting a second one" >&2
  exit 1
fi

before=0
if [ -f "$LOG" ]; then
  before=$(wc -c < "$LOG")
fi
cd "$ROOT"
OFFICE_MUMBLE_PORT="$PORT" \
OFFICE_MUMBLE_PLAN="${OFFICE_MUMBLE_PLAN:-fixtures/floor-t1.json}" \
OFFICE_MUMBLE_CERT_DIR="${OFFICE_MUMBLE_CERT_DIR:-.office-mumble}" \
OFFICE_MUMBLE_VOICES_DIR="${OFFICE_MUMBLE_VOICES_DIR:-harness/dummy/public}" \
nohup ./target/release/office-mumble-server >> "$LOG" 2>&1 &
echo $! > "$PID_FILE"

tries=0
while [ "$tries" -lt 100 ]; do
  if port_answers "$PORT"; then
    tail -c "+$((before + 1))" "$LOG" | grep -E 'issued a certificate|refuses this server' >&2 || true
    echo "listening on https://$(lan_ip):$PORT/ — log $LOG"
    exit 0
  fi
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "it stopped before listening; the last lines of $LOG:" >&2
    tail -n 20 "$LOG" >&2
    exit 1
  fi
  sleep 0.2
  tries=$((tries + 1))
done
echo "it is running but not listening on $PORT after 20 s; see $LOG" >&2
exit 1

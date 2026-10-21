#!/bin/sh
# A new certificate, on purpose. The server issues one by itself when the pair cannot work or no longer names this
# machine; this is for every other reason. It removes the pair, and the floor issues a new one when it starts.
# Every app built against the old one refuses the floor until it is built again, and every browser asks once more.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/net.sh"
PORT=${OFFICE_MUMBLE_PORT:-8787}
DIR=${OFFICE_MUMBLE_CERT_DIR:-.office-mumble}
case "$DIR" in
  /*) ;;
  *) DIR="$ROOT/$DIR" ;;
esac

rm -f "$DIR/cert.pem" "$DIR/key.pem"
echo "certificate: removed from $DIR — the floor issues a new one when it starts"
# Any HTTPS answer, not /cert.pem: the floor reads that file from disk on every request, and it was just removed.
if curl -ks --max-time 2 -o /dev/null "https://127.0.0.1:$PORT/"; then
  echo "  the floor on $PORT still uses the old one until it is restarted: recipes/restart.sh"
fi

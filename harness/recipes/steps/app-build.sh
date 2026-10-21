#!/bin/sh
# Pack the desktop app for this platform. Tauri does not cross-compile: a Linux machine packs the Linux app.
#
# The office it is for comes from server-address.sh — the environment, or what was named last time, or this
# machine. No parameter needed. The app pins that server's certificate, so it is fetched first.
#   OFFICE_MUMBLE_CERT=<file>   optional, instead of asking the server
#
# --app-only builds the app and no installer: for a dev build the installer is minutes of work nobody asked for.
# On macOS that is the .app bundle, which start-app opens; elsewhere it is the bare executable.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/net.sh"

bundles=''
if [ "${1:-}" = '--app-only' ]; then
  case "$(uname -s)" in
    Darwin) bundles='--bundles app' ;;
    *) bundles='--no-bundle' ;;
  esac
fi

server=$(sh "$HERE/server-address.sh")

bare=${server#*://}
bare=${bare%%/*}
case "$bare" in
  *:*) host=${bare%:*}; port=${bare##*:} ;;
  *) host=$bare; port=8787 ;;
esac

# Whether the office is this machine: then its own certificate is the right one even with the floor stopped.
this_machine=''
me=$(hostname 2>/dev/null || true)
wanted=$(printf '%s' "$host" | tr 'A-Z' 'a-z')
for name in localhost 127.0.0.1 "$(lan_ip)" "$me" "$me.local"; do
  if [ "$wanted" = "$(printf '%s' "$name" | tr 'A-Z' 'a-z')" ]; then
    this_machine=1
  fi
done

# What the app pins is written to pinned.pem, never to cert.pem: on a machine that hosts a server, cert.pem is
# one half of the pair with key.pem, and replacing it would leave that server unable to start. build.rs reads
# pinned.pem first and cert.pem second.
mkdir -p "$ROOT/.office-mumble"
PINNED="$ROOT/.office-mumble/pinned.pem"
if [ -n "${OFFICE_MUMBLE_CERT:-}" ]; then
  echo "certificate: using OFFICE_MUMBLE_CERT=$OFFICE_MUMBLE_CERT, as given"
elif curl -kfsS --max-time 15 "https://$host:$port/cert.pem" -o "$PINNED.tmp"; then
  mv "$PINNED.tmp" "$PINNED"
  echo "certificate: fetched from $host:$port into pinned.pem"
elif [ -n "$this_machine" ] && [ -f "$ROOT/.office-mumble/cert.pem" ]; then
  # The office is this machine and its floor is not running: its own certificate is the one to pin. A pinned one
  # left from another house is removed, or build.rs would read it first.
  rm -f "$PINNED" "$PINNED.tmp"
  echo "certificate: $host:$port is this machine, not running — pinning its own certificate"
elif [ -f "$PINNED" ]; then
  rm -f "$PINNED.tmp"
  echo "certificate: $host:$port unreachable — using the one already pinned"
  echo '  if the server issued a new one, the app will refuse it'
else
  rm -f "$PINNED.tmp"
  echo "certificate: none for $host:$port — start that server once, or set OFFICE_MUMBLE_CERT" >&2
  exit 1
fi

# An app built for localhost reaches a server on the machine it runs on, and nowhere else: the address is baked
# in. That is right for a dev build and wrong for a colleague, so it is said rather than discovered later.
case "$bare" in
  localhost*|127.0.0.1*)
    echo "note: built for $server — this app only reaches a server on the machine it runs on."
    echo "      for a colleague's machine, build with OFFICE_MUMBLE_SERVER=$(lan_ip):$port"
    ;;
esac

cd "$ROOT/client"
# shellcheck disable=SC2086
OFFICE_MUMBLE_SERVER="$server" cargo tauri build $bundles
case "$bundles" in
  --no-bundle) echo "built for $server: client/src-tauri/target/release/office-mumble-shell" ;;
  *) echo "packed for $server: client/src-tauri/target/release/bundle" ;;
esac

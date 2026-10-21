#!/bin/sh
# The office, ready to hand out. Run it on the machine that is to be the server, or on any Mac when the server
# already runs somewhere else:
#
#   harness/office.sh                    this machine is the server: build it, start it, and — on a Mac — build
#                                        the Mac app for it
#   harness/office.sh --server <host>    build the Mac app for the server at <host> (or <host:port>), with the
#                                        certificate it shows. When <host> is this machine — its address or its
#                                        name — the server is built and started here too, and the app carries
#                                        that name instead of the address.
#
# The disk image lands in handout/. The app in it knows the server's address and trusts exactly its
# certificate: a colleague opens the image, drags the app to Applications and starts it. Tauri builds the app
# of the platform it runs on, so this makes the Mac one; office.cmd on Windows makes the Windows one, the same
# way. A Linux machine can be the server, and builds no app: the apps come from a Mac or a Windows machine
# pointed at it with --server.
#
# Built is what is checked out. This script does not pull: what goes out to colleagues is decided by whoever
# runs it, not by whatever the remote holds at that moment.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
STEPS="$HERE/steps"
product=office-mumble

usage() { sed -n '2,19p' "$0"; }
step() { printf '\n-- %s\n' "$*"; }
fail() { echo "  $*" >&2; exit 1; }

server=''
while [ $# -gt 0 ]; do
  case "$1" in
    --server) [ $# -ge 2 ] || { usage; exit 2; }; server=$2; shift 2 ;;
    --server=*) server=${1#--server=}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

system=$(uname -s)
case "$system" in
  Darwin|Linux) ;;
  *) fail "this is $system: on Windows the script is harness\\office.cmd" ;;
esac

# ── what the build needs ────────────────────────────────────────────────────────────────────────────────────
# Installed here on a Mac, where there is one way to do it. On Linux the package manager differs from machine to
# machine, so what is missing is named instead.
step "what this machine has"
node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p 'process.versions.node.split(".")[0]'
}
if [ "$system" = Darwin ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "  Xcode's command line tools are missing; asking macOS to install them"
    xcode-select --install || true
    fail "a dialog has opened — when it has finished, run this script again"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "  Rust is missing; installing it with rustup (once per machine)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
  if ! major=$(node_major) || [ "$major" -lt 22 ]; then
    echo "  Node 22 or newer is missing; installing it with Homebrew"
    command -v brew >/dev/null 2>&1 || fail "no Homebrew here either: install Node from https://nodejs.org and run this script again"
    if command -v node >/dev/null 2>&1; then brew upgrade node; else brew install node; fi
  fi
  if ! command -v corepack >/dev/null 2>&1; then
    echo "  corepack is missing; installing it with npm"
    npm install -g corepack
  fi
  if ! cargo tauri --version >/dev/null 2>&1; then
    echo "  the Tauri command line is missing; building it (a few minutes, once per machine)"
    cargo install tauri-cli --version "^2" --locked
  fi
  echo "  node $(node -v) · $(cargo -V) · $(cargo tauri --version)"
else
  missing=''
  command -v cargo >/dev/null 2>&1 || missing="$missing Rust (https://rustup.rs),"
  if ! major=$(node_major) || [ "$major" -lt 22 ]; then missing="$missing Node 22 or newer,"; fi
  command -v corepack >/dev/null 2>&1 || missing="$missing corepack (npm install -g corepack),"
  command -v curl >/dev/null 2>&1 || missing="$missing curl,"
  [ -z "$missing" ] || fail "missing:${missing%,} — install them and run this script again"
  echo "  node $(node -v) · $(cargo -V)"
fi

# ── which server ────────────────────────────────────────────────────────────────────────────────────────────
step "the server"
lan=$(node "$STEPS/lan-address.mjs" 2>/dev/null || true)
default_port=${OFFICE_MUMBLE_PORT:-8787}
if [ -z "$server" ]; then
  [ -n "$lan" ] || fail "this machine has no address on a network; name the server with --server <host>"
  server="$lan:$default_port"
fi

# The address may be written the way somebody says it — a host, a host and a port, or a URL as a browser shows it.
address=${server#*://}
address=${address%%/*}
case "$address" in
  *:*) host=${address%%:*}; port=${address##*:} ;;
  *) host=$address; port=$default_port ;;
esac
server="$host:$port"
case "$host" in
  localhost|127.0.0.1|::1|'')
    fail "an app built for '$host' reaches a server on the colleague's own machine, not this one — name this machine by its address or its name" ;;
esac
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
is_here=''
short=$(hostname -s 2>/dev/null || hostname)
for name in "$lan" "$(hostname)" "$short" "$short.local"; do
  if [ -n "$name" ] && [ "$(lower "$host")" = "$(lower "$name")" ]; then
    is_here=1
  fi
done
if [ -n "$is_here" ]; then
  echo "  $server — this machine: the server is built and started here"
else
  echo "  $server — another machine, which has to be running"
  [ "$system" = Darwin ] || fail "Linux builds no app to hand out: run harness/office.sh on a Mac, or harness\\office.cmd on Windows, with --server $server"
fi

# ── the server, when it is this machine ─────────────────────────────────────────────────────────────────────
# The browser client is built either way: the server hands it out, and the app is built around it.
step "the browser client"
sh "$STEPS/web-build.sh"

if [ -n "$is_here" ]; then
  # Stopped, built and started again, so what runs is what was just built. The certificate is the server's own
  # business: it is issued for this machine on the first start, and anew when it no longer names it.
  step "the server, built and started here"
  export OFFICE_MUMBLE_PORT="$port"
  sh "$STEPS/server-stop.sh"
  sh "$STEPS/server-build.sh"
  sh "$STEPS/server-start.sh"
fi

if [ "$system" != Darwin ]; then
  step "the apps"
  echo "  Linux builds none. For the colleagues' apps, on a Mac:   harness/office.sh --server $server"
  echo "                                       on Windows:          harness\\office.cmd -Server $server"
  exit 0
fi

# ── the certificate the app pins ────────────────────────────────────────────────────────────────────────────
# Always asked of the running server, never taken from a file: the app refuses every certificate but the one it
# was built with, so it has to be the one this server shows now. It lands in pinned.pem — never in cert.pem,
# which on a server machine is half of its own pair.
step "the certificate"
mkdir -p "$ROOT/.office-mumble"
pinned="$ROOT/.office-mumble/pinned.pem"
if ! curl -kfsS --max-time 20 "https://$host:$port/cert.pem" -o "$pinned.tmp"; then
  rm -f "$pinned.tmp"
  fail "$host:$port did not answer — start the server there first; an app built without its certificate cannot connect to it"
fi
mv "$pinned.tmp" "$pinned"
fingerprint=$(openssl x509 -in "$pinned" -noout -fingerprint -sha256 | cut -d= -f2)
echo "  fetched from https://$host:$port/cert.pem"
echo "  $fingerprint"

# ── the app and its disk image ──────────────────────────────────────────────────────────────────────────────
step "the app"
cd "$ROOT/client"
OFFICE_MUMBLE_SERVER="$server" OFFICE_MUMBLE_CERT="$pinned" cargo tauri build --bundles dmg

# ── what the build actually put in the app ──────────────────────────────────────────────────────────────────
# The two ways a build can be wrong both show only later, on a colleague's machine: the server shows another
# certificate than the one the app was built with, or the app dials another address. So the app that came out is
# read back before anything is handed on.
step "what the app was built with"
app="$ROOT/client/src-tauri/target/release/bundle/macos/$product.app"
[ -d "$app" ] || fail "no app at $app — the build stopped before bundling; see what it said above"
binary=$(find "$app/Contents/MacOS" -type f -perm -111 | head -n 1)
[ -n "$binary" ] || fail "no executable under $app/Contents/MacOS"
# The binary is not text, so the certificate is taken out by byte offset and never by line: under a UTF-8 locale
# BSD sed stops at the first byte that is not valid UTF-8, and a line would carry the binary's bytes around it.
inside=$(mktemp)
start=$(LC_ALL=C grep -abo -m1 -- "-----BEGIN CERTIFICATE-----" "$binary" 2>/dev/null | cut -d: -f1 || true)
end=$(LC_ALL=C grep -abo -m1 -- "-----END CERTIFICATE-----" "$binary" 2>/dev/null | cut -d: -f1 || true)
if [ -n "$start" ] && [ -n "$end" ] && [ "$end" -gt "$start" ]; then
  tail -c "+$((start + 1))" "$binary" | head -c "$((end - start + 25))" > "$inside"
fi
inside_fp=$(openssl x509 -in "$inside" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true)
rm -f "$inside"
[ "$inside_fp" = "$fingerprint" ] || fail "the app carries ${inside_fp:-no certificate}, not the certificate of $host:$port ($fingerprint) — nothing is handed out"
echo "  the server's certificate, $fingerprint"
LC_ALL=C grep -aq "wss://$host" "$binary" 2>/dev/null || fail "the app does not carry the address $host — nothing is handed out"
echo "  the address, wss://$host:$port/ws"

# ── to hand out ─────────────────────────────────────────────────────────────────────────────────────────────
step "to hand out"
dmg=$(ls -t "$ROOT/client/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null | head -n 1 || true)
[ -n "$dmg" ] || fail "no disk image under client/src-tauri/target/release/bundle/dmg"
mkdir -p "$ROOT/handout"
# One image per platform: an older one beside it would be the one somebody sends by mistake.
rm -f "$ROOT/handout/"*.dmg
cp "$dmg" "$ROOT/handout/"
echo "  $ROOT/handout/$(basename "$dmg")"
echo "  for $server, certificate $fingerprint"
echo "  it is not signed: macOS asks once before opening it, and once before it may reach the local network —"
echo "  docs/setup.md says what a colleague does."

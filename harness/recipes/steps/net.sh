#!/bin/sh
# The three questions about the network, asked without assuming which tools this is. macOS has lsof and no ss;
# Debian has ss and often no lsof. Sourced by the steps beside it, not run on its own.
NET_HERE=$(cd "$(dirname "$0")" && pwd)

# Which process holds a port, if any.
port_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep ":$1 " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1
  fi
}

# Whether a floor is serving there. curl asks the better question than any socket listing: not "is the port
# taken" but "does it answer HTTPS with a certificate" — which is what a client needs.
port_answers() {
  curl -kfsS --max-time 2 "https://127.0.0.1:$1/cert.pem" >/dev/null 2>&1
}

# This machine's address on the local network, by the rule the server's certificate uses (lan-address.mjs).
# Without a network: 127.0.0.1.
lan_ip() {
  node "$NET_HERE/lan-address.mjs" 2>/dev/null || echo 127.0.0.1
}

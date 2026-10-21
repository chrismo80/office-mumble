#!/bin/sh
# Build the floor server, release. Builds only; see server-start.sh to run it.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
cargo build --release -p office-mumble-server --manifest-path "$ROOT/Cargo.toml"

#!/bin/sh
# Build the art sheet into harness/dist, which the server hands out at /dummy/. Separate from the client:
# nothing here ends up in client/dist and nothing of the client depends on it.
#
# vite comes from the client's node_modules, so this runs inside client/ — which is also where corepack has to
# be asked, for the reason in web-build.sh. The config path is absolute, so it is found from there.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$ROOT/client"
corepack pnpm exec vite build --config "$ROOT/harness/vite.config.mjs" "$@"

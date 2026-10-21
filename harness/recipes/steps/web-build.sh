#!/bin/sh
# Build the browser client: dependencies if they are missing, then the type check and the bundle.
#
# corepack is asked from inside client/: it picks the pnpm version from the package.json of the folder it runs
# in, and the repository root has none — from there it fetches the newest pnpm, which refuses the version the
# client names. pnpm --dir would not help, because corepack has chosen before pnpm reads it.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
# Without this, corepack stops to ask before it fetches pnpm the first time, and nobody sees the question.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$ROOT/client"
if [ ! -d node_modules ]; then
  corepack pnpm install --frozen-lockfile
fi
corepack pnpm build

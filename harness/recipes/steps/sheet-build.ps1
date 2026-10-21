# Build the art sheet into harness/dist, which the server hands out at /dummy/. Separate from the client:
# nothing here ends up in client/dist.
#
# vite comes from the client's node_modules, so this runs inside client\ — which is also where corepack has to
# be asked, for the reason in web-build.ps1. The config path is absolute, so it is found from there.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
Push-Location (Join-Path $root 'client')
try {
    & corepack pnpm exec vite build --config (Join-Path $root 'harness\vite.config.mjs') @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $code

# Build the browser client: dependencies if they are missing, then the type check and the bundle.
#
# corepack is asked from inside client\: it picks the pnpm version from the package.json of the folder it runs
# in, and the repository root has none — from there it fetches the newest pnpm, which refuses the version the
# client names. pnpm --dir would not help, because corepack has chosen before pnpm reads it.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
# Without this, corepack stops to ask before it fetches pnpm the first time, and nobody sees the question.
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
Push-Location (Join-Path $root 'client')
try {
    if (-not (Test-Path 'node_modules')) {
        & corepack pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & corepack pnpm build
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $code

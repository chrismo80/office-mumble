# Build the floor and leave it running — the one command for "make it and let me look". No app, no harness
# pages: the browser is enough to look at it.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$steps = Join-Path $here 'steps'

Write-Host ''
Write-Host '== the server (release)' -ForegroundColor Cyan
& (Join-Path $steps 'server-build.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '== the browser client' -ForegroundColor Cyan
& (Join-Path $steps 'web-build.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '== the floor' -ForegroundColor Cyan
& (Join-Path $steps 'server-start.ps1')
exit $LASTEXITCODE

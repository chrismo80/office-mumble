# Put a freshly built floor in place. The command after changing the server: stop, build, start — in that
# order, so the new binary is what starts.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$steps = Join-Path $here 'steps'

Write-Host ''
Write-Host '== stopping' -ForegroundColor Cyan
& (Join-Path $steps 'server-stop.ps1')
# A floor still running holds the executable open, and the build would fail on it with less to say.
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '== the server (release)' -ForegroundColor Cyan
& (Join-Path $steps 'server-build.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '== starting' -ForegroundColor Cyan
& (Join-Path $steps 'server-start.ps1')
exit $LASTEXITCODE

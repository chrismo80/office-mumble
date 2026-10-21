# Pack the desktop app for this platform: the browser client first, then the app around it. The office it is
# for is asked the same way every app script asks — no parameter needed.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$steps = Join-Path $here 'steps'

Write-Host ''
Write-Host '== the browser client' -ForegroundColor Cyan
& (Join-Path $steps 'web-build.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '== the desktop app' -ForegroundColor Cyan
& (Join-Path $steps 'app-build.ps1')
exit $LASTEXITCODE

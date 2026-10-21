# Everything this machine can build: the server, the browser client, the harness pages, and the desktop app
# when a server is named. Builds only — nothing is started.
#
#   recipes\build.ps1              all of it
#   recipes\build.ps1 -NoApp       all of it except the app, even when a server is named
[CmdletBinding()]
param([switch]$NoApp)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$steps = Join-Path $here 'steps'

foreach ($step in @(@('server-build', 'the server (release)'), @('web-build', 'the browser client'), @('sheet-build', 'the harness pages'))) {
    Write-Host ''
    Write-Host "== $($step[1])" -ForegroundColor Cyan
    & (Join-Path $steps "$($step[0]).ps1")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ''
Write-Host '== the desktop app' -ForegroundColor Cyan
if ($NoApp) {
    Write-Host '  skipped: -NoApp'
} elseif ([string]::IsNullOrWhiteSpace($env:OFFICE_MUMBLE_SERVER)) {
    Write-Host '  skipped: no office named — start-app and pack-app ask for one, and build it'
} else {
    & (Join-Path $steps 'app-build.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
# Every script here ends with an exit: a caller reads $LASTEXITCODE, and a script that ends without one leaves
# whatever the last program before it said — nothing at all in a fresh PowerShell, which reads as a failure.
exit 0

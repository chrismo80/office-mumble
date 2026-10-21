# Build the desktop app for this platform and start it. The app already knows which server it belongs to —
# the address is baked in at build time — so nothing else is needed here, and nothing has to be named.
#
#   OFFICE_MUMBLE_CERT=<file>   optional, instead of asking the server for its certificate
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$steps = Join-Path $here 'steps'
$root = Split-Path -Parent (Split-Path -Parent $here)

Write-Host ''
Write-Host '== the desktop app' -ForegroundColor Cyan
& (Join-Path $steps 'app-build.ps1') -AppOnly
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Join-Path $root 'client\src-tauri\target\release\office-mumble-shell.exe'
if (-not (Test-Path $exe)) {
    Write-Host "no app at $exe — the build did not leave one" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '== the app' -ForegroundColor Cyan
Start-Process -FilePath $exe | Out-Null
Write-Host "started: $exe"
exit 0

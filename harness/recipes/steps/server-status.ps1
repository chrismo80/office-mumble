# Whether the floor is up, on which port, and since when.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    Write-Host 'this needs Windows: Get-NetTCPConnection is not here'
    exit 1
}
$port = if ($env:OFFICE_MUMBLE_PORT) { $env:OFFICE_MUMBLE_PORT } else { '8787' }

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listening) {
    Write-Host "not listening on $port"
    exit 1
}
$processId = $listening.OwningProcess
$proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
Write-Host "listening on https://localhost:$port/"
if ($proc) { Write-Host "pid $processId, up since $($proc.StartTime)" }
# curl.exe, as server-start.ps1 asks: Invoke-WebRequest has no way to skip the certificate check in Windows
# PowerShell 5.1, so it would call every floor silent.
if (Get-Command curl.exe -ErrorAction SilentlyContinue) { $curl = 'curl.exe' } else { $curl = 'curl' }
& $curl -kfsS --max-time 5 "https://127.0.0.1:$port/cert.pem" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host 'answering https, certificate served'
} else {
    Write-Host 'the port is open but it does not answer https yet'
}
exit 0

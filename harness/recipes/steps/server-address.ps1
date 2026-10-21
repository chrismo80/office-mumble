# Which office the app is for. Asked in this order: what the environment says, what was named last time, what
# runs on this machine. The answer is printed on one line, so the scripts above can be run without a parameter.
#
#   OFFICE_MUMBLE_SERVER=<host or host:port>   names it, and is remembered
#
# Only a named office is remembered. This machine's address is worked out anew on every run, because it is the
# one that changes: a new lease from the router, another network, a laptop carried home.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$state = Join-Path $root '.office-mumble'
$kept = Join-Path $state 'server'
$port = if ($env:OFFICE_MUMBLE_PORT) { $env:OFFICE_MUMBLE_PORT } else { '8787' }

$server = $env:OFFICE_MUMBLE_SERVER
if (-not [string]::IsNullOrWhiteSpace($server)) {
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    $server | Set-Content $kept
} elseif (Test-Path $kept) {
    $server = (Get-Content $kept -TotalCount 1)
} else {
    # Nothing named: this machine, by its address on the network rather than by localhost, worked out by the rule
    # the server's certificate uses. The app carries this address, and localhost would only reach a floor on the
    # machine the app happens to run on.
    $lan = & node (Join-Path $here 'lan-address.mjs') 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $lan) { $lan = '127.0.0.1' }
    $server = "${lan}:$port"
    Write-Host "no office named: building for this machine — $server (OFFICE_MUMBLE_SERVER=<host> names another, and is kept)" -ForegroundColor Yellow
}
Write-Output $server
exit 0

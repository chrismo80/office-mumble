# Pack the desktop app for this platform. Tauri does not cross-compile: a Windows machine packs the Windows app.
#
# The office it is for comes from server-address.ps1 — the environment, or what was named last time, or this
# machine. No parameter needed. The app pins that server's certificate, so it is fetched first.
#   OFFICE_MUMBLE_CERT=<file>   optional, instead of asking the server
#
# -AppOnly builds the executable and no installer: for a dev build the MSI and NSIS installers are minutes of
# work nobody asked for.
[CmdletBinding()]
param([switch]$AppOnly)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$clientDir = Join-Path $root 'client'
if (Get-Command curl.exe -ErrorAction SilentlyContinue) { $curl = 'curl.exe' } else { $curl = 'curl' }

$bundles = @()
if ($AppOnly) { $bundles = @('--no-bundle') }

$server = & (Join-Path $here 'server-address.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$bare = ($server -replace '^[a-zA-Z]+://', '') -split '/' | Select-Object -First 1
if ($bare -match ':') {
    $hostName = ($bare -split ':')[0]
    $port = ($bare -split ':')[1]
} else {
    $hostName = $bare
    $port = '8787'
}

# Whether the office is this machine: then its own certificate is the right one even with the floor stopped.
$lan = & node (Join-Path $here 'lan-address.mjs') 2>$null
$me = $env:COMPUTERNAME
$thisMachine = @('localhost', '127.0.0.1', $lan, $me, "$me.local") -contains $hostName

New-Item -ItemType Directory -Force -Path (Join-Path $root '.office-mumble') | Out-Null
# What the app pins is written to pinned.pem, never to cert.pem: on a machine that hosts a server, cert.pem is
# one half of the pair with key.pem, and replacing it would leave that server unable to start. build.rs reads
# pinned.pem first and cert.pem second.
$certFile = Join-Path $root '.office-mumble\pinned.pem'
$ownCert = Join-Path $root '.office-mumble\cert.pem'
$tmp = "$certFile.tmp"
if (-not [string]::IsNullOrWhiteSpace($env:OFFICE_MUMBLE_CERT)) {
    Write-Host "certificate: using OFFICE_MUMBLE_CERT=$($env:OFFICE_MUMBLE_CERT), as given"
} else {
    & $curl -kfsS --max-time 15 "https://${hostName}:${port}/cert.pem" -o $tmp
    if ($LASTEXITCODE -eq 0) {
        Move-Item -Force -LiteralPath $tmp -Destination $certFile
        Write-Host "certificate: fetched from ${hostName}:${port} into pinned.pem"
    } elseif ($thisMachine -and (Test-Path $ownCert)) {
        # The office is this machine and its floor is not running: its own certificate is the one to pin. A
        # pinned one left from another house is removed, or build.rs would read it first.
        Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $certFile, $tmp
        Write-Host "certificate: ${hostName}:${port} is this machine, not running — pinning its own certificate"
    } elseif (Test-Path $certFile) {
        Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $tmp
        Write-Host "certificate: ${hostName}:${port} unreachable — using the one already pinned"
        Write-Host '  if the server issued a new one, the app will refuse it'
    } else {
        Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $tmp
        Write-Host "certificate: none for ${hostName}:${port} — start that server once, or set OFFICE_MUMBLE_CERT" -ForegroundColor Red
        exit 1
    }
}

# An app built for localhost reaches a server on the machine it runs on, and nowhere else: the address is baked in.
if ($server -match '^(localhost|127\.0\.0\.1)') {
    Write-Host "note: built for ${server} — this app only reaches a server on the machine it runs on."
    Write-Host "      for a colleague's machine, build with OFFICE_MUMBLE_SERVER=<this machine's LAN address>:$port"
}

# The environment is put back afterwards: run from an open PowerShell, a worked-out address left in it would be
# taken for a named one by the next run, and remembered.
$named = $env:OFFICE_MUMBLE_SERVER
Push-Location $clientDir
try {
    $env:OFFICE_MUMBLE_SERVER = $server
    & cargo tauri build @bundles
    $code = $LASTEXITCODE
} finally {
    $env:OFFICE_MUMBLE_SERVER = $named
    Pop-Location
}
if ($code -eq 0 -and $AppOnly) { Write-Host "built for ${server}: client/src-tauri/target/release/office-mumble-shell.exe" }
elseif ($code -eq 0) { Write-Host "packed for ${server}: client/src-tauri/target/release/bundle" }
exit $code

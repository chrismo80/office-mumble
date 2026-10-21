# The office, ready to hand out. Run it on the machine that is to be the server, or on any Windows machine when
# the server already runs somewhere else:
#
#   harness\office.cmd                  this machine is the server: build it, start it, and build the Windows
#                                       installer for it
#   harness\office.cmd -Server <host>   build the Windows installer for the server at <host> (or <host:port>),
#                                       with the certificate it shows. When <host> is this machine — its address
#                                       or its name — the server is built and started here too, and the app
#                                       carries that name instead of the address.
#
# The installer lands in handout\. It installs for one user, without administrator rights, and the app in it
# knows the server's address and trusts exactly its certificate: a colleague installs it and starts it, and
# nothing else. Tauri builds the installer of the platform it runs on, so this makes the Windows one; harness/office.sh
# on a Mac makes the Mac one, the same way.
#
# Built is what is checked out. This script does not pull: what goes out to colleagues is decided by whoever
# runs it, not by whatever the remote holds at that moment.
[CmdletBinding()]
param([string]$Server)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$steps = Join-Path $PSScriptRoot 'steps'
$product = 'office-mumble'

#region helpers

function Step {
    param([string]$What)
    Write-Host ''
    Write-Host "-- $What" -ForegroundColor Cyan
}

function Fail {
    param([string]$Why)
    Write-Host "  $Why" -ForegroundColor Red
    exit 1
}

function Have {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

# A program installed by winget is not on this session's PATH until it is read again.
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
    $cargo = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path $cargo) { $env:Path = "$env:Path;$cargo" }
}

function Install-WithWinget {
    param([string]$Id, [string]$Why)
    if (-not (Have winget)) { Fail "$Why, and winget is not here to install it: get it from https://aka.ms/winget and run this script again" }
    Write-Host "  $Why; installing it with winget (once per machine)"
    winget install --id $Id --exact --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
}

# The certificate's SHA-256, written the way `openssl x509 -noout -fingerprint -sha256` writes it, so the line
# here and the same command on the server can be held next to each other.
function Get-CertificateFingerprint {
    param([string]$Path)
    $parts = [regex]::Split((Get-Content -LiteralPath $Path -Raw), '-----(?:BEGIN|END) CERTIFICATE-----')
    if ($parts.Count -lt 2) { return '' }
    $der = [Convert]::FromBase64String(($parts[1] -replace '\s', ''))
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
    (($hash | ForEach-Object { $_.ToString('X2') }) -join ':')
}

# Bytes as text without moving any of them, so searching the text is searching the bytes. Latin-1 maps every
# byte to one character.
function Get-ContentsOfFile {
    param([string]$Path)
    [System.Text.Encoding]::GetEncoding(28591).GetString([System.IO.File]::ReadAllBytes($Path))
}

# A step of the recipes, run in this process; a failure ends this script with the step's own code.
function Invoke-Step {
    param([string]$Name)
    & (Join-Path $steps "$Name.ps1")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

#endregion

# ── what the build needs, installed here rather than asked for ───────────────────────────────────────────────
Step 'what this machine has'

$nodeMajor = 0
if (Have node) { $nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0]) }
if ($nodeMajor -lt 22) {
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node 22 or newer is missing'
    if (-not (Have node)) { Fail 'Node is installed but not on this session''s PATH — open a new terminal and run this script again' }
}
if (-not (Have corepack)) {
    Write-Host '  corepack is missing; installing it with npm'
    npm install --global corepack
}

# Building the app needs a C++ linker. winget can start that install, but it is a large one and wants a new
# terminal afterwards, so it is named rather than run from here.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$buildTools = $false
if (Test-Path $vswhere) {
    $found = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $buildTools = -not [string]::IsNullOrWhiteSpace($found)
}
if (-not $buildTools) {
    Write-Host '  the C++ build tools are missing; Rust needs them to link. In an administrator terminal, then run this script again:' -ForegroundColor Red
    Write-Host '    winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
    exit 1
}

if (-not (Have cargo)) {
    Install-WithWinget 'Rustlang.Rustup' 'Rust is missing'
    if (-not (Have cargo)) { Fail 'Rust is installed but not on this session''s PATH — open a new terminal and run this script again' }
}
if (-not (Have curl.exe)) { Fail 'curl.exe is missing; it ships with Windows 10 1803 and later, and is how the certificate is fetched' }

$tauri = cargo tauri --version 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host '  the Tauri command line is missing; building it (a few minutes, once per machine)'
    cargo install tauri-cli --version '^2' --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $tauri = cargo tauri --version
}
Write-Host "  node $(node --version) · $(cargo --version) · $tauri"

# ── which server ────────────────────────────────────────────────────────────────────────────────────────────
Step 'the server'
$lan = & node (Join-Path $steps 'lan-address.mjs') 2>$null
$defaultPort = if ($env:OFFICE_MUMBLE_PORT) { $env:OFFICE_MUMBLE_PORT } else { '8787' }
if ([string]::IsNullOrWhiteSpace($Server)) {
    if (-not $lan) { Fail 'this machine has no address on a network; name the server with -Server <host>' }
    $Server = "${lan}:$defaultPort"
}

# The address may be written the way somebody says it — a host, a host and a port, or a URL as a browser shows
# it. ($host is PowerShell's own name, hence officeHost.)
$address = (($Server -replace '^[a-zA-Z][a-zA-Z0-9+.-]*://', '') -split '/')[0]
if ($address.Contains(':')) {
    $officeHost = ($address -split ':', 2)[0]
    $port = ($address -split ':', 2)[1]
} else {
    $officeHost = $address
    $port = $defaultPort
}
$Server = "${officeHost}:$port"
if (@('localhost', '127.0.0.1', '::1') -contains $officeHost) {
    Fail "an app built for $officeHost reaches a server on the colleague's own machine, not this one — name this machine by its address or its name"
}
$me = $env:COMPUTERNAME
$isHere = @($lan, $me, "$me.local") -contains $officeHost
if ($isHere) { Write-Host "  $Server — this machine: the server is built and started here" }
else { Write-Host "  $Server — another machine, which has to be running" }

# ── the server, when it is this machine ─────────────────────────────────────────────────────────────────────
# The browser client is built either way: the server hands it out, and the app is built around it.
Step 'the browser client'
Invoke-Step 'web-build'

if ($isHere) {
    # Stopped, built and started again, so what runs is what was just built. The certificate is the server's own
    # business: it is issued for this machine on the first start, and anew when it no longer names it.
    Step 'the server, built and started here'
    $env:OFFICE_MUMBLE_PORT = $port
    Invoke-Step 'server-stop'
    Invoke-Step 'server-build'
    Invoke-Step 'server-start'
}

# ── the certificate the app pins ────────────────────────────────────────────────────────────────────────────
# Always asked of the running server, never taken from a file: the app refuses every certificate but the one it
# was built with, so it has to be the one this server shows now. It lands in pinned.pem — never in cert.pem,
# which on a server machine is half of its own pair.
Step 'the certificate'
$state = Join-Path $root '.office-mumble'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$pinned = Join-Path $state 'pinned.pem'
$tmp = "$pinned.tmp"
& curl.exe -kfsS --max-time 20 "https://${officeHost}:${port}/cert.pem" -o $tmp
if ($LASTEXITCODE -ne 0) {
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $tmp
    Fail "${officeHost}:${port} did not answer — start the server there first; an app built without its certificate cannot connect to it"
}
Move-Item -Force -LiteralPath $tmp -Destination $pinned
$fingerprint = Get-CertificateFingerprint $pinned
Write-Host "  fetched from https://${officeHost}:${port}/cert.pem"
Write-Host "  $fingerprint"

# ── the installer ───────────────────────────────────────────────────────────────────────────────────────────
# NSIS only: it installs for the current user without administrator rights. The MSI would want them, and minutes
# more to build. The environment is put back afterwards, so nothing of this run is mistaken for a named office
# by the scripts run after it in the same PowerShell.
Step 'the installer'
$saved = @{ server = $env:OFFICE_MUMBLE_SERVER; cert = $env:OFFICE_MUMBLE_CERT }
Push-Location (Join-Path $root 'client')
try {
    $env:OFFICE_MUMBLE_SERVER = $Server
    $env:OFFICE_MUMBLE_CERT = $pinned
    & cargo tauri build --bundles nsis
    $code = $LASTEXITCODE
} finally {
    $env:OFFICE_MUMBLE_SERVER = $saved.server
    $env:OFFICE_MUMBLE_CERT = $saved.cert
    Pop-Location
}
if ($code -ne 0) { exit $code }

# ── what the build actually put in the app ──────────────────────────────────────────────────────────────────
# The two ways a build can be wrong both show only later, on a colleague's machine: the server shows another
# certificate than the one the app was built with, or the app dials another address. So the program that came
# out is read back before anything is handed on: the certificate's bytes and the address must both be inside it.
Step 'what the app was built with'
$exe = Join-Path $root 'client\src-tauri\target\release\office-mumble-shell.exe'
if (-not (Test-Path $exe)) { Fail "no program at $exe — the build stopped early; see what it said above" }
$program = Get-ContentsOfFile $exe
if (-not $program.Contains((Get-ContentsOfFile $pinned))) {
    Fail "the app does not carry the certificate of ${officeHost}:${port} ($fingerprint) — nothing is handed out"
}
Write-Host "  the server's certificate, $fingerprint"
if (-not $program.Contains("wss://$officeHost")) {
    Fail "the app does not carry the address $officeHost — nothing is handed out"
}
Write-Host "  the address, wss://${officeHost}:${port}/ws"

# ── to hand out ─────────────────────────────────────────────────────────────────────────────────────────────
Step 'to hand out'
$nsis = Join-Path $root 'client\src-tauri\target\release\bundle\nsis'
$setup = Get-ChildItem -LiteralPath $nsis -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Fail "no installer under $nsis" }
$handout = Join-Path $root 'handout'
New-Item -ItemType Directory -Force -Path $handout | Out-Null
# One installer per platform: an older one beside it would be the one somebody sends by mistake.
Get-ChildItem -LiteralPath $handout -Filter '*-setup.exe' -ErrorAction SilentlyContinue | Remove-Item -Force
Copy-Item -LiteralPath $setup.FullName -Destination $handout
Write-Host "  $(Join-Path $handout $setup.Name)"
Write-Host "  for $Server, certificate $fingerprint"
Write-Host '  Windows asks once before running it (SmartScreen: "More info", then "Run anyway") — it is not signed.'
exit 0

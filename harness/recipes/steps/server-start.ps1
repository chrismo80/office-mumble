# Start the floor in the background: a log and a pid file beside the certificate, and wait until it answers HTTPS.
# Refuses to start a second one. Settings come from the environment, with the usual defaults:
#   OFFICE_MUMBLE_PORT (8787)  OFFICE_MUMBLE_PLAN (fixtures/floor-t1.json)  OFFICE_MUMBLE_CERT_DIR (.office-mumble)
#   OFFICE_MUMBLE_VOICES_DIR (harness/dummy/public)  OFFICE_MUMBLE_DEMO_VOICE  OFFICE_MUMBLE_DEMO_NAME
#
# The certificate is the server's own business: it issues one when there is none, when the pair cannot work, or
# when it no longer names this machine. When it did, the lines it wrote are repeated here, because they mean
# every app built against the old one has to be built again.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$port = if ($env:OFFICE_MUMBLE_PORT) { $env:OFFICE_MUMBLE_PORT } else { '8787' }
$state = Join-Path $root '.office-mumble'
if (Get-Command curl.exe -ErrorAction SilentlyContinue) { $curl = 'curl.exe' } else { $curl = 'curl' }
$pidFile = Join-Path $state 'server.pid'
$outLog = Join-Path $state 'server.log'
$errLog = Join-Path $state 'server.err.log'
$exe = Join-Path $root 'target\release\office-mumble-server.exe'
New-Item -ItemType Directory -Force -Path $state | Out-Null

# The question a client cares about, asked the same way the shell scripts ask it: does it answer HTTPS with a
# certificate? curl.exe ships with Windows and knows how to ignore a certificate that is not trusted yet.
function Test-Floor {
    & $curl -kfsS --max-time 2 "https://127.0.0.1:$port/cert.pem" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# Asked of the port, not of the pid file: a floor started by hand or by run.mjs has none, and a second one would
# fail to bind while the first answered for it.
$holder = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (Test-Floor) {
    if ($holder) { Write-Host "already running on port ${port}, pid $($holder.OwningProcess)" }
    else { Write-Host "already running on port $port" }
    exit 0
}
if ($holder) {
    Write-Host "port $port is held by pid $($holder.OwningProcess), which does not answer https - not starting a second one" -ForegroundColor Red
    exit 1
}

$env:OFFICE_MUMBLE_PORT = $port
if (-not $env:OFFICE_MUMBLE_PLAN) { $env:OFFICE_MUMBLE_PLAN = 'fixtures/floor-t1.json' }
if (-not $env:OFFICE_MUMBLE_CERT_DIR) { $env:OFFICE_MUMBLE_CERT_DIR = '.office-mumble' }
if (-not $env:OFFICE_MUMBLE_VOICES_DIR) { $env:OFFICE_MUMBLE_VOICES_DIR = 'harness/dummy/public' }

# Started through cmd, which writes the logs, and not with -RedirectStandardOutput: a redirected Start-Process
# hands the server every inheritable handle of this process, so whoever captures this script's output — an IDE
# task, CI — waits until the server ends. Without the redirect, nothing is inherited. The pid file then needs
# the server's own pid, not cmd's, and that is read from the port once it answers.
$cmdLine = "/d /s /c `"`"$exe`" > `"$outLog`" 2> `"$errLog`"`""
$proc = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdLine -WorkingDirectory $root -PassThru -WindowStyle Hidden
for ($i = 0; $i -lt 100; $i++) {
    if (Test-Floor) {
        $owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($owner) { $owner.OwningProcess | Set-Content $pidFile }
        Select-String -Path $outLog -Pattern 'issued a certificate|refuses this server' |
            ForEach-Object { Write-Host $_.Line -ForegroundColor Yellow }
        Write-Host "listening on https://localhost:$port/ - log $outLog"
        exit 0
    }
    if ($proc.HasExited) {
        Write-Host "it stopped before listening; the last lines of ${errLog}:" -ForegroundColor Red
        if (Test-Path $errLog) { Get-Content $errLog -Tail 20 }
        exit 1
    }
    Start-Sleep -Milliseconds 200
}
Write-Host "it is running but not listening on $port after 20 s; see $outLog" -ForegroundColor Red
exit 1

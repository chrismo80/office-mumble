# Stop the floor started by server-start.ps1. Falls back to whoever holds the port, so a server started by
# hand is still stopped, and never stops anything but that one process and the processes it started.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    Write-Host 'this needs Windows: Get-NetTCPConnection is not here'
    exit 1
}
$port = if ($env:OFFICE_MUMBLE_PORT) { $env:OFFICE_MUMBLE_PORT } else { '8787' }
$pidFile = Join-Path $root '.office-mumble\server.pid'

$processId = $null
if (Test-Path $pidFile) {
    $processId = Get-Content $pidFile -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
if (-not $processId -or -not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    $processId = $null
    $owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($owner) { $processId = $owner.OwningProcess }
}
if (-not $processId) {
    Write-Host "nothing is listening on $port"
    exit 0
}
# The server's own children go with it: the demo colleague it starts outlives it on Windows, where nothing ends a
# child with its parent, and it holds the server's log files open — the next start then cannot write them and
# stops at once. They are read before the server ends, while they still name it as their parent.
$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" -ErrorAction SilentlyContinue)
Stop-Process -Id $processId -ErrorAction SilentlyContinue
foreach ($child in $children) { Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400
if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    Write-Host "still running after 400 ms (pid $processId); not killing it harder" -ForegroundColor Red
    exit 1
}
Write-Host "stopped (pid $processId)"
exit 0

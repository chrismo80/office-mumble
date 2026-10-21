# A new certificate, on purpose. The server issues one by itself when the pair cannot work or no longer names this
# machine; this is for every other reason. It removes the pair, and the floor issues a new one when it starts.
# Every app built against the old one refuses the floor until it is built again, and every browser asks once more.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$port = if ($env:OFFICE_MUMBLE_PORT) { $env:OFFICE_MUMBLE_PORT } else { '8787' }
$dir = if ($env:OFFICE_MUMBLE_CERT_DIR) { $env:OFFICE_MUMBLE_CERT_DIR } else { '.office-mumble' }
if (-not [System.IO.Path]::IsPathRooted($dir)) { $dir = Join-Path $root $dir }
if (Get-Command curl.exe -ErrorAction SilentlyContinue) { $curl = 'curl.exe' } else { $curl = 'curl' }

Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $dir 'cert.pem'), (Join-Path $dir 'key.pem')
Write-Host "certificate: removed from $dir — the floor issues a new one when it starts"
# Any HTTPS answer, not /cert.pem: the floor reads that file from disk on every request, and it was just removed.
& $curl -ks --max-time 2 -o NUL "https://127.0.0.1:$port/" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  the floor on $port still uses the old one until it is restarted: recipes\restart.ps1"
}
exit 0

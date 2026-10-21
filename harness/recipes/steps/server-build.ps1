# Build the floor server, release. Builds only; see server-start.ps1 to run it.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
& cargo build --release -p office-mumble-server --manifest-path (Join-Path $root 'Cargo.toml')
exit $LASTEXITCODE

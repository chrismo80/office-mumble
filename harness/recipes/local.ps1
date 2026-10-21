# The whole office on this machine, freshly built and running: the floor restarted, then the app rebuilt and
# started against it. The one to run while working on the code and wanting to look at the result.
#
# It is restart plus start-app and nothing of its own — the two know how to do their parts.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

& (Join-Path $here 'restart.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $here 'start-app.ps1')
exit $LASTEXITCODE

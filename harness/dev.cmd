@echo off
rem Start the office on this machine for working on it: the floor rebuilt and restarted, the app rebuilt and
rem started - a name for recipes\local.ps1. Nothing is installed: installers come from office.cmd.
rem Any word goes to the harness runner instead: dev.cmd walkers --count 4
rem
rem Every entry point on Windows is a .cmd: a double click starts it, and it runs PowerShell with
rem -ExecutionPolicy Bypass for this run only, because a Windows never told otherwise refuses .ps1 files.
setlocal
if not "%~1"=="" (
    node "%~dp0run.mjs" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0recipes\local.ps1"
)
set code=%ERRORLEVEL%
echo.
pause
exit /b %code%

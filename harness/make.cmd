@echo off
rem Everything this machine can build - a name for recipes\build.ps1, which is where the work is described.
rem   make.cmd          the server, the browser client, the harness pages, and the desktop app when an office
rem                     is named in OFFICE_MUMBLE_SERVER
rem   make.cmd -NoApp   everything except the desktop app
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0recipes\build.ps1" %*
set code=%ERRORLEVEL%
echo.
pause
exit /b %code%

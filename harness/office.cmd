@echo off
rem The office, ready to hand out - a name for recipes\office.ps1, which says what it does.
rem   office.cmd                  this machine is the server: build it, start it, and build the Windows
rem                               installer for it, into handout\
rem   office.cmd -Server <host>   build the Windows installer for the server running at <host>
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0recipes\office.ps1" %*
set code=%ERRORLEVEL%
echo.
pause
exit /b %code%

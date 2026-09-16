@echo off
cd /d "%~dp0"
echo This registers the Tenbin bounty and starts the engine on the running server.
echo Make sure START-Windows.bat is already running (http://localhost:8441).
echo.
node --env-file=.env scripts\launch.mjs tenbin
pause

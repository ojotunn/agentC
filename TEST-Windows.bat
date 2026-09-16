@echo off
cd /d "%~dp0"
echo Unit tests (no model)...
call npm test
echo.
echo End-to-end proof on the local Vault fixture (uses the real model, about 5 to 12 USD)...
node --env-file=.env scripts\prova-e2e.mjs
pause

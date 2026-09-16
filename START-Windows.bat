@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
if not exist .env (
  echo No .env found. Copy .env.example to .env and fill ANTHROPIC_API_KEY.
  pause
  exit /b 1
)
if not exist tools\foundry\forge.exe (
  echo tools\foundry\forge.exe not found. Download foundry_stable_win32_amd64.zip from github.com/foundry-rs/foundry/releases and unzip into tools\foundry
  pause
  exit /b 1
)
echo Starting Warden on http://localhost:8441  (panel: http://localhost:8441/admin)
node --env-file=.env src\server.js
pause

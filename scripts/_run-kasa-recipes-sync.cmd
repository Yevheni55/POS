@echo off
setlocal
REM Spustenie sync-bar-recipes na kase cez SSH (Tailscale host z ~/.ssh/config).
set HOST=%DEPLOY_HOST%
if "%HOST%"=="" set HOST=pos-kasa-tscale

if /i "%~1"=="apply" (
  ssh -o BatchMode=yes %HOST% "cd /d C:\POS && docker compose exec -T -w /app/server app node ../scripts/sync-bar-recipes.mjs --apply"
  exit /b %ERRORLEVEL%
)
if /i "%~1"=="replace" (
  ssh -o BatchMode=yes %HOST% "cd /d C:\POS && docker compose exec -T -w /app/server app node ../scripts/sync-bar-recipes.mjs --apply --replace"
  exit /b %ERRORLEVEL%
)
ssh -o BatchMode=yes %HOST% "cd /d C:\POS && docker compose exec -T -w /app/server app node ../scripts/sync-bar-recipes.mjs --dry-run"
exit /b %ERRORLEVEL%

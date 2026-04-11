@echo off
REM No-op credential helper for SSH/non-interactive Windows sessions (WinCred "logon session" errors).
REM For "get", return empty credentials as JSON with exit 0 so public pulls proceed.
if /i "%~1"=="get" (
  powershell -NoProfile -Command "$u = [Console]::In.ReadLine(); $o = [ordered]@{ ServerURL = $u; Username = ''; Secret = '' }; ($o | ConvertTo-Json -Compress)"
  exit /b 0
)
if /i "%~1"=="store" (
  powershell -NoProfile -Command "[Console]::In.ReadToEnd() | Out-Null"
  exit /b 0
)
if /i "%~1"=="erase" exit /b 0
if /i "%~1"=="list" (
  echo {}
  exit /b 0
)
exit /b 0

@echo off
REM No-op credential helper for Docker CLI over SSH (no interactive logon session).
if /i "%~1"=="get" (
  echo {"ServerURL":"","Username":"","Secret":""}
  exit /b 0
)
if /i "%~1"=="store" exit /b 0
if /i "%~1"=="erase" exit /b 0
if /i "%~1"=="list" echo {}
exit /b 0

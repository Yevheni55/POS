@echo off
REM Run this file as Administrator (right-click). Bypasses PowerShell execution policy for this script only.
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-windows-autologon.ps1"
echo.
pause

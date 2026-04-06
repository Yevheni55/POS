#Requires -RunAsAdministrator
# One-time on a Windows shop PC: WSL2 prerequisites for Docker Desktop (Linux containers).
# After this script: reboot, sign in at the console or RDP, open Docker Desktop once until it is healthy, then run setup-new-windows-host.ps1.

$ErrorActionPreference = 'Stop'

Write-Host 'Enabling optional Windows features (WSL + Virtual Machine Platform)...'
$null = dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
$null = dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

Write-Host 'Installing WSL (no default Linux distro; enough for Docker Desktop engine)...'
& wsl.exe --install --no-distribution --web-download

Write-Host 'Setting default WSL version to 2 (ignore error if already set)...'
$null = & wsl.exe --set-default-version 2 2>&1

Write-Host ''
Write-Host 'Next: reboot this PC. After reboot, log in locally or via RDP, start Docker Desktop, finish first-run setup, then run scripts\setup-new-windows-host.ps1 from C:\POS.'

# Run on the bar Windows PC (PowerShell). Docker + RustDesk after reboot; optional autologon is separate.
# Docker Desktop: Windows service + current user's Startup (Run key).
# RustDesk: usually the "RustDesk" Windows service (set to Automatic by installer).

$ErrorActionPreference = 'Stop'

Write-Host '=== com.docker.service -> Automatic ==='
$dockerSvc = Get-Service -Name com.docker.service -ErrorAction SilentlyContinue
if (-not $dockerSvc) {
  Write-Warning 'Docker service not found. Install Docker Desktop first.'
} else {
  Set-Service -Name com.docker.service -StartupType Automatic
  Get-Service com.docker.service | Format-Table Name, Status, StartType
}

Write-Host '=== Docker Desktop in current user Startup (Run) ==='
$dockerExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
if (-not (Test-Path $dockerExe)) {
  Write-Warning "Not found: $dockerExe"
} else {
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
  $quoted = "`"$dockerExe`""
  New-ItemProperty -Path $runKey -Name 'Docker Desktop' -Value $quoted -PropertyType String -Force | Out-Null
  Write-Host "Run key Docker Desktop = $quoted"
}

Write-Host '=== RustDesk service ==='
$rd = Get-Service -Name RustDesk -ErrorAction SilentlyContinue
if (-not $rd) {
  Write-Warning 'RustDesk service not found. Install RustDesk or check service name.'
} else {
  Set-Service -Name RustDesk -StartupType Automatic
  Get-Service RustDesk | Format-Table Name, Status, StartType
}

Write-Host ''
Write-Host 'Auto-logon (no password prompt at boot): run as Administrator:'
Write-Host '  .\scripts\set-windows-autologon.ps1'

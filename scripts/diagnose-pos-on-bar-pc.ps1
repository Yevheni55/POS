# Run on the BAR PC as Administrator (PowerShell).
# Checks Docker, listening ports, firewall rules for 3080/22.

$ErrorActionPreference = 'Continue'

Write-Host '=== Tailscale on this machine ==='
$tsExe = "${env:ProgramFiles}\Tailscale\tailscale.exe"
if (Test-Path $tsExe) { $ts = $tsExe }
elseif (Get-Command tailscale -ErrorAction SilentlyContinue) { $ts = 'tailscale' }
else { $ts = $null }
if ($ts) {
  & $ts status
  Write-Host ''
  & $ts ip -4
} else {
  Write-Host 'tailscale CLI not found — open app from tray, ensure Connected.'
}

Write-Host ''
Write-Host '=== Listening on 3080 / 22 (IPv4) ==='
netstat -an | Select-String -Pattern ':3080\s|:22\s'

Write-Host ''
Write-Host '=== Docker (C:\POS) ==='
if (Test-Path 'C:\POS\docker-compose.yml') {
  Set-Location C:\POS
  $dockerBin = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
  if (Test-Path $dockerBin) {
    & $dockerBin compose ps 2>&1
  } else {
    docker compose ps 2>&1
  }
} else {
  Write-Host 'C:\POS not found — run from POS folder or adjust path.'
}

Write-Host ''
Write-Host '=== Firewall rules (POS / Tailscale) ==='
Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'POS|Tailscale' } |
  Select-Object DisplayName, Enabled, Direction, Action |
  Format-Table -AutoSize

Write-Host ''
Write-Host 'If nothing listens on 0.0.0.0:3080: run docker compose up -d in C:\POS'
Write-Host 'If listen OK but home cannot connect: re-run scripts\open-bar-pc-firewall.ps1 as Admin'

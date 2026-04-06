# Run on your HOME PC (PowerShell), where Tailscale is connected.
# Usage: .\diagnose-tailscale-from-home.ps1 -BarIp 100.95.68.84

param(
  [Parameter(Mandatory = $true)]
  [string] $BarIp
)

$ErrorActionPreference = 'Continue'

Write-Host '=== tailscale version / state ==='
$ts = 'tailscale'
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  $tsExe = "${env:ProgramFiles}\Tailscale\tailscale.exe"
  if (Test-Path $tsExe) { $ts = $tsExe } else {
    Write-Host 'ERROR: tailscale CLI not found. Install Tailscale or add to PATH.'
    exit 1
  }
}
& $ts version
Write-Host ''
& $ts status

Write-Host ''
Write-Host "=== tailscale ping $BarIp (stops after ~10 tries or Ctrl+C) ==="
& $ts ping $BarIp 2>&1 | Select-Object -First 20

Write-Host ''
Write-Host "=== TCP 3000 and 22 to $BarIp ==="
Test-NetConnection -ComputerName $BarIp -Port 3000 -WarningAction SilentlyContinue | Select-Object ComputerName, RemotePort, TcpTestSucceeded
Test-NetConnection -ComputerName $BarIp -Port 22 -WarningAction SilentlyContinue | Select-Object ComputerName, RemotePort, TcpTestSucceeded

Write-Host ''
Write-Host 'If ping works but TCP 3000 is False: POS/Docker down or Windows Firewall on bar PC.'
Write-Host 'If ping fails: different Tailscale accounts, ACL, or bar node offline — check https://login.tailscale.com/admin/machines'

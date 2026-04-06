#Requires -RunAsAdministrator
# Run on the bar PC after moving networks: allow LAN access to SSH and POS from tablets/other PCs.
# Also set the active Ethernet/Wi-Fi profile to Private (Public profile blocks many inbound rules).

$ErrorActionPreference = 'Stop'

Write-Host 'Set active network profile to Private (all connections)...'
Get-NetConnectionProfile | ForEach-Object {
  Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private
  Write-Host "  $($_.Name) -> Private"
}

$rules = @(
  @{ Name = 'POS SSH 22'; Port = 22 },
  @{ Name = 'POS HTTP 3000'; Port = 3000 },
  @{ Name = 'POS HTTPS 3443'; Port = 3443 }
)

foreach ($r in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule exists: $($r.Name)"
    continue
  }
  New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $r.Port -Profile Any | Out-Null
  Write-Host "Added: $($r.Name) (TCP $($r.Port))"
}

Write-Host ''
Write-Host 'Done. From another device on the same LAN try: http://<this-pc-ip>:3000'
Write-Host 'If still blocked, confirm the other device uses the same subnet (e.g. 192.168.1.x).'

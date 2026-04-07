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
  @{ Name = 'POS HTTP 3080'; Port = 3080 },
  @{ Name = 'POS HTTPS 3443'; Port = 3443 },
  @{ Name = 'Portos HTTP API 3010'; Port = 3010 }
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

# Tailscale peers use 100.64.0.0/10; some Windows builds treat the TUN adapter as Public — explicit remote helps.
$tsRules = @(
  @{ Name = 'POS SSH 22 (Tailscale peers)'; Port = 22 },
  @{ Name = 'POS HTTP 3080 (Tailscale peers)'; Port = 3080 },
  @{ Name = 'POS HTTPS 3443 (Tailscale peers)'; Port = 3443 },
  @{ Name = 'Portos API 3010 (Tailscale peers)'; Port = 3010 }
)
foreach ($r in $tsRules) {
  if (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue) {
    Write-Host "Firewall rule exists: $($r.Name)"
    continue
  }
  New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $r.Port -RemoteAddress '100.64.0.0/10' | Out-Null
  Write-Host "Added: $($r.Name) (from Tailscale CGNAT)"
}

Write-Host ''
Write-Host 'Done. LAN: http://<local-ip>:3080  |  From home (Tailscale): http://<tailscale-ip>:3080'
Write-Host 'The browser device must run Tailscale too (or use Tailscale on the PC you browse from).'

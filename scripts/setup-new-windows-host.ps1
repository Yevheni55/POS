# Run on the NEW Windows PC, inside the POS project folder (e.g. C:\POS).
# Requires: Docker Desktop running (Linux engine). Portos on this machine if you use fiscal printing.
# If `docker info` fails with WSL / dockerDesktopLinuxEngine: run scripts\enable-wsl-for-docker-desktop.ps1 as Administrator, reboot, open Docker Desktop once on an interactive session.
# NOT for the router — use the workstation IP (often 192.168.0.x, not .1).

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

$dockerCli = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
if (-not (Test-Path $dockerCli)) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error 'Docker CLI not found. Install Docker Desktop, then retry.'
  }
  $dockerCli = 'docker'
}
& $dockerCli info *>$null
if ($LASTEXITCODE -ne 0) {
  Write-Error "Docker engine is not reachable. Install WSL2 and finish Docker Desktop first (see scripts\enable-wsl-for-docker-desktop.ps1), then retry."
}

if (-not (Test-Path '.\server\.env')) {
  Copy-Item '.\server\.env.example' '.\server\.env'
  Write-Host 'Created server\.env from .env.example — edit DATABASE_URL secrets PORTOS_* PRINTER_IP before production.'
}

Write-Host 'Building and starting Docker stack...'
& docker compose up -d --build

Write-Host 'Waiting for Postgres...'
Start-Sleep -Seconds 8

Write-Host 'db:push + db:seed in app container...'
docker compose exec -T app sh -c "cd /app/server && npm run db:push && npm run db:seed"

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "Done. Open POS: http://localhost:3000"
if ($ip) { Write-Host "From LAN: http://${ip}:3000" }

# Run on the bar PC from repo root (e.g. C:\POS). Checks Portos from inside the app container.
# Uses SSH docker shim if present (apply-docker-ssh-cli-fix.ps1).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

. (Join-Path $PSScriptRoot 'apply-docker-ssh-cli-fix.ps1')

Write-Host '=== Portos readiness (docker compose exec app) ==='
docker compose exec -T app sh -c "cd /app/server && node scripts/portos-readiness.mjs"

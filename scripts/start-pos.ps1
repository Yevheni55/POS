# Start POS API + static UI from server/ (correct .env and working directory).
# Port comes from server/.env (default in server.js if unset). Do not rely on :3000 if another dev server uses it.

$ErrorActionPreference = 'Stop'
$serverDir = Resolve-Path (Join-Path $PSScriptRoot '..\server')
Set-Location $serverDir
Write-Host ''
Write-Host 'Starting POS server from' $serverDir.Path
Write-Host 'After "Open POS login" appears, use that URL (not necessarily :3000).' -ForegroundColor DarkYellow
Write-Host ''
npm run start

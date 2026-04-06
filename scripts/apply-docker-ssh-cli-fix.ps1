# Docker Desktop's docker-credential-desktop.exe fails over OpenSSH ("logon session does not exist").
# One-time: copy scripts\docker-credential-desktop-ssh.cmd to $env:USERPROFILE\bin\docker-credential-desktop.cmd
$dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
$userBin = Join-Path $env:USERPROFILE 'bin'
$shim = Join-Path $userBin 'docker-credential-desktop.cmd'
if (-not (Test-Path $shim)) { return }

$parts = $env:PATH -split ';' | Where-Object { $_ -and ($_ -ne $dockerBin) }
$env:PATH = $userBin + ';' + ($parts -join ';')
$dockerExe = Join-Path $dockerBin 'docker.exe'
if (Test-Path $dockerExe) {
  function global:docker { & $dockerExe @args }
}

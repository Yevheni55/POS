# Daily Postgres backup for the kasa POS database.
#
# Usage (manually): powershell -NoProfile -ExecutionPolicy Bypass -File C:\POS\scripts\backup-db.ps1
# Usage (Task Scheduler): see scripts/backup-db.README.md for the schtasks
# command that registers this as a 03:00 daily job.
#
# Output:
#   C:\POS-backups\pos-YYYYMMDD-HHmm.dump  (Postgres custom-format, gzip-style)
#   C:\POS-backups\backup.log              (per-run line: timestamp + size + status)
#
# Retention: keeps the last 30 daily dumps and the last 12 monthly snapshots
# (1st of each month) — older files are removed.

$ErrorActionPreference = 'Stop'

$BackupDir   = 'C:\POS-backups'
$LogFile     = Join-Path $BackupDir 'backup.log'
$DbContainer = 'pos-db-1'
$DbUser      = 'pos'
$DbName      = 'pos'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmm'
$DumpName    = "pos-$Stamp.dump"
$DumpPath    = Join-Path $BackupDir $DumpName
$RetainDays  = 30
$RetainMonths = 12

function Write-Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

# 1. Ensure backup dir + log
if (-not (Test-Path $BackupDir)) {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}

try {
  Write-Log "START dump > $DumpName"

  # 2. Dump INSIDE the container to a temp file, then docker cp out. Avoids
  #    PowerShell pipeline binary-stream corruption that would happen if we
  #    streamed pg_dump's stdout through `docker exec ... | Set-Content`.
  $containerTmp = "/tmp/$DumpName"
  & docker exec $DbContainer pg_dump -U $DbUser -d $DbName -Fc -f $containerTmp 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pg_dump exited $LASTEXITCODE" }
  & docker cp "${DbContainer}:$containerTmp" $DumpPath 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "docker cp exited $LASTEXITCODE" }
  & docker exec $DbContainer rm -f $containerTmp 2>&1 | Out-Null

  $size = (Get-Item $DumpPath).Length
  if ($size -lt 1024) { throw "dump suspiciously small: $size bytes" }
  Write-Log ("OK   $DumpName ({0:N0} bytes)" -f $size)

  # 3. Retention: drop daily dumps older than $RetainDays UNLESS they are the
  #    monthly anchor (day == 01) within the last $RetainMonths.
  $now = Get-Date
  Get-ChildItem -Path $BackupDir -Filter 'pos-*.dump' | ForEach-Object {
    if ($_.Name -match '^pos-(\d{8})-\d{4}\.dump$') {
      $d = [datetime]::ParseExact($matches[1], 'yyyyMMdd', $null)
      $ageDays   = ($now - $d).TotalDays
      $isMonthly = ($d.Day -eq 1)
      $monthAge  = ($now.Year - $d.Year) * 12 + ($now.Month - $d.Month)
      $keep = $false
      if ($ageDays -le $RetainDays) { $keep = $true }
      elseif ($isMonthly -and $monthAge -le $RetainMonths) { $keep = $true }
      if (-not $keep) {
        Remove-Item -Path $_.FullName -Force
        Write-Log "PRUNE $($_.Name)"
      }
    }
  }
}
catch {
  Write-Log ("FAIL $($_.Exception.Message)")
  exit 1
}

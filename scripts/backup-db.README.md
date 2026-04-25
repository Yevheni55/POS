# DB backup setup (kasa, Windows)

`scripts/backup-db.ps1` runs `pg_dump` inside the `pos-db-1` container and
writes a custom-format `.dump` file to `C:\POS-backups\`. Daily retention =
30 days; the 1st-of-month dump is kept for an extra year.

## One-time setup on the kasa

Open **PowerShell as Administrator** on the kasa (or via RDP):

```powershell
# 1) Verify the script runs and the dump lands.
powershell -NoProfile -ExecutionPolicy Bypass -File C:\POS\scripts\backup-db.ps1
dir C:\POS-backups\

# 2) Register a daily 03:00 task in Task Scheduler.
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\POS\scripts\backup-db.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At 3:00am
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'POS-DB-Backup-Daily' `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'pg_dump → C:\POS-backups (30d daily, 12mo monthly)'
```

## Restore from a dump

```powershell
# Copy the dump into the container, then pg_restore over the live DB.
docker cp C:\POS-backups\pos-20260425-0300.dump pos-db-1:/tmp/restore.dump
docker exec -i pos-db-1 pg_restore -U pos -d pos --clean --if-exists /tmp/restore.dump
```

Cleanup `/tmp/restore.dump` inside the container afterwards.

## Verify schedule

```powershell
Get-ScheduledTask -TaskName 'POS-DB-Backup-Daily' | Get-ScheduledTaskInfo
Get-Content C:\POS-backups\backup.log -Tail 20
```

## Off-site copy (optional but recommended)

The dumps live on the same disk as Postgres. If the disk fails, both go.
Add a second step that mirrors `C:\POS-backups\` to e.g. a Tailscale-shared
folder on a NAS or to OneDrive — same Task Scheduler trigger, follow with:

```powershell
robocopy C:\POS-backups \\nas\pos-backups *.dump /MIR /R:2 /W:5
```

## What this protects against

- Disk failure on the kasa
- Accidental DELETE / TRUNCATE
- Schema migration that goes wrong
- Ransomware (combined with off-site copy)

What it does NOT replace:
- Active monitoring (`backup.log` should be tailed periodically)
- Off-site copy (see above)
- Periodic restore drill — at least quarterly do a `pg_restore` to a
  scratch DB (`docker exec ... createdb pos_restore_test`) to confirm the
  dump is actually usable.

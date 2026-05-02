// Daily Postgres backup. Runs in the same node process as the API; the
// scheduler in server.js fires runDailyBackupOnce() at 04:00 Bratislava
// (the same hook the attendance auto-close uses) and rotates older
// snapshots so the volume doesn't grow unbounded.
//
// Why pg_dump and not Drizzle / SQL-export-from-Node?
//   - pg_dump writes a self-contained restore script (CREATE TABLE +
//     COPY data + sequences + indexes), which is what we actually need
//     in 'oh no the kasa died' scenarios. Hand-rolled exports would
//     drift from the live schema as the codebase evolves.
//   - postgresql16-client is added to the app image's Dockerfile so the
//     binary is available; we still keep the DATABASE_URL the same as
//     the running app, so the dump is exactly what the API can see.

import { spawn } from 'node:child_process';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 14;
const FILE_PREFIX = 'pos-';
const FILE_SUFFIX = '.sql.gz';

function todayBratislavaISO() {
  // Returns YYYY-MM-DD in Europe/Bratislava — used as the backup file
  // stem so a 03:30 deploy that triggers a manual run uses 'today's
  // date as the cashier sees it (not yesterday's UTC date).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function parseDatabaseUrl(url) {
  // pg_dump accepts the URL directly via its --dbname flag, but we still
  // parse it so we can fall back to PGPASSWORD env (some pg_dump builds
  // refuse the password embedded in the URL when running non-interactively).
  if (!url) throw new Error('DATABASE_URL is not set');
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    database: (parsed.pathname || '').replace(/^\//, '') || 'postgres',
  };
}

async function ensureBackupDir() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

// Run pg_dump → gzip → file. Returns { path, bytes, durationMs } on success
// and throws on any non-zero exit so the scheduler can log a clear failure.
export async function runDailyBackupOnce(date = todayBratislavaISO()) {
  await ensureBackupDir();
  const conn = parseDatabaseUrl(process.env.DATABASE_URL);
  const filename = path.join(BACKUP_DIR, `${FILE_PREFIX}${date}${FILE_SUFFIX}`);
  const tmpName = filename + '.partial';
  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const args = [
      '--no-owner',                  // restoring as a different user is fine
      '--no-privileges',             // no GRANT noise — we own everything
      '--format=plain',              // plain SQL so cat / less / restore is trivial
      '--clean',                     // include DROP statements for restore-in-place
      '--if-exists',                 // ...but don't fail when objects don't exist
      '-h', conn.host,
      '-p', conn.port,
      '-U', conn.user,
      '-d', conn.database,
    ];
    const child = spawn('pg_dump', args, {
      env: { ...process.env, PGPASSWORD: conn.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const gz = zlib.createGzip({ level: 6 });
    const out = createWriteStream(tmpName);
    let stderrBuf = '';
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
    child.stdout.pipe(gz).pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    gz.on('error', reject);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`pg_dump exited with code ${code}: ${stderrBuf.trim().slice(-500)}`));
      }
    });
  });

  // Atomic-ish swap: pg_dump might have failed partway and left a
  // truncated .partial; we only rename to the canonical name when the
  // whole pipeline finishes cleanly.
  await fs.rename(tmpName, filename);
  const stat = await fs.stat(filename);
  return { path: filename, bytes: stat.size, durationMs: Date.now() - startedAt };
}

// Delete dump files older than RETENTION_DAYS. Errors are swallowed per-file
// so one missing file or permission glitch can't take the whole prune down.
export async function pruneOldBackups(now = new Date()) {
  await ensureBackupDir();
  const entries = await fs.readdir(BACKUP_DIR);
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const name of entries) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
    const full = path.join(BACKUP_DIR, name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) {
        await fs.unlink(full);
        deleted += 1;
      }
    } catch (e) {
      // Skip — the next run will try again.
    }
  }
  return { deleted };
}

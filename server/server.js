import fs from 'fs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server as SocketServer } from 'socket.io';
import { asc, gte, sql } from 'drizzle-orm';

import { app } from './app.js';
import { db } from './db/index.js';
import { attendanceEvents } from './db/schema.js';
import { getActiveCashRegisterCode } from './lib/active-cash-register.js';
import { findOrphanedClockIns, buildAutoCloseRows } from './lib/attendance-auto-close.js';
import { runDailyBackupOnce, pruneOldBackups } from './lib/backup.js';
import { corsOriginCallback } from './lib/cors-origin.js';
import { getPortosConfig, isPortosEnabled } from './lib/portos.js';
import { runPortosProfileSync, startPortosProfileSync } from './lib/portos-sync-job.js';
import { isVatRegisteredBusiness } from './lib/vat-registration.js';
import { startIdempotencyCleanup } from './middleware/idempotency.js';
import { startPrintQueue } from './routes/print.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3080;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// HTTP server
const httpServer = createServer(app);

// HTTPS server (self-signed cert for PWA fullscreen on LAN)
let httpsServer = null;
try {
  const certPath = path.join(__dirname, 'certs');
  const sslKey = fs.readFileSync(path.join(certPath, 'key.pem'));
  const sslCert = fs.readFileSync(path.join(certPath, 'cert.pem'));
  httpsServer = createHttpsServer({ key: sslKey, cert: sslCert }, app);
} catch (e) { /* no certs = no HTTPS, that's fine */ }

const ioServer = httpsServer || httpServer;
const io = new SocketServer(ioServer, { cors: { origin: corsOriginCallback } });
// Also attach to HTTP server if HTTPS exists
if (httpsServer) new SocketServer(httpServer, { cors: { origin: corsOriginCallback } });

// Auth middleware for sockets
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log('WS connected:', socket.user.name);
  socket.on('disconnect', () => console.log('WS disconnected:', socket.user.name));
});

// Make io available to routes
app.set('io', io);

// Crash logging
const LOG_FILE = path.join(__dirname, 'crash.log');

function logCrash(type, err) {
  const entry = `[${new Date().toISOString()}] ${type}: ${err.stack || err}\n`;
  fs.appendFileSync(LOG_FILE, entry);
  console.error(entry);
}

process.on('uncaughtException', (err) => {
  logCrash('UNCAUGHT_EXCEPTION', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logCrash('UNHANDLED_REJECTION', err);
});

process.on('SIGTERM', () => { logCrash('SIGNAL', new Error('SIGTERM')); process.exit(0); });
process.on('SIGINT', () => { logCrash('SIGNAL', new Error('SIGINT')); process.exit(0); });

httpServer.listen(PORT, () => {
  const msg = `[${new Date().toISOString()}] Server started on port ${PORT}\n`;
  fs.appendFileSync(LOG_FILE, msg);
  const loginUrl = `http://localhost:${PORT}/login.html`;
  console.log(`POS server running on http://localhost:${PORT}`);
  console.log(`Open POS login: ${loginUrl}`);
  if (Number(PORT) !== 3000) {
    console.log('(If http://localhost:3000 shows 404, another app is using port 3000 — use the URL above.)');
  }
  const pc = getPortosConfig();
  console.log(
    `[Portos] Fiscal integration ${isPortosEnabled() ? 'ENABLED' : 'DISABLED'} | PORTOS_BASE_URL=${pc.baseUrl} | cashRegister=${pc.cashRegisterCode}`,
  );
  startIdempotencyCleanup();
  startPrintQueue();
  if (isPortosEnabled()) {
    startPortosProfileSync();
    runPortosProfileSync({ timeoutMs: 12000 })
      .then(async () => {
        const activeCode = await getActiveCashRegisterCode();
        const envCode = pc.cashRegisterCode;
        const matches = envCode && envCode === activeCode;
        console.log(
          `[Portos] Active cash register = ${activeCode || '(none)'}${envCode ? ` | .env = ${envCode}${matches ? ' (match)' : ' (MISMATCH)'}` : ''}`,
        );
        const vatRegistered = await isVatRegisteredBusiness();
        console.log(
          `[Portos] VAT mode = ${vatRegistered ? 'registered (IC DPH present, menu VAT rates used)' : 'NON-REGISTERED (no IC DPH, all receipt items forced to vatRate=0)'}`,
        );
      })
      .catch(() => { /* sync error already logged */ });
  }
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`POS HTTPS running on https://localhost:${HTTPS_PORT}`);
  });
}

// Daily auto-close: at 04:00 Europe/Bratislava we close any shift that
// crossed midnight without a clock_out. Without this, one forgotten
// Odchod permanently ruins the staff's hours/wages report.
async function runAutoCloseOnce(now = new Date()) {
  // Cutoff = 04:00 Bratislava on the date just past. Postgres handles the
  // TZ math so DST switches don't drift this by an hour.
  const cutoffSql = await db.execute(
    sql`SELECT (date_trunc('day', NOW() AT TIME ZONE 'Europe/Bratislava') + INTERVAL '4 hours') AT TIME ZONE 'Europe/Bratislava' AS cutoff`
  );
  const cutoff = cutoffSql.rows[0]?.cutoff;
  if (!cutoff) return { closed: 0 };
  const cutoffDate = new Date(cutoff);
  // Look 36h back so we cover at most one missed run; any older orphans
  // would already have been closed by a prior tick.
  const since = new Date(cutoffDate.getTime() - 36 * 60 * 60 * 1000);

  return await db.transaction(async (tx) => {
    const rows = await tx.select().from(attendanceEvents)
      .where(gte(attendanceEvents.at, since))
      .orderBy(asc(attendanceEvents.at));
    const orphans = findOrphanedClockIns(rows, cutoffDate);
    if (!orphans.length) return { closed: 0 };
    const insertRows = buildAutoCloseRows(orphans, cutoffDate);
    await tx.insert(attendanceEvents).values(insertRows);
    return { closed: insertRows.length, staffIds: insertRows.map(r => r.staffId) };
  });
}

function scheduleAutoClose() {
  function msUntilNext0400Local() {
    // Compute "next 04:00 Bratislava" by asking Postgres directly so the
    // DST boundary is correct.
    return db.execute(
      sql`SELECT EXTRACT(EPOCH FROM (
         (date_trunc('day', (NOW() AT TIME ZONE 'Europe/Bratislava') + INTERVAL '1 day')
            + INTERVAL '4 hours') AT TIME ZONE 'Europe/Bratislava' - NOW()
       )) * 1000 AS ms`
    ).then(r => Math.max(60_000, Number(r.rows[0]?.ms) || 24 * 60 * 60 * 1000));
  }
  async function loop() {
    try {
      const result = await runAutoCloseOnce();
      if (result && result.closed > 0) {
        console.log(`[attendance] auto-closed ${result.closed} orphan shift(s)`, result.staffIds);
      }
    } catch (e) {
      console.error('[attendance] auto-close failed:', e?.message || e);
    }
    // Daily DB backup runs in the same 04:00 hook so we have a single
    // bedtime maintenance window. A failure here MUST NOT skip the next
    // schedule tick — the kasa runs unattended and we'd otherwise lose
    // backups silently for days. Logged loudly instead.
    try {
      const out = await runDailyBackupOnce();
      const mb = (out.bytes / (1024 * 1024)).toFixed(2);
      console.log(`[backup] wrote ${out.path} (${mb} MB) in ${out.durationMs} ms`);
    } catch (e) {
      console.error('[backup] daily pg_dump failed:', e?.message || e);
    }
    try {
      const pr = await pruneOldBackups();
      if (pr.deleted > 0) console.log(`[backup] pruned ${pr.deleted} old snapshot(s)`);
    } catch (e) {
      console.error('[backup] prune failed:', e?.message || e);
    }
    const ms = await msUntilNext0400Local();
    setTimeout(loop, ms);
  }
  // First tick: schedule for the next 04:00 Bratislava. Don't run on boot
  // — that would close shifts again right after a deploy.
  msUntilNext0400Local().then((ms) => setTimeout(loop, ms));
}

scheduleAutoClose();

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
import { startSheetsExportCron } from './lib/sheets-export.js';
import { startWeatherHourlyCron } from './lib/weather.js';
import { startForecastCron } from './lib/forecast/engine.js';
import { isVatRegisteredBusiness } from './lib/vat-registration.js';
import { startIdempotencyCleanup } from './middleware/idempotency.js';
import { startPrintQueue, startPrinterKeepAlive } from './routes/print.js';
import { startParagonSync } from './jobs/paragon-sync.js';
import { prewarmTtlock } from './routes/ttlock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3080;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// HTTP server
const httpServer = createServer(app);

// Keep-alive okno — Node default je iba 5 s, ale klienti (Android kasa,
// web POS) pollujú každých 10-15 s. Pri 5 s server zatvoril idle keep-alive
// spojenie MEDZI pollmi, OkHttp/fetch ho z poolu znova použil → prvý request
// padol "nedostupný server", druhý šiel po čerstvom spojení. 65 s > poll
// interval → spojenie ostáva teplé, sokety nestarnú. headersTimeout MUSÍ byť
// väčší než keepAliveTimeout (inak vlastná race podľa Node docs).
function tuneKeepAlive(srv) {
  srv.keepAliveTimeout = 65000;
  srv.headersTimeout = 66000;
}
tuneKeepAlive(httpServer);

// HTTPS server (self-signed cert for PWA fullscreen on LAN)
let httpsServer = null;
try {
  const certPath = path.join(__dirname, 'certs');
  const sslKey = fs.readFileSync(path.join(certPath, 'key.pem'));
  const sslCert = fs.readFileSync(path.join(certPath, 'cert.pem'));
  httpsServer = createHttpsServer({ key: sslKey, cert: sslCert }, app);
  tuneKeepAlive(httpsServer);
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

// Crash logging.
//
// Predtým sa písalo do server/crash.log VNÚTRI image — teda do efemérneho
// súborového systému kontajnera. Prvá vec, ktorou sa pád rieši, je
// `docker compose up -d --build`, a ten log s príčinou zmaže. LOG_DIR
// (defaultne /backups, čo JE namountovaný named volume) prežije rebuild.
// Zápis je best-effort: keď sa nedá, aspoň to ide do stdout → `docker logs`.
const LOG_DIR = process.env.LOG_DIR || process.env.BACKUP_DIR || __dirname;
const LOG_FILE = path.join(LOG_DIR, 'crash.log');

function logCrash(type, err) {
  const entry = `[${new Date().toISOString()}] ${type}: ${err.stack || err}\n`;
  // console.error PRVÝ — stdout zachytí docker logs aj keď zápis zlyhá.
  console.error(entry);
  try {
    fs.appendFileSync(LOG_FILE, entry);
  } catch (e) {
    console.error('[crash-log] zapis do ' + LOG_FILE + ' zlyhal:', e?.message || e);
  }
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
  // Keep-alive — drzi tlaciarne prebudene (žiadny 2-3s wake-up delay pri Send)
  startPrinterKeepAlive();
  startParagonSync();
  // Pre-fetch TTLock OAuth token v pozadi aby prvy passcode request po
  // reštarte nemusel cakat na auth handshake (1-2s šetri).
  prewarmTtlock();
  // Hourly weather fetch from Open-Meteo (Drazdiak coordinates).
  // Boot fetch + each 60 min. Errors are logged but don't crash boot.
  startWeatherHourlyCron();
  // Hourly revenue forecast (ridge model: počasie + kalendár + hodinový profil).
  // Pretrénuje sa, projektuje dnešok + 7 dní → revenue_forecasts (method v2-ridge).
  startForecastCron();
  // Denný export sezónneho P&L do Google Sheets o 05:10 Bratislava (po 04:00
  // auto-close zmien, aby včerajšie mzdy boli uzavreté). Bez SHEETS_EXPORT_URL
  // v .env sa iba zaloguje "disabled".
  startSheetsExportCron();
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
  // POSLEDNÁ hranica 04:00, nie dnešná.
  // Predtým to bolo natvrdo „dnes 04:00": keď funkcia bežala pred štvrtou
  // ráno (napr. pri catch-upe po reštarte o 02:00), cutoff ležal v BUDÚCNOSTI
  // a auto-close by uzavrel aj smenu človeka, ktorý práve pracuje na nočnej.
  // Takto je hranica vždy v minulosti a v riadnom behu o 04:00 vyjde presne
  // rovnaká hodnota ako doteraz.
  const cutoffSql = await db.execute(
    sql`SELECT (
          CASE WHEN (NOW() AT TIME ZONE 'Europe/Bratislava')::time >= TIME '04:00'
               THEN date_trunc('day', NOW() AT TIME ZONE 'Europe/Bratislava') + INTERVAL '4 hours'
               ELSE date_trunc('day', (NOW() AT TIME ZONE 'Europe/Bratislava') - INTERVAL '1 day') + INTERVAL '4 hours'
          END
        ) AT TIME ZONE 'Europe/Bratislava' AS cutoff`
  );
  const cutoff = cutoffSql.rows[0]?.cutoff;
  if (!cutoff) return { closed: 0 };
  const cutoffDate = new Date(cutoff);
  // 72 h dozadu: pri 36 h stačilo, aby kasa prespala jeden beh (reštart medzi
  // polnocou a 04:00 predtým celý ten deň preskočil), a zabudnutý „Odchod"
  // už žiadny ďalší tick nezachytil — zostal otvorený navždy a skresľoval
  // mzdový report.
  const since = new Date(cutoffDate.getTime() - 72 * 60 * 60 * 1000);

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

/**
 * Zmaže staré riadky z prevádzkových tabuliek. Beží raz denne o 04:00 v tom
 * istom hooku ako záloha a auto-close dochádzky.
 *
 * Retencie sú volené tak, aby sa nedalo prísť o nič, čo ešte niekto číta:
 *   events           30 dní — socket fan-out; KDS si cez /events dočítava
 *                    zmeškané udalosti len rádovo v minútach.
 *   print_queue       7 dní pre 'done'; 'failed' zostávajú (diagnostika).
 *   idempotency_keys  2 dni — middleware ich považuje za expirované po 24 h.
 *   auth_attempts    30 dní — lockout okno je 15 minút, zvyšok je len audit.
 * Každý DELETE má vlastný try/catch, nech jedno zlyhanie nezhodí ostatné.
 */
async function pruneOperationalTables() {
  const out = { events: 0, print_queue: 0, idempotency_keys: 0, auth_attempts: 0 };
  const jobs = [
    ['events', sql`DELETE FROM events WHERE created_at < NOW() - INTERVAL '30 days'`],
    ['print_queue', sql`DELETE FROM print_queue WHERE status = 'done' AND created_at < NOW() - INTERVAL '7 days'`],
    ['idempotency_keys', sql`DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '2 days'`],
    ['auth_attempts', sql`DELETE FROM auth_attempts WHERE created_at < NOW() - INTERVAL '30 days'`],
  ];
  for (const [name, stmt] of jobs) {
    try {
      const r = await db.execute(stmt);
      out[name] = Number(r.rowCount ?? 0);
    } catch (e) {
      console.error(`[maintenance] prune ${name} failed:`, e?.message || e);
    }
  }
  return out;
}

function scheduleAutoClose() {
  function msUntilNext0400Local() {
    // Compute "next 04:00 Bratislava" by asking Postgres directly so the
    // DST boundary is correct.
    //
    // Predtým tu bolo natvrdo `+ INTERVAL '1 day'`, teda VŽDY zajtrajšie
    // 04:00. Reštart kontajnera o 01:00 tak preskočil dnešný beh úplne —
    // a s ním aj dennú zálohu, ktorá visí na tom istom hooku. Teraz sa
    // vyberie dnešné 04:00, ak ešte neprešlo.
    return db.execute(
      sql`SELECT EXTRACT(EPOCH FROM (
         (CASE WHEN (NOW() AT TIME ZONE 'Europe/Bratislava')::time < TIME '04:00'
               THEN date_trunc('day', NOW() AT TIME ZONE 'Europe/Bratislava') + INTERVAL '4 hours'
               ELSE date_trunc('day', (NOW() AT TIME ZONE 'Europe/Bratislava') + INTERVAL '1 day') + INTERVAL '4 hours'
          END) AT TIME ZONE 'Europe/Bratislava' - NOW()
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
    // Upratovanie prevádzkových tabuliek. Žiadna z nich sa doteraz nečistila,
    // takže na kase rástli donekonečna — `events` je len socket fan-out
    // (nikto ho spätne nečíta), `print_queue` po vytlačení tiež nie.
    // Zálohy sa tým zbytočne nafukovali a dotazy nad nimi spomaľovali.
    // Zámerne konzervatívne: neúspešné tlače (`failed`) sa NEMAŽÚ, tie chce
    // majiteľ vidieť.
    try {
      const pruned = await pruneOperationalTables();
      const nonZero = Object.entries(pruned).filter(([, n]) => n > 0);
      if (nonZero.length) {
        console.log('[maintenance] pruned:', nonZero.map(([k, n]) => `${k}=${n}`).join(' '));
      }
    } catch (e) {
      console.error('[maintenance] prune failed:', e?.message || e);
    }
    const ms = await msUntilNext0400Local();
    setTimeout(loop, ms);
  }
  // Catch-up po štarte. Kasa sa reštartuje pri každom deployi aj po výpadku
  // prúdu; ak reštart padol do okna, v ktorom mal beh prebehnúť, deň sa
  // predtým jednoducho preskočil (zabudnutý „Odchod" ostal otvorený a v ten
  // deň nevznikla ani záloha). runAutoCloseOnce je bezpečné spustiť
  // opakovane — pracuje voči POSLEDNEJ hranici 04:00 (teda vždy v minulosti)
  // a už uzavreté smeny druhýkrát nenájde.
  setTimeout(function () {
    runAutoCloseOnce()
      .then((r) => {
        if (r && r.closed > 0) {
          console.log(`[attendance] boot catch-up auto-closed ${r.closed} orphan shift(s)`, r.staffIds);
        }
      })
      .catch((e) => console.error('[attendance] boot catch-up failed:', e?.message || e));
  }, 20_000);

  // Ďalej už normálny plán na najbližšie 04:00 Bratislava.
  msUntilNext0400Local().then((ms) => setTimeout(loop, ms));
}

scheduleAutoClose();

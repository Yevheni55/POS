import { Router } from 'express';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import net from 'net';

import { getPortosConfig, isPortosEnabled } from '../lib/portos.js';
import { getPortosProfileSyncStats } from '../lib/portos-sync-job.js';
import { getVatMode } from '../lib/vat-registration.js';

const router = Router();
const START_TIME = Date.now();

/**
 * Fiškálna diagnostika — kód pokladne a režim DPH visia na `company_profiles`,
 * ktorý plní VÝHRADNE Portos profile sync. Kým tento blok neexistoval, zlyhaný
 * sync bol úplne neviditeľný: POS ďalej razil doklady so starým DKP a s 0 %
 * DPH a jediná stopa bol jednorazový boot log.
 *
 * Čítanie je čisto pasívne (in-memory štatistika + jeden SELECT profilu) —
 * /health NIKDY nespúšťa Portos sync, nech ho monitoring nemôže rozbehnúť
 * v prevádzke.
 */
async function collectFiscalHealth() {
  const cfg = getPortosConfig();
  const sync = getPortosProfileSyncStats();

  const fiscal = {
    portosEnabled: isPortosEnabled(),
    profileSync: {
      lastSyncAt: sync.lastSyncAt,
      lastError: sync.lastError,
      running: sync.running,
      attempts: sync.attempts,
      intervalMs: sync.intervalMs,
      trusted: sync.trusted,
    },
    // 'unknown' = profil sa nedal prečítať; NIKDY sa to nemá interpretovať
    // ako „neplatiteľ".
    vatMode: 'unknown',
    vatRegistered: null,
    vatModeMismatch: false,
    expectedVatRegistered: null,
    cashRegisterCode: '',
    envCashRegisterCode: cfg.cashRegisterCode || '',
    cashRegisterMatchesEnv: null,
    error: null,
  };

  try {
    const mode = await getVatMode();
    fiscal.vatMode = mode.vatRegistered ? 'registered' : 'non-registered';
    fiscal.vatRegistered = mode.vatRegistered;
    fiscal.vatModeMismatch = mode.mismatch;
    fiscal.expectedVatRegistered = mode.expectedVatRegistered;
    fiscal.cashRegisterCode = mode.cashRegisterCode;
    fiscal.cashRegisterMatchesEnv = fiscal.envCashRegisterCode
      ? fiscal.envCashRegisterCode === mode.cashRegisterCode
      : null;
  } catch (error) {
    // getVatMode() je fail-closed (chybu DB už neprehltáva) — /health ju
    // ukáže, ale sám kvôli nej nespadne.
    fiscal.error = error instanceof Error ? error.message : String(error);
  }

  return fiscal;
}

function checkPrinter(ip, port) {
  return new Promise(resolve => {
    const client = new net.Socket();
    client.setTimeout(2000);
    client.connect(port, ip, () => { client.destroy(); resolve(true); });
    client.on('error', () => resolve(false));
    client.on('timeout', () => { client.destroy(); resolve(false); });
  });
}

router.get('/', async (req, res) => {
  const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const mem = process.memoryUsage();

  const health = {
    status: 'ok',
    uptime: uptimeSec,
    uptimeFormatted: h + 'h ' + m + 'm',
    timestamp: new Date().toISOString(),
    memory: {
      rss: Math.round(mem.rss / 1048576),
      heap: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
    },
    db: 'unknown',
    printers: [],
    // Fiškálny profil (kód pokladne + režim DPH) a stav Portos profile syncu.
    fiscal: null,
    // Vek poslednej zálohy. Bez tohto sa tichý výpadok záloh (plný disk,
    // chýbajúci pg_dump po rebuilde image) nedal spozorovať inak než SSH
    // na kasu — a zistilo by sa to až vo chvíli, keď treba obnovovať.
    backup: null,
  };

  // DB check
  try {
    await db.execute(sql`SELECT 1`);
    health.db = 'ok';
  } catch {
    health.db = 'error';
    health.status = 'degraded';
  }

  // Printer check — try DB first, fallback to env
  try {
    const { printers: printersTable } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const allPrinters = await db.select().from(printersTable).where(eq(printersTable.active, true));
    for (const p of allPrinters) {
      const ok = await checkPrinter(p.ip, p.port);
      health.printers.push({ name: p.name, ip: p.ip, port: p.port, dest: p.dest, status: ok ? 'ok' : 'error' });
      if (!ok) health.status = 'degraded';
    }
  } catch {
    // Fallback to .env printer
    const ip = process.env.PRINTER_IP || '192.168.0.107';
    const port = parseInt(process.env.PRINTER_PORT || '9100');
    const ok = await checkPrinter(ip, port);
    health.printers.push({ name: 'Default', ip, port, dest: 'all', status: ok ? 'ok' : 'error' });
    if (!ok) health.status = 'degraded';
  }

  // Zálohy — zámerne bez ciest na disku, nech verejný /health nič neprezrádza.
  try {
    const { getLastBackupInfo } = await import('../lib/backup.js');
    const b = await getLastBackupInfo();
    health.backup = {
      ok: b.ok,
      lastDate: b.lastDate,
      ageHours: b.ageHours,
      sizeMb: b.bytes ? Math.round((b.bytes / 1048576) * 10) / 10 : 0,
      count: b.count,
      mirrorConfigured: !!b.mirrorConfigured,
    };
    if (!b.ok) health.status = health.status === 'ok' ? 'degraded' : health.status;
  } catch {
    health.backup = { ok: false, lastDate: null, ageHours: null, sizeMb: 0, count: 0 };
    health.status = health.status === 'ok' ? 'degraded' : health.status;
  }

  // Fiškálny režim. Degradujeme len keď je Portos ZAPNUTÝ a profil sa reálne
  // nedá potvrdiť — pri PORTOS_ENABLED=false (e2e, dev bez fiškálu) sa
  // /health správa presne ako doteraz.
  health.fiscal = await collectFiscalHealth();
  const fiscalDegraded = health.fiscal.portosEnabled
    && (!health.fiscal.profileSync.trusted
      || health.fiscal.vatModeMismatch
      || health.fiscal.cashRegisterMatchesEnv === false
      || health.fiscal.error !== null);
  if (fiscalDegraded && health.status === 'ok') health.status = 'degraded';

  res.json(health);
});

export default router;

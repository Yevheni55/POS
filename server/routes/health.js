import { Router } from 'express';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import net from 'net';

const router = Router();
const START_TIME = Date.now();

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

  res.json(health);
});

export default router;

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

  res.json(health);
});

export default router;

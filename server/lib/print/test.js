import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { printers } from '../../db/schema.js';
import { CMD, PRINTER_IP, PRINTER_PORT, localDateTime } from './format.js';
import { sendToPrinter } from './network.js';

// GET /api/print/test — test ALL active printers
export async function testHandler(req, res) {
  try {
    const activePrinters = await db.select().from(printers).where(eq(printers.active, true));
    const results = [];

    if (activePrinters.length === 0) {
      // Fallback to .env printer
      let ticket = CMD.INIT;
      ticket += CMD.ALIGN_CENTER;
      ticket += CMD.DOUBLE_SIZE;
      ticket += 'TEST TLACE\n';
      ticket += CMD.NORMAL_SIZE;
      ticket += CMD.LINE;
      ticket += 'Tlaciaren funguje!\n';
      ticket += localDateTime() + '\n';
      ticket += CMD.FEED;
      ticket += CMD.CUT;

      await sendToPrinter(ticket);
      return res.json({ ok: true, printer: PRINTER_IP + ':' + PRINTER_PORT });
    }

    for (const p of activePrinters) {
      let ticket = CMD.INIT;
      ticket += CMD.ALIGN_CENTER;
      ticket += CMD.DOUBLE_SIZE;
      ticket += 'TEST TLACE\n';
      ticket += CMD.NORMAL_SIZE;
      ticket += CMD.LINE;
      ticket += p.name + '\n';
      ticket += p.ip + ':' + p.port + '\n';
      ticket += 'Tlaciaren funguje!\n';
      ticket += localDateTime() + '\n';
      ticket += CMD.FEED;
      ticket += CMD.CUT;

      try {
        await sendToPrinter(ticket, p.ip, p.port);
        results.push({ id: p.id, name: p.name, ok: true });
      } catch (e) {
        results.push({ id: p.id, name: p.name, ok: false, error: e.message });
      }
    }

    const allOk = results.every(r => r.ok);
    res.status(allOk ? 200 : 207).json({ ok: allOk, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

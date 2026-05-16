import { localTimeHHMM } from './format.js';
import { getPrinterForDest } from './network.js';
import { sendOrQueue } from './queue.js';
import { buildLockCodeTicket } from './tickets.js';

// POST /api/print/lockcode — print lock code receipt
export async function lockCodeHandler(req, res) {
  try {
    const { code, validUntil, staffName } = req.body;
    const time = localTimeHHMM();

    const printer = await getPrinterForDest('uctenka');
    const ticket = buildLockCodeTicket({ code, validUntil, staffName, time });
    const result = await sendOrQueue('lockcode', ticket, printer.ip, printer.port);

    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Lock code print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

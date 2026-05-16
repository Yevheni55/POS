import { localDateTime, localTimeHHMM } from './format.js';
import { getPrinterForDest } from './network.js';
import { sendOrQueue } from './queue.js';
import { buildParagonTicket } from './tickets.js';

// POST /api/print/paragon — print manual paragón po jeho vystavení
export async function paragonHandler(req, res) {
  try {
    const { paragonNumber, tableName, staffName, items, total, vatRate, method, companyName } = req.body || {};
    if (!paragonNumber || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Chyba paragonNumber alebo items' });
    }
    const time = localTimeHHMM();
    const dateStr = localDateTime();
    const printer = await getPrinterForDest('uctenka');
    const ticket = buildParagonTicket({
      paragonNumber,
      tableName,
      staffName,
      items,
      total: Number(total) || 0,
      vatRate: typeof vatRate === 'number' ? vatRate : null,
      method: method || 'hotovost',
      time,
      dateStr,
      companyName,
    });
    const result = await sendOrQueue('paragon', ticket, printer.ip, printer.port);
    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Paragon print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

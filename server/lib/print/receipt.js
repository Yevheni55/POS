import { localTimeHHMM } from './format.js';
import { getPrinterForDest } from './network.js';
import { sendOrQueue } from './queue.js';
import { buildReceiptTicket } from './tickets.js';

// POST /api/print/receipt — print customer receipt
export async function receiptHandler(req, res) {
  try {
    const { tableName, staffName, items, total, method, orderNum } = req.body;
    const time = localTimeHHMM();

    const printer = await getPrinterForDest('uctenka');
    const ticket = buildReceiptTicket({ tableName, staffName, items, total, method, time, orderNum });
    const result = await sendOrQueue('receipt', ticket, printer.ip, printer.port);

    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

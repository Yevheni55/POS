import { localTimeHHMM } from './format.js';
import { getPrinterForDest } from './network.js';
import { sendOrQueue } from './queue.js';
import { buildKitchenTicket } from './tickets.js';

// POST /api/print/kitchen — print kitchen/bar bon
export async function kitchenHandler(req, res) {
  try {
    const { dest, tableName, staffName, items, orderNum } = req.body;
    const time = localTimeHHMM();

    const printerDest = dest === 'KUCHYNA' || dest === 'STORNO KUCHYNA' ? 'kuchyna' : 'bar';
    const printer = await getPrinterForDest(printerDest);
    const ticket = buildKitchenTicket({ dest, tableName, staffName, items, orderNum, time });
    const result = await sendOrQueue('kitchen', ticket, printer.ip, printer.port);

    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

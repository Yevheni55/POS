import { localTimeHHMM } from './format.js';
import { getPrinterForDest } from './network.js';
import { sendOrQueue } from './queue.js';
import { buildPreBillTicket } from './tickets.js';

// POST /api/print/pre-bill — informatívny predúčet, NIE fiškálny blocek.
// Volá sa keď zákazník chce vidieť účet pred platbou (klasický restauračný
// flow: "Účet prosím" → čašník donesie predúčet → zákazník skontroluje +
// vyberie platobnú metódu → čašník stlačí Hotovosť/Karta → fiškálny blocek).
//
// NEROBÍ:
//   - žiadny Portos roundtrip (nie je to fiškálny doklad)
//   - žiadnu zmenu stavu objednávky (status ostane open)
//   - žiadne logovanie do fiscal_documents
//
// Endpoint je side-effect-free — môžeš predúčet vytlačiť viackrát bez problému.
export async function preBillHandler(req, res) {
  try {
    const { tableName, staffName, items, total, subtotal, discount, orderNum } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Prazdna objednavka — nie je co tlacit' });
    }
    const time = localTimeHHMM();
    const printer = await getPrinterForDest('uctenka');
    const ticket = buildPreBillTicket({
      tableName,
      staffName,
      items,
      total: Number(total) || 0,
      subtotal: Number(subtotal) || Number(total) || 0,
      discount: Number(discount) || 0,
      time,
      orderNum,
    });
    const result = await sendOrQueue('pre-bill', ticket, printer.ip, printer.port);
    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Pre-bill print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

import { Router } from 'express';
import net from 'net';
import { db } from '../db/index.js';
import { printers, printQueue } from '../db/schema.js';
import { eq, and, lte } from 'drizzle-orm';

const router = Router();
const PRINTER_IP = process.env.PRINTER_IP || '192.168.0.106';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9100');

const RETRY_INTERVAL_MS = 15_000;   // check queue every 15s
const MAX_RETRY_ATTEMPTS = 50;      // give up after 50 tries (~12 min)

// ESC/POS commands
const ESC = '\x1B';
const GS = '\x1D';
const CMD = {
  INIT: ESC + '@',
  BOLD_ON: ESC + 'E\x01',
  BOLD_OFF: ESC + 'E\x00',
  ALIGN_CENTER: ESC + 'a\x01',
  ALIGN_LEFT: ESC + 'a\x00',
  DOUBLE_SIZE: GS + '!\x11',
  NORMAL_SIZE: GS + '!\x00',
  LARGE_SIZE: GS + '!\x01',
  CUT: GS + 'V\x00',
  FEED: ESC + 'd\x03',
  LINE: '--------------------------------\n',
  DASHED: '- - - - - - - - - - - - - - - -\n',
};

function sendToPrinter(data, ip, port) {
  const targetIp = ip || PRINTER_IP;
  const targetPort = port || PRINTER_PORT;
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(targetPort, targetIp, () => {
      client.write(Buffer.from(data, 'binary'), () => {
        client.end();
        resolve(true);
      });
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Tlaciaren neodpoveda (timeout)'));
    });

    client.on('error', (err) => {
      reject(new Error('Chyba tlaciarni: ' + err.message));
    });

    client.on('close', () => resolve(true));
  });
}

async function getPrinterForDest(dest) {
  try {
    // Try exact match first
    let [printer] = await db.select().from(printers)
      .where(and(eq(printers.dest, dest), eq(printers.active, true))).limit(1);
    // Fallback to 'all' printer
    if (!printer) {
      [printer] = await db.select().from(printers)
        .where(and(eq(printers.dest, 'all'), eq(printers.active, true))).limit(1);
    }
    // Final fallback to .env
    if (!printer) {
      return { ip: process.env.PRINTER_IP || '192.168.0.107', port: parseInt(process.env.PRINTER_PORT || '9100') };
    }
    return { ip: printer.ip, port: printer.port };
  } catch (e) {
    console.error('getPrinterForDest error:', e.message);
    return { ip: process.env.PRINTER_IP || '192.168.0.107', port: parseInt(process.env.PRINTER_PORT || '9100') };
  }
}

// ===== Print Queue: queue on failure, auto-retry when printer is back =====

async function sendOrQueue(endpoint, ticketData, printerIp, printerPort) {
  try {
    await sendToPrinter(ticketData, printerIp, printerPort);
    return { ok: true };
  } catch (e) {
    // Printer offline — save to queue (base64 because ESC/POS has null bytes)
    await db.insert(printQueue).values({
      endpoint,
      payload: Buffer.from(ticketData, 'binary').toString('base64'),
      printerIp: printerIp || PRINTER_IP,
      printerPort: printerPort || PRINTER_PORT,
      attempts: 1,
      lastError: e.message.slice(0, 300),
      status: 'pending',
    });
    console.log(`[PrintQueue] Queued ${endpoint} job for ${printerIp}:${printerPort} — ${e.message}`);
    return { ok: false, queued: true, error: e.message };
  }
}

function checkPrinterOnline(ip, port) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(3000);
    client.connect(port, ip, () => { client.destroy(); resolve(true); });
    client.on('timeout', () => { client.destroy(); resolve(false); });
    client.on('error', () => { client.destroy(); resolve(false); });
  });
}

let _retryRunning = false;
async function processQueue() {
  if (_retryRunning) return;
  _retryRunning = true;
  try {
    const jobs = await db.select().from(printQueue)
      .where(and(eq(printQueue.status, 'pending'), lte(printQueue.nextRetryAt, new Date())))
      .limit(20);

    if (!jobs.length) return;

    // Group by printer to avoid hammering a dead printer
    const byPrinter = {};
    for (const job of jobs) {
      const key = job.printerIp + ':' + job.printerPort;
      if (!byPrinter[key]) byPrinter[key] = { ip: job.printerIp, port: job.printerPort, jobs: [] };
      byPrinter[key].jobs.push(job);
    }

    for (const printer of Object.values(byPrinter)) {
      const online = await checkPrinterOnline(printer.ip, printer.port);
      if (!online) {
        // Bump retry time for all jobs on this printer
        for (const job of printer.jobs) {
          const nextAttempts = job.attempts + 1;
          if (nextAttempts >= MAX_RETRY_ATTEMPTS) {
            await db.update(printQueue).set({ status: 'failed', attempts: nextAttempts })
              .where(eq(printQueue.id, job.id));
            console.log(`[PrintQueue] Job #${job.id} gave up after ${nextAttempts} attempts`);
          } else {
            await db.update(printQueue).set({
              attempts: nextAttempts,
              nextRetryAt: new Date(Date.now() + RETRY_INTERVAL_MS),
            }).where(eq(printQueue.id, job.id));
          }
        }
        continue;
      }

      // Printer is online — flush jobs in order
      for (const job of printer.jobs) {
        try {
          const ticketData = Buffer.from(job.payload, 'base64').toString('binary');
          await sendToPrinter(ticketData, job.printerIp, job.printerPort);
          await db.update(printQueue).set({ status: 'done' }).where(eq(printQueue.id, job.id));
          console.log(`[PrintQueue] Job #${job.id} (${job.endpoint}) printed successfully`);
        } catch (e) {
          const nextAttempts = job.attempts + 1;
          await db.update(printQueue).set({
            attempts: nextAttempts,
            lastError: e.message.slice(0, 300),
            nextRetryAt: new Date(Date.now() + RETRY_INTERVAL_MS),
            status: nextAttempts >= MAX_RETRY_ATTEMPTS ? 'failed' : 'pending',
          }).where(eq(printQueue.id, job.id));
          break; // printer went offline again, skip remaining
        }
      }
    }
  } catch (e) {
    console.error('[PrintQueue] processQueue error:', e.message);
  } finally {
    _retryRunning = false;
  }
}

let _queueInterval = null;
export function startPrintQueue() {
  if (_queueInterval) return;
  _queueInterval = setInterval(processQueue, RETRY_INTERVAL_MS);
  console.log(`[PrintQueue] Worker started (every ${RETRY_INTERVAL_MS / 1000}s)`);
}

// ===== Ticket builders =====

function buildKitchenTicket({ dest, tableName, staffName, items, orderNum, time }) {
  let ticket = '';
  ticket += CMD.INIT;

  // Header
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.DOUBLE_SIZE;
  ticket += dest + '\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.DASHED;

  // Table + Time
  ticket += CMD.LARGE_SIZE;
  ticket += CMD.BOLD_ON;
  ticket += tableName + '\n';
  ticket += CMD.BOLD_OFF;
  ticket += CMD.NORMAL_SIZE;
  ticket += time + '  |  ' + staffName + '\n';
  if (orderNum) ticket += '#' + orderNum + '\n';
  ticket += CMD.DASHED;

  // Items
  ticket += CMD.ALIGN_LEFT;
  items.forEach(item => {
    ticket += CMD.BOLD_ON;
    ticket += CMD.LARGE_SIZE;
    ticket += ' ' + item.qty + 'x  ' + item.name + '\n';
    ticket += CMD.NORMAL_SIZE;
    ticket += CMD.BOLD_OFF;
    if (item.note) {
      ticket += '      >> ' + item.note + '\n';
    }
  });

  // Footer
  ticket += CMD.DASHED;
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.NORMAL_SIZE;
  ticket += 'NOVE POLOZKY\n';
  ticket += CMD.FEED;
  ticket += CMD.CUT;

  return ticket;
}

function buildReceiptTicket({ tableName, staffName, items, total, method, time, orderNum }) {
  let ticket = '';
  ticket += CMD.INIT;

  // Header
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.DOUBLE_SIZE;
  ticket += 'UCTENKA\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.LINE;
  ticket += tableName + '  |  ' + time + '\n';
  ticket += 'Cisnik: ' + staffName + '\n';
  if (orderNum) ticket += 'Obj. #' + orderNum + '\n';
  ticket += CMD.LINE;

  // Items
  ticket += CMD.ALIGN_LEFT;
  items.forEach(item => {
    const price = (item.price * item.qty).toFixed(2).replace('.', ',') + ' E';
    const line = ' ' + item.qty + 'x ' + item.name;
    const pad = 32 - line.length - price.length;
    ticket += line + (pad > 0 ? ' '.repeat(pad) : '  ') + price + '\n';
  });

  // Total
  ticket += CMD.LINE;
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.BOLD_ON;
  ticket += CMD.DOUBLE_SIZE;
  ticket += 'CELKOM: ' + total.toFixed(2).replace('.', ',') + ' EUR\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.BOLD_OFF;
  ticket += 'Platba: ' + method.toUpperCase() + '\n';
  ticket += CMD.DASHED;
  ticket += 'Dakujeme za navstevu!\n';

  // WC kod — na konci uctenky vytlacit "#" velkym pismom centrovane
  ticket += CMD.FEED;
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.DOUBLE_SIZE;
  ticket += CMD.BOLD_ON;
  ticket += '#\n';
  ticket += CMD.BOLD_OFF;
  ticket += CMD.NORMAL_SIZE;

  ticket += CMD.FEED;
  ticket += CMD.CUT;

  return ticket;
}

// POST /api/print/kitchen — print kitchen/bar bon
router.post('/kitchen', async (req, res) => {
  try {
    const { dest, tableName, staffName, items, orderNum } = req.body;
    const now = new Date();
    const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    const printerDest = dest === 'KUCHYNA' || dest === 'STORNO KUCHYNA' ? 'kuchyna' : 'bar';
    const printer = await getPrinterForDest(printerDest);
    const ticket = buildKitchenTicket({ dest, tableName, staffName, items, orderNum, time });
    const result = await sendOrQueue('kitchen', ticket, printer.ip, printer.port);

    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Print error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/print/receipt — print customer receipt
router.post('/receipt', async (req, res) => {
  try {
    const { tableName, staffName, items, total, method, orderNum } = req.body;
    const now = new Date();
    const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    const printer = await getPrinterForDest('uctenka');
    const ticket = buildReceiptTicket({ tableName, staffName, items, total, method, time, orderNum });
    const result = await sendOrQueue('receipt', ticket, printer.ip, printer.port);

    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Print error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/print/z-report — print Z-report
router.post('/z-report', async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Chyba datum' });

    // Fetch Z-report data from internal API logic
    const reportRes = await fetch(`http://localhost:${process.env.PORT || 3080}/api/reports/z-report?date=${date}`, {
      headers: { 'Authorization': req.headers.authorization },
    });
    if (!reportRes.ok) {
      const err = await reportRes.json().catch(() => ({}));
      return res.status(500).json({ error: err.error || 'Nepodarilo sa nacitat Z-report' });
    }
    const data = await reportRes.json();

    const printer = await getPrinterForDest('uctenka');
    const ticket = buildZReportTicket(data);
    const result = await sendOrQueue('z-report', ticket, printer.ip, printer.port);
    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Z-report print error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function formatEur(num) {
  return num.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function padLine(left, right, width) {
  width = width || 32;
  const pad = width - left.length - right.length;
  return left + (pad > 0 ? ' '.repeat(pad) : '  ') + right;
}

function buildZReportTicket(data) {
  let t = '';
  t += CMD.INIT;

  // Header
  t += CMD.ALIGN_CENTER;
  t += CMD.BOLD_ON;
  t += '================================\n';
  t += CMD.DOUBLE_SIZE;
  t += 'DENNA UZAVIERKA\n';
  t += 'Z-REPORT\n';
  t += CMD.NORMAL_SIZE;
  t += CMD.BOLD_OFF;
  t += '================================\n';

  // Date
  const parts = data.date.split('-');
  const dateFormatted = parts[2] + '.' + parts[1] + '.' + parts[0];
  t += 'Datum: ' + dateFormatted + '\n';
  t += '\n';

  // TRZBA section
  t += CMD.BOLD_ON;
  t += 'TRZBA\n';
  t += CMD.BOLD_OFF;
  t += CMD.LINE;
  t += CMD.ALIGN_LEFT;
  t += padLine('Celkom:', formatEur(data.totalRevenue) + ' EUR') + '\n';
  (data.paymentMethods || []).forEach(pm => {
    const label = pm.method.charAt(0).toUpperCase() + pm.method.slice(1) + ':';
    t += padLine(label, formatEur(pm.total) + ' EUR') + '\n';
  });
  t += CMD.LINE;

  // OBJEDNAVKY section
  t += '\n';
  t += CMD.BOLD_ON;
  t += 'OBJEDNAVKY\n';
  t += CMD.BOLD_OFF;
  t += padLine('Pocet:', String(data.totalOrders)) + '\n';
  t += padLine('Poloziek:', String(data.totalItems)) + '\n';
  t += padLine('Priemerna obj.:', formatEur(data.averageOrder) + ' EUR') + '\n';
  if (data.cancelledItems > 0) {
    t += padLine('Storna:', data.cancelledItems + ' (-' + formatEur(data.cancelledTotal) + ' EUR)') + '\n';
  } else {
    t += padLine('Storna:', '0') + '\n';
  }

  // KATEGORIE section
  t += '\n';
  t += CMD.BOLD_ON;
  t += 'KATEGORIE\n';
  t += CMD.BOLD_OFF;
  t += CMD.LINE;
  (data.categoryBreakdown || []).forEach(cat => {
    const right = formatEur(cat.total) + ' EUR ' + cat.count + 'x';
    t += padLine(cat.category, right) + '\n';
  });

  // TOP POLOZKY section
  t += '\n';
  t += CMD.BOLD_ON;
  t += 'TOP POLOZKY\n';
  t += CMD.BOLD_OFF;
  t += CMD.LINE;
  (data.topItems || []).forEach((item, i) => {
    const rank = (i + 1) + '. ';
    t += padLine(rank + item.name, item.qty + 'x') + '\n';
  });

  // Footer
  t += '\n';
  t += CMD.ALIGN_CENTER;
  t += CMD.BOLD_ON;
  t += '================================\n';
  t += 'UZAVIERKA DOKONCENA\n';
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  t += time + '\n';
  t += '================================\n';
  t += CMD.BOLD_OFF;
  t += CMD.FEED;
  t += CMD.CUT;

  return t;
}

function buildLockCodeTicket({ code, validUntil, staffName, time }) {
  let t = '';
  t += CMD.INIT;

  // Top border
  t += CMD.ALIGN_CENTER;
  t += CMD.BOLD_ON;
  t += '================================\n';
  t += CMD.DOUBLE_SIZE;
  t += 'KOD ZAMKU\n';
  t += CMD.NORMAL_SIZE;
  t += '================================\n';
  t += CMD.BOLD_OFF;
  t += '\n';

  // Big code display
  t += CMD.BOLD_ON;
  t += CMD.DOUBLE_SIZE;
  // Add spacing between digits for readability
  const spaced = code.split('').join('  ');
  t += spaced + '\n';
  t += CMD.NORMAL_SIZE;
  t += CMD.BOLD_OFF;
  t += '\n';

  // Validity
  t += CMD.LINE;
  t += CMD.BOLD_ON;
  t += 'Platny do:\n';
  t += CMD.BOLD_OFF;
  t += validUntil + '\n';
  t += CMD.LINE;

  // Footer info
  t += '\n';
  t += time + '  |  ' + staffName + '\n';
  t += '\n';
  t += CMD.BOLD_ON;
  t += '================================\n';
  t += CMD.BOLD_OFF;

  t += CMD.FEED;
  t += CMD.CUT;

  return t;
}

// POST /api/print/wc-code — print a small "#" slip after the customer's
// fiscal receipt (Portos prints its own receipt on the same printer; this is
// a follow-up slip the customer takes to the WC).
function buildWcCodeTicket() {
  let t = '';
  t += CMD.INIT;
  t += CMD.ALIGN_CENTER;
  t += CMD.DOUBLE_SIZE;
  t += CMD.BOLD_ON;
  t += '#\n';
  t += CMD.BOLD_OFF;
  t += CMD.NORMAL_SIZE;
  t += CMD.FEED;
  t += CMD.CUT;
  return t;
}
router.post('/wc-code', async (req, res) => {
  try {
    const printer = await getPrinterForDest('uctenka');
    const ticket = buildWcCodeTicket();
    const result = await sendOrQueue('wc-code', ticket, printer.ip, printer.port);
    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('WC code print error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/print/lockcode — print lock code receipt
router.post('/lockcode', async (req, res) => {
  try {
    const { code, validUntil, staffName } = req.body;
    const now = new Date();
    const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    const printer = await getPrinterForDest('uctenka');
    const ticket = buildLockCodeTicket({ code, validUntil, staffName, time });
    const result = await sendOrQueue('lockcode', ticket, printer.ip, printer.port);

    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Lock code print error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/print/test — test ALL active printers
router.get('/test', async (req, res) => {
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
      ticket += new Date().toLocaleString('sk-SK') + '\n';
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
      ticket += new Date().toLocaleString('sk-SK') + '\n';
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
});

// GET /api/print/queue — view pending print jobs
router.get('/queue', async (req, res) => {
  try {
    const pending = await db.select().from(printQueue)
      .where(eq(printQueue.status, 'pending'))
      .orderBy(printQueue.createdAt);
    res.json({ count: pending.length, jobs: pending });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/print/queue/retry — force retry all pending jobs now
router.post('/queue/retry', async (req, res) => {
  try {
    await db.update(printQueue)
      .set({ nextRetryAt: new Date() })
      .where(eq(printQueue.status, 'pending'));
    processQueue();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/print/queue/:id — remove a queued job
router.delete('/queue/:id', async (req, res) => {
  try {
    await db.delete(printQueue).where(eq(printQueue.id, parseInt(req.params.id)));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

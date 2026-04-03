import { Router } from 'express';
import net from 'net';
import { db } from '../db/index.js';
import { printers } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const router = Router();

// ESC/POS commands (duplicated for test print)
const ESC = '\x1B';
const GS = '\x1D';
const CMD = {
  INIT: ESC + '@',
  ALIGN_CENTER: ESC + 'a\x01',
  DOUBLE_SIZE: GS + '!\x11',
  NORMAL_SIZE: GS + '!\x00',
  LINE: '--------------------------------\n',
  FEED: ESC + 'd\x03',
  CUT: GS + 'V\x00',
};

function sendToPrinter(data, ip, port) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(port, ip, () => {
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

// GET /api/printers — list all printers
router.get('/', async (req, res) => {
  try {
    const all = await db.select().from(printers);
    res.json(all);
  } catch (e) {
    console.error('List printers error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/printers — add printer
router.post('/', async (req, res) => {
  try {
    const { name, ip, port, dest, active } = req.body;
    if (!name || !ip) {
      return res.status(400).json({ error: 'Nazov a IP su povinne' });
    }
    const [created] = await db.insert(printers).values({
      name,
      ip,
      port: port || 9100,
      dest: dest || 'all',
      active: active !== undefined ? active : true,
    }).returning();
    res.json(created);
  } catch (e) {
    console.error('Add printer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/printers/:id — update printer
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, ip, port, dest, active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (ip !== undefined) updates.ip = ip;
    if (port !== undefined) updates.port = port;
    if (dest !== undefined) updates.dest = dest;
    if (active !== undefined) updates.active = active;

    const [updated] = await db.update(printers)
      .set(updates)
      .where(eq(printers.id, id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: 'Tlaciaren nenajdena' });
    }
    res.json(updated);
  } catch (e) {
    console.error('Update printer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/printers/:id — delete printer
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [deleted] = await db.delete(printers)
      .where(eq(printers.id, id))
      .returning();

    if (!deleted) {
      return res.status(404).json({ error: 'Tlaciaren nenajdena' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete printer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/printers/:id/test — test print on specific printer
router.post('/:id/test', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [printer] = await db.select().from(printers).where(eq(printers.id, id)).limit(1);

    if (!printer) {
      return res.status(404).json({ error: 'Tlaciaren nenajdena' });
    }

    let ticket = CMD.INIT;
    ticket += CMD.ALIGN_CENTER;
    ticket += CMD.DOUBLE_SIZE;
    ticket += 'TEST TLACE\n';
    ticket += CMD.NORMAL_SIZE;
    ticket += CMD.LINE;
    ticket += printer.name + '\n';
    ticket += printer.ip + ':' + printer.port + '\n';
    ticket += 'Ucel: ' + printer.dest + '\n';
    ticket += CMD.LINE;
    ticket += 'Tlaciaren funguje!\n';
    ticket += new Date().toLocaleString('sk-SK') + '\n';
    ticket += CMD.FEED;
    ticket += CMD.CUT;

    await sendToPrinter(ticket, printer.ip, printer.port);
    res.json({ ok: true, printer: printer.ip + ':' + printer.port });
  } catch (e) {
    console.error('Test printer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;

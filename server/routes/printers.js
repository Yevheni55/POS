import { Router } from 'express';
import net from 'net';
import { db } from '../db/index.js';
import { printers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();

// SEC: /:id/test otvara TCP spojenie na adresu z DB. Bez tohto filtra by
// cisnik (alebo ktokolvek s pristupom k zapisu tlaciarni) mohol pouzit
// endpoint ako port-scanner do tailnetu/internetu. Povolujeme iba RFC-1918
// privatne rozsahy — realne tlaciarne su na 192.168.x.x (viz .env PRINTER_IP).
// POZN: rovnaka logika je v server/lib/cors-origin.js (isPrivateLanHostname),
// ale tam nie je exportovana — pri exporte sem dotiahnut import a zmazat kopiu.
function isPrivateLanIp(ip) {
  if (!ip) return false;
  const host = String(ip).trim();
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const m = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 16 && n <= 31;
  }
  return false;
}

function isValidPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

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

// GET /api/printers — list.
// Čašník dostane len to, čo POS naozaj potrebuje (id/name/dest/active); IP
// a port sú sieťová topológia prevádzky a idú len manažérovi, ktorý ich
// aj naozaj edituje v admine. Predtým dostal celé riadky ktokoľvek s JWT.
router.get('/', async (req, res) => {
  try {
    const all = await db.select().from(printers);
    const role = req.user && req.user.role;
    if (role === 'manazer' || role === 'admin') return res.json(all);
    res.json(all.map((p) => ({
      id: p.id, name: p.name, dest: p.dest, active: p.active,
    })));
  } catch (e) {
    console.error('List printers error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/printers — add printer (manazer+admin)
// SEC: zapis do tlaciarni = kam idu bony (kuchyna/bar). Cisnik to nesmie
// prepisat — inak by si vedel presmerovat tlac mimo prevadzku.
router.post('/', requireRole('manazer', 'admin'), async (req, res) => {
  try {
    const { name, ip, port, dest, active } = req.body;
    if (!name || !ip) {
      return res.status(400).json({ error: 'Nazov a IP su povinne' });
    }
    // Validujeme UŽ PRI ZÁPISE, nie až v /test. Inak sa dá do DB uložiť
    // ľubovoľná adresa a endpoint /test ju potom poslušne skúsi otvoriť —
    // filter na čítaní by sa dal obísť zápisom.
    if (!isPrivateLanIp(ip)) {
      return res.status(400).json({ error: 'Neplatna adresa tlaciarni — povolene su len LAN adresy (192.168.x.x, 10.x.x.x, 172.16-31.x.x)' });
    }
    if (port !== undefined && port !== null && !isValidPort(port)) {
      return res.status(400).json({ error: 'Neplatny port' });
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

// PUT /api/printers/:id — update printer (manazer+admin)
router.put('/:id', requireRole('manazer', 'admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, ip, port, dest, active } = req.body;
    // Rovnaká validácia ako pri POST — bez nej sa dá obmedzenie obísť úpravou
    // existujúceho riadku.
    if (ip !== undefined && !isPrivateLanIp(ip)) {
      return res.status(400).json({ error: 'Neplatna adresa tlaciarni — povolene su len LAN adresy (192.168.x.x, 10.x.x.x, 172.16-31.x.x)' });
    }
    if (port !== undefined && port !== null && !isValidPort(port)) {
      return res.status(400).json({ error: 'Neplatny port' });
    }
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

// DELETE /api/printers/:id — delete printer (manazer+admin)
router.delete('/:id', requireRole('manazer', 'admin'), async (req, res) => {
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

// POST /api/printers/:id/test — test print on specific printer (manazer+admin)
router.post('/:id/test', requireRole('manazer', 'admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [printer] = await db.select().from(printers).where(eq(printers.id, id)).limit(1);

    if (!printer) {
      return res.status(404).json({ error: 'Tlaciaren nenajdena' });
    }

    // SEC: iba LAN ciel a platny port — inak by test bol port-scanner.
    if (!isPrivateLanIp(printer.ip) || !isValidPort(printer.port)) {
      return res.status(400).json({ error: 'Neplatna adresa tlaciarni (povolena je iba lokalna siet)' });
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
    // SEC: jednotna hlaska — rozlisenie "refused" vs "timeout" by z endpointu
    // spravilo port-scan oracle. Detail ostava iba v server logu.
    console.error('Test printer error:', e.message);
    res.status(500).json({ error: 'Test tlace zlyhal' });
  }
});

export default router;

// Zber chýb z prehliadača (POS tablet / admin / dochádzkový terminál).
//
// PREČO: kasa beží na tablete ako fullscreen PWA. Keď čašník povie „kasa
// nešla", nedá sa to nijako dohľadať — DevTools tam nikto neotvorí a v repe
// nebol JEDINÝ `window.onerror` ani `unhandledrejection` handler. Chyba, ktorá
// zabije render, tak zmizne bez stopy.
//
// Zámerne minimalistické:
//   - bez DB (chybová smršť by zaplavila tabuľku a spomalila kasu),
//   - kruhový buffer v pamäti + zápis do stdout (docker logs to zachytí),
//   - bez auth na zápise: chyba môže nastať aj pred prihlásením,
//   - tvrdý strop na veľkosť aj frekvenciu, nech sa z toho nedá spraviť DoS.
//
// Čítanie je manazer+ a slúži na to, aby sa majiteľ vedel pozrieť bez SSH.

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();

const MAX_BUFFER = 200;         // koľko posledných chýb držíme
const MAX_FIELD = 500;          // strop na dĺžku jedného poľa
const MAX_PER_MINUTE = 60;      // strop proti smršti z jedného klienta

/** @type {Array<object>} kruhový buffer, najnovšie na konci */
const buffer = [];

// jednoduchý per-IP počítač v rámci minúty
const rate = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const slot = Math.floor(now / 60000);
  const cur = rate.get(ip);
  if (!cur || cur.slot !== slot) {
    rate.set(ip, { slot, count: 1 });
    // upratovanie, nech mapa nerastie donekonečna
    if (rate.size > 500) {
      for (const [k, v] of rate) if (v.slot !== slot) rate.delete(k);
    }
    return false;
  }
  cur.count += 1;
  return cur.count > MAX_PER_MINUTE;
}

function clip(v) {
  if (v == null) return null;
  const s = String(v);
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + '…' : s;
}

// POST /api/client-errors — bez auth zámerne (chyba môže nastať pred loginom).
// Klient posiela cez navigator.sendBeacon, takže odpoveď nikto nečíta → 204.
router.post('/', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (rateLimited(ip)) return res.status(204).end();

  const b = req.body || {};
  const entry = {
    at: new Date().toISOString(),
    ip,
    kind: clip(b.kind) || 'error',
    message: clip(b.message),
    source: clip(b.source),
    line: Number.isFinite(Number(b.line)) ? Number(b.line) : null,
    col: Number.isFinite(Number(b.col)) ? Number(b.col) : null,
    stack: clip(b.stack),
    url: clip(b.url),
    userAgent: clip(req.headers['user-agent']),
    staff: clip(b.staff),
    appVersion: clip(b.appVersion),
  };

  buffer.push(entry);
  while (buffer.length > MAX_BUFFER) buffer.shift();

  // Do stdout, nech to zachytí `docker logs` aj po reštarte kontajnera.
  console.error(
    '[client-error]',
    entry.kind,
    '|', entry.staff || 'anon',
    '|', entry.url || '-',
    '|', entry.message || '-',
    entry.source ? '(' + entry.source + ':' + entry.line + ':' + entry.col + ')' : ''
  );

  res.status(204).end();
});

// GET /api/client-errors — manažér si to pozrie z admina, bez SSH na kasu.
router.get('/', auth, requireRole('manazer', 'admin'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, MAX_BUFFER);
  res.json({
    total: buffer.length,
    errors: buffer.slice(-limit).reverse(),
  });
});

export default router;

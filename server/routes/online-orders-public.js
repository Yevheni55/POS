// Verejné API pre objednávky s doručením (web surfspirit.sk / web/objednat.html).
// Bez JWT — chráni ho validácia, rate-limit podľa IP a to, že ceny sa VŽDY
// berú z DB, nikdy z klienta. Montuje sa PRED auth aj idempotency middleware.
import { Router } from 'express';
import { db } from '../db/index.js';
import { menuItems, onlineOrders, onlineOrderEvents } from '../db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { asyncRoute } from '../lib/async-route.js';
import { emitEvent } from '../lib/emit.js';
import {
  woltConfig, requestShipmentPromise, verifyWebhookToken, WoltError,
} from '../lib/wolt-drive.js';
import { applyWoltEvent } from '../lib/online-order-status.js';
import { quoteSchema, createOnlineOrderSchema, woltWebhookSchema } from '../schemas/online-orders.js';

const router = Router();

// ── Rate limit podľa IP (in-memory; jedna inštancia servera) ────────────────
const _hits = new Map(); // key -> [timestamps]
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (_hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  _hits.set(key, arr);
  if (_hits.size > 5000) _hits.clear(); // poistka proti rastu
  return true;
}
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '')
    .split(',')[0].trim().slice(0, 64);
}

// ── Cache prísľubov: cena doručenia sa do objednávky berie ODTIAĽTO, nie z klienta ──
const _promises = new Map(); // id -> { feeEur, etaMinutes, validUntil, dropoff }
function rememberPromise(p) {
  _promises.set(p.id, p);
  if (_promises.size > 2000) {
    const now = Date.now();
    for (const [id, q] of _promises) if (!q.validUntil || new Date(q.validUntil).getTime() < now) _promises.delete(id);
  }
}
function promiseIsFresh(p) {
  return p && (!p.validUntil || new Date(p.validUntil).getTime() > Date.now() + 30_000);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez 0/O, 1/I
export function makePublicCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return 'SS-' + s;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function woltErrorResponse(res, e) {
  if (e instanceof WoltError) return res.status(e.status).json({ error: e.message });
  throw e;
}

function toPublic(o) {
  return {
    code: o.publicCode,
    status: o.status,
    createdAt: o.createdAt,
    items: o.items,
    subtotal: Number(o.subtotal),
    deliveryFee: Number(o.deliveryFee),
    total: Number(o.total),
    paymentMethod: o.paymentMethod,
    scheduledFor: o.scheduledFor,
    readyAt: o.readyAt || null,
    wolt: {
      status: o.woltStatus || null,
      trackingUrl: o.woltTrackingUrl || null,
    },
    rejectedReason: o.status === 'rejected' ? o.rejectedReason : undefined,
  };
}

// GET /config — čo má web ponúknuť (doručenie zapnuté? platby? min. objednávka)
router.get('/config', (req, res) => {
  const cfg = woltConfig();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    deliveryEnabled: cfg.enabled,
    mode: cfg.mode,
    paymentMethods: cfg.cashOnDelivery ? ['cash', 'transfer'] : ['transfer'],
    minOrderEur: Number(process.env.ONLINE_ORDER_MIN_EUR || 10),
    pickup: { name: cfg.pickup.name, street: cfg.pickup.street, city: cfg.pickup.city },
  });
});

// POST /quote — cena a čas doručenia na adresu
router.post('/quote', validate(quoteSchema), asyncRoute(async (req, res) => {
  if (!rateLimit('q:' + clientIp(req), 40, 10 * 60_000)) {
    return res.status(429).json({ error: 'Priveľa pokusov, skúste o chvíľu' });
  }
  try {
    const p = await requestShipmentPromise(req.body);
    rememberPromise(p);
    res.json({ promiseId: p.id, feeEur: p.feeEur, etaMinutes: p.etaMinutes, validUntil: p.validUntil, address: p.dropoff.formattedAddress });
  } catch (e) { return woltErrorResponse(res, e); }
}));

// POST / — vytvorí objednávku (stav new). Obsluha ju potvrdí v admine.
router.post('/', validate(createOnlineOrderSchema), asyncRoute(async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit('o:' + ip, 10, 60 * 60_000)) {
    return res.status(429).json({ error: 'Priveľa objednávok z tejto adresy, skúste neskôr' });
  }
  const cfg = woltConfig();
  if (!cfg.enabled) return res.status(503).json({ error: 'Doručenie momentálne nie je dostupné' });

  const body = req.body;
  if (body.paymentMethod === 'cash' && !cfg.cashOnDelivery) {
    return res.status(400).json({ error: 'Platba kuriérovi nie je dostupná, zvoľte platbu vopred' });
  }
  // Čas doručenia: buď „čo najskôr" (bez scheduledFor), alebo aspoň 45 min
  // dopredu a najviac 7 dní — kuchyňa musí stihnúť variť, Wolt plánuje max. dni.
  if (body.scheduledFor) {
    const t = new Date(body.scheduledFor).getTime();
    const minT = Date.now() + 45 * 60_000, maxT = Date.now() + 7 * 24 * 60 * 60_000;
    if (t < minT) return res.status(400).json({ error: 'Čas doručenia musí byť aspoň 45 minút dopredu' });
    if (t > maxT) return res.status(400).json({ error: 'Doručenie sa dá naplánovať najviac 7 dní dopredu' });
  }

  // Ceny a názvy z DB — klient posiela len id + množstvo.
  const ids = [...new Set(body.items.map((i) => i.menuItemId))];
  const rows = await db.select({
    id: menuItems.id, name: menuItems.name, price: menuItems.price, vatRate: menuItems.vatRate, active: menuItems.active,
  }).from(menuItems).where(inArray(menuItems.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id) || !byId.get(id).active);
  if (missing.length) {
    return res.status(400).json({ error: 'Niektoré položky už nie sú v ponuke', missingIds: missing });
  }
  const items = body.items.map((i) => {
    const m = byId.get(i.menuItemId);
    return { menuItemId: m.id, name: m.name, qty: i.qty, unitPrice: round2(m.price), vatRate: round2(m.vatRate), note: i.note || '' };
  });
  const subtotal = round2(items.reduce((s, it) => s + it.unitPrice * it.qty, 0));
  const minEur = Number(process.env.ONLINE_ORDER_MIN_EUR || 10);
  if (subtotal < minEur) return res.status(400).json({ error: `Minimálna objednávka je ${minEur.toFixed(2).replace('.', ',')} €` });

  // Prísľub doručenia: z cache (ak ho web získal cez /quote a ešte platí), inak nový.
  let promise = body.promiseId ? _promises.get(body.promiseId) : null;
  if (!promiseIsFresh(promise)) {
    try {
      promise = await requestShipmentPromise({ ...body.dropoff, scheduledFor: body.scheduledFor });
      rememberPromise(promise);
    } catch (e) { return woltErrorResponse(res, e); }
  }
  const deliveryFee = round2(promise.feeEur ?? 0);
  const total = round2(subtotal + deliveryFee);

  // Kód pre zákazníka — pri kolízii (32^5 kombinácií) skúsime znova.
  let created = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const publicCode = makePublicCode();
    try {
      [created] = await db.insert(onlineOrders).values({
        publicCode,
        status: 'new',
        customerName: body.customer.name,
        customerPhone: body.customer.phone,
        customerEmail: body.customer.email || '',
        dropoffStreet: body.dropoff.street,
        dropoffCity: body.dropoff.city,
        dropoffPostCode: body.dropoff.postCode,
        dropoffComment: body.dropoff.comment || '',
        dropoffLat: promise.dropoff?.lat ?? body.dropoff.lat ?? null,
        dropoffLon: promise.dropoff?.lon ?? body.dropoff.lon ?? null,
        items,
        subtotal: String(subtotal),
        deliveryFee: String(deliveryFee),
        total: String(total),
        paymentMethod: body.paymentMethod,
        note: body.note || '',
        scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
        woltPromiseId: promise.id,
        woltPromiseValidUntil: promise.validUntil ? new Date(promise.validUntil) : null,
        clientIp: ip,
      }).returning();
    } catch (e) {
      if (!/online_orders_public_code/.test(String(e.message))) throw e;
    }
  }
  if (!created) return res.status(500).json({ error: 'Nepodarilo sa vytvoriť objednávku, skúste znova' });

  await db.insert(onlineOrderEvents).values({ onlineOrderId: created.id, type: 'created', payload: { ip } });
  emitEvent(req, 'online-order:new', {
    id: created.id, code: created.publicCode, total, customerName: created.customerName, itemCount: items.length,
  }).catch(() => {});

  res.status(201).json({
    code: created.publicCode,
    status: created.status,
    subtotal, deliveryFee, total,
    etaMinutes: promise.etaMinutes,
    trackUrl: `/web/objednat.html?kod=${created.publicCode}`,
  });
}));

// GET /:code — stav objednávky pre zákazníka (sleduje ju na webe)
router.get('/:code', asyncRoute(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase().trim();
  if (!/^SS-[A-Z2-9]{5}$/.test(code)) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  const [o] = await db.select().from(onlineOrders).where(eq(onlineOrders.publicCode, code)).limit(1);
  if (!o) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(toPublic(o));
}));

// POST /wolt/webhook — udalosti kuriéra. Telo: { token: <JWT HS256> }.
router.post('/wolt/webhook', validate(woltWebhookSchema), asyncRoute(async (req, res) => {
  let ev;
  try { ev = verifyWebhookToken(req.body.token); } catch (e) { return woltErrorResponse(res, e); }
  const type = String(ev.type || '');
  const d = ev.details || {};
  const ref = d.wolt_order_reference_id || null;
  const code = d.merchant_order_reference_id || null;

  const [o] = await db.select().from(onlineOrders).where(
    ref ? eq(onlineOrders.woltOrderReferenceId, ref) : eq(onlineOrders.publicCode, String(code || '')),
  ).limit(1);
  // Neznámu objednávku potvrdíme 200 — Wolt by inak opakoval donekonečna.
  if (!o) return res.json({ ok: true, ignored: true });

  await applyWoltEvent(req.app.get('io'), o, type, d);
  res.json({ ok: true });
}));

export default router;

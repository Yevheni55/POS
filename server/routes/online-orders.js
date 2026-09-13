// Admin/POS strana online objednávok: zoznam, potvrdenie (→ POS účet na stole
// „Rozvoz" + kuriér z Woltu), odmietnutie, zrušenie kuriéra. Vyžaduje JWT +
// rolu manažér/admin (montuje sa za auth middlewarom).
import { Router } from 'express';
import { db } from '../db/index.js';
import { onlineOrders, onlineOrderEvents, orders, menuItems } from '../db/schema.js';
import { eq, and, or, inArray, desc, sql, notInArray, isNull, lt } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/requireRole.js';
import { asyncRoute } from '../lib/async-route.js';
import { emitEvent } from '../lib/emit.js';
import { woltConfig, cancelDelivery, WoltError } from '../lib/wolt-drive.js';
import { addEvent, fireOrder, dispatch, printKitchenBons, markCancelledByWolt } from '../lib/online-order-fire.js';
import {
  woltOrderConfig, acceptOrder, rejectOrder as woltRejectOrder, readyOrder as woltReadyOrder, deliveredOrder as woltDeliveredOrder,
  confirmPreorder, exchangeAuthCode, connectionStatus, WoltOrderError,
  normalizeOrder, buildOnlineOrderFromWolt, makeMenuResolver, statusForNotification,
} from '../lib/wolt-order-api.js';
import { confirmOnlineOrderSchema, rejectOnlineOrderSchema, listOnlineOrdersQuerySchema } from '../schemas/online-orders.js';

const router = Router();
// Potvrdiť, odmietnuť a označiť hotové smie ktokoľvek prihlásený (kuchár na
// KDS je bežný účet). Zásahy do kuriéra (znovu objednať, zrušiť) ostávajú
// manažérovi — stoja peniaze.
const mgr = requireRole('manazer', 'admin');

const ACTIVE = ['new', 'confirmed', 'dispatched'];

function woltErrorResponse(res, e) {
  if (e instanceof WoltError || e instanceof WoltOrderError) return res.status(e.status).json({ error: e.message, detail: e.detail || undefined });
  throw e;
}

router.get('/config', asyncRoute(async (req, res) => {
  const cfg = woltConfig();
  const w = woltOrderConfig();
  let woltOrders = { enabled: w.enabled, mode: w.mode, connected: false };
  if (w.enabled) { try { woltOrders = { ...woltOrders, ...(await connectionStatus(w)) }; } catch { /* bez DB info */ } }
  res.json({ enabled: cfg.enabled, mode: cfg.mode, cashOnDelivery: cfg.cashOnDelivery, pickup: cfg.pickup, minPrepMinutes: cfg.minPrepMinutes, woltOrders });
}));

// POST /wolt/mock-order — skúšobná objednávka „z aplikácie Wolt" (len v režime
// WOLT_ORDER_MODE=mock): náhodné položky z menu + jedna mimo kasy, aby bolo
// vidieť aj poznámku o nenamapovaných. Vznikne rovnako ako ostrá — lišta na
// kase, KDS, admin.
router.post('/wolt/mock-order', mgr, asyncRoute(async (req, res) => {
  if (woltOrderConfig().mode !== 'mock') return res.status(403).json({ error: 'Skúšobná objednávka funguje len v režime WOLT_ORDER_MODE=mock' });
  const wanted = String(req.body?.deliveryType || '');
  const deliveryType = ['homedelivery', 'takeaway', 'eatin'].includes(wanted) ? wanted : (Math.random() < 0.6 ? 'homedelivery' : 'takeaway');
  const menu = await db.select({ id: menuItems.id, name: menuItems.name, price: menuItems.price, vatRate: menuItems.vatRate })
    .from(menuItems).where(and(eq(menuItems.active, true), sql`${menuItems.price} >= 1.5`));
  if (menu.length < 2) return res.status(409).json({ error: 'V menu nie sú aspoň dve aktívne položky' });
  const pick = menu.slice().sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 2));
  const cents = (eur) => Math.round(Number(eur) * 100);
  const items = pick.map((m, i) => ({
    id: 'mock-i' + i, name: m.name, count: i === 0 ? 2 : 1, pos_id: String(m.id), sku: null,
    options: i === 0 ? [{ name: 'Poznámka', value: 'bez ľadu', price: { amount: 0 }, count: 1 }] : [],
    item_price: { unit_price: { amount: cents(m.price) }, total: { amount: cents(m.price) * (i === 0 ? 2 : 1) } },
  }));
  items.push({ id: 'mock-x', name: 'Wolt bonus dezert (mimo kasy)', count: 1, pos_id: null, sku: null, options: [], item_price: { unit_price: { amount: 320 }, total: { amount: 320 } } });
  const basket = items.reduce((s, it) => s + it.item_price.total.amount, 0);
  const fee = deliveryType === 'homedelivery' ? 290 : 0;
  const ref = 'mock-' + Date.now().toString(36);
  const names = ['Lucia', 'Peter', 'Zuzana', 'Marek', 'Katarína'];
  const raw = {
    id: ref, order_number: String(1000 + Math.floor(Math.random() * 9000)), order_status: 'received', type: 'instant',
    venue: { id: 'mock-venue', name: 'Surf Spirit Draždiak' },
    consumer_name: names[Math.floor(Math.random() * names.length)] + ' (skúška Wolt)', consumer_phone_number: '+421 900 000 000',
    consumer_comment: 'Skúšobná objednávka z aplikácie Wolt — neriešiť.',
    price: { amount: basket + fee, currency: 'EUR' }, basket_price: { total: { amount: basket, currency: 'EUR' } },
    fees: { delivery: { amount: fee, currency: 'EUR' } },
    delivery: deliveryType === 'homedelivery'
      ? { type: 'homedelivery', status: 'pending', location: { street_address: 'Jasovská 12', city: 'Bratislava', post_code: '851 07', formatted_address: 'Jasovská 12, 851 07 Bratislava', coordinates: { lat: 48.1122, lon: 17.1444 } } }
      : { type: deliveryType, status: 'pending' },
    pickup_eta: new Date(Date.now() + 20 * 60_000).toISOString(), created_at: new Date().toISOString(), items,
  };
  const values = buildOnlineOrderFromWolt(normalizeOrder(raw), makeMenuResolver(menu), raw);
  if (woltOrderConfig().acceptWindowS) values.acceptDeadlineAt = new Date(Date.now() + woltOrderConfig().acceptWindowS * 1000);
  let row;
  try { [row] = await db.insert(onlineOrders).values(values).returning(); }
  catch (e) {
    if (!/online_orders_public_code/.test(String(e.message))) throw e;
    values.publicCode = ('W-' + ref.slice(-5).toUpperCase()).slice(0, 12);
    [row] = await db.insert(onlineOrders).values(values).returning();
  }
  await addEvent(row.id, 'created', { source: 'wolt', mock: true, staffId: req.user.id });
  emitEvent(req, 'online-order:new', { id: row.id, code: row.publicCode, total: Number(row.total), customerName: row.customerName, itemCount: row.items.length, source: 'wolt' }).catch(() => {});
  res.status(201).json({ ok: true, order: row });
}));

// POST /:id/wolt-mock-status — simulácia notifikácie Woltu (DELIVERED / CANCELED /
// PRODUCTION / READY) v mock režime, aby sa dal prejsť celý cyklus bez Woltu.
router.post('/:id/wolt-mock-status', mgr, asyncRoute(async (req, res) => {
  if (woltOrderConfig().mode !== 'mock') return res.status(403).json({ error: 'Len v režime WOLT_ORDER_MODE=mock' });
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.source !== 'wolt') return res.status(409).json({ error: 'Nie je to objednávka z aplikácie Wolt' });
  const st = String(req.body?.status || 'DELIVERED').toUpperCase();
  const patch = { woltStatus: st.toLowerCase(), updatedAt: new Date() };
  const next = statusForNotification(st, oo.status);
  if (next && !['delivered', 'rejected', 'cancelled'].includes(oo.status)) {
    patch.status = next;
    if (next === 'rejected' && !oo.rejectedReason) patch.rejectedReason = 'Zrušené zo strany Woltu (simulácia)';
    if (next === 'confirmed' && !oo.confirmedAt) patch.confirmedAt = new Date();
  }
  if (st === 'READY' && !oo.readyAt) patch.readyAt = new Date();
  await db.update(onlineOrders).set(patch).where(eq(onlineOrders.id, id));
  await addEvent(id, 'wolt:' + st.toLowerCase(), { mock: true, staffId: req.user.id });
  if (patch.status === 'cancelled') await markCancelledByWolt(req.app.get('io'), oo, 'Zrušené zo strany Woltu (simulácia)');
  emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: patch.status || oo.status, woltStatus: patch.woltStatus }).catch(() => {});
  const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  res.json({ ok: true, order: row });
}));

// POST /wolt/oauth/code — ručné vloženie authorization code (keď presmerovanie
// nejde cez web); bežne ho prevezme most z Neon sám.
router.post('/wolt/oauth/code', mgr, asyncRoute(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Chýba code' });
  try { await exchangeAuthCode(code); } catch (e) { return woltErrorResponse(res, e); }
  res.json({ ok: true });
}));

// GET / ?status=new|active|done|all
router.get('/', asyncRoute(async (req, res) => {
  // validate() rieši len body — query si prejdeme tou istou schémou ručne.
  const parsed = listOnlineOrdersQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Neplatné parametre' });
  const { status, limit } = parsed.data;
  let where;
  if (status === 'new') where = eq(onlineOrders.status, 'new');
  else if (status === 'active') where = inArray(onlineOrders.status, ACTIVE);
  else if (status === 'done') where = notInArray(onlineOrders.status, ACTIVE);
  const rows = await db.select().from(onlineOrders)
    .where(where).orderBy(desc(onlineOrders.createdAt)).limit(Number(limit) || 100);
  const countsRes = await db.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'new')::int AS new,
           count(*) FILTER (WHERE status IN ('confirmed','dispatched'))::int AS running
    FROM online_orders`);
  const counts = countsRes.rows[0] || { new: 0, running: 0 };
  res.json({ rows, counts });
}));

router.get('/:id/events', asyncRoute(async (req, res) => {
  const rows = await db.select().from(onlineOrderEvents)
    .where(eq(onlineOrderEvents.onlineOrderId, +req.params.id)).orderBy(onlineOrderEvents.createdAt);
  res.json(rows);
}));

// ── Zámok proti dvojitému spracovaniu ────────────────────────────────────────
// Dve obrazovky (KDS + kasa) môžu kliknúť naraz. UPDATE … WHERE <podmienka>
// AND zámok voľný prejde presne jednému; druhý dostane 409 s vysvetlením.
// Zámok po 30 s expiruje sám (proces mohol spadnúť uprostred).
const LOCK_TTL_MS = 30_000;
async function lockOrder(id, staffId, condition) {
  const [row] = await db.update(onlineOrders)
    .set({ processingAt: new Date(), processingBy: staffId })
    .where(and(
      eq(onlineOrders.id, id),
      condition,
      or(isNull(onlineOrders.processingAt), lt(onlineOrders.processingAt, new Date(Date.now() - LOCK_TTL_MS))),
    ))
    .returning();
  return row || null;
}
async function unlockOrder(id) {
  await db.update(onlineOrders).set({ processingAt: null, processingBy: null }).where(eq(onlineOrders.id, id));
}
/** Keď zámok nevyšiel: 404 / „už spracovaná" / „práve rieši iná obrazovka". */
async function lockFailure(res, id, expectedStatuses, message) {
  const [cur] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!cur) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (!expectedStatuses.includes(cur.status)) return res.status(409).json({ error: message + ' (' + cur.status + ')', status: cur.status });
  return res.status(409).json({ error: 'Objednávku práve rieši iná obrazovka — počkajte chvíľu', processing: true });
}
/** Predvolené minúty na prípravu: .env → Wolt/Drive konfigurácia → 15. */
function defaultPrepMinutes(oo) {
  const env = Number(process.env.ONLINE_ORDER_DEFAULT_PREP_MINUTES);
  if (env) return env;
  if (oo.source === 'wolt') return woltOrderConfig().prepMinutes || 15;
  return woltConfig().minPrepMinutes || 15;
}

// POST /:id/confirm — obsluha objednávku prijala. Vznikne POS účet (bon do
// kuchyne, odpis skladu) a objedná sa kuriér.
router.post('/:id/confirm', validate(confirmOnlineOrderSchema), asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const staffId = req.user.id;
  const oo = await lockOrder(id, staffId, eq(onlineOrders.status, 'new'));
  if (!oo) return lockFailure(res, id, ['new'], 'Objednávka už bola spracovaná');

  const isWolt = oo.source === 'wolt';
  const prepMinutes = Number(req.body?.prepMinutes) || defaultPrepMinutes(oo);
  const promisedReadyAt = new Date(Date.now() + prepMinutes * 60_000);

  // Objednávka z aplikácie Wolt: najprv prijať vo Wolte (má na to pár minút, inak
  // ju Wolt zruší), až potom účet a bon. Predobjednávku treba najprv potvrdiť.
  // wolt_accepted_at chráni pred druhým accept-om pri opakovanom pokuse.
  if (isWolt && !oo.woltAcceptedAt) {
    try {
      const pre = oo.woltPayload?.pre_order;
      if (pre && String(pre.pre_order_status || '').toLowerCase() !== 'confirmed') await confirmPreorder(oo.woltOrderId);
      await acceptOrder(oo.woltOrderId, { pickupTime: promisedReadyAt });
      await db.update(onlineOrders).set({ woltAcceptedAt: new Date() }).where(eq(onlineOrders.id, id));
    } catch (e) {
      await unlockOrder(id);
      return woltErrorResponse(res, e);
    }
  }

  // Predobjednávka (web „na čas" / Wolt pre-order): teraz len potvrdenie, účet +
  // bon + kuriér až v čase fire_at = doručenie − príprava − 15 min (strážca).
  const targetMs = oo.scheduledFor ? new Date(oo.scheduledFor).getTime() : 0;
  const fireAt = targetMs ? new Date(targetMs - (prepMinutes + 15) * 60_000) : null;
  const scheduled = !!fireAt && fireAt.getTime() - Date.now() > 5 * 60_000;
  const confirmPatch = {
    status: 'confirmed', confirmedBy: staffId, confirmedAt: new Date(), prepMinutes, promisedReadyAt: scheduled ? new Date(targetMs) : promisedReadyAt,
    fireAt: scheduled ? fireAt : null, processingAt: null, processingBy: null, claimedBy: null, claimedAt: null, updatedAt: new Date(),
  };
  await db.update(onlineOrders).set(confirmPatch).where(eq(onlineOrders.id, id));
  await addEvent(id, 'confirmed', { staffId, source: oo.source, prepMinutes, scheduled });
  if (scheduled) {
    emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: 'confirmed', scheduled: true }).catch(() => {});
    const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
    return res.json({ ok: true, order: row, scheduled: true, fireAt });
  }
  const fired = await fireOrder(req.app.get('io'), { ...oo, ...confirmPatch }, { staffId, staffName: req.user?.name || 'Online' });
  if (isWolt) return res.json(fired.result);
  res.json(fired.result);
}));

// POST /:id/fire — účet + bon (+ kuriér) hneď: predobjednávka skôr než v čase
// fire_at, alebo objednávka prijatá v aplikácii Wolt (iPad), ktorá bon nedostala.
router.post('/:id/fire', asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const oo = await lockOrder(id, req.user.id, and(eq(onlineOrders.status, 'confirmed'), isNull(onlineOrders.firedAt)));
  if (!oo) return lockFailure(res, id, ['confirmed'], 'Účet sa dá založiť len pri potvrdenej objednávke bez účtu');
  await db.update(onlineOrders).set({ processingAt: null, processingBy: null, fireAt: null }).where(eq(onlineOrders.id, id));
  const fired = await fireOrder(req.app.get('io'), { ...oo, prepMinutes: oo.prepMinutes || 15 }, { staffId: req.user.id, staffName: req.user?.name || 'Online' });
  await addEvent(id, 'fired', { staffId: req.user.id, manual: true });
  res.json(fired.result);
}));

// POST /:id/reprint — bon znova (tlačiareň bola offline / stratil sa). Bon nesie KÓPIA.
router.post('/:id/reprint', asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.status === 'new') return res.status(409).json({ error: 'Bon vznikne až po prijatí' });
  let bon = 'failed';
  try { bon = await printKitchenBons(oo, req.user?.name || 'Online', { copy: true }); } catch (e) { console.error('[online-orders] reprint:', e.message); }
  await db.update(onlineOrders).set({ bonStatus: bon, updatedAt: new Date() }).where(eq(onlineOrders.id, id));
  await addEvent(id, 'reprint', { staffId: req.user.id, status: bon });
  emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: oo.status, bon }).catch(() => {});
  res.json({ ok: bon !== 'failed', bon });
}));

// PATCH /:id/claim — „rieši Peter (kasa)": kto objednávku otvoril, vidia všetky
// obrazovky 30 s; nič nemení na stave, most sa nebudí.
router.patch('/:id/claim', asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select({ id: onlineOrders.id, status: onlineOrders.status, publicCode: onlineOrders.publicCode }).from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  await db.update(onlineOrders).set({ claimedBy: req.user.id, claimedName: String(req.user.name || '').slice(0, 100), claimedAt: new Date() }).where(eq(onlineOrders.id, id));
  emitEvent(req, 'online-order:claimed', { id, code: oo.publicCode, by: req.user.id, name: req.user.name || '' }).catch(() => {});
  res.json({ ok: true });
}));

// POST /:id/dispatch — znova objednať kuriéra (po chybe Woltu)
router.post('/:id/dispatch', mgr, asyncRoute(async (req, res) => {
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, +req.params.id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.source === 'wolt') return res.status(409).json({ error: 'Kuriéra pri objednávke z aplikácie Wolt rieši Wolt sám' });
  if (oo.status !== 'confirmed') return res.status(409).json({ error: 'Kuriér sa dá objednať len pre potvrdenú objednávku' });
  res.json(await dispatch(req.app.get('io'), oo));
}));

// POST /:id/reject — odmietnuť novú objednávku (nič sa nevarí, nič sa neodpisuje)
// POST /:id/ready — kuchár: jedlo je hotové, čaká na kuriéra. Zákazník to vidí.
router.post('/:id/ready', asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const oo = await lockOrder(id, req.user.id, and(inArray(onlineOrders.status, ['confirmed', 'dispatched']), isNull(onlineOrders.readyAt)));
  if (!oo) {
    const [cur] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
    if (!cur) return res.status(404).json({ error: 'Objednávka sa nenašla' });
    if (cur.readyAt) return res.json({ ok: true, alreadyReady: true });
    return lockFailure(res, id, ['confirmed', 'dispatched'], 'Hotové sa dá označiť len pri potvrdenej objednávke');
  }
  if (oo.source === 'wolt') {
    // Wolt pošle kuriéra / povie zákazníkovi, že si môže prísť.
    try { await woltReadyOrder(oo.woltOrderId); } catch (e) { await unlockOrder(id); return woltErrorResponse(res, e); }
  }
  await db.update(onlineOrders).set({ readyAt: new Date(), processingAt: null, processingBy: null, updatedAt: new Date() }).where(eq(onlineOrders.id, id));
  await addEvent(id, 'ready', { staffId: req.user.id });
  emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: oo.status, ready: true }).catch(() => {});
  res.json({ ok: true });
}));

// POST /:id/handed-over — objednávka z aplikácie Wolt na vyzdvihnutie / v podniku:
// zákazník si ju prevzal, Woltu ohlásime „delivered".
router.post('/:id/handed-over', asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.source !== 'wolt') return res.status(409).json({ error: 'Odovzdanie sa hlási len pri objednávke z aplikácie Wolt' });
  if (!['takeaway', 'eatin'].includes(oo.deliveryType || '')) return res.status(409).json({ error: 'Doručenie kuriérom uzavrie Wolt sám' });
  if (oo.status !== 'confirmed') return res.status(409).json({ error: 'Odovzdať sa dá len potvrdená objednávka' });
  const locked = await lockOrder(id, req.user.id, eq(onlineOrders.status, 'confirmed'));
  if (!locked) return lockFailure(res, id, ['confirmed'], 'Odovzdať sa dá len potvrdená objednávka');
  try { await woltDeliveredOrder(oo.woltOrderId); } catch (e) { await unlockOrder(id); return woltErrorResponse(res, e); }
  await db.update(onlineOrders).set({ status: 'delivered', woltStatus: 'delivered', readyAt: oo.readyAt || new Date(), processingAt: null, processingBy: null, updatedAt: new Date() }).where(eq(onlineOrders.id, id));
  await addEvent(id, 'handed-over', { staffId: req.user.id });
  emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: 'delivered' }).catch(() => {});
  res.json({ ok: true });
}));

router.post('/:id/reject', validate(rejectOnlineOrderSchema), asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const oo = await lockOrder(id, req.user.id, eq(onlineOrders.status, 'new'));
  if (!oo) return lockFailure(res, id, ['new'], 'Odmietnuť sa dá len nová objednávka');
  if (oo.source === 'wolt') {
    try { await woltRejectOrder(oo.woltOrderId, req.body.reason || ''); } catch (e) { await unlockOrder(id); return woltErrorResponse(res, e); }
  }
  await db.update(onlineOrders).set({ status: 'rejected', rejectedReason: req.body.reason || '', processingAt: null, processingBy: null, updatedAt: new Date() }).where(eq(onlineOrders.id, id));
  await addEvent(id, 'rejected', { staffId: req.user.id, reason: req.body.reason || '' });
  emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: 'rejected' }).catch(() => {});
  res.json({ ok: true });
}));

// POST /:id/cancel-delivery — zrušiť kuriéra (kým ho Wolt nepridelil). POS účet ostáva.
router.post('/:id/cancel-delivery', mgr, asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.source === 'wolt') return res.status(409).json({ error: 'Kuriéra pri objednávke z aplikácie Wolt rieši Wolt sám' });
  if (oo.status !== 'dispatched' || !oo.woltOrderReferenceId) return res.status(409).json({ error: 'Kuriér nie je objednaný' });
  try { await cancelDelivery(oo.woltOrderReferenceId); } catch (e) { return woltErrorResponse(res, e); }
  await db.update(onlineOrders).set({ status: 'confirmed', woltStatus: 'cancelled', woltOrderReferenceId: null, woltTrackingUrl: null, updatedAt: new Date() }).where(eq(onlineOrders.id, id));
  await addEvent(id, 'wolt:cancelled', { staffId: req.user.id });
  emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: 'confirmed', woltStatus: 'cancelled' }).catch(() => {});
  res.json({ ok: true });
}));

export default router;

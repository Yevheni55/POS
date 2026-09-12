// Admin/POS strana online objednávok: zoznam, potvrdenie (→ POS účet na stole
// „Rozvoz" + kuriér z Woltu), odmietnutie, zrušenie kuriéra. Vyžaduje JWT +
// rolu manažér/admin (montuje sa za auth middlewarom).
import { Router } from 'express';
import { db } from '../db/index.js';
import {
  onlineOrders, onlineOrderEvents, orders, orderItems, menuItems, tables, shifts,
} from '../db/schema.js';
import { eq, and, inArray, desc, sql, notInArray } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/requireRole.js';
import { asyncRoute } from '../lib/async-route.js';
import { emitEvent } from '../lib/emit.js';
import { logEvent } from '../lib/audit.js';
import { deductStockForSentItems } from '../lib/stock.js';
import { buildKitchenTicket } from '../lib/print/tickets.js';
import { getPrinterForDest } from '../lib/print/network.js';
import { sendOrQueue } from '../lib/print/queue.js';
import { localTimeHHMM } from '../lib/print/format.js';
import { menuCategories } from '../db/schema.js';
import { woltConfig, createDelivery, cancelDelivery, WoltError } from '../lib/wolt-drive.js';
import {
  woltOrderConfig, acceptOrder, rejectOrder as woltRejectOrder, readyOrder as woltReadyOrder, deliveredOrder as woltDeliveredOrder,
  confirmPreorder, exchangeAuthCode, connectionStatus, WoltOrderError,
  normalizeOrder, buildOnlineOrderFromWolt, makeMenuResolver, statusForNotification,
} from '../lib/wolt-order-api.js';
import { rejectOnlineOrderSchema, listOnlineOrdersQuerySchema } from '../schemas/online-orders.js';

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

async function addEvent(id, type, payload = {}) {
  await db.insert(onlineOrderEvents).values({ onlineOrderId: id, type, payload });
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

/** Voľný stôl v zóne „rozvoz" — bez otvoreného účtu. */
async function pickFreeDeliveryTable(tx) {
  const rows = await tx.execute(sql`
    SELECT t.id FROM tables t
    WHERE t.zone = 'rozvoz'
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.status = 'open')
    ORDER BY t.id LIMIT 1 FOR UPDATE OF t`);
  return rows.rows[0]?.id ?? null;
}

// POST /:id/confirm — obsluha objednávku prijala. Vznikne POS účet (bon do
// kuchyne, odpis skladu) a objedná sa kuriér.
router.post('/:id/confirm', asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.status !== 'new') return res.status(409).json({ error: 'Objednávka už bola spracovaná (' + oo.status + ')' });

  const staffId = req.user.id;
  const [shift] = await db.select().from(shifts).where(and(eq(shifts.staffId, staffId), eq(shifts.status, 'open'))).limit(1);
  const isWolt = oo.source === 'wolt';

  // Objednávka z aplikácie Wolt: najprv ju prijať vo Wolte (má na to pár minút,
  // inak ju Wolt zruší), až potom účet a bon. Predobjednávku treba najprv potvrdiť.
  if (isWolt) {
    try {
      const pre = oo.woltPayload?.pre_order;
      if (pre && String(pre.pre_order_status || '').toLowerCase() !== 'confirmed') await confirmPreorder(oo.woltOrderId);
      const w = woltOrderConfig();
      await acceptOrder(oo.woltOrderId, { pickupTime: w.prepMinutes ? new Date(Date.now() + w.prepMinutes * 60_000) : null });
    } catch (e) { return woltErrorResponse(res, e); }
  }

  // Položky Woltu bez páru v našom menu ostávajú len v poznámke — účet vznikne
  // z tých, ktoré poznáme (bon aj odpis skladu). Bez jediného páru účet nevznikne.
  const mapped = oo.items.filter((it) => it.menuItemId);
  let posOrderId = null;
  try {
    if (mapped.length) posOrderId = await db.transaction(async (tx) => {
      const tableId = await pickFreeDeliveryTable(tx);
      if (!tableId) throw Object.assign(new Error('Všetky rozvozové stoly sú obsadené — najprv uzavrite starší rozvoz'), { code: 409 });
      await tx.update(tables).set({ status: 'occupied' }).where(eq(tables.id, tableId));
      const [order] = await tx.insert(orders).values({
        tableId, staffId, shiftId: shift?.id ?? null, label: (isWolt ? 'Wolt ' : 'Rozvoz ') + oo.publicCode,
      }).returning();
      const inserted = await tx.insert(orderItems).values(
        mapped.map((it) => ({ orderId: order.id, menuItemId: it.menuItemId, qty: it.qty, note: it.note || '', sent: true })),
      ).returning();
      // Rovnaké čo /orders/:id/send — kuchyňa dostane bon, sklad sa odpíše.
      const names = await tx.select({ id: menuItems.id, name: menuItems.name, emoji: menuItems.emoji })
        .from(menuItems).where(inArray(menuItems.id, inserted.map((i) => i.menuItemId)));
      const byId = new Map(names.map((n) => [n.id, n]));
      const sentItems = inserted.map((i) => ({
        id: i.id, menuItemId: i.menuItemId, qty: i.qty, note: i.note,
        name: byId.get(i.menuItemId)?.name || '', emoji: byId.get(i.menuItemId)?.emoji || '',
      }));
      await deductStockForSentItems(tx, sentItems, staffId, order.id);
      await tx.update(onlineOrders).set({
        status: 'confirmed', posOrderId: order.id, confirmedBy: staffId, confirmedAt: new Date(), updatedAt: new Date(),
      }).where(eq(onlineOrders.id, id));
      return order.id;
    });
    else await db.update(onlineOrders).set({ status: 'confirmed', confirmedBy: staffId, confirmedAt: new Date(), updatedAt: new Date() }).where(eq(onlineOrders.id, id));
  } catch (e) {
    if (e.code === 409 && !isWolt) return res.status(409).json({ error: e.message });
    if (e.code !== 409) throw e;
    // Vo Wolte už prijaté — účet sa nedá založiť (plné stoly), ale objednávka nesmie zmiznúť.
    await db.update(onlineOrders).set({ status: 'confirmed', confirmedBy: staffId, confirmedAt: new Date(), updatedAt: new Date() }).where(eq(onlineOrders.id, id));
    await addEvent(id, 'error', { message: e.message });
  }
  await addEvent(id, 'confirmed', { staffId, posOrderId, source: oo.source });
  if (posOrderId) {
    logEvent(db, { orderId: posOrderId, type: 'order_created', payload: { online: oo.publicCode, itemCount: mapped.length }, staffId }).catch(() => {});
    emitEvent(req, 'order:created', { orderId: posOrderId }).catch(() => {});
    emitEvent(req, 'order:sent', { orderId: posOrderId }).catch(() => {});
  }
  // Bon do kuchyne/baru — v POS ho tlačí klient, tu ho musí spraviť server.
  // Best-effort: tlačiareň offline nesmie zhodiť potvrdenie (fronta to dobehne).
  printKitchenBons(oo, req.user?.name || 'Online').catch((e) => console.error('[online-orders] bon:', e.message));

  if (isWolt) {
    // Kuriéra posiela Wolt sám — nič sa neobjednáva.
    emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: 'confirmed' }).catch(() => {});
    const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
    return res.json({ ok: true, order: row });
  }
  // Kuriér. Keď Wolt zlyhá, objednávka ostáva „confirmed" a obsluha to skúsi
  // znova cez /dispatch — jedlo sa už robí, nesmie sa stratiť.
  const result = await dispatch(req, { ...oo, status: 'confirmed', posOrderId });
  res.json(result);
}));

/** Rozdelí položky podľa cieľa (kuchyňa / bar) ako POS klient a vytlačí bony. */
async function printKitchenBons(oo, staffName) {
  const ids = [...new Set(oo.items.map((i) => i.menuItemId).filter(Boolean))];
  if (!oo.items.length) return;
  const rows = ids.length ? await db.select({ id: menuItems.id, override: menuItems.destOverride, catDest: menuCategories.dest })
    .from(menuItems).innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
    .where(inArray(menuItems.id, ids)) : [];
  const destOf = new Map(rows.map((r) => [r.id, (r.override || r.catDest || 'bar') === 'kuchyna' ? 'KUCHYNA' : 'BAR']));
  const label = (oo.source === 'wolt' ? 'WOLT ' : 'ROZVOZ ') + oo.publicCode;
  const groups = new Map();
  for (const it of oo.items) {
    const d = destOf.get(it.menuItemId) || 'BAR';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push({ name: it.name, qty: it.qty, note: it.note || '' });
  }
  const time = localTimeHHMM();
  for (const [dest, items] of groups) {
    const printer = await getPrinterForDest(dest === 'KUCHYNA' ? 'kuchyna' : 'bar');
    const ticket = buildKitchenTicket({ dest, tableName: label, staffName, items, orderNum: oo.publicCode, time });
    await sendOrQueue('kitchen', ticket, printer.ip, printer.port);
  }
}

async function dispatch(req, oo) {
  try {
    const d = await createDelivery({ promiseId: oo.woltPromiseId, order: oo });
    const patch = {
      status: 'dispatched',
      woltOrderReferenceId: d.woltOrderReferenceId,
      woltTrackingUrl: d.trackingUrl,
      woltStatus: d.status,
      woltFee: d.feeEur != null ? String(d.feeEur) : oo.woltFee,
      updatedAt: new Date(),
    };
    await db.update(onlineOrders).set(patch).where(eq(onlineOrders.id, oo.id));
    await addEvent(oo.id, 'dispatched', { woltOrderReferenceId: d.woltOrderReferenceId, pickupEta: d.pickupEta, dropoffEta: d.dropoffEta });
    emitEvent(req, 'online-order:updated', { id: oo.id, code: oo.publicCode, status: 'dispatched' }).catch(() => {});
    const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, oo.id)).limit(1);
    return { ok: true, order: row, wolt: d };
  } catch (e) {
    const msg = e instanceof WoltError ? e.message : String(e.message);
    await db.update(onlineOrders).set({ woltStatus: 'error', updatedAt: new Date() }).where(eq(onlineOrders.id, oo.id));
    await addEvent(oo.id, 'wolt:error', { message: msg, detail: e.detail || null });
    emitEvent(req, 'online-order:updated', { id: oo.id, code: oo.publicCode, status: oo.status, woltStatus: 'error' }).catch(() => {});
    const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, oo.id)).limit(1);
    return { ok: false, order: row, error: 'Kuriéra sa nepodarilo objednať: ' + msg };
  }
}

// POST /:id/dispatch — znova objednať kuriéra (po chybe Woltu)
router.post('/:id/dispatch', mgr, asyncRoute(async (req, res) => {
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, +req.params.id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.source === 'wolt') return res.status(409).json({ error: 'Kuriéra pri objednávke z aplikácie Wolt rieši Wolt sám' });
  if (oo.status !== 'confirmed') return res.status(409).json({ error: 'Kuriér sa dá objednať len pre potvrdenú objednávku' });
  res.json(await dispatch(req, oo));
}));

// POST /:id/reject — odmietnuť novú objednávku (nič sa nevarí, nič sa neodpisuje)
// POST /:id/ready — kuchár: jedlo je hotové, čaká na kuriéra. Zákazník to vidí.
router.post('/:id/ready', asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (!['confirmed', 'dispatched'].includes(oo.status)) return res.status(409).json({ error: 'Hotové sa dá označiť len pri potvrdenej objednávke' });
  if (oo.readyAt) return res.json({ ok: true, alreadyReady: true });
  if (oo.source === 'wolt') {
    // Wolt pošle kuriéra / povie zákazníkovi, že si môže prísť.
    try { await woltReadyOrder(oo.woltOrderId); } catch (e) { return woltErrorResponse(res, e); }
  }
  await db.update(onlineOrders).set({ readyAt: new Date(), updatedAt: new Date() }).where(eq(onlineOrders.id, id));
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
  try { await woltDeliveredOrder(oo.woltOrderId); } catch (e) { return woltErrorResponse(res, e); }
  await db.update(onlineOrders).set({ status: 'delivered', woltStatus: 'delivered', readyAt: oo.readyAt || new Date(), updatedAt: new Date() }).where(eq(onlineOrders.id, id));
  await addEvent(id, 'handed-over', { staffId: req.user.id });
  emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: 'delivered' }).catch(() => {});
  res.json({ ok: true });
}));

router.post('/:id/reject', validate(rejectOnlineOrderSchema), asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.status !== 'new') return res.status(409).json({ error: 'Odmietnuť sa dá len nová objednávka' });
  if (oo.source === 'wolt') {
    try { await woltRejectOrder(oo.woltOrderId, req.body.reason || ''); } catch (e) { return woltErrorResponse(res, e); }
  }
  await db.update(onlineOrders).set({ status: 'rejected', rejectedReason: req.body.reason || '', updatedAt: new Date() }).where(eq(onlineOrders.id, id));
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

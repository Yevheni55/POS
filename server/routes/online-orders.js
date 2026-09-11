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
import { rejectOnlineOrderSchema, listOnlineOrdersQuerySchema } from '../schemas/online-orders.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

const ACTIVE = ['new', 'confirmed', 'dispatched'];

function woltErrorResponse(res, e) {
  if (e instanceof WoltError) return res.status(e.status).json({ error: e.message, detail: e.detail || undefined });
  throw e;
}

async function addEvent(id, type, payload = {}) {
  await db.insert(onlineOrderEvents).values({ onlineOrderId: id, type, payload });
}

router.get('/config', mgr, (req, res) => {
  const cfg = woltConfig();
  res.json({ enabled: cfg.enabled, mode: cfg.mode, cashOnDelivery: cfg.cashOnDelivery, pickup: cfg.pickup, minPrepMinutes: cfg.minPrepMinutes });
});

// GET / ?status=new|active|done|all
router.get('/', mgr, asyncRoute(async (req, res) => {
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

router.get('/:id/events', mgr, asyncRoute(async (req, res) => {
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
router.post('/:id/confirm', mgr, asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.status !== 'new') return res.status(409).json({ error: 'Objednávka už bola spracovaná (' + oo.status + ')' });

  const staffId = req.user.id;
  const [shift] = await db.select().from(shifts).where(and(eq(shifts.staffId, staffId), eq(shifts.status, 'open'))).limit(1);

  let posOrderId;
  try {
    posOrderId = await db.transaction(async (tx) => {
      const tableId = await pickFreeDeliveryTable(tx);
      if (!tableId) throw Object.assign(new Error('Všetky rozvozové stoly sú obsadené — najprv uzavrite starší rozvoz'), { code: 409 });
      await tx.update(tables).set({ status: 'occupied' }).where(eq(tables.id, tableId));
      const [order] = await tx.insert(orders).values({
        tableId, staffId, shiftId: shift?.id ?? null, label: 'Rozvoz ' + oo.publicCode,
      }).returning();
      const inserted = await tx.insert(orderItems).values(
        oo.items.map((it) => ({ orderId: order.id, menuItemId: it.menuItemId, qty: it.qty, note: it.note || '', sent: true })),
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
  } catch (e) {
    if (e.code === 409) return res.status(409).json({ error: e.message });
    throw e;
  }
  await addEvent(id, 'confirmed', { staffId, posOrderId });
  logEvent(db, { orderId: posOrderId, type: 'order_created', payload: { online: oo.publicCode, itemCount: oo.items.length }, staffId }).catch(() => {});
  emitEvent(req, 'order:created', { orderId: posOrderId }).catch(() => {});
  emitEvent(req, 'order:sent', { orderId: posOrderId }).catch(() => {});
  // Bon do kuchyne/baru — v POS ho tlačí klient, tu ho musí spraviť server.
  // Best-effort: tlačiareň offline nesmie zhodiť potvrdenie (fronta to dobehne).
  printKitchenBons(oo, req.user?.name || 'Online').catch((e) => console.error('[online-orders] bon:', e.message));

  // Kuriér. Keď Wolt zlyhá, objednávka ostáva „confirmed" a obsluha to skúsi
  // znova cez /dispatch — jedlo sa už robí, nesmie sa stratiť.
  const result = await dispatch(req, { ...oo, status: 'confirmed', posOrderId });
  res.json(result);
}));

/** Rozdelí položky podľa cieľa (kuchyňa / bar) ako POS klient a vytlačí bony. */
async function printKitchenBons(oo, staffName) {
  const ids = [...new Set(oo.items.map((i) => i.menuItemId))];
  if (!ids.length) return;
  const rows = await db.select({ id: menuItems.id, override: menuItems.destOverride, catDest: menuCategories.dest })
    .from(menuItems).innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
    .where(inArray(menuItems.id, ids));
  const destOf = new Map(rows.map((r) => [r.id, (r.override || r.catDest || 'bar') === 'kuchyna' ? 'KUCHYNA' : 'BAR']));
  const groups = new Map();
  for (const it of oo.items) {
    const d = destOf.get(it.menuItemId) || 'BAR';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push({ name: it.name, qty: it.qty, note: it.note || '' });
  }
  const time = localTimeHHMM();
  for (const [dest, items] of groups) {
    const printer = await getPrinterForDest(dest === 'KUCHYNA' ? 'kuchyna' : 'bar');
    const ticket = buildKitchenTicket({ dest, tableName: 'ROZVOZ ' + oo.publicCode, staffName, items, orderNum: oo.publicCode, time });
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
  if (oo.status !== 'confirmed') return res.status(409).json({ error: 'Kuriér sa dá objednať len pre potvrdenú objednávku' });
  res.json(await dispatch(req, oo));
}));

// POST /:id/reject — odmietnuť novú objednávku (nič sa nevarí, nič sa neodpisuje)
router.post('/:id/reject', mgr, validate(rejectOnlineOrderSchema), asyncRoute(async (req, res) => {
  const id = +req.params.id;
  const [oo] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, id)).limit(1);
  if (!oo) return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (oo.status !== 'new') return res.status(409).json({ error: 'Odmietnuť sa dá len nová objednávka' });
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
  if (oo.status !== 'dispatched' || !oo.woltOrderReferenceId) return res.status(409).json({ error: 'Kuriér nie je objednaný' });
  try { await cancelDelivery(oo.woltOrderReferenceId); } catch (e) { return woltErrorResponse(res, e); }
  await db.update(onlineOrders).set({ status: 'confirmed', woltStatus: 'cancelled', woltOrderReferenceId: null, woltTrackingUrl: null, updatedAt: new Date() }).where(eq(onlineOrders.id, id));
  await addEvent(id, 'wolt:cancelled', { staffId: req.user.id });
  emitEvent(req, 'online-order:updated', { id, code: oo.publicCode, status: 'confirmed', woltStatus: 'cancelled' }).catch(() => {});
  res.json({ ok: true });
}));

export default router;

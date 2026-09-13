// „Odpálenie" prijatej online objednávky — spoločné pre /confirm (hneď),
// strážcu (predobjednávky v čase fire_at) a ručné „Vytvoriť účet a bon":
// POS účet na stole v zóne „rozvoz" z položiek, ktoré kasa pozná, odpis
// skladu, bony do kuchyne/baru, pri objednávke z webu kuriér cez Wolt Drive.
// Objednávka z aplikácie Wolt kuriéra nepotrebuje — posiela ho Wolt.
import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  onlineOrders, onlineOrderEvents, orders, orderItems, menuItems, menuCategories, tables, shifts, staff,
} from '../db/schema.js';
import { logEvent } from './audit.js';
import { deductStockForSentItems } from './stock.js';
import { buildKitchenTicket } from './print/tickets.js';
import { getPrinterForDest } from './print/network.js';
import { sendOrQueue } from './print/queue.js';
import { localTimeHHMM } from './print/format.js';
import { createDelivery, requestShipmentPromise, WoltError } from './wolt-drive.js';
import { emitEventIo } from './emit.js';
import { sendAlert } from './alerts.js';

export async function addEvent(id, type, payload = {}) {
  await db.insert(onlineOrderEvents).values({ onlineOrderId: id, type, payload });
}

/** Voľný stôl v zóne „rozvoz" — bez otvoreného účtu. */
export async function pickFreeDeliveryTable(tx) {
  const rows = await tx.execute(sql`
    SELECT t.id FROM tables t
    WHERE t.zone = 'rozvoz'
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.status = 'open')
    ORDER BY t.id LIMIT 1 FOR UPDATE OF t`);
  return rows.rows[0]?.id ?? null;
}

export function orderLabel(oo) {
  return (oo.source === 'wolt' ? 'Wolt ' : 'Rozvoz ') + oo.publicCode;
}

/**
 * Rozdelí položky podľa cieľa (kuchyňa / bar) ako POS klient a vytlačí bony.
 * Vracia 'ok' | 'queued' (tlačiareň offline, fronta to dobehne) | 'none'.
 * `copy` = opakovaná tlač, bon nesie „KÓPIA", aby kuchyňa nevarila dvakrát.
 */
export async function printKitchenBons(oo, staffName, { copy = false } = {}) {
  if (!oo.items.length) return 'none';
  const ids = [...new Set(oo.items.map((i) => i.menuItemId).filter(Boolean))];
  const rows = ids.length ? await db.select({ id: menuItems.id, override: menuItems.destOverride, catDest: menuCategories.dest })
    .from(menuItems).innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
    .where(inArray(menuItems.id, ids)) : [];
  const destOf = new Map(rows.map((r) => [r.id, (r.override || r.catDest || 'bar') === 'kuchyna' ? 'KUCHYNA' : 'BAR']));
  const label = (copy ? 'KÓPIA · ' : '') + (oo.source === 'wolt' ? 'WOLT ' : 'ROZVOZ ') + oo.publicCode;
  const groups = new Map();
  for (const it of oo.items) {
    const d = destOf.get(it.menuItemId) || 'BAR';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push({ name: it.name, qty: it.qty, note: it.note || '' });
  }
  const time = localTimeHHMM();
  let queued = false;
  for (const [dest, items] of groups) {
    const printer = await getPrinterForDest(dest === 'KUCHYNA' ? 'kuchyna' : 'bar');
    const ticket = buildKitchenTicket({ dest, tableName: label, staffName, items, orderNum: oo.publicCode, time });
    const r = await sendOrQueue('kitchen', ticket, printer.ip, printer.port);
    if (!r || !r.ok) queued = true;
  }
  return queued ? 'queued' : 'ok';
}

/** Kuriér Wolt Drive. Keď prísľub medzitým expiroval (predobjednávka), vypýta nový. */
export async function dispatch(io, oo) {
  try {
    let promiseId = oo.woltPromiseId;
    const validUntil = oo.woltPromiseValidUntil ? new Date(oo.woltPromiseValidUntil).getTime() : 0;
    if (!promiseId || validUntil < Date.now() + 30_000) {
      const p = await requestShipmentPromise({
        street: oo.dropoffStreet, city: oo.dropoffCity, postCode: oo.dropoffPostCode,
        lat: oo.dropoffLat == null ? undefined : Number(oo.dropoffLat), lon: oo.dropoffLon == null ? undefined : Number(oo.dropoffLon),
        scheduledFor: oo.scheduledFor,
      });
      promiseId = p.id;
      await db.update(onlineOrders).set({ woltPromiseId: p.id, woltPromiseValidUntil: p.validUntil ? new Date(p.validUntil) : null }).where(eq(onlineOrders.id, oo.id));
    }
    const d = await createDelivery({ promiseId, order: oo });
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
    emitEventIo(io, 'online-order:updated', { id: oo.id, code: oo.publicCode, status: 'dispatched' }).catch(() => {});
    const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, oo.id)).limit(1);
    return { ok: true, order: row, wolt: d };
  } catch (e) {
    const msg = e instanceof WoltError ? e.message : String(e.message);
    await db.update(onlineOrders).set({ woltStatus: 'error', updatedAt: new Date() }).where(eq(onlineOrders.id, oo.id));
    await addEvent(oo.id, 'wolt:error', { message: msg, detail: e.detail || null });
    emitEventIo(io, 'online-order:updated', { id: oo.id, code: oo.publicCode, status: oo.status, woltStatus: 'error' }).catch(() => {});
    const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, oo.id)).limit(1);
    return { ok: false, order: row, error: 'Kuriéra sa nepodarilo objednať: ' + msg };
  }
}

/**
 * Účet + odpis + bony (+ kuriér pri webe). `oo` musí byť už potvrdená
 * (status confirmed, prep_minutes). Vracia { posOrderId, bon, result, error }.
 * Plné stoly Rozvoz nezhodia objednávku: ostane potvrdená bez účtu, obsluha to uvidí.
 */
export async function fireOrder(io, oo, { staffId = null, staffName = 'Online' } = {}) {
  const isWolt = oo.source === 'wolt';
  // Účet musí mať obsluhu: kto potvrdil; inak (prijaté v appke Woltu, strážca)
  // prvý aktívny admin/manažér — je to systémový úkon, nie osobná tržba.
  if (!staffId) staffId = oo.confirmedBy || null;
  if (!staffId) {
    const [s] = await db.select({ id: staff.id }).from(staff).where(eq(staff.active, true))
      .orderBy(sql`CASE role WHEN 'admin' THEN 0 WHEN 'manazer' THEN 1 ELSE 2 END`, staff.id).limit(1);
    staffId = s ? s.id : null;
  }
  const [shift] = staffId
    ? await db.select().from(shifts).where(and(eq(shifts.staffId, staffId), eq(shifts.status, 'open'))).limit(1)
    : [null];
  const mapped = (oo.items || []).filter((it) => it.menuItemId);
  let posOrderId = null;
  let error = null;
  try {
    if (mapped.length) posOrderId = await db.transaction(async (tx) => {
      const tableId = await pickFreeDeliveryTable(tx);
      if (!tableId) throw Object.assign(new Error('Všetky rozvozové stoly sú obsadené — najprv uzavrite starší rozvoz'), { code: 409 });
      await tx.update(tables).set({ status: 'occupied' }).where(eq(tables.id, tableId));
      const [order] = await tx.insert(orders).values({
        tableId, staffId, shiftId: shift?.id ?? null, label: orderLabel(oo),
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
      await tx.update(onlineOrders).set({ posOrderId: order.id, firedAt: new Date(), updatedAt: new Date() }).where(eq(onlineOrders.id, oo.id));
      return order.id;
    });
    else await db.update(onlineOrders).set({ firedAt: new Date(), updatedAt: new Date() }).where(eq(onlineOrders.id, oo.id));
  } catch (e) {
    if (e.code !== 409) throw e;
    // Stoly plné: fired_at ostáva prázdne, aby na karte zostalo „Vytvoriť účet a bon" (skúsi sa znova,
    // keď obsluha uzavrie starší rozvoz); bon sa netlačí, inak by pri opakovaní išiel dvakrát.
    // Predobjednávku strážca skúsi znova o 2 minúty — nie každých 15 s.
    error = e.message;
    await addEvent(oo.id, 'error', { message: e.message });
    if (oo.fireAt) await db.update(onlineOrders).set({ fireAt: new Date(Date.now() + 2 * 60_000) }).where(eq(onlineOrders.id, oo.id));
    emitEventIo(io, 'online-order:updated', { id: oo.id, code: oo.publicCode, status: 'confirmed', error }).catch(() => {});
    const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, oo.id)).limit(1);
    return { posOrderId: null, bon: null, result: { ok: false, order: row, error }, error };
  }
  if (posOrderId) {
    logEvent(db, { orderId: posOrderId, type: 'order_created', payload: { online: oo.publicCode, itemCount: mapped.length }, staffId: staffId || oo.confirmedBy || null }).catch(() => {});
    emitEventIo(io, 'order:created', { orderId: posOrderId }).catch(() => {});
    emitEventIo(io, 'order:sent', { orderId: posOrderId }).catch(() => {});
  }
  // Bon — tlačiareň offline nesmie zhodiť potvrdenie; stav si obsluha pozrie na karte.
  let bon = 'none';
  try { bon = await printKitchenBons(oo, staffName); } catch (e) { bon = 'failed'; console.error('[online-orders] bon:', e.message); }
  await db.update(onlineOrders).set({ bonStatus: bon }).where(eq(onlineOrders.id, oo.id));
  await addEvent(oo.id, 'bon', { status: bon });

  let result = null;
  if (isWolt) {
    emitEventIo(io, 'online-order:updated', { id: oo.id, code: oo.publicCode, status: 'confirmed' }).catch(() => {});
    const [row] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, oo.id)).limit(1);
    result = { ok: !error, order: row, error: error || undefined };
  } else {
    // Kuriér. Keď Wolt zlyhá, objednávka ostáva „confirmed" a obsluha to skúsi znova cez /dispatch.
    result = await dispatch(io, { ...oo, status: 'confirmed', posOrderId });
  }
  return { posOrderId, bon, result, error };
}

/**
 * Wolt objednávku zrušil po prijatí: kuchyňa musí zastať. Účet ostáva otvorený
 * s označením ZRUŠENÉ (obsluha ho uzavrie ako odpis), KDS dostane STOP, manažér správu.
 */
export async function markCancelledByWolt(io, oo, reason = 'Zrušené zo strany Woltu') {
  if (oo.posOrderId) {
    const [pos] = await db.select({ id: orders.id, label: orders.label, status: orders.status }).from(orders).where(eq(orders.id, oo.posOrderId)).limit(1);
    if (pos && pos.status === 'open' && !/^ZRUŠENÉ/.test(pos.label || '')) {
      await db.update(orders).set({ label: ('ZRUŠENÉ · ' + pos.label).slice(0, 100) }).where(eq(orders.id, pos.id));
      emitEventIo(io, 'order:updated', { orderId: pos.id, cancelledByWolt: true }).catch(() => {});
    }
  }
  emitEventIo(io, 'online-order:stop', { id: oo.id, code: oo.publicCode, posOrderId: oo.posOrderId || null, reason }).catch(() => {});
  sendAlert('⛔ Wolt zrušil už prijatú objednávku ' + oo.publicCode + ' (' + oo.customerName + ', ' + Number(oo.total).toFixed(2) + ' €). Kuchyňa dostala STOP, účet treba uzavrieť ako odpis.').catch(() => {});
}

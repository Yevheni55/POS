import { Router } from 'express';
import { db } from '../db/index.js';
import {
  orders, orderItems, menuItems, tables, shifts, discounts, orderEvents,
  payments, fiscalDocuments,
  writeOffs, writeOffItems, ingredients, recipes,
} from '../db/schema.js';
import { eq, desc, and, inArray, sql, or } from 'drizzle-orm';
import { logEvent } from '../lib/audit.js';
import { emitEvent } from '../lib/emit.js';
import { enrichOrders } from '../lib/order-queries.js';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/requireRole.js';
import { createOrderSchema, addItemsSchema, updateItemSchema, batchSchema, splitSchema, moveItemsSchema, discountSchema, stornoSendSchema, stornoWriteOffSchema } from '../schemas/orders.js';
import { deductStockForSentItems, applyWriteOff } from '../lib/stock.js';
import { applyStornoStockResolution } from '../lib/storno-stock.js';
import { asyncRoute } from '../lib/async-route.js';
import { needsSaucePicker, isSauceAnnotationRow } from '../lib/menu-helpers.js';

const router = Router();

const VERSION_CONFLICT_MSG = 'Objednavka bola zmenena inym pouzivatelom';

/**
 * Atomically check and bump order version. Accepts a tx handle or db.
 * Returns the updated order row, or null on version mismatch.
 * If version is undefined, bumps unconditionally (backwards-compatible).
 */
async function bumpVersion(txOrDb, orderId, version) {
  const conditions = [eq(orders.id, orderId), eq(orders.status, 'open')];
  if (version !== undefined) conditions.push(eq(orders.version, version));
  const [updated] = await txOrDb.update(orders)
    .set({ version: sql`${orders.version} + 1` })
    .where(and(...conditions))
    .returning();
  return updated || null;
}

class VersionConflictError extends Error {
  constructor() { super(VERSION_CONFLICT_MSG); this.name = 'VersionConflictError'; }
}

async function consolidateSentOrderItems(tx, orderId) {
  const sentRows = await tx.select({
    id: orderItems.id,
    menuItemId: orderItems.menuItemId,
    note: orderItems.note,
    qty: orderItems.qty,
    name: menuItems.name,
  })
    .from(orderItems)
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.sent, true)))
    .orderBy(orderItems.id);

  if (sentRows.length < 2) return;

  const grouped = new Map();
  const duplicateIds = [];

  for (const row of sentRows) {
    // Sauce-paired položky (combos, Kuracie hranolky) sa NIKDY nekonsolidujú.
    // Dva taps tej istej položky s rôznymi omáčkami by boli zlúčené do qty=2
    // s note='', a kitchen ticket builder (server/routes/print.js:buildKitchenTicket)
    // číta len note z prvého susedného "Omáčka (combo)" riadku — druhá
    // omáčka by ticha zmizla. Rovnaký defensive skip aj pre samotný
    // annotation riadok, lebo každá sauce nota je párovaná 1:1 s primary.
    if (needsSaucePicker(row.name)) continue;
    if (isSauceAnnotationRow(row.name)) continue;

    const key = `${row.menuItemId}::${row.note || ''}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { id: row.id, qty: row.qty });
      continue;
    }

    existing.qty += row.qty;
    duplicateIds.push(row.id);
  }

  if (!duplicateIds.length) return;

  for (const keeper of grouped.values()) {
    await tx.update(orderItems)
      .set({ qty: keeper.qty })
      .where(eq(orderItems.id, keeper.id));
  }

  await tx.delete(orderItems).where(inArray(orderItems.id, duplicateIds));
}

// GET /api/orders — all open orders (with items)
router.get('/', asyncRoute(async (req, res) => {
  const allOrders = await db.select().from(orders)
    .where(eq(orders.status, 'open'))
    .orderBy(desc(orders.createdAt));

  res.json(await enrichOrders(allOrders));
}));

// GET /api/orders/table/:tableId — get all open orders for a table (array)
router.get('/table/:tableId', asyncRoute(async (req, res) => {
  const tid = +req.params.tableId;
  const allOrders = await db.select().from(orders)
    .where(and(eq(orders.tableId, tid), eq(orders.status, 'open')))
    .orderBy(orders.createdAt);

  res.json(await enrichOrders(allOrders));
}));

// POST /api/orders — create order
router.post('/', validate(createOrderSchema), asyncRoute(async (req, res) => {
  const { tableId, items, label } = req.body;
  const staffId = req.user.id;

  // Auto-generate label if not provided
  let orderLabel = label;
  if (!orderLabel) {
    const existing = await db.select().from(orders)
      .where(and(eq(orders.tableId, tableId), eq(orders.status, 'open')));
    orderLabel = 'Ucet ' + (existing.length + 1);
  }

  // Look up current open shift for this user (optional — old orders without shiftId still work)
  let shiftId = null;
  const [currentShift] = await db.select().from(shifts)
    .where(and(eq(shifts.staffId, staffId), eq(shifts.status, 'open')))
    .limit(1);
  if (currentShift) shiftId = currentShift.id;

  // Atomic: table status + order + items in one transaction
  const order = await db.transaction(async (tx) => {
    await tx.update(tables).set({ status: 'occupied' }).where(eq(tables.id, tableId));

    const [order] = await tx.insert(orders).values({ tableId, staffId, shiftId, label: orderLabel }).returning();

    if (items && items.length) {
      await tx.insert(orderItems).values(
        items.map(i => ({ orderId: order.id, menuItemId: i.menuItemId, qty: i.qty, note: i.note || '' }))
      );
    }
    return order;
  });

  logEvent(db, { orderId: order.id, type: 'order_created', payload: { tableId, label: orderLabel, itemCount: items?.length || 0 }, staffId }).catch(e => console.error('Audit log error:', e));
  emitEvent(req,'order:created', { tableId, orderId: order.id });
  res.status(201).json(order);
}));

// POST /api/orders/:id/items — add items to existing order
router.post('/:id/items', validate(addItemsSchema), asyncRoute(async (req, res) => {
  const { items, version } = req.body;
  const orderId = +req.params.id;

  try {
    const inserted = await db.transaction(async (tx) => {
      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();

      return await tx.insert(orderItems).values(
        items.map(i => ({ orderId, menuItemId: i.menuItemId, qty: i.qty, note: i.note || '' }))
      ).returning();
    });

    logEvent(db, { orderId, type: 'item_added', payload: { items: items.map(i => ({ menuItemId: i.menuItemId, qty: i.qty })) }, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
    emitEvent(req, 'order:updated', { orderId });
    res.status(201).json(inserted);
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    throw e;
  }
}));

// PUT /api/orders/:orderId/items/:itemId — update item qty/note
router.put('/:orderId/items/:itemId', validate(updateItemSchema), asyncRoute(async (req, res) => {
  const orderId = +req.params.orderId;
  const itemId = +req.params.itemId;
  const { qty, note, version } = req.body;

  try {
    const result = await db.transaction(async (tx) => {
      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();

      if (qty <= 0) {
        await tx.delete(orderItems).where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)));
        return { deleted: true, type: 'item_removed', orderVersion: bumped.version };
      }
      const updates = {};
      if (qty !== undefined) updates.qty = qty;
      if (note !== undefined) updates.note = note;
      const [item] = await tx.update(orderItems).set(updates).where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId))).returning();
      return { item, type: 'item_qty_changed', orderVersion: bumped.version };
    });

    const eventType = result.type;
    const payload = eventType === 'item_removed' ? { itemId } : { itemId, qty, note };
    logEvent(db, { orderId, type: eventType, payload, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
    emitEvent(req, 'order:updated', { orderId });
    if (result.deleted) {
      res.json({ deleted: true, orderVersion: result.orderVersion });
    } else {
      res.json({ item: result.item, orderVersion: result.orderVersion });
    }
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    throw e;
  }
}));

// DELETE /api/orders/:orderId/items/:itemId
router.delete('/:orderId/items/:itemId', asyncRoute(async (req, res) => {
  const orderId = +req.params.orderId;
  const itemId = +req.params.itemId;
  const { version } = req.body || {};

  try {
    const newVersion = await db.transaction(async (tx) => {
      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();
      await tx.delete(orderItems).where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)));
      return bumped ? bumped.version : null;
    });

    logEvent(db, { orderId, type: 'item_removed', payload: { itemId }, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
    emitEvent(req, 'order:updated', { orderId });
    res.json({ ok: true, deleted: true, orderVersion: newVersion });
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    throw e;
  }
}));

// POST /api/orders/:id/batch — batch operations
router.post('/:id/batch', validate(batchSchema), asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const { operations, version } = req.body;

  try {
    const results = await db.transaction(async (tx) => {
      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();

      const results = [];
      for (const op of operations) {
        if (op.action === 'add') {
          const [item] = await tx.insert(orderItems).values({ orderId, menuItemId: op.menuItemId, qty: op.qty || 1, note: op.note || '' }).returning();
          results.push(item);
        } else if (op.action === 'update') {
          if (op.qty <= 0) {
            await tx.delete(orderItems).where(eq(orderItems.id, op.itemId));
            results.push({ deleted: true, id: op.itemId });
          } else {
            const updates = {};
            if (op.qty !== undefined) updates.qty = op.qty;
            if (op.note !== undefined) updates.note = op.note;
            const [item] = await tx.update(orderItems).set(updates).where(eq(orderItems.id, op.itemId)).returning();
            results.push(item);
          }
        } else if (op.action === 'remove') {
          await tx.delete(orderItems).where(eq(orderItems.id, op.itemId));
          results.push({ deleted: true, id: op.itemId });
        }
      }
      return results;
    });

    logEvent(db, { orderId, type: 'batch_update', payload: { operations }, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
    emitEvent(req, 'order:updated', { orderId });
    res.json(results);
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    throw e;
  }
}));

// POST /api/orders/:id/close — close order (after payment)
router.post('/:id/close', asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const { version } = req.body || {};

  try {
    const order = await db.transaction(async (tx) => {
      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();

      const [order] = await tx.update(orders)
        .set({ status: 'closed', closedAt: new Date() })
        .where(eq(orders.id, orderId))
        .returning();

      if (order) {
        const remaining = await tx.select().from(orders)
          .where(and(eq(orders.tableId, order.tableId), eq(orders.status, 'open')));
        if (!remaining.length) {
          await tx.update(tables).set({ status: 'free' }).where(eq(tables.id, order.tableId));
        }
      }
      return order;
    });

    logEvent(db, { orderId, type: 'order_closed', payload: {}, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
    emitEvent(req, 'order:closed', { tableId: order?.tableId, orderId });
    res.json(order);
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    throw e;
  }
}));

// POST /api/orders/:id/close-as-staff-meal
//
// Zamestnanecká spotreba: order zo zóny `zamestanci` sa uzavrie BEZ platby
// a BEZ fiškálu. Zápis ide do write_offs (reason='staff_meal') so sumou =
// COGS celej objednávky (recepty × ingredient cost). Sklad už bol odpísaný
// pri /send (deductStockForSentItems píše stock_movements type='sale') —
// nepriregistrovávame write_off_items, inak by bola dvojitá deduplikácia.
//
// Reporty: revenue ignoruje closure_type='staff_meal'; nová riadka
// "Zamestnanecká spotreba" v P&L = SUM(write_offs.staff_meal.total_cost).
//
// Bezpečnosť: endpoint dovolí close-as-staff-meal LEN pre orders na
// stoloch v zone='zamestanci'. Iné stoly musia ísť cez normálnu platbu.
// Denné limity pre zamestnaneckú spotrebu — policy:
//   - max 5 € nápoje (bar) za deň per osoba
//   - max 1 jedlo (kuchyňa) za deň per osoba
// "Osoba" = name stola v zóne zamestanci (Yevhen / Tania / …).
// "Deň" = Bratislava calendar day (closed_at AT TIME ZONE).
// Manager (admin/manazer) môže obísť cez body.overrideLimit = true.
const STAFF_MEAL_DRINK_LIMIT_EUR = 5.00;
const STAFF_MEAL_MEAL_LIMIT = 1;

/**
 * Skontroluj denný limit zamestnaneckej spotreby pre order. Volane pri:
 *   1. /send-and-print — pred poslanim do kuchyne/baru (aby sa nepripravilo
 *      čo by tak či tak nesmelo byť konzumované)
 *   2. /close-as-staff-meal — pred zavretím objednávky (last-chance check)
 *
 * Algoritmus:
 *   - Ak table.zone != 'zamestanci' → preskočí (limit len pre staff stoly)
 *   - Sčíta dnešné staff_meal write_offs pre osobu (=table.name)
 *   - Sčíta items v aktuálnej objednávke
 *   - Porovná s limitom
 *
 * @param {object} tx — drizzle transaction handle
 * @param {number} orderId
 * @returns {Promise<null | { error, statusCode, detail }>}
 *          null = OK, object = limit prekročený
 */
async function checkStaffMealLimit(tx, orderId) {
  const [orderRow] = await tx
    .select({ id: orders.id, tableId: orders.tableId, zone: tables.zone, tableName: tables.name })
    .from(orders)
    .innerJoin(tables, eq(tables.id, orders.tableId))
    .where(eq(orders.id, orderId));
  if (!orderRow) return null; // order missing — caller handles
  if (orderRow.zone !== 'zamestanci') return null; // limit len pre staff zónu

  // Predošlé staff meals pre túto osobu DNES
  const priorRow = await tx.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN mc.dest = 'bar' THEN oi.qty * mi.price::numeric ELSE 0 END), 0)::float AS bar_value,
      COUNT(DISTINCT CASE WHEN mc.dest = 'kuchyna' THEN o.id END)::int AS meal_orders_count
    FROM write_offs wo
    INNER JOIN orders o ON o.id = wo.order_id
    INNER JOIN tables t ON t.id = o.table_id
    INNER JOIN order_items oi ON oi.order_id = o.id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN menu_categories mc ON mc.id = mi.category_id
    WHERE wo.reason = 'staff_meal'
      AND t.name = ${orderRow.tableName}
      AND (o.closed_at AT TIME ZONE 'Europe/Bratislava')::date
          = (NOW() AT TIME ZONE 'Europe/Bratislava')::date
  `);
  const prior = (priorRow.rows || priorRow)[0] || {};
  const priorBarValue = Number(prior.bar_value) || 0;
  const priorMealCount = Number(prior.meal_orders_count) || 0;

  // Aktuálna objednávka — VSETKY items (sent + unsent), lebo všetky pôjdu
  // nakoniec ako staff meal. Pri /send to zachytí aj future-send items.
  const currRow = await tx.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN mc.dest = 'bar' THEN oi.qty * mi.price::numeric ELSE 0 END), 0)::float AS bar_value,
      COUNT(CASE WHEN mc.dest = 'kuchyna' THEN 1 END)::int AS food_items_count
    FROM order_items oi
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN menu_categories mc ON mc.id = mi.category_id
    WHERE oi.order_id = ${orderId}
  `);
  const curr = (currRow.rows || currRow)[0] || {};
  const currBarValue = Number(curr.bar_value) || 0;
  const currIsMeal = Number(curr.food_items_count) > 0 ? 1 : 0;

  const totalBar = priorBarValue + currBarValue;
  const totalMeals = priorMealCount + currIsMeal;

  if (totalBar > STAFF_MEAL_DRINK_LIMIT_EUR + 0.005) {
    return {
      statusCode: 422,
      error: `Limit nápojov ${STAFF_MEAL_DRINK_LIMIT_EUR.toFixed(2)} €/deň prekročený pre ${orderRow.tableName}: `
        + `dnes už ${priorBarValue.toFixed(2)} €, táto objednávka ${currBarValue.toFixed(2)} € `
        + `(spolu ${totalBar.toFixed(2)} €). Manazer to môže obísť.`,
      detail: {
        limitType: 'drink',
        limitValue: STAFF_MEAL_DRINK_LIMIT_EUR,
        priorUsage: Math.round(priorBarValue * 100) / 100,
        attempted: Math.round(currBarValue * 100) / 100,
        wouldBeTotal: Math.round(totalBar * 100) / 100,
        personName: orderRow.tableName,
      },
    };
  }
  if (totalMeals > STAFF_MEAL_MEAL_LIMIT) {
    return {
      statusCode: 422,
      error: `Limit ${STAFF_MEAL_MEAL_LIMIT} jedlo/deň prekročený pre ${orderRow.tableName}: `
        + `dnes už ${priorMealCount} jedál. Manazer to môže obísť.`,
      detail: {
        limitType: 'meal',
        limitValue: STAFF_MEAL_MEAL_LIMIT,
        priorUsage: priorMealCount,
        attempted: currIsMeal,
        personName: orderRow.tableName,
      },
    };
  }
  return null;
}

router.post('/:id/close-as-staff-meal', asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const { version, overrideLimit } = req.body || {};
  const userRole = req.user && req.user.role;
  const canOverride = (overrideLimit === true) && (userRole === 'admin' || userRole === 'manazer');

  try {
    const result = await db.transaction(async (tx) => {
      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();

      // Načítaj order + zone + name stola (name = identita zamestnanca pre limit check)
      const [orderRow] = await tx
        .select({
          id: orders.id,
          tableId: orders.tableId,
          status: orders.status,
          zone: tables.zone,
          tableName: tables.name,
        })
        .from(orders)
        .innerJoin(tables, eq(tables.id, orders.tableId))
        .where(eq(orders.id, orderId));

      if (!orderRow) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }
      if (orderRow.status !== 'open') {
        const err = new Error('Order is not open');
        err.statusCode = 400;
        throw err;
      }
      if (orderRow.zone !== 'zamestanci') {
        const err = new Error('Iba stoly v zone "zamestanci" mozu byt uzatvorene ako zamestnanecka spotreba');
        err.statusCode = 403;
        throw err;
      }

      // Denný limit check (5 € nápoje + 1 jedlo per deň per osoba).
      // Preskočíme ak má manager override flag a má rolu manazer/admin.
      if (!canOverride) {
        const limit = await checkStaffMealLimit(tx, orderId);
        if (limit) {
          const err = new Error(limit.error);
          err.statusCode = limit.statusCode;
          err.detail = limit.detail;
          throw err;
        }
      }

      // Vypocitaj COGS (suroviny × cena ingredient) za celu objednavku.
      // Ak polozka nema recept (napr. coca-cola s trackMode='simple'),
      // jej cogs je 0 — nealko sa odpisuje cez stock_movements priamo.
      const cogsRow = await tx.execute(sql`
        SELECT COALESCE(SUM(oi.qty * r.qty_per_unit::numeric * i.cost_per_unit::numeric), 0)::numeric(12,2) AS cogs
        FROM order_items oi
        LEFT JOIN recipes r ON r.menu_item_id = oi.menu_item_id
        LEFT JOIN ingredients i ON i.id = r.ingredient_id
        WHERE oi.order_id = ${orderId}
      `);
      const totalCogs = cogsRow.rows[0]?.cogs ?? '0.00';

      // Update order
      const [closedOrder] = await tx.update(orders)
        .set({
          status: 'closed',
          closureType: 'staff_meal',
          closedAt: new Date(),
        })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'open')))
        .returning();

      if (!closedOrder) {
        // Race s inou paralelnou platbou — order sa medzitým uzavrel.
        const err = new Error('Order is not open');
        err.statusCode = 409;
        throw err;
      }

      // Write-off zaznam — auto-approved (zamestnanecka spotreba je
      // automaticky schvalena, nepotrebuje manazerske approval).
      const [woRow] = await tx.insert(writeOffs).values({
        status: 'approved',
        reason: 'staff_meal',
        note: `Zamestnanecka spotreba — order #${orderId}`,
        totalCost: String(totalCogs),
        orderId,
        createdBy: req.user.id,
        approvedBy: req.user.id,
        approvedAt: new Date(),
      }).returning();

      // Uvolni stol ak ziadne ine open orders
      const remaining = await tx.select().from(orders)
        .where(and(eq(orders.tableId, closedOrder.tableId), eq(orders.status, 'open')));
      if (!remaining.length) {
        await tx.update(tables).set({ status: 'free' }).where(eq(tables.id, closedOrder.tableId));
      }

      return { order: closedOrder, writeOff: woRow, totalCogs };
    });

    logEvent(db, {
      orderId,
      type: 'order_closed_staff_meal',
      payload: { totalCogs: result.totalCogs, writeOffId: result.writeOff.id },
      staffId: req.user.id,
    }).catch(e => console.error('Audit log error:', e));
    emitEvent(req, 'order:closed', { tableId: result.order.tableId, orderId });

    res.json({
      order: result.order,
      writeOff: result.writeOff,
      totalCogs: result.totalCogs,
    });
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    if (e.statusCode) {
      // Pre limit chyby (422) vrátime aj detail aby frontend mohol zobraziť
      // manager override flow s konkrétnymi číslami.
      const body = { error: e.message };
      if (e.detail) body.detail = e.detail;
      return res.status(e.statusCode).json(body);
    }
    throw e;
  }
}));

// POST /api/orders/:id/send — mark all unsent items as sent + deduct stock
router.post('/:id/send', asyncRoute(async (req, res) => {
  const orderId = +req.params.id;

  const { unsentItems, stockResult } = await db.transaction(async (tx) => {
    await bumpVersion(tx, orderId);
    const unsentItems = await tx.select({
      id: orderItems.id, name: menuItems.name, emoji: menuItems.emoji,
      qty: orderItems.qty, note: orderItems.note, menuItemId: orderItems.menuItemId
    })
    .from(orderItems)
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.sent, false)))
    .orderBy(orderItems.id);

    if (unsentItems.length) {
      await tx.update(orderItems).set({ sent: true })
        .where(and(eq(orderItems.orderId, orderId), eq(orderItems.sent, false)));
    }

    const stockResult = await deductStockForSentItems(tx, unsentItems, req.user.id, orderId);
    await consolidateSentOrderItems(tx, orderId);
    return { unsentItems, stockResult };
  });

  if (stockResult.alerts.length) {
    emitEvent(req, 'inventory:low-stock', { alerts: stockResult.alerts });
  }

  logEvent(db, { orderId, type: 'order_sent', payload: { itemCount: unsentItems.length }, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
  emitEvent(req,'order:sent', { orderId });
  res.json({ markedItems: unsentItems });
}));

// POST /api/orders/:id/send-and-print — mark unsent as sent, deduct stock, return items for printing
// Reverted (commit pred týmto): limit check pri /send vyhadzoval manager PIN
// aj pri legitímnom prídavaní jedla (ak dnes už 1 staff meal existoval).
// Cashier flow → kuchyna dostane bon hneď, limit sa overí pri uzavretí
// účtu (close-as-staff-meal). Manager rozhodne pri zatváraní účtu.
router.post('/:id/send-and-print', asyncRoute(async (req, res) => {
  const orderId = +req.params.id;

  const { unsentItems, stockResult } = await db.transaction(async (tx) => {
    const unsentItems = await tx.select({
      id: orderItems.id, name: menuItems.name, emoji: menuItems.emoji,
      qty: orderItems.qty, note: orderItems.note, menuItemId: orderItems.menuItemId,
      sent: orderItems.sent,
    })
    .from(orderItems)
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.sent, false)))
    .orderBy(orderItems.id);

    if (!unsentItems.length) return { unsentItems: [], stockResult: { movements: [], alerts: [] } };

    await tx.update(orderItems).set({ sent: true })
      .where(and(eq(orderItems.orderId, orderId), eq(orderItems.sent, false)));

    const stockResult = await deductStockForSentItems(tx, unsentItems, req.user.id, orderId);
    await consolidateSentOrderItems(tx, orderId);
    return { unsentItems, stockResult };
  });

  if (!unsentItems.length) return res.json({ printed: 0, items: [] });

  if (stockResult.alerts.length) {
    emitEvent(req, 'inventory:low-stock', { alerts: stockResult.alerts });
  }

  logEvent(db, { orderId, type: 'order_sent', payload: { itemCount: unsentItems.length }, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
  emitEvent(req,'order:sent', { orderId });
  res.json({
    printed: unsentItems.length,
    items: unsentItems.map(i => ({ id: i.id, name: i.name, emoji: i.emoji, qty: i.qty, note: i.note, menuItemId: i.menuItemId }))
  });
}));

// POST /api/orders/:id/send-storno-and-print — log storno dispatch and return normalized items for printing
// Role-gated: storno of sent items je manager-level akcia (kuchyna už recept
// dostal, kvôli zodpovednosti a inventory dopadu len manazer/admin môže
// triggerovať). Cisnik dostane 403 — frontend ho cez showManagerPin gate
// zavedie na PIN prompt.
router.post('/:id/send-storno-and-print', requireRole('manazer', 'admin'), validate(stornoSendSchema), asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const requestedItems = req.body.items || [];

  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!requestedItems.length) return res.json({ printed: 0, items: [] });

  const menuItemIds = [...new Set(requestedItems.map((item) => item.menuItemId))];
  const menuRows = await db.select({
    id: menuItems.id,
    name: menuItems.name,
    emoji: menuItems.emoji,
  })
    .from(menuItems)
    .where(inArray(menuItems.id, menuItemIds));

  const menuById = new Map(menuRows.map((row) => [row.id, row]));
  const missingMenuItemId = menuItemIds.find((id) => !menuById.has(id));
  if (missingMenuItemId) {
    return res.status(400).json({ error: 'Menu item not found', menuItemId: missingMenuItemId });
  }

  const stornoItems = requestedItems.map((item) => {
    const menuRow = menuById.get(item.menuItemId);
    return {
      menuItemId: item.menuItemId,
      name: menuRow.name,
      emoji: menuRow.emoji,
      qty: item.qty,
      note: item.note || '',
    };
  });

  await logEvent(db, {
    orderId,
    type: 'order_storno_sent',
    payload: {
      itemCount: stornoItems.length,
      items: stornoItems.map((item) => ({
        menuItemId: item.menuItemId,
        qty: item.qty,
        note: item.note,
      })),
    },
    staffId: req.user.id,
  });

  emitEvent(req, 'order:storno-sent', { orderId });
  res.json({ printed: stornoItems.length, items: stornoItems });
}));

// POST /api/orders/:id/split — split bill into multiple orders
router.post('/:id/split', validate(splitSchema), asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const { parts, itemGroups } = req.body;

  const result = await db.transaction(async (tx) => {
    // Get the original order (locked inside tx)
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return { status: 404, error: 'Order not found' };
    if (order.status !== 'open') return { status: 400, error: 'Order is not open' };

    // Get all items for this order
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    if (!items.length) return { status: 400, error: 'Order has no items' };

    if (itemGroups && Array.isArray(itemGroups)) {
      // === Split by item groups ===
      const newOrderIds = [];

      for (let i = 0; i < itemGroups.length; i++) {
        const groupItemIds = itemGroups[i];
        if (!groupItemIds.length) continue;

        const existing = await tx.select().from(orders)
          .where(and(eq(orders.tableId, order.tableId), eq(orders.status, 'open')));
        const label = 'Ucet ' + (existing.length + 1);

        const [newOrder] = await tx.insert(orders).values({
          tableId: order.tableId, staffId: order.staffId, shiftId: order.shiftId, label,
        }).returning();

        for (const itemId of groupItemIds) {
          await tx.update(orderItems)
            .set({ orderId: newOrder.id })
            .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)));
        }
        newOrderIds.push(newOrder.id);
      }

      const remaining = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      if (!remaining.length) {
        await tx.delete(orders).where(eq(orders.id, orderId));
      }
      return { ok: true, newOrderIds, tableId: order.tableId, originalOrderId: orderId };

    } else {
      // === Equal split ===
      const n = Math.max(2, Math.min(10, parseInt(parts) || 2));
      const groups = Array.from({ length: n }, () => []);
      items.forEach((item, idx) => { groups[idx % n].push(item); });

      const existingOrders = await tx.select().from(orders)
        .where(and(eq(orders.tableId, order.tableId), eq(orders.status, 'open')));
      const baseCount = existingOrders.filter(o => o.id !== orderId).length;

      const newOrderIds = [];
      for (let i = 0; i < n; i++) {
        const label = 'Ucet ' + (baseCount + i + 1);
        const [newOrder] = await tx.insert(orders).values({
          tableId: order.tableId, staffId: order.staffId, shiftId: order.shiftId, label,
        }).returning();

        for (const item of groups[i]) {
          await tx.update(orderItems).set({ orderId: newOrder.id }).where(eq(orderItems.id, item.id));
        }
        newOrderIds.push(newOrder.id);
      }

      await tx.delete(orders).where(eq(orders.id, orderId));
      return { ok: true, newOrderIds, tableId: order.tableId, originalOrderId: orderId };
    }
  });

  if (result.error) return res.status(result.status).json({ error: result.error });

  const logOrderId = result.newOrderIds[0] || result.originalOrderId;
  logEvent(db, { orderId: logOrderId, type: 'order_split', payload: { originalOrderId: result.originalOrderId, newOrderIds: result.newOrderIds }, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
  emitEvent(req, 'order:split', { tableId: result.tableId });
  res.json({ newOrderIds: result.newOrderIds });
}));

// POST /api/orders/:id/move-items — move items to another table.
// Two payload variants supported (in priority order):
//   • itemQtys: [{itemId, qty}]  — partial-move; ak qty < item.qty, riadok
//     sa rozdelí (zdroj si nechá zvyšok, destinácia dostane new row s qty).
//   • itemIds: [number]          — legacy/full-move (kompletné riadky).
router.post('/:id/move-items', validate(moveItemsSchema), asyncRoute(async (req, res) => {
  const sourceOrderId = +req.params.id;
  const { itemIds, itemQtys, targetTableId, targetOrderId } = req.body;

  // Normalizácia: itemQtys má prednosť. Ak chýba, prevedieme itemIds na
  // ekvivalent {itemId, qty: <pôvodné qty>} (qty=null znamená 'celé').
  const moveSpec = (itemQtys && itemQtys.length)
    ? itemQtys
    : ((itemIds && itemIds.length) ? itemIds.map(id => ({ itemId: id, qty: null })) : []);

  if (!moveSpec.length) return res.status(400).json({ error: 'itemIds or itemQtys required' });
  if (!targetTableId && !targetOrderId) return res.status(400).json({ error: 'targetTableId or targetOrderId required' });

  const result = await db.transaction(async (tx) => {
    // Verify source order exists
    const [sourceOrder] = await tx.select().from(orders).where(eq(orders.id, sourceOrderId));
    if (!sourceOrder) return { status: 404, error: 'Source order not found' };

    let destOrderId = targetOrderId;

    if (destOrderId) {
      const [targetOrder] = await tx.select().from(orders).where(eq(orders.id, destOrderId));
      if (!targetOrder || targetOrder.status !== 'open') {
        return { status: 400, error: 'Target order not found or not open' };
      }
    } else {
      const [existingOrder] = await tx.select().from(orders)
        .where(and(eq(orders.tableId, targetTableId), eq(orders.status, 'open')))
        .limit(1);

      if (existingOrder) {
        destOrderId = existingOrder.id;
      } else {
        const existing = await tx.select().from(orders)
          .where(and(eq(orders.tableId, targetTableId), eq(orders.status, 'open')));
        const label = 'Ucet ' + (existing.length + 1);

        const [newOrder] = await tx.insert(orders).values({
          tableId: targetTableId, staffId: sourceOrder.staffId, shiftId: sourceOrder.shiftId, label,
        }).returning();
        destOrderId = newOrder.id;
      }
    }

    // Move items: pre každý spec si načítaj zdrojový riadok, rozhodni
    // medzi celkovým presunom (UPDATE orderId) alebo splitom (UPDATE qty
    // na zdroji + INSERT s tým istým menu_item_id, sent, note do destinácie).
    const movedItemIds = [];
    for (const spec of moveSpec) {
      const [src] = await tx.select().from(orderItems)
        .where(and(eq(orderItems.id, spec.itemId), eq(orderItems.orderId, sourceOrderId)));
      if (!src) continue; // riadok medzitým zmazaný / preindexovaný
      const requestedQty = (spec.qty == null) ? src.qty : Math.min(spec.qty, src.qty);
      if (requestedQty <= 0) continue;

      if (requestedQty >= src.qty) {
        // Celý riadok sa presúva — len update orderId.
        await tx.update(orderItems)
          .set({ orderId: destOrderId })
          .where(eq(orderItems.id, src.id));
        movedItemIds.push(src.id);
      } else {
        // Čiastočný presun — split na dva riadky. Zdroj si nechá zvyšok,
        // destinácia dostane nový riadok s rovnakým menu_item_id/note/sent.
        await tx.update(orderItems)
          .set({ qty: src.qty - requestedQty })
          .where(eq(orderItems.id, src.id));
        const [newRow] = await tx.insert(orderItems).values({
          orderId: destOrderId,
          menuItemId: src.menuItemId,
          qty: requestedQty,
          note: src.note,
          sent: src.sent,
        }).returning();
        movedItemIds.push(newRow.id);
      }
    }

    // Check if source order has no items left
    const remaining = await tx.select().from(orderItems).where(eq(orderItems.orderId, sourceOrderId));
    let sourceDeleted = false;
    if (!remaining.length) {
      await tx.delete(orders).where(eq(orders.id, sourceOrderId));
      sourceDeleted = true;
      const otherOrders = await tx.select().from(orders)
        .where(and(eq(orders.tableId, sourceOrder.tableId), eq(orders.status, 'open')));
      if (!otherOrders.length) {
        await tx.update(tables).set({ status: 'free' }).where(eq(tables.id, sourceOrder.tableId));
      }
    }

    // Set target table to occupied
    const tid = targetTableId || (await tx.select().from(orders).where(eq(orders.id, destOrderId)))[0]?.tableId;
    if (tid) {
      await tx.update(tables).set({ status: 'occupied' }).where(eq(tables.id, tid));
    }

    return { ok: true, destOrderId, sourceDeleted, sourceTableId: sourceOrder.tableId, targetTableId: tid, movedItemIds };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });

  const auditOrderId = result.sourceDeleted ? result.destOrderId : sourceOrderId;
  logEvent(db, {
    orderId: auditOrderId, type: 'items_moved',
    payload: {
      sourceOrderId,
      moveSpec,
      movedItemIds: result.movedItemIds,
      targetOrderId: result.destOrderId,
      sourceOrderDeleted: result.sourceDeleted,
    },
    staffId: req.user.id,
  }).catch(e => console.error('Audit log error:', e));
  emitEvent(req,'items:moved', { sourceTableId: result.sourceTableId, targetTableId: result.targetTableId });
  res.json({ movedItems: result.movedItemIds, targetOrderId: result.destOrderId });
}));

// POST /api/orders/:id/discount — apply discount to order
router.post('/:id/discount', requireRole('manazer', 'admin'), validate(discountSchema), asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const { discountId, customPercent, version } = req.body;

  // Get order
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return res.status(404).json({ error: 'Objednavka nenajdena' });

  if (!discountId && customPercent === undefined) {
    return res.status(400).json({ error: 'discountId alebo customPercent je povinny' });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();

      // Calculate order subtotal inside tx so concurrent item adds cannot leave it stale
      const items = await tx.select({
        qty: orderItems.qty,
        price: menuItems.price,
      })
      .from(orderItems)
      .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
      .where(eq(orderItems.orderId, orderId));

      const subtotal = items.reduce((s, i) => s + parseFloat(i.price) * i.qty, 0);

      let discountAmount = 0;
      let appliedDiscountId = null;

      if (discountId) {
        const [disc] = await tx.select().from(discounts).where(eq(discounts.id, discountId));
        if (!disc) return { error: 'Zlava nenajdena', status: 404 };

        appliedDiscountId = disc.id;
        const discValue = parseFloat(disc.value);
        if (disc.type === 'percent') {
          discountAmount = Math.round(subtotal * discValue / 100 * 100) / 100;
        } else {
          discountAmount = Math.min(discValue, subtotal);
        }
      } else {
        const pct = Math.max(0, Math.min(100, parseFloat(customPercent) || 0));
        discountAmount = Math.round(subtotal * pct / 100 * 100) / 100;
      }

      const [updated] = await tx.update(orders).set({
        discountId: appliedDiscountId,
        discountAmount: String(discountAmount),
      }).where(eq(orders.id, orderId)).returning();
      return { updated, appliedDiscountId, discountAmount };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });

    const { updated, appliedDiscountId, discountAmount } = result;
    logEvent(db, { orderId, type: 'discount_applied', payload: { discountId: appliedDiscountId, discountAmount, customPercent }, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
    res.json({ ...updated, discountAmount: parseFloat(updated.discountAmount) });
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    throw e;
  }
}));

// DELETE /api/orders/:id/discount — remove discount from order
router.delete('/:id/discount', requireRole('manazer', 'admin'), asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const { version } = req.body || {};

  if (req.user.role === 'cisnik') {
    return res.status(403).json({ error: 'Pristup odmietnuty' });
  }

  try {
    const { updated, previousDiscountId } = await db.transaction(async (tx) => {
      // Query before update to capture previous discountId
      const [existing] = await tx.select().from(orders).where(eq(orders.id, orderId));

      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();

      const [updated] = await tx.update(orders).set({
        discountId: null,
        discountAmount: null,
      }).where(eq(orders.id, orderId)).returning();

      return { updated, previousDiscountId: existing?.discountId };
    });

    if (!updated) return res.status(404).json({ error: 'Objednavka nenajdena' });
    logEvent(db, { orderId, type: 'discount_removed', payload: { previousDiscountId }, staffId: req.user.id }).catch(e => console.error('Audit log error:', e));
    res.json({ ...updated, discountAmount: null });
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    throw e;
  }
}));

// DELETE /api/orders/:id — cancel order (celá objednávka zo stola)
// Čašník: iba ak ešte neexistuje platba (inak len manazer/admin — uhradené treba riešiť cez storno platby).
router.delete('/:id', asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const { version } = req.body || {};

  try {
    const tableId = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
      if (!order) return null;

      const [existingPay] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)).limit(1);
      if (req.user.role === 'cisnik' && existingPay) {
        const err = new Error('PAYMENT_BLOCKS_CISNIK');
        err.status = 403;
        throw err;
      }

      const bumped = await bumpVersion(tx, orderId, version);
      if (version !== undefined && !bumped) throw new VersionConflictError();

      const payRows = await tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId));
      const paymentIds = payRows.map((r) => r.id);
      if (paymentIds.length) {
        await tx.delete(fiscalDocuments).where(
          or(eq(fiscalDocuments.orderId, orderId), inArray(fiscalDocuments.paymentId, paymentIds)),
        );
        await tx.delete(payments).where(eq(payments.orderId, orderId));
      } else {
        await tx.delete(fiscalDocuments).where(eq(fiscalDocuments.orderId, orderId));
      }

      // Log audit BEFORE delete (cascade would remove audit records)
      await logEvent(tx, { orderId, type: 'order_cancelled', payload: { tableId: order.tableId }, staffId: req.user.id });

      await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await tx.delete(orders).where(eq(orders.id, orderId));

      // Free the table only if no other open orders remain
      const remaining = await tx.select().from(orders)
        .where(and(eq(orders.tableId, order.tableId), eq(orders.status, 'open')));
      if (!remaining.length) {
        await tx.update(tables).set({ status: 'free' }).where(eq(tables.id, order.tableId));
      }
      return order.tableId;
    });

    if (tableId == null) return res.status(404).json({ error: 'Objednavka nenajdena' });
    emitEvent(req, 'order:cancelled', { tableId, orderId });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof VersionConflictError) return res.status(409).json({ error: VERSION_CONFLICT_MSG });
    if (e && e.status === 403) {
      return res.status(403).json({
        error: 'Objednavku s platbou moze zrusit len manazer alebo admin (najprv storno platby v administracii, ak treba).',
      });
    }
    throw e;
  }
}));

// POST /api/orders/:id/storno-write-off — create write-off from POS storno
// Kept for backward-compat (admin direct write-off, e.g. from inventory page).
// Production cashier flow now goes through /api/storno-basket → admin resolves.
// Schema-validated (PR-2.2) and gated to manazer/admin role.
router.post('/:id/storno-write-off', requireRole('manazer', 'admin'), validate(stornoWriteOffSchema), asyncRoute(async (req, res) => {
  const orderId = +req.params.id;
  const { menuItemId, qty, reason, note, returnToStock } = req.body;
  const staffId = req.user.id;
  const woReason = reason;

  try {
    const result = await db.transaction(async (tx) => {
      const [mi] = await tx.select().from(menuItems).where(eq(menuItems.id, menuItemId));
      if (!mi) return { skipped: true, reason: 'menu item not found' };

      const out = await applyStornoStockResolution(tx, {
        menuItem: mi,
        qty,
        wasPrepared: !returnToStock,
        reason: woReason,
        note,
        orderId,
        staffId,
      });

      const eventType = out.action === 'returned' ? 'storno_return' : 'storno_write_off';
      logEvent(tx, { orderId, type: eventType, payload: { menuItemId, qty, reason: woReason, note: note || '', writeOffId: out.writeOffId, totalCost: out.totalCost }, staffId }).catch(() => {});
      return out;
    });

    res.json(result);
  } catch (err) {
    console.error('Storno write-off failed:', err);
    res.status(500).json({ error: 'Storno write-off failed' });
  }
}));

// GET /api/orders/:id/events — audit log for an order (manazer/admin only)
router.get('/:id/events', asyncRoute(async (req, res) => {
  if (req.user.role === 'cisnik') return res.status(403).json({ error: 'Pristup odmietnuty' });
  const orderId = +req.params.id;
  const events = await db.select().from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(orderEvents.createdAt);
  res.json(events);
}));

export default router;

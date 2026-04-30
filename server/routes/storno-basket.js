// Storno basket — bucket pre stornované poslané položky.
//
//   POST   /api/storno-basket           cashier zaznamená storno (žiaden stock change)
//   GET    /api/storno-basket           pending items + summary
//   POST   /api/storno-basket/:id/resolve  admin spracuje → stock revert / write-off
//   DELETE /api/storno-basket/:id       admin zruší záznam (storno bolo omyl, žiaden stock action)
//
// Stock manipulation sa robí IBA pri /resolve, nie pri POST. Cashier flow má
// vždy tichý zápis; rozhodnutie o sklade ide cez admin Storno stránku.

import { Router } from 'express';
import { sql, eq, isNull, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stornoBasket, menuItems, staff } from '../db/schema.js';
import { requireRole } from '../middleware/requireRole.js';
import { asyncRoute } from '../lib/async-route.js';
import { applyStornoStockResolution } from '../lib/storno-stock.js';
import { logEvent } from '../lib/audit.js';
import { emitEvent } from '../lib/emit.js';

const router = Router();

const VALID_REASONS = ['order_error', 'complaint', 'breakage', 'staff_meal', 'other'];

// POST /api/storno-basket — cashier zaznamenáva storno
router.post('/', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const menuItemId = +body.menuItemId;
  const qty = +body.qty || 1;
  const itemName = String(body.name || body.itemName || '').slice(0, 100);
  const unitPrice = body.unitPrice != null ? Number(body.unitPrice) : 0;
  const note = String(body.note || '').slice(0, 200);
  const orderId = body.orderId != null ? +body.orderId : null;
  const reason = VALID_REASONS.includes(body.reason) ? body.reason : 'other';
  const wasPrepared = !!body.wasPrepared;

  if (!menuItemId || !qty || qty <= 0 || !itemName) {
    return res.status(400).json({ error: 'menuItemId, qty (>0) a name su povinne' });
  }

  // Verify menu item exists (FK guards too, but fail-fast with a friendly error)
  const [mi] = await db.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.id, menuItemId)).limit(1);
  if (!mi) return res.status(400).json({ error: 'Menu item not found' });

  const [row] = await db.insert(stornoBasket).values({
    menuItemId,
    qty,
    itemName,
    unitPrice: String(unitPrice.toFixed(2)),
    note,
    orderId,
    staffId: req.user.id,
    reason,
    wasPrepared,
  }).returning();

  emitEvent(req, 'storno-basket:updated', { id: row.id, action: 'created' });
  res.status(201).json(row);
}));

// GET /api/storno-basket — pending records (resolvedAt IS NULL)
router.get('/', asyncRoute(async (req, res) => {
  const rows = await db
    .select({
      id: stornoBasket.id,
      menuItemId: stornoBasket.menuItemId,
      qty: stornoBasket.qty,
      itemName: stornoBasket.itemName,
      unitPrice: stornoBasket.unitPrice,
      note: stornoBasket.note,
      reason: stornoBasket.reason,
      wasPrepared: stornoBasket.wasPrepared,
      orderId: stornoBasket.orderId,
      staffId: stornoBasket.staffId,
      staffName: staff.name,
      createdAt: stornoBasket.createdAt,
    })
    .from(stornoBasket)
    .leftJoin(staff, eq(stornoBasket.staffId, staff.id))
    .where(isNull(stornoBasket.resolvedAt))
    .orderBy(desc(stornoBasket.createdAt))
    .limit(200);

  let pendingValue = 0;
  let pendingCount = 0;
  const items = rows.map((r) => {
    const price = Number(r.unitPrice || 0);
    pendingCount += r.qty;
    pendingValue += price * r.qty;
    return {
      id: r.id,
      menuItemId: r.menuItemId,
      qty: r.qty,
      itemName: r.itemName,
      unitPrice: price,
      note: r.note || '',
      reason: r.reason,
      wasPrepared: !!r.wasPrepared,
      orderId: r.orderId,
      staffId: r.staffId,
      staffName: r.staffName || '',
      createdAt: r.createdAt,
    };
  });

  res.json({
    summary: {
      pendingCount,
      pendingValue: Math.round(pendingValue * 100) / 100,
      rowCount: items.length,
    },
    items,
  });
}));

// POST /api/storno-basket/:id/resolve — admin spracuje (apply stock action)
// body: { override?: { wasPrepared?: boolean, reason?: string } }  — optional admin override
router.post('/:id/resolve', requireRole('manazer', 'admin'), asyncRoute(async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

  const override = (req.body && req.body.override) || {};
  const wasPreparedOverride = override.wasPrepared !== undefined ? !!override.wasPrepared : null;
  const reasonOverride = VALID_REASONS.includes(override.reason) ? override.reason : null;

  try {
    const result = await db.transaction(async (tx) => {
      // Lock the row to prevent double-resolve in a race
      const lockedRows = await tx.execute(sql`SELECT * FROM storno_basket WHERE id = ${id} FOR UPDATE`);
      const lockedArr = lockedRows.rows || lockedRows;
      if (!lockedArr || !lockedArr.length) {
        const e = new Error('not_found'); e.status = 404; throw e;
      }
      const row = lockedArr[0];
      if (row.resolved_at) {
        const e = new Error('already_resolved'); e.status = 409; throw e;
      }

      const [mi] = await tx.select().from(menuItems).where(eq(menuItems.id, row.menu_item_id)).limit(1);
      if (!mi) { const e = new Error('menu_item_missing'); e.status = 410; throw e; }

      const wasPrepared = wasPreparedOverride !== null ? wasPreparedOverride : !!row.was_prepared;
      const reason = reasonOverride || row.reason || 'other';

      const out = await applyStornoStockResolution(tx, {
        menuItem: mi,
        qty: row.qty,
        wasPrepared,
        reason,
        note: row.note,
        orderId: row.order_id,
        staffId: req.user.id,
      });

      await tx.update(stornoBasket)
        .set({ resolvedAt: new Date(), resolvedByStaffId: req.user.id })
        .where(eq(stornoBasket.id, id));

      // Audit logging is INTENTIONALLY done outside the transaction (after
      // commit) — order_id on the basket row may point to an auto-deleted
      // empty order, and order_events.order_id has a NOT NULL FK that would
      // abort the resolve transaction (silently rolling back the stock
      // change) if we tried to insert with tx.
      return { out, eventOrderId: row.order_id, reason, wasPrepared };
    });

    const { out, eventOrderId, reason: resolvedReason, wasPrepared: resolvedWasPrepared } = result;
    const eventType = out.action === 'returned' ? 'storno_basket_returned' : 'storno_basket_write_off';
    if (eventOrderId) {
      logEvent(db, {
        orderId: eventOrderId,
        type: eventType,
        payload: {
          basketId: id, menuItemId: out.menuItemId, qty: out.qty,
          reason: resolvedReason, wasPrepared: resolvedWasPrepared,
          writeOffId: out.writeOffId, totalCost: out.totalCost,
        },
        staffId: req.user.id,
      }).catch((e) => console.warn('storno_basket audit log skipped:', e && e.message));
    }

    emitEvent(req, 'storno-basket:updated', { id, action: 'resolved' });
    res.json({ ok: true, result: out });
  } catch (e) {
    if (e && e.status === 404) return res.status(404).json({ error: 'Záznam nenájdený' });
    if (e && e.status === 409) return res.status(409).json({ error: 'Už spracované' });
    if (e && e.status === 410) return res.status(410).json({ error: 'Menu item už neexistuje' });
    console.error('storno-basket resolve error:', e);
    res.status(500).json({ error: 'Spracovanie zlyhalo' });
  }
}));

// DELETE /api/storno-basket/:id — admin zruší záznam (no stock action)
router.delete('/:id', requireRole('manazer', 'admin'), asyncRoute(async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  await db.delete(stornoBasket).where(eq(stornoBasket.id, id));
  emitEvent(req, 'storno-basket:updated', { id, action: 'deleted' });
  res.json({ ok: true });
}));

export default router;

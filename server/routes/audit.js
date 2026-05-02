// Audit log surface — exposes the order_events table that every order
// route already writes to via lib/audit.js. The table answers 'who did
// what to which order, when' and is the primary forensic tool when
// something looks wrong (missing items, suspicious storno, etc).
//
// We don't add new logging here — order_events is already populated by
// orders.js and storno-basket.js. This route just makes the contents
// browsable from the admin UI without SSH+psql.

import { Router } from 'express';
import { db } from '../db/index.js';
import { orderEvents, staff, orders, tables } from '../db/schema.js';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

// GET /api/audit/order-events?from=YYYY-MM-DD&to=YYYY-MM-DD&staffId=&type=&orderId=&limit=
//
// Defaults to today. Joins staff (actor) and orders→tables (context) so
// the admin row is human-readable without follow-up requests. Caps result
// set at 1000 rows to keep the page snappy on large date ranges.
router.get('/order-events', mgr, async (req, res) => {
  const TZ = 'Europe/Bratislava';
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || to;

  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary = sql`(${to + ' 23:59:59'})::timestamp AT TIME ZONE ${TZ}`;

  const conds = [
    gte(orderEvents.createdAt, fromBoundary),
    lte(orderEvents.createdAt, toBoundary),
  ];
  if (req.query.staffId) conds.push(eq(orderEvents.staffId, parseInt(req.query.staffId, 10)));
  if (req.query.type)    conds.push(eq(orderEvents.type, String(req.query.type)));
  if (req.query.orderId) conds.push(eq(orderEvents.orderId, parseInt(req.query.orderId, 10)));

  const limit = Math.min(parseInt(req.query.limit || '500', 10), 1000);

  const rows = await db.select({
    id:        orderEvents.id,
    orderId:   orderEvents.orderId,
    type:      orderEvents.type,
    payload:   orderEvents.payload,
    createdAt: orderEvents.createdAt,
    staffId:   orderEvents.staffId,
    staffName: staff.name,
    tableId:   orders.tableId,
    tableName: tables.name,
    orderStatus: orders.status,
    orderLabel:  orders.label,
  })
    .from(orderEvents)
    .leftJoin(staff,  eq(staff.id,  orderEvents.staffId))
    .leftJoin(orders, eq(orders.id, orderEvents.orderId))
    .leftJoin(tables, eq(tables.id, orders.tableId))
    .where(and(...conds))
    .orderBy(desc(orderEvents.createdAt))
    .limit(limit);

  // Parse JSON payload server-side so the client doesn't have to. Keep
  // raw payload too so cashier debugging never loses information.
  const out = rows.map((r) => {
    let parsed = null;
    try { parsed = JSON.parse(r.payload || '{}'); } catch { parsed = null; }
    return { ...r, payload: parsed };
  });

  res.json({
    period: { from, to },
    count: out.length,
    truncated: out.length === limit,
    events: out,
  });
});

// GET /api/audit/order-events/types — small helper for the filter dropdown.
// Returns the distinct event types we've ever logged so the UI can populate
// without a hardcoded list (and pick up new types as the codebase evolves).
router.get('/order-events/types', mgr, async (req, res) => {
  const rows = await db.execute(sql`SELECT DISTINCT type FROM order_events ORDER BY type`);
  res.json(rows.rows.map((r) => r.type));
});

export default router;

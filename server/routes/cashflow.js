import { Router } from 'express';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { cashflowEntries } from '../db/schema.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { asyncRoute } from '../lib/async-route.js';
import { createCashflowSchema, updateCashflowSchema } from '../schemas/cashflow.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

const TZ = 'Europe/Bratislava';

router.post('/', mgr, validate(createCashflowSchema), asyncRoute(async (req, res) => {
  const [row] = await db.insert(cashflowEntries).values({
    type: req.body.type,
    category: req.body.category,
    amount: String(req.body.amount),
    occurredAt: new Date(req.body.occurredAt),
    method: req.body.method,
    note: req.body.note || '',
    staffId: req.user.id,
  }).returning();
  res.status(201).json(row);
}));

router.get('/', mgr, asyncRoute(async (req, res) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || to;
  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${to + ' 23:59:59'})::timestamp AT TIME ZONE ${TZ}`;

  const conds = [
    gte(cashflowEntries.occurredAt, fromBoundary),
    lte(cashflowEntries.occurredAt, toBoundary),
  ];
  if (req.query.type === 'income' || req.query.type === 'expense') {
    conds.push(eq(cashflowEntries.type, req.query.type));
  }
  if (req.query.category) {
    conds.push(eq(cashflowEntries.category, String(req.query.category)));
  }

  const rows = await db.select().from(cashflowEntries)
    .where(and(...conds))
    .orderBy(desc(cashflowEntries.occurredAt), desc(cashflowEntries.id))
    .limit(1000);

  res.json({
    period: { from, to },
    count: rows.length,
    entries: rows,
  });
}));

export default router;

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

// Tight YYYY-MM-DD guard for from/to. Without it an unvalidated query
// param hits the `::timestamp` cast inside the sql template tag and
// throws a 500 with a Postgres stack — clients should get a 400 instead.
// Same guard is also wanted in audit.js / reports.js, tracked separately.
//
// Format check + round-trip via Date so a syntactically-valid but
// semantically-bogus value like 2026-13-99 is rejected too: parsing
// it as UTC and slicing the ISO back must yield the original string.
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function isValidIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

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
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return res.status(400).json({ error: 'Neplatný formát dátumu (očakávame YYYY-MM-DD)' });
  }
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

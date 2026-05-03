import { Router } from 'express';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { cashflowEntries, payments, shishaSales } from '../db/schema.js';
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

router.patch('/:id', mgr, validate(updateCashflowSchema), asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatné id' });

  const updates = {};
  if (req.body.type !== undefined) updates.type = req.body.type;
  if (req.body.category !== undefined) updates.category = req.body.category;
  if (req.body.amount !== undefined) updates.amount = String(req.body.amount);
  if (req.body.occurredAt !== undefined) updates.occurredAt = new Date(req.body.occurredAt);
  if (req.body.method !== undefined) updates.method = req.body.method;
  if (req.body.note !== undefined) updates.note = req.body.note;
  updates.updatedAt = new Date();

  const [row] = await db.update(cashflowEntries).set(updates).where(eq(cashflowEntries.id, id)).returning();
  if (!row) return res.status(404).json({ error: 'Záznam nenájdený' });
  res.json(row);
}));

router.delete('/:id', mgr, asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatné id' });
  const result = await db.delete(cashflowEntries).where(eq(cashflowEntries.id, id)).returning();
  if (!result.length) return res.status(404).json({ error: 'Záznam nenájdený' });
  res.status(204).end();
}));

// Summary endpoint — combines manual cashflow with already-tracked POS
// revenue (payments table) and shisha (shishaSales). Same TZ + date guard
// as the list endpoint so behavior is consistent.
router.get('/summary', mgr, asyncRoute(async (req, res) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || to;
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return res.status(400).json({ error: 'Neplatný formát dátumu (očakávame YYYY-MM-DD)' });
  }
  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${to + ' 23:59:59'})::timestamp AT TIME ZONE ${TZ}`;

  const [manualAgg] = await db.select({
    incomeTotal:  sql`COALESCE(SUM(${cashflowEntries.amount}::numeric) FILTER (WHERE ${cashflowEntries.type} = 'income'), 0)`,
    expenseTotal: sql`COALESCE(SUM(${cashflowEntries.amount}::numeric) FILTER (WHERE ${cashflowEntries.type} = 'expense'), 0)`,
    incomeCount:  sql`COUNT(*) FILTER (WHERE ${cashflowEntries.type} = 'income')`,
    expenseCount: sql`COUNT(*) FILTER (WHERE ${cashflowEntries.type} = 'expense')`,
  }).from(cashflowEntries).where(
    and(gte(cashflowEntries.occurredAt, fromBoundary), lte(cashflowEntries.occurredAt, toBoundary)),
  );

  const byCategoryRows = await db.select({
    type: cashflowEntries.type,
    category: cashflowEntries.category,
    total: sql`COALESCE(SUM(${cashflowEntries.amount}::numeric), 0)`,
    count: sql`COUNT(*)`,
  }).from(cashflowEntries).where(
    and(gte(cashflowEntries.occurredAt, fromBoundary), lte(cashflowEntries.occurredAt, toBoundary)),
  ).groupBy(cashflowEntries.type, cashflowEntries.category);

  const [posAgg] = await db.select({
    total: sql`COALESCE(SUM(${payments.amount}::numeric), 0)`,
  }).from(payments).where(
    sql`${payments.createdAt} >= ${fromBoundary} AND ${payments.createdAt} <= ${toBoundary}`,
  );

  const [shishaAgg] = await db.select({
    total: sql`COALESCE(SUM(${shishaSales.price}::numeric), 0)`,
  }).from(shishaSales).where(
    sql`${shishaSales.soldAt} >= ${fromBoundary} AND ${shishaSales.soldAt} <= ${toBoundary}`,
  );

  const manualIncome  = Number(manualAgg.incomeTotal)  || 0;
  const manualExpense = Number(manualAgg.expenseTotal) || 0;
  const posRevenue    = Number(posAgg.total)           || 0;
  const shishaRevenue = Number(shishaAgg.total)        || 0;

  const byCategory = { income: [], expense: [] };
  for (const r of byCategoryRows) {
    byCategory[r.type].push({
      category: r.category,
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
    });
  }
  byCategory.income.sort((a, b) => b.total - a.total);
  byCategory.expense.sort((a, b) => b.total - a.total);

  res.json({
    period: { from, to },
    manual: {
      income: manualIncome,
      expense: manualExpense,
      incomeCount:  Number(manualAgg.incomeCount)  || 0,
      expenseCount: Number(manualAgg.expenseCount) || 0,
    },
    posRevenue,
    shishaRevenue,
    totalIncome:  manualIncome + posRevenue + shishaRevenue,
    totalExpense: manualExpense,
    netCashflow:  manualIncome + posRevenue + shishaRevenue - manualExpense,
    byCategory,
  });
}));

export default router;

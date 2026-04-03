import { Router } from 'express';
import { db } from '../db/index.js';
import { shifts, payments, orders } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';

const router = Router();

// GET /api/shifts/current — get current open shift for authenticated user
router.get('/current', async (req, res) => {
  const staffId = req.user.id;

  const [shift] = await db.select().from(shifts)
    .where(and(eq(shifts.staffId, staffId), eq(shifts.status, 'open')))
    .limit(1);

  res.json(shift || null);
});

// GET /api/shifts/current/summary — get cash summary for current open shift
router.get('/current/summary', async (req, res) => {
  const staffId = req.user.id;

  const [shift] = await db.select().from(shifts)
    .where(and(eq(shifts.staffId, staffId), eq(shifts.status, 'open')))
    .limit(1);

  if (!shift) return res.status(404).json({ error: 'Ziadna otvorena zmena' });

  // Sum of cash payments for orders in this shift
  const cashResult = await db.select({
    total: sql`COALESCE(SUM(${payments.amount}), 0)`,
  })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(and(
      eq(orders.shiftId, shift.id),
      eq(payments.method, 'hotovost')
    ));

  const cashPayments = parseFloat(cashResult[0]?.total || '0');
  const openingCash = parseFloat(shift.openingCash);
  const expectedCash = openingCash + cashPayments;

  res.json({
    shift,
    openingCash,
    cashPayments,
    expectedCash,
  });
});

// POST /api/shifts/open — open a new shift
router.post('/open', async (req, res) => {
  const staffId = req.user.id;
  const { openingCash } = req.body;

  // Check for existing open shift
  const [existing] = await db.select().from(shifts)
    .where(and(eq(shifts.staffId, staffId), eq(shifts.status, 'open')))
    .limit(1);

  if (existing) {
    return res.status(400).json({ error: 'Uz mate otvorenu zmenu' });
  }

  const [shift] = await db.insert(shifts).values({
    staffId,
    openingCash: String(openingCash || 0),
  }).returning();

  res.status(201).json(shift);
});

// POST /api/shifts/close — close current shift
router.post('/close', async (req, res) => {
  const staffId = req.user.id;
  const { closingCash } = req.body;

  const [shift] = await db.select().from(shifts)
    .where(and(eq(shifts.staffId, staffId), eq(shifts.status, 'open')))
    .limit(1);

  if (!shift) {
    return res.status(404).json({ error: 'Ziadna otvorena zmena' });
  }

  // Calculate expected cash
  const cashResult = await db.select({
    total: sql`COALESCE(SUM(${payments.amount}), 0)`,
  })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(and(
      eq(orders.shiftId, shift.id),
      eq(payments.method, 'hotovost')
    ));

  const cashPayments = parseFloat(cashResult[0]?.total || '0');
  const openingCash = parseFloat(shift.openingCash);
  const expectedCash = openingCash + cashPayments;
  const actualCash = parseFloat(closingCash || 0);
  const difference = actualCash - expectedCash;

  const [closed] = await db.update(shifts)
    .set({
      status: 'closed',
      closedAt: new Date(),
      closingCash: String(actualCash),
    })
    .where(eq(shifts.id, shift.id))
    .returning();

  res.json({
    shift: closed,
    openingCash,
    cashPayments,
    expectedCash,
    actualCash,
    difference,
  });
});

// GET /api/shifts/history — past shifts (admin/manazer only)
router.get('/history', async (req, res) => {
  if (req.user.role === 'cisnik') {
    return res.status(403).json({ error: 'Pristup len pre admina/manazera' });
  }

  const allShifts = await db.select().from(shifts)
    .orderBy(desc(shifts.openedAt))
    .limit(100);

  res.json(allShifts);
});

export default router;

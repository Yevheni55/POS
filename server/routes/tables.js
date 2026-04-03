import { Router } from 'express';
import { db } from '../db/index.js';
import { tables } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { createTableSchema, updateTableSchema, updateTableStatusSchema } from '../schemas/tables.js';
import { emitEvent } from '../lib/emit.js';

const router = Router();

// GET /api/tables
router.get('/', async (req, res) => {
  const result = await db.select().from(tables).orderBy(asc(tables.id));
  res.json(result);
});

// POST /api/tables (manazer/admin only)
router.post('/', requireRole('manazer', 'admin'), validate(createTableSchema), async (req, res) => {
  const result = await db.insert(tables).values(req.body).returning();
  emitEvent(req,'table:updated', { tableId: result[0].id });
  res.status(201).json(result[0]);
});

// PUT /api/tables/:id (manazer/admin only)
router.put('/:id', requireRole('manazer', 'admin'), validate(updateTableSchema), async (req, res) => {
  const result = await db.update(tables).set(req.body).where(eq(tables.id, +req.params.id)).returning();
  emitEvent(req,'table:updated', { tableId: +req.params.id });
  res.json(result[0]);
});

// PATCH /api/tables/:id/status — any authenticated user (POS operation)
router.patch('/:id/status', validate(updateTableStatusSchema), async (req, res) => {
  const result = await db.update(tables).set({ status: req.body.status }).where(eq(tables.id, +req.params.id)).returning();
  emitEvent(req,'table:updated', { tableId: +req.params.id });
  res.json(result[0]);
});

// DELETE /api/tables/:id (manazer/admin only)
router.delete('/:id', requireRole('manazer', 'admin'), async (req, res) => {
  await db.delete(tables).where(eq(tables.id, +req.params.id));
  emitEvent(req,'table:updated', { tableId: +req.params.id });
  res.json({ ok: true });
});

export default router;

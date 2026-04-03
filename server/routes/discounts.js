import { Router } from 'express';
import { db } from '../db/index.js';
import { discounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const router = Router();

// GET /api/discounts — list active discounts
router.get('/', async (req, res) => {
  const rows = await db.select().from(discounts).where(eq(discounts.active, true));
  res.json(rows.map(r => ({ ...r, value: parseFloat(r.value) })));
});

// GET /api/discounts/all — list all discounts (admin)
router.get('/all', async (req, res) => {
  const rows = await db.select().from(discounts);
  res.json(rows.map(r => ({ ...r, value: parseFloat(r.value) })));
});

// POST /api/discounts — create discount (admin only)
router.post('/', async (req, res) => {
  const { role } = req.user;
  if (role === 'cisnik') {
    return res.status(403).json({ error: 'Pristup odmietnuty' });
  }

  const { name, type, value } = req.body;
  if (!name || !value) {
    return res.status(400).json({ error: 'Nazov a hodnota su povinne' });
  }
  if (type && !['percent', 'fixed'].includes(type)) {
    return res.status(400).json({ error: 'Typ musi byt percent alebo fixed' });
  }

  const [row] = await db.insert(discounts).values({
    name,
    type: type || 'percent',
    value: String(value),
  }).returning();

  res.status(201).json({ ...row, value: parseFloat(row.value) });
});

// PUT /api/discounts/:id — update discount
router.put('/:id', async (req, res) => {
  const { role } = req.user;
  if (role === 'cisnik') {
    return res.status(403).json({ error: 'Pristup odmietnuty' });
  }

  const id = +req.params.id;
  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.type !== undefined) updates.type = req.body.type;
  if (req.body.value !== undefined) updates.value = String(req.body.value);
  if (req.body.active !== undefined) updates.active = req.body.active;

  const [row] = await db.update(discounts).set(updates).where(eq(discounts.id, id)).returning();
  if (!row) return res.status(404).json({ error: 'Zlava nenajdena' });
  res.json({ ...row, value: parseFloat(row.value) });
});

// DELETE /api/discounts/:id — soft delete (active=false)
router.delete('/:id', async (req, res) => {
  const { role } = req.user;
  if (role === 'cisnik') {
    return res.status(403).json({ error: 'Pristup odmietnuty' });
  }

  const id = +req.params.id;
  const [row] = await db.update(discounts).set({ active: false }).where(eq(discounts.id, id)).returning();
  if (!row) return res.status(404).json({ error: 'Zlava nenajdena' });
  res.json({ ok: true });
});

export default router;

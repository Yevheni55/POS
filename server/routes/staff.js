import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { staff } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { createStaffSchema, updateStaffSchema } from '../schemas/staff.js';

const router = Router();

// GET /api/staff — any authenticated user can list staff (needed for POS UI)
router.get('/', async (req, res) => {
  const result = await db.select({
    id: staff.id,
    name: staff.name,
    role: staff.role,
    active: staff.active,
    createdAt: staff.createdAt,
  }).from(staff).orderBy(asc(staff.id));
  res.json(result);
});

// POST /api/staff — admin only
router.post('/', requireRole('admin'), validate(createStaffSchema), async (req, res) => {
  const { name, pin, role } = req.body;
  const hashed = await bcrypt.hash(pin, 10);
  const result = await db.insert(staff).values({ name, pin: hashed, role: role || 'cisnik' }).returning();
  res.status(201).json({ ...result[0], pin: undefined });
});

// PUT /api/staff/:id — admin only
router.put('/:id', requireRole('admin'), validate(updateStaffSchema), async (req, res) => {
  const { name, pin, role, active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (role !== undefined) updates.role = role;
  if (active !== undefined) updates.active = active;
  if (pin) updates.pin = await bcrypt.hash(pin, 10);
  const result = await db.update(staff).set(updates).where(eq(staff.id, +req.params.id)).returning();
  res.json({ ...result[0], pin: undefined });
});

// DELETE /api/staff/:id — soft delete (deactivate) — admin only
router.delete('/:id', requireRole('admin'), async (req, res) => {
  await db.update(staff).set({ active: false }).where(eq(staff.id, +req.params.id));
  res.json({ ok: true });
});

export default router;

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { staff } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { createStaffSchema, updateStaffSchema } from '../schemas/staff.js';

const router = Router();

// Project bcrypt hashes to booleans so the admin UI can render
// "set" / "not set" without ever seeing hash material on the wire.
// `pin` is NOT NULL on the schema so hasPin is implicitly true for any
// existing row; we still compute it from the source field when a row from
// insert/update is passed in so we never accidentally emit a hash.
function safeStaff(s) {
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    active: s.active,
    position: s.position || '',
    hourlyRate: s.hourlyRate ?? null,
    hasPin: !!s.pin,
    hasAttendancePin: !!s.attendancePin,
    createdAt: s.createdAt,
  };
}

// GET /api/staff — any authenticated user can list staff (needed for POS UI).
// Never selects pin / attendance_pin so hashes cannot leak into responses.
router.get('/', async (req, res) => {
  const result = await db.select({
    id: staff.id,
    name: staff.name,
    role: staff.role,
    active: staff.active,
    position: staff.position,
    hourlyRate: staff.hourlyRate,
    attendancePin: staff.attendancePin, // selected only to compute hasAttendancePin
    createdAt: staff.createdAt,
  }).from(staff).orderBy(asc(staff.id));
  // Mark hasPin = true (column is NOT NULL on the schema), and reduce
  // attendancePin to a boolean before sending.
  res.json(result.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    active: row.active,
    position: row.position || '',
    hourlyRate: row.hourlyRate ?? null,
    hasPin: true,
    hasAttendancePin: !!row.attendancePin,
    createdAt: row.createdAt,
  })));
});

// POST /api/staff — admin only
router.post('/', requireRole('admin'), validate(createStaffSchema), async (req, res) => {
  const { name, pin, role, position, hourlyRate, attendancePin } = req.body;
  const insertValues = {
    name,
    pin: await bcrypt.hash(pin, 10),
    role: role || 'cisnik',
  };
  if (position !== undefined) insertValues.position = position;
  if (hourlyRate !== undefined && hourlyRate !== null) {
    insertValues.hourlyRate = String(hourlyRate);
  }
  if (attendancePin) {
    insertValues.attendancePin = await bcrypt.hash(attendancePin, 10);
  }
  const [created] = await db.insert(staff).values(insertValues).returning();
  res.status(201).json(safeStaff(created));
});

// PUT /api/staff/:id — admin only
router.put('/:id', requireRole('admin'), validate(updateStaffSchema), async (req, res) => {
  const { name, pin, role, active, position, hourlyRate, attendancePin } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (role !== undefined) updates.role = role;
  if (active !== undefined) updates.active = active;
  if (pin) updates.pin = await bcrypt.hash(pin, 10);
  if (position !== undefined) updates.position = position;
  if (hourlyRate !== undefined && hourlyRate !== null) {
    updates.hourlyRate = String(hourlyRate);
  }
  if (attendancePin) {
    updates.attendancePin = await bcrypt.hash(attendancePin, 10);
  }
  const [updated] = await db.update(staff).set(updates).where(eq(staff.id, +req.params.id)).returning();
  res.json(safeStaff(updated));
});

// DELETE /api/staff/:id — soft delete (deactivate) — admin only
router.delete('/:id', requireRole('admin'), async (req, res) => {
  await db.update(staff).set({ active: false }).where(eq(staff.id, +req.params.id));
  res.json({ ok: true });
});

export default router;

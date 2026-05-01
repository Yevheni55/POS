import { z } from 'zod';

// Attendance / payroll fields. Kept optional so existing admin clients that
// only send {name, pin, role} continue to work; new fields are accepted on
// both POST and PUT.
const positionSchema = z.string().max(50).optional();
const hourlyRateSchema = z
  .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d{1,2})?$/)])
  .optional();
// attendancePin is a separate 4–6 digit code (different from the POS pin
// which keeps its existing min/max length rules below). It will be bcrypt
// hashed in the route handler before persisting.
const attendancePinSchema = z
  .string()
  .regex(/^\d{4,6}$/, 'PIN musi byt 4 az 6 cifier')
  .optional();

export const createStaffSchema = z.object({
  name: z.string().min(1).max(100),
  pin: z.string().min(4).max(20),
  role: z.enum(['cisnik', 'manazer', 'admin']).default('cisnik'),
  position: positionSchema,
  hourlyRate: hourlyRateSchema,
  attendancePin: attendancePinSchema,
});

export const updateStaffSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  pin: z.string().min(4).max(20).optional(),
  role: z.enum(['cisnik', 'manazer', 'admin']).optional(),
  active: z.boolean().optional(),
  position: positionSchema,
  hourlyRate: hourlyRateSchema,
  attendancePin: attendancePinSchema,
});

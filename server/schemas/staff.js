import { z } from 'zod';

export const createStaffSchema = z.object({
  name: z.string().min(1).max(100),
  pin: z.string().min(4).max(20),
  role: z.enum(['cisnik', 'manazer', 'admin']).default('cisnik'),
});

export const updateStaffSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  pin: z.string().min(4).max(20).optional(),
  role: z.enum(['cisnik', 'manazer', 'admin']).optional(),
  active: z.boolean().optional(),
});

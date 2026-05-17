import { z } from 'zod';

// Constraints na width/height — drag-resize v POS edit móde.
// Min ≥ 80 (tap target + text fit), max ≤ 240 (aby sa nepreliali cez canvas).
const TABLE_W_MIN = 80;
const TABLE_W_MAX = 240;
const TABLE_H_MIN = 80;
const TABLE_H_MAX = 200;

export const createTableSchema = z.object({
  name: z.string().min(1).max(50),
  seats: z.coerce.number().int().min(1).max(50).default(4),
  zone: z.string().max(50).default('interior'),
  shape: z.enum(['rect', 'round', 'large']).default('rect'),
  x: z.coerce.number().int().min(0).default(0),
  y: z.coerce.number().int().min(0).default(0),
  width: z.coerce.number().int().min(TABLE_W_MIN).max(TABLE_W_MAX).nullable().optional(),
  height: z.coerce.number().int().min(TABLE_H_MIN).max(TABLE_H_MAX).nullable().optional(),
});

export const updateTableSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  seats: z.coerce.number().int().min(1).max(50).optional(),
  zone: z.string().max(50).optional(),
  shape: z.enum(['rect', 'round', 'large']).optional(),
  x: z.coerce.number().int().min(0).optional(),
  y: z.coerce.number().int().min(0).optional(),
  width: z.coerce.number().int().min(TABLE_W_MIN).max(TABLE_W_MAX).nullable().optional(),
  height: z.coerce.number().int().min(TABLE_H_MIN).max(TABLE_H_MAX).nullable().optional(),
});

export const updateTableStatusSchema = z.object({
  status: z.enum(['free', 'occupied', 'reserved']),
});

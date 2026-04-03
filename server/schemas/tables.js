import { z } from 'zod';

export const createTableSchema = z.object({
  name: z.string().min(1).max(50),
  seats: z.coerce.number().int().min(1).max(50).default(4),
  zone: z.string().max(50).default('interior'),
  shape: z.enum(['rect', 'round', 'large']).default('rect'),
  x: z.coerce.number().int().min(0).default(0),
  y: z.coerce.number().int().min(0).default(0),
});

export const updateTableSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  seats: z.coerce.number().int().min(1).max(50).optional(),
  zone: z.string().max(50).optional(),
  shape: z.enum(['rect', 'round', 'large']).optional(),
  x: z.coerce.number().int().min(0).optional(),
  y: z.coerce.number().int().min(0).optional(),
});

export const updateTableStatusSchema = z.object({
  status: z.enum(['free', 'occupied', 'reserved']),
});

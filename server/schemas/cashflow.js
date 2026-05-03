import { z } from 'zod';
import { ALL_CATEGORY_SLUGS } from '../lib/cashflow-categories.js';

const baseFields = {
  type: z.enum(['income', 'expense']),
  category: z.string().min(1).max(50).refine(
    (v) => ALL_CATEGORY_SLUGS.has(v),
    { message: 'Neznáma kategória' },
  ),
  amount: z.coerce.number().positive().max(1_000_000),
  occurredAt: z.string().datetime(),
  method: z.enum(['cash', 'card', 'transfer', 'other']).default('cash'),
  note: z.string().max(500).optional().default(''),
};

export const createCashflowSchema = z.object(baseFields);

export const updateCashflowSchema = z.object({
  type: baseFields.type.optional(),
  category: baseFields.category.optional(),
  amount: baseFields.amount.optional(),
  occurredAt: baseFields.occurredAt.optional(),
  method: baseFields.method.optional(),
  note: baseFields.note,
}).refine((obj) => Object.keys(obj).length > 0, {
  message: 'Aspoň jedno pole musí byť uvedené',
});

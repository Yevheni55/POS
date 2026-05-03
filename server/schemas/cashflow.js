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
  // Optional FK to suppliers.id. Nullable so PATCH can clear an existing
  // link by sending `supplierId: null`. z.coerce so query strings on
  // frontend pickers (where ids are stringified in selects) parse cleanly.
  supplierId: z.coerce.number().int().positive().nullable().optional(),
};

export const createCashflowSchema = z.object(baseFields);

// `note` is redefined here (NOT reusing baseFields.note) because the
// create-side baseFields.note has `.default('')` — that default fires on
// PATCH `{}` too, producing `{ note: '' }` and slipping through the
// "at-least-one-field" guard below. The update path wants truly-absent
// fields to STAY absent so the refine + the route's "spread only the
// present keys" pattern (PATCH /api/cashflow/:id) work correctly.
export const updateCashflowSchema = z.object({
  type: baseFields.type.optional(),
  category: baseFields.category.optional(),
  amount: baseFields.amount.optional(),
  occurredAt: baseFields.occurredAt.optional(),
  method: baseFields.method.optional(),
  note: z.string().max(500).optional(),
  supplierId: baseFields.supplierId,
}).refine((obj) => Object.keys(obj).length > 0, {
  message: 'Aspoň jedno pole musí byť uvedené',
});

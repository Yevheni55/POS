import { z } from 'zod';

export const createOrderSchema = z.object({
  tableId: z.coerce.number().int().positive(),
  items: z.array(z.object({
    menuItemId: z.coerce.number().int().positive(),
    qty: z.coerce.number().int().min(1).default(1),
    note: z.string().max(200).default(''),
  })).default([]),
  label: z.string().max(20).optional(),
});

export const addItemsSchema = z.object({
  items: z.array(z.object({
    menuItemId: z.coerce.number().int().positive(),
    qty: z.coerce.number().int().min(1).default(1),
    note: z.string().max(200).default(''),
  })).min(1),
  version: z.coerce.number().int().optional(),
});

export const updateItemSchema = z.object({
  qty: z.coerce.number().int().min(0).optional(),
  note: z.string().max(200).optional(),
  version: z.coerce.number().int().optional(),
});

export const batchSchema = z.object({
  operations: z.array(z.object({
    action: z.enum(['add', 'update', 'remove']),
    menuItemId: z.coerce.number().int().positive().optional(),
    itemId: z.coerce.number().int().positive().optional(),
    qty: z.coerce.number().int().min(0).optional(),
    note: z.string().max(200).optional(),
  })).min(1),
  version: z.coerce.number().int().optional(),
});

export const splitSchema = z.object({
  parts: z.coerce.number().int().min(2).max(10).optional(),
  itemGroups: z.array(z.array(z.coerce.number().int())).optional(),
});

export const moveItemsSchema = z.object({
  // Backward-compat: itemIds presúva celé položky bez splitu (qty zostáva).
  // itemQtys umožňuje čiastočný presun — ak qty < pôvodné item.qty, zdroj
  // si nechá (item.qty - qty) a destinácia dostane novy riadok s 'qty'.
  // qty môže byť null/undefined → server to interpretuje ako "celé množstvo"
  // (klient posiela null pri jednoduchom kliknutí na item bez qty pickera).
  itemIds: z.array(z.coerce.number().int()).optional(),
  itemQtys: z.array(z.object({
    itemId: z.coerce.number().int(),
    qty: z.coerce.number().int().min(1).nullable().optional(),
  })).optional(),
  targetTableId: z.coerce.number().int().optional(),
  targetOrderId: z.coerce.number().int().optional(),
});

export const discountSchema = z.object({
  discountId: z.coerce.number().int().optional(),
  customPercent: z.coerce.number().min(0).max(100).optional(),
  version: z.coerce.number().int().optional(),
});

export const stornoSendSchema = z.object({
  items: z.array(z.object({
    menuItemId: z.coerce.number().int().positive(),
    qty: z.coerce.number().int().min(1),
    note: z.string().max(200).default(''),
  })).min(1),
});

export const stornoWriteOffSchema = z.object({
  menuItemId: z.coerce.number().int().positive(),
  qty: z.coerce.number().int().positive(),
  reason: z.enum(['order_error', 'complaint', 'breakage', 'staff_meal', 'other']).default('other'),
  note: z.string().max(500).optional().default(''),
  returnToStock: z.boolean().optional().default(false),
});

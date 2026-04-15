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
  itemIds: z.array(z.coerce.number().int()).min(1),
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

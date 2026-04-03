import { z } from 'zod';
import { formatSupportedVatRates, isSupportedVatRate } from '../lib/menu-vat.js';

const supportedVatRateSchema = z.coerce.number().refine(isSupportedVatRate, {
  message: `Povolene sadzby DPH: ${formatSupportedVatRates()}`,
});

export const createCategorySchema = z.object({
  slug: z.string().min(1).max(50),
  label: z.string().min(1).max(100),
  icon: z.string().min(1).max(10),
  sortKey: z.string().min(1).max(5),
  dest: z.string().max(20).default('bar'),
});

export const updateCategorySchema = z.object({
  slug: z.string().min(1).max(50).optional(),
  label: z.string().min(1).max(100).optional(),
  icon: z.string().min(1).max(10).optional(),
  sortKey: z.string().min(1).max(5).optional(),
  dest: z.string().max(20).optional(),
});

export const createMenuItemSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  name: z.string().min(1).max(100),
  emoji: z.string().min(1).max(10),
  price: z.coerce.number().min(0),
  desc: z.string().max(200).default(''),
  active: z.boolean().optional(),
  available: z.boolean().optional(),
  trackMode: z.enum(['none', 'direct', 'recipe']).default('none'),
  stockQty: z.coerce.number().min(0).default(0),
  minStockQty: z.coerce.number().min(0).default(0),
  vatRate: supportedVatRateSchema.optional(),
});

export const updateMenuItemSchema = z.object({
  categoryId: z.coerce.number().int().positive().optional(),
  name: z.string().min(1).max(100).optional(),
  emoji: z.string().min(1).max(10).optional(),
  price: z.coerce.number().min(0).optional(),
  desc: z.string().max(200).optional(),
  active: z.boolean().optional(),
  available: z.boolean().optional(),
  trackMode: z.enum(['none', 'direct', 'recipe']).optional(),
  stockQty: z.coerce.number().min(0).optional(),
  minStockQty: z.coerce.number().min(0).optional(),
  vatRate: supportedVatRateSchema.optional(),
});

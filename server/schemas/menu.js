import { z } from 'zod';
import { formatSupportedVatRates, isSupportedVatRate, SUPPORTED_VAT_RATES } from '../lib/menu-vat.js';

const supportedVatRateSchema = z.coerce.number().refine(isSupportedVatRate, {
  message: `Povolene sadzby DPH: ${formatSupportedVatRates()}`,
});

// Predvolena DPH kategorie (menu_categories.default_vat_rate). 0 % je legalna iba
// na urovni DOKLADU pre neplatitela (forceZeroVat), NIE ako vlastnost kategorie —
// inak by sa po registracii k DPH nula tichuckom preniesla na kazdu novu polozku.
const CATEGORY_VAT_RATES = SUPPORTED_VAT_RATES.filter((rate) => rate > 0);

function isCategoryVatRate(value) {
  const rate = Math.round(Number.parseFloat(value) * 100) / 100;
  return isSupportedVatRate(rate) && rate > 0;
}

// null = manazer sadzbu (este) nezvolil; prazdny string z <select> na null normalizujeme.
// Chybajuci kluc ostava `undefined`, aby PUT bez tohto pola ulozenu sadzbu NEprepisal.
const categoryDefaultVatRateSchema = z.preprocess(
  (value) => (value === '' ? null : value),
  z.coerce.number().refine(isCategoryVatRate, {
    message: `Povolene sadzby DPH kategorie: ${CATEGORY_VAT_RATES.map((rate) => `${rate}%`).join(', ')}`,
  }).nullable(),
).optional();

export const createCategorySchema = z.object({
  slug: z.string().min(1).max(50),
  label: z.string().min(1).max(100),
  icon: z.string().min(1).max(10),
  sortKey: z.string().min(1).max(5),
  dest: z.string().max(20).default('bar'),
  defaultVatRate: categoryDefaultVatRateSchema,
});

export const updateCategorySchema = z.object({
  slug: z.string().min(1).max(50).optional(),
  label: z.string().min(1).max(100).optional(),
  icon: z.string().min(1).max(10).optional(),
  sortKey: z.string().min(1).max(5).optional(),
  dest: z.string().max(20).optional(),
  defaultVatRate: categoryDefaultVatRateSchema,
});

// Companion link: null unsets it, positive int references another menu item.
const companionSchema = z.union([
  z.null(),
  z.coerce.number().int().positive(),
]).optional();

// Per-item dest override: null (alebo prazdny string) = use category default,
// 'bar' / 'kuchyna' = override. Empty string sa normalizuje na null.
const destOverrideSchema = z.union([
  z.null(),
  z.literal(''),
  z.enum(['bar', 'kuchyna']),
]).optional().transform(v => (v === '' || v === undefined ? null : v));

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
  companionMenuItemId: companionSchema,
  destOverride: destOverrideSchema,
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
  companionMenuItemId: companionSchema,
  destOverride: destOverrideSchema,
});

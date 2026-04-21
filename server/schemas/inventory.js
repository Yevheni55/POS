import { z } from 'zod';

export const createIngredientSchema = z.object({
  name: z.string().min(1).max(100),
  unit: z.enum(['ks', 'kg', 'g', 'l', 'ml']),
  type: z.enum(['ingredient', 'supply']).default('ingredient'),
  currentQty: z.coerce.number().min(0).default(0),
  minQty: z.coerce.number().min(0).default(0),
  costPerUnit: z.coerce.number().min(0).default(0),
});

export const updateIngredientSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  unit: z.enum(['ks', 'kg', 'g', 'l', 'ml']).optional(),
  /** Manuálna oprava stavu na sklade — zapíše sa ako stock movement typu `adjustment` s rozdielom. */
  currentQty: z.coerce.number().min(0).optional(),
  minQty: z.coerce.number().min(0).optional(),
  costPerUnit: z.coerce.number().min(0).optional(),
  active: z.boolean().optional(),
});

export const setRecipeSchema = z.object({
  lines: z.array(z.object({
    ingredientId: z.coerce.number().int().positive(),
    qtyPerUnit: z.coerce.number().positive(),
  })).min(1),
});

export const stockAdjustSchema = z.object({
  ingredientId: z.coerce.number().int().positive().optional(),
  menuItemId: z.coerce.number().int().positive().optional(),
  quantity: z.coerce.number(),
  type: z.enum(['adjustment', 'waste']),
  note: z.string().max(200).default(''),
}).refine(d => d.ingredientId || d.menuItemId, { message: 'ingredientId or menuItemId required' });

export const stockConfigSchema = z.object({
  trackMode: z.enum(['none', 'simple', 'recipe']),
  stockQty: z.coerce.number().min(0).optional(),
  minStockQty: z.coerce.number().min(0).optional(),
});

export const createSupplierSchema = z.object({
  name: z.string().min(1).max(100),
  contactPerson: z.string().max(100).default(''),
  phone: z.string().max(30).default(''),
  email: z.string().max(100).default(''),
  notes: z.string().max(500).default(''),
});

export const updateSupplierSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  contactPerson: z.string().max(100).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().max(100).optional(),
  notes: z.string().max(500).optional(),
  active: z.boolean().optional(),
});

export const createPurchaseOrderSchema = z.object({
  supplierId: z.coerce.number().int().positive(),
  note: z.string().max(500).default(''),
  imageData: z.string().optional(),
  items: z.array(z.object({
    ingredientId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().positive(),
    invoiceUnit: z.string().max(20).default(''),
    conversionFactor: z.coerce.number().positive().default(1),
    unitCost: z.coerce.number().min(0),
  })).min(1),
});

export const updatePurchaseOrderSchema = z.object({
  note: z.string().max(500).optional(),
  items: z.array(z.object({
    ingredientId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().positive(),
    invoiceUnit: z.string().max(20).default(''),
    conversionFactor: z.coerce.number().positive().default(1),
    unitCost: z.coerce.number().min(0),
  })).min(1).optional(),
});

export const createAuditSchema = z.object({
  note: z.string().max(500).default(''),
  ingredientIds: z.array(z.coerce.number().int().positive()).optional(),
});

export const updateAuditItemSchema = z.object({
  actualQty: z.coerce.number().min(0),
});

// Write-offs
export const createWriteOffSchema = z.object({
  reason: z.enum(['expiration', 'damage', 'theft', 'other']),
  note: z.string().max(500).default(''),
  items: z.array(z.object({
    ingredientId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().positive(),
  })).min(1),
});

// Assets
export const createAssetSchema = z.object({
  name: z.string().min(1).max(100),
  category: z.enum(['kitchen_equipment', 'furniture', 'electronics', 'other']).default('other'),
  purchasePrice: z.coerce.number().positive(),
  purchaseDate: z.string().min(1),
  usefulLifeMonths: z.coerce.number().int().min(1),
  residualValue: z.coerce.number().min(0).default(0),
  note: z.string().max(500).default(''),
});

export const updateAssetSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  category: z.enum(['kitchen_equipment', 'furniture', 'electronics', 'other']).optional(),
  note: z.string().max(500).optional(),
  active: z.boolean().optional(),
});

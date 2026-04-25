import { Router } from 'express';
import { eq, asc } from 'drizzle-orm';

import { db } from '../db/index.js';
import { menuCategories, menuItems } from '../db/schema.js';
import { formatSupportedVatRates, inferVatRateForMenuItem, isSupportedVatRate } from '../lib/menu-vat.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import {
  createCategorySchema,
  updateCategorySchema,
  createMenuItemSchema,
  updateMenuItemSchema,
} from '../schemas/menu.js';

const router = Router();

const menuItemSelect = {
  id: menuItems.id,
  categoryId: menuItems.categoryId,
  name: menuItems.name,
  emoji: menuItems.emoji,
  price: menuItems.price,
  desc: menuItems.desc,
  active: menuItems.active,
  trackMode: menuItems.trackMode,
  stockQty: menuItems.stockQty,
  minStockQty: menuItems.minStockQty,
  vatRate: menuItems.vatRate,
  companionMenuItemId: menuItems.companionMenuItemId,
};

function normalizeMenuItem(item) {
  const vatRate = parseFloat(item.vatRate ?? 0);
  return {
    ...item,
    price: parseFloat(item.price),
    stockQty: parseFloat(item.stockQty ?? 0),
    minStockQty: parseFloat(item.minStockQty ?? 0),
    vatRate: Number.isFinite(vatRate) ? vatRate : 0,
    active: !!item.active,
    available: !!item.active,
    companionMenuItemId: item.companionMenuItemId ?? null,
  };
}

async function getMenuItemById(id) {
  const [item] = await db.select(menuItemSelect).from(menuItems).where(eq(menuItems.id, id)).limit(1);
  return item ? normalizeMenuItem(item) : null;
}

async function getMenuCategoryById(id) {
  const [category] = await db.select().from(menuCategories).where(eq(menuCategories.id, id)).limit(1);
  return category || null;
}

// GET /api/menu - full menu with categories and items
router.get('/', async (req, res) => {
  const cats = await db.select().from(menuCategories).orderBy(asc(menuCategories.sortKey));
  const items = await db.select(menuItemSelect).from(menuItems).where(eq(menuItems.active, true));

  const menu = cats.map(cat => ({
    ...cat,
    items: items.filter(i => i.categoryId === cat.id).map(normalizeMenuItem),
  }));

  res.json(menu);
});

// POST /api/menu/categories (manazer/admin only)
router.post('/categories', requireRole('manazer', 'admin'), validate(createCategorySchema), async (req, res) => {
  const result = await db.insert(menuCategories).values(req.body).returning();
  res.status(201).json(result[0]);
});

// PUT /api/menu/categories/:id (manazer/admin only)
router.put('/categories/:id', requireRole('manazer', 'admin'), validate(updateCategorySchema), async (req, res) => {
  const result = await db.update(menuCategories).set(req.body).where(eq(menuCategories.id, +req.params.id)).returning();
  res.json(result[0]);
});

// DELETE /api/menu/categories/:id (manazer/admin only)
router.delete('/categories/:id', requireRole('manazer', 'admin'), async (req, res) => {
  const id = +req.params.id;
  const existing = await db.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.categoryId, id));
  if (existing.length) {
    return res.status(409).json({
      error: 'Kategoria obsahuje produkty',
      itemCount: existing.length,
      hint: 'Najprv produkty zmaz alebo presun do inej kategorie.',
    });
  }
  await db.delete(menuCategories).where(eq(menuCategories.id, id));
  res.json({ ok: true });
});

// POST /api/menu/items (manazer/admin only)
router.post('/items', requireRole('manazer', 'admin'), validate(createMenuItemSchema), async (req, res) => {
  const { vatRate, available, active, ...values } = req.body;
  values.active = active ?? available ?? true;
  const category = await getMenuCategoryById(values.categoryId);
  if (!category) return res.status(404).json({ error: 'Kategoria neexistuje' });

  const resolvedVatRate = vatRate ?? inferVatRateForMenuItem({ categorySlug: category.slug, name: values.name });
  if (!isSupportedVatRate(resolvedVatRate)) {
    return res.status(400).json({ error: `Portos podporuje iba sadzby DPH ${formatSupportedVatRates()}` });
  }

  const [created] = await db.insert(menuItems).values({
    ...values,
    vatRate: String(resolvedVatRate),
  }).returning({ id: menuItems.id });

  const item = await getMenuItemById(created.id);
  res.status(201).json(item);
});

// PUT /api/menu/items/:id (manazer/admin only)
router.put('/items/:id', requireRole('manazer', 'admin'), validate(updateMenuItemSchema), async (req, res) => {
  const id = +req.params.id;
  const { vatRate, available, active, ...values } = req.body;
  const resolvedActive = active ?? available;

  if (resolvedActive !== undefined) {
    values.active = resolvedActive;
  }
  if (vatRate !== undefined) {
    values.vatRate = String(vatRate);
  }

  if (Object.keys(values).length) {
    await db.update(menuItems).set(values).where(eq(menuItems.id, id));
  }

  const item = await getMenuItemById(id);
  res.json(item);
});

// DELETE /api/menu/items/:id (manazer/admin only)
router.delete('/items/:id', requireRole('manazer', 'admin'), async (req, res) => {
  await db.update(menuItems).set({ active: false }).where(eq(menuItems.id, +req.params.id));
  res.json({ ok: true });
});

export default router;

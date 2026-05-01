import { Router } from 'express';
import { eq, asc, sql } from 'drizzle-orm';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { db } from '../db/index.js';
import { menuCategories, menuItems, orderItems, orders } from '../db/schema.js';
import { formatSupportedVatRates, inferVatRateForMenuItem, isSupportedVatRate } from '../lib/menu-vat.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import {
  createCategorySchema,
  updateCategorySchema,
  createMenuItemSchema,
  updateMenuItemSchema,
} from '../schemas/menu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root → /uploads is statically served at /uploads/ (mounted in app.js).
const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'uploads', 'menu');

const ALLOWED_IMAGE_MIMES = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB after base64 decode

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
  imageUrl: menuItems.imageUrl,
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
    imageUrl: item.imageUrl || null,
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

// GET /api/menu/top — top-selling items across ALL TIME, used by the
// "Najcastejsie" pseudo-category in the cashier UI for one-tap access.
// Was previously limited to last 14 days, but a quiet bar can have weeks
// without enough orders to populate this — easier to just show all-time
// favourites and let the bartenders trust the tab. Refreshed on the
// client once per 24h, cached in localStorage so a reload never shows it
// empty.
// Empty fallback (fresh install / no orders yet): first 12 active items by id.
router.get('/top', async (req, res) => {
  const rows = await db.select({
    ...menuItemSelect,
    totalQty: sql`SUM(${orderItems.qty})::int`,
  })
  .from(orderItems)
  .innerJoin(orders, eq(orderItems.orderId, orders.id))
  .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
  .where(eq(menuItems.active, true))
  .groupBy(menuItems.id)
  .orderBy(sql`SUM(${orderItems.qty}) DESC`)
  .limit(12);

  if (rows.length) {
    return res.json(rows.map(r => ({ ...normalizeMenuItem(r), totalQty: Number(r.totalQty) || 0 })));
  }

  // Fallback for fresh systems without order history yet.
  const fallback = await db.select(menuItemSelect)
    .from(menuItems)
    .where(eq(menuItems.active, true))
    .orderBy(asc(menuItems.id))
    .limit(12);
  res.json(fallback.map(item => ({ ...normalizeMenuItem(item), totalQty: 0 })));
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

// POST /api/menu/items/:id/image
// body: { image: "data:image/jpeg;base64,..." }
// Decodes the data URL, writes to /uploads/menu/<id>.<ext>, updates DB.
router.post('/items/:id/image', requireRole('manazer', 'admin'), async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const dataUrl = req.body && req.body.image;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return res.status(400).json({ error: 'Pole "image" musi byt data URL (data:image/...;base64,...)' });
  }
  const m = /^data:([a-zA-Z0-9.+-/]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Neplatny data URL format' });
  const mime = m[1].toLowerCase();
  const ext = ALLOWED_IMAGE_MIMES[mime];
  if (!ext) return res.status(400).json({ error: 'Podporovane: JPEG, PNG, WebP' });
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); }
  catch { return res.status(400).json({ error: 'Neplatne base64 data' }); }
  if (buf.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: 'Obrazok je prilis velky (max 4 MB)' });
  }

  const item = await getMenuItemById(id);
  if (!item) return res.status(404).json({ error: 'Polozka nenajdena' });

  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  // Delete previous file if extension changed (avoid orphan).
  if (item.imageUrl) {
    const prevName = path.basename(item.imageUrl);
    const prevPath = path.join(UPLOADS_DIR, prevName);
    try { await fs.unlink(prevPath); } catch { /* ignore */ }
  }

  const filename = `${id}.${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);
  await fs.writeFile(filepath, buf);

  // Cache-bust the URL by appending a timestamp so the browser doesn't show
  // the previous image after re-upload.
  const url = `/uploads/menu/${filename}?v=${Date.now()}`;
  await db.update(menuItems).set({ imageUrl: url }).where(eq(menuItems.id, id));

  const updated = await getMenuItemById(id);
  res.json(updated);
});

// DELETE /api/menu/items/:id/image — clear photo
router.delete('/items/:id/image', requireRole('manazer', 'admin'), async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const item = await getMenuItemById(id);
  if (!item) return res.status(404).json({ error: 'Polozka nenajdena' });
  if (item.imageUrl) {
    const prevName = path.basename(item.imageUrl);
    const prevPath = path.join(UPLOADS_DIR, prevName);
    try { await fs.unlink(prevPath); } catch { /* ignore */ }
  }
  await db.update(menuItems).set({ imageUrl: null }).where(eq(menuItems.id, id));
  res.json({ ok: true });
});

export default router;

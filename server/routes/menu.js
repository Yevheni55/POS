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
  // Per-item destination override pre kuchyňa vs bar tlač.
  // NULL = inherit from category.dest. 'bar' alebo 'kuchyna' = explicit.
  destOverride: menuItems.destOverride,
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
    destOverride: item.destOverride || null,
  };
}

// menu_categories.default_vat_rate je numeric → drizzle ho vracia ako string.
// Admin UI (aj Android) z neho predvyplna select DPH, preto ho vraciame ako cislo.
// null = manazer sadzbu este nezvolil — UI ju MUSI vypytat, nikdy tiche 23 %.
function normalizeCategory(category) {
  if (!category) return category;
  const defaultVatRate = Number.parseFloat(category.defaultVatRate);
  return {
    ...category,
    defaultVatRate: Number.isFinite(defaultVatRate) ? defaultVatRate : null,
  };
}

// Numeric stlpec drzime pri zapise ako string (rovnaky pattern ako menuItems.vatRate).
function categoryWriteValues(body) {
  const values = { ...body };
  if (values.defaultVatRate !== undefined) {
    values.defaultVatRate = values.defaultVatRate === null ? null : String(values.defaultVatRate);
  }
  return values;
}

async function getMenuItemById(id) {
  const [item] = await db.select(menuItemSelect).from(menuItems).where(eq(menuItems.id, id)).limit(1);
  return item ? normalizeMenuItem(item) : null;
}

async function getMenuCategoryById(id) {
  const [category] = await db.select().from(menuCategories).where(eq(menuCategories.id, id)).limit(1);
  return category ? normalizeCategory(category) : null;
}

// Kategoria bez explicitnej sadzby a so slugom mimo hardcoded mapy (typicky
// `cat_<timestamp>` z admin UI) — hlaska musi povedat PRAVDU, nie zavadzat
// zoznamom podporovanych sadzieb.
function respondCategoryVatRateMissing(res, category) {
  return res.status(400).json({
    error: `Kategoria "${category.label}" nema definovanu DPH sadzbu. Nastav ju v uprave kategorie alebo posli vatRate spolu s polozkou.`,
    code: 'CATEGORY_VAT_RATE_MISSING',
    categoryId: category.id,
  });
}

// GET /api/menu - full menu with categories and items
router.get('/', async (req, res) => {
  // Parallel SELECT (predtym sekvencne 2 round-trips)
  const [cats, items] = await Promise.all([
    db.select().from(menuCategories).orderBy(asc(menuCategories.sortKey)),
    db.select(menuItemSelect).from(menuItems).where(eq(menuItems.active, true)),
  ]);

  const menu = cats.map(cat => ({
    ...normalizeCategory(cat),
    items: items.filter(i => i.categoryId === cat.id).map(normalizeMenuItem),
  }));

  // ETag + revalidate. Express auto-genuje ETag pre res.json() (weak hash z body).
  // Cache-Control: 'private, max-age=0, must-revalidate' = browser smie cache-ovať
  // ale MUSÍ revalidovať pred použitím (If-None-Match → server 304 ak rovnaké).
  // Tým ušetríme JSON serialize + sieťový download pri F5 (typicky 5-15ms).
  // Sklad/admin menu edit invaliduje cache automaticky (iný body → iný ETag).
  res.set('Cache-Control', 'private, max-age=0, must-revalidate');
  res.json(menu);
});

// GET /api/menu/top — items ranked by all-time sales, descending.
// Used for two things in the cashier UI:
//   1. The "Najcastejsie" pseudo-category takes the first ~12 entries.
//   2. Inside every category, items are sorted by their rank in this
//      list so the most-ordered burger / drink / dessert lands at the
//      top of the grid and the cashier doesn't scroll for it.
// Returns up to 500 rows so even a 200-item menu can be fully ranked
// from a single request. Refreshed on the client once per 24h.
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
  .limit(500);

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
  const result = await db.insert(menuCategories).values(categoryWriteValues(req.body)).returning();
  res.status(201).json(normalizeCategory(result[0]));
});

// PUT /api/menu/categories/:id (manazer/admin only)
router.put('/categories/:id', requireRole('manazer', 'admin'), validate(updateCategorySchema), async (req, res) => {
  const result = await db.update(menuCategories).set(categoryWriteValues(req.body)).where(eq(menuCategories.id, +req.params.id)).returning();
  res.json(normalizeCategory(result[0]));
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

  // Explicitna sadzba kategorie ma prednost pred hadanim podla slugu — slug
  // `cat_<timestamp>` z admin UI inferencia nikdy nepokryje.
  const resolvedVatRate = vatRate ?? inferVatRateForMenuItem({
    categorySlug: category.slug,
    name: values.name,
    categoryDefaultVatRate: category.defaultVatRate,
  });
  if (resolvedVatRate === null || resolvedVatRate === undefined) {
    return respondCategoryVatRateMissing(res, category);
  }
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
    // Re-check aj ked schema uz sadzbu overila — POST ho ma, PUT ho doteraz nemal.
    if (!isSupportedVatRate(vatRate)) {
      return res.status(400).json({ error: `Portos podporuje iba sadzby DPH ${formatSupportedVatRates()}` });
    }
    values.vatRate = String(vatRate);
  }

  // Presun polozky do inej kategorie doteraz sadzbu ani neprepocital, ani neskontroloval
  // (napr. Cheesecake 5 % presunuty do Koktailov ostal na 5 %). Ked klient sadzbu
  // neposle, prepocitame ju; ked posle inu, povolime ju (legitimne overridy ako
  // nealko pivo), ale nesulad vratime v odpovedi, nech UI vie varovat.
  let vatRateMismatch = null;
  if (values.categoryId !== undefined) {
    const existing = await getMenuItemById(id);
    if (!existing) return res.status(404).json({ error: 'Polozka nenajdena' });

    const category = await getMenuCategoryById(values.categoryId);
    if (!category) return res.status(404).json({ error: 'Kategoria neexistuje' });

    const inferredVatRate = inferVatRateForMenuItem({
      categorySlug: category.slug,
      name: values.name ?? existing.name,
      categoryDefaultVatRate: category.defaultVatRate,
    });

    if (vatRate === undefined) {
      // Sadzbu prepisujeme IBA pri skutocnej zmene kategorie — inak by sme
      // vedomy per-item override zmazali pri kazdom ulozeni formulara.
      if (category.id !== existing.categoryId) {
        if (inferredVatRate === null) return respondCategoryVatRateMissing(res, category);
        values.vatRate = String(inferredVatRate);
      }
    } else if (inferredVatRate !== null && Math.round(Number(vatRate) * 100) / 100 !== inferredVatRate) {
      vatRateMismatch = {
        expected: inferredVatRate,
        actual: Math.round(Number(vatRate) * 100) / 100,
        categoryId: category.id,
        categoryLabel: category.label,
      };
    }
  }

  if (Object.keys(values).length) {
    await db.update(menuItems).set(values).where(eq(menuItems.id, id));
  }

  const item = await getMenuItemById(id);
  if (vatRateMismatch) return res.json({ ...item, vatRateMismatch });
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

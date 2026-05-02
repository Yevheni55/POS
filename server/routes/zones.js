import { Router } from 'express';
import { db } from '../db/index.js';
import { zones, tables } from '../db/schema.js';
import { eq, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { emitEvent } from '../lib/emit.js';

const router = Router();

// Default labels for the legacy hardcoded zones — used only on first
// auto-seed when the zones table is empty. Anything not in this map
// falls back to a Title-Cased slug so the cashier still sees something
// reasonable for a custom zone someone added before this feature shipped.
const DEFAULT_LABELS = {
  interior: 'Interier',
  bar: 'Bar',
  terasa: 'Terasa',
};
const DEFAULT_ORDER = { interior: 10, bar: 20, terasa: 30 };

function titleCase(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function ensureZonesSeeded() {
  const existing = await db.select({ slug: zones.slug }).from(zones);
  if (existing.length) return;
  // Pull every distinct zone slug currently used by a table — covers both
  // the default trio and any custom zone added before this table existed.
  const distinct = await db.execute(sql`
    SELECT DISTINCT zone AS slug FROM tables WHERE zone IS NOT NULL AND zone <> ''
  `);
  const slugs = distinct.rows.map((r) => String(r.slug));
  // If even tables is empty, seed the standard trio so the admin UI has
  // something to show right away.
  const seedSlugs = slugs.length ? slugs : ['interior', 'bar', 'terasa'];
  const rows = seedSlugs.map((slug, i) => ({
    slug,
    label: DEFAULT_LABELS[slug] || titleCase(slug),
    sortOrder: DEFAULT_ORDER[slug] != null ? DEFAULT_ORDER[slug] : 100 + i,
  }));
  await db.insert(zones).values(rows).onConflictDoNothing();
}

// GET /api/zones — every cashier and the admin tables page calls this on
// boot to render zone tabs. Auto-seeds on first call so a fresh deploy
// doesn't hit an empty list.
router.get('/', async (req, res) => {
  await ensureZonesSeeded();
  const rows = await db.select().from(zones).orderBy(asc(zones.sortOrder), asc(zones.slug));
  res.json(rows);
});

// PATCH /api/zones/:slug — rename a zone. Only the label changes; the
// slug is permanent because it's denormalized onto every table row and
// renaming it would require a multi-table migration.
const labelSchema = z.object({ label: z.string().trim().min(1).max(50) });
router.patch('/:slug', requireRole('manazer', 'admin'), validate(labelSchema), async (req, res) => {
  const slug = String(req.params.slug);
  const result = await db.update(zones).set({ label: req.body.label }).where(eq(zones.slug, slug)).returning();
  if (!result.length) return res.status(404).json({ error: 'Zóna neexistuje' });
  emitEvent(req, 'zone:updated', { slug, label: result[0].label });
  res.json(result[0]);
});

export default router;

import { Router } from 'express';
import { sql, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { shishaSales, staff } from '../db/schema.js';
import { requireRole } from '../middleware/requireRole.js';
import { asyncRoute } from '../lib/async-route.js';

const router = Router();

const DEFAULT_PRICE = 17;

// GET /api/shisha/summary — counters + recent sales
router.get('/summary', asyncRoute(async (req, res) => {
  // SUMs/counts in three buckets: today, this month, all-time
  const rows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE sold_at::date = CURRENT_DATE)                          AS today_count,
      COALESCE(SUM(price) FILTER (WHERE sold_at::date = CURRENT_DATE), 0)           AS today_revenue,
      COUNT(*) FILTER (WHERE date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)) AS month_count,
      COALESCE(SUM(price) FILTER (WHERE date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)), 0) AS month_revenue,
      COUNT(*)                                                                       AS total_count,
      COALESCE(SUM(price), 0)                                                        AS total_revenue
    FROM shisha_sales
  `);
  const r = rows.rows ? rows.rows[0] : rows[0];

  // Per-day breakdown over the last 60 days
  const byDayRows = await db.execute(sql`
    SELECT
      to_char(sold_at AT TIME ZONE 'Europe/Bratislava', 'YYYY-MM-DD') AS day,
      COUNT(*)            AS count,
      COALESCE(SUM(price), 0) AS revenue
    FROM shisha_sales
    WHERE sold_at >= CURRENT_DATE - INTERVAL '60 days'
    GROUP BY day
    ORDER BY day DESC
  `);
  const byDay = (byDayRows.rows || byDayRows).map((d) => ({
    day: d.day,
    count: Number(d.count),
    revenue: Number(d.revenue),
  }));

  // Last 20 sales with staff names
  const recent = await db
    .select({
      id: shishaSales.id,
      soldAt: shishaSales.soldAt,
      price: shishaSales.price,
      staffId: shishaSales.staffId,
      staffName: staff.name,
    })
    .from(shishaSales)
    .leftJoin(staff, eq(shishaSales.staffId, staff.id))
    .orderBy(desc(shishaSales.soldAt))
    .limit(20);

  res.json({
    summary: {
      today: { count: Number(r.today_count), revenue: Number(r.today_revenue) },
      month: { count: Number(r.month_count), revenue: Number(r.month_revenue) },
      total: { count: Number(r.total_count), revenue: Number(r.total_revenue) },
    },
    byDay,
    recent: recent.map((s) => ({
      id: s.id,
      soldAt: s.soldAt,
      price: Number(s.price),
      staffId: s.staffId,
      staffName: s.staffName || '',
    })),
  });
}));

// POST /api/shisha — record one sale (price defaults to 17 €)
router.post('/', asyncRoute(async (req, res) => {
  const price = req.body && Number(req.body.price);
  const usePrice = Number.isFinite(price) && price > 0 ? price : DEFAULT_PRICE;
  const [row] = await db
    .insert(shishaSales)
    .values({ staffId: req.user.id, price: String(usePrice) })
    .returning();
  res.status(201).json({
    id: row.id,
    soldAt: row.soldAt,
    price: Number(row.price),
    staffId: row.staffId,
  });
}));

// DELETE /api/shisha/:id — undo last entry (manazer/admin only)
router.delete('/:id', requireRole('manazer', 'admin'), asyncRoute(async (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  await db.delete(shishaSales).where(eq(shishaSales.id, id));
  res.json({ ok: true });
}));

export default router;

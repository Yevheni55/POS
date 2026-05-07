import { Router } from 'express';
import { db } from '../db/index.js';
import { orders, orderItems, payments, menuItems, menuCategories, staff, shishaSales } from '../db/schema.js';
import { eq, sql, gte, lte, and, desc } from 'drizzle-orm';
import { allocateDiscountAcrossVatGroups } from '../lib/fiscal-payment.js';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// GET /api/reports/summary?from=2024-01-01&to=2024-12-31
// Default: single calendar day (today, Bratislava) so "dashboard today" is
// not merged with yesterday. All date/hour aggregates and boundary
// comparisons use Europe/Bratislava — payments.created_at is stored UTC,
// but the cashier reads the dashboard in local time. Without the TZ shift
// hour bins were UTC (pas-time displays 16:00 instead of 18:00 in summer).
const TZ = 'Europe/Bratislava';

router.get('/summary', mgr, async (req, res) => {
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const from = req.query.from || to;

  // SQL-side boundaries: the user types YYYY-MM-DD in local time, so 'from'
  // means "00:00 Bratislava on that day" and 'to' means "23:59:59
  // Bratislava on that day". Postgres handles DST correctly via AT TIME
  // ZONE, so this works across summer/winter switches.
  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${to + ' 23:59:59'})::timestamp AT TIME ZONE ${TZ}`;

  // Total revenue
  const [revenue] = await db.select({
    total: sql`COALESCE(SUM(${payments.amount}::numeric), 0)`,
    count: sql`COUNT(*)`,
  }).from(payments).where(
    sql`${payments.createdAt} >= ${fromBoundary} AND ${payments.createdAt} <= ${toBoundary}`
  );

  // Orders count
  const [orderStats] = await db.select({
    total: sql`COUNT(*)`,
    open: sql`COUNT(*) FILTER (WHERE ${orders.status} = 'open')`,
    closed: sql`COUNT(*) FILTER (WHERE ${orders.status} = 'closed')`,
  }).from(orders).where(
    sql`${orders.createdAt} >= ${fromBoundary} AND ${orders.createdAt} <= ${toBoundary}`
  );

  // Payment methods
  const methodStats = await db.select({
    method: payments.method,
    total: sql`SUM(${payments.amount}::numeric)`,
    count: sql`COUNT(*)`,
  }).from(payments).where(
    sql`${payments.createdAt} >= ${fromBoundary} AND ${payments.createdAt} <= ${toBoundary}`
  ).groupBy(payments.method);

  // All items sold in the period — used by the Reports/Produkty tab which
  // wants the full list, NOT a top-10 cap. The dashboard widget that
  // shows "top products today" is responsible for slicing on its end.
  // Joins menu_categories so each row carries a category label for the UI.
  const topItems = await db.select({
    name: menuItems.name,
    emoji: menuItems.emoji,
    category: menuCategories.label,
    qty: sql`SUM(${orderItems.qty})`,
    revenue: sql`SUM(${orderItems.qty} * ${menuItems.price}::numeric)`,
  })
  .from(orderItems)
  .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
  .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
  .innerJoin(orders, eq(orderItems.orderId, orders.id))
  .where(sql`${orders.createdAt} >= ${fromBoundary} AND ${orders.createdAt} <= ${toBoundary} AND ${orders.status} != 'cancelled'`)
  .groupBy(menuItems.name, menuItems.emoji, menuCategories.label)
  .orderBy(desc(sql`SUM(${orderItems.qty})`));

  // Shisha — internal off-fiscal counter; rolled into the total so the dashboard
  // and weekly chart show real-world business revenue including shisha.
  const [shisha] = await db.select({
    count: sql`COUNT(*)`,
    revenue: sql`COALESCE(SUM(${shishaSales.price}::numeric), 0)`,
  }).from(shishaSales).where(
    sql`${shishaSales.soldAt} >= ${fromBoundary} AND ${shishaSales.soldAt} <= ${toBoundary}`
  );
  const shishaCount = parseInt(shisha.count) || 0;
  const shishaRevenue = parseFloat(shisha.revenue) || 0;
  const fiscalTotal = parseFloat(revenue.total) || 0;

  // Per-day breakdown for the Trzby tab (chronological). Bins payments by
  // their LOCAL Bratislava date so a 01:30-local payment lands in the same
  // day the bartender thinks of, not the next UTC day.
  // Postgres planner sees each Drizzle `${TZ}` interpolation as a separate
  // parameter placeholder ($1 vs $5 etc). When GROUP BY and ORDER BY both
  // include `... AT TIME ZONE ${TZ} ...`, the parser treats them as
  // structurally different expressions and refuses with "column
  // p.created_at must appear in the GROUP BY clause". Workaround: ORDER BY
  // uses positional column reference (1) which always matches the SELECT.
  const dailyRows = await db.execute(sql`
    SELECT
      to_char((p.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      COUNT(DISTINCT p.order_id)::int AS orders,
      COALESCE(SUM(p.amount::numeric), 0)::float AS revenue
    FROM payments p
    WHERE p.created_at >= ${fromBoundary} AND p.created_at <= ${toBoundary}
    GROUP BY 1
    ORDER BY 1
  `);

  // Per-day náklady na výrobu (COGS) — sums (qty × recipe.qty_per_unit ×
  // ingredient.cost_per_unit) over each item that has a recipe. Items
  // without a recipe contribute 0 (per operator decision: combos and
  // un-tracked items are treated as zero-cost in the dashboard until a
  // recipe is added). Bucketed by order's LOCAL Bratislava date so a
  // 01:30-local order lands on the bartender's day, not next UTC day.
  const cogsRows = await db.execute(sql`
    SELECT
      to_char((o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(oi.qty * r.qty_per_unit::numeric * i.cost_per_unit::numeric), 0)::float AS cogs
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN recipes r ON r.menu_item_id = oi.menu_item_id
    INNER JOIN ingredients i ON i.id = r.ingredient_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
    GROUP BY 1
    ORDER BY 1
  `);

  // Per-menu-item COGS — used by the Produkty tab to show "Výroba" per
  // riadok (cumulative cost over the picked period). Same recipe joins as
  // the per-day cogsRows query, but grouped by menu_item instead of date.
  // Items without a recipe don't appear here at all (they're treated as
  // 0-cost in the frontend join).
  const cogsByMenuRows = await db.execute(sql`
    SELECT
      mi.name AS name,
      COALESCE(SUM(oi.qty * r.qty_per_unit::numeric * i.cost_per_unit::numeric), 0)::float AS cogs
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN recipes r ON r.menu_item_id = oi.menu_item_id
    INNER JOIN ingredients i ON i.id = r.ingredient_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
    GROUP BY mi.name
  `);

  // Per-day náklady na mzdy — pairs each clock_in with the immediately
  // next event (which should be the matching clock_out) and computes
  // hours × hourly_rate. Bucketed by clock_in's LOCAL Bratislava date so
  // a shift that starts before midnight lands on the date the cashier
  // walked in (not the date they clocked out). Open shifts (no matching
  // clock_out) and admin staff with NULL hourly_rate contribute 0.
  const laborRows = await db.execute(sql`
    WITH paired AS (
      SELECT
        ae.staff_id,
        ae.type,
        ae.at,
        LEAD(ae.at)   OVER (PARTITION BY ae.staff_id ORDER BY ae.at) AS next_at,
        LEAD(ae.type) OVER (PARTITION BY ae.staff_id ORDER BY ae.at) AS next_type
      FROM attendance_events ae
    )
    SELECT
      to_char((paired.at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(EXTRACT(EPOCH FROM (paired.next_at - paired.at)) / 3600.0
        * COALESCE(s.hourly_rate, 0)::numeric), 0)::float AS labor
    FROM paired
    INNER JOIN staff s ON s.id = paired.staff_id
    WHERE paired.type = 'clock_in'
      AND paired.next_type = 'clock_out'
      AND paired.at >= ${fromBoundary}
      AND paired.at <= ${toBoundary}
    GROUP BY 1
    ORDER BY 1
  `);

  // Per-hour-of-day breakdown for the Hodiny tab. Hours are LOCAL Bratislava
  // hours so 18:00 means 18:00 in the bar, not 16:00 UTC.
  const hourlyRows = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM (p.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS hour,
      COUNT(DISTINCT p.order_id)::int AS orders,
      COALESCE(SUM(p.amount::numeric), 0)::float AS revenue
    FROM payments p
    WHERE p.created_at >= ${fromBoundary} AND p.created_at <= ${toBoundary}
    GROUP BY 1
    ORDER BY 1
  `);

  // Per-hour split by dest (bar vs kuchyna). Item-level so a single order
  // with both food and drinks lands in both buckets correctly. Uses the
  // order's created_at hour (when the cashier rang it up) — note this can
  // differ slightly from payment-time if a tab was paid much later, but
  // for the hourly view 'when was it sold' is what the owner expects.
  const hourlyDestRows = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS hour,
      c.dest AS dest,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS revenue
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories c ON c.id = mi.category_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
    GROUP BY 1, 2
  `);
  const hourlyDestMap = {};
  for (const r of hourlyDestRows.rows) {
    const h = Number(r.hour) || 0;
    if (!hourlyDestMap[h]) hourlyDestMap[h] = { bar: 0, kuchyna: 0 };
    const dest = String(r.dest || 'bar');
    if (dest === 'kuchyna') hourlyDestMap[h].kuchyna += Number(r.revenue) || 0;
    else hourlyDestMap[h].bar += Number(r.revenue) || 0;
  }

  // Per-staff breakdown for the Zamestnanci tab. Joins payments → orders →
  // staff so each cashier's revenue is attributable from their own sales.
  const staffRows = await db.execute(sql`
    SELECT
      s.name,
      COUNT(DISTINCT o.id)::int AS orders,
      COUNT(DISTINCT p.id)::int AS payments,
      COALESCE(SUM(p.amount::numeric), 0)::float AS revenue
    FROM payments p
    INNER JOIN orders o ON o.id = p.order_id
    INNER JOIN staff s ON s.id = o.staff_id
    WHERE p.created_at >= ${fromBoundary} AND p.created_at <= ${toBoundary}
    GROUP BY s.id, s.name
    ORDER BY revenue DESC
  `);

  // Revenue split by printer destination (bar vs kuchyna). Categories carry
  // a `dest` flag and items inherit it via category_id, so this tells the
  // owner what slice of trzby came out of the kitchen vs the bar. Excludes
  // cancelled orders and uses oi.qty * mi.price (gross, before discount —
  // matches how "Spolu" is computed in the Tržby table).
  const destRows = await db.execute(sql`
    SELECT
      c.dest AS dest,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS revenue,
      COALESCE(SUM(oi.qty), 0)::int AS items
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories c ON c.id = mi.category_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
    GROUP BY c.dest
  `);
  const destAcc = { bar: { revenue: 0, items: 0 }, kuchyna: { revenue: 0, items: 0 } };
  for (const r of destRows.rows) {
    const dest = String(r.dest || 'bar');
    if (!destAcc[dest]) destAcc[dest] = { revenue: 0, items: 0 };
    destAcc[dest].revenue += Number(r.revenue) || 0;
    destAcc[dest].items += Number(r.items) || 0;
  }

  // Index per-menu-item COGS by name (case-sensitive match) so the
  // Produkty tab can show Výroba per riadok in renderProdukty().
  const cogsByMenuName = {};
  for (const r of cogsByMenuRows.rows) cogsByMenuName[r.name] = Number(r.cogs) || 0;

  // Index per-day náklady (výroba + mzdy) by date so dailyArr can be
  // enriched in a single pass below. Days that had revenue but no
  // recipe-tracked items still appear with cogs=0 (the LEFT JOIN pattern
  // happens implicitly because we only set keys that have data).
  const cogsByDate = {};
  for (const r of cogsRows.rows) cogsByDate[r.date] = Number(r.cogs) || 0;
  const laborByDate = {};
  for (const r of laborRows.rows) laborByDate[r.date] = Number(r.labor) || 0;
  // A day might exist in cogs/labor but not in dailyArr (sales-less day
  // that still had a paid shift, or recipe write-off). Union all keys so
  // such days still surface with revenue=0.
  const dailyDateSet = new Set([
    ...dailyRows.rows.map(r => r.date),
    ...Object.keys(cogsByDate),
    ...Object.keys(laborByDate),
  ]);
  const revenueByDate = {};
  const ordersByDate = {};
  for (const r of dailyRows.rows) {
    revenueByDate[r.date] = Number(r.revenue) || 0;
    ordersByDate[r.date] = Number(r.orders) || 0;
  }
  const dailyArr = Array.from(dailyDateSet).sort().map((date) => {
    const orders = ordersByDate[date] || 0;
    const revenue = revenueByDate[date] || 0;
    const cogs = roundMoney(cogsByDate[date] || 0);
    const labor = roundMoney(laborByDate[date] || 0);
    return {
      date,
      orders,
      revenue,
      avgCheck: orders > 0 ? roundMoney(revenue / orders) : 0,
      peakHours: '',
      cogs,
      labor,
      profit: roundMoney(revenue - cogs - labor),
    };
  });
  // Union the hour buckets from both queries so an hour that had only
  // open-tab items (no payment yet) still shows up in the table — and an
  // hour that had a delayed payment from the previous hour still appears.
  const paymentHourMap = {};
  const hourSet = new Set();
  for (const r of hourlyRows.rows) {
    const h = Number(r.hour) || 0;
    hourSet.add(h);
    paymentHourMap[h] = { orders: Number(r.orders) || 0, revenue: Number(r.revenue) || 0 };
  }
  for (const k of Object.keys(hourlyDestMap)) hourSet.add(Number(k));
  const hourlyArr = Array.from(hourSet).sort((a, b) => a - b).map((h) => {
    const p = paymentHourMap[h] || { orders: 0, revenue: 0 };
    const d = hourlyDestMap[h] || { bar: 0, kuchyna: 0 };
    return {
      hour: String(h).padStart(2, '0') + ':00',
      orders: p.orders,
      revenue: p.revenue,
      barRevenue: roundMoney(d.bar),
      kuchynaRevenue: roundMoney(d.kuchyna),
    };
  });
  const staffArr = staffRows.rows.map((r) => {
    const orders = Number(r.orders) || 0;
    const revenue = Number(r.revenue) || 0;
    return {
      name: r.name,
      shifts: 0,
      orders,
      revenue,
      avgCheck: orders > 0 ? roundMoney(revenue / orders) : 0,
      rating: 0,
    };
  });

  const totalRevenue = fiscalTotal + shishaRevenue;
  const totalOrders = parseInt(orderStats.total) || 0;
  const avgCheck = totalOrders > 0 ? roundMoney(totalRevenue / totalOrders) : 0;
  const topRevenue = staffArr.length ? staffArr[0].revenue : 0;
  const topItemsArr = topItems.map(i => ({ ...i, qty: parseInt(i.qty), revenue: parseFloat(i.revenue) }));

  // Period totals — sum the per-day arrays so the dashboard "Spolu" row
  // and the new "Výsledok" stat card always agree with the table. Profit
  // uses fiscal+shisha totalRevenue (matching the existing 'Celkové tržby'
  // card) MINUS the COGS and labor sums; if the period boundary trims a
  // shift in the middle (clock_in inside, clock_out outside) that shift
  // contributes to whichever bucket its clock_in fell in.
  const totalCogs = roundMoney(dailyArr.reduce((s, d) => s + (d.cogs || 0), 0));
  const totalLabor = roundMoney(dailyArr.reduce((s, d) => s + (d.labor || 0), 0));
  const totalProfit = roundMoney(totalRevenue - totalCogs - totalLabor);

  res.json({
    period: { from, to },
    // Nested shape (modern callers).
    revenue: { total: totalRevenue, fiscal: fiscalTotal, payments: parseInt(revenue.count) },
    shisha: { count: shishaCount, revenue: shishaRevenue },
    orders: { total: totalOrders, open: parseInt(orderStats.open), closed: parseInt(orderStats.closed) },
    methods: methodStats.map(m => ({ method: m.method, total: parseFloat(m.total), count: parseInt(m.count) })),
    topItems: topItemsArr,
    // Flat aliases consumed by admin/pages/reports.js so the dashboard
    // KPI strip + 4 tabs render directly without a frontend rewrite.
    totalRevenue,
    totalOrders,
    avgCheck,
    topRevenue,
    totalCogs,
    totalLabor,
    totalProfit,
    daily: dailyArr,
    hourly: hourlyArr,
    staff: staffArr,
    revenueByDest: {
      bar: roundMoney(destAcc.bar.revenue),
      kuchyna: roundMoney(destAcc.kuchyna.revenue),
      itemsBar: destAcc.bar.items,
      itemsKuchyna: destAcc.kuchyna.items,
    },
    products: topItemsArr.map((it) => {
      const cogs = roundMoney(cogsByMenuName[it.name] || 0);
      return {
        name: it.name,
        emoji: it.emoji || '',
        category: it.category || '',
        qty: it.qty,
        revenue: it.revenue,
        cogs,
        profit: roundMoney(it.revenue - cogs),
      };
    }),
  });
});

// GET /api/reports/weekly?from=YYYY-MM-DD&to=YYYY-MM-DD
// Detailný týždenný breakdown — hodina × deň-v-týždni × destinácia
// (bar/kuchyna), plus cook-shifts pre per-hour výpočet kuchárskej
// efektivity. Slúži novej admin stránke "Týždeň".
//
// Pre cook efficiency potrebujeme: kto, koľko hodín, v akých hodinách
// bol v práci, koľko € sa za ten čas vytočilo v kuchyni. Pomer
// kitchen_revenue / cook_hours = €/hod efektivity. Pri viacerých
// kuchároch v rovnakej hodine sa kitchen revenue delí proporčne.
router.get('/weekly', mgr, async (req, res) => {
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const from = req.query.from || (() => {
    // Default = aktuálny pondelok-nedeľa rozsah
    const d = new Date();
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1; // Po=0, Ne=6
    d.setDate(d.getDate() - dow);
    return d.toISOString().split('T')[0];
  })();
  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${to + ' 23:59:59'})::timestamp AT TIME ZONE ${TZ}`;

  // Hour × weekday × dest aggregation. dest='kuchyna' alebo 'bar'.
  const cellsRows = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS hour,
      EXTRACT(ISODOW FROM (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS weekday,
      to_char((o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      c.dest AS dest,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS revenue,
      COUNT(DISTINCT o.id)::int AS orders,
      COALESCE(SUM(oi.qty), 0)::int AS items
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories c ON c.id = mi.category_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
    GROUP BY 1, 2, 3, 4
  `);

  // Cook shifts — všetky uzavreté smeny v období. Cook = staff.position
  // obsahuje 'kuchár' / 'kuchar' / 'cook' / 'chef' (case-insensitive).
  // Ak nikto taký, vrátime všetkých s hourly_rate>0 (server zaobchádza
  // ako so 'všetkým personálom' a UI to označí).
  const shiftsRows = await db.execute(sql`
    WITH paired AS (
      SELECT ae.staff_id, ae.type, ae.at,
        LEAD(ae.at)   OVER (PARTITION BY ae.staff_id ORDER BY ae.at) AS next_at,
        LEAD(ae.type) OVER (PARTITION BY ae.staff_id ORDER BY ae.at) AS next_type
      FROM attendance_events ae
    )
    SELECT
      paired.staff_id AS "staffId",
      s.name,
      s.position,
      COALESCE(s.hourly_rate, 0)::float AS "hourlyRate",
      paired.at AS "inAt",
      paired.next_at AS "outAt"
    FROM paired
    JOIN staff s ON s.id = paired.staff_id
    WHERE paired.type = 'clock_in'
      AND paired.next_type = 'clock_out'
      AND paired.at >= ${fromBoundary}
      AND paired.at <= ${toBoundary}
    ORDER BY paired.at
  `);

  // Cells: { date, hour, weekday, kitchenRevenue, barRevenue, orders, items }
  const cellMap = new Map(); // key = date|hour
  for (const r of cellsRows.rows){
    const key = r.date + '|' + r.hour;
    let cell = cellMap.get(key);
    if (!cell){
      cell = {
        date: r.date,
        hour: Number(r.hour),
        weekday: Number(r.weekday), // ISO 1=Po..7=Ne
        kitchenRevenue: 0,
        barRevenue: 0,
        kitchenItems: 0,
        barItems: 0,
        orders: 0,
      };
      cellMap.set(key, cell);
    }
    const dest = String(r.dest || 'bar');
    if (dest === 'kuchyna'){
      cell.kitchenRevenue += Number(r.revenue) || 0;
      cell.kitchenItems += Number(r.items) || 0;
    } else {
      cell.barRevenue += Number(r.revenue) || 0;
      cell.barItems += Number(r.items) || 0;
    }
    cell.orders += Number(r.orders) || 0;
  }

  // Per-hour-of-day aggregates (24 buckets across whole period)
  const byHour = Array.from({length:24}, (_, i) => ({
    hour: i,
    kitchenRevenue: 0, barRevenue: 0,
    kitchenItems: 0, barItems: 0,
    orders: 0,
    cookMinutes: 0,
    activeCooks: 0,
  }));

  // Per-weekday-hour heatmap (7 × 24 cells, ISO Po=1..Ne=7)
  const heatmapMap = new Map(); // key=weekday|hour
  for (const cell of cellMap.values()){
    const key = cell.weekday + '|' + cell.hour;
    let hm = heatmapMap.get(key);
    if (!hm){
      hm = { weekday: cell.weekday, hour: cell.hour, kitchenRevenue: 0, barRevenue: 0, orders: 0 };
      heatmapMap.set(key, hm);
    }
    hm.kitchenRevenue += cell.kitchenRevenue;
    hm.barRevenue += cell.barRevenue;
    hm.orders += cell.orders;
    byHour[cell.hour].kitchenRevenue += cell.kitchenRevenue;
    byHour[cell.hour].barRevenue += cell.barRevenue;
    byHour[cell.hour].kitchenItems += cell.kitchenItems;
    byHour[cell.hour].barItems += cell.barItems;
    byHour[cell.hour].orders += cell.orders;
  }

  // Cook detection — keyword match na position. Ak žiadny cook,
  // UI dostane všetok personál s flag 'noKitchenStaff'.
  const cookKeywords = /kuch|cook|chef/i;
  const allShifts = shiftsRows.rows.map(r => ({
    staffId: Number(r.staffId),
    name: r.name,
    position: r.position || '',
    hourlyRate: Number(r.hourlyRate) || 0,
    inAt: r.inAt,
    outAt: r.outAt,
    isCook: cookKeywords.test(r.position || ''),
  }));
  const cookShifts = allShifts.filter(s => s.isCook);
  const noKitchenStaff = cookShifts.length === 0;
  const usedShifts = noKitchenStaff ? allShifts : cookShifts;

  // For each hour-of-day, count cook-minutes across all shifts.
  // Shift overlap with hour [h, h+1): for each shift, slice into per-hour segments.
  // Day boundary: ak zmena prekročí polnoc, rozdelíme tiež.
  for (const sh of usedShifts){
    const start = new Date(sh.inAt);
    const end = new Date(sh.outAt);
    if (end <= start) continue;
    let cur = new Date(start);
    while (cur < end){
      // Nájdi koniec aktuálneho hour-bucketu (TZ-aware cez Bratislava local)
      const local = new Date(cur.toLocaleString('en-US', { timeZone: 'Europe/Bratislava' }));
      const hour = local.getHours();
      // Compute next hour boundary in UTC
      const localNextHour = new Date(local);
      localNextHour.setHours(hour + 1, 0, 0, 0);
      // Convert local back to UTC
      const offsetMs = (new Date(local.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
                       - local.getTime());
      const nextBoundaryUtc = new Date(localNextHour.getTime() + offsetMs);
      const sliceEnd = nextBoundaryUtc > end ? end : nextBoundaryUtc;
      const minutes = (sliceEnd - cur) / 60000;
      if (minutes > 0 && hour >= 0 && hour < 24){
        byHour[hour].cookMinutes += minutes;
      }
      cur = sliceEnd;
      if (sliceEnd >= end) break;
    }
  }

  // Per-cook efficiency table — total minutes worked + kitchen revenue
  // attributed (proportionally if multiple cooks active in same hour).
  // Simplifying: split kitchenRevenue v každej hodine medzi aktívnych
  // cookov rovnakou váhou (% ich minút v tej hodine).
  const cookStats = new Map(); // staffId -> { name, position, hourlyRate, minutes, kitchenRevenue }
  for (const sh of usedShifts){
    const id = sh.staffId;
    if (!cookStats.has(id)){
      cookStats.set(id, {
        staffId: id,
        name: sh.name,
        position: sh.position,
        hourlyRate: sh.hourlyRate,
        minutes: 0,
        kitchenRevenue: 0,
      });
    }
    const stat = cookStats.get(id);
    // Total minutes
    stat.minutes += (new Date(sh.outAt) - new Date(sh.inAt)) / 60000;
  }

  // Per-hour kitchen revenue allocation — pre každú hodinu zisti aktívnych
  // cookov a rozdeľ kitchen revenue proporčne ich minútam.
  for (let h = 0; h < 24; h++){
    const kitchenRev = byHour[h].kitchenRevenue;
    if (kitchenRev <= 0) continue;
    // Spočítaj per-cook minúty v tejto hodine
    const minutesPerCook = new Map();
    let totalMin = 0;
    for (const sh of usedShifts){
      const start = new Date(sh.inAt);
      const end = new Date(sh.outAt);
      let cur = new Date(start);
      let cookH = 0;
      while (cur < end){
        const local = new Date(cur.toLocaleString('en-US', { timeZone: 'Europe/Bratislava' }));
        const hour = local.getHours();
        const localNextHour = new Date(local);
        localNextHour.setHours(hour + 1, 0, 0, 0);
        const offsetMs = (new Date(local.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
                         - local.getTime());
        const nextBoundaryUtc = new Date(localNextHour.getTime() + offsetMs);
        const sliceEnd = nextBoundaryUtc > end ? end : nextBoundaryUtc;
        const minutes = (sliceEnd - cur) / 60000;
        if (hour === h){
          cookH += minutes;
        }
        cur = sliceEnd;
        if (sliceEnd >= end) break;
      }
      if (cookH > 0){
        minutesPerCook.set(sh.staffId, (minutesPerCook.get(sh.staffId) || 0) + cookH);
        totalMin += cookH;
      }
    }
    if (totalMin > 0){
      byHour[h].activeCooks = minutesPerCook.size;
      for (const [id, min] of minutesPerCook){
        const allocation = (min / totalMin) * kitchenRev;
        const stat = cookStats.get(id);
        if (stat) stat.kitchenRevenue += allocation;
      }
    }
  }

  // Round + finalize
  const cookList = Array.from(cookStats.values()).map(c => ({
    ...c,
    hours: Math.round((c.minutes / 60) * 100) / 100,
    kitchenRevenue: roundMoney(c.kitchenRevenue),
    efficiency: c.minutes > 0 ? roundMoney(c.kitchenRevenue / (c.minutes / 60)) : 0,
    wage: roundMoney((c.minutes / 60) * c.hourlyRate),
  })).sort((a, b) => b.efficiency - a.efficiency);

  const byHourFinal = byHour.map(h => ({
    hour: h.hour,
    kitchenRevenue: roundMoney(h.kitchenRevenue),
    barRevenue: roundMoney(h.barRevenue),
    totalRevenue: roundMoney(h.kitchenRevenue + h.barRevenue),
    kitchenItems: h.kitchenItems,
    barItems: h.barItems,
    orders: h.orders,
    cookMinutes: Math.round(h.cookMinutes),
    cookHours: Math.round((h.cookMinutes / 60) * 100) / 100,
    activeCooks: h.activeCooks,
    kitchenEfficiency: h.cookMinutes > 0 ? roundMoney(h.kitchenRevenue / (h.cookMinutes / 60)) : 0,
  }));

  const heatmap = Array.from(heatmapMap.values()).map(c => ({
    weekday: c.weekday,
    hour: c.hour,
    kitchenRevenue: roundMoney(c.kitchenRevenue),
    barRevenue: roundMoney(c.barRevenue),
    totalRevenue: roundMoney(c.kitchenRevenue + c.barRevenue),
    orders: c.orders,
  }));

  // Totals
  const totalKitchen = byHourFinal.reduce((s, h) => s + h.kitchenRevenue, 0);
  const totalBar = byHourFinal.reduce((s, h) => s + h.barRevenue, 0);
  const totalCookMinutes = byHourFinal.reduce((s, h) => s + h.cookMinutes, 0);
  const totalCookHours = Math.round((totalCookMinutes / 60) * 100) / 100;
  const avgKitchenEfficiency = totalCookMinutes > 0
    ? roundMoney(totalKitchen / (totalCookMinutes / 60))
    : 0;

  res.json({
    period: { from, to },
    byHour: byHourFinal,
    heatmap,
    cooks: cookList,
    noKitchenStaff,
    totals: {
      kitchenRevenue: roundMoney(totalKitchen),
      barRevenue: roundMoney(totalBar),
      cookHours: totalCookHours,
      avgKitchenEfficiency,
    },
  });
});

// GET /api/reports/z-report?date=2026-03-26
router.get('/z-report', mgr, async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const fromDate = new Date(date + 'T00:00:00');
  const toDate = new Date(date + 'T23:59:59.999');

  try {
    // Total revenue from payments
    const [revenue] = await db.select({
      total: sql`COALESCE(SUM(${payments.amount}::numeric), 0)`,
      count: sql`COUNT(*)`,
    }).from(payments).where(
      and(gte(payments.createdAt, fromDate), sql`${payments.createdAt} <= ${toDate}`)
    );

    // Orders count
    const [orderStats] = await db.select({
      totalOrders: sql`COUNT(*)`,
      cancelled: sql`COUNT(*) FILTER (WHERE ${orders.status} = 'cancelled')`,
    }).from(orders).where(
      and(gte(orders.createdAt, fromDate), sql`${orders.createdAt} <= ${toDate}`)
    );

    // Total items sold
    const [itemStats] = await db.select({
      totalItems: sql`COALESCE(SUM(${orderItems.qty}), 0)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        gte(orders.createdAt, fromDate),
        sql`${orders.createdAt} <= ${toDate}`,
        sql`${orders.status} != 'cancelled'`
      )
    );

    // Payment methods breakdown
    const methodStats = await db.select({
      method: payments.method,
      total: sql`SUM(${payments.amount}::numeric)`,
      count: sql`COUNT(*)`,
    }).from(payments).where(
      and(gte(payments.createdAt, fromDate), sql`${payments.createdAt} <= ${toDate}`)
    ).groupBy(payments.method);

    // Category breakdown
    const categoryStats = await db.select({
      category: menuCategories.label,
      total: sql`SUM(${orderItems.qty} * ${menuItems.price}::numeric)`,
      count: sql`SUM(${orderItems.qty})`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
    .where(
      and(
        gte(orders.createdAt, fromDate),
        sql`${orders.createdAt} <= ${toDate}`,
        sql`${orders.status} != 'cancelled'`
      )
    )
    .groupBy(menuCategories.label)
    .orderBy(desc(sql`SUM(${orderItems.qty} * ${menuItems.price}::numeric)`));

    // Top 10 items
    const topItems = await db.select({
      name: menuItems.name,
      emoji: menuItems.emoji,
      qty: sql`SUM(${orderItems.qty})`,
      revenue: sql`SUM(${orderItems.qty} * ${menuItems.price}::numeric)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(
      and(
        gte(orders.createdAt, fromDate),
        sql`${orders.createdAt} <= ${toDate}`,
        sql`${orders.status} != 'cancelled'`
      )
    )
    .groupBy(menuItems.name, menuItems.emoji)
    .orderBy(desc(sql`SUM(${orderItems.qty})`))
    .limit(10);

    // Cancelled orders revenue
    const [cancelledStats] = await db.select({
      cancelledTotal: sql`COALESCE(SUM(${orderItems.qty} * ${menuItems.price}::numeric), 0)`,
      cancelledItems: sql`COALESCE(SUM(${orderItems.qty}), 0)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(
      and(
        gte(orders.createdAt, fromDate),
        sql`${orders.createdAt} <= ${toDate}`,
        sql`${orders.status} = 'cancelled'`
      )
    );

    // Shisha — internal off-fiscal counter for the same calendar day.
    const [shisha] = await db.select({
      count: sql`COUNT(*)`,
      revenue: sql`COALESCE(SUM(${shishaSales.price}::numeric), 0)`,
    }).from(shishaSales).where(
      and(gte(shishaSales.soldAt, fromDate), sql`${shishaSales.soldAt} <= ${toDate}`)
    );
    const shishaCount = parseInt(shisha.count) || 0;
    const shishaRevenue = parseFloat(shisha.revenue) || 0;

    const fiscalRevenue = parseFloat(revenue.total);
    const totalRevenue = fiscalRevenue + shishaRevenue;
    const totalOrders = parseInt(orderStats.totalOrders);
    const totalItems = parseInt(itemStats.totalItems);
    const averageOrder = totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0;

    res.json({
      date,
      totalRevenue,
      fiscalRevenue,
      totalOrders,
      totalItems,
      paymentMethods: methodStats.map(m => ({
        method: m.method,
        total: parseFloat(m.total),
        count: parseInt(m.count),
      })),
      categoryBreakdown: categoryStats.map(c => ({
        category: c.category,
        total: parseFloat(c.total),
        count: parseInt(c.count),
      })),
      topItems: topItems.map(i => ({
        name: i.name,
        emoji: i.emoji,
        qty: parseInt(i.qty),
        revenue: parseFloat(i.revenue),
      })),
      shisha: { count: shishaCount, revenue: shishaRevenue },
      cancelledItems: parseInt(cancelledStats.cancelledItems),
      cancelledTotal: parseFloat(cancelledStats.cancelledTotal),
      averageOrder,
    });
  } catch (err) {
    console.error('Z-report error:', err);
    res.status(500).json({ error: 'Chyba pri generovani Z-reportu' });
  }
});

// GET /api/reports/export?from=2026-03-01&to=2026-03-26&format=csv
router.get('/export', mgr, async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const format = req.query.format || 'csv';

  const fromDate = new Date(from);
  const toDate = new Date(to + 'T23:59:59');

  try {
    // Get all closed orders with payments, items, and staff
    const rawOrders = await db.select({
      orderId: orders.id,
      orderCreatedAt: orders.createdAt,
      orderStatus: orders.status,
      orderDiscountAmount: sql`COALESCE(${orders.discountAmount}::numeric, 0)`,
      staffName: staff.name,
      paymentMethod: payments.method,
      paymentAmount: sql`${payments.amount}::numeric`,
      itemName: menuItems.name,
      itemQty: orderItems.qty,
      itemPrice: sql`${menuItems.price}::numeric`,
      itemVatRate: sql`COALESCE(${menuItems.vatRate}::numeric, 0)`,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .innerJoin(staff, eq(orders.staffId, staff.id))
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(
      and(
        gte(payments.createdAt, fromDate),
        sql`${payments.createdAt} <= ${toDate}`
      )
    )
    .orderBy(desc(payments.createdAt));

    // Group by payment (orderId + paymentMethod as key)
    const grouped = {};
    for (const row of rawOrders) {
      const key = row.orderId + '-' + row.paymentMethod;
      if (!grouped[key]) {
        grouped[key] = {
          orderId: row.orderId,
          date: row.orderCreatedAt,
          staffName: row.staffName,
          paymentMethod: row.paymentMethod,
          paymentAmount: parseFloat(row.paymentAmount),
          discountAmount: parseFloat(row.orderDiscountAmount),
          items: [],
        };
      }
      const existing = grouped[key].items.find(i => i.name === row.itemName);
      if (existing) {
        // skip duplicate from join
      } else {
        grouped[key].items.push({
          name: row.itemName,
          qty: row.itemQty,
          price: parseFloat(row.itemPrice),
          vatRate: parseFloat(row.itemVatRate),
        });
      }
    }
    const rows = Object.values(grouped).map(g => {
      const dt = new Date(g.date);
      const dateStr = dt.toLocaleDateString('sk-SK');
      const timeStr = dt.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
      const itemsList = g.items.map(i => i.qty + 'x ' + i.name).join(', ');
      const celkom = g.paymentAmount;
      const vatGroups = new Map();
      for (const item of g.items) {
        const key = String(item.vatRate);
        vatGroups.set(key, roundMoney((vatGroups.get(key) || 0) + (item.price * item.qty)));
      }
      for (const discount of allocateDiscountAcrossVatGroups(g.items, g.discountAmount)) {
        const key = String(discount.vatRate || 0);
        vatGroups.set(key, roundMoney((vatGroups.get(key) || 0) + discount.price));
      }

      let zaklad = 0;
      let dph = 0;
      for (const [vatRateKey, grossTotal] of vatGroups.entries()) {
        const vatRate = parseFloat(vatRateKey) || 0;
        const factor = 1 + (vatRate / 100);
        const base = factor === 0 ? grossTotal : roundMoney(grossTotal / factor);
        zaklad = roundMoney(zaklad + base);
        dph = roundMoney(dph + (grossTotal - base));
      }
      return {
        cislo: g.orderId,
        datum: dateStr,
        cas: timeStr,
        polozky: itemsList,
        zaklad,
        dph,
        celkom,
        platba: g.paymentMethod,
        cisnik: g.staffName,
      };
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pos-export-${from}-${to}.csv"`);
      // BOM for Excel UTF-8
      let csv = '\uFEFF';
      csv += 'Cislo;Datum;Cas;Polozky;Zaklad;DPH;Celkom;Platba;Cisnik\n';
      for (const r of rows) {
        csv += [r.cislo, r.datum, r.cas, '"' + r.polozky.replace(/"/g, '""') + '"', r.zaklad.toFixed(2), r.dph.toFixed(2), r.celkom.toFixed(2), r.platba, r.cisnik].join(';') + '\n';
      }
      res.send(csv);
    } else {
      res.json(rows);
    }
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Chyba pri exporte' });
  }
});

// GET /api/reports/staff?from=&to=
router.get('/staff', mgr, async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const to = req.query.to || new Date().toISOString().split('T')[0];

  const fromDate = new Date(from);
  const toDate = new Date(to + 'T23:59:59');

  try {
    // Staff with order counts and revenue
    const staffStats = await db.select({
      staffId: staff.id,
      name: staff.name,
      role: staff.role,
      ordersCount: sql`COUNT(DISTINCT ${orders.id})`,
      itemsCount: sql`COALESCE(SUM(${orderItems.qty}), 0)`,
      revenue: sql`COALESCE(SUM(DISTINCT ${payments.amount}::numeric), 0)`,
      cancelledOrders: sql`COUNT(DISTINCT ${orders.id}) FILTER (WHERE ${orders.status} = 'cancelled')`,
    })
    .from(staff)
    .leftJoin(orders, and(
      eq(orders.staffId, staff.id),
      gte(orders.createdAt, fromDate),
      sql`${orders.createdAt} <= ${toDate}`
    ))
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .where(eq(staff.active, true))
    .groupBy(staff.id, staff.name, staff.role)
    .orderBy(desc(sql`COALESCE(SUM(DISTINCT ${payments.amount}::numeric), 0)`));

    // Get payment method breakdown per staff
    const paymentBreakdown = await db.select({
      staffId: staff.id,
      method: payments.method,
      total: sql`SUM(${payments.amount}::numeric)`,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .innerJoin(staff, eq(orders.staffId, staff.id))
    .where(
      and(
        gte(payments.createdAt, fromDate),
        sql`${payments.createdAt} <= ${toDate}`
      )
    )
    .groupBy(staff.id, payments.method);

    const breakdownMap = {};
    for (const pb of paymentBreakdown) {
      if (!breakdownMap[pb.staffId]) breakdownMap[pb.staffId] = {};
      breakdownMap[pb.staffId][pb.method] = parseFloat(pb.total);
    }

    const result = staffStats.map(s => {
      const revenue = parseFloat(s.revenue);
      const ordersCount = parseInt(s.ordersCount);
      const bd = breakdownMap[s.staffId] || {};
      return {
        staffId: s.staffId,
        name: s.name,
        role: s.role,
        ordersCount,
        itemsCount: parseInt(s.itemsCount),
        revenue,
        averageOrder: ordersCount > 0 ? Math.round((revenue / ordersCount) * 100) / 100 : 0,
        cancelledOrders: parseInt(s.cancelledOrders),
        cashPayments: bd['cash'] || 0,
        cardPayments: bd['card'] || 0,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Staff report error:', err);
    res.status(500).json({ error: 'Chyba pri generovani reportu cisnikov' });
  }
});

export default router;

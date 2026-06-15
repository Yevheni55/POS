import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, menuItems, menuCategories, shishaSales } from '../../db/schema.js';
import { TZ, roundMoney } from './shared.js';

// GET /api/reports/summary?from=2024-01-01&to=2024-12-31
// Default: single calendar day (today, Bratislava) so "dashboard today" is
// not merged with yesterday. All date/hour aggregates and boundary
// comparisons use Europe/Bratislava — payments.created_at is stored UTC,
// but the cashier reads the dashboard in local time. Without the TZ shift
// hour bins were UTC (pas-time displays 16:00 instead of 18:00 in summer).
export async function summaryHandler(req, res) {
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
  // Vylucujeme staff_meal ordery zo sales-side topItems — tak rovnako ako pri
  // cogsRows. Staff_meal je naklad firmy (benefit), nie predaj — keby ich
  // pripocitavali, kategoria breakdown by inflatoval qty (sef by si myslel
  // ze sa predalo viac ako naozaj). Reportova "Zamestnanecka spotreba"
  // panel uz zobrazuje staff_meal naklady oddelene.
  const topItems = await db.select({
    name: menuItems.name,
    emoji: menuItems.emoji,
    category: menuCategories.label,
    // Effective dest = item.destOverride (ak je) inak category.dest. COALESCE
    // ošetruje NULL override. Vďaka tomu admin môže pretočiť individuálnu
    // položku bez zmeny kategórie.
    dest: sql`COALESCE(${menuItems.destOverride}, ${menuCategories.dest})`,
    qty: sql`SUM(${orderItems.qty})`,
    revenue: sql`SUM(${orderItems.qty} * ${menuItems.price}::numeric)`,
  })
  .from(orderItems)
  .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
  .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
  .innerJoin(orders, eq(orderItems.orderId, orders.id))
  .where(sql`${orders.createdAt} >= ${fromBoundary} AND ${orders.createdAt} <= ${toBoundary} AND ${orders.status} != 'cancelled' AND COALESCE(${orders.closureType}, 'paid') != 'staff_meal'`)
  .groupBy(menuItems.name, menuItems.emoji, menuCategories.label, menuItems.destOverride, menuCategories.dest)
  .orderBy(desc(sql`SUM(${orderItems.qty})`));

  // Per-day per-product breakdown — pre pivot tabulku "kolko burgerov sa
  // predalo 25.5 vs 26.5". Bucketuje po order.created_at LOCAL Bratislava
  // (rovnako ako cogsRows / dailyRows). Vylucuje staff_meal aj cancelled.
  // Vracia (date, name, dest, qty) — frontend skladá do pivot matice.
  // Dest = override polozky ALEBO category default (COALESCE).
  const productsByDayRows = await db.execute(sql`
    SELECT
      to_char((o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      mi.name AS name,
      COALESCE(mi.dest_override, mc.dest, 'bar') AS dest,
      SUM(oi.qty)::int AS qty
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories mc ON mc.id = mi.category_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
      AND COALESCE(o.closure_type, 'paid') != 'staff_meal'
    GROUP BY 1, mi.name, mi.dest_override, mc.dest
    ORDER BY 1, mi.name
  `);

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

  // Predané burgery — počet kusov burgerov za obdobie. Ráta 4 samostatné
  // burgery + 4 combá (combo = burger + hranolky + nápoj, takže 1 combo =
  // 1 burger) z kategórie 'burgre'. Vylučuje "Omáčka (combo)" (to nie je
  // burger) a staff_meal/cancelled — chceme PREDANÉ kusy. Combo aj burger
  // sa rátajú dokopy podľa požiadavky prevádzky.
  const burgersRes = await db.execute(sql`
    SELECT COALESCE(SUM(oi.qty), 0)::int AS qty
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories mc ON mc.id = mi.category_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
      AND COALESCE(o.closure_type, 'paid') != 'staff_meal'
      AND mc.slug = 'burgre'
      AND mi.name NOT ILIKE 'Omáčka%'
  `);
  const burgersSold = Number(burgersRes.rows[0] && burgersRes.rows[0].qty) || 0;

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
      AND COALESCE(o.closure_type, 'paid') != 'staff_meal'
    GROUP BY 1
    ORDER BY 1
  `);

  // Per-day zamestnanecká spotreba — náklad na suroviny pre staff meals.
  // Toto je oddelene od COGS predaja, aby P&L vedel ukázať "z čoho":
  //   tržby − náklad na výrobu predaného − mzdy − staff_meal_cost = zisk
  // Sklad sa už odpísal pri /send (deductStockForSentItems) → tu len
  // sumarizujeme cez write_offs ktoré sa vytvorili pri close-as-staff-meal.
  const staffMealRows = await db.execute(sql`
    SELECT
      to_char((wo.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(wo.total_cost::numeric), 0)::float AS cost
    FROM write_offs wo
    WHERE wo.reason = 'staff_meal'
      AND wo.created_at >= ${fromBoundary} AND wo.created_at <= ${toBoundary}
    GROUP BY 1
    ORDER BY 1
  `);

  // Zamestnanecká spotreba podľa mena (= meno stola v zóne 'zamestanci').
  // Konvencia: stoly v staff zóne sa volajú menami zamestnancov (Alex,
  // Oleh, Tania, Yevhen…), takže name stola = identita konzumenta. Toto
  // dáva čistú per-person attribution bez nutnosti staff_id flagu na
  // order. (created_by na write_off je kasier ktorý zatvoril, nie ten
  // kto si dal jedlo.)
  //
  // Split COGS na food (kuchyna) vs napoje (bar) cez menu_categories.dest.
  // Polozky bez receptu (vacsina barovych drinkov bez recipe definicie)
  // contribuju 0 — same simplifikacia ako cogsRows above.
  //
  // menu_value = SUM(qty × menu_items.price) — kolko by to stalo na predaj.
  // Toto je hodnota benefitu, ktory zamestnanec dostal. menu_value − cost =
  // marza na ktoru firma "rezignovala" (potencialny zisk).
  //
  // POZN: agregacia nad order_items vs over recipes-vyzaduje dve nezavisle
  // GROUP-BY-a, lebo recipe ma multi-row JOIN per oi (jedna polozka, viac
  // ingredients). Robime to v dvoch CTE a JOINujeme.
  const staffMealByPersonRows = await db.execute(sql`
    WITH per_order AS (
      SELECT
        wo.id AS wo_id,
        t.name AS person_name,
        oi.id AS oi_id,
        oi.qty,
        mi.price::numeric AS menu_price,
        mc.dest
      FROM write_offs wo
      INNER JOIN orders o ON o.id = wo.order_id
      INNER JOIN tables t ON t.id = o.table_id
      INNER JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE wo.reason = 'staff_meal'
        AND wo.created_at >= ${fromBoundary} AND wo.created_at <= ${toBoundary}
    ),
    per_oi_cogs AS (
      SELECT
        oi.id AS oi_id,
        COALESCE(SUM(r.qty_per_unit::numeric * i.cost_per_unit::numeric), 0)::numeric AS unit_cogs
      FROM order_items oi
      LEFT JOIN recipes r ON r.menu_item_id = oi.menu_item_id
      LEFT JOIN ingredients i ON i.id = r.ingredient_id
      WHERE oi.id IN (SELECT oi_id FROM per_order)
      GROUP BY oi.id
    )
    SELECT
      po.person_name,
      COUNT(DISTINCT po.wo_id)::int AS meals,
      COALESCE(SUM(CASE WHEN po.dest = 'kuchyna' THEN po.qty * pc.unit_cogs ELSE 0 END), 0)::float AS food_cost,
      COALESCE(SUM(CASE WHEN po.dest = 'bar'     THEN po.qty * pc.unit_cogs ELSE 0 END), 0)::float AS drink_cost,
      COALESCE(SUM(po.qty * pc.unit_cogs), 0)::float AS cost,
      COALESCE(SUM(po.qty * po.menu_price), 0)::float AS menu_value
    FROM per_order po
    INNER JOIN per_oi_cogs pc ON pc.oi_id = po.oi_id
    GROUP BY po.person_name
    ORDER BY menu_value DESC, po.person_name ASC
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
      AND COALESCE(o.closure_type, 'paid') != 'staff_meal'
    GROUP BY mi.name
  `);

  // Per-day náklady na mzdy — pairs each clock_in with the immediately
  // next event (which should be the matching clock_out) and computes
  // hours × hourly_rate. Bucketed by clock_in's LOCAL Bratislava date so
  // a shift that starts before midnight lands on the date the cashier
  // walked in (not the date they clocked out). OTVORENÉ zmeny (prihlásený,
  // ešte neodhlásený) sa rátajú PRIEBEŽNE: koniec = min(teraz, koniec obdobia),
  // takže dnešný dashboard ukazuje rastúci náklad na mzdy už počas dňa. V
  // historickom reporte sa otvorená zmena zaráta len po koniec daného dňa
  // (žiadne preťaženie keď niekto zabudol odhlásiť). Admin s NULL hourly_rate = 0.
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
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(paired.next_at, LEAST((now() AT TIME ZONE 'UTC'), (${toBoundary} AT TIME ZONE 'UTC'))) - paired.at)) / 3600.0
        * COALESCE(s.hourly_rate, 0)::numeric), 0)::float AS labor
    FROM paired
    INNER JOIN staff s ON s.id = paired.staff_id
    WHERE paired.type = 'clock_in'
      AND (paired.next_type = 'clock_out' OR paired.next_type IS NULL)
      AND paired.at >= ${fromBoundary}
      AND paired.at <= ${toBoundary}
    GROUP BY 1
    ORDER BY 1
  `);

  // Per-staff labor breakdown — rovnaka paired CTE, ale GROUP BY staff_id.
  // Pouzite v admin Reportoch panelom "Mzdy podla zamestnancov" aby sef
  // vedel kto najviac stal firmu cez zvolene obdobie. Otvorene zmeny sa rataju
  // priebezne (koniec = min(teraz, koniec obdobia)) — konzistentne s totalLabor.
  const laborByStaffRows = await db.execute(sql`
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
      s.id AS staff_id,
      s.name AS staff_name,
      COALESCE(s.position, '') AS position,
      COALESCE(s.hourly_rate, 0)::float AS hourly_rate,
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(paired.next_at, LEAST((now() AT TIME ZONE 'UTC'), (${toBoundary} AT TIME ZONE 'UTC'))) - paired.at)) / 3600.0), 0)::float AS hours,
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(paired.next_at, LEAST((now() AT TIME ZONE 'UTC'), (${toBoundary} AT TIME ZONE 'UTC'))) - paired.at)) / 3600.0
        * COALESCE(s.hourly_rate, 0)::numeric), 0)::float AS labor,
      COUNT(*)::int AS shifts
    FROM paired
    INNER JOIN staff s ON s.id = paired.staff_id
    WHERE paired.type = 'clock_in'
      AND (paired.next_type = 'clock_out' OR paired.next_type IS NULL)
      AND paired.at >= ${fromBoundary}
      AND paired.at <= ${toBoundary}
    GROUP BY s.id, s.name, s.position, s.hourly_rate
    HAVING COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(paired.next_at, LEAST((now() AT TIME ZONE 'UTC'), (${toBoundary} AT TIME ZONE 'UTC'))) - paired.at)) / 3600.0), 0) > 0
    ORDER BY labor DESC, s.name ASC
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
      COALESCE(mi.dest_override, c.dest) AS dest,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS revenue
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories c ON c.id = mi.category_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
    GROUP BY 1, COALESCE(mi.dest_override, c.dest)
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
      COALESCE(mi.dest_override, c.dest) AS dest,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS revenue,
      COALESCE(SUM(oi.qty), 0)::int AS items
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories c ON c.id = mi.category_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
    GROUP BY COALESCE(mi.dest_override, c.dest)
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
  const staffMealByDate = {};
  for (const r of staffMealRows.rows) staffMealByDate[r.date] = Number(r.cost) || 0;
  // A day might exist in cogs/labor but not in dailyArr (sales-less day
  // that still had a paid shift, or recipe write-off). Union all keys so
  // such days still surface with revenue=0.
  const dailyDateSet = new Set([
    ...dailyRows.rows.map(r => r.date),
    ...Object.keys(cogsByDate),
    ...Object.keys(laborByDate),
    ...Object.keys(staffMealByDate),
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
    const staffMeal = roundMoney(staffMealByDate[date] || 0);
    return {
      date,
      orders,
      revenue,
      avgCheck: orders > 0 ? roundMoney(revenue / orders) : 0,
      peakHours: '',
      cogs,
      labor,
      staffMeal,
      // Zisk = tržby − suroviny predaného − mzdy − suroviny zamestnaneckej spotreby.
      // staff_meal nie je odčítaný z tržieb (žiadna platba), ale je nákladom
      // na suroviny, takže ide do mínusu pri výpočte zisku.
      profit: roundMoney(revenue - cogs - labor - staffMeal),
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
  const totalStaffMeal = roundMoney(dailyArr.reduce((s, d) => s + (d.staffMeal || 0), 0));
  const totalProfit = roundMoney(totalRevenue - totalCogs - totalLabor - totalStaffMeal);

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
    totalStaffMeal,
    totalProfit,
    burgersSold,
    staffMealByPerson: staffMealByPersonRows.rows.map(r => ({
      name: r.person_name,
      meals: Number(r.meals) || 0,
      foodCost: Number(r.food_cost) || 0,
      drinkCost: Number(r.drink_cost) || 0,
      cost: Number(r.cost) || 0,
      menuValue: Number(r.menu_value) || 0,
    })),
    laborByStaff: laborByStaffRows.rows.map(r => ({
      staffId: Number(r.staff_id) || 0,
      name: r.staff_name,
      position: r.position || '',
      hourlyRate: Number(r.hourly_rate) || 0,
      hours: Number(r.hours) || 0,
      labor: Number(r.labor) || 0,
      shifts: Number(r.shifts) || 0,
    })),
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
        dest: it.dest || 'bar', // 'bar' | 'kuchyna'
        qty: it.qty,
        revenue: it.revenue,
        cogs,
        profit: roundMoney(it.revenue - cogs),
      };
    }),
    // Per-day per-product matrix — frontend pivotuje na rendering.
    // Structure: [{ date, name, dest, qty }, ...] sorted by (date, name).
    productsByDay: productsByDayRows.rows.map(r => ({
      date: r.date,
      name: r.name,
      dest: r.dest || 'bar',
      qty: Number(r.qty) || 0,
    })),
  });
}

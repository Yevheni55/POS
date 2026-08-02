import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, menuItems, menuCategories, shishaSales } from '../../db/schema.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { getVatMode } from '../vat-registration.js';
import {
  TZ,
  roundMoney,
  notStornoedSql,
  notStornoedOrderSql,
  notForeignCashRegisterSql,
  notForeignCashRegisterOrderSql,
} from './shared.js';

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

  // Na kase sa môže zmeniť daňový subjekt (iné DKP v Portose) — reporty nesmú
  // sčítať tržby dvoch firiem. Prázdny kód = filter sa neaplikuje (rovnaký
  // fallback ako server/lib/payments/history.js).
  const activeCashRegisterCode = await getActiveCashRegisterCode();
  const notForeignPayment = sql.raw(notForeignCashRegisterSql('payments', activeCashRegisterCode));
  const notForeignPaymentP = sql.raw(notForeignCashRegisterSql('p', activeCashRegisterCode));
  const notForeignOrderO = sql.raw(notForeignCashRegisterOrderSql('o', activeCashRegisterCode));

  // Režim DPH — u PLATITEĽA nie je daň na výstupe príjmom firmy, takže zisk
  // sa NESMIE počítať z brutto tržby proti netto nákladom. U neplatiteľa
  // ostáva všetko presne ako doteraz (`netFactor` = 1).
  // Report je len na čítanie: keď sa režim nedá zistiť, radšej vrátime staré
  // (brutto) čísla + `vatModeError`, než aby padla celá stránka reportov.
  let vatRegistered = false;
  let vatModeError = null;
  try {
    ({ vatRegistered } = await getVatMode());
  } catch (err) {
    vatModeError = err?.message || String(err);
    console.error('[reports/summary] nepodarilo sa zistiť režim DPH:', vatModeError);
  }

  // Total revenue
  const [revenue] = await db.select({
    total: sql`COALESCE(SUM(${payments.amount}::numeric), 0)`,
    count: sql`COUNT(*)`,
  }).from(payments).where(
    sql`${payments.createdAt} >= ${fromBoundary} AND ${payments.createdAt} <= ${toBoundary} AND ${sql.raw(notStornoedSql('payments'))} AND ${notForeignPayment}`
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
    sql`${payments.createdAt} >= ${fromBoundary} AND ${payments.createdAt} <= ${toBoundary} AND ${sql.raw(notStornoedSql('payments'))} AND ${notForeignPayment}`
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
    // Sadzba DPH položky pre netto maržu v Produktoch. Zámerne agregát
    // MAX(...) a NIE ďalší GROUP BY kľúč — pridanie do GROUP BY by rozbilo
    // riadok na dva, keby dve položky s rovnakým názvom mali inú sadzbu.
    vatRate: sql`MAX(COALESCE(${menuItems.vatRate}::numeric, 0))`,
  })
  .from(orderItems)
  .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
  .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
  .innerJoin(orders, eq(orderItems.orderId, orders.id))
  // Fiškálne stornovaný účet nie je predaj — bez tohto filtra ukazovala tržba
  // 0 €, ale "Produkty"/kategórie stále plnú sumu.
  .where(sql`${orders.createdAt} >= ${fromBoundary} AND ${orders.createdAt} <= ${toBoundary} AND ${orders.status} != 'cancelled' AND COALESCE(${orders.closureType}, 'paid') != 'staff_meal'
    AND ${sql.raw(notStornoedOrderSql('orders'))}
    AND ${sql.raw(notForeignCashRegisterOrderSql('orders', activeCashRegisterCode))}`)
  .groupBy(menuItems.name, menuItems.emoji, menuCategories.label, menuItems.destOverride, menuCategories.dest)
  .orderBy(desc(sql`SUM(${orderItems.qty})`));

  // Per-day per-product breakdown — pre pivot tabulku "kolko burgerov sa
  // predalo 25.5 vs 26.5". Bucketuje po order.created_at LOCAL Bratislava
  // (rovnako ako cogsRows / dailyRows). Vylucuje staff_meal aj cancelled.
  // Vracia (date, name, category, dest, qty, revenue) — frontend pivotuje
  // buď po polozke alebo po kategorii, metrika ks alebo trzba (qty × price,
  // gross — rovnako ako topItems/products). Dest = override polozky ALEBO
  // category default (COALESCE).
  const productsByDayRows = await db.execute(sql`
    SELECT
      to_char((o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      mi.name AS name,
      mc.label AS category,
      COALESCE(mi.dest_override, mc.dest, 'bar') AS dest,
      SUM(oi.qty)::int AS qty,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS revenue
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories mc ON mc.id = mi.category_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
      AND COALESCE(o.closure_type, 'paid') != 'staff_meal'
      AND ${sql.raw(notStornoedOrderSql('o'))}
      AND ${notForeignOrderO}
    GROUP BY 1, mi.name, mc.label, mi.dest_override, mc.dest
    ORDER BY 1, mi.name
  `);

  // Rozpad BRUTTO tržby predaných položiek podľa sadzby DPH, po dňoch.
  // Slúži LEN na odvodenie netto tržby (základ dane) u platiteľa DPH —
  // u neplatiteľa sa query vôbec nespúšťa a všetky čísla ostávajú brutto.
  // Odpis a staff_meal sú mimo (odpis nejde cez fiškál a rátame ho brutto,
  // staff_meal nie je predaj). Pomer sadzieb sa potom aplikuje na REÁLNE
  // zaplatenú sumu (`dailyRows`), aby zľavy aj zaokrúhlenia sedeli.
  const vatMixRows = vatRegistered ? await db.execute(sql`
    SELECT
      to_char((o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      COALESCE(mi.vat_rate::numeric, 0)::float AS vat_rate,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS gross
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
      AND COALESCE(o.closure_type, 'paid') NOT IN ('staff_meal', 'odpis')
      AND ${sql.raw(notStornoedOrderSql('o'))}
      AND ${notForeignOrderO}
    GROUP BY 1, 2
  `) : { rows: [] };

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
      AND ${notForeignOrderO}
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
    WHERE p.created_at >= ${fromBoundary} AND p.created_at <= ${toBoundary} AND ${sql.raw(notStornoedSql('p'))}
      AND ${notForeignPaymentP}
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
      AND ${notForeignOrderO}
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

  // Per-day ODPIS — predajna (cennikova) hodnota uctov uzavretych ako
  // manazersky odpis (closure_type='odpis', cez /close-as-odpis). Ziadna
  // platba ani fiskal → nie je v `payments`, takze sa do trzby (dailyRows,
  // hourlyRows, staffRows — vsetko payment-based) musi PRIRATAT manualne.
  // Tu zratame SUM(qty × menu price) gross, bucketovane po order.created_at
  // LOCAL Bratislava (rovnako ako cogsRows). Per rozhodnutie prevadzky sa
  // odpis sprava ako BEZNY PREDAJ — rata sa do trzby aj do zisku (jeho cogs
  // uz pokryva cogsRows, ktory odpis zahrna). KPI "Odpisy (predaj)" ostava
  // ako informativny podiel "z toho odpis".
  const odpisRows = await db.execute(sql`
    SELECT
      to_char((o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS odpis,
      COUNT(DISTINCT o.id)::int AS orders
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND COALESCE(o.closure_type, 'paid') = 'odpis'
      AND ${notForeignOrderO}
    GROUP BY 1
    ORDER BY 1
  `);

  // Per-hodina ODPIS — aby hodinovy rozpad trzby (hourlyRows je payment-based)
  // zahrnal aj odpis. Bucketujeme po order.created_at LOCAL Bratislava hodine,
  // rovnako ako hourlyDestRows.
  const odpisHourlyRows = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS hour,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS odpis
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND COALESCE(o.closure_type, 'paid') = 'odpis'
      AND ${notForeignOrderO}
    GROUP BY 1
  `);
  const odpisHourMap = {};
  for (const r of odpisHourlyRows.rows) odpisHourMap[Number(r.hour) || 0] = Number(r.odpis) || 0;

  // Per-zamestnanec ODPIS — aby trzba per cisnik (staffRows je payment-based)
  // zahrnala aj odpis. Atribuujeme cez orders.staff_id (kto ucet zalozil).
  const odpisStaffRows = await db.execute(sql`
    SELECT
      s.name AS name,
      COUNT(DISTINCT o.id)::int AS orders,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS revenue
    FROM orders o
    INNER JOIN order_items oi ON oi.order_id = o.id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN staff s ON s.id = o.staff_id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND COALESCE(o.closure_type, 'paid') = 'odpis'
      AND ${notForeignOrderO}
    GROUP BY s.id, s.name
  `);
  const odpisStaffMap = {};
  for (const r of odpisStaffRows.rows) odpisStaffMap[r.name] = { orders: Number(r.orders) || 0, revenue: Number(r.revenue) || 0 };

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
      AND ${notForeignOrderO}
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
        LEAD(ae.at)   OVER (PARTITION BY ae.staff_id ORDER BY ae.at, ae.id) AS next_at,
        LEAD(ae.type) OVER (PARTITION BY ae.staff_id ORDER BY ae.at, ae.id) AS next_type
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
        LEAD(ae.at)   OVER (PARTITION BY ae.staff_id ORDER BY ae.at, ae.id) AS next_at,
        LEAD(ae.type) OVER (PARTITION BY ae.staff_id ORDER BY ae.at, ae.id) AS next_type
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
    WHERE p.created_at >= ${fromBoundary} AND p.created_at <= ${toBoundary} AND ${sql.raw(notStornoedSql('p'))}
      AND ${notForeignPaymentP}
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
      AND COALESCE(o.closure_type, 'paid') != 'staff_meal'
      AND ${notForeignOrderO}
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
    WHERE p.created_at >= ${fromBoundary} AND p.created_at <= ${toBoundary} AND ${sql.raw(notStornoedSql('p'))}
      AND ${notForeignPaymentP}
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
      AND COALESCE(o.closure_type, 'paid') != 'staff_meal'
      AND ${notForeignOrderO}
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
  const odpisByDate = {};
  const odpisOrdersByDate = {};
  for (const r of odpisRows.rows) {
    odpisByDate[r.date] = Number(r.odpis) || 0;
    odpisOrdersByDate[r.date] = Number(r.orders) || 0;
  }
  // Suma odpisov za obdobie (predajna hodnota) — folduje sa do totalRevenue
  // (odpis = bezny predaj) a zaroven sa vykazuje samostatne ako "z toho odpis".
  const totalOdpis = roundMoney(Object.values(odpisByDate).reduce((s, v) => s + v, 0));
  // A day might exist in cogs/labor but not in dailyArr (sales-less day
  // that still had a paid shift, or recipe write-off). Union all keys so
  // such days still surface with revenue=0.
  const dailyDateSet = new Set([
    ...dailyRows.rows.map(r => r.date),
    ...Object.keys(cogsByDate),
    ...Object.keys(laborByDate),
    ...Object.keys(staffMealByDate),
    ...Object.keys(odpisByDate),
  ]);
  const revenueByDate = {};
  const ordersByDate = {};
  for (const r of dailyRows.rows) {
    revenueByDate[r.date] = Number(r.revenue) || 0;
    ordersByDate[r.date] = Number(r.orders) || 0;
  }

  // ── DPH na výstupe ────────────────────────────────────────────────────────
  // U PLATITEĽA nie je daň na výstupe príjmom firmy — proti NETTO nákladom
  // (ingredients.cost_per_unit sa zadáva BEZ DPH) sa preto nesmie stavať
  // BRUTTO tržba. Postup: z položiek dňa vezmeme len POMER sadzieb a ten
  // aplikujeme na REÁLNE zaplatenú sumu (`revenueByDate`), takže zľavy aj
  // zaokrúhlenia ostanú konzistentné a Σ netto = fiškálna tržba − DPH.
  // Odpis a shisha ostávajú BRUTTO — cez fiškál vôbec neprešli.
  // U NEPLATITEĽA je `vatMixByDate` prázdna, `netFactorFor()` vracia 1 a
  // všetky čísla sú bajt-identické s pôvodným kódom.
  const vatMixByDate = {};
  for (const r of (vatMixRows.rows || [])) {
    const gross = Number(r.gross) || 0;
    if (gross <= 0) continue;
    (vatMixByDate[r.date] ??= []).push({ vatRate: Number(r.vat_rate) || 0, gross });
  }
  /** Podiel základu dane na brutto tržbe daného dňa (1 = žiadna DPH). */
  function netFactorFor(date) {
    const mix = vatMixByDate[date];
    if (!mix || !mix.length) return 1;
    const grossSum = mix.reduce((s, g) => s + g.gross, 0);
    if (!(grossSum > 0)) return 1;
    return mix.reduce((s, g) => s + (g.gross / grossSum) / (1 + (g.vatRate / 100)), 0);
  }
  // Brutto tržba per sadzba (už premietnutá na skutočne zaplatené sumy).
  const vatGrossByRate = new Map();

  const dailyArr = Array.from(dailyDateSet).sort().map((date) => {
    const odpis = roundMoney(odpisByDate[date] || 0);
    // Odpis sa rata ako bezny predaj → pripocitavame ho do trzby aj do poctu
    // uctov (kvoli avgCheck). Fiskalna trzba (platby) + odpis.
    const orders = (ordersByDate[date] || 0) + (odpisOrdersByDate[date] || 0);
    const fiscalDay = revenueByDate[date] || 0;
    const revenue = roundMoney(fiscalDay + odpis);
    const cogs = roundMoney(cogsByDate[date] || 0);
    const labor = roundMoney(laborByDate[date] || 0);
    const staffMeal = roundMoney(staffMealByDate[date] || 0);
    // Netto (bez DPH) fiškálna tržba dňa + brutto odpis.
    const revenueNet = roundMoney((fiscalDay * netFactorFor(date)) + odpis);
    const mix = vatMixByDate[date];
    if (mix && fiscalDay > 0) {
      const grossSum = mix.reduce((s, g) => s + g.gross, 0);
      if (grossSum > 0) {
        for (const g of mix) {
          vatGrossByRate.set(g.vatRate, (vatGrossByRate.get(g.vatRate) || 0) + (fiscalDay * (g.gross / grossSum)));
        }
      }
    }
    return {
      date,
      orders,
      revenue,
      // Tržba bez DPH (základ dane). U neplatiteľa === revenue.
      revenueNet,
      avgCheck: orders > 0 ? roundMoney(revenue / orders) : 0,
      peakHours: '',
      cogs,
      labor,
      staffMeal,
      // Odpis = predajna hodnota uctov uzavretych ako manazersky odpis. Uz je
      // ZAHRNUTY vo `revenue` vyssie (rata sa ako bezny predaj); tu ho vraciame
      // samostatne len ako informativny podiel "z toho odpis".
      odpis,
      // Zisk = trzby BEZ DPH (vratane odpisu) − suroviny predaneho (cogs zahrna
      // odpis) − mzdy − suroviny zamestnaneckej spotreby. staff_meal nie je
      // v trzbe, ale je nakladom na suroviny, takze ide do minusu.
      // U neplatitela je revenueNet === revenue → cislo je nezmenene.
      profit: roundMoney(revenueNet - cogs - labor - staffMeal),
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
  for (const k of Object.keys(odpisHourMap)) hourSet.add(Number(k));
  const hourlyArr = Array.from(hourSet).sort((a, b) => a - b).map((h) => {
    const p = paymentHourMap[h] || { orders: 0, revenue: 0 };
    const d = hourlyDestMap[h] || { bar: 0, kuchyna: 0 };
    // Odpis (item-based) sa pripocita do hodinovej trzby; bar/kuchyna rozpad
    // uz odpis obsahuje (hourlyDestRows zahrna odpis).
    return {
      hour: String(h).padStart(2, '0') + ':00',
      orders: p.orders,
      revenue: roundMoney(p.revenue + (odpisHourMap[h] || 0)),
      barRevenue: roundMoney(d.bar),
      kuchynaRevenue: roundMoney(d.kuchyna),
    };
  });
  // Trzba per cisnik = fiskalne platby + odpis (predaj na ucet podniku),
  // atribuovany cez orders.staff_id. Odpis-only cisnik (bez fiskalnej platby)
  // sa tiez objavi.
  const staffByName = {};
  for (const r of staffRows.rows) {
    staffByName[r.name] = { name: r.name, orders: Number(r.orders) || 0, revenue: Number(r.revenue) || 0 };
  }
  for (const name of Object.keys(odpisStaffMap)) {
    const o = odpisStaffMap[name];
    if (!staffByName[name]) staffByName[name] = { name, orders: 0, revenue: 0 };
    staffByName[name].orders += o.orders;
    staffByName[name].revenue += o.revenue;
  }
  const staffArr = Object.values(staffByName)
    .sort((a, b) => b.revenue - a.revenue)
    .map((r) => ({
      name: r.name,
      shifts: 0,
      orders: r.orders,
      revenue: roundMoney(r.revenue),
      avgCheck: r.orders > 0 ? roundMoney(r.revenue / r.orders) : 0,
      rating: 0,
    }));

  // Trzba = fiskalne platby + shisha + odpis (predaj na ucet podniku).
  // Odpis sa per rozhodnutie prevadzky rata ako bezny predaj.
  const totalRevenue = roundMoney(fiscalTotal + shishaRevenue + totalOdpis);
  const totalOrders = parseInt(orderStats.total) || 0;
  const avgCheck = totalOrders > 0 ? roundMoney(totalRevenue / totalOrders) : 0;
  const topRevenue = staffArr.length ? staffArr[0].revenue : 0;
  const topItemsArr = topItems.map(i => ({
    ...i,
    qty: parseInt(i.qty),
    revenue: parseFloat(i.revenue),
    vatRate: parseFloat(i.vatRate) || 0,
  }));

  // Period totals — sum the per-day arrays so the dashboard "Spolu" row
  // and the new "Výsledok" stat card always agree with the table. Profit
  // uses fiscal+shisha totalRevenue (matching the existing 'Celkové tržby'
  // card) MINUS the COGS and labor sums; if the period boundary trims a
  // shift in the middle (clock_in inside, clock_out outside) that shift
  // contributes to whichever bucket its clock_in fell in.
  const totalCogs = roundMoney(dailyArr.reduce((s, d) => s + (d.cogs || 0), 0));
  const totalLabor = roundMoney(dailyArr.reduce((s, d) => s + (d.labor || 0), 0));
  const totalStaffMeal = roundMoney(dailyArr.reduce((s, d) => s + (d.staffMeal || 0), 0));

  // Netto (bez DPH) fiškálna tržba = Σ denných netto tržieb mínus brutto odpis,
  // ktorý je v `d.revenueNet` už započítaný. Shisha je off-fiscal → brutto.
  // U neplatiteľa vychádza netFiscalTotal === fiscalTotal a všetko nižšie je
  // bajt-identické s pôvodným kódom.
  // Pri neplatiteľovi vynucujeme rovnosť explicitne (žiadny priestor na
  // centový float drift) — čísla musia byť bajt-identické s dneškom.
  const netFiscalTotal = vatRegistered
    ? roundMoney(dailyArr.reduce((s, d) => s + ((d.revenueNet || 0) - (d.odpis || 0)), 0))
    : fiscalTotal;
  const totalVatOutput = roundMoney(fiscalTotal - netFiscalTotal);
  const totalRevenueNet = roundMoney(totalRevenue - totalVatOutput);
  // Rozpad DPH po sadzbách — podklad pre účtovníčku aj Google Sheets P&L.
  const vatByRate = Array.from(vatGrossByRate.entries())
    .map(([vatRate, gross]) => {
      const base = roundMoney(gross / (1 + (vatRate / 100)));
      return { vatRate, gross: roundMoney(gross), base, amount: roundMoney(roundMoney(gross) - base) };
    })
    .sort((a, b) => a.vatRate - b.vatRate);

  // Zisk = trzby BEZ DPH (vratane odpisu) − suroviny predaneho (totalCogs uz
  // zahrna odpis) − mzdy − suroviny zamestnaneckej spotreby. totalOdpis je uz
  // zahrnuty v totalRevenue; vykazuje sa samostatne len ako podiel "z toho".
  // DPH na vystupe nie je prijmom firmy, preto ide zo zakladu prec.
  const totalProfit = roundMoney(totalRevenueNet - totalCogs - totalLabor - totalStaffMeal);

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
    totalOdpis,
    totalProfit,
    // ── DPH ────────────────────────────────────────────────────────────────
    // `totalRevenue` ostáva BRUTTO (KPI „Celkové tržby" musí sedieť so
    // zásuvkou). Pre maržu a P&L použi `totalRevenueNet`.
    // U neplatiteľa: vatRegistered=false, totalVatOutput=0,
    // totalRevenueNet === totalRevenue, vat.byRate = [].
    vatRegistered,
    // Nenulové len ak sa režim DPH nedal zistiť — čísla sú vtedy počítané
    // ako u neplatiteľa (brutto) a NESMÚ slúžiť ako podklad pre priznanie.
    vatModeError,
    totalRevenueNet,
    totalVatOutput,
    vat: {
      amount: totalVatOutput,
      base: netFiscalTotal,
      byRate: vatByRate,
    },
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
      // Food cost aj marža sa musia počítať na ROVNAKOM základe ako COGS
      // (ingredients.cost_per_unit je BEZ DPH). U neplatiteľa je
      // revenueNet === revenue a číslo je nezmenené.
      const revenueNet = vatRegistered
        ? roundMoney(it.revenue / (1 + ((it.vatRate || 0) / 100)))
        : it.revenue;
      return {
        name: it.name,
        emoji: it.emoji || '',
        category: it.category || '',
        dest: it.dest || 'bar', // 'bar' | 'kuchyna'
        qty: it.qty,
        revenue: it.revenue,
        revenueNet,
        vatRate: it.vatRate || 0,
        cogs,
        profit: roundMoney(revenueNet - cogs),
      };
    }),
    // Per-day per-product matrix — frontend pivotuje na rendering.
    // Structure: [{ date, name, category, dest, qty, revenue }, ...] sorted
    // by (date, name). category + revenue umoznuju prepnut pivot na
    // "trzba podla kategorii po dnoch".
    productsByDay: productsByDayRows.rows.map(r => ({
      date: r.date,
      name: r.name,
      category: r.category || '',
      dest: r.dest || 'bar',
      qty: Number(r.qty) || 0,
      revenue: roundMoney(Number(r.revenue) || 0),
    })),
  });
}

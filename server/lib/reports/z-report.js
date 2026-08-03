import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, menuItems, menuCategories, shishaSales } from '../../db/schema.js';
import { localYmd } from '../print/format.js';

import {
  TZ,
  notStornoedSql,
  notStornoedOrderSql,
  notForeignCashRegisterSql,
  notForeignCashRegisterOrderSql,
  resolveScope,
} from './shared.js';

// GET /api/reports/z-report?date=2026-03-26&scope=active|all
export async function zReportHandler(req, res) {
  // Default = DNESNY lokalny den (nie UTC den — ten sa po polnoci lisi).
  const date = req.query.date || localYmd();

  // Denne okno sa MUSI pocitat v Europe/Bratislava, nie v UTC. Server bezi
  // v Dockeri v UTC a created_at je `timestamp` BEZ zony (UTC nastenne hodiny),
  // takze `new Date(date+'T00:00:00')` pokryval 02:00–01:59 lokalneho casu →
  // uzavierka tahana tesne po polnoci bola takmer prazdna. Rovnaky pristup ako
  // server/lib/reports/summary.js, ale stlpec explicitne interpretujeme ako UTC
  // (`AT TIME ZONE 'UTC'`), aby vysledok NEZAVISEL od session TimeZone databazy.
  const fromBoundary = sql`(${date + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${date + ' 23:59:59.999'})::timestamp AT TIME ZONE ${TZ}`;
  // inDay = stlpce typu `timestamp` BEZ zony (payments/orders/write_offs).
  // inDayTz = stlpce `timestamptz` (shisha_sales.sold_at) — tie uz zonu nesu,
  // takze sa porovnavaju priamo (pridanie AT TIME ZONE 'UTC' by ich naopak
  // rozbilo).
  const inDay   = (col) => sql`(${col} AT TIME ZONE 'UTC') >= ${fromBoundary} AND (${col} AT TIME ZONE 'UTC') <= ${toBoundary}`;
  const inDayTz = (col) => sql`${col} >= ${fromBoundary} AND ${col} <= ${toBoundary}`;

  try {
    // Na kase sa môže zmeniť daňový subjekt (iné DKP v Portose). Uzávierka
    // nesmie zúčtovať tržby cudzej firmy — default `scope=active` preto
    // filtruje podľa aktívneho kódu pokladne. `scope=all` filter uvoľní
    // (historický pohľad majiteľa); `cashFiscalByRegister` aj
    // `activeCashRegisterCode` ostávajú nezmenené, lebo tlač výberu hotovosti
    // sa musí VŽDY riadiť aktívnou pokladňou.
    const { scope, cashRegisterCode, filterCode } = await resolveScope(req);
    const activeCashRegisterCode = cashRegisterCode;
    const notForeignPayment = sql.raw(notForeignCashRegisterSql('payments', filterCode));
    const notForeignOrder = sql.raw(notForeignCashRegisterOrderSql('orders', filterCode));

    // Total revenue from payments
    const [revenue] = await db.select({
      total: sql`COALESCE(SUM(${payments.amount}::numeric), 0)`,
      count: sql`COUNT(*)`,
    }).from(payments).where(
      sql`${inDay(payments.createdAt)} AND ${sql.raw(notStornoedSql('payments'))} AND ${notForeignPayment}`   // stornované platby ani cudzia kasa nie sú tržba
    );

    // Orders count. Rovnaké filtre ako pri fiscalRevenue / kategóriách /
    // topItems — bez nich si uzávierka protirečila: tržba stornovaný účet
    // odrátala, ale do počtu účtov (a tým do `averageOrder`) ho nechala, a po
    // prepnutí DKP zarátala aj účty druhej firmy.
    const [orderStats] = await db.select({
      totalOrders: sql`COUNT(*)`,
      cancelled: sql`COUNT(*) FILTER (WHERE ${orders.status} = 'cancelled')`,
    }).from(orders).where(
      sql`${inDay(orders.createdAt)}
        AND ${sql.raw(notStornoedOrderSql('orders'))}
        AND ${notForeignOrder}`
    );

    // Total items sold
    const [itemStats] = await db.select({
      totalItems: sql`COALESCE(SUM(${orderItems.qty}), 0)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      sql`${inDay(orders.createdAt)} AND ${orders.status} != 'cancelled'
        AND ${sql.raw(notStornoedOrderSql('orders'))}
        AND ${notForeignOrder}`
    );

    // Payment methods breakdown
    const methodStats = await db.select({
      method: payments.method,
      total: sql`SUM(${payments.amount}::numeric)`,
      count: sql`COUNT(*)`,
    }).from(payments).where(
      sql`${inDay(payments.createdAt)} AND ${sql.raw(notStornoedSql('payments'))} AND ${notForeignPayment}`
    ).groupBy(payments.method);

    // Fiskálna hotovosť z payments (potrebné samostatne pre Portos withdraw paragón —
    // Portos pokladňa nevie o shisha, takže výber môže odviezť LEN fiskálnu cash).
    // V API output ju exportujeme ako `cashFiscal`.
    let cashFiscal = 0;
    for (const m of methodStats) {
      const label = String(m.method || '').toLowerCase();
      if (label === 'hotovost' || label === 'cash') {
        cashFiscal = parseFloat(m.total) || 0;
        break;
      }
    }

    // Rozpad HOTOVOSTI podľa kódu pokladne. Toto je zdroj pravdy pre fiškálny
    // paragón výberu (server/lib/print/z-report.js) — v deň prepnutia firmy sa
    // NESMIE z novej pokladne vybrať hotovosť, ktorá do nej nikdy nevstúpila.
    // LEFT JOIN cez korelovaný sub-SELECT (nie JOIN), aby prípadné dva
    // predajné doklady na jednu platbu nezdvojili sumu. Prázdny kód = platba
    // bez fiškálneho dokladu (Portos vypnutý / offline paragón).
    const cashByRegisterRes = await db.execute(sql`
      SELECT
        COALESCE((
          SELECT TRIM(fd.cash_register_code)
          FROM fiscal_documents fd
          WHERE fd.payment_id = p.id AND fd.source_type = 'payment'
          ORDER BY fd.id DESC
          LIMIT 1
        ), '') AS crc,
        COALESCE(SUM(p.amount::numeric), 0)::float AS total,
        COUNT(*)::int AS count
      FROM payments p
      WHERE ${inDay(sql`p.created_at`)}
        AND ${sql.raw(notStornoedSql('p'))}
        AND lower(p.method) IN ('hotovost', 'cash')
      GROUP BY 1
      ORDER BY 1
    `);
    const cashFiscalByRegister = (cashByRegisterRes.rows || []).map((r) => ({
      cashRegisterCode: String(r.crc || ''),
      total: Math.round((Number(r.total) || 0) * 100) / 100,
      count: Number(r.count) || 0,
    }));
    // Viac než jeden NEPRÁZDNY kód za jeden deň = deň prepnutia firmy/pokladne.
    // Obsluha to musí vidieť — výber sa vtedy zúčtováva na dve pokladne.
    const mixedRegisters = cashFiscalByRegister
      .map(r => r.cashRegisterCode)
      .filter(code => code !== '');

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
    // Fiškálne stornovaný účet nie je predaj — bez tohto filtra ukazovala
    // uzávierka totalRevenue 0 €, ale kategórie stále plnú sumu.
    .where(
      sql`${inDay(orders.createdAt)} AND ${orders.status} != 'cancelled'
        AND ${sql.raw(notStornoedOrderSql('orders'))}
        AND ${notForeignOrder}`
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
      sql`${inDay(orders.createdAt)} AND ${orders.status} != 'cancelled'
        AND ${sql.raw(notStornoedOrderSql('orders'))}
        AND ${notForeignOrder}`
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
      sql`${inDay(orders.createdAt)} AND ${orders.status} = 'cancelled'`
    );

    // Shisha — internal off-fiscal counter for the same calendar day.
    const [shisha] = await db.select({
      count: sql`COUNT(*)`,
      revenue: sql`COALESCE(SUM(${shishaSales.price}::numeric), 0)`,
    }).from(shishaSales).where(
      inDayTz(shishaSales.soldAt)
    );
    const shishaCount = parseInt(shisha.count) || 0;
    const shishaRevenue = parseFloat(shisha.revenue) || 0;

    // ODPIS — predajna (cennikova) hodnota uctov uzavretych ako manazersky
    // odpis "na ucet podniku" (closure_type='odpis', cez /close-as-odpis).
    // Ziadna platba ani fiskal → nie je v platobnych metodach ani v zasuvke
    // (cashFiscal). Per rozhodnutie prevadzky sa vsak rata ako BEZNY PREDAJ:
    // item-statistiky (kategorie, top, pocet) ho UZ zahrnaju a folduje sa aj
    // do totalRevenue. Tu ho zratame samostatne, aby sme ho vedeli ukazat ako
    // informativny podiel "z toho odpis".
    const odpisRes = await db.execute(sql`
      SELECT
        COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS total,
        COUNT(DISTINCT o.id)::int AS count
      FROM orders o
      INNER JOIN order_items oi ON oi.order_id = o.id
      INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE ${inDay(sql`o.created_at`)}
        AND COALESCE(o.closure_type, 'paid') = 'odpis'
        AND ${sql.raw(notForeignCashRegisterOrderSql('o', filterCode))}
    `);
    const odpisTotal = Number(odpisRes.rows[0] && odpisRes.rows[0].total) || 0;
    const odpisCount = Number(odpisRes.rows[0] && odpisRes.rows[0].count) || 0;

    // Zamestnanecká spotreba podľa mena (= meno stola v zóne zamestnancov).
    // Konvencia: stoly v staff zóne sa volajú menami zamestnancov (Yevhen,
    // Tania, Oleh…), takže name stola = identita konzumenta. Split na
    // food (kuchyna) vs drinks (bar) cez menu_categories.dest. Reportuje
    // sa cez write_offs s reason='staff_meal' (zápis nastáva pri close-as-
    // staff-meal flow v js/pos-payments.js). Tá istá CTE štruktúra ako
    // v server/lib/reports/summary.js staffMealByPersonRows, len scope na
    // jeden deň namiesto pásu dní.
    const staffMealRows = await db.execute(sql`
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
          AND ${inDay(sql`wo.created_at`)}
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
    const staffMealByPerson = (staffMealRows.rows || staffMealRows).map((r) => ({
      name: r.person_name,
      meals: Number(r.meals) || 0,
      foodCost: Number(r.food_cost) || 0,
      drinkCost: Number(r.drink_cost) || 0,
      cost: Number(r.cost) || 0,
      menuValue: Number(r.menu_value) || 0,
    }));

    const fiscalRevenue = parseFloat(revenue.total);
    // Trzba = fiskalne platby + shisha + odpis (predaj na ucet podniku).
    // Odpis sa rata ako bezny predaj (rovnako ako v reports/summary). cashFiscal
    // ostava CISTO fiskalna (odpis nie je platba → nepatri do zasuvky).
    const totalRevenue = fiscalRevenue + shishaRevenue + odpisTotal;
    const totalOrders = parseInt(orderStats.totalOrders);
    const totalItems = parseInt(itemStats.totalItems);
    const averageOrder = totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0;

    // Hotovosť ostáva LEN fiškálna (z payments). Shisha cash sa vykazuje
    // v samostatnej SHISHA sekcii na tikete (data.shisha) — operátor presne
    // vidí čo má v zásuvke z hotovostných platieb a čo zo shisha predajov.
    res.json({
      date,
      // Rozsah, ktorý sa REÁLNE použil + aktívny kód pokladne. `scope='all'`
      // znamená, že čísla obsahujú aj tržby predchádzajúcich daňových
      // subjektov — NIE je to podklad pre uzávierku ani pre DPH.
      scope,
      cashRegisterCode,
      totalRevenue,
      fiscalRevenue,
      cashFiscal,
      // Rozpad fiškálnej hotovosti podľa kódu pokladne + aktívny kód, aby
      // tlač uzávierky vedela vybrať LEN vlastnú hotovosť (vlastný kód +
      // platby bez dokladu). `mixedRegisters` s viac než jedným kódom =
      // deň prepnutia firmy — treba zúčtovať na dve pokladne.
      cashFiscalByRegister,
      activeCashRegisterCode,
      mixedRegisters,
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
      odpisTotal,
      odpisCount,
      averageOrder,
      staffMealByPerson,
    });
  } catch (err) {
    console.error('Z-report error:', err);
    res.status(500).json({ error: 'Chyba pri generovani Z-reportu' });
  }
}

import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, menuItems, menuCategories, shishaSales } from '../../db/schema.js';

// GET /api/reports/z-report?date=2026-03-26
export async function zReportHandler(req, res) {
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
          AND wo.created_at >= ${fromDate} AND wo.created_at <= ${toDate}
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
    const totalRevenue = fiscalRevenue + shishaRevenue;
    const totalOrders = parseInt(orderStats.totalOrders);
    const totalItems = parseInt(itemStats.totalItems);
    const averageOrder = totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0;

    // Hotovosť ostáva LEN fiškálna (z payments). Shisha cash sa vykazuje
    // v samostatnej SHISHA sekcii na tikete (data.shisha) — operátor presne
    // vidí čo má v zásuvke z hotovostných platieb a čo zo shisha predajov.
    res.json({
      date,
      totalRevenue,
      fiscalRevenue,
      cashFiscal,
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
      staffMealByPerson,
    });
  } catch (err) {
    console.error('Z-report error:', err);
    res.status(500).json({ error: 'Chyba pri generovani Z-reportu' });
  }
}

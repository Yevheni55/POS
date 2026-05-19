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

    const fiscalRevenue = parseFloat(revenue.total);
    const totalRevenue = fiscalRevenue + shishaRevenue;
    const totalOrders = parseInt(orderStats.totalOrders);
    const totalItems = parseInt(itemStats.totalItems);
    const averageOrder = totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0;

    // Užívateľská logika: shisha sa predáva len v hotovosti, peniaze idú do
    // tej istej zásuvky ako fiškálna cash. Preto v Z-report payment methods
    // pripočítame shisha k Hotovosti — operátor potom vidí v "Hotovost" line
    // skutočný stav drawer-u a po odpočítaní terminálu nevychádza falošný
    // "tip". `cashFiscal` zostáva exportovaný separátne pre Portos withdrawal
    // logic (Portos pokladňa nevie o shisha — môže odpísať LEN fiskal cash).
    const mergedMethods = methodStats.map(m => ({
      method: m.method,
      total: parseFloat(m.total),
      count: parseInt(m.count),
    }));
    if (shishaRevenue > 0) {
      const hot = mergedMethods.find(m => {
        const l = String(m.method || '').toLowerCase();
        return l === 'hotovost' || l === 'cash';
      });
      if (hot) {
        hot.total = Math.round((hot.total + shishaRevenue) * 100) / 100;
        hot.count = hot.count + shishaCount;
      } else {
        mergedMethods.push({ method: 'hotovost', total: shishaRevenue, count: shishaCount });
      }
    }

    res.json({
      date,
      totalRevenue,
      fiscalRevenue,
      cashFiscal,
      totalOrders,
      totalItems,
      paymentMethods: mergedMethods,
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
}

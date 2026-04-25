import { Router } from 'express';
import { db } from '../db/index.js';
import { orders, orderItems, payments, menuItems, menuCategories, staff, shishaSales } from '../db/schema.js';
import { eq, sql, gte, lte, and, desc } from 'drizzle-orm';
import { allocateDiscountAcrossVatGroups } from '../lib/fiscal-payment.js';

const router = Router();

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// GET /api/reports/summary?from=2024-01-01&to=2024-12-31
// Default: single calendar day (today UTC) so "dashboard today" is not merged with yesterday.
router.get('/summary', async (req, res) => {
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const from = req.query.from || to;

  const fromDate = new Date(from);
  const toDate = new Date(to + 'T23:59:59');

  // Total revenue
  const [revenue] = await db.select({
    total: sql`COALESCE(SUM(${payments.amount}::numeric), 0)`,
    count: sql`COUNT(*)`,
  }).from(payments).where(
    and(gte(payments.createdAt, fromDate), sql`${payments.createdAt} <= ${toDate}`)
  );

  // Orders count
  const [orderStats] = await db.select({
    total: sql`COUNT(*)`,
    open: sql`COUNT(*) FILTER (WHERE ${orders.status} = 'open')`,
    closed: sql`COUNT(*) FILTER (WHERE ${orders.status} = 'closed')`,
  }).from(orders).where(
    and(gte(orders.createdAt, fromDate), sql`${orders.createdAt} <= ${toDate}`)
  );

  // Payment methods
  const methodStats = await db.select({
    method: payments.method,
    total: sql`SUM(${payments.amount}::numeric)`,
    count: sql`COUNT(*)`,
  }).from(payments).where(
    and(gte(payments.createdAt, fromDate), sql`${payments.createdAt} <= ${toDate}`)
  ).groupBy(payments.method);

  // Top items
  const topItems = await db.select({
    name: menuItems.name,
    emoji: menuItems.emoji,
    qty: sql`SUM(${orderItems.qty})`,
    revenue: sql`SUM(${orderItems.qty} * ${menuItems.price}::numeric)`,
  })
  .from(orderItems)
  .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
  .innerJoin(orders, eq(orderItems.orderId, orders.id))
  .where(and(gte(orders.createdAt, fromDate), sql`${orders.createdAt} <= ${toDate}`))
  .groupBy(menuItems.name, menuItems.emoji)
  .orderBy(desc(sql`SUM(${orderItems.qty})`))
  .limit(10);

  // Shisha — internal off-fiscal counter; rolled into the total so the dashboard
  // and weekly chart show real-world business revenue including shisha.
  const [shisha] = await db.select({
    count: sql`COUNT(*)`,
    revenue: sql`COALESCE(SUM(${shishaSales.price}::numeric), 0)`,
  }).from(shishaSales).where(
    and(gte(shishaSales.soldAt, fromDate), sql`${shishaSales.soldAt} <= ${toDate}`)
  );
  const shishaCount = parseInt(shisha.count) || 0;
  const shishaRevenue = parseFloat(shisha.revenue) || 0;
  const fiscalTotal = parseFloat(revenue.total) || 0;

  res.json({
    period: { from, to },
    revenue: { total: fiscalTotal + shishaRevenue, fiscal: fiscalTotal, payments: parseInt(revenue.count) },
    shisha: { count: shishaCount, revenue: shishaRevenue },
    orders: { total: parseInt(orderStats.total), open: parseInt(orderStats.open), closed: parseInt(orderStats.closed) },
    methods: methodStats.map(m => ({ method: m.method, total: parseFloat(m.total), count: parseInt(m.count) })),
    topItems: topItems.map(i => ({ ...i, qty: parseInt(i.qty), revenue: parseFloat(i.revenue) })),
  });
});

// GET /api/reports/z-report?date=2026-03-26
router.get('/z-report', async (req, res) => {
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
router.get('/export', async (req, res) => {
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
router.get('/staff', async (req, res) => {
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

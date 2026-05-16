import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, staff } from '../../db/schema.js';

// GET /api/reports/staff?from=&to=
export async function staffHandler(req, res) {
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
}

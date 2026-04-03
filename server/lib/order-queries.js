import { db } from '../db/index.js';
import { orderItems, menuItems, discounts } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';

/**
 * Enrich an array of order rows with items, discounts, and computed totals.
 * @param {Array} allOrders - Raw order rows from the database
 * @returns {Promise<Array>} Orders with items, discount info, total, and totalAfterDiscount
 */
export async function enrichOrders(allOrders) {
  if (!allOrders.length) return [];

  const orderIds = allOrders.map(o => o.id);
  const discountIds = [...new Set(allOrders.filter(o => o.discountId).map(o => o.discountId))];

  const [allItems, discountMap] = await Promise.all([
    db.select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      menuItemId: orderItems.menuItemId,
      qty: orderItems.qty,
      note: orderItems.note,
      sent: orderItems.sent,
      name: menuItems.name,
      emoji: menuItems.emoji,
      price: menuItems.price,
      desc: menuItems.desc,
    })
    .from(orderItems)
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(inArray(orderItems.orderId, orderIds)),
    (async () => {
      const map = {};
      if (discountIds.length) {
        const rows = await db.select().from(discounts).where(inArray(discounts.id, discountIds));
        rows.forEach(d => { map[d.id] = d; });
      }
      return map;
    })()
  ]);

  // Group items by orderId via Map for O(n) instead of O(n*m)
  const itemsByOrderId = new Map();
  for (const i of allItems) {
    const list = itemsByOrderId.get(i.orderId);
    const parsed = { ...i, price: parseFloat(i.price) };
    if (list) list.push(parsed);
    else itemsByOrderId.set(i.orderId, [parsed]);
  }

  return allOrders.map(order => {
    const items = itemsByOrderId.get(order.id) || [];
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const discountAmount = order.discountAmount ? parseFloat(order.discountAmount) : 0;
    const disc = order.discountId ? discountMap[order.discountId] : null;
    return {
      ...order,
      discountAmount: discountAmount || null,
      discount: disc ? { id: disc.id, name: disc.name, type: disc.type, value: parseFloat(disc.value), amount: discountAmount } : null,
      total: subtotal,
      totalAfterDiscount: subtotal - discountAmount,
      items,
    };
  });
}

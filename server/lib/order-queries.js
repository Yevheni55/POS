import { db } from '../db/index.js';
import { orderItems, menuItems, menuCategories, discounts } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { lineDiscountAmount, roundMoney } from './payments/shared.js';

/**
 * Enrich an array of order rows with items, discounts, and computed totals.
 * @param {Array} allOrders - Raw order rows from the database
 * @returns {Promise<Array>} Orders with items, discount info, total, and totalAfterDiscount
 */
export async function enrichOrders(allOrders) {
  if (!allOrders.length) return [];

  const orderIds = allOrders.map(o => o.id);

  const allItems = await db.select({
    id: orderItems.id,
    orderId: orderItems.orderId,
    menuItemId: orderItems.menuItemId,
    qty: orderItems.qty,
    note: orderItems.note,
    sent: orderItems.sent,
    discountId: orderItems.discountId,
    discountType: orderItems.discountType,
    discountValue: orderItems.discountValue,
    name: menuItems.name,
    emoji: menuItems.emoji,
    price: menuItems.price,
    desc: menuItems.desc,
    // Cieľ tlače: prednosť má override na položke, inak dest kategórie.
    // Potrebuje to kuchynská obrazovka (kitchen.html), aby vedela oddeliť
    // kuchyňu od baru — dovtedy túto informáciu cez API vôbec nedostala.
    destOverride: menuItems.destOverride,
    categoryDest: menuCategories.dest,
  })
  .from(orderItems)
  .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
  .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
  .where(inArray(orderItems.orderId, orderIds));

  // Resolve discount catalog rows referenced by either the order OR a line item.
  const discountIds = [...new Set([
    ...allOrders.filter(o => o.discountId).map(o => o.discountId),
    ...allItems.filter(i => i.discountId).map(i => i.discountId),
  ])];
  const discountMap = {};
  if (discountIds.length) {
    const rows = await db.select().from(discounts).where(inArray(discounts.id, discountIds));
    rows.forEach(d => { discountMap[d.id] = d; });
  }

  // Group items by orderId via Map for O(n) instead of O(n*m). Each line gets
  // its realized euro discount derived live from the current menu price.
  const itemsByOrderId = new Map();
  for (const i of allItems) {
    const price = parseFloat(i.price);
    const discValue = i.discountValue == null ? null : parseFloat(i.discountValue);
    const itemDiscountAmount = i.discountType && discValue
      ? lineDiscountAmount(price, i.qty, i.discountType, discValue)
      : 0;
    const itemDisc = i.discountId ? discountMap[i.discountId] : null;
    const parsed = {
      ...i,
      price,
      discountValue: discValue,
      discountAmount: itemDiscountAmount || null,
      discountName: itemDisc ? itemDisc.name : null,
      dest: i.destOverride || i.categoryDest || 'bar',
    };
    // Pomocné stĺpce von z odpovede — von ide už len vyhodnotený `dest`.
    delete parsed.destOverride;
    delete parsed.categoryDest;
    const list = itemsByOrderId.get(i.orderId);
    if (list) list.push(parsed);
    else itemsByOrderId.set(i.orderId, [parsed]);
  }

  return allOrders.map(order => {
    const items = itemsByOrderId.get(order.id) || [];
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const itemDiscountTotal = roundMoney(items.reduce((s, i) => s + (i.discountAmount || 0), 0));
    const discountAmount = order.discountAmount ? parseFloat(order.discountAmount) : 0;
    const disc = order.discountId ? discountMap[order.discountId] : null;
    const totalAfterDiscount = Math.max(0, roundMoney(subtotal - discountAmount - itemDiscountTotal));
    return {
      ...order,
      discountAmount: discountAmount || null,
      discount: disc ? { id: disc.id, name: disc.name, type: disc.type, value: parseFloat(disc.value), amount: discountAmount } : null,
      itemDiscountTotal: itemDiscountTotal || null,
      total: subtotal,
      totalAfterDiscount,
      items,
    };
  });
}

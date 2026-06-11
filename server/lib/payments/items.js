import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { menuItems, orderItems, orders, payments, tables } from '../../db/schema.js';

/**
 * GET /api/payments/:id/items — položky dokladu pre admin Históriu platieb.
 *
 * Pozn.: order_items NEMÁ cenový snapshot — ceny sa čítajú z aktuálneho
 * menu (leftJoin; zmazaná položka => name fallback). Pri zmene cien po
 * platbe sa preto súčet položiek môže líšiť od sumy dokladu; autoritatívna
 * je VŽDY payments.amount (klient rozdiel priznáva, nie maskuje).
 */
export async function paymentItemsHandler(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Neplatné id platby' });
  }

  const [pay] = await db
    .select({
      paymentId: payments.id,
      orderId: payments.orderId,
      amount: payments.amount,
      method: payments.method,
      createdAt: payments.createdAt,
      orderLabel: orders.label,
      discountAmount: orders.discountAmount,
      tableName: tables.name,
    })
    .from(payments)
    .leftJoin(orders, eq(payments.orderId, orders.id))
    .leftJoin(tables, eq(orders.tableId, tables.id))
    .where(eq(payments.id, id))
    .limit(1);

  if (!pay) return res.status(404).json({ error: 'Platba nenájdená' });

  const rows = pay.orderId
    ? await db
      .select({
        itemId: orderItems.id,
        menuItemId: orderItems.menuItemId,
        qty: orderItems.qty,
        note: orderItems.note,
        name: menuItems.name,
        emoji: menuItems.emoji,
        price: menuItems.price,
      })
      .from(orderItems)
      .leftJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
      .where(eq(orderItems.orderId, pay.orderId))
      .orderBy(orderItems.id)
    : [];

  let itemsTotal = 0;
  let priceMissing = false;
  const items = rows.map((r) => {
    const price = r.price == null ? null : Number(r.price);
    const lineTotal = price == null ? null : Math.round(price * r.qty * 100) / 100;
    if (lineTotal == null) priceMissing = true;
    else itemsTotal += lineTotal;
    return {
      menuItemId: r.menuItemId,
      name: r.name || `Položka #${r.menuItemId}`,
      emoji: r.emoji || '',
      qty: r.qty,
      note: r.note || '',
      price,
      lineTotal,
    };
  });

  res.json({
    paymentId: pay.paymentId,
    orderId: pay.orderId,
    orderLabel: pay.orderLabel,
    tableName: pay.tableName,
    method: pay.method,
    amount: pay.amount == null ? null : Number(pay.amount),
    discountAmount: pay.discountAmount == null ? null : Number(pay.discountAmount),
    createdAt: pay.createdAt ? new Date(pay.createdAt).toISOString() : null,
    items,
    itemsTotal: Math.round(itemsTotal * 100) / 100,
    priceMissing,
    priceSource: 'menu_current',
  });
}

import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { menuItems, orderItems, orders, payments, tables } from '../../db/schema.js';
import { logEvent } from '../audit.js';
import { roundMoney } from './shared.js';
import {
  buildFiscalDocumentValues,
  selectSaleFiscalDocumentForOrder,
  upsertFiscalDocument,
} from './fiscal-document.js';

export async function loadExistingPaymentSnapshot(orderId) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return { order: null, payment: null, fiscalDocument: null };

  const [payment] = await db.select().from(payments).where(eq(payments.orderId, orderId));
  const fiscalDocument = await selectSaleFiscalDocumentForOrder(db, orderId);

  return { order, payment, fiscalDocument };
}

export async function loadOrderPaymentContext(orderId) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;

  const items = await db.select({
    orderItemId: orderItems.id,
    menuItemId: menuItems.id,
    name: menuItems.name,
    qty: orderItems.qty,
    price: menuItems.price,
    vatRate: menuItems.vatRate,
  })
    .from(orderItems)
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(eq(orderItems.orderId, orderId));

  const normalizedItems = items.map((item) => ({
    ...item,
    qty: Number(item.qty),
    price: Number(item.price),
    vatRate: Number(item.vatRate),
  }));

  const subtotal = roundMoney(normalizedItems.reduce((sum, item) => sum + (item.price * item.qty), 0));
  const discountAmount = roundMoney(order.discountAmount ? Number(order.discountAmount) : 0);
  const expectedTotal = roundMoney(subtotal - discountAmount);

  return {
    order,
    items: normalizedItems,
    subtotal,
    discountAmount,
    expectedTotal,
  };
}

export async function finalizeLocalPayment({ orderContext, method, amount, fiscalOutcome, requestPayload, staffId }) {
  return db.transaction(async (tx) => {
    const [existingPayment] = await tx.select().from(payments).where(eq(payments.orderId, orderContext.order.id));
    if (existingPayment) {
      const [existingOrder] = await tx.select().from(orders).where(eq(orders.id, orderContext.order.id));
      const existingFiscalDocument = await selectSaleFiscalDocumentForOrder(tx, orderContext.order.id);

      return {
        created: false,
        payment: existingPayment,
        order: existingOrder,
        fiscalDocument: existingFiscalDocument,
      };
    }

    const [closedOrder] = await tx.update(orders)
      .set({ status: 'closed', closedAt: new Date() })
      .where(and(eq(orders.id, orderContext.order.id), eq(orders.status, 'open')))
      .returning();

    if (!closedOrder) {
      const [currentOrder] = await tx.select().from(orders).where(eq(orders.id, orderContext.order.id));
      const [paymentAfterClose] = await tx.select().from(payments).where(eq(payments.orderId, orderContext.order.id));
      const fiscalAfterClose = await selectSaleFiscalDocumentForOrder(tx, orderContext.order.id);

      if (paymentAfterClose) {
        return {
          created: false,
          payment: paymentAfterClose,
          order: currentOrder,
          fiscalDocument: fiscalAfterClose,
        };
      }

      throw new Error(currentOrder ? 'Order is not open' : 'Order not found');
    }

    const [payment] = await tx.insert(payments).values({
      orderId: orderContext.order.id,
      method,
      amount: String(amount),
    }).returning();

    let fiscalDocument = null;
    if (requestPayload && fiscalOutcome) {
      fiscalDocument = await upsertFiscalDocument(tx, buildFiscalDocumentValues({
        orderId: orderContext.order.id,
        paymentId: payment.id,
        requestPayload,
        outcome: fiscalOutcome,
      }));
    }

    await logEvent(tx, {
      orderId: orderContext.order.id,
      type: 'payment_received',
      payload: { method, amount, fiscalStatus: fiscalDocument?.resultMode || null },
      staffId,
    });

    const remaining = await tx.select().from(orders)
      .where(and(eq(orders.tableId, closedOrder.tableId), eq(orders.status, 'open')));

    if (!remaining.length) {
      await tx.update(tables).set({ status: 'free' }).where(eq(tables.id, closedOrder.tableId));
    }

    return {
      created: true,
      payment,
      order: closedOrder,
      fiscalDocument,
    };
  });
}

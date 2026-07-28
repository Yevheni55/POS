import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { menuItems, orderItems, orders, payments, tables } from '../../db/schema.js';
import { logEvent } from '../audit.js';
import { lineDiscountAmount, roundMoney } from './shared.js';
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
    discountType: orderItems.discountType,
    discountValue: orderItems.discountValue,
  })
    .from(orderItems)
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(eq(orderItems.orderId, orderId));

  // Each line's euro discount is derived live from the current menu price
  // (no price snapshot on order_items). discountAmount is attached to the item
  // so the fiscal builder can emit a per-item negative discount line.
  const normalizedItems = items.map((item) => {
    const qty = Number(item.qty);
    const price = Number(item.price);
    const discountValue = item.discountValue == null ? null : Number(item.discountValue);
    const discountAmount = item.discountType && discountValue
      ? lineDiscountAmount(price, qty, item.discountType, discountValue)
      : 0;
    return {
      ...item,
      qty,
      price,
      vatRate: Number(item.vatRate),
      discountAmount,
    };
  });

  const subtotal = roundMoney(normalizedItems.reduce((sum, item) => sum + (item.price * item.qty), 0));
  // Per-item discounts are each capped at their own line → itemDiscountTotal ≤ subtotal.
  const itemDiscountTotal = roundMoney(normalizedItems.reduce((sum, item) => sum + (item.discountAmount || 0), 0));
  const rawOrderDiscount = roundMoney(order.discountAmount ? Number(order.discountAmount) : 0);
  // Order-level discount was frozen against the gross subtotal; item discounts
  // come on top. Clamp the order-level portion so order + item discounts never
  // exceed the subtotal — otherwise the fiscal line sum would go negative while
  // expectedTotal floors at 0, and Portos rejects on amount mismatch.
  const orderDiscountAmount = Math.min(rawOrderDiscount, Math.max(0, roundMoney(subtotal - itemDiscountTotal)));
  const discountAmount = roundMoney(itemDiscountTotal + orderDiscountAmount);
  const expectedTotal = roundMoney(subtotal - discountAmount);

  return {
    order,
    items: normalizedItems,
    subtotal,
    // discountAmount = TOTAL discount (order-level + per-item) used for the
    // payment guard / expectedTotal. orderDiscountAmount is the (clamped)
    // order-level portion only — the fiscal builder needs them split: per-item
    // discounts are emitted as their own lines (items[].discountAmount), the
    // order-level portion is allocated across VAT groups.
    discountAmount,
    orderDiscountAmount,
    itemDiscountTotal,
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

    // POZN. pre majiteľa (vedomé rozhodnutie, NEmeniť bez rozhodnutia):
    // `payments.amount` je ZÁMERNE suma, ktorú poslal klient — teda „koľko
    // hosť podal", nie „koľko bol účet". Pripína sa na to test
    // server/test/routes/payments.test.js:345 („accepts overpayment and stores
    // the tendered amount"). Fiškálny doklad sa pritom razí zo serverového
    // `orderContext.expectedTotal`.
    // Kým web POS posiela `amount: getOrderTotal()` (js/pos-payments.js), obe
    // hodnoty sedia a rozdiel nevzniká. Ak by však niektorý klient (Android)
    // niekedy poslal skutočnú podanú hotovosť, tržba v reportoch by o vydanú
    // sumu NARÁSTLA oproti súčtu eKasa dokladov. Ak sa to má riešiť, treba to
    // rozhodnúť ako produktovú otázku (samostatný stĺpec `tendered_amount`),
    // nie tichou zmenou významu tohto stĺpca.
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

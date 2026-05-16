import { and, desc, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, orders, payments, tables } from '../../db/schema.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { isPortosEnabled } from '../portos.js';

import { STORNO_ELIGIBLE_MODES } from './shared.js';

// SECURITY FIX: was unprotected — any authenticated cisnik could enumerate
// the entire payment history (sums, methods, table assignments). Now
// manazer/admin only — the cashier doesn't need to browse other people's
// historical receipts to do their job; for current-shift questions there
// are dedicated per-order views.
export async function historyHandler(req, res) {
  const parseLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(parseLimit) && parseLimit > 0 ? Math.min(parseLimit, 500) : 100;

  const method = String(req.query.method || '').trim();
  const q = String(req.query.q || '').trim();
  const scope = String(req.query.scope || 'current').trim().toLowerCase();
  const activeCashRegisterCode = await getActiveCashRegisterCode();

  const conditions = [];
  if (method === 'hotovost' || method === 'karta') {
    conditions.push(eq(payments.method, method));
  }

  const joined = await db
    .select({
      id: payments.id,
      orderId: payments.orderId,
      method: payments.method,
      amount: payments.amount,
      createdAt: payments.createdAt,
      orderStatus: orders.status,
      orderLabel: orders.label,
      tableId: orders.tableId,
      tableName: tables.name,
    })
    .from(payments)
    .leftJoin(orders, eq(payments.orderId, orders.id))
    .leftJoin(tables, eq(orders.tableId, tables.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(payments.id))
    .limit(limit);

  const filteredByQuery = q
    ? joined.filter((row) => {
      const hay = [row.orderLabel, row.tableName, String(row.id), String(row.orderId)]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return hay.some((value) => value.includes(q.toLowerCase()));
    })
    : joined;

  const paymentIds = filteredByQuery.map((row) => row.id);
  const orderIds = Array.from(new Set(filteredByQuery.map((row) => row.orderId)));

  const docs = paymentIds.length
    ? await db
      .select()
      .from(fiscalDocuments)
      .where(inArray(fiscalDocuments.paymentId, paymentIds))
    : [];

  const docsByPaymentId = new Map();
  for (const doc of docs) {
    const list = docsByPaymentId.get(doc.paymentId) || [];
    list.push(doc);
    docsByPaymentId.set(doc.paymentId, list);
  }

  const mappedItems = filteredByQuery.map((row) => {
    const related = docsByPaymentId.get(row.id) || [];
    // sourceType is the source of truth — externalId formát sa zmenil
    // (legacy `order-N-payment` vs nový `order-N-pay-<salt>`) a dvojitý
    // formátový lookup by mohol minúť doc od starej eKasy.
    const saleDoc = related.find((d) => d.sourceType === 'payment') || null;
    const stornoDoc = related.find((d) => d.sourceType === 'storno') || null;

    const referenceReceiptId = saleDoc ? saleDoc.receiptId || saleDoc.okp : null;
    const stornoEligible = Boolean(
      isPortosEnabled() && saleDoc && STORNO_ELIGIBLE_MODES.has(saleDoc.resultMode) && referenceReceiptId && !stornoDoc,
    );

    return {
      id: row.id,
      orderId: row.orderId,
      orderLabel: row.orderLabel,
      orderStatus: row.orderStatus,
      tableId: row.tableId,
      tableName: row.tableName,
      method: row.method,
      amount: row.amount == null ? null : Number(row.amount),
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      fiscal: saleDoc ? {
        externalId: saleDoc.externalId,
        status: saleDoc.resultMode,
        receiptId: saleDoc.receiptId,
        receiptNumber: saleDoc.receiptNumber,
        okp: saleDoc.okp,
        cashRegisterCode: saleDoc.cashRegisterCode,
        processDate: saleDoc.processDate ? new Date(saleDoc.processDate).toISOString() : null,
      } : null,
      storno: stornoDoc ? {
        externalId: stornoDoc.externalId,
        status: stornoDoc.resultMode,
        receiptId: stornoDoc.receiptId,
        receiptNumber: stornoDoc.receiptNumber,
        okp: stornoDoc.okp,
        processDate: stornoDoc.processDate ? new Date(stornoDoc.processDate).toISOString() : null,
      } : null,
      stornoEligible,
      copyAvailable: Boolean(saleDoc && saleDoc.externalId),
    };
  });

  // Po zmene firmy/eKasa v Portos (iný cashRegisterCode) skryjeme staré platby z inej kasy,
  // ak klient nevyžiada `scope=all`. Platby bez fiškálneho dokladu zostávajú vždy viditeľné.
  const items = scope === 'all' || !activeCashRegisterCode
    ? mappedItems
    : mappedItems.filter((item) => {
      if (!item.fiscal) return true;
      return String(item.fiscal.cashRegisterCode || '').trim() === activeCashRegisterCode;
    });

  const hiddenByScope = mappedItems.length - items.length;

  res.json({
    items,
    totalOrders: orderIds.length,
    scope: scope === 'all' ? 'all' : 'current',
    activeCashRegisterCode,
    hiddenByScope,
  });
}

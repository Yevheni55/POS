import { and, desc, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, orders, payments, tables } from '../../db/schema.js';
import {
  buildPaymentStornoExternalId,
  parsePaymentExternalIdSalt,
} from '../fiscal-payment.js';
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
    // Storno musí patriť PRÁVE TOMUTO predajnému dokladu. Po `change-method`
    // ostáva na platbe aj starý (vystornovaný) doklad ako 'payment_superseded'
    // — jeho storno nesmie zhasnúť tlačidlo pri novom, platnom doklade.
    // Fallback na `sourceType` je pre staré riadky s odlišným formátom
    // externalId, ale len keď žiadny superseded doklad neexistuje.
    const expectedStornoExternalId = saleDoc
      ? buildPaymentStornoExternalId(row.orderId, { salt: parsePaymentExternalIdSalt(saleDoc.externalId) })
      : null;
    const stornoDoc = (expectedStornoExternalId
      && related.find((d) => d.sourceType === 'storno' && d.externalId === expectedStornoExternalId))
      || (related.some((d) => d.sourceType === 'payment_superseded')
        ? null
        : related.find((d) => d.sourceType === 'storno'))
      || null;

    const referenceReceiptId = saleDoc ? saleDoc.receiptId || saleDoc.okp : null;
    // Doklad z PREDCHÁDZAJÚCEJ identity (iný kód pokladne / DKP) sa už nedá
    // stornovať — Portos ten alias nepozná. UI má zobraziť disabled stav
    // s vysvetlením namiesto tlačidla, ktoré vždy skončí chybou certifikátu.
    const docCashRegisterCode = saleDoc ? String(saleDoc.cashRegisterCode || '').trim() : '';
    const foreignCashRegister = Boolean(
      docCashRegisterCode && activeCashRegisterCode && docCashRegisterCode !== activeCashRegisterCode,
    );
    const stornoEligible = Boolean(
      isPortosEnabled() && saleDoc && STORNO_ELIGIBLE_MODES.has(saleDoc.resultMode)
      && referenceReceiptId && !stornoDoc && !foreignCashRegister,
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
      // 'foreign_cash_register' = jediný dôvod, ktorý UI vie vysvetliť textom;
      // ostatné (už stornované / nevhodný resultMode) sa dajú odvodiť z payloadu.
      stornoBlockedReason: !stornoEligible && foreignCashRegister ? 'foreign_cash_register' : null,
      cashRegisterCode: docCashRegisterCode || null,
      // Dotlač kópie necháme povolenú aj pre cudzí kód — Portos môže mať
      // certifikát pre starý alias ešte nahraný; UI nech na to upozorní.
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

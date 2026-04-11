import { Router } from 'express';
import { and, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { requireRole } from '../middleware/requireRole.js';
import {
  fiscalDocuments,
  menuItems,
  orderItems,
  orders,
  payments,
  tables,
} from '../db/schema.js';
import { logEvent } from '../lib/audit.js';
import {
  buildCashRegisterRequestContext,
  buildPaymentExternalId,
  buildPaymentStornoExternalId,
  buildStornoCashRegisterRequestContext,
} from '../lib/fiscal-payment.js';
import { emitEvent } from '../lib/emit.js';
import { formatSupportedVatRates, isSupportedVatRate } from '../lib/menu-vat.js';
import {
  findReceiptByExternalId,
  isPortosEnabled,
  PortosTransportError,
  printCopyByExternalId,
  registerCashReceipt,
} from '../lib/portos.js';
import { validate } from '../middleware/validate.js';
import { createPaymentSchema } from '../schemas/payments.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

const STORNO_ELIGIBLE_MODES = new Set([
  'online_success',
  'offline_accepted',
  'reconciled_online_success',
  'reconciled_offline_accepted',
]);

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseJsonField(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildFiscalDocumentValues({ orderId, paymentId = null, requestPayload, outcome, sourceType = 'payment' }) {
  return {
    sourceType,
    sourceId: orderId,
    orderId,
    paymentId,
    externalId: requestPayload.request.externalId,
    cashRegisterCode: requestPayload.request.data.cashRegisterCode,
    requestType: requestPayload.request.data.receiptType,
    httpStatus: outcome.httpStatus,
    resultMode: outcome.resultMode,
    isSuccessful: outcome.isSuccessful,
    receiptId: outcome.receiptId,
    receiptNumber: outcome.receiptNumber,
    okp: outcome.okp,
    portosRequestId: outcome.portosRequestId,
    printerName: requestPayload.print?.printerName || null,
    processDate: toDateOrNull(outcome.processDate),
    requestJson: outcome.requestJson || JSON.stringify(requestPayload),
    responseJson: outcome.responseJson || '{}',
    errorCode: outcome.errorCode,
    errorDetail: outcome.errorDetail || '',
    updatedAt: new Date(),
  };
}

async function upsertFiscalDocument(txOrDb, values) {
  const [document] = await txOrDb.insert(fiscalDocuments)
    .values(values)
    .onConflictDoUpdate({
      target: fiscalDocuments.externalId,
      set: {
        sourceType: values.sourceType,
        sourceId: values.sourceId,
        orderId: values.orderId,
        paymentId: values.paymentId,
        cashRegisterCode: values.cashRegisterCode,
        requestType: values.requestType,
        httpStatus: values.httpStatus,
        resultMode: values.resultMode,
        isSuccessful: values.isSuccessful,
        receiptId: values.receiptId,
        receiptNumber: values.receiptNumber,
        okp: values.okp,
        portosRequestId: values.portosRequestId,
        printerName: values.printerName,
        processDate: values.processDate,
        requestJson: values.requestJson,
        responseJson: values.responseJson,
        errorCode: values.errorCode,
        errorDetail: values.errorDetail,
        updatedAt: new Date(),
      },
    })
    .returning();

  return document;
}

function toFiscalResponse(document) {
  if (!document) return { status: 'disabled', copyAvailable: false };

  return {
    status: document.resultMode,
    externalId: document.externalId,
    httpStatus: document.httpStatus,
    isSuccessful: document.isSuccessful,
    receiptId: document.receiptId,
    receiptNumber: document.receiptNumber,
    okp: document.okp,
    portosRequestId: document.portosRequestId,
    printerName: document.printerName,
    processDate: document.processDate ? new Date(document.processDate).toISOString() : null,
    errorCode: document.errorCode,
    errorDetail: document.errorDetail,
    copyAvailable: Boolean(document.externalId),
  };
}

async function loadExistingPaymentSnapshot(orderId) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return { order: null, payment: null, fiscalDocument: null };

  const [payment] = await db.select().from(payments).where(eq(payments.orderId, orderId));
  const [fiscalDocument] = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.orderId, orderId));

  return { order, payment, fiscalDocument };
}

async function loadOrderPaymentContext(orderId) {
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

async function finalizeLocalPayment({ orderContext, method, amount, fiscalOutcome, requestPayload, staffId }) {
  return db.transaction(async (tx) => {
    const [existingPayment] = await tx.select().from(payments).where(eq(payments.orderId, orderContext.order.id));
    if (existingPayment) {
      const [existingOrder] = await tx.select().from(orders).where(eq(orders.id, orderContext.order.id));
      const [existingFiscalDocument] = await tx.select().from(fiscalDocuments).where(eq(fiscalDocuments.orderId, orderContext.order.id));

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
      const [fiscalAfterClose] = await tx.select().from(fiscalDocuments).where(eq(fiscalDocuments.orderId, orderContext.order.id));

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

async function resolveFiscalAttempt({ requestPayload, initialOutcome }) {
  const externalId = requestPayload.request.externalId;

  if (initialOutcome.httpStatus === 200 || initialOutcome.httpStatus === 202) {
    return initialOutcome;
  }

  if (initialOutcome.httpStatus === 400 || initialOutcome.httpStatus === 403) {
    return initialOutcome;
  }

  try {
    const existingReceipt = await findReceiptByExternalId(externalId);
    if (!existingReceipt) {
      return {
        ...initialOutcome,
        resultMode: 'ambiguous',
      };
    }

    let copyPrinted = false;
    if (initialOutcome.errorCode === -502) {
      try {
        const copyResult = await printCopyByExternalId(externalId);
        copyPrinted = Boolean(copyResult.printed);
      } catch {
        copyPrinted = false;
      }
    }

    return {
      ...initialOutcome,
      resultMode: existingReceipt.isSuccessful === null
        ? 'reconciled_offline_accepted'
        : 'reconciled_online_success',
      isSuccessful: existingReceipt.isSuccessful,
      receiptId: existingReceipt.receiptId,
      receiptNumber: existingReceipt.receiptNumber,
      okp: existingReceipt.okp,
      portosRequestId: existingReceipt.portosRequestId || initialOutcome.portosRequestId,
      processDate: existingReceipt.processDate,
      responseJson: existingReceipt.responseJson,
      copyPrinted,
    };
  } catch (lookupError) {
    return {
      ...initialOutcome,
      resultMode: 'ambiguous',
      errorDetail: initialOutcome.errorDetail || lookupError.message,
    };
  }
}

function buildTransportFailure(requestPayload, error) {
  return {
    httpStatus: null,
    resultMode: 'ambiguous',
    isSuccessful: null,
    receiptId: null,
    receiptNumber: null,
    okp: null,
    portosRequestId: null,
    processDate: null,
    errorCode: null,
    errorDetail: error.message,
    requestJson: JSON.stringify(requestPayload),
    responseJson: JSON.stringify({ error: error.message }),
  };
}

router.post('/', validate(createPaymentSchema), async (req, res) => {
  const { orderId, method, amount } = req.body;

  const orderContext = await loadOrderPaymentContext(orderId);
  if (!orderContext) {
    return res.status(404).json({ error: 'Objednavka nenajdena' });
  }

  if (orderContext.order.status !== 'open') {
    const existing = await loadExistingPaymentSnapshot(orderId);
    if (existing.order && existing.payment) {
      return res.status(200).json({
        payment: existing.payment,
        order: existing.order,
        fiscal: toFiscalResponse(existing.fiscalDocument),
        alreadyProcessed: true,
      });
    }
    return res.status(400).json({ error: 'Objednavka uz nie je otvorena' });
  }

  if (amount < orderContext.expectedTotal - 0.01) {
    return res.status(400).json({
      error: `Suma platby (${amount}) je mensia ako celkova suma objednavky (${orderContext.expectedTotal})`,
    });
  }

  if (!isPortosEnabled()) {
    try {
      const result = await finalizeLocalPayment({
        orderContext,
        method,
        amount,
        fiscalOutcome: null,
        requestPayload: null,
        staffId: req.user.id,
      });

      if (result.created) {
        emitEvent(req, 'payment:created', { orderId, tableId: result.order.tableId });
      }

      return res.status(result.created ? 201 : 200).json({
        payment: result.payment,
        order: result.order,
        fiscal: { status: 'disabled', copyAvailable: false },
        alreadyProcessed: !result.created,
      });
    } catch (error) {
      console.error('Legacy payment error:', error);
      return res.status(500).json({ error: 'Platba zlyhala' });
    }
  }

  const unsupportedVatItems = orderContext.items.filter((item) => !isSupportedVatRate(item.vatRate));
  if (unsupportedVatItems.length) {
    const itemList = unsupportedVatItems
      .map((item) => `${item.name} (${Number(item.vatRate).toFixed(2)}%)`)
      .join(', ');
    const errorDetail = `Portos podporuje iba sadzby DPH ${formatSupportedVatRates()}. Skontroluj polozky: ${itemList}`;

    return res.status(400).json({
      error: errorDetail,
      fiscal: {
        status: 'validation_error',
        errorDetail,
      },
    });
  }

  const requestPayload = buildCashRegisterRequestContext({
    orderId,
    items: orderContext.items,
    discountAmount: orderContext.discountAmount,
    method,
    expectedTotal: orderContext.expectedTotal,
  });

  let fiscalOutcome;
  try {
    const initialOutcome = await registerCashReceipt(requestPayload);
    fiscalOutcome = await resolveFiscalAttempt({ requestPayload, initialOutcome });
  } catch (error) {
    if (!(error instanceof PortosTransportError)) {
      console.error('Unexpected Portos payment error:', error);
    }
    fiscalOutcome = await resolveFiscalAttempt({
      requestPayload,
      initialOutcome: buildTransportFailure(requestPayload, error instanceof Error ? error : new Error(String(error))),
    });
  }

  if (fiscalOutcome.resultMode === 'validation_error' || fiscalOutcome.resultMode === 'rejected') {
    await upsertFiscalDocument(db, buildFiscalDocumentValues({
      orderId,
      requestPayload,
      outcome: fiscalOutcome,
    }));

    return res.status(fiscalOutcome.httpStatus || 400).json({
      error: fiscalOutcome.errorDetail || 'Fiskalizacia bola odmietnuta',
      fiscal: {
        status: fiscalOutcome.resultMode,
        externalId: requestPayload.request.externalId,
        errorCode: fiscalOutcome.errorCode,
        errorDetail: fiscalOutcome.errorDetail,
      },
    });
  }

  if (
    fiscalOutcome.resultMode !== 'online_success' &&
    fiscalOutcome.resultMode !== 'offline_accepted' &&
    fiscalOutcome.resultMode !== 'reconciled_online_success' &&
    fiscalOutcome.resultMode !== 'reconciled_offline_accepted'
  ) {
    await upsertFiscalDocument(db, buildFiscalDocumentValues({
      orderId,
      requestPayload,
      outcome: fiscalOutcome,
    }));

    return res.status(503).json({
      error: fiscalOutcome.errorDetail || 'Fiskalizacia vyzaduje kontrolu',
      fiscal: {
        status: fiscalOutcome.resultMode,
        externalId: requestPayload.request.externalId,
        errorCode: fiscalOutcome.errorCode,
        errorDetail: fiscalOutcome.errorDetail,
      },
    });
  }

  try {
    const result = await finalizeLocalPayment({
      orderContext,
      method,
      amount,
      fiscalOutcome,
      requestPayload,
      staffId: req.user.id,
    });

    if (result.created) {
      emitEvent(req, 'payment:created', { orderId, tableId: result.order.tableId });
    }

    return res.status(result.created ? 201 : 200).json({
      payment: result.payment,
      order: result.order,
      fiscal: toFiscalResponse(result.fiscalDocument),
      alreadyProcessed: !result.created,
    });
  } catch (error) {
    if (error.message === 'Order not found') {
      return res.status(404).json({ error: 'Objednavka nenajdena' });
    }
    if (error.message === 'Order is not open') {
      const existing = await loadExistingPaymentSnapshot(orderId);
      if (existing.payment) {
        return res.status(200).json({
          payment: existing.payment,
          order: existing.order,
          fiscal: toFiscalResponse(existing.fiscalDocument),
          alreadyProcessed: true,
        });
      }
      return res.status(400).json({ error: 'Objednavka uz nie je otvorena' });
    }

    console.error('Payment finalize error:', error);
    return res.status(500).json({ error: 'Platba zlyhala' });
  }
});

router.get('/:id/fiscal', async (req, res) => {
  const paymentId = Number.parseInt(req.params.id, 10);
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });

  const docs = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.paymentId, paymentId));
  if (!docs.length) return res.status(404).json({ error: 'Fiskalny doklad nenajdeny' });

  const saleExternalId = buildPaymentExternalId(payment.orderId);
  const stornoExternalId = buildPaymentStornoExternalId(payment.orderId);
  const document = docs.find((d) => d.externalId === saleExternalId) || docs[0];
  const stornoRow = docs.find((d) => d.externalId === stornoExternalId);

  const referenceReceiptId = document.receiptId || document.okp;
  const stornoEligible = Boolean(
    isPortosEnabled()
    && STORNO_ELIGIBLE_MODES.has(document.resultMode)
    && referenceReceiptId
    && !stornoRow,
  );

  res.json({
    ...document,
    processDate: document.processDate ? new Date(document.processDate).toISOString() : null,
    requestJson: parseJsonField(document.requestJson),
    responseJson: parseJsonField(document.responseJson),
    stornoEligible,
    stornoDone: Boolean(stornoRow),
    stornoExternalId,
  });
});

router.post('/:id/receipt-copy', async (req, res) => {
  const paymentId = Number.parseInt(req.params.id, 10);
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });

  if (!isPortosEnabled()) {
    return res.status(400).json({ error: 'Portos nie je zapnuty' });
  }

  const saleExternalId = buildPaymentExternalId(payment.orderId);
  const [document] = await db.select().from(fiscalDocuments).where(
    and(eq(fiscalDocuments.paymentId, paymentId), eq(fiscalDocuments.externalId, saleExternalId)),
  );
  const fallback = document || (await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.paymentId, paymentId)))[0];
  if (!fallback?.externalId) {
    return res.status(404).json({ error: 'Fiskalny doklad nema dostupny externalId' });
  }

  try {
    const result = await printCopyByExternalId(fallback.externalId);
    res.status(result.httpStatus || 200).json({
      ok: true,
      printed: result.printed,
      externalId: fallback.externalId,
    });
  } catch (error) {
    console.error('Receipt copy error:', error);
    res.status(503).json({ error: 'Kopiu dokladu sa nepodarilo vytlacit' });
  }
});

router.post('/:id/fiscal-storno', mgr, async (req, res) => {
  const paymentId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId)) {
    return res.status(400).json({ error: 'Neplatne ID platby' });
  }

  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });

  if (!isPortosEnabled()) {
    return res.status(400).json({ error: 'Portos nie je zapnuty' });
  }

  const saleExternalId = buildPaymentExternalId(payment.orderId);
  const stornoExternalId = buildPaymentStornoExternalId(payment.orderId);

  const [existingStorno] = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.externalId, stornoExternalId));
  if (existingStorno) {
    return res.status(409).json({ error: 'Storno pre tuto objednavku uz bolo odoslane', fiscal: toFiscalResponse(existingStorno) });
  }

  const [saleDoc] = await db.select().from(fiscalDocuments).where(
    and(eq(fiscalDocuments.paymentId, paymentId), eq(fiscalDocuments.externalId, saleExternalId)),
  );
  if (!saleDoc) {
    return res.status(404).json({ error: 'Nenasiel sa povodny fiškálny doklad platby' });
  }

  if (!STORNO_ELIGIBLE_MODES.has(saleDoc.resultMode)) {
    return res.status(400).json({
      error: 'Storno je mozne len pre uspesne zaevidovany doklad (online/offline/reconciled)',
      fiscal: toFiscalResponse(saleDoc),
    });
  }

  const referenceReceiptId = saleDoc.receiptId || saleDoc.okp;
  if (!referenceReceiptId) {
    return res.status(400).json({
      error: 'Chýba ID dokladu ani OKP — storno nie je mozne bez referencie na pôvod',
      fiscal: toFiscalResponse(saleDoc),
    });
  }

  let requestPayload;
  try {
    const rawPayload = parseJsonField(saleDoc.requestJson);
    requestPayload = buildStornoCashRegisterRequestContext({
      originalRequestPayload: rawPayload,
      referenceReceiptId,
      orderId: payment.orderId,
    });
  } catch (err) {
    console.error('Fiscal storno build error:', err);
    return res.status(400).json({
      error: err instanceof Error ? err.message : 'Nepodarilo sa zostavit STORNO doklad',
    });
  }

  let fiscalOutcome;
  try {
    const initialOutcome = await registerCashReceipt(requestPayload);
    fiscalOutcome = await resolveFiscalAttempt({ requestPayload, initialOutcome });
  } catch (error) {
    if (!(error instanceof PortosTransportError)) {
      console.error('Unexpected Portos storno error:', error);
    }
    fiscalOutcome = await resolveFiscalAttempt({
      requestPayload,
      initialOutcome: buildTransportFailure(requestPayload, error instanceof Error ? error : new Error(String(error))),
    });
  }

  if (
    fiscalOutcome.resultMode === 'validation_error'
    || fiscalOutcome.resultMode === 'rejected'
    || (
      fiscalOutcome.resultMode !== 'online_success'
      && fiscalOutcome.resultMode !== 'offline_accepted'
      && fiscalOutcome.resultMode !== 'reconciled_online_success'
      && fiscalOutcome.resultMode !== 'reconciled_offline_accepted'
    )
  ) {
    await upsertFiscalDocument(db, buildFiscalDocumentValues({
      orderId: payment.orderId,
      paymentId,
      requestPayload,
      outcome: fiscalOutcome,
      sourceType: 'storno',
    }));

    return res.status(fiscalOutcome.httpStatus || 503).json({
      error: fiscalOutcome.errorDetail || 'Storno doklad bol odmietnuty alebo zlyhal',
      fiscal: {
        status: fiscalOutcome.resultMode,
        externalId: requestPayload.request.externalId,
        errorCode: fiscalOutcome.errorCode,
        errorDetail: fiscalOutcome.errorDetail,
      },
    });
  }

  const stornoDoc = await upsertFiscalDocument(db, buildFiscalDocumentValues({
    orderId: payment.orderId,
    paymentId,
    requestPayload,
    outcome: fiscalOutcome,
    sourceType: 'storno',
  }));

  await logEvent(db, {
    orderId: payment.orderId,
    type: 'fiscal_storno',
    payload: {
      paymentId,
      saleExternalId,
      stornoExternalId,
      receiptId: fiscalOutcome.receiptId,
    },
    staffId: req.user.id,
  });

  res.status(fiscalOutcome.httpStatus || 200).json({
    ok: true,
    fiscal: toFiscalResponse(stornoDoc),
  });
});

export default router;

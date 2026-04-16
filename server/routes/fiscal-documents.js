import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { fiscalDocuments, orders, payments, tables } from '../db/schema.js';
import { logEvent } from '../lib/audit.js';
import { buildPaymentStornoExternalId, buildStornoCashRegisterRequestContext } from '../lib/fiscal-payment.js';
import { getActiveCashRegisterCode } from '../lib/active-cash-register.js';
import {
  findReceiptByExternalIdWithRetry,
  isPortosEnabled,
  PortosTransportError,
  printCopyByExternalId,
  registerCashReceipt,
} from '../lib/portos.js';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');
const STORNO_ELIGIBLE_MODES = new Set([
  'online_success',
  'offline_accepted',
  'reconciled_online_success',
  'reconciled_offline_accepted',
]);

function toIsoDate(value) {
  return value ? new Date(value).toISOString() : null;
}

function parsePositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonField(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildFiscalDocumentValues({ document, requestPayload, outcome }) {
  return {
    sourceType: 'storno',
    sourceId: document.orderId,
    orderId: document.orderId,
    paymentId: document.paymentId,
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
    processDate: outcome.processDate ? new Date(outcome.processDate) : null,
    requestJson: outcome.requestJson || JSON.stringify(requestPayload),
    responseJson: outcome.responseJson || '{}',
    errorCode: outcome.errorCode,
    errorDetail: outcome.errorDetail || '',
    updatedAt: new Date(),
  };
}

async function upsertFiscalDocument(values) {
  const [document] = await db.insert(fiscalDocuments)
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
    processDate: toIsoDate(document.processDate),
    errorCode: document.errorCode,
    errorDetail: document.errorDetail,
    copyAvailable: Boolean(document.externalId),
  };
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

function needsReceiptEnrichment(outcome) {
  return !outcome.receiptId || !outcome.okp || outcome.receiptNumber === null;
}

function mergeReceiptOutcome(baseOutcome, receipt) {
  if (!receipt) return baseOutcome;

  return {
    ...baseOutcome,
    isSuccessful: receipt.isSuccessful ?? baseOutcome.isSuccessful,
    receiptId: receipt.receiptId || baseOutcome.receiptId,
    receiptNumber: receipt.receiptNumber ?? baseOutcome.receiptNumber,
    okp: receipt.okp || baseOutcome.okp,
    portosRequestId: receipt.portosRequestId || baseOutcome.portosRequestId,
    processDate: receipt.processDate || baseOutcome.processDate,
    responseJson: receipt.responseJson || baseOutcome.responseJson,
  };
}

function cashRegisterFromFiscalPayload(requestPayload) {
  return requestPayload?.request?.data?.cashRegisterCode;
}

async function enrichSuccessfulFiscalOutcome({ requestPayload, outcome }) {
  if (!needsReceiptEnrichment(outcome)) return outcome;
  const receipt = await findReceiptByExternalIdWithRetry(requestPayload.request.externalId, {
    cashRegisterCode: cashRegisterFromFiscalPayload(requestPayload),
  });
  return mergeReceiptOutcome(outcome, receipt);
}

async function resolveFiscalAttempt({ requestPayload, initialOutcome }) {
  if (initialOutcome.resultMode === 'blocked') {
    return initialOutcome;
  }

  if (
    initialOutcome.httpStatus === 200 ||
    initialOutcome.httpStatus === 201 ||
    initialOutcome.httpStatus === 202
  ) {
    try {
      return await enrichSuccessfulFiscalOutcome({ requestPayload, outcome: initialOutcome });
    } catch {
      return initialOutcome;
    }
  }

  if (initialOutcome.httpStatus === 400 || initialOutcome.httpStatus === 403) {
    return initialOutcome;
  }

  try {
    const existingReceipt = await findReceiptByExternalIdWithRetry(requestPayload.request.externalId, {
      cashRegisterCode: cashRegisterFromFiscalPayload(requestPayload),
    });
    if (!existingReceipt) {
      return {
        ...initialOutcome,
        resultMode: 'ambiguous',
      };
    }

    let copyPrinted = false;
    if (initialOutcome.errorCode === -502) {
      try {
        const copyResult = await printCopyByExternalId(requestPayload.request.externalId, {
          cashRegisterCode: cashRegisterFromFiscalPayload(requestPayload),
        });
        copyPrinted = Boolean(copyResult.printed);
      } catch {
        copyPrinted = false;
      }
    }

    return {
      ...mergeReceiptOutcome(initialOutcome, existingReceipt),
      resultMode: existingReceipt.isSuccessful === null
        ? 'reconciled_offline_accepted'
        : 'reconciled_online_success',
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerCashReceiptWithRetry(requestPayload, { maxAttempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await registerCashReceipt(requestPayload);
    } catch (error) {
      lastError = error;
      if (!(error instanceof PortosTransportError) || attempt === maxAttempts) throw error;
      await sleep(400 * attempt);
    }
  }
  throw lastError;
}

async function runFiscalStorno({ document, staffId }) {
  if (!document.paymentId) {
    return { status: 400, body: { error: 'K dokladu nie je naviazana platba' } };
  }
  if (!isPortosEnabled()) {
    return { status: 400, body: { error: 'Portos nie je zapnuty' } };
  }

  const stornoExternalId = buildPaymentStornoExternalId(document.orderId);
  const [existingStorno] = await db.select().from(fiscalDocuments)
    .where(eq(fiscalDocuments.externalId, stornoExternalId))
    .limit(1);
  if (existingStorno) {
    return {
      status: 409,
      body: { error: 'Storno pre tuto objednavku uz bolo odoslane', fiscal: toFiscalResponse(existingStorno) },
    };
  }

  if (!STORNO_ELIGIBLE_MODES.has(document.resultMode)) {
    return {
      status: 400,
      body: {
        error: 'Storno je mozne len pre uspesne zaevidovany doklad (online/offline/reconciled)',
        fiscal: toFiscalResponse(document),
      },
    };
  }

  const referenceReceiptId = document.receiptId || document.okp;
  if (!referenceReceiptId) {
    return {
      status: 400,
      body: {
        error: 'Chyba ID dokladu ani OKP - storno nie je mozne bez referencie na povod',
        fiscal: toFiscalResponse(document),
      },
    };
  }

  let requestPayload;
  try {
    requestPayload = buildStornoCashRegisterRequestContext({
      originalRequestPayload: parseJsonField(document.requestJson),
      referenceReceiptId,
      orderId: document.orderId,
      cashRegisterCode: document.cashRegisterCode || (await getActiveCashRegisterCode()),
    });
  } catch (error) {
    console.error('Fiscal storno build error:', error);
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : 'Nepodarilo sa zostavit STORNO doklad' },
    };
  }

  let fiscalOutcome;
  try {
    const initialOutcome = await registerCashReceiptWithRetry(requestPayload);
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
    fiscalOutcome.resultMode === 'validation_error' ||
    fiscalOutcome.resultMode === 'rejected' ||
    (
      fiscalOutcome.resultMode !== 'online_success' &&
      fiscalOutcome.resultMode !== 'offline_accepted' &&
      fiscalOutcome.resultMode !== 'reconciled_online_success' &&
      fiscalOutcome.resultMode !== 'reconciled_offline_accepted'
    )
  ) {
    await upsertFiscalDocument(buildFiscalDocumentValues({
      document,
      requestPayload,
      outcome: fiscalOutcome,
    }));

    return {
      status: fiscalOutcome.httpStatus || 503,
      body: {
        error: fiscalOutcome.errorDetail || 'Storno doklad bol odmietnuty alebo zlyhal',
        fiscal: {
          status: fiscalOutcome.resultMode,
          externalId: requestPayload.request.externalId,
          errorCode: fiscalOutcome.errorCode,
          errorDetail: fiscalOutcome.errorDetail,
        },
      },
    };
  }

  const stornoDoc = await upsertFiscalDocument(buildFiscalDocumentValues({
    document,
    requestPayload,
    outcome: fiscalOutcome,
  }));

  await logEvent(db, {
    orderId: document.orderId,
    type: 'fiscal_storno',
    payload: {
      paymentId: document.paymentId,
      saleExternalId: document.externalId,
      stornoExternalId,
      receiptId: fiscalOutcome.receiptId,
    },
    staffId,
  });

  return {
    status: fiscalOutcome.httpStatus || 200,
    body: {
      ok: true,
      fiscal: toFiscalResponse(stornoDoc),
    },
  };
}

function normalizeRow(row) {
  return {
    id: row.id,
    sourceType: row.sourceType,
    orderId: row.orderId,
    paymentId: row.paymentId,
    externalId: row.externalId,
    cashRegisterCode: row.cashRegisterCode,
    requestType: row.requestType,
    httpStatus: row.httpStatus,
    resultMode: row.resultMode,
    isSuccessful: row.isSuccessful,
    receiptId: row.receiptId,
    receiptNumber: row.receiptNumber,
    okp: row.okp,
    processDate: toIsoDate(row.processDate),
    printerName: row.printerName,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    paymentMethod: row.paymentMethod,
    paymentAmount: row.paymentAmount == null ? null : Number(row.paymentAmount),
    paymentCreatedAt: toIsoDate(row.paymentCreatedAt),
    orderStatus: row.orderStatus,
    orderLabel: row.orderLabel,
    tableId: row.tableId,
    tableName: row.tableName,
  };
}

async function selectFiscalDocuments(whereClause) {
  const rows = await db.select({
    id: fiscalDocuments.id,
    sourceType: fiscalDocuments.sourceType,
    orderId: fiscalDocuments.orderId,
    paymentId: fiscalDocuments.paymentId,
    externalId: fiscalDocuments.externalId,
    cashRegisterCode: fiscalDocuments.cashRegisterCode,
    requestType: fiscalDocuments.requestType,
    httpStatus: fiscalDocuments.httpStatus,
    resultMode: fiscalDocuments.resultMode,
    isSuccessful: fiscalDocuments.isSuccessful,
    receiptId: fiscalDocuments.receiptId,
    receiptNumber: fiscalDocuments.receiptNumber,
    okp: fiscalDocuments.okp,
    processDate: fiscalDocuments.processDate,
    printerName: fiscalDocuments.printerName,
    errorCode: fiscalDocuments.errorCode,
    errorDetail: fiscalDocuments.errorDetail,
    paymentMethod: payments.method,
    paymentAmount: payments.amount,
    paymentCreatedAt: payments.createdAt,
    orderStatus: orders.status,
    orderLabel: orders.label,
    tableId: orders.tableId,
    tableName: tables.name,
  })
    .from(fiscalDocuments)
    .leftJoin(payments, eq(fiscalDocuments.paymentId, payments.id))
    .leftJoin(orders, eq(fiscalDocuments.orderId, orders.id))
    .leftJoin(tables, eq(orders.tableId, tables.id))
    .where(whereClause)
    .orderBy(desc(fiscalDocuments.id));

  return rows.map(normalizeRow);
}

async function loadDocumentMeta(document) {
  const stornoExternalId = document.orderId ? buildPaymentStornoExternalId(document.orderId) : null;
  let stornoDone = false;

  if (document.paymentId && stornoExternalId) {
    const [existingStorno] = await db.select({ id: fiscalDocuments.id })
      .from(fiscalDocuments)
      .where(and(
        eq(fiscalDocuments.paymentId, document.paymentId),
        eq(fiscalDocuments.externalId, stornoExternalId),
      ))
      .limit(1);

    stornoDone = Boolean(existingStorno);
  }

  const referenceReceiptId = document.receiptId || document.okp;
  const stornoEligible = Boolean(
    isPortosEnabled()
    && document.sourceType === 'payment'
    && document.paymentId
    && STORNO_ELIGIBLE_MODES.has(document.resultMode)
    && referenceReceiptId
    && !stornoDone
  );

  return {
    stornoEligible,
    stornoDone,
    stornoExternalId,
  };
}

router.get('/search', mgr, async (req, res) => {
  const receiptId = String(req.query.receiptId || '').trim();
  const externalId = String(req.query.externalId || '').trim();
  const okp = String(req.query.okp || '').trim();
  const cashRegisterCode = String(req.query.cashRegisterCode || '').trim();
  const receiptNumber = parsePositiveInt(req.query.receiptNumber);
  const year = parsePositiveInt(req.query.year);
  const month = parsePositiveInt(req.query.month);

  let items = [];
  if (receiptId) {
    items = await selectFiscalDocuments(eq(fiscalDocuments.receiptId, receiptId));
  } else if (externalId) {
    items = await selectFiscalDocuments(eq(fiscalDocuments.externalId, externalId));
  } else if (okp) {
    items = await selectFiscalDocuments(eq(fiscalDocuments.okp, okp));
  } else if (cashRegisterCode && receiptNumber && year && month) {
    items = await selectFiscalDocuments(and(
      eq(fiscalDocuments.cashRegisterCode, cashRegisterCode),
      eq(fiscalDocuments.receiptNumber, receiptNumber),
    ));
    items = items.filter((item) => {
      if (!item.processDate) return false;
      const processDate = new Date(item.processDate);
      return processDate.getUTCFullYear() === year && (processDate.getUTCMonth() + 1) === month;
    });
  } else {
    return res.status(400).json({
      error: 'Zadaj receiptId, externalId, okp alebo cashRegisterCode + year + month + receiptNumber',
    });
  }

  res.json({ items });
});

router.get('/:id', mgr, async (req, res) => {
  const documentId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(documentId)) {
    return res.status(400).json({ error: 'Neplatne ID dokladu' });
  }

  const items = await selectFiscalDocuments(eq(fiscalDocuments.id, documentId));
  const document = items[0];
  if (!document) {
    return res.status(404).json({ error: 'Fiskalny doklad nenajdeny' });
  }

  const meta = await loadDocumentMeta(document);
  res.json({ ...document, ...meta });
});

router.post('/:id/storno', mgr, async (req, res) => {
  const documentId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(documentId)) {
    return res.status(400).json({ error: 'Neplatne ID dokladu' });
  }

  const [document] = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.id, documentId)).limit(1);
  if (!document) {
    return res.status(404).json({ error: 'Fiskalny doklad nenajdeny' });
  }
  if (!document.paymentId) {
    return res.status(400).json({ error: 'K dokladu nie je naviazana platba' });
  }

  const result = await runFiscalStorno({ document, staffId: req.user.id });
  res.status(result.status).json(result.body);
});

export default router;

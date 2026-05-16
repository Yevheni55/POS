import { and, desc, eq } from 'drizzle-orm';

import { fiscalDocuments } from '../../db/schema.js';
import { toDateOrNull } from './shared.js';

export function buildFiscalDocumentValues({ orderId, paymentId = null, requestPayload, outcome, sourceType = 'payment' }) {
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

export async function upsertFiscalDocument(txOrDb, values) {
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

/** Predajný doklad (nie STORNO) — externalId formát sa môže líšiť (legacy
 * `order-N-payment` alebo nový salted `order-N-pay-<salt>`), preto hľadáme
 * priamo cez orderId + sourceType=payment a vyberieme najnovší. */
export async function selectSaleFiscalDocumentForOrder(txOrDb, orderId) {
  const rows = await txOrDb
    .select()
    .from(fiscalDocuments)
    .where(and(eq(fiscalDocuments.orderId, orderId), eq(fiscalDocuments.sourceType, 'payment')))
    .orderBy(desc(fiscalDocuments.id))
    .limit(1);
  return rows[0] ?? null;
}

export function toFiscalResponse(document) {
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

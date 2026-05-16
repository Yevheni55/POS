import { db } from '../../db/index.js';
import { emitEvent } from '../emit.js';
import {
  buildCashRegisterRequestContext,
  generatePaymentExternalIdSalt,
  parsePaymentExternalIdSalt,
} from '../fiscal-payment.js';
import { formatSupportedVatRates, isSupportedVatRate } from '../menu-vat.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import {
  explainPortosCertificateError,
  isPortosEnabled,
  PortosTransportError,
} from '../portos.js';
import { isVatRegisteredBusiness } from '../vat-registration.js';

import {
  buildFiscalDocumentValues,
  selectSaleFiscalDocumentForOrder,
  toFiscalResponse,
  upsertFiscalDocument,
} from './fiscal-document.js';
import {
  buildTransportFailure,
  registerCashReceiptWithRetry,
  resolveFiscalAttempt,
} from './fiscal-resolve.js';
import {
  finalizeLocalPayment,
  loadExistingPaymentSnapshot,
  loadOrderPaymentContext,
} from './context.js';

export async function createPaymentHandler(req, res) {
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

  const vatRegistered = await isVatRegisteredBusiness();
  if (vatRegistered) {
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
  }

  const activeCashRegisterCode = await getActiveCashRegisterCode();

  // CRITICAL FIX (atomicity): if a previous attempt for this order ALREADY
  // got a successful eKasa receipt but the local DB write failed afterwards
  // (Postgres connection drop, race on order.status, etc), the order is in
  // a 'fiscalized but unpaid' limbo state — sale fiscal_document exists
  // with no payment row. Without this check, the client retry would
  // generate a brand-new salt → new externalId → eKasa accepts a SECOND
  // receipt → customer is charged once but has two eKasa records.
  //
  // Reuse the existing salt so Portos's externalId-based dedup catches the
  // retry and returns the original receipt; we then resume by writing the
  // payment row locally.
  //
  // We only reuse on SUCCESS resultModes — for validation_error / rejected
  // a fresh salt is correct because the operator is fixing the input and
  // wants a new submission.
  const SUCCESS_MODES = new Set(['online_success', 'offline_accepted', 'reconciled_online_success', 'reconciled_offline_accepted']);
  let externalIdSalt = null;
  const existingSaleDoc = await selectSaleFiscalDocumentForOrder(db, orderId);
  if (existingSaleDoc && SUCCESS_MODES.has(existingSaleDoc.resultMode)) {
    const existingSalt = parsePaymentExternalIdSalt(existingSaleDoc.externalId);
    if (existingSalt) {
      externalIdSalt = existingSalt;
      console.warn(
        `[Portos] Reusing externalId salt for order=${orderId} — prior attempt fiscalized successfully but payment row missing. Resuming idempotent retry.`,
      );
    }
  }
  // Fresh salt per payment so externalId is globally unique even if orderId
  // sequence resets (dev DB truncate would otherwise collide with a Portos
  // doc cached under the same `order-N-payment` key from a previous cycle).
  if (!externalIdSalt) externalIdSalt = generatePaymentExternalIdSalt();

  const requestPayload = buildCashRegisterRequestContext({
    orderId,
    items: orderContext.items,
    discountAmount: orderContext.discountAmount,
    method,
    expectedTotal: orderContext.expectedTotal,
    cashRegisterCode: activeCashRegisterCode,
    forceZeroVat: !vatRegistered,
    externalIdSalt,
  });

  let fiscalOutcome;
  try {
    const initialOutcome = await registerCashReceiptWithRetry(requestPayload);
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

  if (
    fiscalOutcome.resultMode === 'validation_error' ||
    fiscalOutcome.resultMode === 'rejected' ||
    fiscalOutcome.resultMode === 'blocked' ||
    fiscalOutcome.resultMode === 'mismatch_rejected'
  ) {
    console.warn(
      `[Portos] Payment ${fiscalOutcome.resultMode} for order=${orderId} ` +
      `cashRegister=${requestPayload.request.data.cashRegisterCode} ` +
      `errorCode=${fiscalOutcome.errorCode ?? '-'} ` +
      `detail="${fiscalOutcome.errorDetail || ''}" ` +
      `mismatchReason="${fiscalOutcome.mismatchReason || ''}"`,
    );
    await upsertFiscalDocument(db, buildFiscalDocumentValues({
      orderId,
      requestPayload,
      outcome: fiscalOutcome,
    }));

    const certificateHint = explainPortosCertificateError({
      detail: fiscalOutcome.errorDetail,
      errorDetail: fiscalOutcome.errorDetail,
    });
    const mismatchMsg = fiscalOutcome.resultMode === 'mismatch_rejected'
      ? `Doklad z eKasy NEZHODA s objednávkou (${fiscalOutcome.mismatchReason || 'neznámy dôvod'}). Kontaktuj manažéra — platbu NEUKLADAJ ako úspešnú.`
      : null;
    return res.status(fiscalOutcome.resultMode === 'blocked' ? 503 : (fiscalOutcome.httpStatus || 400)).json({
      error: mismatchMsg || certificateHint || fiscalOutcome.errorDetail || 'Fiskalizacia bola odmietnuta',
      fiscal: {
        status: fiscalOutcome.resultMode,
        externalId: requestPayload.request.externalId,
        errorCode: fiscalOutcome.errorCode,
        errorDetail: fiscalOutcome.errorDetail,
        mismatchReason: fiscalOutcome.mismatchReason || null,
        certificateIssue: Boolean(certificateHint),
        cashRegisterCodeUsed: requestPayload.request.data.cashRegisterCode,
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
}

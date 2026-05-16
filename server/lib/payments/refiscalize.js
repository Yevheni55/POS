import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import { logEvent } from '../audit.js';
import {
  buildCashRegisterRequestContext,
  generatePaymentExternalIdSalt,
} from '../fiscal-payment.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import {
  isPortosEnabled,
  isPrintCopyResponseSuccess,
  PortosTransportError,
  printCopyByExternalId,
} from '../portos.js';
import { isVatRegisteredBusiness } from '../vat-registration.js';

import {
  buildFiscalDocumentValues,
  toFiscalResponse,
  upsertFiscalDocument,
} from './fiscal-document.js';
import {
  buildTransportFailure,
  registerCashReceiptWithRetry,
  resolveFiscalAttempt,
} from './fiscal-resolve.js';
import { loadOrderPaymentContext } from './context.js';

/**
 * POST /api/payments/:id/refiscalize
 *
 * Manuálne pre-pošle fiškálny request pre danú platbu pod NOVÝM unique
 * externalId. Použiť keď pôvodný doklad sa nikdy poriadne nezaregistroval
 * (Portos vrátil cudzí cache cez `findReceiptByExternalId`, alebo platba
 * bola označená `mismatch_rejected`).
 *
 * Postaví requestPayload zo skutočných order_items + menu_items, pošle do
 * Portos, validuje response, nahradí starý fiscal_document záznam novým.
 * Pokuta-kritické: vyžaduje role manazer/admin a neukladá nezhodný receipt.
 */
export async function refiscalizeHandler(req, res) {
  const paymentId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId)) {
    return res.status(400).json({ error: 'Neplatne ID platby' });
  }
  if (!isPortosEnabled()) {
    return res.status(400).json({ error: 'Portos nie je zapnuty' });
  }

  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });

  const orderContext = await loadOrderPaymentContext(payment.orderId);
  if (!orderContext) return res.status(404).json({ error: 'Objednavka nenajdena' });
  if (!orderContext.items.length) return res.status(400).json({ error: 'Objednavka nema polozky' });

  const vatRegistered = await isVatRegisteredBusiness();
  const activeCashRegisterCode = await getActiveCashRegisterCode();
  const requestPayload = buildCashRegisterRequestContext({
    orderId: payment.orderId,
    items: orderContext.items,
    discountAmount: orderContext.discountAmount,
    method: payment.method,
    expectedTotal: orderContext.expectedTotal,
    cashRegisterCode: activeCashRegisterCode,
    forceZeroVat: !vatRegistered,
    externalIdSalt: generatePaymentExternalIdSalt(),
  });

  let fiscalOutcome;
  try {
    const initialOutcome = await registerCashReceiptWithRetry(requestPayload);
    fiscalOutcome = await resolveFiscalAttempt({ requestPayload, initialOutcome });
  } catch (error) {
    if (!(error instanceof PortosTransportError)) {
      console.error('Refiscalize error:', error);
    }
    fiscalOutcome = await resolveFiscalAttempt({
      requestPayload,
      initialOutcome: buildTransportFailure(requestPayload, error instanceof Error ? error : new Error(String(error))),
    });
  }

  const acceptedModes = new Set(['online_success', 'offline_accepted', 'reconciled_online_success', 'reconciled_offline_accepted']);
  if (!acceptedModes.has(fiscalOutcome.resultMode)) {
    return res.status(502).json({
      error: 'Refiskalizacia neprosla — Portos vratil ' + fiscalOutcome.resultMode + (fiscalOutcome.errorDetail ? ': ' + fiscalOutcome.errorDetail : ''),
      fiscal: { status: fiscalOutcome.resultMode, externalId: requestPayload.request.externalId, mismatchReason: fiscalOutcome.mismatchReason || null },
    });
  }

  // Replace any existing fiscal_document for this payment with the fresh one.
  // We DELETE the stale row so admin UI no longer points at the cudzí blok.
  // Storno doc (sourceType='storno'), if any, stays as-is.
  await db.delete(fiscalDocuments).where(and(
    eq(fiscalDocuments.paymentId, paymentId),
    eq(fiscalDocuments.sourceType, 'payment'),
  ));
  const fiscalDocument = await upsertFiscalDocument(db, buildFiscalDocumentValues({
    orderId: payment.orderId,
    requestPayload,
    outcome: fiscalOutcome,
    paymentId,
  }));

  // Print a copy on the CHDU so the cashier physically gets the receipt.
  let printOutcome = { ok: true, printed: false, queued: false };
  try {
    const printResult = await printCopyByExternalId(requestPayload.request.externalId, {
      cashRegisterCode: requestPayload.request.data.cashRegisterCode,
    });
    printOutcome = { ok: isPrintCopyResponseSuccess(printResult), printed: !!printResult.printed, raw: printResult.raw };
  } catch (e) {
    console.warn('Refiscalize: print copy failed', e && e.message);
    printOutcome = { ok: false, printed: false, error: e && e.message };
  }

  await logEvent(db, {
    orderId: payment.orderId,
    type: 'payment_refiscalized',
    payload: {
      paymentId,
      newExternalId: requestPayload.request.externalId,
      receiptId: fiscalOutcome.receiptId,
      receiptNumber: fiscalOutcome.receiptNumber,
      printed: printOutcome.printed,
    },
    staffId: req.user.id,
  });

  res.json({
    ok: true,
    fiscal: toFiscalResponse(fiscalDocument),
    print: printOutcome,
  });
}

import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import { logEvent } from '../audit.js';
import {
  buildPaymentStornoExternalId,
  buildStornoCashRegisterRequestContext,
  parsePaymentExternalIdSalt,
} from '../fiscal-payment.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { isPortosEnabled, PortosTransportError } from '../portos.js';

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
import { STORNO_ELIGIBLE_MODES, parseJsonField } from './shared.js';

export async function fiscalStornoHandler(req, res) {
  const paymentId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId)) {
    return res.status(400).json({ error: 'Neplatne ID platby' });
  }

  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });

  if (!isPortosEnabled()) {
    return res.status(400).json({ error: 'Portos nie je zapnuty' });
  }

  // Find the actual sale doc first (sourceType-based — externalId formát je
  // teraz salted, deterministic builder by minul nový dok), then derive the
  // matching storno externalId from its salt so existence check + new send
  // share the same id space.
  const docsForPayment = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.paymentId, paymentId));
  const saleDoc = docsForPayment.find((d) => d.sourceType === 'payment');
  if (!saleDoc) {
    return res.status(404).json({ error: 'Nenasiel sa povodny fiškálny doklad platby' });
  }
  const saltFromSale = parsePaymentExternalIdSalt(saleDoc.externalId);
  const stornoExternalId = buildPaymentStornoExternalId(payment.orderId, { salt: saltFromSale });

  const [existingStorno] = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.externalId, stornoExternalId));
  if (existingStorno) {
    return res.status(409).json({ error: 'Storno pre tuto objednavku uz bolo odoslane', fiscal: toFiscalResponse(existingStorno) });
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
      cashRegisterCode: saleDoc.cashRegisterCode || (await getActiveCashRegisterCode()),
      externalIdSalt: saltFromSale,
    });
  } catch (err) {
    console.error('Fiscal storno build error:', err);
    return res.status(400).json({
      error: err instanceof Error ? err.message : 'Nepodarilo sa zostavit STORNO doklad',
    });
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
    fiscalOutcome.resultMode === 'validation_error'
    || fiscalOutcome.resultMode === 'rejected'
    || (
      fiscalOutcome.resultMode !== 'online_success'
      && fiscalOutcome.resultMode !== 'offline_accepted'
      && fiscalOutcome.resultMode !== 'reconciled_online_success'
      && fiscalOutcome.resultMode !== 'reconciled_offline_accepted'
    )
  ) {
    // CRITICAL FIX: previously persisted a fiscal_document with sourceType='storno'
    // even on failure modes. The dedup check at line 984 then matched on the
    // externalId, so any subsequent retry got HTTP 409 ("Storno už bolo
    // odoslané") even though eKasa never accepted the storno — leaving the
    // operator stuck with no admin path to clear it.
    //
    // Now we ONLY persist on success modes (handled below). Failures are
    // logged for diagnostics + an audit event so we still know who tried
    // and when, and the caller can simply retry. validation_error = bad
    // input (will fail again on retry) so we still log it but the salt
    // stays stable, so a subsequent fix-and-retry produces the same
    // externalId — eKasa side dedup handles that idempotently.
    console.warn(
      `[Portos] Storno ${fiscalOutcome.resultMode} for payment=${paymentId} order=${payment.orderId} ` +
      `errorCode=${fiscalOutcome.errorCode ?? '-'} ` +
      `detail="${fiscalOutcome.errorDetail || ''}"`,
    );
    await logEvent(db, {
      orderId: payment.orderId,
      type: 'fiscal_storno_failed',
      payload: {
        paymentId,
        saleExternalId: saleDoc.externalId,
        stornoExternalId: requestPayload.request.externalId,
        resultMode: fiscalOutcome.resultMode,
        errorCode: fiscalOutcome.errorCode || null,
        errorDetail: fiscalOutcome.errorDetail || null,
      },
      staffId: req.user.id,
    }).catch((e) => console.error('[Portos] storno-failed audit log error:', e?.message || e));

    return res.status(fiscalOutcome.httpStatus || 503).json({
      error: fiscalOutcome.errorDetail || 'Storno doklad bol odmietnuty alebo zlyhal — skús znova',
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

  // CRITICAL FIX: previously referenced an undeclared `saleExternalId` which
  // ReferenceError'd on every successful storno — eKasa storno was already
  // registered + DB row written, but the cashier saw HTTP 500 and assumed it
  // failed (then often retried, hitting the dedup 409). Pull the id from the
  // sale doc that we already loaded above so the audit row is complete.
  await logEvent(db, {
    orderId: payment.orderId,
    type: 'fiscal_storno',
    payload: {
      paymentId,
      saleExternalId: saleDoc.externalId,
      stornoExternalId,
      receiptId: fiscalOutcome.receiptId,
    },
    staffId: req.user.id,
  });

  res.status(fiscalOutcome.httpStatus || 200).json({
    ok: true,
    fiscal: toFiscalResponse(stornoDoc),
  });
}

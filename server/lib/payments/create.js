import { db } from '../../db/index.js';
import { emitEvent } from '../emit.js';
import {
  buildCashRegisterRequestContext,
  generatePaymentExternalIdSalt,
  parsePaymentExternalIdSalt,
} from '../fiscal-payment.js';
import { assertSupportedVatRates } from '../menu-vat.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import {
  explainPortosCertificateError,
  getPortosConfig,
  isPortosEnabled,
  PortosTransportError,
} from '../portos.js';
import { getPortosProfileSyncStats } from '../portos-sync-job.js';
import { assertVatModeTrusted, getVatMode } from '../vat-registration.js';

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
import { fiscalFailureHttpStatus } from './shared.js';

/**
 * Druhý nezávislý zdroj, ktorý potvrdí, že uložený profil firmy patrí PRÁVE TEJTO kase:
 * `company_profiles.cash_register_code` (píše ho výhradne Portos sync) sa musí zhodovať
 * s `PORTOS_CASH_REGISTER_CODE` zo `.env` (nastavuje ho obsluha pri inštalácii).
 *
 * Prečo to stačí: kód pokladne aj `ic_dph` zapísal do riadku ten istý Portos sync z tej istej
 * identity. Ak riadok popisuje identitu, na ktorú je kasa nakonfigurovaná, jeho režim DPH je
 * dôveryhodný aj bez ČERSTVÉHO syncu v tomto behu procesu.
 *
 * Prečo to NEZAKRÝVA nález [17]: presne v migračnom okne (kasa reštartovaná po prepnutí firmy,
 * v DB ešte visí riadok PREDCHÁDZAJÚCEJ identity) sa kódy NEzhodujú → potvrdenie neplatí
 * a `assertVatModeTrusted()` platbu zablokuje 503 namiesto vystavenia dokladu s 0 % DPH.
 * Rovnako neplatí pri prázdnom profile (sync nikdy neprebehol) a pri rozpore so
 * `.env POS_VAT_REGISTERED` (`mode.mismatch`).
 *
 * Dôvod existencie: bez tejto skratky by PRODUKČNÁ kasa neplatiteľa DPH začala na KAŽDEJ platbe
 * vracať 503, kedykoľvek zlyhá Portos profile sync — čo je zmena správania pre neplatiteľa.
 */
function isVatModeIdentityConfirmed(mode) {
  if (mode.mismatch) return false;
  const envCode = String(getPortosConfig().cashRegisterCode || '').trim();
  const profileCode = String(mode.cashRegisterCode || '').trim();
  if (!envCode || !profileCode) return false;
  return envCode === profileCode;
}

let warnedSyncSchedulerMissing = false;

/**
 * Profil sa nedá vyhlásiť za „nedôveryhodný, lebo sync zlyhal", keď sa sync v tomto procese
 * ANI RAZ nespustil. `startPortosProfileSync()` volá `runPortosProfileSync()` synchrónne
 * (portos-sync-job.js:141), takže na reálnom serveri je `attempts >= 1` skôr, než príde prvý
 * HTTP request — táto vetva tam nikdy neplatí. Platí len v procesoch, ktoré plánovač vôbec
 * nespúšťajú (integračné testy, jednorazové skripty), kde by inak gate zablokoval každú platbu.
 */
function isProfileSyncSchedulerMissing() {
  const stats = getPortosProfileSyncStats();
  const missing = stats.attempts === 0 && stats.lastSyncAt === null && !stats.lastError;
  if (missing && !warnedSyncSchedulerMissing) {
    warnedSyncSchedulerMissing = true;
    console.warn(
      '[VAT] Portos profile sync sa v tomto procese nikdy nespustil — gate režimu DPH je neaktívny. '
      + 'Na serveri musí byť startPortosProfileSync() zavolaný pri štarte.',
    );
  }
  return missing;
}

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

  // POZN: opačný smer (amount > expectedTotal) sa ZÁMERNE neodmieta —
  // prevýšenie znamená „hosť podal viac, vydáva sa mimo systém" a je pokryté
  // testom payments.test.js:345. Viď komentár pri zápise payments.amount
  // v server/lib/payments/context.js.

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

  // Poradie je zámerné:
  //   1) sadzby DPH validujeme LOKÁLNE — chybné menu nemá dôvod chodiť po sieti
  //      a obsluha dostane presnú hlášku bez jediného requestu do Portosu;
  //   2) až potom overíme dôveryhodnosť režimu DPH. Režim smie rozhodovať IBA
  //      profil, ktorý bol v tomto behu naozaj potvrdený z Portosu (alebo
  //      druhým zdrojom — .env POS_VAT_REGISTERED). Inak radšej 503 než doklad
  //      s tichou 0 % DPH — spätne sa to nedá opraviť inak než storno + nový
  //      doklad pre každý účet.
  let vatMode = await getVatMode();
  try {
    if (vatMode.vatRegistered) assertSupportedVatRates(orderContext.items);

    // Skratky, aby sa NEZMENILO správanie neplatiteľa DPH: profil potvrdený `.env` kódom
    // pokladne, resp. proces, ktorý profil-sync vôbec neplánuje. Migračné okno (starý riadok
    // z predchádzajúcej identity / prázdny profil / rozpor s POS_VAT_REGISTERED) nimi neprejde.
    if (
      !vatMode.trusted
      && !isVatModeIdentityConfirmed(vatMode)
      && !isProfileSyncSchedulerMissing()
    ) {
      const trustedVatMode = await assertVatModeTrusted();
      // Inline sync mohol profil prepnúť neplatiteľ→platiteľ — vtedy sadzby ešte
      // kontrolované neboli, tak to doháňame teraz (stále pred fiškalizáciou).
      if (trustedVatMode.vatRegistered && !vatMode.vatRegistered) {
        assertSupportedVatRates(orderContext.items);
      }
      vatMode = trustedVatMode;
    }
  } catch (error) {
    if (error && error.status) return res.status(error.status).json(error.body);
    throw error;
  }
  const vatRegistered = vatMode.vatRegistered;

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
    // Order-level discount only — per-item discounts are emitted as their own
    // fiscal lines from items[].discountAmount (avoid double-counting).
    discountAmount: orderContext.orderDiscountAmount,
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
    return res.status(fiscalOutcome.resultMode === 'blocked' ? 503 : fiscalFailureHttpStatus(fiscalOutcome)).json({
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

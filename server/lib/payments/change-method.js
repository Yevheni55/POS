import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import { logEvent } from '../audit.js';
import {
  buildCashRegisterRequestContext,
  buildPaymentStornoExternalId,
  buildStornoCashRegisterRequestContext,
  generatePaymentExternalIdSalt,
  parsePaymentExternalIdSalt,
} from '../fiscal-payment.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { isPortosEnabled } from '../portos.js';
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
import { STORNO_ELIGIBLE_MODES, parseJsonField } from './shared.js';

// POST /api/payments/:id/change-method
// Zmena spôsobu platby na už vytlačenom doklade. Postup:
//   1) Vystorno pôvodný fiškálny doklad cez Portos.
//   2) Pošli nový sale-doklad s rovnakými položkami ale s NOVÝM sposobom.
//   3) UPDATE payments.method na nový spôsob (jediný payment row, iba sa
//      mení label) — reporty a Z-report tým správne sčítajú nové sumy
//      podľa metódy.
//
// Idempotencia: ak storno pre objednávku už existuje, prerušíme. Ak nový
// doklad by mal rovnaký externalId-salt, generujeme čerstvý.
export async function changeMethodHandler(req, res) {
  const paymentId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId)) {
    return res.status(400).json({ error: 'Neplatne ID platby' });
  }
  const { newMethod } = req.body;

  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });
  if (payment.method === newMethod) {
    return res.status(400).json({ error: 'Rovnaký spôsob platby — nič sa nemení' });
  }
  if (!isPortosEnabled()) {
    return res.status(400).json({ error: 'Portos nie je zapnuty' });
  }

  // ── 1. Storno pôvodného dokladu ────────────────────────────────────
  const docsForPayment = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.paymentId, paymentId));
  const saleDoc = docsForPayment.find((d) => d.sourceType === 'payment');
  if (!saleDoc) {
    return res.status(404).json({ error: 'Nenasiel sa povodny fiškálny doklad platby' });
  }
  const saltFromSale = parsePaymentExternalIdSalt(saleDoc.externalId);
  const stornoExternalId = buildPaymentStornoExternalId(payment.orderId, { salt: saltFromSale });
  const [existingStorno] = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.externalId, stornoExternalId));
  if (existingStorno) {
    return res.status(409).json({ error: 'Storno pre tento doklad už existuje — zmenu metódy treba dokončiť ručne', fiscal: toFiscalResponse(existingStorno) });
  }
  if (!STORNO_ELIGIBLE_MODES.has(saleDoc.resultMode)) {
    return res.status(400).json({ error: 'Pôvodný doklad nie je v stave kde sa dá storno', fiscal: toFiscalResponse(saleDoc) });
  }
  const referenceReceiptId = saleDoc.receiptId || saleDoc.okp;
  if (!referenceReceiptId) {
    return res.status(400).json({ error: 'Chýba ID dokladu ani OKP — storno bez referencie nie je možné' });
  }

  const cashRegisterCode = saleDoc.cashRegisterCode || (await getActiveCashRegisterCode());
  let stornoPayload;
  try {
    stornoPayload = buildStornoCashRegisterRequestContext({
      originalRequestPayload: parseJsonField(saleDoc.requestJson),
      referenceReceiptId,
      orderId: payment.orderId,
      cashRegisterCode,
      externalIdSalt: saltFromSale,
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Nepodarilo sa zostavit STORNO doklad' });
  }

  let stornoOutcome;
  try {
    const initialOutcome = await registerCashReceiptWithRetry(stornoPayload);
    stornoOutcome = await resolveFiscalAttempt({ requestPayload: stornoPayload, initialOutcome });
  } catch (error) {
    stornoOutcome = await resolveFiscalAttempt({
      requestPayload: stornoPayload,
      initialOutcome: buildTransportFailure(stornoPayload, error instanceof Error ? error : new Error(String(error))),
    });
  }
  const STORNO_OK = new Set(['online_success', 'offline_accepted', 'reconciled_online_success', 'reconciled_offline_accepted']);
  if (!STORNO_OK.has(stornoOutcome.resultMode)) {
    return res.status(stornoOutcome.httpStatus || 503).json({
      error: stornoOutcome.errorDetail || 'STORNO zlyhalo, zmena metódy nemôže pokračovať',
      fiscal: { status: stornoOutcome.resultMode, errorCode: stornoOutcome.errorCode, errorDetail: stornoOutcome.errorDetail },
    });
  }

  const stornoDoc = await upsertFiscalDocument(db, buildFiscalDocumentValues({
    orderId: payment.orderId,
    paymentId,
    requestPayload: stornoPayload,
    outcome: stornoOutcome,
    sourceType: 'storno',
  }));

  // ── 2. Nový sale s NOVÝM sposobom platby ───────────────────────────
  const orderContext = await loadOrderPaymentContext(payment.orderId);
  if (!orderContext) {
    return res.status(500).json({ error: 'Storno OK, ale nepodarilo sa načítať položky pre nový doklad — kontaktuj IT', fiscal: toFiscalResponse(stornoDoc) });
  }
  const vatRegistered = await isVatRegisteredBusiness();
  const newSalt = generatePaymentExternalIdSalt();
  const newSalePayload = buildCashRegisterRequestContext({
    orderId: payment.orderId,
    items: orderContext.items,
    discountAmount: orderContext.discountAmount,
    method: newMethod,
    expectedTotal: Number(payment.amount),
    cashRegisterCode,
    forceZeroVat: !vatRegistered,
    externalIdSalt: newSalt,
  });

  let newOutcome;
  try {
    const initialOutcome = await registerCashReceiptWithRetry(newSalePayload);
    newOutcome = await resolveFiscalAttempt({ requestPayload: newSalePayload, initialOutcome });
  } catch (error) {
    newOutcome = await resolveFiscalAttempt({
      requestPayload: newSalePayload,
      initialOutcome: buildTransportFailure(newSalePayload, error instanceof Error ? error : new Error(String(error))),
    });
  }
  if (!STORNO_OK.has(newOutcome.resultMode)) {
    // Pôvodný doklad je vystornovaný, ale nový sa neuložil — operátor musí
    // tlačiť ručne. Vrátime 503 s detailom; storno doc už v DB existuje.
    return res.status(newOutcome.httpStatus || 503).json({
      error: 'Storno bolo OK, ale nový doklad zlyhal — vytvor platbu ručne v POS. ' + (newOutcome.errorDetail || ''),
      fiscal: { status: newOutcome.resultMode, errorCode: newOutcome.errorCode, errorDetail: newOutcome.errorDetail },
      stornoFiscal: toFiscalResponse(stornoDoc),
    });
  }

  const newSaleDoc = await upsertFiscalDocument(db, buildFiscalDocumentValues({
    orderId: payment.orderId,
    paymentId,
    requestPayload: newSalePayload,
    outcome: newOutcome,
    sourceType: 'payment',
  }));

  // ── 3. UPDATE payment.method (jediný row, len label sa mení) ───────
  await db.update(payments).set({ method: newMethod }).where(eq(payments.id, paymentId));

  await logEvent(db, {
    orderId: payment.orderId,
    type: 'payment_method_changed',
    payload: {
      paymentId,
      oldMethod: payment.method,
      newMethod,
      stornoExternalId: stornoPayload.request.externalId,
      newSaleExternalId: newSalePayload.request.externalId,
    },
    staffId: req.user.id,
  });

  res.json({
    ok: true,
    paymentId,
    oldMethod: payment.method,
    newMethod,
    stornoFiscal: toFiscalResponse(stornoDoc),
    newSaleFiscal: toFiscalResponse(newSaleDoc),
  });
}

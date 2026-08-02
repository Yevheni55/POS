import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import { logEvent } from '../audit.js';
import {
  buildPaymentExternalId,
  buildPaymentStornoExternalId,
  buildStornoCashRegisterRequestContext,
  generatePaymentExternalIdSalt,
  parsePaymentExternalIdSalt,
  sanitizeForFiscalPrinter,
  PAYMENT_METHOD_LABELS,
} from '../fiscal-payment.js';
import { assertSupportedVatRates } from '../menu-vat.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { isPortosEnabled } from '../portos.js';

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
import {
  STORNO_ELIGIBLE_MODES,
  fiscalFailureHttpStatus,
  parseJsonField,
  roundMoney,
} from './shared.js';

// POST /api/payments/:id/change-method
// Zmena spôsobu platby na už vytlačenom doklade. Postup:
//   1) Všetky kontroly + kompletné zostavenie OBOCH dokladov (storno aj nový)
//      ešte PRED prvým dotykom Portosu — inak pri odmietnutí nového dokladu
//      ostane v eKase vystornovaný doklad bez náhrady.
//   2) Vystorno pôvodný fiškálny doklad cez Portos.
//   3) Pošli nový sale-doklad s rovnakými položkami ale s NOVÝM sposobom.
//   4) UPDATE payments.method na nový spôsob (jediný payment row, iba sa
//      mení label) — reporty a Z-report tým správne sčítajú nové sumy
//      podľa metódy.
//
// DPH-neutralita: OBA doklady sa odvodzujú zo ZMRAZENÉHO payloadu pôvodného
// dokladu (`fiscal_documents.request_json`). Nikdy sa neskladajú nanovo z live
// menu — inak by po prepnutí neplatiteľ→platiteľ (alebo po zmene
// menu_items.price / vat_rate) dvojica storno+nový doklad nebola ani DPH-,
// ani sumovo-neutrálna.
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

  // ── 1. Kontroly a príprava — BEZ akéhokoľvek dotyku Portosu ────────
  const docsForPayment = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.paymentId, paymentId));
  const saleDoc = docsForPayment.find((d) => d.sourceType === 'payment');
  if (!saleDoc) {
    return res.status(404).json({ error: 'Nenasiel sa povodny fiškálny doklad platby' });
  }

  // Doklad vystavený pod PREDCHÁDZAJÚCOU identitou (iný kód pokladne / DKP) sa
  // v Portose už nedá ani stornovať — certifikát pre starý alias tam nie je.
  // Odmietni PRED stornom, nech nevznikne polovičná dvojica.
  const activeCashRegisterCode = await getActiveCashRegisterCode();
  const docCashRegisterCode = String(saleDoc.cashRegisterCode || '').trim();
  if (docCashRegisterCode && activeCashRegisterCode && docCashRegisterCode !== activeCashRegisterCode) {
    return res.status(409).json({
      error: `Doklad patrí predchádzajúcej firme (kód pokladne ${docCashRegisterCode}) — zmenu spôsobu platby treba vystaviť v jej eKase`,
      stornoBlockedReason: 'foreign_cash_register',
      cashRegisterCode: docCashRegisterCode,
      activeCashRegisterCode,
      fiscal: toFiscalResponse(saleDoc),
    });
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

  const cashRegisterCode = docCashRegisterCode || activeCashRegisterCode;

  // Zmrazený payload pôvodného dokladu je jediný povolený zdroj položiek pre OBE
  // strany dvojice. Ak sa nedá rozparsovať, končíme 400 EŠTE pred stornom —
  // rekonštrukcia z live menu je presne to, čo robí dvojicu nesedieť.
  const savedPayload = parseJsonField(saleDoc.requestJson);
  const savedData = savedPayload && savedPayload.request ? savedPayload.request.data : null;
  if (
    !savedData
    || !Array.isArray(savedData.items) || !savedData.items.length
    || !Array.isArray(savedData.payments) || !savedData.payments.length
  ) {
    return res.status(400).json({
      error: 'Pôvodný fiškálny payload sa nedá rozparsovať (chýbajú položky alebo platby) — '
        + 'nový doklad by sa musel rekonštruovať z aktuálneho menu, čo nie je DPH-neutrálne. '
        + 'Rieš ručne (storno + nová platba).',
      fiscal: toFiscalResponse(saleDoc),
    });
  }

  let stornoPayload;
  try {
    stornoPayload = buildStornoCashRegisterRequestContext({
      originalRequestPayload: savedPayload,
      referenceReceiptId,
      orderId: payment.orderId,
      cashRegisterCode,
      externalIdSalt: saltFromSale,
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Nepodarilo sa zostavit STORNO doklad' });
  }

  // ── 2. „Dry-run" nového dokladu — kompletne zostavený a zvalidovaný ešte
  //       PRED odoslaním storna. Položky (názvy, ceny, vatRate, zľavové riadky)
  //       ostávajú BÍTOVO tie isté; mení sa výlučne `payments` a `externalId`.
  const newSalt = generatePaymentExternalIdSalt();
  const originalTotal = roundMoney(
    savedData.payments.reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
  );
  const newSalePayload = {
    request: {
      data: {
        ...savedData,
        cashRegisterCode: String(savedData.cashRegisterCode || cashRegisterCode || '').trim(),
        payments: [{
          name: sanitizeForFiscalPrinter(PAYMENT_METHOD_LABELS[newMethod] || newMethod),
          amount: originalTotal,
        }],
      },
      externalId: buildPaymentExternalId(payment.orderId, { salt: newSalt }),
    },
    // Rovnaká voľba tlačiarne ako pri storne (zmrazená → konfigurovaná).
    print: { printerName: stornoPayload.print.printerName },
  };

  try {
    // Validujeme presne to, čo naozaj pôjde do Portosu (zmrazené položky), nie
    // živé menu. U neplatiteľa sú všetky sadzby 0 → guard je no-op.
    assertSupportedVatRates(newSalePayload.request.data.items);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json(err.body);
    throw err;
  }

  // ── 3. Storno pôvodného dokladu ────────────────────────────────────
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
    return res.status(fiscalFailureHttpStatus(stornoOutcome, 503)).json({
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

  // ── 4. Nový sale s NOVÝM sposobom platby (payload je hotový z kroku 2) ──
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
    return res.status(fiscalFailureHttpStatus(newOutcome, 503)).json({
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

  // Pôvodný predajný doklad je vystornovaný — odstavíme ho z aktívneho pohľadu
  // rovnakou konvenciou ako refiscalize.js. Bez toho by na platbe ostali DVA
  // riadky so `sourceType='payment'` a `.find(d => d.sourceType === 'payment')`
  // (fiscal-storno.js, fiscal-get.js, history.js, receipt-copy.js) by trafilo
  // ten STARÝ — storno nového dokladu by potom navždy končilo na 409 „storno
  // už existuje" a dotlač kópie by vytlačila zrušený blok. Riadok sa NEMAŽE:
  // externalId + receiptId ostávajú dohľadateľné.
  await db.update(fiscalDocuments)
    .set({ sourceType: 'payment_superseded', updatedAt: new Date() })
    .where(eq(fiscalDocuments.id, saleDoc.id));

  // ── 5. UPDATE payment.method (jediný row, len label sa mení) ───────
  await db.update(payments).set({ method: newMethod }).where(eq(payments.id, paymentId));

  await logEvent(db, {
    orderId: payment.orderId,
    type: 'payment_method_changed',
    payload: {
      paymentId,
      oldMethod: payment.method,
      newMethod,
      oldSaleExternalId: saleDoc.externalId,
      oldSaleReceiptId: saleDoc.receiptId || saleDoc.okp || null,
      stornoExternalId: stornoPayload.request.externalId,
      newSaleExternalId: newSalePayload.request.externalId,
      cashRegisterCode,
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

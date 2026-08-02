import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import { logEvent } from '../audit.js';
import {
  buildPaymentExternalId,
  generatePaymentExternalIdSalt,
} from '../fiscal-payment.js';
import { assertSupportedVatRates } from '../menu-vat.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import {
  getPortosConfig,
  isPortosEnabled,
  isPrintCopyResponseSuccess,
  PortosTransportError,
  printCopyByExternalId,
} from '../portos.js';

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

/**
 * POST /api/payments/:id/refiscalize
 *
 * Manuálne pre-pošle fiškálny request pre danú platbu pod NOVÝM unique
 * externalId. Použiť keď pôvodný doklad sa nikdy poriadne nezaregistroval
 * (Portos vrátil cudzí cache cez `findReceiptByExternalId`, alebo platba
 * bola označená `mismatch_rejected`).
 *
 * Payload sa NESKLADÁ nanovo z live menu — berie sa ZMRAZENÝ
 * `fiscal_documents.request_json` pôvodného pokusu (rovnako ako to robí
 * `buildStornoCashRegisterRequestContext`). Inak by sa po prepnutí
 * neplatiteľ→platiteľ, resp. po zmene `menu_items.price` / `vat_rate`, doklad
 * prerazil s inými sadzbami a sumami, než za aké hosť reálne zaplatil.
 *
 * Pôvodný lokálny riadok sa NIKDY nemaže — iba sa označí ako neaktívny
 * (`sourceType='payment_superseded'`), aby staré `externalId`/`receiptId`
 * ostali dohľadateľné pre prípadné neskoršie storno.
 *
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

  const docsForPayment = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.paymentId, paymentId));
  const saleDoc = docsForPayment.find((d) => d.sourceType === 'payment') || null;
  if (!saleDoc) {
    return res.status(404).json({ error: 'Nenasiel sa povodny fiškálny doklad platby — refiskalizacia nie je mozna' });
  }

  // GUARD: platne zaevidovaný doklad sa NESMIE preraziť druhýkrát. eKasa by
  // potom obsahovala DVA doklady na tú istú tržbu (a po prepnutí režimu DPH
  // aj s rôznymi sadzbami). Jediná legálna cesta je STORNO + nová platba.
  if (STORNO_ELIGIBLE_MODES.has(saleDoc.resultMode)) {
    return res.status(409).json({
      error: 'Doklad je platne zaevidovany v eKase — najprv sprav STORNO, refiskalizacia by vyrobila druhy doklad na tu istu trzbu',
      fiscal: toFiscalResponse(saleDoc),
    });
  }

  // Zmrazený payload pôvodného pokusu je jediný povolený zdroj položiek/súm.
  const savedPayload = parseJsonField(saleDoc.requestJson);
  const savedData = savedPayload && savedPayload.request ? savedPayload.request.data : null;
  if (
    !savedData
    || !Array.isArray(savedData.items) || !savedData.items.length
    || !Array.isArray(savedData.payments) || !savedData.payments.length
  ) {
    return res.status(400).json({
      error: 'Povodny fiškálny payload sa neda rozparsovat (chybaju polozky alebo platby) — '
        + 'refiskalizacia by musela doklad rekonstruovat z aktualneho menu, co nie je bezpecne',
      fiscal: toFiscalResponse(saleDoc),
    });
  }

  const activeCashRegisterCode = await getActiveCashRegisterCode();
  const requestPayload = {
    request: {
      data: {
        ...savedData,
        // Rovnaká precedencia ako `buildStornoCashRegisterRequestContext`:
        // zmrazený kód má prednosť, aktívny je len fallback.
        cashRegisterCode: String(savedData.cashRegisterCode || activeCashRegisterCode || '').trim(),
      },
      externalId: buildPaymentExternalId(payment.orderId, { salt: generatePaymentExternalIdSalt() }),
    },
    print: {
      // Rovnaká precedencia ako `buildStornoCashRegisterRequestContext`:
      // zmrazená tlačiareň, inak aktuálna konfigurácia.
      printerName: (savedPayload.print && savedPayload.print.printerName)
        || saleDoc.printerName
        || getPortosConfig().printerName,
    },
  };

  try {
    // Sadzby berieme z toho, čo naozaj pôjde do Portosu (zmrazené položky).
    // U neplatiteľa sú všetky 0 → guard je no-op.
    assertSupportedVatRates(requestPayload.request.data.items);
  } catch (error) {
    if (error && error.status) return res.status(error.status).json(error.body);
    throw error;
  }

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

  // Starý riadok NEMAŽEME — len ho odstavíme z aktívneho pohľadu. `sourceType`
  // je zároveň kľúč, cez ktorý sale doc hľadajú storno/history/admin, takže
  // 'payment_superseded' ho spoľahlivo vyradí, ale externalId + receiptId
  // ostanú v DB dohľadateľné (a nevzniká FK problém s offline_paragons).
  const supersededExternalIds = docsForPayment
    .filter((doc) => doc.sourceType === 'payment')
    .map((doc) => doc.externalId);
  await db.update(fiscalDocuments)
    .set({ sourceType: 'payment_superseded', updatedAt: new Date() })
    .where(and(
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
      oldExternalId: saleDoc.externalId,
      oldReceiptId: saleDoc.receiptId || saleDoc.okp || null,
      oldResultMode: saleDoc.resultMode,
      supersededExternalIds,
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

import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import {
  buildPaymentStornoExternalId,
  parsePaymentExternalIdSalt,
} from '../fiscal-payment.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { isPortosEnabled } from '../portos.js';

import { STORNO_ELIGIBLE_MODES, parseJsonField } from './shared.js';

// SECURITY FIX: was unprotected — exposed full Portos request/response JSON
// (including OKP, signature material, and the Portos requestId used for
// reconciliation). Restrict to manazer/admin.
export async function fiscalGetHandler(req, res) {
  const paymentId = Number.parseInt(req.params.id, 10);
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });

  const docs = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.paymentId, paymentId));
  if (!docs.length) return res.status(404).json({ error: 'Fiskalny doklad nenajdeny' });

  const document = docs.find((d) => d.sourceType === 'payment') || docs[0];
  // Compute the EXPECTED storno externalId aligned with the sale doc's salt,
  // so the admin UI can show the right id even before the storno exists.
  const saltFromSale = parsePaymentExternalIdSalt(document?.externalId);
  const stornoExternalId = buildPaymentStornoExternalId(payment.orderId, { salt: saltFromSale });
  // Storno musí patriť PRÁVE TOMUTO predajnému dokladu. Po `change-method` má
  // platba aj starý (vystornovaný, `payment_superseded`) doklad — jeho storno
  // sa nesmie počítať ako storno nového dokladu, inak by admin videl
  // `stornoDone: true` a nový doklad by sa nedal stornovať vôbec.
  // Fallback na `sourceType` držíme pre staré riadky s iným formátom
  // externalId — ale len keď žiadny superseded doklad neexistuje.
  const stornoRow = docs.find((d) => d.sourceType === 'storno' && d.externalId === stornoExternalId)
    || (docs.some((d) => d.sourceType === 'payment_superseded')
      ? null
      : docs.find((d) => d.sourceType === 'storno'));

  const referenceReceiptId = document.receiptId || document.okp;
  // Doklad z PREDCHÁDZAJÚCEJ identity (iný kód pokladne / DKP) sa už nedá
  // stornovať — Portos ten alias nepozná (viď fiscal-storno.js guard).
  const activeCashRegisterCode = await getActiveCashRegisterCode();
  const docCashRegisterCode = String(document.cashRegisterCode || '').trim();
  const foreignCashRegister = Boolean(
    docCashRegisterCode && activeCashRegisterCode && docCashRegisterCode !== activeCashRegisterCode,
  );
  const stornoEligible = Boolean(
    isPortosEnabled()
    && STORNO_ELIGIBLE_MODES.has(document.resultMode)
    && referenceReceiptId
    && !stornoRow
    && !foreignCashRegister,
  );

  res.json({
    ...document,
    processDate: document.processDate ? new Date(document.processDate).toISOString() : null,
    requestJson: parseJsonField(document.requestJson),
    responseJson: parseJsonField(document.responseJson),
    stornoEligible,
    stornoBlockedReason: !stornoEligible && foreignCashRegister ? 'foreign_cash_register' : null,
    activeCashRegisterCode,
    stornoDone: Boolean(stornoRow),
    stornoExternalId,
  });
}

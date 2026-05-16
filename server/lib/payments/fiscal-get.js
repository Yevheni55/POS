import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import {
  buildPaymentStornoExternalId,
  parsePaymentExternalIdSalt,
} from '../fiscal-payment.js';
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
  const stornoRow = docs.find((d) => d.sourceType === 'storno');
  // Compute the EXPECTED storno externalId aligned with the sale doc's salt,
  // so the admin UI can show the right id even before the storno exists.
  const saltFromSale = parsePaymentExternalIdSalt(document?.externalId);
  const stornoExternalId = buildPaymentStornoExternalId(payment.orderId, { salt: saltFromSale });

  const referenceReceiptId = document.receiptId || document.okp;
  const stornoEligible = Boolean(
    isPortosEnabled()
    && STORNO_ELIGIBLE_MODES.has(document.resultMode)
    && referenceReceiptId
    && !stornoRow,
  );

  res.json({
    ...document,
    processDate: document.processDate ? new Date(document.processDate).toISOString() : null,
    requestJson: parseJsonField(document.requestJson),
    responseJson: parseJsonField(document.responseJson),
    stornoEligible,
    stornoDone: Boolean(stornoRow),
    stornoExternalId,
  });
}

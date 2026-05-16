import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import {
  explainPortosPrintCopyFailure,
  isPortosEnabled,
  isPrintCopyResponseSuccess,
  printCopyByExternalId,
} from '../portos.js';

export async function receiptCopyHandler(req, res) {
  const paymentId = Number.parseInt(req.params.id, 10);
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });

  if (!isPortosEnabled()) {
    return res.status(400).json({ error: 'Portos nie je zapnuty' });
  }

  // Always pick the doc by sourceType=payment + paymentId — externalId
  // formát už nie je deterministic z orderId (salt suffix), takže buildXxx
  // už nie je dostatočný kľúč. Stored externalId z DB je use-this.
  const docs = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.paymentId, paymentId));
  const fallback = docs.find((d) => d.sourceType === 'payment') || docs[0];
  if (!fallback?.externalId) {
    return res.status(404).json({ error: 'Fiskalny doklad nema dostupny externalId' });
  }

  try {
    const storedCode = String(fallback.cashRegisterCode || '').trim();
    const result = await printCopyByExternalId(fallback.externalId, {
      cashRegisterCode: storedCode || undefined,
    });
    if (!isPrintCopyResponseSuccess(result)) {
      const hint = explainPortosPrintCopyFailure(result.raw);
      const status = result.httpStatus && result.httpStatus >= 400 && result.httpStatus < 600
        ? result.httpStatus
        : 502;
      return res.status(status).json({
        ok: false,
        printed: false,
        externalId: fallback.externalId,
        error: hint || result.raw?.detail || result.raw?.title || 'Kopiu dokladu sa nepodarilo vytlacit',
        cashRegisterCodeUsed: storedCode || null,
      });
    }
    res.status(result.httpStatus || 200).json({
      ok: true,
      printed: result.printed,
      externalId: fallback.externalId,
    });
  } catch (error) {
    console.error('Receipt copy error:', error);
    res.status(503).json({ error: 'Kopiu dokladu sa nepodarilo vytlacit' });
  }
}

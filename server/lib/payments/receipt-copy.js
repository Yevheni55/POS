import { eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { fiscalDocuments, payments } from '../../db/schema.js';
import { logEvent } from '../audit.js';
import {
  explainPortosPrintCopyFailure,
  isPortosEnabled,
  isPrintCopyResponseSuccess,
  printCopyByExternalId,
} from '../portos.js';

const MANAGER_ROLES = new Set(['manazer', 'admin']);

/**
 * Patrí platba do PREBIEHAJÚCEHO prevádzkového dňa?
 *
 * Deň režeme o 04:00 Europe/Bratislava — rovnaká hranica ako attendance
 * auto-close a denná záloha v server.js. Kalendárna polnoc by čašníkovi
 * o 00:30 zablokovala kópiu bloku, ktorý pred pol hodinou sám vytlačil.
 *
 * Počíta to Postgres, nie Node — `payments.created_at` je naivný timestamp
 * v UTC, takže prevod musí ísť cez `AT TIME ZONE 'UTC' AT TIME ZONE '...'`
 * (server beží v Dockeri v UTC, vývojársky stroj nie).
 */
async function isCurrentBusinessDayPayment(paymentId) {
  const result = await db.execute(sql`
    SELECT (
      ((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Bratislava') - INTERVAL '4 hours')::date
      = ((NOW() AT TIME ZONE 'Europe/Bratislava') - INTERVAL '4 hours')::date
    ) AS same_day
    FROM payments
    WHERE id = ${paymentId}
  `);
  const row = (result.rows || result)[0];
  return row?.same_day === true;
}

export async function receiptCopyHandler(req, res) {
  const paymentId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId)) {
    return res.status(400).json({ error: 'Neplatne ID platby' });
  }
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return res.status(404).json({ error: 'Platba nenajdena' });

  // Kópia fiškálneho dokladu je fiškálna tlač — čašník ju smie spraviť len
  // pre doklad z prebiehajúceho prevádzkového dňa (hosť stratil blok, tlač
  // sa zasekla). Dotlač historických dokladov (kontrola, reklamácia) ostáva
  // manažérovi/adminovi cez admin sekciu Fiškálne doklady.
  if (!MANAGER_ROLES.has(req.user?.role)) {
    if (!(await isCurrentBusinessDayPayment(paymentId))) {
      return res.status(403).json({
        error: 'Kopiu starsieho dokladu moze vytlacit len manazer',
      });
    }
  }

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
    // Audit: kópia dokladu je fiškálny úkon — musí byť dohľadateľné KTO ju
    // dotlačil a ku ktorému dokladu. Best-effort, zlyhanie logu nezhodí tlač.
    await logEvent(db, {
      orderId: payment.orderId,
      type: 'fiscal_receipt_copy',
      payload: {
        paymentId,
        externalId: fallback.externalId,
        cashRegisterCode: storedCode || null,
        role: req.user?.role || null,
      },
      staffId: req.user.id,
    }).catch((e) => console.error('[Portos] receipt-copy audit log error:', e?.message || e));

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

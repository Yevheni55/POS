// server/routes/paragons.js
//
// Offline paragón flow — náhradný doklad pre eKasa (zákon § 10, č. 289/2008).
//
// Endpoints:
//   POST /api/paragons          → vystaviť paragón (Portos je nedostupný)
//   GET  /api/paragons          → list (default: pending; ?status=all|registered|failed)
//   POST /api/paragons/:id/retry → manuálny retry registrácie konkrétneho paragónu
//   POST /api/paragons/sync     → vynútený sync všetkých pending (admin button)
//
// Hookuje sa do payment-flow tak: keď POS detekuje že Portos je down,
// namiesto klasického fiškálneho payment-u vystaví paragón cez POST /api/paragons.
// Background worker (paragon-sync.js) potom registruje pending paragóny postupne.

import { Router } from 'express';
import { eq, sql, and, desc, lte, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { offlineParagons, fiscalDocuments, orders, payments } from '../db/schema.js';
import { requireRole } from '../middleware/requireRole.js';
import {
  registerParagon,
  isPortosEnabled,
  PortosTransportError,
} from '../lib/portos.js';
import {
  buildParagonRequestContext,
  generatePaymentExternalIdSalt,
} from '../lib/fiscal-payment.js';
import { isVatRegisteredBusiness } from '../lib/vat-registration.js';
import { getActiveCashRegisterCode } from '../lib/active-cash-register.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');
const anyStaff = requireRole('cisnik', 'manazer', 'admin');

const MAX_ATTEMPTS = 100; // ~ pri 60s intervale = 100 minút aktívneho retry
const MIN_RETRY_INTERVAL_MS = 30_000; // anti-thundering-herd

/**
 * Generate next monotonic paragón number "P-000001" pre celý systém.
 *
 * KRITICKÉ: musí byť strict-monotonic bez medzier (zákon § 10).
 * Použijeme `SELECT FOR UPDATE` lock na max() z existujúcich + insert
 * v jednej transakcii. Drizzle nemá natívne `FOR UPDATE`, takže
 * použijeme raw SQL pre tento jeden query.
 */
async function nextParagonNumber(tx) {
  const result = await tx.execute(sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(paragon_number FROM 3) AS INTEGER)), 0) + 1 AS next_num
    FROM offline_paragons
  `);
  const nextNum = Number(result.rows[0]?.next_num || 1);
  return 'P-' + String(nextNum).padStart(6, '0');
}

/**
 * POST /api/paragons
 *
 * Body:
 *   { orderId, paymentId?, items, paymentMethod, totalAmount, discountAmount?, reason? }
 *
 * Returns: { paragonId, paragonNumber, requestPayloadJson }
 *
 * Vystaví paragón LOKÁLNE (žiadne volanie Portos teraz — predpokladá sa že je
 * nedostupný). Status='pending'. Background sync ho dohne po obnove.
 */
router.post('/', anyStaff, async (req, res) => {
  try {
    const {
      orderId,
      paymentId,
      items,
      paymentMethod,
      totalAmount,
      discountAmount = 0,
      reason = 'portos_unavailable',
    } = req.body || {};

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Žiadne položky' });
    }
    if (!paymentMethod) {
      return res.status(400).json({ error: 'Chýba spôsob platby' });
    }
    if (totalAmount == null) {
      return res.status(400).json({ error: 'Chýba suma' });
    }

    const forceZeroVat = !(await isVatRegisteredBusiness());
    const cashRegisterCode = await getActiveCashRegisterCode();
    const externalIdSalt = generatePaymentExternalIdSalt();

    // Atomicky alokuj poradové číslo + vlož snapshot
    const inserted = await db.transaction(async (tx) => {
      const paragonNumber = await nextParagonNumber(tx);
      // issuedAt = TERAZ — moment kedy čašník vystavil náhradný doklad
      // pre zákazníka. Tento timestamp ide do Portos payloadu ako issueDate
      // a zostane konzistentný aj počas neskorších sync retries (Portos
      // tomu hovorí "spätná registrácia").
      const issuedAt = new Date();

      const ctx = buildParagonRequestContext({
        paragonNumber,
        issuedAt,
        items,
        discountAmount: Number(discountAmount) || 0,
        method: paymentMethod,
        expectedTotal: Number(totalAmount),
        cashRegisterCode,
        forceZeroVat,
        externalIdSalt,
      });

      const [row] = await tx
        .insert(offlineParagons)
        .values({
          orderId: orderId || null,
          paymentId: paymentId || null,
          paragonNumber,
          requestPayloadJson: JSON.stringify(ctx),
          totalAmount: String(Number(totalAmount).toFixed(2)),
          paymentMethod,
          status: 'pending',
          reason,
          staffId: req.user?.id || null,
        })
        .returning();
      return row;
    });

    return res.json({
      ok: true,
      paragonId: inserted.id,
      paragonNumber: inserted.paragonNumber,
      requestPayloadJson: inserted.requestPayloadJson,
    });
  } catch (err) {
    console.error('POST /api/paragons error:', err);
    return res.status(500).json({ error: err.message || 'Vystavenie paragónu zlyhalo' });
  }
});

/**
 * GET /api/paragons?status=pending|registered|failed|all
 *
 * Vracia zoznam paragónov pre admin / kontrolu.
 */
router.get('/', anyStaff, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending').toLowerCase();
    const baseQuery = db
      .select()
      .from(offlineParagons)
      .orderBy(desc(offlineParagons.issuedAt))
      .limit(200);

    const rows = status === 'all'
      ? await baseQuery
      : await db
          .select()
          .from(offlineParagons)
          .where(eq(offlineParagons.status, status))
          .orderBy(desc(offlineParagons.issuedAt))
          .limit(200);

    return res.json({ paragons: rows });
  } catch (err) {
    console.error('GET /api/paragons error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/paragons/:id/retry
 *
 * Manuálny retry registrácie konkrétneho paragónu. Použiteľné pre admina
 * keď background sync hovori "failed" a treba forsírovať.
 */
router.post('/:id/retry', mgr, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatné ID' });
  try {
    const result = await registerOneParagon(id);
    return res.json(result);
  } catch (err) {
    console.error('POST /api/paragons/:id/retry error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/paragons/sync
 *
 * Vynútený sync všetkých pending paragónov. Manuálny trigger pre prípad
 * že background worker nestiha alebo bol vypnutý.
 */
router.post('/sync', mgr, async (req, res) => {
  try {
    const result = await syncPendingParagons();
    return res.json(result);
  } catch (err) {
    console.error('POST /api/paragons/sync error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Sync helpers (used by background worker too) ──────────────────────────

/**
 * Pokúsi sa zaregistrovať konkrétny paragón cez Portos.
 * Pri úspechu: status='registered', vytvorí fiscal_documents záznam.
 * Pri zlyhaní: status zostáva 'pending', increment attempts + lastError.
 */
export async function registerOneParagon(paragonId) {
  if (!isPortosEnabled()) {
    return { ok: false, skipped: true, reason: 'portos_disabled' };
  }

  const [paragon] = await db
    .select()
    .from(offlineParagons)
    .where(eq(offlineParagons.id, paragonId))
    .limit(1);
  if (!paragon) return { ok: false, reason: 'not_found' };
  if (paragon.status === 'registered') {
    return { ok: true, alreadyRegistered: true };
  }

  let requestPayload;
  try {
    requestPayload = JSON.parse(paragon.requestPayloadJson);
  } catch (e) {
    await db
      .update(offlineParagons)
      .set({
        status: 'failed',
        lastError: 'Invalid request payload JSON: ' + e.message,
        lastAttemptAt: new Date(),
      })
      .where(eq(offlineParagons.id, paragonId));
    return { ok: false, reason: 'invalid_payload' };
  }

  // Incrementuj attempts pred volaním (aj keď request zlyhá v transport vrstve)
  await db
    .update(offlineParagons)
    .set({
      attempts: sql`${offlineParagons.attempts} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(eq(offlineParagons.id, paragonId));

  let portosResult;
  try {
    portosResult = await registerParagon(requestPayload);
  } catch (err) {
    const transport = err instanceof PortosTransportError;
    await db
      .update(offlineParagons)
      .set({
        lastError: (transport ? 'transport: ' : 'unexpected: ') + (err.message || ''),
      })
      .where(eq(offlineParagons.id, paragonId));
    return { ok: false, reason: 'transport_error', message: err.message };
  }

  if (portosResult.resultMode !== 'online_success') {
    // Portos neúspech: 4xx, 5xx, validation_error, blocked
    await db
      .update(offlineParagons)
      .set({
        lastError: `Portos: ${portosResult.resultMode} ${portosResult.errorCode || ''} ${portosResult.errorDetail || ''}`.trim(),
      })
      .where(eq(offlineParagons.id, paragonId));

    // Po MAX_ATTEMPTS označ ako 'failed' (manuálny review)
    if ((paragon.attempts || 0) + 1 >= MAX_ATTEMPTS) {
      await db
        .update(offlineParagons)
        .set({ status: 'failed' })
        .where(eq(offlineParagons.id, paragonId));
    }
    return { ok: false, reason: 'portos_error', portosResult };
  }

  // Úspech: zaznamenaj fiscal_document + linkni cez fiscalDocumentId
  const [fd] = await db
    .insert(fiscalDocuments)
    .values({
      sourceType: 'paragon',
      sourceId: paragonId,
      orderId: paragon.orderId,
      paymentId: paragon.paymentId,
      externalId: requestPayload.request.externalId,
      cashRegisterCode: requestPayload.request.data.cashRegisterCode || '',
      requestType: 'paragon',
      httpStatus: portosResult.httpStatus,
      resultMode: portosResult.resultMode,
      isSuccessful: portosResult.isSuccessful,
      receiptId: portosResult.receiptId,
      receiptNumber: portosResult.receiptNumber,
      okp: portosResult.okp,
      portosRequestId: portosResult.portosRequestId,
      printerName: requestPayload.print?.printerName || null,
      processDate: portosResult.processDate ? new Date(portosResult.processDate) : null,
      requestJson: portosResult.requestJson,
      responseJson: portosResult.responseJson,
      errorCode: portosResult.errorCode,
      errorDetail: portosResult.errorDetail || '',
    })
    .returning({ id: fiscalDocuments.id });

  await db
    .update(offlineParagons)
    .set({
      status: 'registered',
      registeredAt: new Date(),
      fiscalDocumentId: fd.id,
      lastError: null,
    })
    .where(eq(offlineParagons.id, paragonId));

  return { ok: true, paragonId, fiscalDocumentId: fd.id, receiptId: portosResult.receiptId };
}

/**
 * Sync všetkých pending paragónov (s rate limit voči thundering herd
 * pri prvom obnovení Portos).
 */
export async function syncPendingParagons() {
  if (!isPortosEnabled()) return { ok: false, reason: 'portos_disabled' };

  // Iba paragóny ktoré sú aspoň MIN_RETRY_INTERVAL_MS staré (od posledného pokusu)
  // alebo nemali pokus.
  const cutoff = new Date(Date.now() - MIN_RETRY_INTERVAL_MS);
  const pending = await db
    .select({ id: offlineParagons.id })
    .from(offlineParagons)
    .where(
      and(
        eq(offlineParagons.status, 'pending'),
        sql`(${offlineParagons.lastAttemptAt} IS NULL OR ${offlineParagons.lastAttemptAt} < ${cutoff})`,
      ),
    )
    .orderBy(offlineParagons.issuedAt)
    .limit(50);

  const results = { total: pending.length, registered: 0, failed: 0, errors: [] };
  for (const p of pending) {
    try {
      const r = await registerOneParagon(p.id);
      if (r.ok) results.registered++;
      else { results.failed++; if (r.reason) results.errors.push({ id: p.id, reason: r.reason, message: r.message || r.portosResult?.errorDetail }); }
    } catch (err) {
      results.failed++;
      results.errors.push({ id: p.id, error: err.message });
    }
  }
  return results;
}

export default router;

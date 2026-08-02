import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { companyProfiles } from '../db/schema.js';
import {
  hasUsablePortosIdentity,
  mapPortosIdentityFromStatus,
  mergePortosIdentityIntoProfileRow,
} from '../lib/company-profile-from-portos.js';
import { getStatus, isPortosEnabled } from '../lib/portos.js';
import { runPortosProfileSync } from '../lib/portos-sync-job.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { updateCompanyProfileSchema } from '../schemas/company-profile.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

const EMPTY_PROFILE = {
  businessName: '',
  ico: '',
  dic: '',
  icDph: '',
  registeredAddress: '',
  branchName: '',
  branchAddress: '',
  cashRegisterCode: '',
  contactPhone: '',
  contactEmail: '',
};

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeComparableText(value) {
  return normalizeText(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/slovenska republika/gi, '')
    .replace(/[,.]/g, ' ')
    .replace(/\b(\d{3})\s?(\d{2})\b/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function serializeProfile(row) {
  if (!row) return { ...EMPTY_PROFILE };

  return {
    businessName: row.businessName,
    ico: row.ico,
    dic: row.dic,
    icDph: row.icDph,
    registeredAddress: row.registeredAddress,
    branchName: row.branchName,
    branchAddress: row.branchAddress,
    cashRegisterCode: row.cashRegisterCode,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
  };
}

async function loadProfileRow() {
  const [row] = await db.select().from(companyProfiles).orderBy(desc(companyProfiles.id)).limit(1);
  return row || null;
}

/**
 * Zmena režimu DPH je udalosť, ktorá nesmie byť neviditeľná: keď z profilu
 * zmizne IČ DPH, `isVatRegisteredBusiness()` začne vracať false a KAŽDÝ ďalší
 * doklad ide s vatRate 0. Logujeme oba smery, nech je v `docker logs` presný
 * čas prepnutia.
 */
function warnOnVatIdentityChange(existingRow, nextRow, source) {
  const before = normalizeText(existingRow?.icDph);
  const after = normalizeText(nextRow?.icDph);
  if (before === after) return;

  if (before && !after) {
    console.warn(
      `[VAT] IČ DPH sa MAŽE z profilu firmy (${source}): "${before}" → "" — ` +
      'POS od tejto chvíle fiškalizuje ako NEPLATITEĽ (všetky položky vatRate=0).',
    );
    return;
  }
  console.warn(
    `[VAT] IČ DPH sa mení v profile firmy (${source}): "${before || '(prázdne)'}" → "${after || '(prázdne)'}".`,
  );
}

function buildComparison(local, portos) {
  const fields = [
    'businessName',
    'ico',
    'dic',
    'icDph',
    'registeredAddress',
    'branchName',
    'branchAddress',
    'cashRegisterCode',
  ];

  const matches = {};
  let mismatchCount = 0;

  for (const field of fields) {
    const same = normalizeComparableText(local[field]) === normalizeComparableText(portos[field]);
    matches[field] = same;
    if (!same) mismatchCount += 1;
  }

  return {
    mismatchCount,
    matches,
    lastComparedAt: new Date().toISOString(),
  };
}

router.get('/', async (req, res) => {
  const refresh = String(req.query.refresh || '').toLowerCase();
  if (refresh === '1' || refresh === 'true') {
    if (isPortosEnabled()) {
      try {
        await runPortosProfileSync({ timeoutMs: 8000 });
      } catch {
        /* ak Portos zlyhá, vrátime posledné známe dáta z DB */
      }
    }
  }
  try {
    res.json(serializeProfile(await loadProfileRow()));
  } catch (error) {
    console.error('Company profile load error:', error);
    res.status(503).json({
      error: 'Nepodarilo sa načítať profil firmy',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * PUT je ZÁMERNE contact-only. Identita firmy (IČ DPH, kód pokladne, názov,
 * adresy) sa NIKDY nepreberá z tela requestu — vlastní ju Portos a zapisuje ju
 * iba `runPortosProfileSync` / POST /sync-from-portos.
 *
 * Bez tohto guardu stačilo, aby manažér uložil Nastavenia v momente, keď GET
 * profilu zlyhal: admin UI poslalo icDph:'' a dummy cashRegisterCode
 * z localStorage DEFAULTS, POS prepol na 0 % DPH a razil na neexistujúci DKP.
 * Schéma tie kľúče už zahadzuje (.strip()), toto je druhá vrstva — route
 * skladá update-set explicitne, takže ani rozšírená schéma sa sem nepretlačí.
 */
router.put('/', mgr, validate(updateCompanyProfileSchema), async (req, res) => {
  const contacts = {
    contactPhone: normalizeText(req.body.contactPhone),
    contactEmail: normalizeText(req.body.contactEmail),
  };

  try {
    const existing = await loadProfileRow();

    if (!existing) {
      // Identifikačné stĺpce majú v schéme NOT NULL DEFAULT '' — riadok vznikne
      // s prázdnou identitou a doplní ju najbližší Portos profile sync.
      const [created] = await db.insert(companyProfiles)
        .values({ ...contacts, updatedAt: new Date() })
        .returning();
      return res.json(serializeProfile(created));
    }

    const [updated] = await db.update(companyProfiles)
      .set({ ...contacts, updatedAt: new Date() })
      .where(eq(companyProfiles.id, existing.id))
      .returning();

    return res.json(serializeProfile(updated));
  } catch (error) {
    console.error('Company profile update error:', error);
    return res.status(503).json({
      error: 'Nepodarilo sa uložiť kontakty na doklade',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

/** Prepíše identifikačné polia z aktuálneho Portos (po zmene firmy / eKasa). Kontakty z DB ponechá. */
router.post('/sync-from-portos', mgr, async (req, res) => {
  try {
    const status = await getStatus();
    if (!hasUsablePortosIdentity(status)) {
      return res.status(503).json({
        error: 'Portos nevrátil použiteľnú identitu prevádzky',
        detail: status.errors?.identity || 'Skontrolujte PORTOS_BASE_URL a registráciu v Portos.',
      });
    }

    const portosFields = mapPortosIdentityFromStatus(status);
    const existing = await loadProfileRow();
    const merged = mergePortosIdentityIntoProfileRow(portosFields, existing);
    warnOnVatIdentityChange(existing, merged, 'POST /company-profile/sync-from-portos');

    if (!existing) {
      const [created] = await db.insert(companyProfiles)
        .values({ ...merged, updatedAt: new Date() })
        .returning();
      return res.json({
        profile: serializeProfile(created),
        source: 'portos',
        updated: true,
      });
    }

    const [updated] = await db.update(companyProfiles)
      .set({ ...merged, updatedAt: new Date() })
      .where(eq(companyProfiles.id, existing.id))
      .returning();

    return res.json({
      profile: serializeProfile(updated),
      source: 'portos',
      updated: true,
    });
  } catch (error) {
    console.error('Company profile sync-from-portos error:', error);
    return res.status(503).json({
      error: 'Synchronizácia z Portos zlyhala',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/portos-compare', mgr, async (req, res) => {
  try {
    const [row, status] = await Promise.all([
      loadProfileRow(),
      getStatus(),
    ]);

    const local = serializeProfile(row);
    const portos = mapPortosIdentityFromStatus(status);

    res.json({
      local,
      portos,
      summary: buildComparison(local, portos),
      diagnostics: {
        serviceReachable: status.serviceReachable,
        connectivity: status.connectivity,
        storage: status.storage,
        printer: status.printer,
        certificate: status.certificate,
        printerName: status.printerName,
        baseUrl: status.baseUrl,
      },
    });
  } catch (error) {
    console.error('Company profile compare error:', error);
    res.status(503).json({ error: 'Nepodarilo sa nacitat Portos porovnanie', detail: error.message });
  }
});

export default router;

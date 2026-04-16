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
  res.json(serializeProfile(await loadProfileRow()));
});

router.put('/', mgr, validate(updateCompanyProfileSchema), async (req, res) => {
  const existing = await loadProfileRow();

  if (!existing) {
    const [created] = await db.insert(companyProfiles)
      .values(req.body)
      .returning();
    return res.json(serializeProfile(created));
  }

  const [updated] = await db.update(companyProfiles)
    .set({ ...req.body, updatedAt: new Date() })
    .where(eq(companyProfiles.id, existing.id))
    .returning();

  res.json(serializeProfile(updated));
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

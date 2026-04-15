import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { companyProfiles } from '../db/schema.js';
import { getStatus } from '../lib/portos.js';
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

function buildAddress(address) {
  if (!address || typeof address !== 'object') return '';

  const street = [address.streetName, address.buildingNumber, address.propertyRegistrationNumber]
    .filter(Boolean)
    .join(' ')
    .trim();
  const locality = [
    address.deliveryAddress?.postalCode || address.postalCode || '',
    address.municipality || '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  return [street, locality, address.country]
    .filter(Boolean)
    .join(', ')
    .trim();
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

function mapPortosIdentity(status) {
  const identity = status?.identity || {};
  const organizationUnit = identity.organizationUnit || {};

  return {
    businessName: normalizeText(identity.corporateBodyFullName),
    ico: normalizeText(identity.ico),
    dic: normalizeText(identity.dic),
    icDph: normalizeText(identity.icdph),
    registeredAddress: buildAddress(identity.physicalAddress),
    branchName: normalizeText(organizationUnit.organizationUnitName),
    branchAddress: buildAddress(organizationUnit.physicalAddress),
    cashRegisterCode: normalizeText(status?.cashRegisterCode || organizationUnit.cashRegisterCode),
  };
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

router.get('/portos-compare', mgr, async (req, res) => {
  try {
    const [row, status] = await Promise.all([
      loadProfileRow(),
      getStatus(),
    ]);

    const local = serializeProfile(row);
    const portos = mapPortosIdentity(status);

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

import { z } from 'zod';

/**
 * PUT /api/company-profile smie meniť IBA kontakty tlačené na doklade.
 *
 * Identifikačné polia (businessName, ico, dic, icDph, adresy, cashRegisterCode)
 * sú Portos-owned — jediní legitímni zapisovači sú `runPortosProfileSync`
 * (server/lib/portos-sync-job.js) a POST /api/company-profile/sync-from-portos.
 *
 * PREČO: admin UI posielalo celý profil pri KAŽDOM uložení Nastavení a keď
 * GET /company-profile zlyhal, readonly inputy ostali naplnené z localStorage
 * DEFAULTS (icDph='' + dummy kód pokladne 88812345678900001). Taký payload
 * ticho prepol POS do režimu neplatiteľa DPH (forceZeroVat=true) a razil na
 * neexistujúci DKP. `.strip()` zahodí všetky ostatné kľúče ešte pred routou,
 * takže stale klientsky payload nemá ako dosiahnuť DB.
 */
export const updateCompanyProfileSchema = z.object({
  contactPhone: z.string().trim().max(50).default(''),
  contactEmail: z.string().trim().max(120).default(''),
}).strip();

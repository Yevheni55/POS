import { desc } from 'drizzle-orm';

import { db } from '../db/index.js';
import { companyProfiles } from '../db/schema.js';

/**
 * Firma bez IČ DPH je neplatiteľ DPH. Portos pre takú firmu akceptuje iba riadky s `vatRate = 0`.
 * Profil sa synchronizuje z Portos identity (`icdph`), preto je tu source of truth.
 */
export async function isVatRegisteredBusiness() {
  try {
    const [row] = await db
      .select()
      .from(companyProfiles)
      .orderBy(desc(companyProfiles.id))
      .limit(1);
    const icDph = String(row?.icDph || '').trim();
    return icDph.length > 0;
  } catch {
    return true;
  }
}

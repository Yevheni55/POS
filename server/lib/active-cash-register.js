import { desc } from 'drizzle-orm';

import { db } from '../db/index.js';
import { companyProfiles } from '../db/schema.js';
import { getPortosConfig } from './portos.js';

/**
 * Efektívny kód pokladne pre volania do Portos (registrácia / lookup).
 *
 * Zdroj pravdy je `company_profiles.cash_register_code` v DB, ktorý sa pri štarte a každých ~5 min
 * synchronizuje z `/api/v1/identities` v Portos. Vďaka tomu po zmene firmy alebo pokladne v Portos
 * POS automaticky prejde na nový kód aj bez úpravy `.env`.
 *
 * Fallback: `PORTOS_CASH_REGISTER_CODE` zo .env (aby sa nestratili SSR/test prostredia a staré inštalácie).
 */
export async function getActiveCashRegisterCode() {
  const envCode = String(getPortosConfig().cashRegisterCode || '').trim();
  try {
    const [row] = await db
      .select()
      .from(companyProfiles)
      .orderBy(desc(companyProfiles.id))
      .limit(1);
    const dbCode = String(row?.cashRegisterCode || '').trim();
    if (dbCode) return dbCode;
  } catch {
    /* ak DB zlyhá, padneme do env */
  }
  return envCode;
}

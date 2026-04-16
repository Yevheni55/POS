import { z } from 'zod';

/**
 * Identifikačné polia sa synchronizujú z Portos a môžu prísť prázdne
 * (napr. organizationUnitName = null). POS nesmie zlyhať na PUT profilu
 * len preto, že Portos nevrátil vedľajšie pole — uloží to, čo je.
 */
export const updateCompanyProfileSchema = z.object({
  businessName: z.string().trim().max(150).default(''),
  ico: z.string().trim().max(32).default(''),
  dic: z.string().trim().max(32).default(''),
  icDph: z.string().trim().max(32).default(''),
  registeredAddress: z.string().trim().max(250).default(''),
  branchName: z.string().trim().max(150).default(''),
  branchAddress: z.string().trim().max(250).default(''),
  cashRegisterCode: z.string().trim().max(32).default(''),
  contactPhone: z.string().trim().max(50).default(''),
  contactEmail: z.string().trim().max(120).default(''),
});

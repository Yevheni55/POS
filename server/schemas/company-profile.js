import { z } from 'zod';

export const updateCompanyProfileSchema = z.object({
  businessName: z.string().trim().min(1).max(150),
  ico: z.string().trim().max(32).default(''),
  dic: z.string().trim().min(1).max(32),
  icDph: z.string().trim().max(32).default(''),
  registeredAddress: z.string().trim().min(1).max(250),
  branchName: z.string().trim().min(1).max(150),
  branchAddress: z.string().trim().min(1).max(250),
  cashRegisterCode: z.string().trim().min(1).max(32),
  contactPhone: z.string().trim().max(50).default(''),
  contactEmail: z.string().trim().max(120).default(''),
});

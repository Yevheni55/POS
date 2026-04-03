import { z } from 'zod';

export const createPaymentSchema = z.object({
  orderId: z.coerce.number().int().positive(),
  method: z.enum(['hotovost', 'karta']),
  amount: z.coerce.number().positive(),
});

import { z } from 'zod';

export const createPaymentSchema = z.object({
  orderId: z.coerce.number().int().positive(),
  method: z.enum(['hotovost', 'karta']),
  amount: z.coerce.number().positive(),
});

// Used by POST /payments/:id/change-method — operátor mení sposob už
// vytlaceneho dokladu (storno + novy doklad s novym sposobom).
export const changePaymentMethodSchema = z.object({
  newMethod: z.enum(['hotovost', 'karta']),
});

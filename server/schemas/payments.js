import { z } from 'zod';

// 'prevod' = okamžitá platba prevodom cez Portos QR platbu (PayMe/SBA).
// Fiškálne sa správa ako bezhotovostná platba (žiadne zaokrúhľovanie na 5 c).
export const PAYMENT_METHODS = ['hotovost', 'karta', 'prevod'];

export const createPaymentSchema = z.object({
  orderId: z.coerce.number().int().positive(),
  method: z.enum(['hotovost', 'karta', 'prevod']),
  amount: z.coerce.number().positive(),
});

// Used by POST /payments/:id/change-method — operátor mení sposob už
// vytlaceneho dokladu (storno + novy doklad s novym sposobom).
export const changePaymentMethodSchema = z.object({
  newMethod: z.enum(['hotovost', 'karta', 'prevod']),
});

// POST /payments/qr — spustenie QR platby pre otvorenú objednávku. Suma sa
// odvodí na serveri z objednávky (expectedTotal), nie z klienta — bráni
// podvrhnutiu nižšej sumy.
export const qrPaymentCreateSchema = z.object({
  orderId: z.coerce.number().int().positive(),
});

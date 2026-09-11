import { z } from 'zod';

// Telefón: slovenský/český formát alebo medzinárodný; medzery a pomlčky dovolené.
const phone = z.string().trim().min(9).max(30)
  .regex(/^\+?[0-9 ()\-]{9,30}$/, 'Telefón musí byť číslo, napr. +421 900 123 456');

const address = z.object({
  street: z.string().trim().min(3, 'Zadajte ulicu a číslo').max(150),
  city: z.string().trim().min(2).max(80),
  postCode: z.string().trim().regex(/^\d{3}\s?\d{2}$/, 'PSČ musí mať 5 číslic'),
  comment: z.string().trim().max(300).optional().default(''),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

export const quoteSchema = z.object({
  street: address.shape.street,
  city: address.shape.city,
  postCode: address.shape.postCode,
  lat: address.shape.lat,
  lon: address.shape.lon,
  scheduledFor: z.string().datetime().optional(),
});

export const createOnlineOrderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2, 'Zadajte meno').max(100),
    phone,
    email: z.string().trim().email('Neplatný e-mail').max(120).optional().or(z.literal('')),
  }),
  dropoff: address,
  items: z.array(z.object({
    menuItemId: z.number().int().positive(),
    qty: z.number().int().min(1).max(50),
    note: z.string().trim().max(120).optional().default(''),
  })).min(1, 'Košík je prázdny').max(60),
  note: z.string().trim().max(500).optional().default(''),
  paymentMethod: z.enum(['cash', 'transfer']).default('cash'),
  promiseId: z.string().trim().max(80).optional(),
  scheduledFor: z.string().datetime().optional(),
  // Súhlas so spracovaním údajov pre doručenie — bez neho sa objednať nedá.
  consent: z.literal(true, { errorMap: () => ({ message: 'Potvrďte súhlas so spracovaním údajov' }) }),
});

export const rejectOnlineOrderSchema = z.object({
  reason: z.string().trim().max(300).optional().default(''),
});

export const listOnlineOrdersQuerySchema = z.object({
  status: z.enum(['new', 'active', 'done', 'all']).optional().default('active'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

export const woltWebhookSchema = z.object({
  token: z.string().min(20),
});

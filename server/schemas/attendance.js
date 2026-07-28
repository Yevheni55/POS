import { z } from 'zod';

const pinValue = z.string().regex(/^\d{4,6}$/, 'PIN musi byt 4 az 6 cifier');

export const pinSchema = z.object({ pin: pinValue });

export const clockSchema = z.object({
  pin: pinValue,
  type: z.enum(['clock_in', 'clock_out']),
});

export const attendanceReasonSchema = z.enum(['forgot','wrong_time','shift_change','pin_failed','other']);

export const manualEventSchema = z.object({
  staffId: z.number().int().positive(),
  type: z.enum(['clock_in', 'clock_out']),
  at: z.string().datetime(),
  reason: attendanceReasonSchema,
  note: z.string().max(200).optional().default(''),
});

// Inline úprava existujúceho záznamu (PATCH /events/:id). Mení iba čas
// (at) — typ ostáva, lebo z UI sa edituje konkrétny príchod/odchod a
// preklopenie clock_in↔clock_out by rozbilo párovanie smien. Reason je
// povinný (rovnaký audit kontrakt ako manuálne pridanie). Úprava zachová
// id eventu, takže prípadný naviazaný payout (FK clock_out_event_id)
// ostáva neporušený — narozdiel od delete+create, kde by CASCADE payout
// zmazala a osirela by cashflow položka.
export const editEventSchema = z.object({
  at: z.string().datetime(),
  reason: attendanceReasonSchema,
  note: z.string().max(200).optional().default(''),
});

export const summaryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from musi byt YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to musi byt YYYY-MM-DD'),
}).refine((q) => q.from <= q.to, { message: 'from musi byt <= to' });

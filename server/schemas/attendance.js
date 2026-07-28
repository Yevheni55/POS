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

// ── Žiadosti o opravu dochádzky ─────────────────────────────────────────────
// Zamestnanec zadáva DEŇ a ČASY (HH:MM), nie plné timestampy — na termináli
// klepe do numerickej klávesnice, nie do date-time pickeru. Server si z toho
// poskladá bratislavský čas, aby sa nestalo, že sa deň prekĺzne cez UTC.
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Cas musi byt HH:MM');
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum musi byt YYYY-MM-DD');

export const attendanceRequestSchema = z.object({
  pin: pinValue,
  // 'late_pin'    — bol v praci skor, PIN zadal neskoro (opravuje sa prichod)
  // 'missing_day' — v ten den sa neoznacil vobec (doplna sa cela smena)
  type: z.enum(['late_pin', 'missing_day']),
  targetDate: isoDay,
  claimedIn: hhmm,
  // Odchod je povinny pri missing_day (inak by vznikla vecne otvorena smena)
  // a volitelny pri late_pin, kde sa opravuje len zaciatok.
  claimedOut: hhmm.optional().nullable(),
  note: z.string().max(300).optional().default(''),
}).refine(
  (r) => r.type !== 'missing_day' || !!r.claimedOut,
  { message: 'Pri zabudnutom dni treba zadat aj odchod', path: ['claimedOut'] },
).refine(
  (r) => !r.claimedOut || r.claimedOut > r.claimedIn,
  { message: 'Odchod musi byt neskor ako prichod', path: ['claimedOut'] },
);

export const requestReviewSchema = z.object({
  note: z.string().max(300).optional().default(''),
});

export const summaryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from musi byt YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to musi byt YYYY-MM-DD'),
}).refine((q) => q.from <= q.to, { message: 'from musi byt <= to' });

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { staff, attendanceEvents, authAttempts, attendancePayouts, cashflowEntries, attendanceRequests } from '../db/schema.js';
import { eq, and, gte, lte, desc, asc, sql, count, inArray } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { asyncRoute } from '../lib/async-route.js';
import { requireRole } from '../middleware/requireRole.js';
import {
  pinSchema,
  clockSchema,
  manualEventSchema,
  editEventSchema,
  summaryQuerySchema,
  attendanceRequestSchema,
  requestReviewSchema,
} from '../schemas/attendance.js';
import {
  pairEventsToShifts,
  summarizeHours,
  computeWage,
  OVERLAP_RULES,
  overlapMinutes,
  computeWageWithOverlap,
} from '../lib/attendance.js';

export const publicRouter = Router();
export const adminRouter = Router();

// Mirror /verify-manager — same window/threshold so a leaked attendance PIN
// can't be brute-forced any faster than a manager PIN.
const PIN_WINDOW_MS = 15 * 60 * 1000;
const PIN_MAX_ATTEMPTS = 5;

async function failuresFor(staffId, ip) {
  if (process.env.DISABLE_PIN_RATE_LIMIT === 'true') return 0;
  const since = new Date(Date.now() - PIN_WINDOW_MS);
  try {
    if (staffId != null) {
      const r = await db.select({ n: count() }).from(authAttempts).where(and(
        eq(authAttempts.staffId, staffId),
        eq(authAttempts.success, false),
        gte(authAttempts.createdAt, since),
      ));
      return Number(r[0]?.n || 0);
    }
    const r = await db.select({ n: count() }).from(authAttempts).where(and(
      eq(authAttempts.ip, ip || ''),
      eq(authAttempts.success, false),
      sql`${authAttempts.staffId} IS NULL`,
      gte(authAttempts.createdAt, since),
    ));
    return Number(r[0]?.n || 0);
  } catch {
    return 0;
  }
}

async function recordAttempt({ staffId, ip, success }) {
  try {
    await db.insert(authAttempts).values({
      staffId: staffId ?? null,
      ip: ip || '',
      success: !!success,
    });
  } catch {
    // Best-effort logging — never block the response on a write failure.
  }
}

function startOfTodayUtc(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function eventsForStaffSince(staffId, since) {
  return db.select().from(attendanceEvents)
    .where(and(eq(attendanceEvents.staffId, staffId), gte(attendanceEvents.at, since)))
    .orderBy(attendanceEvents.at, attendanceEvents.id);
}

// bcrypt.compare (async) namiesto compareSync.
// bcryptjs je čistý JavaScript, takže compareSync blokuje event loop; toto je
// navyše VEREJNÝ endpoint dochádzkového terminálu (bez JWT), takže ktokoľvek
// na sieti podniku vedel opakovaným posielaním PINu vyťažiť CPU tak, že kasa
// prestala odpovedať. Async varianta prácu rozkúskuje.
// Cyklus zámerne nekončí pri prvej zhode — trvanie odpovede tak neprezrádza
// poradie zamestnanca v tabuľke.
async function findStaffByAttendancePin(pin) {
  const all = await db.select().from(staff).where(eq(staff.active, true));
  let match = null;
  for (const s of all) {
    if (!s.attendancePin) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(pin, s.attendancePin);
    if (ok && !match) match = s;
  }
  return match;
}

async function buildStateFor(staffMember) {
  // Today's events feed the visible "Dnes Xh Ym" wage counter.
  const todayEvents = await eventsForStaffSince(staffMember.id, startOfTodayUtc());
  const summary = summarizeHours(pairEventsToShifts(todayEvents));

  // currentState must look at ALL history (specifically the latest event)
  // so a cashier who clocked in before midnight UTC and is still working
  // sees `clocked_in`, not a fresh `clocked_out` after the date rolled.
  const [latest] = await db.select().from(attendanceEvents)
    .where(eq(attendanceEvents.staffId, staffMember.id))
    .orderBy(desc(attendanceEvents.at))
    .limit(1);

  const currentState = latest && latest.type === 'clock_in' ? 'clocked_in' : 'clocked_out';
  return { currentState, todayMinutes: summary.minutes, lastEvent: latest || null };
}

publicRouter.post('/identify', validate(pinSchema), asyncRoute(async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const found = await findStaffByAttendancePin(req.body.pin);

  // Two-stage lockout:
  //  - matched-PIN path: per-staff bucket (a malicious actor can't lock
  //    out everyone by guessing — only the staff whose PIN they keep
  //    typing wrong, which is themselves);
  //  - unmatched-PIN path: per-IP bucket of staffId IS NULL attempts
  //    (so 5 random guesses from one tablet stop further guesses, but
  //    don't block the next legitimate user).
  const lockKey = found ? { staffId: found.id, ip: null } : { staffId: null, ip };
  const failures = await failuresFor(lockKey.staffId, lockKey.ip);
  if (failures >= PIN_MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil(PIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }

  if (!found) {
    await recordAttempt({ staffId: null, ip, success: false });
    return res.status(401).json({ error: 'Neplatny PIN' });
  }
  await recordAttempt({ staffId: found.id, ip, success: true });

  const state = await buildStateFor(found);
  res.json({
    staff: { id: found.id, name: found.name, position: found.position || '' },
    currentState: state.currentState,
    todayMinutes: state.todayMinutes,
  });
}));

publicRouter.post('/clock', validate(clockSchema), asyncRoute(async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const found = await findStaffByAttendancePin(req.body.pin);

  // Two-stage lockout: see /identify above for the rationale. Same gate
  // applies here so /clock can't be used as a brute-force side channel.
  const lockKey = found ? { staffId: found.id, ip: null } : { staffId: null, ip };
  const failures = await failuresFor(lockKey.staffId, lockKey.ip);
  if (failures >= PIN_MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil(PIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }

  if (!found) {
    await recordAttempt({ staffId: null, ip, success: false });
    return res.status(401).json({ error: 'Neplatny PIN' });
  }
  await recordAttempt({ staffId: found.id, ip, success: true });

  const state = await buildStateFor(found);
  if (req.body.type === 'clock_in' && state.currentState === 'clocked_in') {
    return res.status(409).json({ error: 'Uz si v praci. Najprv Odchod.' });
  }
  if (req.body.type === 'clock_out' && state.currentState === 'clocked_out') {
    return res.status(409).json({ error: 'Nie si v praci. Najprv Prichod.' });
  }

  await db.insert(attendanceEvents).values({
    staffId: found.id,
    type: req.body.type,
    source: 'pin',
  });

  const after = await buildStateFor(found);
  res.json({
    staff: { id: found.id, name: found.name, position: found.position || '' },
    currentState: after.currentState,
    todayMinutes: after.todayMinutes,
  });
}));

// POST /api/attendance/my-shifts — PIN-authenticated self-service view.
// Zamestnanec si vie pozrieť vlastné smeny + zárobky cez ten istý PIN
// na dochádzkovom termináli. Vracia aktuálny kalendárny mesiac (default)
// alebo celé obdobie sezóny ak operátor pošle period='season'/'all'.
//
// Bezpečnosť: PIN sa overí cez findStaffByAttendancePin (rovnaká logika
// ako /clock), uplatňuje sa rovnaký rate-limit.
publicRouter.post('/my-shifts', validate(pinSchema), asyncRoute(async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const found = await findStaffByAttendancePin(req.body.pin);

  const lockKey = found ? { staffId: found.id, ip: null } : { staffId: null, ip };
  const failures = await failuresFor(lockKey.staffId, lockKey.ip);
  if (failures >= PIN_MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil(PIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }
  if (!found) {
    await recordAttempt({ staffId: null, ip, success: false });
    return res.status(401).json({ error: 'Neplatny PIN' });
  }
  await recordAttempt({ staffId: found.id, ip, success: true });

  // Period: default = aktuálny kalendárny mesiac. 'season' = od 25.04.
  // 'all' = od začiatku evidencie.
  const period = String((req.body && req.body.period) || 'month');
  const now = new Date();
  let fromDate, toDate = new Date(now.getFullYear(), now.getMonth() + 1, 1); // start of next month
  if (period === 'season') {
    fromDate = new Date(`${now.getFullYear()}-04-25T00:00:00Z`);
  } else if (period === 'all') {
    fromDate = new Date('2000-01-01T00:00:00Z');
  } else {
    fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const events = await db.select().from(attendanceEvents).where(and(
    eq(attendanceEvents.staffId, found.id),
    gte(attendanceEvents.at, fromDate),
    lte(attendanceEvents.at, toDate),
  )).orderBy(attendanceEvents.at, attendanceEvents.id);

  // Map clock_out events → payout (ak existuje), aby zamestnanec videl
  // ✓ vyplatené pri každej smene a vedel rozlíšiť čo už dostal vs. čo
  // ešte čaká.
  const clockOutIds = events.filter((e) => e.type === 'clock_out').map((e) => e.id);
  let payoutByOutId = new Map();
  if (clockOutIds.length) {
    const payouts = await db.select({
      id: attendancePayouts.id,
      clockOutEventId: attendancePayouts.clockOutEventId,
      amount: attendancePayouts.amount,
      paidAt: attendancePayouts.paidAt,
    }).from(attendancePayouts).where(
      sql`${attendancePayouts.clockOutEventId} IN (${sql.join(clockOutIds.map((id) => sql`${id}`), sql`, `)})`,
    );
    for (const p of payouts) payoutByOutId.set(p.clockOutEventId, p);
  }

  const shifts = pairEventsToShifts(events);
  const summary = summarizeHours(shifts);
  const totalWage = computeWage(summary.minutes, found.hourlyRate);

  // Pre každú smenu vypočítaj earnings + paid status. Earning = minutes/60
  // × hourlyRate (rovnaké ako server-side computeWage). Open shifts (bez
  // clock_out) nie sú ešte hotové — nepripočítavame.
  const hourlyRate = Number(found.hourlyRate) || 0;
  const shiftRows = shifts.map((sh) => {
    const minutes = sh.minutes || 0;
    const hours = minutes / 60;
    const earnings = sh.closed ? Math.round(hours * hourlyRate * 100) / 100 : 0;
    const payout = sh.outEvent ? payoutByOutId.get(sh.outEvent.id) : null;
    return {
      inAt: sh.inEvent ? sh.inEvent.at : null,
      outAt: sh.outEvent ? sh.outEvent.at : null,
      minutes,
      hours: Math.round(hours * 100) / 100,
      earnings,
      closed: sh.closed,
      paid: payout ? {
        amount: Number(payout.amount),
        paidAt: payout.paidAt,
      } : null,
    };
  });

  // Sumár len cez closed shifts.
  const closedShifts = shiftRows.filter((s) => s.closed);
  const totalEarnings = closedShifts.reduce((s, x) => s + x.earnings, 0);
  const paidEarnings = closedShifts.reduce((s, x) => s + (x.paid ? x.paid.amount : 0), 0);
  const unpaidEarnings = Math.round((totalEarnings - paidEarnings) * 100) / 100;

  res.json({
    staff: {
      id: found.id,
      name: found.name,
      position: found.position || '',
      hourlyRate: hourlyRate,
    },
    period: {
      kind: period,
      from: fromDate.toISOString(),
      to: now.toISOString(),
    },
    shifts: shiftRows.reverse(), // najnovšie hore
    summary: {
      shiftCount: closedShifts.length,
      openShifts: summary.openShifts,
      totalMinutes: summary.minutes,
      totalHours: Math.round((summary.minutes / 60) * 100) / 100,
      totalEarnings: Math.round(totalEarnings * 100) / 100,
      paidEarnings: Math.round(paidEarnings * 100) / 100,
      unpaidEarnings: unpaidEarnings,
      hourlyRate: hourlyRate,
    },
  });
}));

// ===== Žiadosti o opravu dochádzky ========================================
//
// Terminál pozná len „teraz". Kto príde o 8:00 a PIN stihne až o 9:30, má
// v evidencii 9:30 a hodina a pol mzdy zmizne; kto sa niektorý deň neoznačí,
// ten deň v evidencii vôbec nie je. Doteraz to vedel opraviť len manažér —
// teda len ak mu to niekto povedal a on si spomenul.
//
// Tu si to zamestnanec nahlási sám cez ten istý PIN. Žiadosť je LEN NÁVRH:
// dochádzku nemení, kým ju manažér neschváli.

// Koľko dní dozadu sa dá žiadosť podať. Bez stropu by sa dala prepisovať
// dávno vyplatená mzda.
const REQUEST_MAX_AGE_DAYS = 31;

/**
 * Poskladá bratislavský timestamp z 'YYYY-MM-DD' + 'HH:MM'.
 * Cez Postgres, nie cez `new Date(...)`: server beží v UTC kontajneri, takže
 * ručné skladanie by pri prechode letného času posunulo čas o hodinu a pri
 * nočných smenách aj deň.
 */
async function bratislavaTs(handle, isoDay, hhmm) {
  const r = await handle.execute(
    sql`SELECT ((${isoDay} || ' ' || ${hhmm})::timestamp AT TIME ZONE 'Europe/Bratislava') AS ts`
  );
  const row = (r.rows || r)[0];
  return row ? new Date(row.ts) : null;
}

/** Dnešný bratislavský deň ako 'YYYY-MM-DD'. */
async function bratislavaToday(handle) {
  const r = await handle.execute(
    sql`SELECT to_char(NOW() AT TIME ZONE 'Europe/Bratislava', 'YYYY-MM-DD') AS d`
  );
  const row = (r.rows || r)[0];
  return row ? row.d : null;
}

/** Hranice bratislavského dňa [od, do) ako UTC inštanty. */
async function bratislavaDayBounds(handle, isoDay) {
  const from = await bratislavaTs(handle, isoDay, '00:00');
  const r = await handle.execute(
    sql`SELECT ((${isoDay}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Europe/Bratislava') AS ts`
  );
  const row = (r.rows || r)[0];
  return { from, to: row ? new Date(row.ts) : null };
}

async function eventsOnDay(handle, staffId, isoDay) {
  const { from, to } = await bratislavaDayBounds(handle, isoDay);
  return handle.select().from(attendanceEvents).where(and(
    eq(attendanceEvents.staffId, staffId),
    gte(attendanceEvents.at, from),
    lte(attendanceEvents.at, to),
  )).orderBy(asc(attendanceEvents.at), asc(attendanceEvents.id));
}

// POST /api/attendance/requests — zamestnanec podá žiadosť (PIN, bez JWT).
publicRouter.post('/requests', validate(attendanceRequestSchema), asyncRoute(async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const found = await findStaffByAttendancePin(req.body.pin);

  // Rovnaký lockout ako /clock — endpoint nesmie byť lacnejšia cesta na
  // skúšanie PINov.
  const lockKey = found ? { staffId: found.id, ip: null } : { staffId: null, ip };
  const failures = await failuresFor(lockKey.staffId, lockKey.ip);
  if (failures >= PIN_MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil(PIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }
  if (!found) {
    await recordAttempt({ staffId: null, ip, success: false });
    return res.status(401).json({ error: 'Neplatny PIN' });
  }
  await recordAttempt({ staffId: found.id, ip, success: true });

  const { type, targetDate, claimedIn, claimedOut, note } = req.body;

  const today = await bratislavaToday(db);
  if (targetDate > today) {
    return res.status(400).json({ error: 'Nedá sa nahlásiť deň v budúcnosti' });
  }
  // ::int je nutný — bez neho ide 31 ako netypovaný parameter a Postgres
  // odmietne `date - $1` s "date/time field value out of range".
  const oldest = await db.execute(
    sql`SELECT to_char((NOW() AT TIME ZONE 'Europe/Bratislava')::date - ${REQUEST_MAX_AGE_DAYS}::int, 'YYYY-MM-DD') AS d`
  );
  const oldestDay = (oldest.rows || oldest)[0]?.d;
  if (oldestDay && targetDate < oldestDay) {
    return res.status(400).json({
      error: `Nahlásiť sa dá najviac ${REQUEST_MAX_AGE_DAYS} dní dozadu. Starší deň rieš osobne s manažérom.`,
    });
  }

  // Jedna otvorená žiadosť na deň — inak by manažér schvaľoval tri varianty
  // toho istého dňa a každá by pridala ďalšiu smenu.
  const [dup] = await db.select().from(attendanceRequests).where(and(
    eq(attendanceRequests.staffId, found.id),
    eq(attendanceRequests.targetDate, targetDate),
    eq(attendanceRequests.status, 'pending'),
  )).limit(1);
  if (dup) {
    return res.status(409).json({ error: 'Na tento deň už máš žiadosť, ktorá čaká na schválenie.' });
  }

  const inTs = await bratislavaTs(db, targetDate, claimedIn);
  const outTs = claimedOut ? await bratislavaTs(db, targetDate, claimedOut) : null;

  const [created] = await db.insert(attendanceRequests).values({
    staffId: found.id,
    type,
    targetDate,
    claimedIn: inTs,
    claimedOut: outTs,
    note: note || '',
  }).returning();

  res.status(201).json({ request: created });
}));

// POST /api/attendance/my-requests — zamestnanec si pozrie vlastné žiadosti.
publicRouter.post('/my-requests', validate(pinSchema), asyncRoute(async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const found = await findStaffByAttendancePin(req.body.pin);

  const lockKey = found ? { staffId: found.id, ip: null } : { staffId: null, ip };
  const failures = await failuresFor(lockKey.staffId, lockKey.ip);
  if (failures >= PIN_MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil(PIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }
  if (!found) {
    await recordAttempt({ staffId: null, ip, success: false });
    return res.status(401).json({ error: 'Neplatny PIN' });
  }
  await recordAttempt({ staffId: found.id, ip, success: true });

  const rows = await db.select().from(attendanceRequests)
    .where(eq(attendanceRequests.staffId, found.id))
    .orderBy(desc(attendanceRequests.createdAt))
    .limit(30);

  res.json({ staff: { id: found.id, name: found.name }, requests: rows });
}));

// ===== Admin / manager attendance API =====================================
// Mounted at /api/attendance with the JWT `auth` middleware. Public PIN
// routes match first (Express order in app.js), so /identify and /clock
// stay PIN-only; everything below requires manazer or admin.

const mgr = requireRole('manazer', 'admin');

adminRouter.get('/history/:staffId', mgr, asyncRoute(async (req, res) => {
  const staffId = Number.parseInt(req.params.staffId, 10);
  if (!Number.isFinite(staffId)) return res.status(400).json({ error: 'Neplatne staffId' });
  const from = String(req.query.from || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.from : null;
  const to = String(req.query.to || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.to : null;
  if (!from || !to) return res.status(400).json({ error: 'from a to musia byt YYYY-MM-DD' });
  const fromDate = new Date(from + 'T00:00:00Z');
  const toDate = new Date(to + 'T23:59:59Z');

  const events = await db.select().from(attendanceEvents).where(and(
    eq(attendanceEvents.staffId, staffId),
    gte(attendanceEvents.at, fromDate),
    lte(attendanceEvents.at, toDate),
  )).orderBy(attendanceEvents.at, attendanceEvents.id);

  // Enrich each clock_out event with its payout (if any) so the admin
  // table can render "✓ Vyplatené" badges per shift without a second
  // round-trip. Joins on clock_out_event_id; a clock_in event simply
  // returns paid=null since payouts hang off the closing event.
  const clockOutIds = events.filter((e) => e.type === 'clock_out').map((e) => e.id);
  let payoutByOutId = new Map();
  if (clockOutIds.length) {
    const payouts = await db.select({
      id: attendancePayouts.id,
      clockOutEventId: attendancePayouts.clockOutEventId,
      amount: attendancePayouts.amount,
      paidAt: attendancePayouts.paidAt,
      paidByStaffId: attendancePayouts.paidByStaffId,
      cashflowEntryId: attendancePayouts.cashflowEntryId,
      note: attendancePayouts.note,
    }).from(attendancePayouts).where(
      sql`${attendancePayouts.clockOutEventId} IN (${sql.join(clockOutIds.map((id) => sql`${id}`), sql`, `)})`,
    );
    for (const p of payouts) payoutByOutId.set(p.clockOutEventId, p);
  }

  const eventsWithPayout = events.map((e) => {
    if (e.type !== 'clock_out') return { ...e, paid: null };
    const p = payoutByOutId.get(e.id);
    return {
      ...e,
      paid: p ? {
        id: p.id,
        amount: Number(p.amount),
        paidAt: p.paidAt,
        paidByStaffId: p.paidByStaffId,
        cashflowEntryId: p.cashflowEntryId,
        note: p.note,
      } : null,
    };
  });

  const shifts = pairEventsToShifts(events);
  const summary = summarizeHours(shifts);
  const [s] = await db.select().from(staff).where(eq(staff.id, staffId));
  res.json({
    staff: s ? { id: s.id, name: s.name, position: s.position || '', hourlyRate: s.hourlyRate } : null,
    events: eventsWithPayout,
    shifts: shifts.map((sh) => ({
      inAt: sh.inEvent ? sh.inEvent.at : null,
      outAt: sh.outEvent ? sh.outEvent.at : null,
      minutes: sh.minutes,
      closed: sh.closed,
      clockOutEventId: sh.outEvent ? sh.outEvent.id : null,
    })),
    summary: {
      minutes: summary.minutes,
      openShifts: summary.openShifts,
      wage: computeWage(summary.minutes, s?.hourlyRate),
    },
  });
}));

// ===================== PAYOUTS =====================
// Mark a shift as paid: store the amount + auto-create a matching
// cashflow expense (category=salary) so payroll cash leaving the till
// shows up in the cashflow report. The two rows are linked by FK so
// undoing the payout (DELETE) also removes the cashflow expense in the
// same transaction.
adminRouter.post('/payouts', mgr, asyncRoute(async (req, res) => {
  const clockOutEventId = Number.parseInt(req.body && req.body.clockOutEventId, 10);
  const amount = Number(req.body && req.body.amount);
  const note = String((req.body && req.body.note) || '').slice(0, 200);

  if (!Number.isFinite(clockOutEventId) || clockOutEventId <= 0) {
    return res.status(400).json({ error: 'Neplatné clockOutEventId' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Suma musí byť kladná' });
  }

  const [outEvent] = await db.select().from(attendanceEvents).where(eq(attendanceEvents.id, clockOutEventId));
  if (!outEvent || outEvent.type !== 'clock_out') {
    return res.status(404).json({ error: 'Smena (clock_out event) nenájdená' });
  }
  const [existing] = await db.select().from(attendancePayouts).where(eq(attendancePayouts.clockOutEventId, clockOutEventId));
  if (existing) {
    return res.status(409).json({ error: 'Smena už bola označená ako vyplatená', payout: existing });
  }

  const [staffRow] = await db.select().from(staff).where(eq(staff.id, outEvent.staffId));
  const staffName = (staffRow && staffRow.name) || 'Zamestnanec';
  const shiftDate = new Date(outEvent.at).toISOString().slice(0, 10);

  // Single transaction so a failed cashflow insert doesn't leave a
  // payout pointing at a non-existent expense row.
  const result = await db.transaction(async (tx) => {
    const [cashflowRow] = await tx.insert(cashflowEntries).values({
      type: 'expense',
      category: 'salary',
      amount: String(amount),
      occurredAt: new Date(),
      method: 'cash',
      note: note || `Výplata smeny — ${staffName} (${shiftDate})`,
      staffId: req.user.id,
    }).returning();

    const [payout] = await tx.insert(attendancePayouts).values({
      staffId: outEvent.staffId,
      clockOutEventId,
      amount: String(amount),
      paidAt: new Date(),
      paidByStaffId: req.user.id,
      cashflowEntryId: cashflowRow.id,
      note,
    }).returning();

    return { payout, cashflowRow };
  });

  res.status(201).json({
    id: result.payout.id,
    amount: Number(result.payout.amount),
    paidAt: result.payout.paidAt,
    paidByStaffId: result.payout.paidByStaffId,
    cashflowEntryId: result.payout.cashflowEntryId,
    clockOutEventId: result.payout.clockOutEventId,
  });
}));

/**
 * POST /attendance/payouts/lump-sum
 * Body: { staffId, amount, note? }
 *
 * Manager vyplatil sumu (napr. 200 €) hotovostne, nechce ratat smeny ručne.
 * Backend FIFO rozloží sumu cez najstarsie NEzaplatene closed shifts:
 *   - každý shift má wage = minutes/60 * hourly_rate
 *   - allocate = min(remainingBudget, wage)
 *   - ak 0 → stop
 *   - posledný shift môže byť čiastočne pokrytý (allocate < wage)
 *
 * Vystupy:
 *   - 1 cashflow_entries row pre TOTAL allocated sum (jedna výplata = jeden
 *     bank/cash pohyb pre manazera, jednoduchsie reportovanie)
 *   - N attendance_payouts rows (každy linkutý na ten istý cashflow_entry_id)
 *
 * Vracia summary: { totalPaid, shiftsPaid, partialShiftId?, remainder }
 */
adminRouter.post('/payouts/lump-sum', mgr, asyncRoute(async (req, res) => {
  const staffId = Number.parseInt(req.body && req.body.staffId, 10);
  const amount = Number(req.body && req.body.amount);
  const note = String((req.body && req.body.note) || '').slice(0, 200);

  if (!Number.isFinite(staffId) || staffId <= 0) {
    return res.status(400).json({ error: 'Neplatne staffId' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Suma musí byť kladná' });
  }
  if (amount > 10000) {
    return res.status(400).json({ error: 'Suma > 10000 € — over zadanie' });
  }

  const [staffRow] = await db.select().from(staff).where(eq(staff.id, staffId));
  if (!staffRow) return res.status(404).json({ error: 'Zamestnanec nenajdeny' });
  const hourlyRate = Number(staffRow.hourlyRate) || 0;
  if (hourlyRate <= 0) {
    return res.status(400).json({ error: 'Zamestnanec nema nastavenu hodinovu sadzbu' });
  }

  // Vsetky events zamestnanca aby sme spravne spárovali shifts (asc by time)
  const events = await db.select().from(attendanceEvents)
    .where(eq(attendanceEvents.staffId, staffId))
    .orderBy(attendanceEvents.at, attendanceEvents.id);
  const shifts = pairEventsToShifts(events);
  // Closed shifts (oba clock_in + clock_out) FIFO podla clock_out time
  const closed = shifts
    .filter((sh) => sh.inEvent && sh.outEvent)
    .sort((a, b) => new Date(a.outEvent.at) - new Date(b.outEvent.at));

  // Existujuce payouts → vylúč shifty kde už existuje payout
  const clockOutIds = closed.map((sh) => sh.outEvent.id);
  const existing = clockOutIds.length
    ? await db.select().from(attendancePayouts).where(
        sql`${attendancePayouts.clockOutEventId} IN (${sql.join(clockOutIds.map((id) => sql`${id}`), sql`, `)})`
      )
    : [];
  const paidSet = new Set(existing.map((p) => p.clockOutEventId));
  const unpaid = closed.filter((sh) => !paidSet.has(sh.outEvent.id));

  if (!unpaid.length) {
    return res.status(409).json({ error: 'Žiadne nezaplatené smeny pre tohto zamestnanca' });
  }

  // Allocate FIFO
  let remaining = Math.round(amount * 100) / 100;
  const allocations = []; // [{ clockOutEventId, shiftWage, allocated, partial }]
  for (const sh of unpaid) {
    const minutes = sh.outEvent && sh.inEvent
      ? Math.max(0, Math.round((new Date(sh.outEvent.at) - new Date(sh.inEvent.at)) / 60000))
      : 0;
    const wage = Math.round((minutes / 60) * hourlyRate * 100) / 100;
    if (wage <= 0) continue; // skip 0-minute shifts
    if (remaining <= 0) break;
    const alloc = Math.min(remaining, wage);
    allocations.push({
      clockOutEventId: sh.outEvent.id,
      shiftDate: new Date(sh.outEvent.at).toISOString().slice(0, 10),
      shiftWage: wage,
      allocated: Math.round(alloc * 100) / 100,
      partial: alloc < wage,
    });
    remaining = Math.round((remaining - alloc) * 100) / 100;
  }

  if (!allocations.length) {
    return res.status(409).json({ error: 'Ziadne shifty s kladnou mzdou' });
  }

  const totalPaid = allocations.reduce((s, a) => s + a.allocated, 0);
  const totalPaidRounded = Math.round(totalPaid * 100) / 100;

  // Single transaction — cashflow + N payouts pohromade.
  const result = await db.transaction(async (tx) => {
    const shiftDates = allocations.map((a) => a.shiftDate);
    const dateRange = shiftDates.length > 1
      ? shiftDates[0] + ' – ' + shiftDates[shiftDates.length - 1]
      : shiftDates[0];
    const cashflowNote = note
      || `Výplata ${staffRow.name} — ${allocations.length}× smena (${dateRange})`;

    const [cashflowRow] = await tx.insert(cashflowEntries).values({
      type: 'expense',
      category: 'salary',
      amount: String(totalPaidRounded),
      occurredAt: new Date(),
      method: 'cash',
      note: cashflowNote,
      staffId: req.user.id,
    }).returning();

    const payoutRows = [];
    for (const a of allocations) {
      const [p] = await tx.insert(attendancePayouts).values({
        staffId,
        clockOutEventId: a.clockOutEventId,
        amount: String(a.allocated),
        paidAt: new Date(),
        paidByStaffId: req.user.id,
        cashflowEntryId: cashflowRow.id,
        note: a.partial ? `Čiastočné krytie (${a.allocated}/${a.shiftWage} €)` : '',
      }).returning();
      payoutRows.push(p);
    }
    return { cashflowRow, payoutRows };
  });

  res.status(201).json({
    totalPaid: totalPaidRounded,
    shiftsCovered: allocations.length,
    partialShifts: allocations.filter((a) => a.partial).length,
    remainder: remaining,
    cashflowEntryId: result.cashflowRow.id,
    allocations: allocations.map((a) => ({
      clockOutEventId: a.clockOutEventId,
      shiftDate: a.shiftDate,
      wage: a.shiftWage,
      allocated: a.allocated,
      partial: a.partial,
    })),
  });
}));

adminRouter.delete('/payouts/:id', mgr, asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatné id' });
  const [payout] = await db.select().from(attendancePayouts).where(eq(attendancePayouts.id, id));
  if (!payout) return res.status(404).json({ error: 'Výplata nenájdená' });

  await db.transaction(async (tx) => {
    await tx.delete(attendancePayouts).where(eq(attendancePayouts.id, id));
    if (payout.cashflowEntryId) {
      await tx.delete(cashflowEntries).where(eq(cashflowEntries.id, payout.cashflowEntryId));
    }
  });

  res.status(204).end();
}));

adminRouter.get('/summary', mgr, asyncRoute(async (req, res) => {
  const parsed = summaryQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Bad query' });
  const fromDate = new Date(parsed.data.from + 'T00:00:00Z');
  const toDate = new Date(parsed.data.to + 'T23:59:59Z');

  const allStaff = await db.select().from(staff).where(eq(staff.active, true));
  const allEvents = await db.select().from(attendanceEvents).where(and(
    gte(attendanceEvents.at, fromDate),
    lte(attendanceEvents.at, toDate),
  )).orderBy(attendanceEvents.at, attendanceEvents.id);

  const byStaff = new Map();
  for (const e of allEvents) {
    if (!byStaff.has(e.staffId)) byStaff.set(e.staffId, []);
    byStaff.get(e.staffId).push(e);
  }

  // Payouts za rovnaké obdobie — bucket per staff. Datum referuje paidAt
  // (kedy bola výplata zaevidovaná), nie čas smeny — manager filter "Tento
  // mesiac" tak ukáže "koľko som vyplatil tento mesiac" bez ohľadu na to
  // ktorú smenu pokryl payout.
  const payoutAgg = await db.execute(sql`
    SELECT staff_id, COUNT(*)::int AS cnt,
      COALESCE(SUM(amount::numeric), 0)::float AS total,
      MAX(paid_at) AS last_paid_at
    FROM attendance_payouts
    WHERE paid_at >= ${fromDate} AND paid_at <= ${toDate}
    GROUP BY staff_id
  `);
  const paidByStaff = new Map();
  for (const r of (payoutAgg.rows || payoutAgg)) {
    paidByStaff.set(Number(r.staff_id), {
      total: Number(r.total) || 0,
      count: Number(r.cnt) || 0,
      lastPaidAt: r.last_paid_at,
    });
  }

  const rows = allStaff.map((s) => {
    const events = byStaff.get(s.id) || [];
    const shifts = pairEventsToShifts(events);
    const summary = summarizeHours(shifts);
    let wage = computeWage(summary.minutes, s.hourlyRate);

    // Overlap pravidlo — ak tento zamestnanec ma special sadzbu na hodiny
    // odpracovane SPOLU s inym (napr. Oleg @ 5€ ked robi s Jarikom).
    // Spocitame prekryv jeho smien so smenami partnera a prepocitame mzdu:
    // solo hodiny @ normalna sadzba + prekryv @ overlap sadzba.
    let overlapInfo = null;
    const rule = OVERLAP_RULES.find((r) => r.staffId === s.id);
    if (rule && summary.minutes > 0) {
      const partnerEvents = byStaff.get(rule.withStaffId) || [];
      const partnerShifts = pairEventsToShifts(partnerEvents);
      const ovMin = overlapMinutes(shifts, partnerShifts);
      if (ovMin > 0) {
        wage = computeWageWithOverlap(summary.minutes, s.hourlyRate, ovMin, rule.overlapRate);
        overlapInfo = {
          withStaffId: rule.withStaffId,
          minutes: ovMin,
          rate: rule.overlapRate,
        };
      }
    }

    const paid = paidByStaff.get(s.id) || { total: 0, count: 0, lastPaidAt: null };
    return {
      staffId: s.id,
      name: s.name,
      position: s.position || '',
      hourlyRate: s.hourlyRate,
      minutes: summary.minutes,
      openShifts: summary.openShifts,
      wage,
      // overlapInfo: keď je nenull, frontend ukáže poznámku "z toho Xh
      // spolu s <partner> @ Y€". Inak null = bežný výpočet.
      overlapInfo,
      // Paid totals — koľko reálne dostal zamestnanec za obdobie
      paidTotal: Math.round(paid.total * 100) / 100,
      paidCount: paid.count,
      lastPaidAt: paid.lastPaidAt,
      // Outstanding = mzda za obdobie − vyplatené v období. Môže byť záporné
      // ak manager vyplatil viac (predošlé dlhy + bonusy). UI to potom vie
      // farebne podľa znamienka.
      outstanding: Math.round((wage - paid.total) * 100) / 100,
    };
  });

  res.json({ from: parsed.data.from, to: parsed.data.to, rows });
}));

// GET /api/attendance/balance — CELKOVÝ dlh na výplatách za CELÉ obdobie
// fungovania (NIE period-scoped ako /summary). Toto je skutočná dlžoba:
//   Σ(všetky odpracované hodiny × sadzba) − Σ(všetko vyplatené)
//
// Rozdiel oproti /summary.outstanding: ten ráta mzdu za zvolený filter
// mínus výplaty v tom filtri — môže klamať (mzda tento týždeň − výplata
// tento týždeň). Balance ignoruje dátumy: berie VŠETKY eventy + VŠETKY
// payouts, takže manager vidí reálnu dlžobu naprieč celou históriou.
//
// Zahŕňa aj NEAKTÍVNych zamestnancov — ak niekto skončil ale ešte mu
// dlžíš, stále to je záväzok.
adminRouter.get('/balance', mgr, asyncRoute(async (req, res) => {
  const allStaff = await db.select().from(staff); // vrátane neaktívnych
  const allEvents = await db.select().from(attendanceEvents).orderBy(attendanceEvents.at, attendanceEvents.id);

  const byStaff = new Map();
  for (const e of allEvents) {
    if (!byStaff.has(e.staffId)) byStaff.set(e.staffId, []);
    byStaff.get(e.staffId).push(e);
  }

  // All-time payouts per staff (žiadny dátumový filter)
  const payoutAgg = await db.execute(sql`
    SELECT staff_id, COALESCE(SUM(amount::numeric), 0)::float AS total, MAX(paid_at) AS last_paid_at
    FROM attendance_payouts GROUP BY staff_id
  `);
  const paidByStaff = new Map();
  for (const r of (payoutAgg.rows || payoutAgg)) {
    paidByStaff.set(Number(r.staff_id), { total: Number(r.total) || 0, lastPaidAt: r.last_paid_at });
  }

  const rows = [];
  let totalOwed = 0;     // suma kladných zostatkov = koľko reálne dlžím
  let totalPrepaid = 0;  // suma záporných = koľko som preplatil (zálohy navyše)

  for (const s of allStaff) {
    const events = byStaff.get(s.id) || [];
    const shifts = pairEventsToShifts(events);
    const summary = summarizeHours(shifts);
    let wage = computeWage(summary.minutes, s.hourlyRate);

    // Overlap pravidlo aj tu (Oleg @ 5€ s Jarikom) — nad celou históriou.
    const rule = OVERLAP_RULES.find((r) => r.staffId === s.id);
    if (rule && summary.minutes > 0) {
      const partnerShifts = pairEventsToShifts(byStaff.get(rule.withStaffId) || []);
      const ovMin = overlapMinutes(shifts, partnerShifts);
      if (ovMin > 0) wage = computeWageWithOverlap(summary.minutes, s.hourlyRate, ovMin, rule.overlapRate);
    }

    const paid = paidByStaff.get(s.id) || { total: 0, lastPaidAt: null };
    const balance = Math.round((wage - paid.total) * 100) / 100;

    // Skip ľudí bez histórie (0 mzda + 0 výplat) — nezahlcujeme zoznam
    if (Math.abs(wage) < 0.01 && Math.abs(paid.total) < 0.01) continue;

    if (balance > 0) totalOwed += balance;
    else if (balance < 0) totalPrepaid += -balance;

    rows.push({
      staffId: s.id,
      name: s.name,
      position: s.position || '',
      active: !!s.active,
      totalWage: Math.round(wage * 100) / 100,
      totalPaid: Math.round(paid.total * 100) / 100,
      balance,
      lastPaidAt: paid.lastPaidAt,
    });
  }

  // Najväčší dlh hore
  rows.sort((a, b) => b.balance - a.balance);

  res.json({
    totalOwed: Math.round(totalOwed * 100) / 100,
    totalPrepaid: Math.round(totalPrepaid * 100) / 100,
    rows,
  });
}));

// GET /api/attendance/requests?status=pending — zoznam žiadostí pre manažéra.
// Ku každej doloží, čo je v ten deň REÁLNE v evidencii, nech sa dá porovnať
// tvrdenie zamestnanca so systémom bez preklikávania sa do histórie.
adminRouter.get('/requests', mgr, asyncRoute(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(String(req.query.status))
    ? String(req.query.status)
    : null;

  const rows = await db.select({
    id: attendanceRequests.id,
    staffId: attendanceRequests.staffId,
    staffName: staff.name,
    position: staff.position,
    type: attendanceRequests.type,
    targetDate: attendanceRequests.targetDate,
    claimedIn: attendanceRequests.claimedIn,
    claimedOut: attendanceRequests.claimedOut,
    note: attendanceRequests.note,
    status: attendanceRequests.status,
    reviewedBy: attendanceRequests.reviewedBy,
    reviewedAt: attendanceRequests.reviewedAt,
    reviewNote: attendanceRequests.reviewNote,
    createdAt: attendanceRequests.createdAt,
  })
    .from(attendanceRequests)
    .innerJoin(staff, eq(staff.id, attendanceRequests.staffId))
    .where(status ? eq(attendanceRequests.status, status) : undefined)
    .orderBy(desc(attendanceRequests.createdAt))
    .limit(200);

  // Existujúce eventy v dotknutých dňoch — aby manažér videl „tvrdí 8:00,
  // systém má 9:30" bez ďalšieho klikania.
  //
  // Časy posielame aj ako HOTOVÉ 'HH:MM' v bratislavskom čase, spočítané
  // v Postgrese. Klient by ich inak musel odvodzovať z ISO reťazca a trafil
  // by správne len vtedy, keď má prehliadač aj serverový proces rovnakú zónu
  // (attendance_events.at je `timestamp` BEZ zóny — funguje to len preto, že
  // kontajner beží v UTC). Toto tú závislosť odstraňuje.
  const out = [];
  for (const r of rows) {
    const existing = await eventsOnDay(db, r.staffId, r.targetDate);
    const ids = existing.map((e) => e.id);
    let localById = new Map();
    if (ids.length) {
      const lt = await db.execute(sql`
        SELECT id, to_char(at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Bratislava', 'HH24:MI') AS t
          FROM attendance_events WHERE id IN ${ids}
      `);
      for (const row of (lt.rows || lt)) localById.set(Number(row.id), row.t);
    }
    const times = await db.execute(sql`
      SELECT to_char(${r.claimedIn}::timestamptz AT TIME ZONE 'Europe/Bratislava', 'HH24:MI') AS in_t,
             CASE WHEN ${r.claimedOut}::timestamptz IS NULL THEN NULL
                  ELSE to_char(${r.claimedOut}::timestamptz AT TIME ZONE 'Europe/Bratislava', 'HH24:MI') END AS out_t
    `);
    const tRow = (times.rows || times)[0] || {};

    out.push({
      ...r,
      claimedInLocal: tRow.in_t || null,
      claimedOutLocal: tRow.out_t || null,
      existingEvents: existing.map((e) => ({
        id: e.id, type: e.type, at: e.at, source: e.source,
        localTime: localById.get(Number(e.id)) || null,
      })),
    });
  }

  const [{ n: pendingCount } = { n: 0 }] = await db.select({ n: count() })
    .from(attendanceRequests).where(eq(attendanceRequests.status, 'pending'));

  res.json({ requests: out, pendingCount: Number(pendingCount) || 0 });
}));

// POST /api/attendance/requests/:id/approve
//
// AŽ TOTO mení dochádzku. Zapisuje sa rovnakým audit kontraktom ako manuálna
// úprava v admine (source='manual', reason, edited_by = schvaľovateľ), takže
// v histórii je vidieť, že to nebol PIN na termináli.
adminRouter.post('/requests/:id/approve', mgr, validate(requestReviewSchema), asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatne id' });

  try {
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE — dvaja manažéri nesmú schváliť tú istú žiadosť naraz
      // a založiť smenu dvakrát.
      const locked = await tx.execute(
        sql`SELECT * FROM attendance_requests WHERE id = ${id} FOR UPDATE`
      );
      const rows = locked.rows || locked;
      if (!rows || !rows.length) { const e = new Error('not_found'); e.status = 404; throw e; }
      const reqRow = rows[0];
      if (reqRow.status !== 'pending') { const e = new Error('already'); e.status = 409; throw e; }

      const staffId = reqRow.staff_id;
      const targetDate = typeof reqRow.target_date === 'string'
        ? reqRow.target_date
        : new Date(reqRow.target_date).toISOString().slice(0, 10);
      const claimedIn = new Date(reqRow.claimed_in);
      const claimedOut = reqRow.claimed_out ? new Date(reqRow.claimed_out) : null;

      const dayEvents = await eventsOnDay(tx, staffId, targetDate);
      const firstIn = dayEvents.find((e) => e.type === 'clock_in');
      const lastOut = [...dayEvents].reverse().find((e) => e.type === 'clock_out');

      const touched = [];

      if (reqRow.type === 'late_pin') {
        if (!firstIn) {
          // Medzitým sa deň vyprázdnil (napr. manažér smenu zmazal) —
          // z opravy času sa stáva doplnenie celej smeny.
          const [ins] = await tx.insert(attendanceEvents).values({
            staffId, type: 'clock_in', at: claimedIn,
            source: 'manual', reason: 'forgot', editedBy: req.user.id,
            note: 'Žiadosť #' + id,
          }).returning();
          touched.push(ins.id);
        } else {
          const [upd] = await tx.update(attendanceEvents).set({
            at: claimedIn, source: 'manual', reason: 'wrong_time',
            editedBy: req.user.id, note: 'Žiadosť #' + id,
          }).where(eq(attendanceEvents.id, firstIn.id)).returning();
          touched.push(upd.id);
        }
        if (claimedOut) {
          if (lastOut) {
            const [upd] = await tx.update(attendanceEvents).set({
              at: claimedOut, source: 'manual', reason: 'wrong_time',
              editedBy: req.user.id, note: 'Žiadosť #' + id,
            }).where(eq(attendanceEvents.id, lastOut.id)).returning();
            touched.push(upd.id);
          } else {
            const [ins] = await tx.insert(attendanceEvents).values({
              staffId, type: 'clock_out', at: claimedOut,
              source: 'manual', reason: 'forgot', editedBy: req.user.id,
              note: 'Žiadosť #' + id,
            }).returning();
            touched.push(ins.id);
          }
        }
      } else {
        // missing_day — ak medzitým v ten deň nejaká smena vznikla, radšej
        // nič nepridávame; manažér nech to dorieši ručne, inak by človek mal
        // za jeden deň dve smeny.
        if (dayEvents.length) { const e = new Error('day_not_empty'); e.status = 409; throw e; }
        const [insIn] = await tx.insert(attendanceEvents).values({
          staffId, type: 'clock_in', at: claimedIn,
          source: 'manual', reason: 'forgot', editedBy: req.user.id,
          note: 'Žiadosť #' + id,
        }).returning();
        const [insOut] = await tx.insert(attendanceEvents).values({
          staffId, type: 'clock_out', at: claimedOut,
          source: 'manual', reason: 'forgot', editedBy: req.user.id,
          note: 'Žiadosť #' + id,
        }).returning();
        touched.push(insIn.id, insOut.id);
      }

      const [updatedReq] = await tx.update(attendanceRequests).set({
        status: 'approved',
        reviewedBy: req.user.id,
        reviewedAt: new Date(),
        reviewNote: req.body.note || '',
      }).where(eq(attendanceRequests.id, id)).returning();

      return { request: updatedReq, eventIds: touched };
    });

    res.json({ ok: true, ...result });
  } catch (e) {
    if (e && e.status === 404) return res.status(404).json({ error: 'Žiadosť nenájdená' });
    if (e && e.status === 409 && e.message === 'already') {
      return res.status(409).json({ error: 'Žiadosť už bola vybavená' });
    }
    if (e && e.status === 409 && e.message === 'day_not_empty') {
      return res.status(409).json({
        error: 'V ten deň už dochádzka existuje — dorieš ju ručne, nech nevznikne dvojitá smena.',
      });
    }
    throw e;
  }
}));

// POST /api/attendance/requests/:id/reject — dochádzku nemení.
adminRouter.post('/requests/:id/reject', mgr, validate(requestReviewSchema), asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatne id' });

  const [existing] = await db.select().from(attendanceRequests).where(eq(attendanceRequests.id, id));
  if (!existing) return res.status(404).json({ error: 'Žiadosť nenájdená' });
  if (existing.status !== 'pending') return res.status(409).json({ error: 'Žiadosť už bola vybavená' });

  const [updated] = await db.update(attendanceRequests).set({
    status: 'rejected',
    reviewedBy: req.user.id,
    reviewedAt: new Date(),
    reviewNote: req.body.note || '',
  }).where(eq(attendanceRequests.id, id)).returning();

  res.json({ ok: true, request: updated });
}));

adminRouter.get('/active', mgr, asyncRoute(async (req, res) => {
  // Find each active staff's most-recent attendance event in one query.
  // Then keep only the ones whose latest event is clock_in.
  // Tie-break by id DESC: two events written in the same millisecond
  // (rapid double-tap on the PIN pad, or batched test inserts) share a
  // NOW() timestamp, so without a secondary sort `DISTINCT ON` would
  // pick non-deterministically.
  const latest = await db.execute(sql`
    SELECT DISTINCT ON (e.staff_id)
      e.staff_id   AS staff_id,
      e.type       AS type,
      e.at         AS at,
      s.name       AS name,
      s.position   AS position
    FROM attendance_events e
    INNER JOIN staff s ON s.id = e.staff_id AND s.active = true
    ORDER BY e.staff_id, e.at DESC, e.id DESC
  `);
  const now = Date.now();
  const active = latest.rows
    .filter((r) => r.type === 'clock_in')
    .map((r) => {
      const at = new Date(r.at);
      return {
        staffId: r.staff_id,
        name: r.name,
        position: r.position || '',
        clockedInAt: at.toISOString(),
        minutes: Math.max(0, Math.round((now - at.getTime()) / 60000)),
      };
    });
  res.json({ active });
}));

adminRouter.post('/events', mgr, validate(manualEventSchema), asyncRoute(async (req, res) => {
  const [event] = await db.insert(attendanceEvents).values({
    staffId: req.body.staffId,
    type: req.body.type,
    at: new Date(req.body.at),
    source: 'manual',
    note: req.body.note || '',
    reason: req.body.reason,
    editedBy: req.user.id,
  }).returning();
  res.status(201).json({ event });
}));

// PATCH /events/:id — inline úprava času existujúceho záznamu. Updatuje
// iba `at` (+ označí riadok ako manuálny override s reason/editedBy). Typ
// sa nemení. Zachovaním id zostáva naviazaný payout (clock_out_event_id)
// neporušený — preto edit, nie delete+create. Mzda/zostatok sa prepočítajú
// automaticky pri ďalšom /summary, lebo wage sa ráta z časov eventov.
adminRouter.patch('/events/:id', mgr, validate(editEventSchema), asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatne id' });
  const [existing] = await db.select().from(attendanceEvents).where(eq(attendanceEvents.id, id));
  if (!existing) return res.status(404).json({ error: 'Záznam nenájdený' });

  const [event] = await db.update(attendanceEvents).set({
    at: new Date(req.body.at),
    source: 'manual',
    reason: req.body.reason,
    note: req.body.note || '',
    editedBy: req.user.id,
  }).where(eq(attendanceEvents.id, id)).returning();

  res.json({ event });
}));

adminRouter.delete('/events/:id', mgr, asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatne id' });
  await db.delete(attendanceEvents).where(eq(attendanceEvents.id, id));
  res.json({ ok: true });
}));

// DELETE /api/attendance/shifts/:clockOutEventId
//
// Zmaze CELU ukoncenu smenu = par (clock_in + clock_out) NARAZ, a ak je
// smena vyplatena, aj jej payout + naviazany cashflow zaznam (salary
// expense) — vsetko v jednej transakcii, aby nezostal sirotny payout/cashflow
// ani polovicna smena. Parovy clock_in najdeme cez ROVNAKU paircovaciu logiku
// ako display (pairEventsToShifts), takze to co user vidi ako "smenu" sa zmaze
// cele. Otvorenu smenu (samotny clock_in bez clock_out) tu neriesime — tu sa
// maze cez clock_out id; stray event sa da zmazat cez DELETE /events/:id.
// Mzda/zostatok sa prepocitaju automaticky pri dalsom /summary.
adminRouter.delete('/shifts/:clockOutEventId', mgr, asyncRoute(async (req, res) => {
  const clockOutEventId = Number.parseInt(req.params.clockOutEventId, 10);
  if (!Number.isFinite(clockOutEventId)) return res.status(400).json({ error: 'Neplatne id' });

  try {
    // VSETKO (validacia + paircovanie + payout + delete) v JEDNEJ transakcii.
    // Inak by medzi "co zmazat" a samotnym zmazanim mohol konkurencny insert
    // (POST /events) prepairovat odchod na iny prichod (→ sirotny event) alebo
    // konkurencny DELETE /payouts zmazat payout (→ sirotna cashflow polozka).
    // Pairujeme presne ako display: vsetky eventy zamestnanca v poradi (at, id).
    await db.transaction(async (tx) => {
      const [outEvent] = await tx.select().from(attendanceEvents).where(eq(attendanceEvents.id, clockOutEventId));
      if (!outEvent) { const e = new Error('Smena (odchod) nenájdená'); e.statusCode = 404; throw e; }
      if (outEvent.type !== 'clock_out') {
        const e = new Error('Zadaný záznam nie je odchod — zmazať takto sa dá iba ukončená smena.'); e.statusCode = 409; throw e;
      }

      const staffEvents = await tx.select().from(attendanceEvents)
        .where(eq(attendanceEvents.staffId, outEvent.staffId))
        .orderBy(attendanceEvents.at, attendanceEvents.id);
      const shift = pairEventsToShifts(staffEvents).find(
        (s) => s.outEvent && s.outEvent.id === clockOutEventId,
      );
      if (!shift || !shift.inEvent) {
        const e = new Error('K tomuto odchodu sa nenašiel párový príchod — smenu nemožno jednoznačne zmazať.'); e.statusCode = 409; throw e;
      }
      const clockInEventId = shift.inEvent.id;

      // Payout (ak smena vyplatena) — zmaz explicitne + jeho cashflow expense.
      // (FK clock_out_event_id ma onDelete cascade, ten payout zmaze aj tak pri
      //  delete clock_out eventu; explicitny delete je tu kvoli citatelnosti a
      //  hlavne kvoli naviazanej cashflow polozke, ktoru FK NEzmaze.)
      const [payout] = await tx.select().from(attendancePayouts)
        .where(eq(attendancePayouts.clockOutEventId, clockOutEventId));
      if (payout) {
        await tx.delete(attendancePayouts).where(eq(attendancePayouts.id, payout.id));
        if (payout.cashflowEntryId) {
          await tx.delete(cashflowEntries).where(eq(cashflowEntries.id, payout.cashflowEntryId));
        }
      }
      await tx.delete(attendanceEvents).where(eq(attendanceEvents.id, clockOutEventId));
      await tx.delete(attendanceEvents).where(eq(attendanceEvents.id, clockInEventId));
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }

  res.status(204).end();
}));

export default publicRouter;

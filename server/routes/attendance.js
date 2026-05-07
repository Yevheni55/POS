import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { staff, attendanceEvents, authAttempts, attendancePayouts, cashflowEntries } from '../db/schema.js';
import { eq, and, gte, lte, desc, sql, count } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { asyncRoute } from '../lib/async-route.js';
import { requireRole } from '../middleware/requireRole.js';
import {
  pinSchema,
  clockSchema,
  manualEventSchema,
  summaryQuerySchema,
} from '../schemas/attendance.js';
import {
  pairEventsToShifts,
  summarizeHours,
  computeWage,
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
    .orderBy(attendanceEvents.at);
}

async function findStaffByAttendancePin(pin) {
  const all = await db.select().from(staff).where(eq(staff.active, true));
  return all.find((s) => s.attendancePin && bcrypt.compareSync(pin, s.attendancePin)) || null;
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
  )).orderBy(attendanceEvents.at);

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
  )).orderBy(attendanceEvents.at);

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
  )).orderBy(attendanceEvents.at);

  const byStaff = new Map();
  for (const e of allEvents) {
    if (!byStaff.has(e.staffId)) byStaff.set(e.staffId, []);
    byStaff.get(e.staffId).push(e);
  }

  const rows = allStaff.map((s) => {
    const events = byStaff.get(s.id) || [];
    const shifts = pairEventsToShifts(events);
    const summary = summarizeHours(shifts);
    return {
      staffId: s.id,
      name: s.name,
      position: s.position || '',
      hourlyRate: s.hourlyRate,
      minutes: summary.minutes,
      openShifts: summary.openShifts,
      wage: computeWage(summary.minutes, s.hourlyRate),
    };
  });

  res.json({ from: parsed.data.from, to: parsed.data.to, rows });
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

adminRouter.delete('/events/:id', mgr, asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatne id' });
  await db.delete(attendanceEvents).where(eq(attendanceEvents.id, id));
  res.json({ ok: true });
}));

export default publicRouter;

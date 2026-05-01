import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { staff, attendanceEvents, authAttempts } from '../db/schema.js';
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

  const shifts = pairEventsToShifts(events);
  const summary = summarizeHours(shifts);
  const [s] = await db.select().from(staff).where(eq(staff.id, staffId));
  res.json({
    staff: s ? { id: s.id, name: s.name, position: s.position || '', hourlyRate: s.hourlyRate } : null,
    events,
    shifts: shifts.map((sh) => ({
      inAt: sh.inEvent ? sh.inEvent.at : null,
      outAt: sh.outEvent ? sh.outEvent.at : null,
      minutes: sh.minutes,
      closed: sh.closed,
    })),
    summary: {
      minutes: summary.minutes,
      openShifts: summary.openShifts,
      wage: computeWage(summary.minutes, s?.hourlyRate),
    },
  });
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

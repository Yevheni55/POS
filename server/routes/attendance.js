import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { staff, attendanceEvents, authAttempts } from '../db/schema.js';
import { eq, and, gte, desc, sql, count } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { asyncRoute } from '../lib/async-route.js';
import { pinSchema, clockSchema } from '../schemas/attendance.js';
import { pairEventsToShifts, summarizeHours } from '../lib/attendance.js';

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
  // Public terminal: rate-limit only by IP bucket of unmatched-PIN attempts.
  // Unlike /verify-manager (which switches to a per-staff bucket once a row
  // matches), here a successful match exits the gate — there's no value in
  // per-staff buckets for an unauthenticated kiosk.
  const before = await failuresFor(null, ip);
  if (before >= PIN_MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil(PIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }

  const found = await findStaffByAttendancePin(req.body.pin);
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
  // Public terminal: rate-limit only by IP bucket of unmatched-PIN attempts.
  // Unlike /verify-manager (which switches to a per-staff bucket once a row
  // matches), here a successful match exits the gate — there's no value in
  // per-staff buckets for an unauthenticated kiosk.
  const before = await failuresFor(null, ip);
  if (before >= PIN_MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil(PIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }

  const found = await findStaffByAttendancePin(req.body.pin);
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

export default publicRouter;

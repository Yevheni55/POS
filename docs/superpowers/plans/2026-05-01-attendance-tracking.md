# Attendance Tracking (Dochádzka) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone clock-in/clock-out terminal for staff (separate PIN from POS), with admin pages to set position + hourly rate per staff and view total hours/wages per period.

**Architecture:** Add three columns to `staff` (`position`, `hourly_rate`, `attendance_pin`) plus a new `attendance_events` table that stores `clock_in`/`clock_out` rows keyed by `staff_id` and `at` timestamp. New Express router `server/routes/attendance.js` exposes a public PIN-based pair (`identify` + `clock`) and an authenticated admin pair (`history` + `summary` + manual edit). New static page `dochadzka.html` is a self-contained PIN pad — no JWT, no `api.js`, just `fetch` to the public endpoints. Admin gains an extended `staff` form and a new `dochadzka` SPA page. Hours are computed in pure helper `server/lib/attendance.js` (pairing rows by date) and unit-tested in isolation.

**Tech Stack:** Node.js ESM, Express 4, Drizzle ORM, PostgreSQL 16, `bcryptjs`, `node:test` runner, `supertest`, vanilla JS frontend (no bundler).

---

## File Structure

- Modify: `server/db/schema.js` — add `staff.position`, `staff.hourlyRate`, `staff.attendancePin`; add new `attendanceEvents` table.
- Create: `server/lib/attendance.js` — pure helpers (`pairEventsToShifts`, `summarizeHours`, `computeWage`).
- Create: `server/schemas/attendance.js` — zod schemas (`pinSchema`, `clockSchema`, `manualEventSchema`, `summaryQuerySchema`).
- Create: `server/routes/attendance.js` — Express router with 6 endpoints (mounted partially without auth).
- Modify: `server/app.js` — mount the router; the public sub-routes are mounted before `auth` so `/api/attendance/identify` and `/api/attendance/clock` work without a Bearer token.
- Modify: `server/schemas/staff.js` — extend create/update schemas with the 3 new fields.
- Modify: `server/routes/staff.js` — accept new fields, hash `attendance_pin` like the existing POS PIN.
- Create: `dochadzka.html` — standalone PIN pad terminal (separate from `pos-enterprise.html`).
- Create: `js/dochadzka.js` — page logic (PIN buffer, identify, clock, status display).
- Create: `css/dochadzka.css` — minimal styles, reuses tokens from `tokens.css`.
- Modify: `admin/pages/staff.js` — add inputs for `position`, `hourlyRate`, `attendancePin`.
- Create: `admin/pages/dochadzka.js` — admin page for hours/wages summary, event history, manual edit.
- Modify: `admin/router.js` — register new `dochadzka` route.
- Modify: `admin/index.html` — sidebar link to Dochádzka.
- Modify: `sw.js` — include the new static assets in `STATIC_ASSETS`.
- Test: `server/test/lib/attendance.test.js` — pairing/summarizing logic.
- Test: `server/test/routes/attendance.test.js` — endpoint integration (PIN flow + admin flow).
- Test: `server/test/schemas/attendance.test.js` — schema validation edge cases.

---

## Task 1: Schema migration — staff columns + attendance_events table

**Files:**
- Modify: `server/db/schema.js`

- [ ] **Step 1: Add the three staff columns and the new table**

In `server/db/schema.js`, locate the `staff` table block. Add the three new columns to the object passed to `pgTable('staff', { ... })`:

```javascript
export const staff = pgTable('staff', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  pin: varchar('pin', { length: 60 }).notNull(),
  role: varchar('role', { length: 20 }).notNull().default('cisnik'),
  active: boolean('active').notNull().default(true),
  // Attendance / payroll. attendance_pin is a separate bcrypt hash so
  // a leaked POS PIN can't be used to clock anyone in/out, and vice versa.
  position: varchar('position', { length: 50 }).notNull().default(''),
  hourlyRate: numeric('hourly_rate', { precision: 8, scale: 2 }),
  attendancePin: varchar('attendance_pin', { length: 60 }),
});
```

Append the new `attendanceEvents` table at the end of the existing tables block (anywhere after `staff` is fine):

```javascript
export const attendanceEvents = pgTable('attendance_events', {
  id: serial('id').primaryKey(),
  staffId: integer('staff_id').notNull().references(() => staff.id),
  // 'clock_in' or 'clock_out'. Kept as varchar to mirror the existing
  // schema style instead of a Drizzle enum (no migration churn).
  type: varchar('type', { length: 12 }).notNull(),
  at: timestamp('at').notNull().defaultNow(),
  // 'pin' for the dochadzka.html terminal, 'manual' for admin overrides.
  source: varchar('source', { length: 20 }).notNull().default('pin'),
  note: varchar('note', { length: 200 }).notNull().default(''),
  // For manual edits: who entered/edited the row.
  editedBy: integer('edited_by').references(() => staff.id),
}, (t) => [
  index('attendance_events_staff_at_idx').on(t.staffId, t.at),
  index('attendance_events_at_idx').on(t.at),
]);
```

- [ ] **Step 2: Push the schema**

```bash
cd server && npm run db:push
```

Expected: `drizzle-kit push` reports the four new columns and the new table, no destructive changes.

- [ ] **Step 3: Smoke check**

```bash
cd server && node -e "import('./db/index.js').then(async ({db}) => { const r = await db.execute(\"SELECT column_name FROM information_schema.columns WHERE table_name='staff' AND column_name IN ('position','hourly_rate','attendance_pin')\"); console.log(r.rows); const r2 = await db.execute(\"SELECT to_regclass('public.attendance_events')\"); console.log(r2.rows); process.exit(0); })"
```

Expected: prints all three new columns and `attendance_events` (not null).

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.js
git commit -m "schema: add staff position/hourly_rate/attendance_pin + attendance_events

Position and hourly rate are nullable/empty defaults so existing rows
keep working. attendance_pin is a separate bcrypt hash so a leaked POS
PIN can't clock anyone in. attendance_events stores raw clock_in/out
rows keyed by (staff_id, at) — pairing into shifts happens in code."
```

---

## Task 2: Pure helpers — pair events into shifts, summarize, compute wage

**Files:**
- Create: `server/lib/attendance.js`
- Test: `server/test/lib/attendance.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/test/lib/attendance.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairEventsToShifts, summarizeHours, computeWage } from '../../lib/attendance.js';

const at = (iso) => new Date(iso);

test('pairEventsToShifts pairs in→out within the same day', () => {
  const events = [
    { id: 1, type: 'clock_in',  at: at('2026-05-01T09:00:00Z') },
    { id: 2, type: 'clock_out', at: at('2026-05-01T13:00:00Z') },
    { id: 3, type: 'clock_in',  at: at('2026-05-01T14:00:00Z') },
    { id: 4, type: 'clock_out', at: at('2026-05-01T18:30:00Z') },
  ];
  const shifts = pairEventsToShifts(events);
  assert.equal(shifts.length, 2);
  assert.equal(shifts[0].minutes, 240);
  assert.equal(shifts[1].minutes, 270);
  assert.equal(shifts[0].closed, true);
  assert.equal(shifts[1].closed, true);
});

test('pairEventsToShifts marks an open shift when clock_in has no clock_out', () => {
  const events = [
    { id: 1, type: 'clock_in', at: at('2026-05-01T09:00:00Z') },
  ];
  const shifts = pairEventsToShifts(events);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].closed, false);
  assert.equal(shifts[0].minutes, 0);
});

test('pairEventsToShifts ignores a stray clock_out with no preceding clock_in', () => {
  const events = [
    { id: 1, type: 'clock_out', at: at('2026-05-01T13:00:00Z') },
  ];
  const shifts = pairEventsToShifts(events);
  assert.equal(shifts.length, 0);
});

test('summarizeHours sums closed shifts only', () => {
  const shifts = [
    { minutes: 240, closed: true },
    { minutes: 270, closed: true },
    { minutes: 0,   closed: false }, // open shift, not counted
  ];
  assert.equal(summarizeHours(shifts).minutes, 510);
  assert.equal(summarizeHours(shifts).openShifts, 1);
});

test('computeWage rounds to 2 decimals', () => {
  // 510 minutes = 8.5 h * 12.34 EUR/h = 104.89 EUR
  assert.equal(computeWage(510, '12.34'), 104.89);
  // numeric NULL rate → 0
  assert.equal(computeWage(510, null), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node --test test/lib/attendance.test.js
```

Expected: FAIL with `Cannot find module '../../lib/attendance.js'`.

- [ ] **Step 3: Implement the helpers**

Create `server/lib/attendance.js`:

```javascript
/**
 * Attendance helpers — pure functions, no DB or framework deps.
 *
 * Events come in as `{ id, type, at }` rows ordered by `at` ASC. We pair
 * each `clock_in` with the next `clock_out` for the same staff. A trailing
 * `clock_in` with no `clock_out` is an "open" shift (cashier forgot to
 * clock out) and contributes 0 minutes — admin must close it manually.
 */

export function pairEventsToShifts(events) {
  const shifts = [];
  let openIn = null;
  for (const ev of events) {
    if (ev.type === 'clock_in') {
      if (openIn) {
        // Two clock_ins in a row = previous shift never closed. Keep it open.
        shifts.push({ inEvent: openIn, outEvent: null, minutes: 0, closed: false });
      }
      openIn = ev;
    } else if (ev.type === 'clock_out') {
      if (!openIn) continue; // stray clock_out
      const minutes = Math.round((ev.at.getTime() - openIn.at.getTime()) / 60000);
      shifts.push({ inEvent: openIn, outEvent: ev, minutes, closed: true });
      openIn = null;
    }
  }
  if (openIn) {
    shifts.push({ inEvent: openIn, outEvent: null, minutes: 0, closed: false });
  }
  return shifts;
}

export function summarizeHours(shifts) {
  let minutes = 0;
  let openShifts = 0;
  for (const s of shifts) {
    if (s.closed) minutes += s.minutes;
    else openShifts += 1;
  }
  return { minutes, openShifts };
}

export function computeWage(minutes, hourlyRate) {
  const rate = parseFloat(hourlyRate);
  if (!Number.isFinite(rate)) return 0;
  return Math.round((minutes / 60) * rate * 100) / 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node --test test/lib/attendance.test.js
```

Expected: PASS for all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add server/lib/attendance.js server/test/lib/attendance.test.js
git commit -m "lib(attendance): pair clock events into shifts, sum, wage

Pure helpers — no DB, no framework. Open shifts (clock_in without
matching clock_out) count as 0 minutes and surface in summary so admin
can fix them by hand. Wage rounded to 2 decimals."
```

---

## Task 3: Zod schemas for attendance

**Files:**
- Create: `server/schemas/attendance.js`
- Test: `server/test/schemas/attendance.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/schemas/attendance.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinSchema, clockSchema, manualEventSchema, summaryQuerySchema } from '../../schemas/attendance.js';

test('pinSchema accepts 4-6 digits', () => {
  assert.equal(pinSchema.safeParse({ pin: '1234' }).success, true);
  assert.equal(pinSchema.safeParse({ pin: '123456' }).success, true);
  assert.equal(pinSchema.safeParse({ pin: '12' }).success, false);
  assert.equal(pinSchema.safeParse({ pin: '1234567' }).success, false);
  assert.equal(pinSchema.safeParse({ pin: '12ab' }).success, false);
});

test('clockSchema requires pin + valid type', () => {
  assert.equal(clockSchema.safeParse({ pin: '1234', type: 'clock_in' }).success, true);
  assert.equal(clockSchema.safeParse({ pin: '1234', type: 'clock_out' }).success, true);
  assert.equal(clockSchema.safeParse({ pin: '1234', type: 'punch' }).success, false);
  assert.equal(clockSchema.safeParse({ pin: '1234' }).success, false);
});

test('manualEventSchema requires staffId + type + at + optional note', () => {
  const ok = manualEventSchema.safeParse({
    staffId: 5, type: 'clock_in', at: '2026-05-01T09:00:00Z', note: 'forgot',
  });
  assert.equal(ok.success, true);
  const bad = manualEventSchema.safeParse({ staffId: 'x', type: 'clock_in', at: 'not a date' });
  assert.equal(bad.success, false);
});

test('summaryQuerySchema requires from <= to as ISO date strings', () => {
  assert.equal(summaryQuerySchema.safeParse({ from: '2026-05-01', to: '2026-05-31' }).success, true);
  assert.equal(summaryQuerySchema.safeParse({ from: '2026-05-31', to: '2026-05-01' }).success, false);
  assert.equal(summaryQuerySchema.safeParse({ from: 'bad', to: '2026-05-01' }).success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node --test test/schemas/attendance.test.js
```

Expected: FAIL with `Cannot find module '../../schemas/attendance.js'`.

- [ ] **Step 3: Implement the schemas**

Create `server/schemas/attendance.js`:

```javascript
import { z } from 'zod';

const pinValue = z.string().regex(/^\d{4,6}$/, 'PIN musi byt 4 az 6 cifier');

export const pinSchema = z.object({ pin: pinValue });

export const clockSchema = z.object({
  pin: pinValue,
  type: z.enum(['clock_in', 'clock_out']),
});

export const manualEventSchema = z.object({
  staffId: z.number().int().positive(),
  type: z.enum(['clock_in', 'clock_out']),
  at: z.string().datetime(),
  note: z.string().max(200).optional().default(''),
});

export const summaryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from musi byt YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to musi byt YYYY-MM-DD'),
}).refine((q) => q.from <= q.to, { message: 'from musi byt <= to' });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node --test test/schemas/attendance.test.js
```

Expected: PASS for all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add server/schemas/attendance.js server/test/schemas/attendance.test.js
git commit -m "schemas(attendance): pin/clock/manualEvent/summaryQuery"
```

---

## Task 4: Public attendance routes — identify + clock (PIN-based, no JWT)

**Files:**
- Create: `server/routes/attendance.js`
- Modify: `server/app.js`
- Test: `server/test/routes/attendance.test.js` (new)

- [ ] **Step 1: Write the failing integration test for the PIN flow**

Create `server/test/routes/attendance.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../../app.js';
import { db } from '../../db/index.js';
import { staff, attendanceEvents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb } from '../helpers/setup.js';

async function makeStaffWithAttendancePin(pin) {
  const [row] = await db.insert(staff).values({
    name: 'Test',
    pin: bcrypt.hashSync('0000', 10),
    role: 'cisnik',
    position: 'Casnik',
    hourlyRate: '7.50',
    attendancePin: bcrypt.hashSync(pin, 10),
  }).returning();
  return row;
}

test('POST /api/attendance/identify returns staff + currentState=clocked_out', async (t) => {
  await setupTestDb();
  t.after(teardownTestDb);
  const s = await makeStaffWithAttendancePin('4321');

  const res = await request(app).post('/api/attendance/identify').send({ pin: '4321' });
  assert.equal(res.status, 200);
  assert.equal(res.body.staff.id, s.id);
  assert.equal(res.body.staff.name, 'Test');
  assert.equal(res.body.staff.position, 'Casnik');
  assert.equal(res.body.currentState, 'clocked_out');
  assert.equal(res.body.todayMinutes, 0);
});

test('POST /api/attendance/identify rejects an unknown PIN with 401', async (t) => {
  await setupTestDb();
  t.after(teardownTestDb);
  await makeStaffWithAttendancePin('4321');

  const res = await request(app).post('/api/attendance/identify').send({ pin: '9999' });
  assert.equal(res.status, 401);
});

test('POST /api/attendance/clock toggles state and writes a row', async (t) => {
  await setupTestDb();
  t.after(teardownTestDb);
  const s = await makeStaffWithAttendancePin('4321');

  const r1 = await request(app).post('/api/attendance/clock').send({ pin: '4321', type: 'clock_in' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.currentState, 'clocked_in');

  const rows = await db.select().from(attendanceEvents).where(eq(attendanceEvents.staffId, s.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'clock_in');
  assert.equal(rows[0].source, 'pin');

  const r2 = await request(app).post('/api/attendance/clock').send({ pin: '4321', type: 'clock_out' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.currentState, 'clocked_out');
  assert.ok(r2.body.todayMinutes > 0);
});

test('POST /api/attendance/clock rejects clock_in when already clocked in', async (t) => {
  await setupTestDb();
  t.after(teardownTestDb);
  await makeStaffWithAttendancePin('4321');

  await request(app).post('/api/attendance/clock').send({ pin: '4321', type: 'clock_in' });
  const dup = await request(app).post('/api/attendance/clock').send({ pin: '4321', type: 'clock_in' });
  assert.equal(dup.status, 409);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/attendance.test.js
```

Expected: FAIL — module `../../routes/attendance.js` doesn't exist (and route isn't mounted).

- [ ] **Step 3: Implement the public routes**

Create `server/routes/attendance.js`:

```javascript
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { staff, attendanceEvents, authAttempts } from '../db/schema.js';
import { eq, and, gte, lte, desc, sql, count } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/requireRole.js';
import { asyncRoute } from '../lib/async-route.js';
import { pinSchema, clockSchema, manualEventSchema, summaryQuerySchema } from '../schemas/attendance.js';
import { pairEventsToShifts, summarizeHours, computeWage } from '../lib/attendance.js';

export const publicRouter = Router();
export const adminRouter = Router();

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
  } catch { return 0; }
}

async function recordAttempt({ staffId, ip, success }) {
  try {
    await db.insert(authAttempts).values({ staffId: staffId ?? null, ip: ip || '', success: !!success });
  } catch {}
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
  const since = startOfTodayUtc();
  const events = await eventsForStaffSince(staffMember.id, since);
  const shifts = pairEventsToShifts(events);
  const summary = summarizeHours(shifts);
  const lastEvent = events[events.length - 1] || null;
  const currentState = lastEvent && lastEvent.type === 'clock_in' ? 'clocked_in' : 'clocked_out';
  return { currentState, todayMinutes: summary.minutes, lastEvent };
}

publicRouter.post('/identify', validate(pinSchema), asyncRoute(async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
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
```

- [ ] **Step 4: Mount the public router in `app.js`**

In `server/app.js`, after the imports add:

```javascript
import { publicRouter as attendancePublicRouter, adminRouter as attendanceAdminRouter } from './routes/attendance.js';
```

Then mount them. The public sub-routes go BEFORE the `auth` middleware (no JWT), and the admin sub-routes go AFTER. Find the existing block where other routers are mounted (around `app.use('/api/auth', authRoutes)`) and add:

```javascript
// Public attendance terminal — PIN auth, no JWT.
app.use('/api/attendance', attendancePublicRouter);
// Admin attendance — same prefix, but JWT-gated. Express matches the more
// specific routes from the public router first; admin paths only match here.
app.use('/api/attendance', auth, attendanceAdminRouter);
```

- [ ] **Step 5: Run the integration tests — expect PASS**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/attendance.test.js
```

Expected: PASS for all 4 cases.

- [ ] **Step 6: Run the full suite (no regressions)**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true npm test
```

Expected: PASS overall.

- [ ] **Step 7: Commit**

```bash
git add server/routes/attendance.js server/test/routes/attendance.test.js server/app.js
git commit -m "attendance: public PIN-based identify + clock endpoints

Two new endpoints behind no JWT, gated only by attendance_pin:
- POST /api/attendance/identify -> staff + today's state
- POST /api/attendance/clock     -> writes clock_in/out, returns state

Anti-bruteforce reuses auth_attempts (same pattern as /verify-manager):
PIN_MAX_ATTEMPTS=5 per 15 min by IP for unknown attempts, then by
staff_id once we've matched. DISABLE_PIN_RATE_LIMIT=true bypasses for
E2E."
```

---

## Task 5: Admin attendance routes — history + summary + manual edit

**Files:**
- Modify: `server/routes/attendance.js`
- Modify: `server/test/routes/attendance.test.js` (extend)

- [ ] **Step 1: Add failing tests for the admin endpoints**

Append to `server/test/routes/attendance.test.js`:

```javascript
import jwt from 'jsonwebtoken';
import { attendanceEvents as ae } from '../../db/schema.js';

function adminToken(id) {
  return jwt.sign({ id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

test('GET /api/attendance/history/:staffId returns events + computed shifts', async (t) => {
  await setupTestDb();
  t.after(teardownTestDb);
  const s = await makeStaffWithAttendancePin('4321');
  const day = new Date('2026-05-01T00:00:00Z');
  await db.insert(ae).values([
    { staffId: s.id, type: 'clock_in',  at: new Date('2026-05-01T09:00:00Z'), source: 'pin' },
    { staffId: s.id, type: 'clock_out', at: new Date('2026-05-01T13:00:00Z'), source: 'pin' },
  ]);

  const res = await request(app)
    .get(`/api/attendance/history/${s.id}?from=2026-05-01&to=2026-05-01`)
    .set('Authorization', `Bearer ${adminToken(s.id)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 2);
  assert.equal(res.body.summary.minutes, 240);
  assert.equal(res.body.summary.openShifts, 0);
});

test('GET /api/attendance/summary returns one row per staff with wage', async (t) => {
  await setupTestDb();
  t.after(teardownTestDb);
  const s = await makeStaffWithAttendancePin('4321');
  await db.insert(ae).values([
    { staffId: s.id, type: 'clock_in',  at: new Date('2026-05-01T09:00:00Z'), source: 'pin' },
    { staffId: s.id, type: 'clock_out', at: new Date('2026-05-01T13:00:00Z'), source: 'pin' },
  ]);

  const res = await request(app)
    .get('/api/attendance/summary?from=2026-05-01&to=2026-05-31')
    .set('Authorization', `Bearer ${adminToken(s.id)}`);
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r) => r.staffId === s.id);
  assert.ok(row);
  assert.equal(row.minutes, 240);
  // 240 min = 4 h * 7.50 EUR/h = 30.00 EUR
  assert.equal(row.wage, 30);
});

test('POST /api/attendance/events adds a manual entry (admin only)', async (t) => {
  await setupTestDb();
  t.after(teardownTestDb);
  const s = await makeStaffWithAttendancePin('4321');

  const res = await request(app)
    .post('/api/attendance/events')
    .set('Authorization', `Bearer ${adminToken(s.id)}`)
    .send({ staffId: s.id, type: 'clock_in', at: '2026-05-01T09:00:00Z', note: 'forgot' });
  assert.equal(res.status, 201);
  assert.equal(res.body.event.source, 'manual');
  assert.equal(res.body.event.note, 'forgot');
});

test('DELETE /api/attendance/events/:id removes a manual entry (admin only)', async (t) => {
  await setupTestDb();
  t.after(teardownTestDb);
  const s = await makeStaffWithAttendancePin('4321');
  const [ev] = await db.insert(ae).values({
    staffId: s.id, type: 'clock_in', at: new Date('2026-05-01T09:00:00Z'), source: 'manual',
  }).returning();

  const res = await request(app)
    .delete(`/api/attendance/events/${ev.id}`)
    .set('Authorization', `Bearer ${adminToken(s.id)}`);
  assert.equal(res.status, 200);

  const left = await db.select().from(ae).where(eq(ae.id, ev.id));
  assert.equal(left.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/attendance.test.js
```

Expected: PASS for the 4 public-flow tests, FAIL for the 4 new admin tests (404 / no router).

- [ ] **Step 3: Implement the admin routes**

In `server/routes/attendance.js`, after the `publicRouter` definition and before `export default publicRouter`, add:

```javascript
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
```

- [ ] **Step 4: Run all attendance tests — expect PASS**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/attendance.test.js
```

Expected: PASS for all 8 cases.

- [ ] **Step 5: Run full server suite**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true npm test
```

Expected: PASS overall.

- [ ] **Step 6: Commit**

```bash
git add server/routes/attendance.js server/test/routes/attendance.test.js
git commit -m "attendance: admin history/summary/manual-edit endpoints (manazer+)

GET /api/attendance/history/:staffId?from&to     - per-staff events + shifts
GET /api/attendance/summary?from&to              - all staff hours + wages
POST /api/attendance/events                       - manual record
DELETE /api/attendance/events/:id                 - delete manual record

All four require manazer/admin via requireRole."
```

---

## Task 6: Extend staff CRUD — accept new fields, hash attendance PIN

**Files:**
- Modify: `server/schemas/staff.js`
- Modify: `server/routes/staff.js`

- [ ] **Step 1: Locate the existing schemas + routes**

Read `server/schemas/staff.js` (top to ~50 lines) to find the create/update zod schemas.
Read `server/routes/staff.js` (top to ~80 lines) to find where `pin` is hashed today.

- [ ] **Step 2: Extend the zod schemas**

In `server/schemas/staff.js`, the existing `staffCreateSchema` (or equivalent) probably has `name`, `pin`, `role`, `active`. Extend it:

```javascript
import { z } from 'zod';

const positionSchema = z.string().max(50).optional().default('');
const hourlyRateSchema = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d{1,2})?$/)]).optional();
const attendancePinSchema = z.string().regex(/^\d{4,6}$/, 'PIN musi byt 4 az 6 cifier').optional();

export const staffCreateSchema = z.object({
  name: z.string().min(1).max(80),
  pin: z.string().regex(/^\d{4,6}$/),
  role: z.enum(['cisnik', 'manazer', 'admin']),
  active: z.boolean().optional().default(true),
  position: positionSchema,
  hourlyRate: hourlyRateSchema,
  attendancePin: attendancePinSchema,
});

export const staffUpdateSchema = staffCreateSchema.partial();
```

(If the file already has `staffCreateSchema` and `staffUpdateSchema` defined differently, merge — keep existing fields intact and add the three new optional ones.)

- [ ] **Step 3: Hash and persist the new fields in the route**

In `server/routes/staff.js`, find the `POST /` handler and the `PUT /:id` handler. After the existing `bcrypt.hashSync(pin, 10)` call, add a parallel branch for `attendancePin`. Example for POST:

```javascript
const insertValues = {
  name: req.body.name,
  pin: bcrypt.hashSync(req.body.pin, 10),
  role: req.body.role,
  active: req.body.active ?? true,
  position: req.body.position || '',
};
if (req.body.hourlyRate != null) insertValues.hourlyRate = String(req.body.hourlyRate);
if (req.body.attendancePin) insertValues.attendancePin = bcrypt.hashSync(req.body.attendancePin, 10);
const [created] = await db.insert(staff).values(insertValues).returning();
```

For PUT, mirror — only set the field when present:

```javascript
const updates = {};
if (req.body.name != null) updates.name = req.body.name;
if (req.body.pin) updates.pin = bcrypt.hashSync(req.body.pin, 10);
if (req.body.role != null) updates.role = req.body.role;
if (req.body.active != null) updates.active = req.body.active;
if (req.body.position != null) updates.position = req.body.position;
if (req.body.hourlyRate != null) updates.hourlyRate = String(req.body.hourlyRate);
if (req.body.attendancePin) updates.attendancePin = bcrypt.hashSync(req.body.attendancePin, 10);
const [updated] = await db.update(staff).set(updates).where(eq(staff.id, +req.params.id)).returning();
```

When returning rows to the admin UI, **never include the bcrypt hashes**. Strip them explicitly in the GET handlers:

```javascript
const safe = (s) => ({
  id: s.id, name: s.name, role: s.role, active: s.active,
  position: s.position || '', hourlyRate: s.hourlyRate,
  hasPin: !!s.pin, hasAttendancePin: !!s.attendancePin,
});
res.json(rows.map(safe));
```

- [ ] **Step 4: Run the existing staff suite + ad-hoc smoke**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/auth.test.js test/routes/role-gates.test.js test/schemas/staff.test.js
```

Expected: PASS — existing tests don't reference the new fields, defaults preserve compatibility.

- [ ] **Step 5: Commit**

```bash
git add server/schemas/staff.js server/routes/staff.js
git commit -m "staff: accept position/hourlyRate/attendancePin in CRUD

bcrypt-hash attendancePin separately from the POS pin. GET responses
strip both hashes and return hasPin / hasAttendancePin booleans so the
admin UI can show 'set'/'not set' without leaking material."
```

---

## Task 7: Standalone /dochadzka.html terminal page

**Files:**
- Create: `dochadzka.html`
- Create: `js/dochadzka.js`
- Create: `css/dochadzka.css`
- Modify: `sw.js`

- [ ] **Step 1: Create the HTML scaffold**

Create `dochadzka.html`:

```html
<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Dochadzka</title>
  <link rel="stylesheet" href="/tokens.css?v=12" />
  <link rel="stylesheet" href="/a11y.css?v=12" />
  <link rel="stylesheet" href="/css/dochadzka.css?v=12" />
</head>
<body>
  <main class="doch-shell">
    <h1 class="doch-title">Dochadzka</h1>

    <section class="doch-status" id="status">
      <div class="doch-status-empty">Zadaj svoj PIN</div>
    </section>

    <section class="doch-pin">
      <div class="doch-pin-display" id="pinDisplay" aria-live="polite"></div>
      <div class="doch-pad">
        <button class="doch-key" data-d="1">1</button>
        <button class="doch-key" data-d="2">2</button>
        <button class="doch-key" data-d="3">3</button>
        <button class="doch-key" data-d="4">4</button>
        <button class="doch-key" data-d="5">5</button>
        <button class="doch-key" data-d="6">6</button>
        <button class="doch-key" data-d="7">7</button>
        <button class="doch-key" data-d="8">8</button>
        <button class="doch-key" data-d="9">9</button>
        <button class="doch-key doch-key-clr" id="pinClr">C</button>
        <button class="doch-key" data-d="0">0</button>
        <button class="doch-key doch-key-bk" id="pinBk">&larr;</button>
      </div>
    </section>

    <section class="doch-actions" id="actions" hidden>
      <button class="doch-btn doch-btn-in"  id="btnIn"  hidden>Prichod</button>
      <button class="doch-btn doch-btn-out" id="btnOut" hidden>Odchod</button>
    </section>

    <div class="doch-toast" id="toast" role="status" aria-live="polite"></div>
  </main>
  <script src="/js/dochadzka.js?v=12"></script>
</body>
</html>
```

- [ ] **Step 2: Page logic**

Create `js/dochadzka.js`:

```javascript
'use strict';
// Standalone dochadzka terminal — no JWT, no api.js. Talks only to
// /api/attendance/identify and /api/attendance/clock with a PIN.

(function () {
  var pin = '';
  var currentStaff = null;
  var currentState = 'clocked_out';
  var resetTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  function fmtMinutes(m) {
    if (!Number.isFinite(m)) return '0h 0m';
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return h + 'h ' + mm + 'm';
  }

  function showToast(msg, ok) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'doch-toast show ' + (ok ? 'ok' : 'err');
    setTimeout(function () { t.className = 'doch-toast'; }, 2400);
  }

  function renderPin() {
    var dots = '';
    for (var i = 0; i < pin.length; i++) dots += '<span class="dot"></span>';
    $('pinDisplay').innerHTML = dots;
  }

  function renderStatus(staff, state, todayMinutes) {
    var s = $('status');
    if (!staff) {
      s.innerHTML = '<div class="doch-status-empty">Zadaj svoj PIN</div>';
      $('actions').hidden = true;
      return;
    }
    var label = state === 'clocked_in' ? 'V praci' : 'Doma';
    s.innerHTML =
      '<div class="doch-status-name">' + escapeHtml(staff.name) + '</div>' +
      (staff.position ? '<div class="doch-status-pos">' + escapeHtml(staff.position) + '</div>' : '') +
      '<div class="doch-status-state ' + state + '">' + label + '</div>' +
      '<div class="doch-status-today">Dnes: ' + fmtMinutes(todayMinutes) + '</div>';
    $('actions').hidden = false;
    $('btnIn').hidden = state === 'clocked_in';
    $('btnOut').hidden = state === 'clocked_out';
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function resetSoon() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(function () {
      pin = ''; currentStaff = null; currentState = 'clocked_out';
      renderPin(); renderStatus(null);
    }, 8000);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }

  function tryIdentify() {
    if (pin.length < 4) return;
    postJson('/api/attendance/identify', { pin: pin }).then(function (res) {
      if (!res.ok) {
        showToast(res.data.error || 'Neplatny PIN', false);
        pin = ''; renderPin();
        return;
      }
      currentStaff = res.data.staff;
      currentState = res.data.currentState;
      renderStatus(currentStaff, currentState, res.data.todayMinutes);
      resetSoon();
    });
  }

  function clock(type) {
    if (!currentStaff || !pin) return;
    postJson('/api/attendance/clock', { pin: pin, type: type }).then(function (res) {
      if (!res.ok) {
        showToast(res.data.error || 'Chyba', false);
        return;
      }
      currentState = res.data.currentState;
      renderStatus(res.data.staff, currentState, res.data.todayMinutes);
      showToast(type === 'clock_in' ? 'Prichod zaznamenany' : 'Odchod zaznamenany', true);
      // Auto-clear after success so the next person sees a fresh terminal.
      setTimeout(function () {
        pin = ''; currentStaff = null; currentState = 'clocked_out';
        renderPin(); renderStatus(null);
      }, 2400);
    });
  }

  document.querySelectorAll('.doch-key[data-d]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (pin.length >= 6) return;
      pin += b.getAttribute('data-d');
      renderPin();
      if (pin.length >= 4) tryIdentify();
    });
  });
  $('pinClr').addEventListener('click', function () { pin = ''; renderPin(); renderStatus(null); });
  $('pinBk').addEventListener('click', function () { pin = pin.slice(0, -1); renderPin(); });
  $('btnIn').addEventListener('click', function () { clock('clock_in'); });
  $('btnOut').addEventListener('click', function () { clock('clock_out'); });

  document.addEventListener('keydown', function (e) {
    if (/^\d$/.test(e.key)) {
      if (pin.length >= 6) return;
      pin += e.key; renderPin();
      if (pin.length >= 4) tryIdentify();
    } else if (e.key === 'Backspace') {
      pin = pin.slice(0, -1); renderPin();
    } else if (e.key === 'Escape') {
      pin = ''; renderPin(); renderStatus(null);
    }
  });

  renderPin();
  renderStatus(null);
})();
```

- [ ] **Step 3: Styles**

Create `css/dochadzka.css`:

```css
:root { color-scheme: dark; }
body { margin: 0; padding: 0; background: var(--surface-bg, #0e0e12); color: var(--text-primary, #e9e9f0); font-family: var(--font-body, system-ui); -webkit-tap-highlight-color: transparent; }
.doch-shell { max-width: 460px; margin: 0 auto; padding: 24px 20px env(safe-area-inset-bottom, 16px); }
.doch-title { text-align: center; margin: 8px 0 16px; font-size: 28px; letter-spacing: .02em; }
.doch-status { min-height: 110px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 16px 12px; border-radius: 14px; background: var(--surface-card, #1a1a22); margin-bottom: 16px; }
.doch-status-empty { opacity: .55; font-size: 18px; }
.doch-status-name { font-size: 26px; font-weight: 700; }
.doch-status-pos { opacity: .7; font-size: 14px; }
.doch-status-state { font-size: 16px; padding: 4px 12px; border-radius: 999px; margin-top: 6px; }
.doch-status-state.clocked_in  { background: rgba(95, 200, 130, .18); color: #6ed599; }
.doch-status-state.clocked_out { background: rgba(180, 180, 200, .14); color: #b9b9c7; }
.doch-status-today { opacity: .8; font-size: 14px; }
.doch-pin-display { display: flex; gap: 12px; justify-content: center; min-height: 28px; margin: 8px 0 14px; }
.doch-pin-display .dot { width: 16px; height: 16px; border-radius: 50%; background: var(--text-primary, #fff); display: inline-block; }
.doch-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.doch-key { font-size: 26px; font-weight: 600; padding: 18px 0; border-radius: 12px; border: 1px solid rgba(255, 255, 255, .08); background: var(--surface-card, #1a1a22); color: inherit; cursor: pointer; min-height: 64px; }
.doch-key:active { transform: scale(.97); background: rgba(255, 255, 255, .06); }
.doch-key-clr { background: rgba(224, 112, 112, .18); }
.doch-key-bk  { background: rgba(180, 180, 200, .12); }
.doch-actions { display: flex; gap: 12px; margin-top: 18px; }
.doch-btn { flex: 1; padding: 22px 0; font-size: 22px; font-weight: 700; border-radius: 14px; border: 0; color: #07120a; cursor: pointer; min-height: 72px; }
.doch-btn-in  { background: linear-gradient(135deg, #5edba8, #42c490); }
.doch-btn-out { background: linear-gradient(135deg, #f1a47a, #e08a5b); color: #2a0e02; }
.doch-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(40px); opacity: 0; transition: opacity .2s, transform .2s; padding: 12px 18px; border-radius: 999px; background: #222; font-weight: 600; }
.doch-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.doch-toast.ok  { background: rgba(95, 200, 130, .9); color: #07120a; }
.doch-toast.err { background: rgba(224, 112, 112, .92); color: #2a0707; }
```

- [ ] **Step 4: Add to service worker precache**

In `sw.js`, append the three paths to `STATIC_ASSETS`:

```javascript
  '/dochadzka.html',
  '/js/dochadzka.js',
  '/css/dochadzka.css',
```

- [ ] **Step 5: Manual smoke**

Open `http://localhost:3080/dochadzka.html` in a browser. With a staff row that has `attendance_pin` set (you can set one ad-hoc later via the admin page from Task 8 — for now insert one via psql), type the PIN. Expect: status panel appears with name + position + state; tapping `Prichod` writes a row in `attendance_events`; tapping `Odchod` closes it; toast confirms each action.

- [ ] **Step 6: Commit**

```bash
git add dochadzka.html js/dochadzka.js css/dochadzka.css sw.js
git commit -m "ui(dochadzka): standalone PIN terminal page

dochadzka.html is fully self-contained (no JWT, no api.js, no
admin/router). Numeric PIN pad calls /api/attendance/identify after
4 digits, then exposes Prichod/Odchod buttons matching the staff's
current state. Auto-clears 8s after identify and 2.4s after a clock
action so the next person sees a fresh terminal."
```

---

## Task 8: Admin /staff page — extend form with new fields

**Files:**
- Modify: `admin/pages/staff.js`

- [ ] **Step 1: Extend the existing staff form**

Read `admin/pages/staff.js` to find the form template (search for `fName`, `fPin`, etc).

Add these inputs into the form HTML (next to the existing PIN field):

```html
<label class="admin-field">
  <span>Pozicia</span>
  <input type="text" id="fPosition" maxlength="50" placeholder="napr. Casnik" />
</label>
<label class="admin-field">
  <span>Hodinova sadza (EUR)</span>
  <input type="number" id="fHourlyRate" step="0.01" min="0" placeholder="0.00" />
</label>
<label class="admin-field">
  <span>Dochadzka PIN (4–6 cifier)</span>
  <input type="text" id="fAttendancePin" pattern="\d{4,6}" placeholder="Nastavit / zmenit" />
  <small id="fAttendancePinStatus" class="muted"></small>
</label>
```

When opening the edit modal, populate:

```javascript
byId('fPosition').value = row.position || '';
byId('fHourlyRate').value = row.hourlyRate != null ? row.hourlyRate : '';
byId('fAttendancePin').value = '';
byId('fAttendancePinStatus').textContent = row.hasAttendancePin
  ? 'PIN je nastaveny — vyplnte len ak chcete zmenit'
  : 'PIN nie je nastaveny';
```

In the save handler, attach the new fields to the request body. Send `attendancePin` only if non-empty (so blank input means "keep existing"):

```javascript
const body = {
  name: byId('fName').value.trim(),
  role: byId('fRole').value,
  active: byId('fActive').checked,
  position: byId('fPosition').value.trim(),
};
const rate = byId('fHourlyRate').value.trim();
if (rate !== '') body.hourlyRate = rate;
const newPin = byId('fPin').value.trim();
if (newPin) body.pin = newPin;
const newAttPin = byId('fAttendancePin').value.trim();
if (newAttPin) body.attendancePin = newAttPin;
```

- [ ] **Step 2: Manual smoke**

Open `/admin/#staff`, edit a row. Set `Pozicia=Casnik`, `Hodinova sadza=8.00`, `Dochadzka PIN=4321`. Save. Reload. Expect: position + rate visible, attendance PIN status reads "PIN je nastaveny — vyplnte len ak chcete zmenit".

- [ ] **Step 3: Commit**

```bash
git add admin/pages/staff.js
git commit -m "admin(staff): position, hourly rate, attendance PIN fields"
```

---

## Task 9: New admin /dochadzka page

**Files:**
- Create: `admin/pages/dochadzka.js`
- Modify: `admin/router.js`
- Modify: `admin/index.html`

- [ ] **Step 1: Register the route**

In `admin/router.js`, find the existing route registry (lazy `import()` map keyed by hash). Add:

```javascript
'dochadzka': () => import('./pages/dochadzka.js'),
```

- [ ] **Step 2: Add the sidebar link**

In `admin/index.html`, find the sidebar nav list. Add the new item after `staff`:

```html
<li><a href="#dochadzka">Dochadzka</a></li>
```

- [ ] **Step 3: Implement the page module**

Create `admin/pages/dochadzka.js`:

```javascript
'use strict';

let _container = null;
let _from = todayMinusDays(7);
let _to = today();
let _summary = { rows: [] };
let _expanded = null; // staffId currently expanded

function todayIso() { return new Date().toISOString().slice(0, 10); }
function today() { return todayIso(); }
function todayMinusDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtMinutes(m) {
  if (!Number.isFinite(m)) return '0h 0m';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + 'h ' + mm + 'm';
}
function fmtEur(n) { return Number(n || 0).toFixed(2) + ' €'; }
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function loadSummary() {
  const res = await api.get(`/attendance/summary?from=${_from}&to=${_to}`);
  _summary = res || { rows: [] };
  render();
}

async function loadHistory(staffId) {
  return api.get(`/attendance/history/${staffId}?from=${_from}&to=${_to}`);
}

function render() {
  if (!_container) return;
  _container.innerHTML =
    '<header class="admin-page-header"><h1>Dochadzka</h1></header>' +
    '<div class="admin-toolbar">' +
      '<label>Od <input type="date" id="dFrom" value="' + _from + '"></label>' +
      '<label>Do <input type="date" id="dTo" value="' + _to + '"></label>' +
      '<button class="admin-btn" id="dRefresh">Obnovit</button>' +
    '</div>' +
    '<table class="admin-table doch-table">' +
      '<thead><tr><th>Meno</th><th>Pozicia</th><th>Sadza</th><th>Hodiny</th><th>Otv. smeny</th><th>Mzda</th><th></th></tr></thead>' +
      '<tbody id="dBody"></tbody>' +
    '</table>' +
    '<div id="dDetail"></div>';

  _container.querySelector('#dRefresh').addEventListener('click', () => {
    _from = _container.querySelector('#dFrom').value;
    _to = _container.querySelector('#dTo').value;
    loadSummary();
  });

  const body = _container.querySelector('#dBody');
  if (!_summary.rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">Ziadne data</td></tr>';
    return;
  }
  body.innerHTML = _summary.rows.map((r) => (
    '<tr data-staff="' + r.staffId + '">' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td>' + escapeHtml(r.position || '') + '</td>' +
      '<td>' + (r.hourlyRate != null ? fmtEur(r.hourlyRate) + '/h' : '<span class="muted">—</span>') + '</td>' +
      '<td>' + fmtMinutes(r.minutes) + '</td>' +
      '<td>' + (r.openShifts > 0 ? '<span class="badge warn">' + r.openShifts + '</span>' : '0') + '</td>' +
      '<td>' + fmtEur(r.wage) + '</td>' +
      '<td><button class="admin-btn-mini" data-toggle="' + r.staffId + '">Detail</button></td>' +
    '</tr>'
  )).join('');

  body.querySelectorAll('button[data-toggle]').forEach((b) => {
    b.addEventListener('click', () => toggleDetail(parseInt(b.getAttribute('data-toggle'), 10)));
  });
}

async function toggleDetail(staffId) {
  if (_expanded === staffId) {
    _expanded = null;
    _container.querySelector('#dDetail').innerHTML = '';
    return;
  }
  _expanded = staffId;
  const detail = _container.querySelector('#dDetail');
  detail.innerHTML = '<div class="muted">Nacitavam…</div>';
  const data = await loadHistory(staffId);
  const evRows = data.events.map((e) => (
    '<tr>' +
      '<td>' + new Date(e.at).toLocaleString('sk-SK') + '</td>' +
      '<td>' + (e.type === 'clock_in' ? 'Prichod' : 'Odchod') + '</td>' +
      '<td>' + escapeHtml(e.source || '') + '</td>' +
      '<td>' + escapeHtml(e.note || '') + '</td>' +
      '<td><button class="admin-btn-mini danger" data-del="' + e.id + '">×</button></td>' +
    '</tr>'
  )).join('');

  detail.innerHTML =
    '<h3>Detail — ' + escapeHtml(data.staff && data.staff.name || '') + '</h3>' +
    '<form id="dManualForm" class="admin-toolbar">' +
      '<label>Typ <select id="mType"><option value="clock_in">Prichod</option><option value="clock_out">Odchod</option></select></label>' +
      '<label>Cas <input type="datetime-local" id="mAt" required></label>' +
      '<label>Poznamka <input type="text" id="mNote" maxlength="200"></label>' +
      '<button class="admin-btn" type="submit">Pridat zaznam</button>' +
    '</form>' +
    '<table class="admin-table"><thead><tr><th>Cas</th><th>Typ</th><th>Zdroj</th><th>Poznamka</th><th></th></tr></thead><tbody>' +
    (evRows || '<tr><td colspan="5" class="muted">Bez zaznamov</td></tr>') +
    '</tbody></table>';

  detail.querySelector('#dManualForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const at = detail.querySelector('#mAt').value;
    const type = detail.querySelector('#mType').value;
    const note = detail.querySelector('#mNote').value;
    await api.post('/attendance/events', { staffId, type, at: new Date(at).toISOString(), note });
    await loadSummary();
    await toggleDetail(staffId); // close
    await toggleDetail(staffId); // re-open with new data
  });
  detail.querySelectorAll('button[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Vymazat zaznam?')) return;
      await api.del('/attendance/events/' + b.getAttribute('data-del'));
      await loadSummary();
      await toggleDetail(staffId); await toggleDetail(staffId);
    });
  });
}

export default {
  init(container) {
    _container = container;
    loadSummary();
  },
};
```

- [ ] **Step 4: Manual smoke**

Open `/admin/#dochadzka`. Expect: 7-day summary table; click `Detail` on a staff row → events list + manual entry form. Add a manual `clock_in` for `09:00` today; expect the row to appear and the `Hodiny` column to update after summary reload.

- [ ] **Step 5: Commit**

```bash
git add admin/pages/dochadzka.js admin/router.js admin/index.html
git commit -m "admin(dochadzka): summary + per-staff detail + manual edit"
```

---

## Task 10: Deploy + DB push on the kasa

**Files:** none (deploy only).

- [ ] **Step 1: Push branch + deploy**

```bash
git push origin claude/mystifying-pike-558184:main
DEPLOY_HOST=surfs@100.95.64.38 bash scripts/deploy-tailscale-pos.sh
```

Expected: deploy script reports `=== Deploy complete ===` after rebuilding the container.

- [ ] **Step 2: Push schema migration**

```bash
ssh surfs@100.95.64.38 'docker compose -f C:/POS/docker-compose.yml exec -T app sh -lc "cd /app/server && npm run db:push -- --force"'
```

Expected: `[✓] Changes applied` from drizzle-kit, with the four new columns and the new table.

- [ ] **Step 3: Health check**

```bash
ssh surfs@100.95.64.38 "curl -s http://localhost:3080/api/health"
```

Expected: `{"status":"ok", ...}` with both printers `status: ok`.

- [ ] **Step 4: End-to-end smoke**

1. In `/admin/#staff`, edit one staff member: set `Pozicia`, `Hodinova sadza`, and a 4-digit `Dochadzka PIN`.
2. Open `/dochadzka.html` on a phone or tablet on the LAN.
3. Type the PIN; expect status panel with name + state.
4. Tap `Prichod`. Toast `Prichod zaznamenany`.
5. Wait a minute, type PIN again, tap `Odchod`. Toast `Odchod zaznamenany`.
6. Open `/admin/#dochadzka`. Expect the staff row showing 1 closed shift and the right wage.

- [ ] **Step 5: No commit needed if everything passed**

```bash
git status
git log --oneline -10
```

Expected: working tree clean, the most recent commits on `main` map 1:1 to Tasks 1–9.

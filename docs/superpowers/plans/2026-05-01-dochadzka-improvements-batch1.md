# Dochádzka Improvements — Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five highest-impact, lowest-effort gaps in the attendance system: auto-close orphaned shifts at 04:00, require a `reason` on every manual edit, surface a live "kto je v práci" widget on the admin dashboard, replace the small terminal toast with a full-screen confirm splash, and switch the PIN lockout key to per-staff once a row matches.

**Architecture:** All five items extend the existing attendance feature without rewriting it. Backend additions: one new column (`attendance_events.reason`), one new public endpoint (`GET /api/attendance/active`), one new background job (`server/lib/attendance-auto-close.js` invoked from `server/server.js` on a daily timer), one schema-validation tightening (`reason` required on manual events). Frontend additions: a dropdown in the admin manual-event form, a `<aside>` widget on `/admin/#dashboard`, and a full-screen splash on `/dochadzka.html`. The PIN-lockout fix is a small refactor in `server/routes/attendance.js`.

**Tech Stack:** Node.js ESM, Express 4, Drizzle ORM, PostgreSQL 16, `node:test` + supertest, vanilla JS frontend (no bundler).

---

## File Structure

- Modify: `server/db/schema.js` — add `attendance_events.reason varchar(20) NULL` (dropdown values, NULL for PIN events).
- Modify: `server/schemas/attendance.js` — `reason` becomes required on `manualEventSchema`; add `attendanceReasonSchema` enum used by both client and server.
- Modify: `server/routes/attendance.js` — store `reason` on manual `POST /events`; refactor `failuresFor` to use per-staff bucket once a PIN matches; add `GET /active`.
- Create: `server/lib/attendance-auto-close.js` — pure helper `closeOpenShifts(now)` that returns rows to insert + caller does the insert in one TX.
- Modify: `server/server.js` — start a daily timer that calls `closeOpenShifts` at 04:00 Bratislava.
- Modify: `js/dochadzka.js` — replace the toast on `clock_in`/`clock_out` with a full-screen splash; auto-clear after 3s.
- Modify: `css/dochadzka.css` — `.doch-splash` styles.
- Modify: `admin/pages/dochadzka.js` — required reason `<select>` in the manual-entry form; render `source='auto_close'` rows with an amber badge; surface "X auto-uzavretých" count on the detail summary.
- Modify: `admin/pages/dashboard.js` — new "Kto je v práci" panel at the top, auto-refresh every 30s, calls `GET /api/attendance/active`.
- Test: `server/test/lib/attendance-auto-close.test.js` — pure-helper unit tests (open shift detected, already-closed not duplicated, multiple staff handled).
- Modify: `server/test/routes/attendance.test.js` — add tests for `reason` required, `GET /active`, per-staff lockout.

---

## Task 1: Schema — add `attendance_events.reason`

**Files:**
- Modify: `server/db/schema.js`

- [ ] **Step 1: Add the column**

In `server/db/schema.js`, locate the `attendanceEvents` table block and add the `reason` column right after `note`:

```javascript
export const attendanceEvents = pgTable('attendance_events', {
  id: serial('id').primaryKey(),
  staffId: integer('staff_id').notNull().references(() => staff.id),
  type: varchar('type', { length: 12 }).notNull(),
  at: timestamp('at').notNull().defaultNow(),
  // 'pin' | 'manual' | 'auto_close'
  source: varchar('source', { length: 20 }).notNull().default('pin'),
  note: varchar('note', { length: 200 }).notNull().default(''),
  // For source='manual': required reason from a fixed enum (forgot,
  // wrong_time, shift_change, pin_failed, other). NULL for PIN-driven
  // and auto_close rows so the column is always meaningful.
  reason: varchar('reason', { length: 20 }),
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

Expected: `drizzle-kit push` reports `attendance_events.reason` added; no destructive prompts.

- [ ] **Step 3: Smoke check**

```bash
cd server && node -e "import('./db/index.js').then(async ({db}) => { const r = await db.execute(\"SELECT column_name FROM information_schema.columns WHERE table_name='attendance_events' AND column_name='reason'\"); console.log(r.rows); process.exit(0); })"
```

Expected: prints `[ { column_name: 'reason' } ]`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.js
git commit -m "schema: add attendance_events.reason for manual-edit audit

Required (via zod) on source='manual' rows, NULL on source='pin' and
'auto_close'. Fixed enum: forgot / wrong_time / shift_change /
pin_failed / other."
```

---

## Task 2: Auto-close pure helper

**Files:**
- Create: `server/lib/attendance-auto-close.js`
- Test: `server/test/lib/attendance-auto-close.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/lib/attendance-auto-close.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrphanedClockIns, buildAutoCloseRows } from '../../lib/attendance-auto-close.js';

const ev = (id, staffId, type, at) => ({ id, staffId, type, at: new Date(at) });

test('findOrphanedClockIns returns staff whose last event before cutoff is clock_in', () => {
  const events = [
    ev(1, 5, 'clock_in',  '2026-05-01T18:00:00Z'),
    ev(2, 5, 'clock_out', '2026-05-01T22:00:00Z'),
    ev(3, 6, 'clock_in',  '2026-05-01T19:00:00Z'),
    // staff 6 forgot to clock out
  ];
  const cutoff = new Date('2026-05-02T02:00:00Z'); // 04:00 Bratislava
  const orphans = findOrphanedClockIns(events, cutoff);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].staffId, 6);
  assert.equal(orphans[0].lastInEvent.id, 3);
});

test('findOrphanedClockIns ignores staff whose last event is after cutoff', () => {
  const events = [
    ev(1, 5, 'clock_in', '2026-05-02T03:00:00Z'), // already after cutoff — current shift, leave alone
  ];
  const cutoff = new Date('2026-05-02T02:00:00Z');
  assert.equal(findOrphanedClockIns(events, cutoff).length, 0);
});

test('findOrphanedClockIns ignores staff whose last event is clock_out', () => {
  const events = [
    ev(1, 5, 'clock_in',  '2026-05-01T18:00:00Z'),
    ev(2, 5, 'clock_out', '2026-05-01T22:00:00Z'),
  ];
  const cutoff = new Date('2026-05-02T02:00:00Z');
  assert.equal(findOrphanedClockIns(events, cutoff).length, 0);
});

test('buildAutoCloseRows returns one clock_out row per orphan with the cutoff timestamp', () => {
  const orphans = [
    { staffId: 6, lastInEvent: ev(3, 6, 'clock_in', '2026-05-01T19:00:00Z') },
    { staffId: 7, lastInEvent: ev(4, 7, 'clock_in', '2026-05-01T20:00:00Z') },
  ];
  const cutoff = new Date('2026-05-02T02:00:00Z');
  const rows = buildAutoCloseRows(orphans, cutoff);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    staffId: 6, type: 'clock_out', at: cutoff, source: 'auto_close', note: 'auto', reason: null,
  });
  assert.deepEqual(rows[1], {
    staffId: 7, type: 'clock_out', at: cutoff, source: 'auto_close', note: 'auto', reason: null,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node --test test/lib/attendance-auto-close.test.js
```

Expected: FAIL with `Cannot find module '../../lib/attendance-auto-close.js'`.

- [ ] **Step 3: Implement the helper**

Create `server/lib/attendance-auto-close.js`:

```javascript
/**
 * Pure helpers for the daily auto-close cron. No DB access — caller
 * loads recent events and inserts the returned rows in a single TX.
 *
 * Contract: events is an array of { id, staffId, type, at: Date } sorted
 * ASCENDING by `at`. cutoff is the Date at which we declare unfinished
 * shifts dead (typically 04:00 Bratislava local).
 *
 * findOrphanedClockIns groups events by staff, takes the last event
 * before the cutoff, and returns those whose last event is clock_in.
 * Staff whose last event is at-or-after the cutoff are left alone —
 * those are current/future shifts the cron must not touch.
 */

export function findOrphanedClockIns(events, cutoff) {
  const lastByStaff = new Map();
  for (const ev of events) {
    if (ev.at >= cutoff) continue;
    lastByStaff.set(ev.staffId, ev);
  }
  const orphans = [];
  for (const [staffId, lastInEvent] of lastByStaff.entries()) {
    if (lastInEvent.type === 'clock_in') {
      orphans.push({ staffId, lastInEvent });
    }
  }
  return orphans;
}

export function buildAutoCloseRows(orphans, cutoff) {
  return orphans.map(({ staffId }) => ({
    staffId,
    type: 'clock_out',
    at: cutoff,
    source: 'auto_close',
    note: 'auto',
    reason: null,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node --test test/lib/attendance-auto-close.test.js
```

Expected: PASS — 4/4 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/lib/attendance-auto-close.js server/test/lib/attendance-auto-close.test.js
git commit -m "lib(attendance): pure helpers for the daily auto-close cron"
```

---

## Task 3: Wire the daily timer in `server/server.js`

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Read the current server entry point**

Read `server/server.js` end-to-end. Identify where the HTTP server is started and where other startup-time wiring lives (e.g. print queue worker).

- [ ] **Step 2: Add the daily-timer scheduler**

Append to `server/server.js`, after the existing startup wiring (e.g. after `startPrintQueue()` if it exists):

```javascript
import { db } from './db/index.js';
import { attendanceEvents } from './db/schema.js';
import { gte, lte, asc } from 'drizzle-orm';
import { findOrphanedClockIns, buildAutoCloseRows } from './lib/attendance-auto-close.js';

// Daily auto-close: at 04:00 Europe/Bratislava we close any shift that
// crossed midnight without a clock_out. Without this, one forgotten
// Odchod permanently ruins the staff's hours/wages report.
async function runAutoCloseOnce(now = new Date()) {
  // Cutoff = 04:00 Bratislava on the date just past. Postgres handles the
  // TZ math so DST switches don't drift this by an hour.
  const cutoffSql = await db.execute(
    `SELECT (date_trunc('day', NOW() AT TIME ZONE 'Europe/Bratislava') + INTERVAL '4 hours') AT TIME ZONE 'Europe/Bratislava' AS cutoff`
  );
  const cutoff = cutoffSql.rows[0]?.cutoff;
  if (!cutoff) return { closed: 0 };
  const cutoffDate = new Date(cutoff);
  // Look 36h back so we cover at most one missed run; any older orphans
  // would already have been closed by a prior tick.
  const since = new Date(cutoffDate.getTime() - 36 * 60 * 60 * 1000);

  return await db.transaction(async (tx) => {
    const rows = await tx.select().from(attendanceEvents)
      .where(gte(attendanceEvents.at, since))
      .orderBy(asc(attendanceEvents.at));
    const orphans = findOrphanedClockIns(rows, cutoffDate);
    if (!orphans.length) return { closed: 0 };
    const insertRows = buildAutoCloseRows(orphans, cutoffDate);
    await tx.insert(attendanceEvents).values(insertRows);
    return { closed: insertRows.length, staffIds: insertRows.map(r => r.staffId) };
  });
}

function scheduleAutoClose() {
  function msUntilNext0400Local() {
    const now = new Date();
    // Compute "next 04:00 Bratislava" by asking Postgres directly so the
    // DST boundary is correct.
    return db.execute(
      `SELECT EXTRACT(EPOCH FROM (
         (date_trunc('day', (NOW() AT TIME ZONE 'Europe/Bratislava') + INTERVAL '1 day')
            + INTERVAL '4 hours') AT TIME ZONE 'Europe/Bratislava' - NOW()
       )) * 1000 AS ms`
    ).then(r => Math.max(60_000, Number(r.rows[0]?.ms) || 24 * 60 * 60 * 1000));
  }
  async function loop() {
    try {
      const result = await runAutoCloseOnce();
      if (result && result.closed > 0) {
        console.log(`[attendance] auto-closed ${result.closed} orphan shift(s)`, result.staffIds);
      }
    } catch (e) {
      console.error('[attendance] auto-close failed:', e?.message || e);
    }
    const ms = await msUntilNext0400Local();
    setTimeout(loop, ms);
  }
  // First tick: schedule for the next 04:00 Bratislava. Don't run on boot
  // — that would close shifts again right after a deploy.
  msUntilNext0400Local().then((ms) => setTimeout(loop, ms));
}

scheduleAutoClose();
```

- [ ] **Step 3: Smoke — start the server, verify the scheduler logs nothing on boot**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node server.js &
sleep 2
echo "If no '[attendance] auto-close' line appeared, scheduler is dormant as designed."
kill %1 || true
```

(In a real shell. The test below is what actually exercises the close path.)

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "server: schedule daily attendance auto-close at 04:00 Bratislava

Computes next-tick delay via Postgres TIME ZONE math so the timer
survives DST switches without drifting by an hour. First firing is
scheduled (not run on boot) so a deploy does not close shifts twice."
```

---

## Task 4: Tighten `manualEventSchema` — `reason` becomes required

**Files:**
- Modify: `server/schemas/attendance.js`
- Modify: `server/test/schemas/attendance.test.js`

- [ ] **Step 1: Update the test**

In `server/test/schemas/attendance.test.js`, replace the existing `manualEventSchema requires …` block with:

```javascript
import { manualEventSchema, attendanceReasonSchema } from '../../schemas/attendance.js';

test('manualEventSchema requires staffId + type + at + reason; note optional', () => {
  const ok = manualEventSchema.safeParse({
    staffId: 5, type: 'clock_in', at: '2026-05-01T09:00:00Z', reason: 'forgot', note: 'forgot to clock',
  });
  assert.equal(ok.success, true);
  // No reason → reject
  const noReason = manualEventSchema.safeParse({ staffId: 5, type: 'clock_in', at: '2026-05-01T09:00:00Z' });
  assert.equal(noReason.success, false);
  // Bad enum value → reject
  const bad = manualEventSchema.safeParse({
    staffId: 5, type: 'clock_in', at: '2026-05-01T09:00:00Z', reason: 'whatever',
  });
  assert.equal(bad.success, false);
});

test('attendanceReasonSchema accepts the documented values', () => {
  for (const v of ['forgot','wrong_time','shift_change','pin_failed','other']) {
    assert.equal(attendanceReasonSchema.safeParse(v).success, true, `should accept "${v}"`);
  }
  assert.equal(attendanceReasonSchema.safeParse('').success, false);
});
```

- [ ] **Step 2: Run the failing tests**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/schemas/attendance.test.js
```

Expected: 2 of the new asserts FAIL — `attendanceReasonSchema` does not exist and the existing `manualEventSchema` does not require `reason`.

- [ ] **Step 3: Update the schema**

In `server/schemas/attendance.js`:

```javascript
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

export const summaryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from musi byt YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to musi byt YYYY-MM-DD'),
}).refine((q) => q.from <= q.to, { message: 'from musi byt <= to' });
```

- [ ] **Step 4: Pass the tests**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/schemas/attendance.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/schemas/attendance.js server/test/schemas/attendance.test.js
git commit -m "schemas(attendance): require reason on manualEventSchema"
```

---

## Task 5: Persist `reason` on manual-event insert

**Files:**
- Modify: `server/routes/attendance.js`
- Modify: `server/test/routes/attendance.test.js`

- [ ] **Step 1: Extend the existing manual-events test**

In `server/test/routes/attendance.test.js`, find the `POST /api/attendance/events` test and tighten it:

```javascript
test('POST /api/attendance/events saves the reason field', async () => {
  await db.delete(authAttempts);
  const s = await makeStaffWithAttendancePin('4321');
  const res = await request(app)
    .post('/api/attendance/events')
    .set('Authorization', `Bearer ${tokens.admin(1)}`)
    .send({ staffId: s.id, type: 'clock_in', at: '2026-05-01T09:00:00Z', reason: 'forgot', note: 'zabudol' });
  assert.equal(res.status, 201);
  assert.equal(res.body.event.reason, 'forgot');
  assert.equal(res.body.event.source, 'manual');
});

test('POST /api/attendance/events rejects when reason missing', async () => {
  await db.delete(authAttempts);
  const s = await makeStaffWithAttendancePin('4321');
  const res = await request(app)
    .post('/api/attendance/events')
    .set('Authorization', `Bearer ${tokens.admin(1)}`)
    .send({ staffId: s.id, type: 'clock_in', at: '2026-05-01T09:00:00Z' });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/attendance.test.js
```

Expected: the two new assertions FAIL.

- [ ] **Step 3: Update the route handler**

In `server/routes/attendance.js`, find `adminRouter.post('/events', ...)` and add `reason` to the insert:

```javascript
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
```

- [ ] **Step 4: Pass the tests**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/attendance.test.js
```

Expected: PASS for the 2 new tests; existing tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add server/routes/attendance.js server/test/routes/attendance.test.js
git commit -m "attendance: persist reason on manual-event insert"
```

---

## Task 6: Per-staff lockout — switch bucket after PIN matches

**Files:**
- Modify: `server/routes/attendance.js`
- Modify: `server/test/routes/attendance.test.js`

- [ ] **Step 1: Add the failing test**

In `server/test/routes/attendance.test.js`, append:

```javascript
test('PIN lockout switches to per-staff bucket once a PIN matches', async () => {
  // Two staff with two different attendance PINs.
  const a = await makeStaffWithAttendancePin('1111');
  const b = await makeStaffWithAttendancePin('2222');
  // Don't let DISABLE_PIN_RATE_LIMIT short-circuit this test.
  delete process.env.DISABLE_PIN_RATE_LIMIT;
  // 5 wrong PIN attempts from one IP — IP bucket fills.
  for (let i = 0; i < 5; i++) {
    await request(app).post('/api/attendance/identify').send({ pin: '9999' });
  }
  // Staff A whose PIN matches should still get through.
  const okA = await request(app).post('/api/attendance/identify').send({ pin: '1111' });
  assert.equal(okA.status, 200, 'matched PIN must bypass IP-only lockout');
  // Now five wrong attempts targeting staff A's id specifically (we
  // simulate by failing the matched-PIN path 5 times).
  for (let i = 0; i < 5; i++) {
    await request(app).post('/api/attendance/identify').send({ pin: '1111x' }); // unmatched
  }
  // Staff B should still be allowed — different bucket.
  const okB = await request(app).post('/api/attendance/identify').send({ pin: '2222' });
  assert.equal(okB.status, 200, 'staff B must not inherit staff A lockout');
  process.env.DISABLE_PIN_RATE_LIMIT = 'true';
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd server && node --test test/routes/attendance.test.js --test-name-pattern="lockout switches to per-staff"
```

Expected: FAIL — current code uses the IP-only bucket so any 5 wrong attempts lock everyone.

- [ ] **Step 3: Refactor the gate**

In `server/routes/attendance.js`, find both `publicRouter.post('/identify', …)` and `publicRouter.post('/clock', …)`. Replace the early IP-only gate with a two-stage gate that runs after the staff lookup:

```javascript
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
```

Apply the same pattern to the `/clock` handler (look up the staff first, derive `lockKey`, check `failuresFor`).

- [ ] **Step 4: Pass the tests**

```bash
cd server && node --test test/routes/attendance.test.js
```

Expected: all attendance tests PASS, including the new lockout-bucket test.

- [ ] **Step 5: Commit**

```bash
git add server/routes/attendance.js server/test/routes/attendance.test.js
git commit -m "attendance: per-staff lockout once a PIN matches; per-IP only for unknown PINs

Old behavior was IP-only — 5 wrong PINs from one tablet locked the
whole kasa for 15 minutes. Now the bucket switches the moment a PIN
resolves to a staff row: attacker who keeps mistyping their own PIN
locks themselves, not the rest of the team. Unknown PIN guesses still
gate by IP so 5 random attempts can't be repeated indefinitely."
```

---

## Task 7: `GET /api/attendance/active` — live "kto je v práci" feed

**Files:**
- Modify: `server/routes/attendance.js`
- Modify: `server/test/routes/attendance.test.js`

- [ ] **Step 1: Add the failing test**

```javascript
test('GET /api/attendance/active returns clocked-in staff with todayMinutes', async () => {
  const s = await makeStaffWithAttendancePin('4321');
  await db.insert(attendanceEvents).values({
    staffId: s.id, type: 'clock_in', source: 'pin',
  });
  // Backdate to make todayMinutes nonzero.
  await testDb.execute(sql`UPDATE attendance_events SET at = NOW() - INTERVAL '90 minutes' WHERE staff_id = ${s.id}`);

  const res = await request(app)
    .get('/api/attendance/active')
    .set('Authorization', `Bearer ${tokens.admin(1)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.active.length, 1);
  const row = res.body.active[0];
  assert.equal(row.staffId, s.id);
  assert.ok(row.minutes >= 88);  // give a 2-minute test-execution slop
  assert.ok(row.clockedInAt);
});

test('GET /api/attendance/active excludes staff who already clocked out', async () => {
  const s = await makeStaffWithAttendancePin('4321');
  await db.insert(attendanceEvents).values([
    { staffId: s.id, type: 'clock_in',  source: 'pin' },
    { staffId: s.id, type: 'clock_out', source: 'pin' },
  ]);
  const res = await request(app)
    .get('/api/attendance/active')
    .set('Authorization', `Bearer ${tokens.admin(1)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.active.length, 0);
});
```

- [ ] **Step 2: Run the failing tests**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/attendance.test.js
```

Expected: 404 on the new endpoint.

- [ ] **Step 3: Implement the endpoint**

In `server/routes/attendance.js`, add right after `adminRouter.get('/summary', …)`:

```javascript
adminRouter.get('/active', mgr, asyncRoute(async (req, res) => {
  // Find each active staff's most-recent attendance event in one query.
  // Then keep only the ones whose latest event is clock_in.
  const latest = await db.execute(sql`
    SELECT DISTINCT ON (e.staff_id)
      e.staff_id   AS staff_id,
      e.type       AS type,
      e.at         AS at,
      s.name       AS name,
      s.position   AS position
    FROM attendance_events e
    INNER JOIN staff s ON s.id = e.staff_id AND s.active = true
    ORDER BY e.staff_id, e.at DESC
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
```

- [ ] **Step 4: Pass the tests**

```bash
cd server && DISABLE_PIN_RATE_LIMIT=true node --test test/routes/attendance.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/attendance.js server/test/routes/attendance.test.js
git commit -m "attendance: GET /active for the dashboard 'kto je v praci' widget"
```

---

## Task 8: Admin Dochádzka page — reason dropdown + auto-close badge

**Files:**
- Modify: `admin/pages/dochadzka.js`

- [ ] **Step 1: Add a required `<select>` to the manual-entry form**

In `admin/pages/dochadzka.js`, find the inline form template inside `toggleDetail()` (the block that builds `detail.innerHTML` with the `dManualForm`). Insert a new field **before** the Čas input:

```javascript
'<label class="doch-toolbar-label">Dôvod' +
  '<select id="mReason" class="doch-input" required>' +
    '<option value="">— vyber —</option>' +
    '<option value="forgot">Zabudol kliknúť</option>' +
    '<option value="wrong_time">Nesprávny čas</option>' +
    '<option value="shift_change">Zmena zmeny</option>' +
    '<option value="pin_failed">PIN zlyhal</option>' +
    '<option value="other">Iné</option>' +
  '</select>' +
'</label>' +
```

- [ ] **Step 2: Read `reason` and send it on submit**

Replace the form-submit handler body inside `toggleDetail()`:

```javascript
detail.querySelector('#dManualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const at = detail.querySelector('#mAt').value;
  const type = detail.querySelector('#mType').value;
  const reason = detail.querySelector('#mReason').value;
  const note = detail.querySelector('#mNote').value.trim();
  if (!at || !reason) {
    showToast('Vyber čas aj dôvod úpravy', 'error');
    return;
  }
  try {
    await api.post('/attendance/events', {
      staffId, type,
      at: new Date(at).toISOString(),
      reason, note,
    });
    showToast('Záznam pridaný', true);
    await loadSummary();
    _expanded = null;
    await toggleDetail(staffId);
  } catch (err) {
    showToast(err.message || 'Záznam sa nepodarilo pridať', 'error');
  }
});
```

- [ ] **Step 3: Render `reason` and `auto_close` badge in the events table**

In the same `toggleDetail()`, find the event-row mapper and replace it with:

```javascript
const events = (data.events || []).slice().reverse(); // newest first
const reasonLabels = {
  forgot: 'Zabudol kliknúť',
  wrong_time: 'Nesprávny čas',
  shift_change: 'Zmena zmeny',
  pin_failed: 'PIN zlyhal',
  other: 'Iné',
};
const evRows = events.map((e) => {
  let sourceCell;
  if (e.source === 'auto_close') sourceCell = '<span class="badge badge-warning">auto-zatvorené</span>';
  else if (e.source === 'manual') sourceCell = '<span class="badge badge-warning">manuálne</span>';
  else sourceCell = '<span class="text-muted">PIN</span>';
  const reasonCell = e.reason
    ? '<span class="text-muted">' + escapeHtml(reasonLabels[e.reason] || e.reason) + '</span>'
    : '<span class="text-muted">—</span>';
  return (
    '<tr class="data-row">' +
      '<td class="data-td">' + escapeHtml(formatLocalDateTime(e.at)) + '</td>' +
      '<td class="data-td">' + (e.type === 'clock_in'
        ? '<span class="badge badge-success">Príchod</span>'
        : '<span class="badge badge-info">Odchod</span>') + '</td>' +
      '<td class="data-td">' + sourceCell + '</td>' +
      '<td class="data-td">' + reasonCell + '</td>' +
      '<td class="data-td">' + (e.note ? escapeHtml(e.note) : '<span class="text-muted">—</span>') + '</td>' +
      '<td class="data-td">' +
        '<button class="btn-toggle-status doch-event-del" data-del="' + e.id + '" title="Vymazať záznam">✕</button>' +
      '</td>' +
    '</tr>'
  );
}).join('');
```

Update the events table header to add a `Dôvod` column:

```javascript
'<thead><tr>' +
  '<th class="data-th">Čas</th>' +
  '<th class="data-th">Typ</th>' +
  '<th class="data-th">Zdroj</th>' +
  '<th class="data-th">Dôvod</th>' +
  '<th class="data-th">Poznámka</th>' +
  '<th class="data-th"></th>' +
'</tr></thead>'
```

And the colspan on the empty-state row:

```javascript
(evRows || '<tr><td class="data-td" colspan="6"><div class="empty-hint">Bez záznamov za toto obdobie.</div></td></tr>')
```

- [ ] **Step 4: Surface auto-closed count in the detail summary line**

In the same block where you render `summaryLine`, add an extra hint when `events` contains any `auto_close`:

```javascript
const autoCount = (data.events || []).filter((e) => e.source === 'auto_close').length;
const autoLine = autoCount > 0
  ? '<span class="badge badge-warning">' + autoCount + ' auto-zatvorené</span> '
  : '';
```

Then put `autoLine` next to `summaryLine` in the inserted HTML.

- [ ] **Step 5: Manual smoke**

Open `/admin/#dochadzka`, click `Detail` on any staff. Try to submit the form without picking a reason → toast error. Pick "Zabudol kliknúť" + a time → row appears with badge "Zabudol kliknúť" in the new column.

- [ ] **Step 6: Commit**

```bash
git add admin/pages/dochadzka.js
git commit -m "admin(dochadzka): required reason on manual edits, auto-close badge"
```

---

## Task 9: Dashboard "Kto je v práci" widget

**Files:**
- Modify: `admin/pages/dashboard.js`
- Modify: `admin/admin.css`

- [ ] **Step 1: Add the panel HTML to dashboard `init`**

In `admin/pages/dashboard.js`, find where `container.innerHTML` is set in `init`. **Above** the `Prehľad dňa` section-label, prepend:

```javascript
`<div class="row dashboard-row-single dochadzka-active-row">
  <div class="col-50">
    <div class="panel" id="ktoJeVPraciPanel">
      <div class="panel-title">
        <svg aria-hidden="true" viewBox="0 0 24 24" class="panel-icon panel-icon-accent"><circle cx="12" cy="8" r="4"/><path d="M3 21a9 9 0 0118 0"/></svg>
        Kto je v práci
      </div>
      <div id="ktoJeVPraciList" class="loading-placeholder">Načítavam…</div>
    </div>
  </div>
</div>` +
```

- [ ] **Step 2: Implement loadActiveStaff and wire it into `refreshDashboardData` + 30s tick**

In `admin/pages/dashboard.js`, append:

```javascript
async function loadActiveStaff() {
  if (!_container) return;
  const listEl = _container.querySelector('#ktoJeVPraciList');
  if (!listEl) return;
  try {
    const data = await api.get('/attendance/active');
    listEl.classList.remove('loading-placeholder');
    const rows = (data && data.active) || [];
    if (!rows.length) {
      listEl.innerHTML = '<div class="text-muted" style="padding:8px 0">Nikto sa zatiaľ neoznačil.</div>';
      return;
    }
    listEl.innerHTML = '<div class="kto-list">' + rows.map((r) => {
      const h = Math.floor(r.minutes / 60);
      const m = r.minutes % 60;
      const since = new Date(r.clockedInAt).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
      return '<div class="kto-row">' +
        '<div class="kto-name">' + (r.name || '?') + '</div>' +
        (r.position ? '<div class="kto-pos">' + r.position + '</div>' : '') +
        '<div class="kto-time">od ' + since + '</div>' +
        '<div class="kto-mins"><strong>' + h + 'h ' + m + 'm</strong></div>' +
      '</div>';
    }).join('') + '</div>';
  } catch (err) {
    listEl.classList.remove('loading-placeholder');
    listEl.innerHTML = '<div class="text-muted">Chyba načítania (' + (err.message || 'unknown') + ')</div>';
  }
}
```

Modify `refreshDashboardData()`:

```javascript
function refreshDashboardData() {
  loadStats();
  loadBarChart();
  loadUzavierka();
  loadActiveStaff();
}
```

In `init`, change the existing 120s interval to also call `loadActiveStaff` every 30s:

```javascript
interval = setInterval(loadStats, 120000);
const ktoInterval = setInterval(loadActiveStaff, 30000);
// add to destroy below:
//   clearInterval(ktoInterval);
```

Update `destroy()` to also clear the 30s timer.

- [ ] **Step 3: Add CSS**

Append to `admin/admin.css`:

```css
.dochadzka-active-row{margin-bottom:16px}
.kto-list{display:flex;flex-direction:column;gap:8px}
.kto-row{
  display:grid;
  grid-template-columns:1fr auto auto;
  gap:12px;align-items:center;
  padding:8px 12px;border-radius:var(--radius-sm);
  background:rgba(95,200,130,.06);
  border:1px solid rgba(95,200,130,.18);
}
.kto-name{font-weight:700;color:var(--color-text)}
.kto-pos{font-size:12px;color:var(--color-text-sec);grid-column:1;margin-top:-2px}
.kto-time{font-size:12px;color:var(--color-text-sec)}
.kto-mins{font-family:var(--font-display);font-size:18px;color:var(--color-success)}
```

- [ ] **Step 4: Manual smoke**

Open `/admin/#dashboard`. With one staff currently `clocked_in`, the panel shows their name + position + arrival time + accumulated hours. Wait 30s and confirm minutes increments by 0-1.

- [ ] **Step 5: Commit**

```bash
git add admin/pages/dashboard.js admin/admin.css
git commit -m "admin(dashboard): 'Kto je v praci' live widget, refreshes every 30s"
```

---

## Task 10: Terminal confirm splash

**Files:**
- Modify: `js/dochadzka.js`
- Modify: `css/dochadzka.css`

- [ ] **Step 1: Add splash markup to dochadzka.html**

In `dochadzka.html`, just before the closing `</main>`:

```html
<div class="doch-splash" id="splash" hidden>
  <div class="doch-splash-card" id="splashCard">
    <div class="doch-splash-icon" aria-hidden="true">✓</div>
    <div class="doch-splash-title" id="splashTitle">Príchod 18:14</div>
    <div class="doch-splash-name"  id="splashName">Yevhen</div>
  </div>
</div>
```

- [ ] **Step 2: Update `clock(type)` to fire the splash**

In `js/dochadzka.js`, replace `clock(type)`:

```javascript
function clock(type) {
  if (!currentStaff || !pin) return;
  postJson('/api/attendance/clock', { pin: pin, type: type }).then(function (res) {
    if (!res.ok) {
      showToast(res.data.error || 'Chyba', false);
      return;
    }
    currentState = res.data.currentState;
    renderStatus(res.data.staff, currentState, res.data.todayMinutes);
    showSplash(type, res.data.staff && res.data.staff.name);
    setTimeout(function () {
      pin = ''; currentStaff = null; currentState = 'clocked_out';
      renderPin(); renderStatus(null);
    }, 3200);
  });
}

function showSplash(type, name) {
  var el = document.getElementById('splash');
  if (!el) return;
  var now = new Date();
  var hh = String(now.getHours()).padStart(2, '0');
  var mm = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('splashTitle').textContent =
    (type === 'clock_in' ? 'Príchod ' : 'Odchod ') + hh + ':' + mm;
  document.getElementById('splashName').textContent = name || '';
  el.className = 'doch-splash show ' + (type === 'clock_in' ? 'in' : 'out');
  el.hidden = false;
  setTimeout(function () { el.className = 'doch-splash'; el.hidden = true; }, 3000);
}
```

- [ ] **Step 3: Add CSS**

Append to `css/dochadzka.css`:

```css
.doch-splash{
  position:fixed;inset:0;z-index:50;
  display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.45);
  opacity:0;pointer-events:none;transition:opacity .2s;
}
.doch-splash.show{opacity:1;pointer-events:auto}
.doch-splash-card{
  text-align:center;padding:28px 32px;border-radius:18px;
  background:linear-gradient(135deg,#5edba8,#42c490);
  color:#07120a;min-width:280px;
  box-shadow:0 12px 48px rgba(0,0,0,.4);
  transform:scale(.95);transition:transform .2s;
}
.doch-splash.show .doch-splash-card{transform:scale(1)}
.doch-splash.out .doch-splash-card{
  background:linear-gradient(135deg,#f1a47a,#e08a5b);color:#2a0e02;
}
.doch-splash-icon{font-size:64px;line-height:1;margin-bottom:6px;font-weight:700}
.doch-splash-title{font-size:28px;font-weight:700}
.doch-splash-name{font-size:20px;font-weight:600;opacity:.9;margin-top:4px}
```

- [ ] **Step 4: Manual smoke**

Open `/dochadzka.html`, type a PIN, tap Príchod. Full-screen green card "✓ Príchod HH:MM — Name" appears for 3 seconds, then auto-clears.

- [ ] **Step 5: Commit**

```bash
git add dochadzka.html js/dochadzka.js css/dochadzka.css
git commit -m "ui(dochadzka): full-screen confirm splash on Prichod/Odchod"
```

---

## Task 11: Deploy + verify

**Files:** none (deploy only).

- [ ] **Step 1: Push branch + deploy**

```bash
git push origin claude/mystifying-pike-558184:main
DEPLOY_HOST=surfs@100.95.64.38 bash scripts/deploy-tailscale-pos.sh
```

- [ ] **Step 2: Push schema migration on the kasa**

```bash
ssh surfs@100.95.64.38 'docker compose -f C:/POS/docker-compose.yml exec -T app sh -lc "cd /app/server && npm run db:push -- --force"'
```

Expected: `[✓] Changes applied` — `attendance_events.reason` added.

- [ ] **Step 3: Health + scheduler check**

```bash
ssh surfs@100.95.64.38 "curl -s http://localhost:3080/api/health"
ssh surfs@100.95.64.38 'docker compose -f C:/POS/docker-compose.yml logs --since 30s app | grep -i "attendance"'
```

Expected: health ok, no `[attendance] auto-close` line on boot (the next firing is scheduled, not run on boot per Task 3 design).

- [ ] **Step 4: End-to-end smoke**

1. On `/dochadzka.html`: enter a PIN, tap Príchod. Full-screen splash for 3s.
2. Open `/admin/#dashboard`. The "Kto je v práci" panel lists that staff with arrival time + minutes.
3. Open `/admin/#dochadzka`, expand the same staff. Try to add a manual event without a reason → "Vyber čas aj dôvod úpravy" toast. Pick a reason, submit → row appears with the reason badge in a new column.
4. Run a quick lockout test: enter `9999` × 5 from one device → 6th attempt returns 429. With a different staff's correct PIN from another device → 200 (per-staff bucket isolated).
5. Auto-close test (only after 04:00 Bratislava): leave one staff `clocked_in` overnight; next morning the row appears with `source='auto_close'`, badge "auto-zatvorené".

- [ ] **Step 5: Commit any final cleanup; tag**

```bash
git tag -a stable-2026-05-01-dochadzka-v2 -m "Dochadzka batch 1: auto-close + reason + active widget + splash + per-staff lockout"
git push origin stable-2026-05-01-dochadzka-v2
git status
git log --oneline -15
```

Expected: working tree clean, the most recent commits map 1:1 to Tasks 1-10, tag pushed.

// DATABASE_URL must point to pos_test BEFORE Node starts, because db/index.js
// is a static ESM dependency loaded at import time. The npm test script passes:
//   DATABASE_URL=postgresql://pos:pos@localhost:5432/pos_test node --test ...
// Pripusta aj paralelne worker DB (pos_test_w1..w6) — inak sa tento subor
// neda spustit vedla ostatnych bez kolizie na jednej zdielanej pos_test.
// Nazov MUSI zacinat 'pos_test', nech sa testy nikdy netrafia do zivej 'pos'
// (truncateAll() maze 32 tabuliek).
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';

import { app } from '../../app.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import * as schema from '../../db/schema.js';
import { tokens } from '../helpers/auth.js';

const { staff, attendanceEvents, attendancePayouts, cashflowEntries } = schema;
const request = supertest(app);

async function makeStaffWithAttendancePin(pin) {
  const [row] = await testDb.insert(staff).values({
    name: 'Test',
    pin: bcrypt.hashSync('0000', 10),
    role: 'cisnik',
    position: 'Casnik',
    hourlyRate: '7.50',
    attendancePin: bcrypt.hashSync(pin, 10),
  }).returning();
  return row;
}

// Lifecycle hooks at module level so they apply to every describe block in
// this file. Moving them inside a single describe would close the DB pool
// before later describes ran.
before(async () => {
  app.set('io', { emit: () => {} });
});

after(async () => {
  await closeDb();
});

describe('attendance public PIN routes', () => {
  beforeEach(async () => {
    // Clean slate so per-test PIN buckets and attendance rows do not leak.
    await truncateAll();
    await seed();
  });

  it('POST /api/attendance/identify returns staff + currentState=clocked_out', async () => {
    const s = await makeStaffWithAttendancePin('4321');

    const res = await request.post('/api/attendance/identify').send({ pin: '4321' });
    assert.equal(res.status, 200);
    assert.equal(res.body.staff.id, s.id);
    assert.equal(res.body.staff.name, 'Test');
    assert.equal(res.body.staff.position, 'Casnik');
    assert.equal(res.body.currentState, 'clocked_out');
    assert.equal(res.body.todayMinutes, 0);
  });

  it('POST /api/attendance/identify rejects an unknown PIN with 401', async () => {
    await makeStaffWithAttendancePin('4321');

    const res = await request.post('/api/attendance/identify').send({ pin: '9999' });
    assert.equal(res.status, 401);
  });

  it('POST /api/attendance/clock toggles state and writes a row', async () => {
    const s = await makeStaffWithAttendancePin('4321');

    const r1 = await request.post('/api/attendance/clock').send({ pin: '4321', type: 'clock_in' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.currentState, 'clocked_in');

    const rows = await testDb.select().from(attendanceEvents).where(eq(attendanceEvents.staffId, s.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'clock_in');
    assert.equal(rows[0].source, 'pin');

    // Backdate the clock_in so the diff between clock_in/out is > 0 minutes.
    // Without this the events land in the same second and todayMinutes rounds to 0.
    await testDb.execute(
      sql`UPDATE attendance_events SET at = NOW() - INTERVAL '5 minutes' WHERE id = ${rows[0].id}`
    );

    const r2 = await request.post('/api/attendance/clock').send({ pin: '4321', type: 'clock_out' });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.currentState, 'clocked_out');
    assert.ok(r2.body.todayMinutes > 0, `todayMinutes should be > 0, got ${r2.body.todayMinutes}`);
  });

  it('POST /api/attendance/clock rejects clock_in when already clocked in', async () => {
    await makeStaffWithAttendancePin('4321');

    await request.post('/api/attendance/clock').send({ pin: '4321', type: 'clock_in' });
    const dup = await request.post('/api/attendance/clock').send({ pin: '4321', type: 'clock_in' });
    assert.equal(dup.status, 409);
  });

  it('POST /api/attendance/identify reports clocked_in when last clock_in was yesterday (midnight rollover)', async () => {
    const s = await makeStaffWithAttendancePin('4321');

    await testDb.insert(attendanceEvents).values({
      staffId: s.id, type: 'clock_in', source: 'pin',
    });
    // Backdate to yesterday — simulates someone who clocked in before midnight UTC and never clocked out.
    await testDb.execute(sql`UPDATE attendance_events SET at = NOW() - INTERVAL '1 day' WHERE staff_id = ${s.id}`);

    const res = await request.post('/api/attendance/identify').send({ pin: '4321' });
    assert.equal(res.status, 200);
    assert.equal(res.body.currentState, 'clocked_in');
  });

  it('PIN lockout switches to per-staff bucket once a PIN matches', async () => {
    // Two staff with two different attendance PINs.
    await makeStaffWithAttendancePin('1111');
    await makeStaffWithAttendancePin('2222');
    // Don't let DISABLE_PIN_RATE_LIMIT short-circuit this test.
    const prevDisable = process.env.DISABLE_PIN_RATE_LIMIT;
    delete process.env.DISABLE_PIN_RATE_LIMIT;
    try {
      // 5 wrong PIN attempts from one IP — IP bucket fills.
      for (let i = 0; i < 5; i++) {
        await request.post('/api/attendance/identify').send({ pin: '9999' });
      }
      // Staff A whose PIN matches should still get through.
      const okA = await request.post('/api/attendance/identify').send({ pin: '1111' });
      assert.equal(okA.status, 200, 'matched PIN must bypass IP-only lockout');
      // Now five wrong attempts targeting staff A's id specifically (we
      // simulate by failing the matched-PIN path 5 times).
      for (let i = 0; i < 5; i++) {
        await request.post('/api/attendance/identify').send({ pin: '1111x' }); // unmatched
      }
      // Staff B should still be allowed — different bucket.
      const okB = await request.post('/api/attendance/identify').send({ pin: '2222' });
      assert.equal(okB.status, 200, 'staff B must not inherit staff A lockout');
    } finally {
      if (prevDisable !== undefined) process.env.DISABLE_PIN_RATE_LIMIT = prevDisable;
    }
  });
});

describe('attendance admin routes (manazer/admin only)', () => {
  beforeEach(async () => {
    await truncateAll();
    await seed();
  });

  it('GET /api/attendance/history/:staffId returns events + computed shifts', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    await testDb.insert(attendanceEvents).values([
      { staffId: s.id, type: 'clock_in',  at: new Date('2026-05-01T09:00:00Z'), source: 'pin' },
      { staffId: s.id, type: 'clock_out', at: new Date('2026-05-01T13:00:00Z'), source: 'pin' },
    ]);

    const res = await request
      .get(`/api/attendance/history/${s.id}?from=2026-05-01&to=2026-05-01`)
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 2);
    assert.equal(res.body.summary.minutes, 240);
    assert.equal(res.body.summary.openShifts, 0);
  });

  it('GET /api/attendance/summary returns one row per staff with wage', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    await testDb.insert(attendanceEvents).values([
      { staffId: s.id, type: 'clock_in',  at: new Date('2026-05-01T09:00:00Z'), source: 'pin' },
      { staffId: s.id, type: 'clock_out', at: new Date('2026-05-01T13:00:00Z'), source: 'pin' },
    ]);

    const res = await request
      .get('/api/attendance/summary?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 200);
    const row = res.body.rows.find((r) => r.staffId === s.id);
    assert.ok(row);
    assert.equal(row.minutes, 240);
    // 240 min = 4 h * 7.50 EUR/h = 30.00 EUR
    assert.equal(row.wage, 30);
  });

  it('POST /api/attendance/events saves the reason field', async () => {
    const s = await makeStaffWithAttendancePin('4321');

    const res = await request
      .post('/api/attendance/events')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ staffId: s.id, type: 'clock_in', at: '2026-05-01T09:00:00Z', reason: 'forgot', note: 'zabudol' });
    assert.equal(res.status, 201);
    assert.equal(res.body.event.reason, 'forgot');
    assert.equal(res.body.event.source, 'manual');
  });

  it('POST /api/attendance/events rejects when reason missing', async () => {
    const s = await makeStaffWithAttendancePin('4321');

    const res = await request
      .post('/api/attendance/events')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ staffId: s.id, type: 'clock_in', at: '2026-05-01T09:00:00Z' });
    assert.equal(res.status, 400);
  });

  it('DELETE /api/attendance/events/:id removes a manual entry (admin only)', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const [ev] = await testDb.insert(attendanceEvents).values({
      staffId: s.id, type: 'clock_in', at: new Date('2026-05-01T09:00:00Z'), source: 'manual',
    }).returning();

    const res = await request
      .delete(`/api/attendance/events/${ev.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 200);

    const left = await testDb.select().from(attendanceEvents).where(eq(attendanceEvents.id, ev.id));
    assert.equal(left.length, 0);
  });

  it('PATCH /api/attendance/events/:id updates the time and marks it manual', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const [ev] = await testDb.insert(attendanceEvents).values({
      staffId: s.id, type: 'clock_in', at: new Date('2026-05-01T09:00:00Z'), source: 'pin',
    }).returning();

    const res = await request
      .patch(`/api/attendance/events/${ev.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ at: '2026-05-01T08:30:00Z', reason: 'wrong_time', note: 'opraveny prichod' });
    assert.equal(res.status, 200);
    assert.equal(res.body.event.source, 'manual');
    assert.equal(res.body.event.reason, 'wrong_time');
    assert.equal(res.body.event.note, 'opraveny prichod');
    assert.equal(res.body.event.editedBy, 3); // seeded admin staff id
    assert.equal(res.body.event.type, 'clock_in'); // type must NOT change
    assert.equal(new Date(res.body.event.at).toISOString(), '2026-05-01T08:30:00.000Z');
  });

  it('PATCH /api/attendance/events/:id rejects when reason missing', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const [ev] = await testDb.insert(attendanceEvents).values({
      staffId: s.id, type: 'clock_in', at: new Date('2026-05-01T09:00:00Z'), source: 'pin',
    }).returning();

    const res = await request
      .patch(`/api/attendance/events/${ev.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ at: '2026-05-01T08:30:00Z' });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/attendance/events/:id returns 404 for unknown id', async () => {
    const res = await request
      .patch('/api/attendance/events/999999')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ at: '2026-05-01T08:30:00Z', reason: 'wrong_time' });
    assert.equal(res.status, 404);
  });

  it('PATCH on a paid clock_out keeps the linked payout intact (no delete+create cascade)', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    await testDb.insert(attendanceEvents).values({
      staffId: s.id, type: 'clock_in', at: new Date('2026-05-01T09:00:00Z'), source: 'pin',
    });
    const [clockOut] = await testDb.insert(attendanceEvents).values({
      staffId: s.id, type: 'clock_out', at: new Date('2026-05-01T13:00:00Z'), source: 'pin',
    }).returning();
    const [payout] = await testDb.insert(attendancePayouts).values({
      staffId: s.id,
      clockOutEventId: clockOut.id,
      amount: '30.00',
      paidByStaffId: 3,
    }).returning();

    // Correct the clock_out time — the payout (FK on clock_out_event_id with
    // ON DELETE CASCADE) must survive because we UPDATE in place, not delete.
    const res = await request
      .patch(`/api/attendance/events/${clockOut.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ at: '2026-05-01T12:30:00Z', reason: 'wrong_time' });
    assert.equal(res.status, 200);

    const stillThere = await testDb.select().from(attendancePayouts).where(eq(attendancePayouts.id, payout.id));
    assert.equal(stillThere.length, 1, 'payout must survive the time edit');
    assert.equal(stillThere[0].clockOutEventId, clockOut.id);
  });

  it('GET /api/attendance/active returns clocked-in staff with todayMinutes', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    await testDb.insert(attendanceEvents).values({
      staffId: s.id, type: 'clock_in', source: 'pin',
    });
    // Backdate to make todayMinutes nonzero.
    await testDb.execute(sql`UPDATE attendance_events SET at = NOW() - INTERVAL '90 minutes' WHERE staff_id = ${s.id}`);

    const res = await request
      .get('/api/attendance/active')
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.active.length, 1);
    const row = res.body.active[0];
    assert.equal(row.staffId, s.id);
    assert.ok(row.minutes >= 88);  // give a 2-minute test-execution slop
    assert.ok(row.clockedInAt);
  });

  it('GET /api/attendance/active excludes staff who already clocked out', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    await testDb.insert(attendanceEvents).values([
      { staffId: s.id, type: 'clock_in',  source: 'pin' },
      { staffId: s.id, type: 'clock_out', source: 'pin' },
    ]);
    const res = await request
      .get('/api/attendance/active')
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.active.length, 0);
  });
});

// Zmazanie CELEJ ukončenej smeny (pár clock_in + clock_out naraz) cez
// DELETE /api/attendance/shifts/:clockOutEventId. Zóna dotýkajúca sa miezd
// + cashflow, takže testujeme atomické zmazanie payoutu + cashflow expense,
// párovanie príchodu cez pairEventsToShifts a všetky chybové stavy.
describe('DELETE /api/attendance/shifts/:clockOutEventId — zmazanie celej smeny', () => {
  beforeEach(async () => {
    await truncateAll();
    await seed();
  });

  async function makeClosedShift(staffId, opts = {}) {
    const [inEv] = await testDb.insert(attendanceEvents).values({
      staffId, type: 'clock_in', at: new Date(opts.inAt || '2026-05-01T09:00:00Z'), source: 'pin',
    }).returning();
    const [outEv] = await testDb.insert(attendanceEvents).values({
      staffId, type: 'clock_out', at: new Date(opts.outAt || '2026-05-01T13:00:00Z'), source: 'pin',
    }).returning();
    return { inEv, outEv };
  }

  it('zmaže kompletnú nezaplatenú smenu (príchod + odchod naraz)', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const { outEv } = await makeClosedShift(s.id);

    const res = await request
      .delete(`/api/attendance/shifts/${outEv.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 204);

    const left = await testDb.select().from(attendanceEvents).where(eq(attendanceEvents.staffId, s.id));
    assert.equal(left.length, 0, 'oba eventy (príchod aj odchod) musia zmiznúť');
  });

  it('pri vyplatenej smene zmaže aj payout + naviazaný cashflow záznam (atomicky)', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const { outEv } = await makeClosedShift(s.id);
    const [cf] = await testDb.insert(cashflowEntries).values({
      type: 'expense', category: 'salary', amount: '30.00',
      occurredAt: new Date('2026-05-01T13:00:00Z'), method: 'cash',
      note: 'Výplata smeny', staffId: 3,
    }).returning();
    const [payout] = await testDb.insert(attendancePayouts).values({
      staffId: s.id, clockOutEventId: outEv.id, amount: '30.00',
      paidByStaffId: 3, cashflowEntryId: cf.id,
    }).returning();

    const res = await request
      .delete(`/api/attendance/shifts/${outEv.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 204);

    const evLeft = await testDb.select().from(attendanceEvents).where(eq(attendanceEvents.staffId, s.id));
    assert.equal(evLeft.length, 0, 'oba eventy musia zmiznúť');
    const poLeft = await testDb.select().from(attendancePayouts).where(eq(attendancePayouts.id, payout.id));
    assert.equal(poLeft.length, 0, 'payout musí zmiznúť');
    const cfLeft = await testDb.select().from(cashflowEntries).where(eq(cashflowEntries.id, cf.id));
    assert.equal(cfLeft.length, 0, 'naviazaný cashflow expense musí zmiznúť');
  });

  it('zmaže iba cieľovú smenu, ostatné smeny zamestnanca ostanú netknuté', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const first = await makeClosedShift(s.id, { inAt: '2026-05-01T09:00:00Z', outAt: '2026-05-01T13:00:00Z' });
    const second = await makeClosedShift(s.id, { inAt: '2026-05-02T09:00:00Z', outAt: '2026-05-02T13:00:00Z' });

    const res = await request
      .delete(`/api/attendance/shifts/${second.outEv.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 204);

    const left = await testDb.select().from(attendanceEvents).where(eq(attendanceEvents.staffId, s.id));
    const ids = left.map((e) => e.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [first.inEv.id, first.outEv.id].sort((a, b) => a - b), 'prvá smena musí ostať');
  });

  it('vráti 409 keď cieľový event je príchod (clock_in), nie odchod', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const { inEv } = await makeClosedShift(s.id);

    const res = await request
      .delete(`/api/attendance/shifts/${inEv.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 409);

    const left = await testDb.select().from(attendanceEvents).where(eq(attendanceEvents.staffId, s.id));
    assert.equal(left.length, 2, 'pri 409 sa nesmie nič zmazať');
  });

  it('vráti 409 pre osamotený odchod bez párového príchodu', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const [outEv] = await testDb.insert(attendanceEvents).values({
      staffId: s.id, type: 'clock_out', at: new Date('2026-05-01T13:00:00Z'), source: 'pin',
    }).returning();

    const res = await request
      .delete(`/api/attendance/shifts/${outEv.id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 409);

    const left = await testDb.select().from(attendanceEvents).where(eq(attendanceEvents.id, outEv.id));
    assert.equal(left.length, 1, 'osamotený odchod sa cez tento endpoint nemaže');
  });

  it('vráti 404 pre neexistujúce id', async () => {
    const res = await request
      .delete('/api/attendance/shifts/999999')
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 404);
  });

  it('odmietne ne-manažéra (čašník) s 403 a nič nezmaže', async () => {
    const s = await makeStaffWithAttendancePin('4321');
    const { outEv } = await makeClosedShift(s.id);

    const res = await request
      .delete(`/api/attendance/shifts/${outEv.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 403);

    const left = await testDb.select().from(attendanceEvents).where(eq(attendanceEvents.staffId, s.id));
    assert.equal(left.length, 2, 'čašník nesmie nič zmazať');
  });
});

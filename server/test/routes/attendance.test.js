// DATABASE_URL must point to pos_test BEFORE Node starts, because db/index.js
// is a static ESM dependency loaded at import time. The npm test script passes:
//   DATABASE_URL=postgresql://pos:pos@localhost:5432/pos_test node --test ...
if (!process.env.DATABASE_URL?.endsWith('/pos_test')) {
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

const { staff, attendanceEvents } = schema;
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
});

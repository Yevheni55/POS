import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { app } from '../../app.js';
import { truncateAll, seed, closeDb } from '../helpers/setup.js';

// PR-2.3: DB-backed per-account PIN lockout.
// - 5 consecutive bad PINs against the same identity -> 6th returns 429.
// - A successful login does NOT count against the failure total, because the
//   lockout query filters success=false. So login remains possible after a
//   run of failures as long as you have not hit the threshold yet.
//
// We use a single test suite with truncateAll() in before() so this file is
// independent of the sibling auth.test.js suite state.

const request = supertest(app);

describe('PIN lockout (DB-backed)', () => {
  before(async () => {
    app.set('io', { emit: () => {} });
    await truncateAll();
    await seed();
  });

  after(async () => {
    await closeDb();
  });

  it('returns 429 on the 6th bad PIN (unmatched staff, IP-bucket)', async () => {
    // PIN '9999' does not match any seeded staff, so each failure lands in
    // the IP bucket (staff_id IS NULL). After 5 failures the 6th is locked.
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await request.post('/api/auth/login').send({ pin: '9999' });
      statuses.push(res.status);
    }
    assert.deepEqual(
      statuses,
      [401, 401, 401, 401, 401, 429],
      `Expected [401x5, 429] got ${JSON.stringify(statuses)}`,
    );
  });

  it('a correct PIN does not count against the failure total', async () => {
    // Fresh slate for this sub-scenario: nuke auth_attempts only. Easiest
    // way — truncate everything and reseed, keeping the test self-contained.
    await truncateAll();
    await seed();

    // 4 bad attempts (below the limit of 5).
    for (let i = 0; i < 4; i++) {
      const res = await request.post('/api/auth/login').send({ pin: '9999' });
      assert.equal(res.status, 401, `bad attempt ${i + 1} should be 401`);
    }

    // A correct login must still succeed (the query only counts failures).
    const ok = await request.post('/api/auth/login').send({ pin: '1234' });
    assert.equal(ok.status, 200, 'correct PIN must succeed while under limit');
    assert.ok(ok.body.token, 'success response must include a token');

    // The successful login should NOT have incremented the failure count
    // against the IP bucket. One more bad attempt (5 total failures) is still
    // below the trigger, then the next one (6th failure) should be 429.
    const bad5 = await request.post('/api/auth/login').send({ pin: '9999' });
    assert.equal(bad5.status, 401, '5th bad attempt should be 401');

    const locked = await request.post('/api/auth/login').send({ pin: '9999' });
    assert.equal(locked.status, 429, '6th bad attempt should be locked out');
  });
});

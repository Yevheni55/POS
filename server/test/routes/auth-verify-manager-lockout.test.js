import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { app } from '../../app.js';
import { truncateAll, seed, closeDb } from '../helpers/setup.js';

// PR-B: DB-backed PIN lockout on /api/auth/verify-manager.
// Mirrors the limiter wired into /login in PR-2.3:
//   - 5 failures within a 15-minute window blocks the next attempt with 429.
//   - Lockout key prefers matched staffId; falls back to IP bucket otherwise.
//   - A correct verification does NOT count against the failure total.

const request = supertest(app);

describe('PIN lockout on /api/auth/verify-manager (DB-backed)', () => {
  before(async () => {
    app.set('io', { emit: () => {} });
  });

  beforeEach(async () => {
    // Each test gets a clean slate so per-staff/IP buckets don't leak.
    await truncateAll();
    await seed();
  });

  after(async () => {
    await closeDb();
  });

  it('returns 200 for a correct manazer PIN', async () => {
    const res = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '5678' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('returns 401 for a wrong PIN', async () => {
    const res = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '9999' });
    assert.equal(res.status, 401);
  });

  it('locks out after 5 failed attempts in the IP bucket — 6th returns 429 with Retry-After', async () => {
    // PIN '9999' matches no manager — every failure lands in the IP bucket
    // (staff_id IS NULL).
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await request
        .post('/api/auth/verify-manager')
        .send({ pin: '9999' });
      statuses.push({ status: res.status, retryAfter: res.headers['retry-after'] });
    }

    assert.deepEqual(
      statuses.map((s) => s.status),
      [401, 401, 401, 401, 401, 429],
      `Expected [401x5, 429] got ${JSON.stringify(statuses.map((s) => s.status))}`,
    );

    const locked = statuses[5];
    assert.ok(locked.retryAfter, 'Retry-After header must be present on 429');
    assert.ok(
      Number(locked.retryAfter) > 0,
      `Retry-After must be a positive number of seconds, got ${locked.retryAfter}`,
    );
  });

  it('a cisnik PIN against /verify-manager also lands in the IP bucket and contributes to lockout', async () => {
    // The cisnik PIN (1234) is valid for /login but NOT a manager — so on
    // /verify-manager it returns 401, and that failure is bucketed to IP
    // because no manager row matched.
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await request
        .post('/api/auth/verify-manager')
        .send({ pin: '1234' });
      statuses.push(res.status);
    }
    // 6th attempt — even with a different non-matching PIN — must be locked.
    const locked = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '8888' });
    statuses.push(locked.status);

    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  });

  it('a correct manager PIN does not count against the failure total', async () => {
    // 4 IP-bucket failures (under the limit).
    for (let i = 0; i < 4; i++) {
      const r = await request
        .post('/api/auth/verify-manager')
        .send({ pin: '9999' });
      assert.equal(r.status, 401, `bad attempt ${i + 1} should be 401`);
    }

    // A correct verification must still succeed.
    const ok = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '5678' });
    assert.equal(ok.status, 200, 'correct manager PIN must succeed while under limit');

    // The success did NOT increment the failure count, so two more failures
    // are still possible: 5th = 401 (at threshold), 6th = 429.
    const bad5 = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '9999' });
    assert.equal(bad5.status, 401, '5th IP-bucket failure should still be 401');

    const locked = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '9999' });
    assert.equal(locked.status, 429, '6th IP-bucket failure should be locked');
  });
});

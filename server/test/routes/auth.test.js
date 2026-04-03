import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { app } from '../../app.js';
import { truncateAll, seed, closeDb } from '../helpers/setup.js';

// ---------------------------------------------------------------------------
// NOTE on rate limiter state:
// The in-memory Map in routes/auth.js is module-level and persists for the
// entire test run. The limit is 10 attempts. Each test that sends a wrong
// PIN burns one slot. We budget our bad-PIN tests carefully:
//   - "wrong PIN" → 1 attempt
//   - "missing pin" → blocked before the rate limiter by Zod (no slot burned)
//   - "verify-manager with cisnik PIN" → 1 attempt
//   - "rate limit" suite itself uses 10 attempts, so it MUST run last
// Total bad attempts before the rate-limit suite: 2 (safely under 10).
// ---------------------------------------------------------------------------

const request = supertest(app);

describe('POST /api/auth/login', () => {
  before(async () => {
    app.set('io', { emit: () => {} });
    await truncateAll();
    await seed();
  });

  after(async () => {
    await closeDb();
  });

  it('returns 200 with a token and user object for a correct PIN', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ pin: '1234' });

    assert.equal(res.status, 200);
    assert.ok(res.body.token, 'response must include a token');
    assert.ok(res.body.user, 'response must include a user object');
    assert.equal(res.body.user.name, 'Test Cisnik');
    assert.equal(res.body.user.role, 'cisnik');
    assert.ok(res.body.user.id, 'user must have an id');
    // PIN hash must never be returned
    assert.equal(res.body.user.pin, undefined);
  });

  it('returns 401 for a wrong PIN', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ pin: '0000' });

    assert.equal(res.status, 401);
    assert.ok(res.body.error, 'error field must be present');
  });

  it('returns 400 when pin is missing (Zod validation)', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({});

    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'error field must be present');
  });

  it('returns 400 when pin is too short (Zod min 4)', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ pin: '12' });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when pin is not a string', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ pin: 1234 });

    // Zod expects z.string() — numeric value must be rejected
    assert.equal(res.status, 400);
  });

  it('returns 400 when request body is empty (no Content-Type)', async () => {
    const res = await request
      .post('/api/auth/login');

    assert.equal(res.status, 400);
  });
});

describe('POST /api/auth/verify-manager', () => {
  // Reuses the DB seeded by the login suite above — no truncate/seed needed
  // because closeDb is called in the parent suite's after(), and this suite
  // shares the same process. If test isolation is ever tightened, add a
  // dedicated before/after here.

  before(async () => {
    app.set('io', { emit: () => {} });
  });

  it('returns 200 with ok:true for a manazer PIN (5678)', async () => {
    const res = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '5678' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.name, 'name must be returned');
  });

  it('returns 200 for an admin PIN (9012) — admins are also managers', async () => {
    const res = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '9012' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('returns 401 for a cisnik PIN (1234) — not authorised as manager', async () => {
    const res = await request
      .post('/api/auth/verify-manager')
      .send({ pin: '1234' });

    assert.equal(res.status, 401);
    assert.ok(res.body.error);
  });

  it('returns 400 when pin is missing', async () => {
    const res = await request
      .post('/api/auth/verify-manager')
      .send({});

    assert.equal(res.status, 400);
  });
});

// Rate-limiting suite — runs LAST so earlier bad-PIN attempts do not exhaust
// the budget. The in-memory Map in auth.js uses the client IP as the key.
// supertest uses 127.0.0.1 / ::1, which is shared across all suites in the
// same process run. We have burned at most 2 slots before reaching this suite
// (wrong PIN + cisnik-on-verify-manager), so sending 10 more wrong PINs will
// push the counter to 12, which is above the limit of 10.
describe('Rate limiting on PIN endpoints', () => {
  it('returns 429 after 10 bad-PIN attempts in the same window', async () => {
    // Drain remaining slots up to and slightly beyond the limit.
    // We fire 10 requests with a definitely-wrong PIN.  The counter already
    // has ≥0 slots from earlier tests; at attempt 10 (or before) the server
    // will start returning 429.  We collect responses and assert the last one
    // is 429.
    const results = [];
    for (let i = 0; i < 10; i++) {
      const res = await request
        .post('/api/auth/login')
        .send({ pin: '9999' });
      results.push(res.status);
    }

    // At least the final attempt must be rate-limited.
    const last = results[results.length - 1];
    assert.equal(last, 429, `Expected 429 on last attempt, got ${last}`);
  });

  it('rate-limited response body contains a Slovak error message', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ pin: '9999' });

    assert.equal(res.status, 429);
    assert.ok(
      typeof res.body.error === 'string' && res.body.error.length > 0,
      'error message must be present',
    );
  });
});

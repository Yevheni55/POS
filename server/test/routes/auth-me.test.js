import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../app.js';
import { truncateAll, seed, closeDb } from '../helpers/setup.js';

// PR-1.1 regression tests: GET /api/auth/me must require a valid JWT.
// Before this change the route was mounted as public and req.user was always
// undefined, so clients using a 200 response for auth gating were bypassable.

const request = supertest(app);

describe('GET /api/auth/me', () => {
  before(async () => {
    app.set('io', { emit: () => {} });
    await truncateAll();
    await seed();
  });

  after(async () => {
    await closeDb();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const res = await request.get('/api/auth/me');

    assert.equal(res.status, 401);
    assert.ok(res.body.error, 'error field must be present');
    assert.equal(res.body.user, undefined, 'must not leak a user object');
  });

  it('returns 401 when the Bearer token is invalid/tampered', async () => {
    const res = await request
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-jwt');

    assert.equal(res.status, 401);
    assert.ok(res.body.error, 'error field must be present');
    assert.equal(res.body.user, undefined, 'must not leak a user object');
  });

  it('returns 200 with the decoded user payload for a valid token', async () => {
    // Mint a token the same way POST /login does, using the seeded cisnik.
    const loginRes = await request
      .post('/api/auth/login')
      .send({ pin: '1234' });
    assert.equal(loginRes.status, 200);
    const token = loginRes.body.token;
    assert.ok(token, 'login must return a token');

    const res = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.ok(res.body.user, 'user object must be present');
    assert.equal(res.body.user.name, 'Test Cisnik');
    assert.equal(res.body.user.role, 'cisnik');
    assert.ok(res.body.user.id, 'user must have an id');

    // Sanity check: payload matches what we signed (iat/exp will be set by jwt).
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    assert.equal(res.body.user.id, decoded.id);
  });
});

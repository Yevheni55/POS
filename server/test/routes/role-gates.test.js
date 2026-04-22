// Role gating for manager-only read endpoints (PR-1.2).
// Must run against the test database.
if (!process.env.DATABASE_URL?.endsWith('/pos_test')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { app } from '../../app.js';
import { truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

const request = supertest(app);

before(async () => {
  app.set('io', { emit: () => {} });
  await truncateAll();
  await seed();
});

after(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// GET /api/reports/* — manazer/admin only
// ---------------------------------------------------------------------------

describe('GET /api/reports/* — manazer/admin only', () => {
  const endpoints = [
    '/api/reports/summary',
    '/api/reports/z-report',
    '/api/reports/export?format=json',
    '/api/reports/staff',
  ];

  for (const path of endpoints) {
    it(`returns 403 when cisnik calls GET ${path}`, async () => {
      const res = await request
        .get(path)
        .set('Authorization', `Bearer ${tokens.cisnik()}`);

      assert.equal(res.status, 403);
      assert.ok(res.body.error, 'error field must be present');
    });

    it(`returns 200 when manazer calls GET ${path}`, async () => {
      const res = await request
        .get(path)
        .set('Authorization', `Bearer ${tokens.manazer()}`);

      assert.equal(res.status, 200);
    });

    it(`returns 401 when no token is provided for GET ${path}`, async () => {
      const res = await request.get(path);
      assert.equal(res.status, 401);
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/print/z-report — manazer/admin only
// ---------------------------------------------------------------------------

describe('POST /api/print/z-report — manazer/admin only', () => {
  it('returns 403 when cisnik tries to print Z-report', async () => {
    const res = await request
      .post('/api/print/z-report')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ date: new Date().toISOString().split('T')[0] });

    assert.equal(res.status, 403);
    assert.ok(res.body.error);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request
      .post('/api/print/z-report')
      .send({ date: new Date().toISOString().split('T')[0] });

    assert.equal(res.status, 401);
  });
});

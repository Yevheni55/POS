import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';

import { app } from '../../app.js';
import { truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

const request = supertest(app);

// Module-level lifecycle. Multiple `describe` blocks in one file all share
// the same Drizzle pool — putting `after(closeDb)` inside any one block
// would close the pool before later blocks ran, cancelling their setup
// with "Cannot use a pool after calling end on the pool". This pattern
// is documented in server/test/routes/attendance.test.js.
after(closeDb);

describe('POST /api/cashflow', () => {
  before(async () => { await truncateAll(); await seed(); });
  beforeEach(async () => { await truncateAll(); await seed(); });

  it('creates an expense entry as manazer', async () => {
    const res = await request
      .post('/api/cashflow')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({
        type: 'expense',
        category: 'rent',
        amount: 850,
        occurredAt: '2026-05-03T08:00:00Z',
        method: 'transfer',
        note: 'Mesačný nájom — máj',
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.type, 'expense');
    assert.equal(res.body.category, 'rent');
    assert.equal(Number(res.body.amount), 850);
    assert.equal(res.body.method, 'transfer');
  });

  it('creates an income entry as admin', async () => {
    const res = await request
      .post('/api/cashflow')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({
        type: 'income',
        category: 'tip',
        amount: 12.5,
        occurredAt: '2026-05-03T22:00:00Z',
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.type, 'income');
  });

  it('rejects with 403 for cisnik', async () => {
    const res = await request
      .post('/api/cashflow')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ type: 'income', category: 'tip', amount: 5, occurredAt: '2026-05-03T22:00:00Z' });
    assert.equal(res.status, 403);
  });

  it('rejects unknown category with 400', async () => {
    const res = await request
      .post('/api/cashflow')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ type: 'expense', category: 'made_up', amount: 10, occurredAt: '2026-05-03T22:00:00Z' });
    assert.equal(res.status, 400);
  });

  it('rejects negative or zero amount with 400', async () => {
    for (const bad of [0, -5, '-10']) {
      const res = await request
        .post('/api/cashflow')
        .set('Authorization', `Bearer ${tokens.manazer()}`)
        .send({ type: 'expense', category: 'rent', amount: bad, occurredAt: '2026-05-03T22:00:00Z' });
      assert.equal(res.status, 400, `amount=${bad} should be rejected`);
    }
  });
});

describe('GET /api/cashflow', () => {
  before(async () => { await truncateAll(); await seed(); });

  it('lists entries newest first, filtered by from/to', async () => {
    const adminToken = tokens.manazer();
    await request.post('/api/cashflow').set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'income', category: 'tip', amount: 5, occurredAt: '2026-05-01T10:00:00Z' });
    await request.post('/api/cashflow').set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'expense', category: 'rent', amount: 850, occurredAt: '2026-05-03T08:00:00Z' });
    await request.post('/api/cashflow').set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'income', category: 'event', amount: 200, occurredAt: '2026-04-01T20:00:00Z' });

    const res = await request
      .get('/api/cashflow?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.length, 2);
    assert.equal(res.body.entries[0].category, 'rent'); // 2026-05-03 first
    assert.equal(res.body.entries[1].category, 'tip');
  });

  it('filters by type=expense', async () => {
    const res = await request
      .get('/api/cashflow?from=2026-05-01&to=2026-05-31&type=expense')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.entries.every((e) => e.type === 'expense'));
  });

  it('rejects malformed date with 400 (instead of 500 from cast error)', async () => {
    const res = await request
      .get(`/api/cashflow?from=2026-13-99&to=2026-05-31`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(res.status, 400);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request.get('/api/cashflow?from=2026-05-01&to=2026-05-31');
    assert.equal(res.status, 401);
  });
});

describe('PATCH /api/cashflow/:id', () => {
  before(async () => { await truncateAll(); await seed(); });

  it('updates note and amount', async () => {
    const create = await request.post('/api/cashflow')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ type: 'expense', category: 'rent', amount: 850, occurredAt: '2026-05-03T08:00:00Z' });
    const id = create.body.id;
    const patch = await request.patch(`/api/cashflow/${id}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ amount: 900, note: 'Včítane vody' });
    assert.equal(patch.status, 200);
    assert.equal(Number(patch.body.amount), 900);
    assert.equal(patch.body.note, 'Včítane vody');
    assert.equal(patch.body.category, 'rent'); // unchanged
  });

  it('returns 404 for unknown id', async () => {
    const res = await request.patch('/api/cashflow/999999')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ amount: 10 });
    assert.equal(res.status, 404);
  });

  it('rejects empty body with 400', async () => {
    const create = await request.post('/api/cashflow')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ type: 'income', category: 'tip', amount: 5, occurredAt: '2026-05-03T22:00:00Z' });
    const res = await request.patch(`/api/cashflow/${create.body.id}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});
    assert.equal(res.status, 400);
  });
});

describe('DELETE /api/cashflow/:id', () => {
  before(async () => { await truncateAll(); await seed(); });

  it('deletes an entry as admin', async () => {
    const create = await request.post('/api/cashflow')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ type: 'expense', category: 'rent', amount: 850, occurredAt: '2026-05-03T08:00:00Z' });
    const id = create.body.id;
    const del = await request.delete(`/api/cashflow/${id}`)
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(del.status, 204);
    const list = await request.get('/api/cashflow?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.ok(list.body.entries.every((e) => e.id !== id));
  });

  it('returns 404 for unknown id', async () => {
    const res = await request.delete('/api/cashflow/999999')
      .set('Authorization', `Bearer ${tokens.admin()}`);
    assert.equal(res.status, 404);
  });

  it('rejects cisnik with 403', async () => {
    const res = await request.delete('/api/cashflow/1')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 403);
  });
});

describe('GET /api/cashflow/summary', () => {
  before(async () => { await truncateAll(); await seed(); });

  it('combines manual entries + POS payments + shisha into a totals payload', async () => {
    const adminToken = tokens.manazer();
    await request.post('/api/cashflow').set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'expense', category: 'rent', amount: 850, occurredAt: '2026-05-03T08:00:00Z' });
    await request.post('/api/cashflow').set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'expense', category: 'utilities', amount: 120, occurredAt: '2026-05-03T08:00:00Z' });
    await request.post('/api/cashflow').set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'income', category: 'tip', amount: 25, occurredAt: '2026-05-03T22:00:00Z' });

    const res = await request
      .get('/api/cashflow/summary?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.period.from, '2026-05-01');
    assert.equal(Number(res.body.manual.income), 25);
    assert.equal(Number(res.body.manual.expense), 970);
    assert.ok('posRevenue' in res.body);
    assert.ok('shishaRevenue' in res.body);
    assert.ok('netCashflow' in res.body);
    assert.ok(Array.isArray(res.body.byCategory.expense));
    assert.ok(Array.isArray(res.body.byCategory.income));
    const rentRow = res.body.byCategory.expense.find((c) => c.category === 'rent');
    assert.equal(Number(rentRow.total), 850);
  });
});

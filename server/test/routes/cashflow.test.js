import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';

import { app } from '../../app.js';
import { truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

const request = supertest(app);

describe('POST /api/cashflow', () => {
  before(async () => { await truncateAll(); await seed(); });
  after(closeDb);
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
  after(closeDb);

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
});

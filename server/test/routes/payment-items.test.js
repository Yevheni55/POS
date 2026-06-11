// GET /api/payments/:id/items — položky dokladu pre admin Históriu platieb.
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
import { sql } from 'drizzle-orm';

import { app } from '../../app.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';

app.set('io', { emit: () => {} });
const request = supertest(app);

after(async () => { await closeDb(); });

describe('GET /api/payments/:id/items', () => {
  let fixtures = {};

  before(async () => {
    process.env.PORTOS_ENABLED = 'false';
    await truncateAll();
    fixtures = await seed();
  });

  beforeEach(async () => {
    await testDb.execute(
      sql.raw('TRUNCATE order_events, payments, order_items, orders RESTART IDENTITY CASCADE')
    );
  });

  async function createPaidOrder() {
    const { cisnik, table1, itemBurger, itemPivo } = fixtures;
    const [order] = await testDb.insert(schema.orders)
      .values({ tableId: table1.id, staffId: cisnik.id, status: 'closed', label: 'Ucet 1' })
      .returning();
    await testDb.insert(schema.orderItems)
      .values({ orderId: order.id, menuItemId: itemBurger.id, qty: 2, sent: true, note: 'bez cibule' });
    await testDb.insert(schema.orderItems)
      .values({ orderId: order.id, menuItemId: itemPivo.id, qty: 1, sent: true });
    const [payment] = await testDb.insert(schema.payments)
      .values({ orderId: order.id, method: 'hotovost', amount: '19.50' })
      .returning();
    return { order, payment };
  }

  it('returns order items with names, qty, notes and totals', async () => {
    const { order, payment } = await createPaidOrder();

    const res = await request
      .get(`/api/payments/${payment.id}/items`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.paymentId, payment.id);
    assert.equal(res.body.orderId, order.id);
    assert.equal(res.body.amount, 19.50);
    assert.equal(res.body.items.length, 2);

    const burger = res.body.items.find((i) => i.name === 'Burger');
    assert.ok(burger, 'burger item present');
    assert.equal(burger.qty, 2);
    assert.equal(burger.note, 'bez cibule');
    assert.equal(burger.lineTotal, 17.00);

    // 2× 8.50 + 1× 2.50
    assert.equal(res.body.itemsTotal, 19.50);
    assert.equal(res.body.priceMissing, false);
  });

  it('rejects cisnik (manazer/admin only — rovnaká ochrana ako history)', async () => {
    const { payment } = await createPaidOrder();
    const res = await request
      .get(`/api/payments/${payment.id}/items`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 403);
  });

  it('404 for unknown payment id', async () => {
    const res = await request
      .get('/api/payments/999999/items')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(res.status, 404);
  });
});

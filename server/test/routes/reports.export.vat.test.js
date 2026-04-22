if (!process.env.DATABASE_URL?.endsWith('/pos_test')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { eq, sql } from 'drizzle-orm';

import { app } from '../../app.js';
import * as schema from '../../db/schema.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

const request = supertest(app);

describe('reports export VAT breakdown', () => {
  let fixtures = {};

  before(async () => {
    await truncateAll();
    fixtures = await seed();
  });

  beforeEach(async () => {
    await testDb.execute(
      sql.raw('TRUNCATE fiscal_documents, order_events, payments, order_items, orders RESTART IDENTITY CASCADE')
    );
    await testDb.update(schema.tables).set({ status: 'free' });
  });

  after(async () => {
    await closeDb();
  });

  it('calculates zaklad and DPH from mixed VAT groups instead of a hardcoded rate', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const createdAt = new Date(`${today}T12:00:00.000Z`);
    const { cisnik, table1, itemBurger, itemPivo } = fixtures;

    const [order] = await testDb.insert(schema.orders).values({
      tableId: table1.id,
      staffId: cisnik.id,
      status: 'closed',
      label: 'VAT test',
      discountAmount: '1.00',
      createdAt,
      closedAt: createdAt,
    }).returning();

    await testDb.insert(schema.orderItems).values([
      { orderId: order.id, menuItemId: itemBurger.id, qty: 1, sent: true },
      { orderId: order.id, menuItemId: itemPivo.id, qty: 1, sent: true },
    ]);

    await testDb.insert(schema.payments).values({
      orderId: order.id,
      method: 'hotovost',
      amount: '10.00',
      createdAt,
    });

    const res = await request
      .get(`/api/reports/export?from=${today}&to=${today}&format=json`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].cislo, order.id);
    assert.equal(res.body[0].celkom, 10);
    assert.equal(res.body[0].zaklad, 9.21);
    assert.equal(res.body[0].dph, 0.79);

    const [row] = await testDb.select({
      burgerVat: schema.menuItems.vatRate,
    }).from(schema.menuItems).where(eq(schema.menuItems.id, itemBurger.id));
    assert.equal(Number(row.burgerVat), 5);
  });
});

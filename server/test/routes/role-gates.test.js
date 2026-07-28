// Role gating for manager-only read endpoints (PR-1.2).
// Must run against a test database.
// Guard drzi ten isty zmysel ako predtym (NIKDY nie ostra `pos` DB), len
// pripusta aj paralelne test DB typu pos_test_w2 — inak sa tento subor neda
// spustit vedla ostatnych bez kolizie na jednej `pos_test`.
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test (or pos_test_<suffix>).\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';
import { app } from '../../app.js';
import { truncateAll, seed, testDb, closeDb } from '../helpers/setup.js';
import { tokens, makeToken } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';

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

// ---------------------------------------------------------------------------
// orders router — autorizacne a integritne gate-y
// ---------------------------------------------------------------------------

describe('orders router — storno odoslanej polozky, close, batch IDOR', () => {
  let fixtures;

  before(async () => {
    await truncateAll();
    fixtures = await seed();
  });

  async function createOrder(tableId, items) {
    const res = await request
      .post('/api/orders')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ tableId, items });
    assert.equal(res.status, 201);
    return res.body;
  }

  async function sendOrder(orderId) {
    const res = await request
      .post(`/api/orders/${orderId}/send`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 200);
  }

  async function itemsOf(orderId) {
    return testDb.select().from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, orderId))
      .orderBy(schema.orderItems.id);
  }

  // -------------------------------------------------------------------------
  // DELETE /api/orders/:orderId/items/:itemId — storno odoslanej polozky
  // -------------------------------------------------------------------------

  it('403: cisnik nesmie zmazat UZ ODOSLANU polozku', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 2 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .delete(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(res.status, 403);
    assert.ok(res.body.error);
    const after = await itemsOf(order.id);
    assert.equal(after.length, 1, 'odoslana polozka musi ostat na ucte');
  });

  it('200: cisnik smie zmazat NEODOSLANU polozku (spravanie sa nemeni)', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    const [item] = await itemsOf(order.id);

    const res = await request
      .delete(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(res.status, 200);
    assert.equal((await itemsOf(order.id)).length, 0);
  });

  it('200: manazer smie zmazat odoslanu polozku', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .delete(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 200);
    assert.equal((await itemsOf(order.id)).length, 0);
  });

  it('200: cisnik s platnym manazerskym elevacnym tokenom smie stornovat odoslanu polozku', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    // Presne ten tvar tokenu, aky razi POST /api/auth/verify-manager.
    const elevation = makeToken({ id: fixtures.manazer.id, name: 'Test Manazer', role: 'manazer' });

    const res = await request
      .delete(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .set('X-Manager-Token', elevation)
      .send({});

    assert.equal(res.status, 200);
    assert.equal((await itemsOf(order.id)).length, 0);
  });

  it('403: elevacny token s rolou cisnik neprejde', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .delete(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .set('X-Manager-Token', tokens.cisnik())
      .send({});

    assert.equal(res.status, 403);
    assert.equal((await itemsOf(order.id)).length, 1);
  });

  // -------------------------------------------------------------------------
  // PUT /api/orders/:orderId/items/:itemId — znizenie qty odoslanej polozky
  // -------------------------------------------------------------------------

  it('403: cisnik nesmie znizit qty odoslanej polozky', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 3 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .put(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ qty: 1 });

    assert.equal(res.status, 403);
    const [after] = await itemsOf(order.id);
    assert.equal(after.qty, 3, 'qty sa nesmie znizit');
  });

  it('200: cisnik smie ZVYSIT qty odoslanej polozky (nie je to storno)', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .put(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ qty: 4 });

    assert.equal(res.status, 200);
    const [after] = await itemsOf(order.id);
    assert.equal(after.qty, 4);
  });

  it('200: cisnik smie zmenit poznamku odoslanej polozky', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .put(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ note: 'bez peny' });

    assert.equal(res.status, 200);
    const [after] = await itemsOf(order.id);
    assert.equal(after.note, 'bez peny');
    assert.equal(after.qty, 1);
  });

  it('200: manazer smie znizit qty odoslanej polozky', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 3 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .put(`/api/orders/${order.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ qty: 1 });

    assert.equal(res.status, 200);
    const [after] = await itemsOf(order.id);
    assert.equal(after.qty, 1);
  });

  // -------------------------------------------------------------------------
  // POST /api/orders/:id/batch — cross-order IDOR + storno gate
  // -------------------------------------------------------------------------

  it('batch nesmie siahnut na polozku INEHO uctu (IDOR)', async () => {
    const victim = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemBurger.id, qty: 2 }]);
    const attacker = await createOrder(fixtures.table2.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    const [victimItem] = await itemsOf(victim.id);

    const res = await request
      .post(`/api/orders/${attacker.id}/batch`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ operations: [{ action: 'remove', itemId: victimItem.id }] });

    assert.equal(res.status, 200, 'batch sam o sebe nespadne');
    const victimItems = await itemsOf(victim.id);
    assert.equal(victimItems.length, 1, 'polozka cudzieho uctu musi ostat');
    assert.equal(victimItems[0].id, victimItem.id);
  });

  it('batch update nesmie prepisat qty polozky INEHO uctu (IDOR)', async () => {
    const victim = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemBurger.id, qty: 2 }]);
    const attacker = await createOrder(fixtures.table2.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    const [victimItem] = await itemsOf(victim.id);

    const res = await request
      .post(`/api/orders/${attacker.id}/batch`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ operations: [{ action: 'update', itemId: victimItem.id, qty: 99 }] });

    assert.equal(res.status, 200);
    const [after] = await itemsOf(victim.id);
    assert.equal(after.qty, 2, 'qty cudzieho uctu sa nesmie zmenit');
  });

  it('403: batch remove odoslanej polozky od cisnika', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .post(`/api/orders/${order.id}/batch`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ operations: [{ action: 'remove', itemId: item.id }] });

    assert.equal(res.status, 403);
    assert.equal((await itemsOf(order.id)).length, 1);
  });

  it('200: batch remove odoslanej polozky od manazera prejde', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    await sendOrder(order.id);
    const [item] = await itemsOf(order.id);

    const res = await request
      .post(`/api/orders/${order.id}/batch`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ operations: [{ action: 'remove', itemId: item.id }] });

    assert.equal(res.status, 200);
    assert.equal((await itemsOf(order.id)).length, 0);
  });

  // -------------------------------------------------------------------------
  // POST /api/orders/:id/close — nesmie zavriet ucet bez platby
  // -------------------------------------------------------------------------

  it('403: cisnik nesmie volat /close', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);

    const res = await request
      .post(`/api/orders/${order.id}/close`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(res.status, 403);
    const [row] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    assert.equal(row.status, 'open', 'ucet musi ostat otvoreny');
  });

  it('409: manazer nezavrie ucet bez platby (trzba by zmizla)', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);

    const res = await request
      .post(`/api/orders/${order.id}/close`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 409);
    const [row] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    assert.equal(row.status, 'open');
  });

  it('200: manazer zavrie ucet, ktory ma platbu', async () => {
    const order = await createOrder(fixtures.table1.id, [{ menuItemId: fixtures.itemPivo.id, qty: 1 }]);
    await testDb.insert(schema.payments).values({ orderId: order.id, method: 'cash', amount: '2.50' });

    const res = await request
      .post(`/api/orders/${order.id}/close`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 200);
    const [row] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    assert.equal(row.status, 'closed');
  });
});

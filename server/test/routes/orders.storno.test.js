import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';

import { app } from '../../app.js';
import { truncateAll, seed, testDb, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';

const request = supertest(app);

async function createOrder(body) {
  return request
    .post('/api/orders')
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .send(body);
}

app.set('io', { emit: () => {} });

after(async () => {
  await closeDb();
});

describe('POST /api/orders/:id/send-storno-and-print', () => {
  let fixtures;

  before(async () => {
    await truncateAll();
    fixtures = await seed();
  });

  it('returns storno items enriched from menu data and logs a storno send event', async () => {
    const orderRes = await createOrder({
      tableId: fixtures.table1.id,
      items: [{ menuItemId: fixtures.itemPivo.id, qty: 2 }],
    });
    const orderId = orderRes.body.id;

    let res = await request
      .post(`/api/orders/${orderId}/send`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 200);

    res = await request
      .post(`/api/orders/${orderId}/send-storno-and-print`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({
        items: [
          { menuItemId: fixtures.itemPivo.id, qty: 1, note: 'bez peny' },
        ],
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.printed, 1);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].menuItemId, fixtures.itemPivo.id);
    assert.equal(res.body.items[0].name, fixtures.itemPivo.name);
    assert.equal(res.body.items[0].qty, 1);
    assert.equal(res.body.items[0].note, 'bez peny');

    const events = await testDb
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, orderId));

    const stornoEvent = events.find((event) => event.type === 'order_storno_sent');
    assert.ok(stornoEvent, 'storno send should be recorded in order_events');

    const payload = JSON.parse(stornoEvent.payload);
    assert.equal(payload.itemCount, 1);
    assert.equal(payload.items[0].menuItemId, fixtures.itemPivo.id);
    assert.equal(payload.items[0].qty, 1);
    assert.equal(payload.items[0].note, 'bez peny');
  });
});

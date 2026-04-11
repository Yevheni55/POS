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
import { and, eq, sql } from 'drizzle-orm';

import { app } from '../../app.js';
import * as schema from '../../db/schema.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

app.set('io', { emit: () => {} });

const request = supertest(app);
const originalFetch = global.fetch;

function mockJsonResponse(status, body) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  });
}

function buildRegisterSuccess({ externalId, receiptNumber = 21, receiptId = 'O-TEST-RECEIPT', isSuccessful = true, withResponse = true }) {
  return {
    request: {
      data: {
        receiptType: 'CashRegister',
        receiptNumber,
        okp: 'OKP-123',
        cashRegisterCode: '88812345678900001',
      },
      id: '11111111-1111-1111-1111-111111111111',
      externalId,
      date: '2026-04-02T10:00:00+02:00',
      sendingCount: 1,
    },
    response: withResponse ? {
      data: { id: receiptId },
      processDate: '2026-04-02T10:00:01+02:00',
    } : null,
    isSuccessful,
    error: null,
  };
}

async function createOpenOrder(tableId, staffId, items, discountAmount = null) {
  const [order] = await testDb
    .insert(schema.orders)
    .values({ tableId, staffId, status: 'open', label: 'Test', discountAmount })
    .returning();

  for (const item of items) {
    await testDb
      .insert(schema.orderItems)
      .values({ orderId: order.id, menuItemId: item.menuItemId, qty: item.qty, sent: true });
  }

  return order;
}

after(async () => {
  global.fetch = originalFetch;
  await closeDb();
});

describe('Portos payment integration', () => {
  let fixtures = {};

  before(async () => {
    process.env.PORTOS_ENABLED = 'true';
    process.env.PORTOS_CASH_REGISTER_CODE = '88812345678900001';
    process.env.PORTOS_PRINTER_NAME = 'pos';
    process.env.PORTOS_BASE_URL = 'http://localhost:3010';
    await truncateAll();
    fixtures = await seed();
  });

  beforeEach(async () => {
    process.env.PORTOS_ENABLED = 'true';
    await testDb.execute(
      sql.raw('TRUNCATE fiscal_documents, order_events, payments, order_items, orders RESTART IDENTITY CASCADE')
    );
    await testDb.update(schema.tables).set({ status: 'free' });
    global.fetch = originalFetch;
  });

  it('creates payment and fiscal document for online Portos success', async () => {
    const { cisnik, table1, itemBurger, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
      { menuItemId: itemPivo.id, qty: 1 },
    ], '1.00');

    global.fetch = async () => mockJsonResponse(200, buildRegisterSuccess({
      externalId: `order-${order.id}-payment`,
      receiptNumber: 34,
      receiptId: 'O-ONLINE',
    }));

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 10.00 });

    assert.equal(res.status, 201);
    assert.equal(res.body.fiscal.status, 'online_success');
    assert.equal(res.body.fiscal.receiptId, 'O-ONLINE');

    const [fiscalDoc] = await testDb.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.orderId, order.id));
    assert.equal(fiscalDoc.externalId, `order-${order.id}-payment`);
    assert.equal(fiscalDoc.resultMode, 'online_success');
    assert.equal(fiscalDoc.paymentId, res.body.payment.id);
  });

  it('stores offline accepted Portos result and still closes the order', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    global.fetch = async () => mockJsonResponse(202, buildRegisterSuccess({
      externalId: `order-${order.id}-payment`,
      receiptNumber: 35,
      receiptId: null,
      isSuccessful: null,
      withResponse: false,
    }));

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'karta', amount: 8.50 });

    assert.equal(res.status, 201);
    assert.equal(res.body.fiscal.status, 'offline_accepted');

    const [dbOrder] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    assert.equal(dbOrder.status, 'closed');

    const [fiscalDoc] = await testDb.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.orderId, order.id));
    assert.equal(fiscalDoc.resultMode, 'offline_accepted');
    assert.equal(fiscalDoc.isSuccessful, null);
  });

  it('leaves order open and records failed fiscal attempt on validation error', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    global.fetch = async () => mockJsonResponse(400, {
      code: -900,
      title: 'Validation failed',
      errors: { 'Items[0].Name': ['Name is required'] },
    });

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });

    assert.equal(res.status, 400);

    const [dbOrder] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    assert.equal(dbOrder.status, 'open');

    const dbPayments = await testDb.select().from(schema.payments).where(eq(schema.payments.orderId, order.id));
    assert.equal(dbPayments.length, 0);

    const [fiscalDoc] = await testDb.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.orderId, order.id));
    assert.equal(fiscalDoc.resultMode, 'validation_error');
  });

  it('reconciles an ambiguous transport failure by externalId lookup', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    let callIndex = 0;
    global.fetch = async () => {
      callIndex += 1;
      if (callIndex === 1) throw new Error('socket hang up');
      return mockJsonResponse(200, buildRegisterSuccess({
        externalId: `order-${order.id}-payment`,
        receiptNumber: 36,
        receiptId: 'O-LOOKUP',
      }));
    };

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 8.50 });

    assert.equal(res.status, 201);
    assert.equal(res.body.fiscal.status, 'reconciled_online_success');
    assert.equal(callIndex, 2);
  });

  it('uses lookup and copy flow after Portos print error instead of new sale', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    let callIndex = 0;
    global.fetch = async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return mockJsonResponse(500, {
          code: -502,
          title: 'Print failed',
          detail: 'Receipt printed failed',
        });
      }
      if (callIndex === 2) {
        return mockJsonResponse(200, buildRegisterSuccess({
          externalId: `order-${order.id}-payment`,
          receiptNumber: 37,
          receiptId: 'O-COPY',
        }));
      }
      return mockJsonResponse(200, { printed: true });
    };

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });

    assert.equal(res.status, 201);
    assert.equal(res.body.fiscal.status, 'reconciled_online_success');
    assert.equal(callIndex, 3);
  });

  it('does not call Portos again when the same order is retried after successful payment', async () => {
    const { cisnik, table1, itemTracked } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemTracked.id, qty: 1 },
    ]);

    let callIndex = 0;
    global.fetch = async () => {
      callIndex += 1;
      return mockJsonResponse(200, buildRegisterSuccess({
        externalId: `order-${order.id}-payment`,
        receiptNumber: 38,
        receiptId: 'O-ONCE',
      }));
    };

    const first = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 5.00 });

    const second = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 5.00 });

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyProcessed, true);
    assert.equal(callIndex, 1);

    const dbPayments = await testDb.select().from(schema.payments).where(eq(schema.payments.orderId, order.id));
    assert.equal(dbPayments.length, 1);
  });

  it('prints receipt copy for an existing fiscal payment', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    global.fetch = async () => mockJsonResponse(200, buildRegisterSuccess({
      externalId: `order-${order.id}-payment`,
      receiptNumber: 39,
      receiptId: 'O-COPY-READY',
    }));

    const paymentRes = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });

    global.fetch = async () => mockJsonResponse(200, { printed: true });

    const copyRes = await request
      .post(`/api/payments/${paymentRes.body.payment.id}/receipt-copy`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(copyRes.status, 200);
    assert.equal(copyRes.body.printed, true);
  });

  it('rejects payment before Portos call when order contains unsupported VAT rate', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    await testDb.update(schema.menuItems)
      .set({ vatRate: '20.00' })
      .where(eq(schema.menuItems.id, itemPivo.id));

    let called = false;
    global.fetch = async () => {
      called = true;
      return mockJsonResponse(200, buildRegisterSuccess({
        externalId: `order-${order.id}-payment`,
      }));
    };

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Portos podporuje iba sadzby DPH/);
    assert.equal(called, false);
  });

  it('rejects fiscal storno for cisnik (403)', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    global.fetch = async () => mockJsonResponse(200, buildRegisterSuccess({
      externalId: `order-${order.id}-payment`,
      receiptNumber: 40,
      receiptId: 'O-S1',
    }));

    const paymentRes = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 8.50 });

    const stornoRes = await request
      .post(`/api/payments/${paymentRes.body.payment.id}/fiscal-storno`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(stornoRes.status, 403);
  });

  it('registers fiscal storno for manager and stores second fiscal row', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    let callIndex = 0;
    global.fetch = async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return mockJsonResponse(200, buildRegisterSuccess({
          externalId: `order-${order.id}-payment`,
          receiptNumber: 41,
          receiptId: 'O-ORIG',
        }));
      }
      return mockJsonResponse(200, buildRegisterSuccess({
        externalId: `order-${order.id}-payment-storno`,
        receiptNumber: 42,
        receiptId: 'O-STORNO',
      }));
    };

    const paymentRes = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 8.50 });

    assert.equal(paymentRes.status, 201);

    const stornoRes = await request
      .post(`/api/payments/${paymentRes.body.payment.id}/fiscal-storno`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(stornoRes.status, 200);
    assert.equal(stornoRes.body.ok, true);
    assert.equal(stornoRes.body.fiscal.status, 'online_success');
    assert.equal(stornoRes.body.fiscal.receiptId, 'O-STORNO');
    assert.equal(callIndex, 2);

    const docs = await testDb.select().from(schema.fiscalDocuments)
      .where(eq(schema.fiscalDocuments.paymentId, paymentRes.body.payment.id));
    assert.equal(docs.length, 2);
    const stornoDoc = docs.find((d) => d.externalId === `order-${order.id}-payment-storno`);
    assert.ok(stornoDoc);
    assert.equal(stornoDoc.sourceType, 'storno');
  });
});

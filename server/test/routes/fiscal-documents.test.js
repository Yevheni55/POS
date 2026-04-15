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
import { closeDb, seed, testDb, truncateAll } from '../helpers/setup.js';
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

async function createPaidOrder(fixtures, overrides = {}) {
  const [order] = await testDb.insert(schema.orders).values({
    tableId: fixtures.table1.id,
    staffId: fixtures.cisnik.id,
    status: 'closed',
    label: 'Ucet 1',
    closedAt: new Date('2026-04-12T10:10:00Z'),
  }).returning();

  const [payment] = await testDb.insert(schema.payments).values({
    orderId: order.id,
    method: 'hotovost',
    amount: '8.50',
  }).returning();

  const [doc] = await testDb.insert(schema.fiscalDocuments).values({
    sourceType: 'payment',
    sourceId: order.id,
    orderId: order.id,
    paymentId: payment.id,
    externalId: overrides.externalId || `order-${order.id}-payment`,
    cashRegisterCode: overrides.cashRegisterCode || '88812345678900001',
    requestType: 'CashRegister',
    httpStatus: 200,
    resultMode: overrides.resultMode || 'online_success',
    isSuccessful: true,
    receiptId: overrides.receiptId || 'RID-123',
    receiptNumber: overrides.receiptNumber || 45,
    okp: overrides.okp || 'OKP-123',
    portosRequestId: 'REQ-1',
    printerName: 'pos',
    processDate: overrides.processDate || new Date('2026-04-12T10:00:01Z'),
    requestJson: JSON.stringify({
      request: {
        data: {
          cashRegisterCode: overrides.cashRegisterCode || '88812345678900001',
          receiptType: 'CashRegister',
          items: [{
            type: 'Positive',
            name: 'Burger',
            price: 8.5,
            unitPrice: 8.5,
            quantity: { amount: 1, unit: 'ks' },
            vatRate: 5,
            description: null,
            referenceReceiptId: null,
          }],
          payments: [{ name: 'Hotovost', amount: 8.5 }],
        },
        externalId: overrides.externalId || `order-${order.id}-payment`,
      },
      print: { printerName: 'pos' },
    }),
    responseJson: JSON.stringify({ ok: true }),
    errorDetail: '',
  }).returning();

  return { order, payment, doc };
}

describe('fiscal documents routes', () => {
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
    global.fetch = originalFetch;
    await testDb.execute(sql.raw('TRUNCATE fiscal_documents, order_events, payments, order_items, orders RESTART IDENTITY CASCADE'));
  });

  after(async () => {
    global.fetch = originalFetch;
    await closeDb();
  });

  it('finds fiscal documents by receiptId for manager', async () => {
    const { doc, payment } = await createPaidOrder(fixtures, { receiptId: 'RID-SEARCH-1' });

    const res = await request
      .get('/api/fiscal-documents/search?receiptId=RID-SEARCH-1')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].id, doc.id);
    assert.equal(res.body.items[0].paymentId, payment.id);
  });

  it('finds fiscal documents by externalId for manager', async () => {
    await createPaidOrder(fixtures, { externalId: 'order-777-payment' });

    const res = await request
      .get('/api/fiscal-documents/search?externalId=order-777-payment')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].externalId, 'order-777-payment');
  });

  it('finds fiscal documents by cashRegisterCode + year + month + receiptNumber', async () => {
    await createPaidOrder(fixtures, {
      cashRegisterCode: '88812345678900001',
      receiptNumber: 987,
      processDate: new Date('2026-04-10T12:00:00Z'),
    });

    const res = await request
      .get('/api/fiscal-documents/search?cashRegisterCode=88812345678900001&year=2026&month=4&receiptNumber=987')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].receiptNumber, 987);
  });

  it('returns 400 when fiscal document search has no supported identifiers', async () => {
    const res = await request
      .get('/api/fiscal-documents/search')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 400);
  });

  it('rejects fiscal document search for cisnik', async () => {
    const res = await request
      .get('/api/fiscal-documents/search?receiptId=RID-SEARCH-1')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 403);
  });

  it('returns fiscal document detail with storno eligibility', async () => {
    const { doc } = await createPaidOrder(fixtures, { receiptId: 'RID-DETAIL-1' });

    const res = await request
      .get(`/api/fiscal-documents/${doc.id}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, doc.id);
    assert.equal(res.body.stornoEligible, true);
    assert.equal(res.body.stornoDone, false);
  });

  it('allows manager to storno by fiscal document id without knowing payment id', async () => {
    const { doc, payment, order } = await createPaidOrder(fixtures, {
      receiptId: 'RID-STORNO-ORIG',
      externalId: 'order-500-payment',
    });

    global.fetch = async () => mockJsonResponse(200, {
      request: {
        data: {
          receiptType: 'CashRegister',
          receiptNumber: 501,
          okp: 'OKP-STORNO-1',
          cashRegisterCode: '88812345678900001',
        },
        id: '11111111-1111-1111-1111-111111111222',
        externalId: `order-${order.id}-payment-storno`,
        date: '2026-04-12T10:20:00+02:00',
      },
      response: {
        data: { id: 'RID-STORNO-NEW' },
        processDate: '2026-04-12T10:20:01+02:00',
      },
      isSuccessful: true,
      error: null,
    });

    const res = await request
      .post(`/api/fiscal-documents/${doc.id}/storno`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.fiscal.receiptId, 'RID-STORNO-NEW');

    const docs = await testDb.select().from(schema.fiscalDocuments)
      .where(eq(schema.fiscalDocuments.paymentId, payment.id));
    assert.equal(docs.length, 2);
  });
});

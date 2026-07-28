// Pripusta aj paralelne worker DB (pos_test_w1..w6) — inak sa tento subor
// neda spustit vedla ostatnych bez kolizie na jednej zdielanej pos_test.
// Nazov MUSI zacinat 'pos_test', nech sa testy nikdy netrafia do zivej 'pos'
// (truncateAll() maze 32 tabuliek).
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { sql } from 'drizzle-orm';

import { app } from '../../app.js';
import * as schema from '../../db/schema.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import {
  normalizeQrStatus,
  QR_PAID_STATUSES,
  QR_FINAL_STATUSES,
} from '../../lib/portos.js';
import { qrPaymentCreateSchema, createPaymentSchema, PAYMENT_METHODS } from '../../schemas/payments.js';

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

function buildQrCreateResponse(over = {}) {
  return {
    transactionId: 'QR-test-0001',
    amount: 10,
    currencyCode: 'EUR',
    merchant: { iban: 'SK28 1100 0000 0029 4630 3220', name: 'Tatra banka' },
    cashRegisterCode: '88812345678900001',
    createdAt: '2026-06-29T10:08:55.000Z',
    expiresAt: '2026-06-29T10:10:55.000Z',
    status: 'pending',
    paidAmount: 0,
    remainingAmount: 10,
    overpaidAmount: 0,
    recipientMessage: 'Obj. 1',
    links: [{ provider: 'payme', version: '2.0', url: 'https://payme.tatrabanka.sk/?v=2&id=abc' }],
    ...over,
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

// ---- Čisté kontrakty (bez DB/siete) -------------------------------------
describe('QR platba — schémy a pomocné funkcie', () => {
  it('createPaymentSchema akceptuje method=prevod', () => {
    const r = createPaymentSchema.safeParse({ orderId: 1, method: 'prevod', amount: 10 });
    assert.equal(r.success, true);
    assert.ok(PAYMENT_METHODS.includes('prevod'));
  });

  it('qrPaymentCreateSchema vyžaduje kladné orderId', () => {
    assert.equal(qrPaymentCreateSchema.safeParse({ orderId: 5 }).success, true);
    assert.equal(qrPaymentCreateSchema.safeParse({ orderId: 0 }).success, false);
    assert.equal(qrPaymentCreateSchema.safeParse({}).success, false);
  });

  it('normalizeQrStatus + množiny stavov', () => {
    assert.equal(normalizeQrStatus('Expired'), 'expired');
    assert.equal(normalizeQrStatus('  PAID '), 'paid');
    assert.ok(QR_PAID_STATUSES.has('paid'));
    assert.ok(QR_PAID_STATUSES.has('overpaid'));
    assert.ok(!QR_PAID_STATUSES.has('pending'));
    assert.ok(QR_FINAL_STATUSES.has('expired'));
    assert.ok(!QR_FINAL_STATUSES.has('pending'));
  });
});

// ---- Route integration (mock Portos cez global.fetch) -------------------
describe('POST /api/payments/qr + GET /api/payments/qr/:id', () => {
  let fixtures = {};

  before(async () => {
    process.env.PORTOS_ENABLED = 'true';
    process.env.PORTOS_CASH_REGISTER_CODE = '88812345678900001';
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

  it('vytvorí QR platbu na sumu objednávky a vráti QR obrázok + Payme link', async () => {
    const { cisnik, table1, itemBurger, itemPivo } = fixtures;
    // 8.50 + 2.50 = 11.00, zľava 1.00 → expectedTotal 10.00
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
      { menuItemId: itemPivo.id, qty: 1 },
    ], '1.00');

    let createCall = null;
    let renderCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (/\/payments\/qr\/[^/]+\/render$/.test(u)) {
        renderCalled = true;
        return mockJsonResponse(204, null); // tlač QR na bonček OK
      }
      createCall = { url: u, body: opts && opts.body ? JSON.parse(opts.body) : null };
      return mockJsonResponse(201, buildQrCreateResponse());
    };

    const res = await request
      .post('/api/payments/qr')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id });

    assert.equal(res.status, 201);
    assert.equal(res.body.transactionId, 'QR-test-0001');
    assert.equal(res.body.amount, 10);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.payUrl, 'https://payme.tatrabanka.sk/?v=2&id=abc');
    // QR sa TLAČÍ na bonček (render) → printed=true. qrDataUrl sa vracia vždy
    // (fallback + spätná kompatibilita so staršou verziou frontendu).
    assert.equal(res.body.printed, true);
    assert.ok(renderCalled, 'mal sa zavolať Portos render (posPrinter)');
    assert.match(res.body.qrDataUrl, /^data:image\/png;base64,/);
    // Suma sa odvodzuje na serveri z objednávky, nie z klienta.
    assert.ok(createCall, 'create fetch sa mal zavolať');
    assert.match(createCall.url, /\/api\/v1\/payments\/qr$/);
    assert.equal(createCall.body.amount, 10);
    assert.equal(createCall.body.cashRegisterCode, '88812345678900001');
  });

  it('keď tlač QR zlyhá (tlačiareň offline) → fallback obrázok na obrazovku (printed=false)', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [{ menuItemId: itemBurger.id, qty: 1 }]);

    global.fetch = async (url) => {
      const u = String(url);
      if (/\/payments\/qr\/[^/]+\/render$/.test(u)) {
        return mockJsonResponse(500, { error: 'printer offline' }); // tlač zlyhala
      }
      return mockJsonResponse(201, buildQrCreateResponse());
    };

    const res = await request
      .post('/api/payments/qr')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id });

    assert.equal(res.status, 201);
    assert.equal(res.body.printed, false);
    assert.match(res.body.qrDataUrl, /^data:image\/png;base64,/);
  });

  it('400 keď je Portos vypnutý', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [{ menuItemId: itemBurger.id, qty: 1 }]);
    process.env.PORTOS_ENABLED = 'false';

    const res = await request
      .post('/api/payments/qr')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id });
    assert.equal(res.status, 400);
  });

  it('404 pre neexistujúcu objednávku', async () => {
    const res = await request
      .post('/api/payments/qr')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: 999999 });
    assert.equal(res.status, 404);
  });

  it('400 keď objednávka už nie je otvorená', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [{ menuItemId: itemBurger.id, qty: 1 }]);
    await testDb.update(schema.orders).set({ status: 'paid' }).where(sql`id = ${order.id}`);

    const res = await request
      .post('/api/payments/qr')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id });
    assert.equal(res.status, 400);
  });

  it('401 bez prihlásenia', async () => {
    const res = await request.post('/api/payments/qr').send({ orderId: 1 });
    assert.equal(res.status, 401);
  });

  it('GET stav: pending → paid=false, paid → paid=true/final=true', async () => {
    global.fetch = async () => mockJsonResponse(200, buildQrCreateResponse({ status: 'pending' }));
    let res = await request
      .get('/api/payments/qr/QR-test-0001')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.paid, false);

    global.fetch = async () => mockJsonResponse(200, buildQrCreateResponse({
      status: 'paid', paidAmount: 10, remainingAmount: 0,
    }));
    res = await request
      .get('/api/payments/qr/QR-test-0001')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'paid');
    assert.equal(res.body.paid, true);
    assert.equal(res.body.final, true);
  });

  it('GET stav: 404 keď Portos nepozná platbu', async () => {
    global.fetch = async () => mockJsonResponse(404, { error: 'not found' });
    const res = await request
      .get('/api/payments/qr/QR-unknown')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 404);
  });

  // ---- Strict-spec správanie (NineDigit PaymentStatus enum) ----
  it('GET stav: partiallyPaid → paid=false, final=false (pokračuje pooling)', async () => {
    global.fetch = async () => mockJsonResponse(200, buildQrCreateResponse({
      status: 'partiallyPaid', paidAmount: 5, remainingAmount: 5,
    }));
    const res = await request
      .get('/api/payments/qr/QR-test-0001')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'partiallypaid');
    assert.equal(res.body.paid, false);
    assert.equal(res.body.final, false);
  });

  it('GET stav: úspech sa určuje LEN podľa statusu — pending so sumami remaining=0 NIE je paid', async () => {
    // Strážny test: odstránili sme amount-based detekciu. Aj keď by sumy
    // ukazovali nulový zostatok, kým status nie je paid/overpaid → paid=false.
    global.fetch = async () => mockJsonResponse(200, buildQrCreateResponse({
      status: 'pending', paidAmount: 10, remainingAmount: 0,
    }));
    const res = await request
      .get('/api/payments/qr/QR-test-0001')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.paid, false);
    assert.equal(res.body.final, false);
  });

  it('GET stav: Expired (PascalCase) → final=true, paid=false', async () => {
    global.fetch = async () => mockJsonResponse(200, buildQrCreateResponse({
      status: 'Expired', paidAmount: 0, remainingAmount: 10,
    }));
    const res = await request
      .get('/api/payments/qr/QR-test-0001')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'expired');
    assert.equal(res.body.paid, false);
    assert.equal(res.body.final, true);
  });

  it('POST non-delivery-notice → 204 (Portos vytlačí doklad o nepotvrdení platby)', async () => {
    let captured = null;
    global.fetch = async (url) => {
      captured = String(url);
      return mockJsonResponse(204, null);
    };
    const res = await request
      .post('/api/payments/qr/QR-test-0001/non-delivery-notice')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});
    assert.equal(res.status, 204);
    assert.match(captured, /\/api\/v1\/payments\/qr\/QR-test-0001\/print_non_delivery_notice$/);
  });

  it('POST render → 204 (znova vytlačí QR bonček cez posPrinter)', async () => {
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = { url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null };
      return mockJsonResponse(204, null);
    };
    const res = await request
      .post('/api/payments/qr/QR-test-0001/render')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});
    assert.equal(res.status, 204);
    assert.match(captured.url, /\/api\/v1\/payments\/qr\/QR-test-0001\/render$/);
    assert.equal(captured.body.rendererName, 'posPrinter');
  });
});

// Prod safety: DATABASE_URL musí ukazovať na pos_test (alebo pos_test_<sandbox>
// pri paralelných behoch), nikdy nie na produkčnú `pos` DB.
if (!/\/pos_test(_[A-Za-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
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
import { registerCashWithdrawal } from '../../lib/portos.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { makeToken, tokens } from '../helpers/auth.js';

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

/**
 * Portos pri lookup-e (`GET .../receipts/receipt`) vracia PRESNE ten `request.data`,
 * ktorý mu POS poslal pri registrácii. Od commitu 39ba9a6 server túto zhodu overuje
 * (`validateReceiptMatchesRequest`) a odmietne zmergovať cudzí doklad
 * (`result_mode='mismatch_rejected'`), takže mock lookupu musí odoslaný payload
 * echo-vať — inak testuje niečo, čo Portos nikdy nevráti.
 */
function buildRegisterSuccessFromSent(sent, opts = {}) {
  const {
    receiptNumber = 21,
    receiptId = 'O-TEST-RECEIPT',
    isSuccessful = true,
    withResponse = true,
  } = opts;

  return {
    request: {
      data: {
        ...(sent?.request?.data || {}),
        receiptType: 'CashRegister',
        receiptNumber,
        okp: 'OKP-123',
      },
      id: '11111111-1111-1111-1111-111111111111',
      externalId: sent?.request?.externalId ?? null,
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

function parseSentBody(options) {
  try {
    return JSON.parse(options?.body ?? 'null');
  } catch {
    return null;
  }
}

/** externalId je od 39ba9a6 salted (`order-N-pay-<salt>`), nie deterministické. */
function saltedExternalIdPattern(orderId) {
  return new RegExp(`^order-${orderId}-pay-[a-z0-9]+-[0-9a-f]{4}$`);
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
    assert.match(fiscalDoc.externalId, saltedExternalIdPattern(order.id));
    assert.equal(fiscalDoc.externalId, res.body.fiscal.externalId);
    assert.equal(fiscalDoc.resultMode, 'online_success');
    assert.equal(fiscalDoc.paymentId, res.body.payment.id);
  });

  it('enriches successful Portos payment when register response is missing receipt id', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    let callIndex = 0;
    let sent = null;
    global.fetch = async (url, options) => {
      callIndex += 1;
      const target = String(url);
      if (target.includes('cash_register')) {
        sent = parseSentBody(options);
        return mockJsonResponse(200, buildRegisterSuccessFromSent(sent, {
          receiptNumber: 43,
          receiptId: null,
          withResponse: false,
        }));
      }

      return mockJsonResponse(200, buildRegisterSuccessFromSent(sent, {
        receiptNumber: 43,
        receiptId: 'O-ENRICHED',
      }));
    };

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 8.50 });

    assert.equal(res.status, 201);
    assert.equal(res.body.fiscal.status, 'online_success');
    assert.equal(res.body.fiscal.receiptId, 'O-ENRICHED');
    assert.equal(callIndex, 2);

    const [fiscalDoc] = await testDb.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.orderId, order.id));
    assert.equal(fiscalDoc.receiptId, 'O-ENRICHED');
  });

  it('rejects a foreign receipt with a non-2xx status and no payment row', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    // Portos POST prejde (200), ale lookup vráti CUDZÍ doklad (iné položky) —
    // presne scenár z 39ba9a6 (stale Portos cache po DB resete). Server ho
    // musí odmietnuť ako mismatch_rejected a NESMIE odpovedať 2xx: klient
    // (js/pos-payments.js normalizeFiscalOutcome) by 200 bez `error` statusu
    // klasifikoval ako úspech a čašníkovi ukázal „Platba uspesna".
    global.fetch = async (url, options) => {
      const target = String(url);
      if (target.includes('cash_register')) {
        const sent = parseSentBody(options);
        return mockJsonResponse(200, buildRegisterSuccessFromSent(sent, {
          receiptNumber: 44,
          receiptId: null,
          withResponse: false,
        }));
      }
      // Cudzí doklad — bez položiek, iná suma.
      return mockJsonResponse(200, buildRegisterSuccess({
        externalId: 'order-999-pay-stranger-0001',
        receiptNumber: 7,
        receiptId: 'O-STRANGER',
      }));
    };

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 8.50 });

    assert.equal(res.status, 400);
    assert.equal(res.body.fiscal.status, 'mismatch_rejected');
    assert.match(res.body.error, /NEZHODA/);

    const dbPayments = await testDb.select().from(schema.payments).where(eq(schema.payments.orderId, order.id));
    assert.equal(dbPayments.length, 0);

    const [dbOrder] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    assert.equal(dbOrder.status, 'open');
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

  it('marks storage connection failures as blocked and keeps the order open', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    global.fetch = async () => mockJsonResponse(500, {
      code: -100,
      title: 'Vseobecna chyba',
      detail: 'Aplikacia nedokaze nadviazat spojenie s datovym uloziskom. Uistite sa, ze ulozisko je pripojene na porte COM3.',
    });

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 8.50 });

    assert.equal(res.status, 503);
    assert.equal(res.body.fiscal.status, 'blocked');

    const [dbOrder] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    assert.equal(dbOrder.status, 'open');

    const dbPayments = await testDb.select().from(schema.payments).where(eq(schema.payments.orderId, order.id));
    assert.equal(dbPayments.length, 0);

    const [fiscalDoc] = await testDb.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.orderId, order.id));
    assert.equal(fiscalDoc.resultMode, 'blocked');
    assert.equal(fiscalDoc.errorCode, -100);
  });

  it('reconciles an ambiguous transport failure by externalId lookup', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    let callIndex = 0;
    let sent = null;
    // Všetky POST cash_register zlyhajú (3× retry), potom GET receipt vráti doklad — bez skutočného Portos.
    global.fetch = async (url, options) => {
      callIndex += 1;
      const u = String(url);
      if (u.includes('cash_register')) {
        sent = parseSentBody(options);
        throw new Error('socket hang up');
      }
      return mockJsonResponse(200, buildRegisterSuccessFromSent(sent, {
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
    assert.equal(callIndex, 4);
  });

  it('uses lookup and copy flow after Portos print error instead of new sale', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    let callIndex = 0;
    let sent = null;
    global.fetch = async (url, options) => {
      callIndex += 1;
      if (callIndex === 1) {
        sent = parseSentBody(options);
        return mockJsonResponse(500, {
          code: -502,
          title: 'Print failed',
          detail: 'Receipt printed failed',
        });
      }
      if (callIndex === 2) {
        return mockJsonResponse(200, buildRegisterSuccessFromSent(sent, {
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

  it('receipt-copy passes CashRegisterCode from saved fiscal row to Portos', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    global.fetch = async () => mockJsonResponse(200, buildRegisterSuccess({
      externalId: `order-${order.id}-payment`,
      receiptNumber: 41,
      receiptId: 'O-ROW-CODE',
    }));

    const paymentRes = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });

    assert.equal(paymentRes.status, 201);

    // externalId je salted, takže riadok hľadáme cez paymentId (nie cez legacy id).
    const rowCode = '99988877766655554';
    const updated = await testDb.update(schema.fiscalDocuments)
      .set({ cashRegisterCode: rowCode })
      .where(eq(schema.fiscalDocuments.paymentId, paymentRes.body.payment.id))
      .returning();
    assert.equal(updated.length, 1);

    let printUrl = '';
    global.fetch = async (url) => {
      printUrl = String(url);
      return mockJsonResponse(200, { printed: true });
    };

    const copyRes = await request
      .post(`/api/payments/${paymentRes.body.payment.id}/receipt-copy`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(copyRes.status, 200);
    assert.ok(
      printUrl.includes(`CashRegisterCode=${rowCode}`) || printUrl.includes(encodeURIComponent(rowCode)),
      `print_copy URL should use DB cash_register_code, got: ${printUrl}`,
    );
  });

  // Kópia dokladu bola jediná platobná trasa bez role guardu. Test drží obe
  // strany brány: čašník smie dotlačiť len doklad z prebiehajúceho
  // prevádzkového dňa (rez 04:00 Bratislava), manažér aj starší.
  it('receipt-copy: cisnik cannot reprint an older business-day document, manager can', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    global.fetch = async (url, options) => mockJsonResponse(200, buildRegisterSuccessFromSent(parseSentBody(options), {
      receiptNumber: 55,
      receiptId: 'O-COPY-OLD',
    }));

    const paymentRes = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });
    assert.equal(paymentRes.status, 201);
    const paymentId = paymentRes.body.payment.id;

    // Posuň platbu o 3 dni dozadu → už nie je z prebiehajúceho dňa.
    await testDb.execute(sql`
      UPDATE payments SET created_at = NOW() - INTERVAL '3 days' WHERE id = ${paymentId}
    `);

    let portosCalled = false;
    global.fetch = async () => {
      portosCalled = true;
      return mockJsonResponse(200, { printed: true });
    };

    const cisnikRes = await request
      .post(`/api/payments/${paymentId}/receipt-copy`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});

    assert.equal(cisnikRes.status, 403);
    assert.equal(portosCalled, false, 'refused copy must not reach Portos');

    const managerRes = await request
      .post(`/api/payments/${paymentId}/receipt-copy`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(managerRes.status, 200);
    assert.equal(managerRes.body.printed, true);

    // Kazda dotlac musi byt v audite.
    const events = await testDb.select().from(schema.orderEvents)
      .where(and(
        eq(schema.orderEvents.orderId, order.id),
        eq(schema.orderEvents.type, 'fiscal_receipt_copy'),
      ));
    assert.equal(events.length, 1);
    assert.equal(events[0].staffId, 2);
    assert.equal(JSON.parse(events[0].payload).paymentId, paymentId);
  });

  it('receipt-copy is rejected for an unauthenticated request', async () => {
    const res = await request.post('/api/payments/1/receipt-copy').send({});
    assert.equal(res.status, 401);
  });

  // Role guard bije aj na prihlásený, ale nepovolaný účet (napr. kuchár) —
  // predtým prešiel ktokoľvek s platným tokenom.
  it('receipt-copy is rejected for an authenticated non-staff role (403)', async () => {
    let portosCalled = false;
    global.fetch = async () => {
      portosCalled = true;
      return mockJsonResponse(200, { printed: true });
    };

    const res = await request
      .post('/api/payments/1/receipt-copy')
      .set('Authorization', `Bearer ${makeToken({ id: 1, name: 'Kuchar', role: 'kuchar' })}`)
      .send({});

    assert.equal(res.status, 403);
    assert.equal(portosCalled, false);
  });

  // Z-report auto-výber: druhý ťuk na uzávierku NESMIE vytlačiť druhý
  // fiškálny paragón výberu. Predtým sa Portos volal PRED kontrolou
  // cashflow_entries, takže dva paragóny padli na jeden cashflow riadok.
  it('z-report withdrawal skips Portos when the day already has a withdrawal entry', async () => {
    const date = '2026-04-20';

    // Tlačiareň na zavretý port → sendOrQueue zlyhá rýchlo a job ide do fronty
    // (tlač nie je predmetom testu, ale nesmie blokovať).
    const [printer] = await testDb.insert(schema.printers)
      .values({ name: 'test-uctenka', ip: '127.0.0.1', port: 1, dest: 'uctenka', active: true })
      .returning();

    await testDb.insert(schema.cashflowEntries).values({
      type: 'expense',
      category: 'withdrawal_uzavierka',
      amount: '100.00',
      occurredAt: new Date(`${date}T23:59:59+02:00`),
      method: 'cash',
      note: 'existujuci vyber pre tento den',
      staffId: fixtures.manazer.id,
    });

    let withdrawCalls = 0;
    global.fetch = async (url) => {
      const target = String(url);
      if (target.includes('/api/reports/z-report')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            date,
            fiscalRevenue: 100,
            totalRevenue: 100,
            paymentMethods: [{ method: 'hotovost', total: 100 }],
            shisha: null,
            totalOrders: 5,
            totalItems: 9,
            averageOrder: 20,
            cancelledItems: 0,
            cancelledTotal: 0,
            categoryBreakdown: [],
            topItems: [],
          }),
        };
      }
      if (target.includes('/receipts/withdraw')) {
        withdrawCalls += 1;
        return mockJsonResponse(200, { response: { data: { id: 'W-1' } } });
      }
      return mockJsonResponse(200, {});
    };

    try {
      const res = await request
        .post('/api/print/z-report')
        .set('Authorization', `Bearer ${tokens.manazer()}`)
        .send({ date });

      assert.equal(res.status, 200);
      assert.equal(withdrawCalls, 0, 'Portos withdraw must NOT be called when the day already has a withdrawal');
      assert.equal(res.body.withdrawal.alreadyExists, true);

      const entries = await testDb.select().from(schema.cashflowEntries)
        .where(eq(schema.cashflowEntries.category, 'withdrawal_uzavierka'));
      assert.equal(entries.length, 1, 'no duplicate cashflow row either');
    } finally {
      await testDb.delete(schema.printers).where(eq(schema.printers.id, printer.id));
      await testDb.delete(schema.cashflowEntries);
    }
  });

  // Druhá strana tej istej brány: digitálna uzávierka paragón NEVYTVORÍ a
  // potvrdzovacie okno operátorovi sľubuje, že ho môže dotlačiť papierovou
  // uzávierkou. Guard „existuje cashflow riadok → Portos vôbec nevolaj" by
  // túto obnovu ticho zabil (paragón by nevznikol nikdy). Papierový beh po
  // digitálnom teda musí paragón poslať PRÁVE RAZ.
  it('z-report: paper uzávierka after a digital one issues the missing paragon exactly once', async () => {
    const date = '2026-04-21';

    const [printer] = await testDb.insert(schema.printers)
      .values({ name: 'test-uctenka-2', ip: '127.0.0.1', port: 1, dest: 'uctenka', active: true })
      .returning();

    let withdrawCalls = 0;
    global.fetch = async (url) => {
      const target = String(url);
      if (target.includes('/api/reports/z-report')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            date,
            fiscalRevenue: 60,
            totalRevenue: 60,
            paymentMethods: [{ method: 'hotovost', total: 60 }],
            shisha: null,
            totalOrders: 3,
            totalItems: 6,
            averageOrder: 20,
            cancelledItems: 0,
            cancelledTotal: 0,
            categoryBreakdown: [],
            topItems: [],
          }),
        };
      }
      if (target.includes('/receipts/withdraw')) {
        withdrawCalls += 1;
        return mockJsonResponse(200, { response: { data: { id: 'W-DIGITAL-FIX' } } });
      }
      return mockJsonResponse(200, {});
    };

    const zReport = (body) => request
      .post('/api/print/z-report')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send(body);

    try {
      // 1) Digitálna uzávierka — cashflow áno, fiškálny paragón nie.
      const digitalRes = await zReport({ date, digital: true });
      assert.equal(digitalRes.status, 200);
      assert.equal(digitalRes.body.withdrawal.created, true);
      assert.equal(withdrawCalls, 0, 'digital uzávierka must not print a fiscal paragon');

      // 2) Papierová uzávierka toho istého dňa — paragón sa DOTLAČÍ, cashflow
      //    riadok sa NEduplikuje.
      const paperRes = await zReport({ date });
      assert.equal(paperRes.status, 200);
      assert.equal(withdrawCalls, 1, 'paper uzávierka after a digital one must issue the missing paragon');
      assert.equal(paperRes.body.portosWithdraw.ok, true);
      assert.equal(paperRes.body.withdrawal.alreadyExists, true);

      let entries = await testDb.select().from(schema.cashflowEntries)
        .where(eq(schema.cashflowEntries.category, 'withdrawal_uzavierka'));
      assert.equal(entries.length, 1, 'no duplicate cashflow row');

      // 3) Tretí ťuk — paragón už existuje, Portos sa NESMIE volať znova.
      const againRes = await zReport({ date });
      assert.equal(againRes.status, 200);
      assert.equal(withdrawCalls, 1, 'a second paper uzávierka must NOT print a second paragon');
      assert.equal(againRes.body.withdrawal.alreadyExists, true);

      entries = await testDb.select().from(schema.cashflowEntries)
        .where(eq(schema.cashflowEntries.category, 'withdrawal_uzavierka'));
      assert.equal(entries.length, 1);
    } finally {
      await testDb.delete(schema.printers).where(eq(schema.printers.id, printer.id));
      await testDb.delete(schema.cashflowEntries);
    }
  });

  // externalId je druhá vrstva ochrany pred dvoma paragónmi výberu. Retry bez
  // neho smie prebehnúť LEN keď Portos pole nepozná — nie keď 400 znamená
  // „taký externalId už bol", lebo to je práve úspešná deduplikácia.
  it('withdrawal retries without externalId only when the field itself is rejected', async () => {
    const bodies = [];
    global.fetch = async (url, options) => {
      bodies.push(JSON.parse(options?.body ?? 'null'));
      if (bodies.length === 1) {
        return mockJsonResponse(400, { title: 'Validation failed', detail: "Unknown property 'externalId'." });
      }
      return mockJsonResponse(200, { response: { data: { id: 'W-RETRY' } } });
    };

    const res = await registerCashWithdrawal({ cashRegisterCode: 'X1', amount: 10, externalId: 'withdraw-2026-04-22-X1' });
    assert.equal(res.ok, true);
    assert.equal(bodies.length, 2, 'unknown-field 400 must fall back to a request without externalId');
    assert.equal(bodies[0].request.externalId, 'withdraw-2026-04-22-X1');
    assert.equal(bodies[1].request.externalId, undefined);
  });

  it('withdrawal does NOT retry when Portos rejects a duplicate externalId', async () => {
    const bodies = [];
    global.fetch = async (url, options) => {
      bodies.push(JSON.parse(options?.body ?? 'null'));
      return mockJsonResponse(400, { title: 'Duplicate request', detail: 'Request with the same externalId already exists.' });
    };

    const res = await registerCashWithdrawal({ cashRegisterCode: 'X1', amount: 10, externalId: 'withdraw-2026-04-22-X1' });
    assert.equal(res.ok, false);
    assert.equal(bodies.length, 1, 'a duplicate externalId must NOT be retried without the key — that would print a second paragon');
  });

  it('rejects payment before Portos call when order contains unsupported VAT rate', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    // Od 0eb891e platí VAT-rate guard len pre platiteľa DPH — neplatiteľ ide
    // cez forceZeroVat a sadzby z menu sa na doklad vôbec nedostanú. Test teda
    // musí firmu najprv označiť za platiteľa (IČ DPH vyplnené).
    await testDb.insert(schema.companyProfiles).values({
      businessName: 'Test s.r.o.',
      ico: '12345678',
      dic: '1234567890',
      icDph: 'SK1234567890',
    });

    await testDb.update(schema.menuItems)
      .set({ vatRate: '20.00' })
      .where(eq(schema.menuItems.id, itemPivo.id));

    let called = false;
    global.fetch = async (url, options) => {
      called = true;
      return mockJsonResponse(200, buildRegisterSuccessFromSent(parseSentBody(options)));
    };

    try {
      const res = await request
        .post('/api/payments')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });

      assert.equal(res.status, 400);
      assert.match(res.body.error, /Portos podporuje iba sadzby DPH/);
      assert.equal(called, false);
    } finally {
      await testDb.delete(schema.companyProfiles);
      await testDb.update(schema.menuItems)
        .set({ vatRate: '23.00' })
        .where(eq(schema.menuItems.id, itemPivo.id));
    }
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
    global.fetch = async (url, options) => {
      callIndex += 1;
      const sent = parseSentBody(options);
      if (callIndex === 1) {
        return mockJsonResponse(200, buildRegisterSuccessFromSent(sent, {
          receiptNumber: 41,
          receiptId: 'O-ORIG',
        }));
      }
      return mockJsonResponse(200, buildRegisterSuccessFromSent(sent, {
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

    // Storno externalId musí byť odvodené zo saltu predajného dokladu
    // (`order-N-pay-<salt>` → `order-N-pay-<salt>-storno`), aby existence-check
    // a odoslanie zdieľali rovnaký id priestor — viď 39ba9a6.
    const saleDoc = docs.find((d) => d.sourceType === 'payment');
    assert.match(saleDoc.externalId, saltedExternalIdPattern(order.id));
    const stornoDoc = docs.find((d) => d.externalId === `${saleDoc.externalId}-storno`);
    assert.ok(stornoDoc, `expected storno doc ${saleDoc.externalId}-storno, got ${docs.map((d) => d.externalId).join(', ')}`);
    assert.equal(stornoDoc.sourceType, 'storno');
  });

  it('returns 2xx for a storno reconciled after a -502 print error', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    let callIndex = 0;
    let stornoSent = null;
    global.fetch = async (url, options) => {
      callIndex += 1;
      // 1) predaj OK
      if (callIndex === 1) {
        return mockJsonResponse(200, buildRegisterSuccessFromSent(parseSentBody(options), {
          receiptNumber: 51,
          receiptId: 'O-SALE-502',
        }));
      }
      // 2) storno POST spadne na tlačiarni (-502) — doklad je ale v eKase
      if (callIndex === 2) {
        stornoSent = parseSentBody(options);
        return mockJsonResponse(500, {
          code: -502,
          title: 'Print failed',
          detail: 'Receipt printed failed',
        });
      }
      // 3) lookup nájde reálne odoslaný storno doklad → reconcile PREJDE
      if (callIndex === 3) {
        return mockJsonResponse(200, buildRegisterSuccessFromSent(stornoSent, {
          receiptNumber: 52,
          receiptId: 'O-STORNO-502',
        }));
      }
      // 4) print copy
      return mockJsonResponse(200, { printed: true });
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

    // Storno REÁLNE prebehlo (reconciled) a riadok je v DB — odpoveď preto NESMIE
    // zdediť pôvodný 500 z prvého pokusu. Inak čašník vidí „zlyhalo", opakuje
    // storno a narazí na dedup 409, hoci eKasa už storno eviduje.
    assert.equal(stornoRes.status, 200);
    assert.equal(stornoRes.body.ok, true);
    assert.equal(stornoRes.body.fiscal.status, 'reconciled_online_success');

    const docs = await testDb.select().from(schema.fiscalDocuments)
      .where(eq(schema.fiscalDocuments.paymentId, paymentRes.body.payment.id));
    assert.equal(docs.filter((d) => d.sourceType === 'storno').length, 1);
  });
});

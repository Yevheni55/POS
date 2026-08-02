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
import { eq, sql } from 'drizzle-orm';

import { app } from '../../app.js';
import * as schema from '../../db/schema.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

app.set('io', { emit: () => {} });

const request = supertest(app);
const originalFetch = global.fetch;

const OWN_CODE = '88812345678900001';
const FOREIGN_CODE = '88821217418420001';

function mockJsonResponse(status, body) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  });
}

function parseSentBody(options) {
  try {
    return JSON.parse(options?.body ?? 'null');
  } catch {
    return null;
  }
}

/** Portos pri lookupe echo-uje presne to, čo mu POS poslal — inak by
 *  `validateReceiptMatchesRequest` doklad odmietol ako mismatch_rejected. */
function buildRegisterSuccessFromSent(sent, { receiptNumber = 21, receiptId = 'O-TEST' } = {}) {
  return {
    request: {
      data: {
        ...(sent?.request?.data || {}),
        receiptType: sent?.request?.data?.receiptType || 'CashRegister',
        receiptNumber,
        okp: 'OKP-123',
      },
      id: '11111111-1111-1111-1111-111111111111',
      externalId: sent?.request?.externalId ?? null,
      date: '2026-04-02T10:00:00+02:00',
      sendingCount: 1,
    },
    response: {
      data: { id: receiptId },
      processDate: '2026-04-02T10:00:01+02:00',
    },
    isSuccessful: true,
    error: null,
  };
}

async function createOpenOrder(tableId, staffId, items) {
  const [order] = await testDb
    .insert(schema.orders)
    .values({ tableId, staffId, status: 'open', label: 'Test', discountAmount: null })
    .returning();

  for (const item of items) {
    await testDb
      .insert(schema.orderItems)
      .values({ orderId: order.id, menuItemId: item.menuItemId, qty: item.qty, sent: true });
  }

  return order;
}

/** Platiteľ DPH — `company_profiles.ic_dph` je jediný zdroj pravdy pre režim. */
async function makeVatPayerProfile() {
  await testDb.delete(schema.companyProfiles);
  await testDb.insert(schema.companyProfiles).values({
    businessName: 'SL management, s.r.o.',
    ico: '12345678',
    dic: '1234567890',
    icDph: 'SK2121741842',
    cashRegisterCode: OWN_CODE,
  });
}

/** Zaplať účet cez štandardnú cestu, nech je zmrazený payload naozaj ten,
 *  ktorý vyrobí produkčný kód (nie ručne zložený objekt v teste). */
async function payOrder(order, { method = 'hotovost', amount, receiptId = 'O-SALE' }) {
  global.fetch = async (url, options) => mockJsonResponse(200, buildRegisterSuccessFromSent(
    parseSentBody(options),
    { receiptNumber: 100, receiptId },
  ));

  const res = await request
    .post('/api/payments')
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .send({ orderId: order.id, method, amount });

  assert.equal(res.status, 201, `payment failed: ${JSON.stringify(res.body)}`);
  return res.body.payment;
}

async function saleDocFor(paymentId) {
  const docs = await testDb.select().from(schema.fiscalDocuments)
    .where(eq(schema.fiscalDocuments.paymentId, paymentId));
  return docs.find((d) => d.sourceType === 'payment');
}

after(async () => {
  global.fetch = originalFetch;
  await closeDb();
});

describe('change-method + refiscalize — DPH-neutralita a ochrana pred dvojitým dokladom', () => {
  let fixtures = {};

  before(async () => {
    process.env.PORTOS_ENABLED = 'true';
    process.env.PORTOS_CASH_REGISTER_CODE = OWN_CODE;
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
    await testDb.delete(schema.companyProfiles);
    await testDb.update(schema.tables).set({ status: 'free' });
    global.fetch = originalFetch;
  });

  // ── [03] + [23] ────────────────────────────────────────────────────────────
  it('novy doklad kopiruje ZMRAZENE polozky — zmena menu ani rezimu DPH ho neovplyvni', async () => {
    const { cisnik, table1, itemBurger, itemPivo } = fixtures;
    await makeVatPayerProfile();

    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },   // 8.50 @ 5 %
      { menuItemId: itemPivo.id, qty: 1 },     // 2.50 @ 23 %
    ]);
    const payment = await payOrder(order, { amount: 11.00 });

    const saleDoc = await saleDocFor(payment.id);
    const frozenItems = JSON.parse(saleDoc.requestJson).request.data.items;
    assert.deepEqual(frozenItems.map((i) => i.vatRate), [5, 23], 'predpoklad testu: platitel DPH razi realne sadzby');

    // Menu sa medzitým zmení (cena aj sadzba) A firma sa vráti na neplatiteľa.
    // Stará implementácia by nový doklad postavila z TOHTO stavu.
    await testDb.update(schema.menuItems).set({ price: '99.00', vatRate: '23.00' })
      .where(eq(schema.menuItems.id, itemBurger.id));
    await testDb.delete(schema.companyProfiles);

    const sent = [];
    global.fetch = async (url, options) => {
      const target = String(url);
      if (target.includes('print_copy')) return mockJsonResponse(200, { printed: true });
      const body = parseSentBody(options);
      sent.push(body);
      return mockJsonResponse(200, buildRegisterSuccessFromSent(body, {
        receiptNumber: 200 + sent.length,
        receiptId: `O-CM-${sent.length}`,
      }));
    };

    try {
      const res = await request
        .post(`/api/payments/${payment.id}/change-method`)
        .set('Authorization', `Bearer ${tokens.manazer()}`)
        .send({ newMethod: 'karta' });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(sent.length, 2, 'presne dva doklady: storno + novy predaj');

      // 1) STORNO = zrkadlo zmrazeného dokladu.
      const stornoData = sent[0].request.data;
      assert.deepEqual(stornoData.items.map((i) => i.type), ['correction', 'correction']);
      assert.deepEqual(stornoData.items.map((i) => i.vatRate), [5, 23]);
      assert.deepEqual(stornoData.items.map((i) => i.price), [-8.5, -2.5]);

      // 2) NOVY PREDAJ = tie isté položky BÍTOVO, mení sa len `payments`.
      const newData = sent[1].request.data;
      assert.deepEqual(newData.items, frozenItems, 'polozky sa NESMU skladat nanovo z live menu');
      assert.deepEqual(newData.payments, [{ name: 'Karta', amount: 11 }]);
      assert.equal(newData.cashRegisterCode, OWN_CODE);
      assert.notEqual(sent[1].request.externalId, saleDoc.externalId, 'novy doklad musi mat novy externalId');

      // 3) Dvojica je sumovo aj DPH neutrálna.
      const stornoSum = stornoData.payments.reduce((s, p) => s + p.amount, 0);
      const newSum = newData.payments.reduce((s, p) => s + p.amount, 0);
      assert.equal(Math.round((stornoSum + newSum) * 100) / 100, 0);

      const [updatedPayment] = await testDb.select().from(schema.payments)
        .where(eq(schema.payments.id, payment.id));
      assert.equal(updatedPayment.method, 'karta');

      // 4) Na platbe smie ostat PRAVE JEDEN aktivny predajny doklad — inak by
      //    `.find(d => d.sourceType === 'payment')` trafilo stary (vystornovany)
      //    a storno noveho dokladu by uz nikdy nepreslo.
      const docs = await testDb.select().from(schema.fiscalDocuments)
        .where(eq(schema.fiscalDocuments.paymentId, payment.id));
      assert.equal(docs.filter((d) => d.sourceType === 'payment').length, 1);
      const oldDoc = docs.find((d) => d.externalId === saleDoc.externalId);
      assert.ok(oldDoc, 'stary riadok sa NESMIE mazat');
      assert.equal(oldDoc.sourceType, 'payment_superseded');
      assert.equal(docs.filter((d) => d.sourceType === 'storno').length, 1);

      // A storno noveho dokladu musi byt realne mozne.
      const fiscalRes = await request
        .get(`/api/payments/${payment.id}/fiscal`)
        .set('Authorization', `Bearer ${tokens.manazer()}`);
      assert.equal(fiscalRes.status, 200);
      assert.equal(fiscalRes.body.externalId, sent[1].request.externalId);
      assert.equal(fiscalRes.body.stornoDone, false, 'storno stareho dokladu nie je storno noveho');
      assert.equal(fiscalRes.body.stornoEligible, true);

      const historyRes = await request
        .get('/api/payments/history')
        .set('Authorization', `Bearer ${tokens.manazer()}`);
      const histRow = historyRes.body.items.find((i) => i.id === payment.id);
      assert.ok(histRow);
      assert.equal(histRow.storno, null);
      assert.equal(histRow.stornoEligible, true);
    } finally {
      await testDb.update(schema.menuItems).set({ price: '8.50', vatRate: '5.00' })
        .where(eq(schema.menuItems.id, itemBurger.id));
    }
  });

  // ── [23] + [25] ────────────────────────────────────────────────────────────
  it('nepodporovana sadzba v zmrazenom payloade => 400 a ZIADNE storno neodide', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    await makeVatPayerProfile();

    const order = await createOpenOrder(table1.id, cisnik.id, [{ menuItemId: itemBurger.id, qty: 1 }]);
    const payment = await payOrder(order, { amount: 8.50 });

    // Doklad zmrazený s neplatnou sadzbou (napr. DB default 20.00 z ručného SQL).
    const saleDoc = await saleDocFor(payment.id);
    const payload = JSON.parse(saleDoc.requestJson);
    payload.request.data.items[0].vatRate = 20;
    await testDb.update(schema.fiscalDocuments)
      .set({ requestJson: JSON.stringify(payload) })
      .where(eq(schema.fiscalDocuments.id, saleDoc.id));

    let called = false;
    global.fetch = async () => { called = true; return mockJsonResponse(200, {}); };

    const res = await request
      .post(`/api/payments/${payment.id}/change-method`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ newMethod: 'karta' });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Portos podporuje iba sadzby DPH/);
    assert.equal(called, false, 'validacia musi bezat PRED stornom — inak ostane vystornovany doklad bez nahrady');

    const docs = await testDb.select().from(schema.fiscalDocuments)
      .where(eq(schema.fiscalDocuments.paymentId, payment.id));
    assert.equal(docs.filter((d) => d.sourceType === 'storno').length, 0);
  });

  it('nerozparsovatelny zmrazeny payload => 400 pred stornom', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [{ menuItemId: itemBurger.id, qty: 1 }]);
    const payment = await payOrder(order, { amount: 8.50 });

    const saleDoc = await saleDocFor(payment.id);
    await testDb.update(schema.fiscalDocuments)
      .set({ requestJson: '{}' })
      .where(eq(schema.fiscalDocuments.id, saleDoc.id));

    let called = false;
    global.fetch = async () => { called = true; return mockJsonResponse(200, {}); };

    const res = await request
      .post(`/api/payments/${payment.id}/change-method`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ newMethod: 'karta' });

    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  // ── [22] ───────────────────────────────────────────────────────────────────
  it('doklad z predchadzajucej identity => 409 foreign_cash_register, Portos sa nezavola', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [{ menuItemId: itemBurger.id, qty: 1 }]);
    const payment = await payOrder(order, { amount: 8.50 });

    const saleDoc = await saleDocFor(payment.id);
    await testDb.update(schema.fiscalDocuments)
      .set({ cashRegisterCode: FOREIGN_CODE })
      .where(eq(schema.fiscalDocuments.id, saleDoc.id));

    let called = false;
    global.fetch = async () => { called = true; return mockJsonResponse(200, {}); };

    const changeRes = await request
      .post(`/api/payments/${payment.id}/change-method`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ newMethod: 'karta' });
    assert.equal(changeRes.status, 409);
    assert.equal(changeRes.body.stornoBlockedReason, 'foreign_cash_register');

    const stornoRes = await request
      .post(`/api/payments/${payment.id}/fiscal-storno`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});
    assert.equal(stornoRes.status, 409);
    assert.equal(stornoRes.body.stornoBlockedReason, 'foreign_cash_register');

    const fiscalRes = await request
      .get(`/api/payments/${payment.id}/fiscal`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(fiscalRes.status, 200);
    assert.equal(fiscalRes.body.stornoEligible, false);
    assert.equal(fiscalRes.body.stornoBlockedReason, 'foreign_cash_register');

    const historyRes = await request
      .get('/api/payments/history?scope=all')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(historyRes.status, 200);
    const row = historyRes.body.items.find((i) => i.id === payment.id);
    assert.ok(row, 'platba musi byt v scope=all');
    assert.equal(row.stornoEligible, false);
    assert.equal(row.stornoBlockedReason, 'foreign_cash_register');
    assert.equal(row.copyAvailable, true, 'dotlac kopie ostava povolena');

    assert.equal(called, false, 'ziadny odsudeny request do Portosu');
  });

  // ── [04] ───────────────────────────────────────────────────────────────────
  it('refiskalizacia platne zaevidovaneho dokladu => 409, Portos sa nezavola', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    const order = await createOpenOrder(table1.id, cisnik.id, [{ menuItemId: itemBurger.id, qty: 1 }]);
    const payment = await payOrder(order, { amount: 8.50 });

    let called = false;
    global.fetch = async () => { called = true; return mockJsonResponse(200, {}); };

    const res = await request
      .post(`/api/payments/${payment.id}/refiscalize`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 409);
    assert.match(res.body.error, /STORNO/);
    assert.equal(called, false, 'refiskalizacia by vyrobila DRUHY doklad na tu istu trzbu');
  });

  it('refiskalizacia odmietnuteho dokladu berie ZMRAZENY payload a stary riadok NEMAZE', async () => {
    const { cisnik, table1, itemBurger } = fixtures;
    await makeVatPayerProfile();

    const order = await createOpenOrder(table1.id, cisnik.id, [{ menuItemId: itemBurger.id, qty: 1 }]);
    const payment = await payOrder(order, { amount: 8.50 });

    const saleDoc = await saleDocFor(payment.id);
    const frozenItems = JSON.parse(saleDoc.requestJson).request.data.items;
    // Doklad sa nikdy poriadne nezaevidoval — presne stav, pre ktorý refiskalizacia je.
    await testDb.update(schema.fiscalDocuments)
      .set({ resultMode: 'mismatch_rejected', isSuccessful: false, receiptId: null, okp: null })
      .where(eq(schema.fiscalDocuments.id, saleDoc.id));

    // Menu sa medzitým zmení + firma prestane byť platiteľom.
    await testDb.update(schema.menuItems).set({ price: '99.00', vatRate: '23.00' })
      .where(eq(schema.menuItems.id, itemBurger.id));
    await testDb.delete(schema.companyProfiles);

    const sent = [];
    global.fetch = async (url, options) => {
      const target = String(url);
      if (target.includes('print_copy')) return mockJsonResponse(200, { printed: true });
      const body = parseSentBody(options);
      sent.push(body);
      return mockJsonResponse(200, buildRegisterSuccessFromSent(body, {
        receiptNumber: 300 + sent.length,
        receiptId: `O-RF-${sent.length}`,
      }));
    };

    try {
      const res = await request
        .post(`/api/payments/${payment.id}/refiscalize`)
        .set('Authorization', `Bearer ${tokens.manazer()}`)
        .send({});

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].request.data.items, frozenItems, 'polozky zo zmrazeneho payloadu, nie z live menu');
      assert.notEqual(sent[0].request.externalId, saleDoc.externalId);

      const docs = await testDb.select().from(schema.fiscalDocuments)
        .where(eq(schema.fiscalDocuments.paymentId, payment.id));
      const old = docs.find((d) => d.externalId === saleDoc.externalId);
      assert.ok(old, 'stary riadok sa NESMIE mazat — externalId/receiptId treba pre neskorsie storno');
      assert.equal(old.sourceType, 'payment_superseded');
      assert.equal(docs.filter((d) => d.sourceType === 'payment').length, 1);
    } finally {
      await testDb.update(schema.menuItems).set({ price: '8.50', vatRate: '5.00' })
        .where(eq(schema.menuItems.id, itemBurger.id));
    }
  });
});

// DATABASE_URL must point to pos_test BEFORE Node starts, because db/index.js
// is a static ESM dependency loaded at import time.  The npm test script passes:
//   DATABASE_URL=postgresql://pos:pos@localhost:5432/pos_test node --test ...
if (!process.env.DATABASE_URL?.endsWith('/pos_test')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { eq, and, sql } from 'drizzle-orm';

import { app } from '../../app.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';

// ---------------------------------------------------------------------------
// Top-level setup — applied once for the entire file
// ---------------------------------------------------------------------------

// Stub Socket.IO — emitEvent() calls io.emit(); prevent crash on missing server
app.set('io', { emit: () => {} });

const request = supertest(app);

// Close the pool once — after ALL describe blocks in this file finish
after(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Helper: create a ready-to-pay open order with items
// ---------------------------------------------------------------------------
async function createOpenOrder(tableId, staffId, items) {
  const [order] = await testDb
    .insert(schema.orders)
    .values({ tableId, staffId, status: 'open', label: 'Test' })
    .returning();

  for (const item of items) {
    await testDb
      .insert(schema.orderItems)
      .values({ orderId: order.id, menuItemId: item.menuItemId, qty: item.qty, sent: true });
  }

  return order;
}

// ---------------------------------------------------------------------------
// POST /api/payments
// ---------------------------------------------------------------------------
describe('POST /api/payments', () => {
  let fixtures = {};

  before(async () => {
    await truncateAll();
    fixtures = await seed();
  });

  // Wipe transactional rows before each test; keep menu/staff/tables seed
  beforeEach(async () => {
    await testDb.execute(
      sql.raw('TRUNCATE order_events, payments, order_items, orders RESTART IDENTITY CASCADE')
    );
    // Reset table statuses to free after previous test may have changed them
    await testDb.update(schema.tables).set({ status: 'free' });
  });

  // -------------------------------------------------------------------------
  // 1. Happy path — cash payment closes order and frees table
  // -------------------------------------------------------------------------
  it('closes order and frees table on exact cash payment', async () => {
    const { cisnik, table1, itemBurger, itemPivo } = fixtures;

    // burger×2 = 17.00, pivo×1 = 2.50 → total 19.50
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 2 },
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 19.50 });

    assert.equal(res.status, 201);
    assert.ok(res.body.payment, 'response must include payment record');
    assert.ok(res.body.order, 'response must include closed order');

    // Verify order closed in DB
    const [dbOrder] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    assert.equal(dbOrder.status, 'closed', 'order status must be closed');
    assert.ok(dbOrder.closedAt, 'order must have a closedAt timestamp');

    // Verify payment record
    const [dbPayment] = await testDb
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, order.id));
    assert.ok(dbPayment, 'payment record must exist in DB');
    assert.equal(dbPayment.method, 'hotovost');
    assert.equal(parseFloat(dbPayment.amount), 19.50);

    // Verify table freed
    const [dbTable] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, table1.id));
    assert.equal(dbTable.status, 'free', 'table must be freed when no open orders remain');
  });

  // -------------------------------------------------------------------------
  // 2. Underpayment rejected
  // -------------------------------------------------------------------------
  it('rejects payment when amount is less than order total', async () => {
    const { cisnik, table1, itemBurger } = fixtures;

    // burger×1 = 8.50; sending 1.00 is clearly short
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },
    ]);

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 1.00 });

    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'error field must be present');
    assert.match(res.body.error, /Suma platby/i, 'error must reference the underpaid amount');

    // Order must remain open — no partial payment state
    const [dbOrder] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    assert.equal(dbOrder.status, 'open', 'order must remain open after rejected payment');

    // No payment record should exist
    const dbPayments = await testDb
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, order.id));
    assert.equal(dbPayments.length, 0, 'no payment record should be created on rejection');
  });

  // -------------------------------------------------------------------------
  // 3. Payment on already-closed order
  // -------------------------------------------------------------------------
  it('rejects payment on an already-closed order', async () => {
    const { cisnik, table1, itemPivo } = fixtures;

    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    // Manually close the order in DB
    await testDb
      .update(schema.orders)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(schema.orders.id, order.id));

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  // -------------------------------------------------------------------------
  // 4. Non-existent order returns 404
  // -------------------------------------------------------------------------
  it('returns 404 for a non-existent orderId', async () => {
    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: 99999, method: 'hotovost', amount: 10.00 });

    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  // -------------------------------------------------------------------------
  // 5. Table stays occupied until the last open order on it is paid
  // -------------------------------------------------------------------------
  it('keeps table occupied until the last open order is paid', async () => {
    const { cisnik, manazer, table1, itemBurger, itemPivo } = fixtures;

    // Pre-set table to occupied (simulates real state)
    await testDb
      .update(schema.tables)
      .set({ status: 'occupied' })
      .where(eq(schema.tables.id, table1.id));

    const orderA = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 1 },  // €8.50
    ]);
    const orderB = await createOpenOrder(table1.id, manazer.id, [
      { menuItemId: itemPivo.id, qty: 1 },    // €2.50
    ]);

    // Pay first order only
    const res1 = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: orderA.id, method: 'hotovost', amount: 8.50 });

    assert.equal(res1.status, 201);

    const [tableAfterFirst] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, table1.id));
    assert.equal(
      tableAfterFirst.status,
      'occupied',
      'table must remain occupied while orderB is still open'
    );

    // Pay second order
    const res2 = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ orderId: orderB.id, method: 'hotovost', amount: 2.50 });

    assert.equal(res2.status, 201);

    const [tableAfterSecond] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, table1.id));
    assert.equal(
      tableAfterSecond.status,
      'free',
      'table must be freed once all open orders are paid'
    );
  });

  // -------------------------------------------------------------------------
  // 6. Payment with discount — reduced amount is accepted
  // -------------------------------------------------------------------------
  it('accepts exact payment matching discounted total', async () => {
    const { cisnik, table1, itemBurger } = fixtures;

    // burger×2 = 17.00, discount €2.00 → expected total 15.00
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 2 },
    ]);

    await testDb
      .update(schema.orders)
      .set({ discountAmount: '2.00' })
      .where(eq(schema.orders.id, order.id));

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 15.00 });

    assert.equal(res.status, 201);

    const [dbOrder] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    assert.equal(dbOrder.status, 'closed');

    const [dbPayment] = await testDb
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, order.id));
    assert.equal(parseFloat(dbPayment.amount), 15.00);
  });

  it('rejects payment that is below discounted total', async () => {
    const { cisnik, table1, itemBurger } = fixtures;

    // burger×2 = 17.00, discount €2.00 → expected 15.00; sending 14.00 is short
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemBurger.id, qty: 2 },
    ]);

    await testDb
      .update(schema.orders)
      .set({ discountAmount: '2.00' })
      .where(eq(schema.orders.id, order.id));

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 14.00 });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Suma platby/i);
  });

  // -------------------------------------------------------------------------
  // 7. Card payment method is accepted and persisted
  // -------------------------------------------------------------------------
  it('records card payment and closes order', async () => {
    const { cisnik, table1, itemPivo } = fixtures;

    // pivo×2 = 5.00
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 2 },
    ]);

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'karta', amount: 5.00 });

    assert.equal(res.status, 201);
    assert.equal(res.body.payment.method, 'karta', 'response payment must show karta method');

    const [dbPayment] = await testDb
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, order.id));
    assert.equal(dbPayment.method, 'karta', 'DB payment record must persist karta method');

    const [dbOrder] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    assert.equal(dbOrder.status, 'closed');
  });

  // -------------------------------------------------------------------------
  // 8. Overpayment accepted — tendered amount stored as-is (change is external)
  // -------------------------------------------------------------------------
  it('accepts overpayment and stores the tendered amount', async () => {
    const { cisnik, table1, itemPivo } = fixtures;

    // pivo×1 = 2.50; customer tenders 5.00
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 5.00 });

    assert.equal(res.status, 201);

    const [dbPayment] = await testDb
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, order.id));
    assert.equal(parseFloat(dbPayment.amount), 5.00, 'tendered amount must be stored as-is');
  });

  // -------------------------------------------------------------------------
  // 9. Missing / invalid required fields return 400 (Zod validation layer)
  // -------------------------------------------------------------------------
  it('returns 400 when orderId is missing', async () => {
    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ method: 'hotovost', amount: 10.00 });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when method is missing', async () => {
    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: 1, amount: 10.00 });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when amount is missing', async () => {
    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: 1, method: 'hotovost' });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when method is an invalid enum value', async () => {
    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: 1, method: 'bitcoin', amount: 10.00 });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when amount is zero', async () => {
    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: 1, method: 'hotovost', amount: 0 });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('returns 400 when amount is negative', async () => {
    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: 1, method: 'hotovost', amount: -5 });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  // -------------------------------------------------------------------------
  // 10. Unauthenticated request returns 401
  // -------------------------------------------------------------------------
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request
      .post('/api/payments')
      .send({ orderId: 1, method: 'hotovost', amount: 10.00 });

    assert.equal(res.status, 401);
  });

  // -------------------------------------------------------------------------
  // 11. Audit event persisted in order_events
  // -------------------------------------------------------------------------
  it('persists a payment_received audit event with correct payload', async () => {
    const { cisnik, table1, itemPivo } = fixtures;

    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemPivo.id, qty: 1 },
    ]);

    await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 2.50 });

    const auditRows = await testDb
      .select()
      .from(schema.orderEvents)
      .where(and(
        eq(schema.orderEvents.orderId, order.id),
        eq(schema.orderEvents.type, 'payment_received')
      ));

    assert.equal(auditRows.length, 1, 'exactly one payment_received event must be written');
    const payload = JSON.parse(auditRows[0].payload);
    assert.equal(payload.method, 'hotovost');
    assert.equal(payload.amount, 2.50);
  });

  // -------------------------------------------------------------------------
  // 12. Floating-point tolerance boundary (±0.01)
  // -------------------------------------------------------------------------
  it('accepts amount within the 0.01 floating-point tolerance', async () => {
    const { cisnik, table1, itemTracked } = fixtures;

    // itemTracked = €5.00; tolerance allows down to 4.99 (5.00 - 0.01)
    // 4.995 > 4.99 → should be accepted
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemTracked.id, qty: 1 },
    ]);

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 4.995 });

    assert.equal(res.status, 201);
  });

  it('rejects amount that falls outside the 0.01 tolerance', async () => {
    const { cisnik, table1, itemTracked } = fixtures;

    // itemTracked = €5.00; 4.98 < 4.99 → must be rejected
    const order = await createOpenOrder(table1.id, cisnik.id, [
      { menuItemId: itemTracked.id, qty: 1 },
    ]);

    const res = await request
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 4.98 });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Suma platby/i);
  });
});

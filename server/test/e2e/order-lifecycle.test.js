import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../../app.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';

app.set('io', { emit: () => {} });

// ---------------------------------------------------------------------------
// Flow 1: Complete order lifecycle
// ---------------------------------------------------------------------------
describe('Flow 1: Complete order lifecycle', () => {
  let fixtures;
  let cisnikToken;
  let order;

  beforeEach(async () => {
    await truncateAll();
    fixtures = await seed();
    cisnikToken = tokens.cisnik();
  });

  it('creates order on table1 with burger(x2) + pivo(x1)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [
          { menuItemId: fixtures.itemBurger.id, qty: 2 },
          { menuItemId: fixtures.itemPivo.id, qty: 1 },
        ],
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.tableId, fixtures.table1.id);
    assert.equal(res.body.status, 'open');
    order = res.body;
  });

  it('verifies table1.status becomes occupied after order creation', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [
          { menuItemId: fixtures.itemBurger.id, qty: 2 },
          { menuItemId: fixtures.itemPivo.id, qty: 1 },
        ],
      });
    assert.equal(createRes.status, 201);

    const [tableRow] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, fixtures.table1.id));

    assert.equal(tableRow.status, 'occupied');
  });

  it('sends order to kitchen and marks items as sent', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [
          { menuItemId: fixtures.itemBurger.id, qty: 2 },
          { menuItemId: fixtures.itemPivo.id, qty: 1 },
        ],
      });
    assert.equal(createRes.status, 201);
    order = createRes.body;

    const sendRes = await request(app)
      .post(`/api/orders/${order.id}/send`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({});

    assert.equal(sendRes.status, 200);
    assert.ok(Array.isArray(sendRes.body.markedItems));
    assert.equal(sendRes.body.markedItems.length, 2);

    const items = await testDb
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));

    for (const item of items) {
      assert.equal(item.sent, true, `item ${item.id} should be marked sent`);
    }
  });

  it('pays the order, closes order, and frees the table', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [
          { menuItemId: fixtures.itemBurger.id, qty: 2 },
          { menuItemId: fixtures.itemPivo.id, qty: 1 },
        ],
      });
    assert.equal(createRes.status, 201);
    order = createRes.body;

    // total = 2 * 8.50 + 1 * 2.50 = 19.50
    const payRes = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 19.50 });

    assert.equal(payRes.status, 201);
    assert.equal(payRes.body.order.status, 'closed');
    assert.equal(payRes.body.payment.orderId, order.id);
    assert.equal(parseFloat(payRes.body.payment.amount), 19.50);

    const [orderRow] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    assert.equal(orderRow.status, 'closed');

    const [tableRow] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, fixtures.table1.id));
    assert.equal(tableRow.status, 'free');
  });

  it('verifies payment record exists with correct amount', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [
          { menuItemId: fixtures.itemBurger.id, qty: 2 },
          { menuItemId: fixtures.itemPivo.id, qty: 1 },
        ],
      });
    assert.equal(createRes.status, 201);
    order = createRes.body;

    const payRes = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 19.50 });
    assert.equal(payRes.status, 201);

    const paymentRows = await testDb
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, order.id));

    assert.equal(paymentRows.length, 1);
    assert.equal(parseFloat(paymentRows[0].amount), 19.50);
    assert.equal(paymentRows[0].method, 'hotovost');
    assert.equal(paymentRows[0].orderId, order.id);
  });

  it('full lifecycle: create → send → pay → verify closed + free table + payment record', async () => {
    // Step 1: Create order
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [
          { menuItemId: fixtures.itemBurger.id, qty: 2 },
          { menuItemId: fixtures.itemPivo.id, qty: 1 },
        ],
      });
    assert.equal(createRes.status, 201);
    order = createRes.body;

    // Step 2: Verify table occupied
    const [tableAfterCreate] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, fixtures.table1.id));
    assert.equal(tableAfterCreate.status, 'occupied');

    // Step 3: Send to kitchen
    const sendRes = await request(app)
      .post(`/api/orders/${order.id}/send`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({});
    assert.equal(sendRes.status, 200);

    // Step 4: Verify all items are sent
    const items = await testDb
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));
    for (const item of items) {
      assert.equal(item.sent, true, `order item id=${item.id} must be sent`);
    }

    // Step 5: Pay (amount = 2*8.50 + 1*2.50 = 19.50)
    const payRes = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ orderId: order.id, method: 'karta', amount: 19.50 });
    assert.equal(payRes.status, 201);

    // Step 6: Verify order closed
    const [orderRow] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    assert.equal(orderRow.status, 'closed');
    assert.ok(orderRow.closedAt !== null);

    // Step 7: Verify table freed
    const [tableAfterPay] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, fixtures.table1.id));
    assert.equal(tableAfterPay.status, 'free');

    // Step 8: Verify payment record
    const paymentRows = await testDb
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, order.id));
    assert.equal(paymentRows.length, 1);
    assert.equal(parseFloat(paymentRows[0].amount), 19.50);
    assert.equal(paymentRows[0].method, 'karta');
  });
});

// ---------------------------------------------------------------------------
// Flow 2: Storno with stock return
// ---------------------------------------------------------------------------
describe('Flow 2: Storno with stock return', () => {
  let fixtures;
  let cisnikToken;
  let manazerToken;

  beforeEach(async () => {
    await truncateAll();
    fixtures = await seed();
    cisnikToken = tokens.cisnik();
    manazerToken = tokens.manazer();
  });

  it('full storno flow: create → send (stock deducted) → storno-write-off returnToStock=true (stock restored)', async () => {
    // Step 1: Create order with itemTracked x3 (stockQty starts at 10)
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemTracked.id, qty: 3 }],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;

    // Step 2: Send to kitchen — stock should be deducted to 7
    const sendRes = await request(app)
      .post(`/api/orders/${order.id}/send`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({});
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.body.markedItems.length, 1);

    const [miAfterSend] = await testDb
      .select()
      .from(schema.menuItems)
      .where(eq(schema.menuItems.id, fixtures.itemTracked.id));
    assert.equal(parseFloat(miAfterSend.stockQty), 7, 'stock should be 10 - 3 = 7 after send');

    // Step 3: Storno with returnToStock=true — stock should be returned to 10
    const stornoRes = await request(app)
      .post(`/api/orders/${order.id}/storno-write-off`)
      .set('Authorization', `Bearer ${manazerToken}`)
      .send({
        menuItemId: fixtures.itemTracked.id,
        qty: 3,
        reason: 'order_error',
        note: 'Mistake order',
        returnToStock: true,
      });
    assert.equal(stornoRes.status, 200);
    assert.equal(stornoRes.body.action, 'returned');
    assert.equal(stornoRes.body.menuItemId, fixtures.itemTracked.id);
    assert.equal(stornoRes.body.qty, 3);

    // Step 4: Verify stock restored to 10
    const [miAfterStorno] = await testDb
      .select()
      .from(schema.menuItems)
      .where(eq(schema.menuItems.id, fixtures.itemTracked.id));
    assert.equal(parseFloat(miAfterStorno.stockQty), 10, 'stock should be restored to 10');

    // Step 5: Close the order and verify it becomes 'closed'
    const closeRes = await request(app)
      .post(`/api/orders/${order.id}/close`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({});
    assert.equal(closeRes.status, 200);

    const [orderRow] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    assert.ok(
      orderRow.status === 'closed' || orderRow.status === 'storno',
      `order status should be closed or storno, got: ${orderRow.status}`
    );
  });

  it('storno with returnToStock=false creates a write-off record', async () => {
    // Create and send order
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemTracked.id, qty: 2 }],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;

    await request(app)
      .post(`/api/orders/${order.id}/send`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({});

    // Storno without returning to stock — food was made, it's a loss
    const stornoRes = await request(app)
      .post(`/api/orders/${order.id}/storno-write-off`)
      .set('Authorization', `Bearer ${manazerToken}`)
      .send({
        menuItemId: fixtures.itemTracked.id,
        qty: 2,
        reason: 'complaint',
        note: 'Customer unhappy',
        returnToStock: false,
      });
    assert.equal(stornoRes.status, 200);
    assert.equal(stornoRes.body.action, 'write_off');
    assert.ok(stornoRes.body.writeOffId, 'writeOffId should be set');
    assert.ok(typeof stornoRes.body.totalCost === 'number', 'totalCost should be a number');

    // Verify write-off record created in DB
    const woRows = await testDb
      .select()
      .from(schema.writeOffs)
      .where(eq(schema.writeOffs.id, stornoRes.body.writeOffId));
    assert.equal(woRows.length, 1);
    assert.equal(woRows[0].status, 'approved');
    assert.ok(woRows[0].note.includes('POS storno'));

    // Stock is NOT returned when returnToStock=false
    const [miAfter] = await testDb
      .select()
      .from(schema.menuItems)
      .where(eq(schema.menuItems.id, fixtures.itemTracked.id));
    assert.equal(parseFloat(miAfter.stockQty), 8, 'stock should remain at 8 (10 - 2 sent, not returned)');
  });

  it('storno-write-off rejects missing menuItemId', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemTracked.id, qty: 1 }],
      });
    const order = createRes.body;

    const res = await request(app)
      .post(`/api/orders/${order.id}/storno-write-off`)
      .set('Authorization', `Bearer ${manazerToken}`)
      .send({ qty: 1, returnToStock: true });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('storno-write-off rejects qty <= 0', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemTracked.id, qty: 1 }],
      });
    const order = createRes.body;

    const res = await request(app)
      .post(`/api/orders/${order.id}/storno-write-off`)
      .set('Authorization', `Bearer ${manazerToken}`)
      .send({ menuItemId: fixtures.itemTracked.id, qty: 0, returnToStock: true });

    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });
});

// ---------------------------------------------------------------------------
// Flow 3: Split and pay
// ---------------------------------------------------------------------------
describe('Flow 3: Split and pay', () => {
  let fixtures;
  let cisnikToken;

  beforeEach(async () => {
    await truncateAll();
    fixtures = await seed();
    cisnikToken = tokens.cisnik();
  });

  it('splits order into 2 parts, verifies 2 new orders exist', async () => {
    // Create order with burger(x2) + pivo(x3) = 5 items total
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [
          { menuItemId: fixtures.itemBurger.id, qty: 2 },
          { menuItemId: fixtures.itemPivo.id, qty: 3 },
        ],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;

    // Split into 2 parts
    const splitRes = await request(app)
      .post(`/api/orders/${order.id}/split`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ parts: 2 });

    assert.equal(splitRes.status, 200);
    assert.ok(Array.isArray(splitRes.body.newOrderIds));
    assert.equal(splitRes.body.newOrderIds.length, 2);

    // Original order should be deleted; 2 new orders must exist and be open
    for (const newId of splitRes.body.newOrderIds) {
      const [newOrder] = await testDb
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, newId));
      assert.ok(newOrder, `new order id=${newId} must exist`);
      assert.equal(newOrder.status, 'open');
      assert.equal(newOrder.tableId, fixtures.table1.id);

      const items = await testDb
        .select()
        .from(schema.orderItems)
        .where(eq(schema.orderItems.orderId, newId));
      assert.ok(items.length > 0, `new order id=${newId} must have items`);
    }

    // Original order should be gone
    const [originalOrder] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    assert.equal(originalOrder, undefined, 'original order should have been deleted after equal split');
  });

  it('table stays occupied after paying first split order, freed after paying second', async () => {
    // Create order with 2 item types (one row each)
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [
          { menuItemId: fixtures.itemBurger.id, qty: 2 },
          { menuItemId: fixtures.itemPivo.id, qty: 3 },
        ],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;

    // Split into 2
    const splitRes = await request(app)
      .post(`/api/orders/${order.id}/split`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ parts: 2 });
    assert.equal(splitRes.status, 200);

    const [orderId1, orderId2] = splitRes.body.newOrderIds;

    // Calculate total for each split order
    const calcTotal = async (orderId) => {
      const rows = await testDb
        .select({
          qty: schema.orderItems.qty,
          price: schema.menuItems.price,
        })
        .from(schema.orderItems)
        .innerJoin(schema.menuItems, eq(schema.orderItems.menuItemId, schema.menuItems.id))
        .where(eq(schema.orderItems.orderId, orderId));
      return rows.reduce((sum, r) => sum + parseFloat(r.price) * r.qty, 0);
    };

    const total1 = Math.round((await calcTotal(orderId1)) * 100) / 100;

    // Pay first split order
    const pay1Res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ orderId: orderId1, method: 'hotovost', amount: total1 });
    assert.equal(pay1Res.status, 201);

    // Table must still be occupied (second order still open)
    const [tableAfterFirst] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, fixtures.table1.id));
    assert.equal(tableAfterFirst.status, 'occupied', 'table should still be occupied after first payment');

    const total2 = Math.round((await calcTotal(orderId2)) * 100) / 100;

    // Pay second split order
    const pay2Res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ orderId: orderId2, method: 'hotovost', amount: total2 });
    assert.equal(pay2Res.status, 201);

    // Table must now be free
    const [tableAfterSecond] = await testDb
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, fixtures.table1.id));
    assert.equal(tableAfterSecond.status, 'free', 'table should be free after both split orders paid');
  });

  it('cannot split a non-existent order', async () => {
    const res = await request(app)
      .post('/api/orders/999999/split')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ parts: 2 });

    assert.equal(res.status, 404);
  });

  it('cannot split a closed order', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemBurger.id, qty: 1 }],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;

    // Close the order
    await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ orderId: order.id, method: 'hotovost', amount: 8.50 });

    const splitRes = await request(app)
      .post(`/api/orders/${order.id}/split`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ parts: 2 });

    assert.equal(splitRes.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Flow 4: Version conflict
// ---------------------------------------------------------------------------
describe('Flow 4: Version conflict', () => {
  let fixtures;
  let cisnikToken;

  beforeEach(async () => {
    await truncateAll();
    fixtures = await seed();
    cisnikToken = tokens.cisnik();
  });

  it('adding items with stale version returns 409 conflict', async () => {
    // Step 1: Create order
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemBurger.id, qty: 1 }],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;
    const initialVersion = order.version;

    // Step 2: First add-items bumps the version
    const add1Res = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        items: [{ menuItemId: fixtures.itemPivo.id, qty: 1 }],
        version: initialVersion,
      });
    assert.equal(add1Res.status, 201);

    // Step 3: Add more items with the same (now stale) version — must get 409
    const conflictRes = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        items: [{ menuItemId: fixtures.itemPivo.id, qty: 1 }],
        version: initialVersion,
      });
    assert.equal(conflictRes.status, 409);
    assert.ok(conflictRes.body.error, 'conflict response should contain error message');
  });

  it('retrying with updated version succeeds after a conflict', async () => {
    // Create order
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemBurger.id, qty: 1 }],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;
    const initialVersion = order.version;

    // First add bumps version
    const add1Res = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        items: [{ menuItemId: fixtures.itemPivo.id, qty: 1 }],
        version: initialVersion,
      });
    assert.equal(add1Res.status, 201);

    // Confirm version was bumped in DB
    const [orderRow] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    const updatedVersion = orderRow.version;
    assert.ok(updatedVersion > initialVersion, 'version should have been incremented');

    // Retry with updated version — should succeed
    const retryRes = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        items: [{ menuItemId: fixtures.itemPivo.id, qty: 2 }],
        version: updatedVersion,
      });
    assert.equal(retryRes.status, 201);
    assert.ok(Array.isArray(retryRes.body));
    assert.equal(retryRes.body.length, 1);
    assert.equal(retryRes.body[0].menuItemId, fixtures.itemPivo.id);
    assert.equal(retryRes.body[0].qty, 2);
  });

  it('adding items without version field always succeeds (backwards-compatible)', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemBurger.id, qty: 1 }],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;

    // No version field — should bump unconditionally and succeed
    const add1Res = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ items: [{ menuItemId: fixtures.itemPivo.id, qty: 1 }] });
    assert.equal(add1Res.status, 201);

    // Second add without version — should also succeed
    const add2Res = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ items: [{ menuItemId: fixtures.itemPivo.id, qty: 1 }] });
    assert.equal(add2Res.status, 201);
  });

  it('updating item qty with stale version returns 409', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({
        tableId: fixtures.table1.id,
        items: [{ menuItemId: fixtures.itemBurger.id, qty: 1 }],
      });
    assert.equal(createRes.status, 201);
    const order = createRes.body;
    const initialVersion = order.version;

    // Get the item id
    const items = await testDb
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));
    const itemId = items[0].id;

    // First update bumps version
    const update1 = await request(app)
      .put(`/api/orders/${order.id}/items/${itemId}`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ qty: 2, version: initialVersion });
    assert.equal(update1.status, 200);

    // Second update with same stale version must conflict
    const update2 = await request(app)
      .put(`/api/orders/${order.id}/items/${itemId}`)
      .set('Authorization', `Bearer ${cisnikToken}`)
      .send({ qty: 3, version: initialVersion });
    assert.equal(update2.status, 409);
  });
});

// Single shared teardown — closes the DB pool once all describe blocks finish
after(async () => {
  await closeDb();
});

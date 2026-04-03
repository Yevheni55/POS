// DATABASE_URL must point to pos_test BEFORE Node starts, because db/index.js
// is a static ESM dependency of order-queries.js and its module body (which
// calls `new pg.Pool(...)`) runs before any top-level test-file code executes.
// dotenv does not override a pre-set env var, so the npm test scripts pass:
//   DATABASE_URL=postgresql://pos:pos@localhost:5432/pos_test node --test ...
// Verify: process.env.DATABASE_URL must end with '/pos_test' at this point.
if (!process.env.DATABASE_URL?.endsWith('/pos_test')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test. ' +
    'Use: npm test  (or npm run test:lib)\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import * as schema from '../../db/schema.js';

// Imported AFTER the env-var patch so that ../db/index.js picks up pos_test.
import { enrichOrders } from '../../lib/order-queries.js';

// ---------------------------------------------------------------------------
// All fixtures are created once in a single before() at the top level.
// Nested describe() blocks share these variables via closure.
// ---------------------------------------------------------------------------

let fixtures = {};
let orderA;        // burger×2 + pivo×1 on table1
let orderB;        // pivo×3 on table2
let orderDisc;     // burger×1 on table1 with a €0.85 discount
let orderEmpty;    // no items
let discountRow;

before(async () => {
  await truncateAll();
  fixtures = await seed();

  const { cisnik, table1, table2, itemBurger, itemPivo } = fixtures;

  // --- discount -----------------------------------------------------------
  [discountRow] = await testDb
    .insert(schema.discounts)
    .values({ name: '10% off', type: 'percent', value: '10.00' })
    .returning();

  // --- orderA: burger×2 + pivo×1 on table1 --------------------------------
  [orderA] = await testDb
    .insert(schema.orders)
    .values({ tableId: table1.id, staffId: cisnik.id, status: 'open', label: 'Ucet 1' })
    .returning();

  await testDb.insert(schema.orderItems).values([
    { orderId: orderA.id, menuItemId: itemBurger.id, qty: 2, note: '', sent: false },
    { orderId: orderA.id, menuItemId: itemPivo.id,   qty: 1, note: '', sent: false },
  ]);

  // --- orderB: pivo×3 on table2 -------------------------------------------
  [orderB] = await testDb
    .insert(schema.orders)
    .values({ tableId: table2.id, staffId: cisnik.id, status: 'open', label: 'Ucet 1' })
    .returning();

  await testDb.insert(schema.orderItems).values([
    { orderId: orderB.id, menuItemId: itemPivo.id, qty: 3, note: '', sent: false },
  ]);

  // --- orderDisc: burger×1 with a 10% discount (€0.85 pre-computed) -------
  [orderDisc] = await testDb
    .insert(schema.orders)
    .values({
      tableId: table1.id,
      staffId: cisnik.id,
      status: 'open',
      label: 'Ucet 2',
      discountId: discountRow.id,
      discountAmount: '0.85',   // €8.50 × 10% = €0.85
    })
    .returning();

  await testDb.insert(schema.orderItems).values([
    { orderId: orderDisc.id, menuItemId: itemBurger.id, qty: 1, note: '', sent: false },
  ]);

  // --- orderEmpty: no items -----------------------------------------------
  [orderEmpty] = await testDb
    .insert(schema.orders)
    .values({ tableId: table1.id, staffId: cisnik.id, status: 'open', label: 'Ucet 3' })
    .returning();
});

after(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichOrders()', () => {

  // ── edge cases ────────────────────────────────────────────────────────────

  describe('empty input array', () => {
    it('returns [] without querying the database', async () => {
      const result = await enrichOrders([]);
      assert.deepEqual(result, []);
    });
  });

  // ── single order ──────────────────────────────────────────────────────────

  describe('single order with two items (orderA)', () => {
    it('returns exactly one enriched order', async () => {
      const result = await enrichOrders([orderA]);
      assert.equal(result.length, 1);
      assert.equal(result[0].id, orderA.id);
    });

    it('attaches both items to the order', async () => {
      const [enriched] = await enrichOrders([orderA]);
      assert.equal(enriched.items.length, 2);
    });

    it('total equals sum of (price × qty) — burger×2 @8.50 + pivo×1 @2.50 = 19.50', async () => {
      const [enriched] = await enrichOrders([orderA]);
      assert.equal(+(enriched.total.toFixed(2)), 19.5);
    });

    it('totalAfterDiscount equals total when no discount is applied', async () => {
      const [enriched] = await enrichOrders([orderA]);
      assert.equal(enriched.totalAfterDiscount, enriched.total);
    });

    it('discount is null when no discount is applied', async () => {
      const [enriched] = await enrichOrders([orderA]);
      assert.equal(enriched.discount, null);
    });

    it('discountAmount is null when no discount is applied', async () => {
      const [enriched] = await enrichOrders([orderA]);
      assert.equal(enriched.discountAmount, null);
    });
  });

  // ── joined fields on items ────────────────────────────────────────────────

  describe('item fields from the menuItems JOIN', () => {
    it('each item price is a JS number (float), not a string', async () => {
      const [enriched] = await enrichOrders([orderA]);
      for (const item of enriched.items) {
        assert.equal(typeof item.price, 'number');
        assert.ok(!Number.isNaN(item.price));
      }
    });

    it('items include name from menuItems', async () => {
      const [enriched] = await enrichOrders([orderA]);
      const names = enriched.items.map(i => i.name).sort();
      assert.deepEqual(names, ['Burger', 'Pivo']);
    });

    it('items include emoji from menuItems', async () => {
      const [enriched] = await enrichOrders([orderA]);
      for (const item of enriched.items) {
        assert.equal(typeof item.emoji, 'string');
        assert.ok(item.emoji.length > 0);
      }
    });

    it('items include the correct qty', async () => {
      const [enriched] = await enrichOrders([orderA]);
      const byName = Object.fromEntries(enriched.items.map(i => [i.name, i.qty]));
      assert.equal(byName['Burger'], 2);
      assert.equal(byName['Pivo'], 1);
    });

    it('items include sent flag as a boolean', async () => {
      const [enriched] = await enrichOrders([orderA]);
      for (const item of enriched.items) {
        assert.equal(typeof item.sent, 'boolean');
      }
    });

    it('items include a note field (string)', async () => {
      const [enriched] = await enrichOrders([orderA]);
      for (const item of enriched.items) {
        assert.equal(typeof item.note, 'string');
      }
    });

    it('burger price parses to 8.5', async () => {
      const [enriched] = await enrichOrders([orderA]);
      const burger = enriched.items.find(i => i.name === 'Burger');
      assert.equal(burger.price, 8.5);
    });

    it('pivo price parses to 2.5', async () => {
      const [enriched] = await enrichOrders([orderA]);
      const pivo = enriched.items.find(i => i.name === 'Pivo');
      assert.equal(pivo.price, 2.5);
    });
  });

  // ── multiple orders ───────────────────────────────────────────────────────

  describe('multiple orders enriched together', () => {
    it('returns one enriched object per input order', async () => {
      const results = await enrichOrders([orderA, orderB]);
      assert.equal(results.length, 2);
    });

    it('each result is identified by the correct id', async () => {
      const results = await enrichOrders([orderA, orderB]);
      const ids = results.map(r => r.id);
      assert.ok(ids.includes(orderA.id));
      assert.ok(ids.includes(orderB.id));
    });

    it('orderB items do not include orderA items (no cross-contamination)', async () => {
      const results = await enrichOrders([orderA, orderB]);
      const enrichedB = results.find(r => r.id === orderB.id);
      assert.equal(enrichedB.items.length, 1);
      assert.equal(enrichedB.items[0].name, 'Pivo');
    });

    it('orderA items do not bleed into orderB', async () => {
      const results = await enrichOrders([orderA, orderB]);
      const enrichedA = results.find(r => r.id === orderA.id);
      assert.equal(enrichedA.items.length, 2);
      const names = enrichedA.items.map(i => i.name).sort();
      assert.deepEqual(names, ['Burger', 'Pivo']);
    });

    it('orderB total = pivo price(2.50) × qty(3) = 7.50', async () => {
      const results = await enrichOrders([orderA, orderB]);
      const enrichedB = results.find(r => r.id === orderB.id);
      assert.equal(+(enrichedB.total.toFixed(2)), 7.5);
    });
  });

  // ── discount ──────────────────────────────────────────────────────────────

  describe('order with a discount applied (orderDisc)', () => {
    it('discountAmount is parsed as a float', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      assert.equal(typeof enriched.discountAmount, 'number');
      assert.equal(+(enriched.discountAmount.toFixed(2)), 0.85);
    });

    it('totalAfterDiscount = total - discountAmount', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      const expected = +(enriched.total - enriched.discountAmount).toFixed(2);
      assert.equal(+(enriched.totalAfterDiscount.toFixed(2)), expected);
    });

    it('totalAfterDiscount is 7.65 (8.50 - 0.85)', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      assert.equal(+(enriched.totalAfterDiscount.toFixed(2)), 7.65);
    });

    it('discount object is present and is an object', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      assert.ok(enriched.discount !== null);
      assert.equal(typeof enriched.discount, 'object');
    });

    it('discount.id matches the inserted discount record', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      assert.equal(enriched.discount.id, discountRow.id);
    });

    it('discount.name is correct', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      assert.equal(enriched.discount.name, '10% off');
    });

    it('discount.type is correct', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      assert.equal(enriched.discount.type, 'percent');
    });

    it('discount.value is parsed as a float', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      assert.equal(typeof enriched.discount.value, 'number');
      assert.equal(enriched.discount.value, 10);
    });

    it('discount.amount equals the stored discountAmount on the order', async () => {
      const [enriched] = await enrichOrders([orderDisc]);
      assert.equal(enriched.discount.amount, enriched.discountAmount);
    });
  });

  // ── order with no items ───────────────────────────────────────────────────

  describe('order with zero items (orderEmpty)', () => {
    it('items property is an empty array, not undefined or null', async () => {
      const [enriched] = await enrichOrders([orderEmpty]);
      assert.ok(Array.isArray(enriched.items));
      assert.equal(enriched.items.length, 0);
    });

    it('total is 0', async () => {
      const [enriched] = await enrichOrders([orderEmpty]);
      assert.equal(enriched.total, 0);
    });

    it('totalAfterDiscount is 0', async () => {
      const [enriched] = await enrichOrders([orderEmpty]);
      assert.equal(enriched.totalAfterDiscount, 0);
    });
  });

  // ── original order fields are preserved ──────────────────────────────────

  describe('original order row fields pass through enrichment unchanged', () => {
    it('id, tableId, staffId, status, label survive', async () => {
      const [enriched] = await enrichOrders([orderA]);
      assert.equal(enriched.id,       orderA.id);
      assert.equal(enriched.tableId,  orderA.tableId);
      assert.equal(enriched.staffId,  orderA.staffId);
      assert.equal(enriched.status,   orderA.status);
      assert.equal(enriched.label,    orderA.label);
    });
  });
});

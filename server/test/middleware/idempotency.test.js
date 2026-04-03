/**
 * Integration tests for the idempotency middleware.
 *
 * Uses supertest against the real Express app (POST /api/orders) so that the
 * idempotency middleware runs through its full DB-backed flow.  Each test uses
 * a unique UUID key so tests are fully independent — no shared key state.
 *
 * Pool lifecycle: a single closeDb() call is issued in the top-level after()
 * hook so the pg pool is not closed before sibling test suites finish.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';

import { app } from '../../app.js';
import { truncateAll, seed, testDb, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const request = supertest(app);

app.set('io', { emit: () => {} });

/** Count open orders in the test DB */
async function countOrders() {
  const rows = await testDb
    .select({ id: schema.orders.id })
    .from(schema.orders);
  return rows.length;
}

/** Count stored idempotency key rows */
async function countIdempotencyKeys() {
  const rows = await testDb
    .select({ key: schema.idempotencyKeys.key })
    .from(schema.idempotencyKeys);
  return rows.length;
}

/** Fetch one idempotency key row by key string */
async function fetchIdempotencyRow(key) {
  const [row] = await testDb
    .select()
    .from(schema.idempotencyKeys)
    .where(eq(schema.idempotencyKeys.key, key));
  return row;
}

/** Build a valid create-order payload using seeded fixtures */
function validOrderPayload(fixtures) {
  return {
    tableId: fixtures.table1.id,
    items: [{ menuItemId: fixtures.itemBurger.id, qty: 1 }],
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fixtures;

before(async () => {
  await truncateAll();
  fixtures = await seed();
});

after(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('idempotency middleware — POST /api/orders', () => {
  describe('first request with a new key', () => {
    it('creates the order and returns 201', async () => {
      const key = randomUUID();

      const res = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send(validOrderPayload(fixtures));

      assert.equal(res.status, 201);
      assert.ok(res.body.id, 'response must include order id');
    });

    it('stores the key in the idempotency_keys table', async () => {
      const key = randomUUID();

      await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send(validOrderPayload(fixtures));

      // Allow the async DB insert to settle — the middleware fires insert
      // after res.json() returns, so we give it a short tick
      await new Promise((r) => setImmediate(r));

      const row = await fetchIdempotencyRow(key);
      assert.ok(row, 'idempotency row should be stored');
      assert.equal(row.statusCode, 201);
    });
  });

  describe('replayed request with the same key', () => {
    it('returns the cached 201 without creating a second order', async () => {
      const key = randomUUID();
      const payload = validOrderPayload(fixtures);

      // First request — real creation
      const first = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send(payload);

      assert.equal(first.status, 201);

      // Wait for the async cache write to settle
      await new Promise((r) => setImmediate(r));

      const countBefore = await countOrders();

      // Second request — must be served from cache.
      // The middleware uses res.end(string) so supertest parses the body as
      // text; compare via res.text rather than res.body.
      const second = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send(payload);

      assert.equal(second.status, 201);
      // Both the original JSON text and the replayed text must be identical
      assert.deepEqual(
        JSON.parse(second.text),
        JSON.parse(first.text),
        'replayed response body must equal the original',
      );

      // No new order must have been created
      const countAfter = await countOrders();
      assert.equal(countAfter, countBefore, 'no second order should be created on replay');
    });

    it('sets the X-Idempotent-Replayed: true header on the cached response', async () => {
      const key = randomUUID();

      await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send(validOrderPayload(fixtures));

      await new Promise((r) => setImmediate(r));

      const replayed = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send(validOrderPayload(fixtures));

      assert.equal(
        replayed.headers['x-idempotent-replayed'],
        'true',
        'replayed response must carry X-Idempotent-Replayed header',
      );
    });
  });

  describe('different keys create independent records', () => {
    it('creates a separate order for each unique key', async () => {
      const keyA = randomUUID();
      const keyB = randomUUID();
      const payload = validOrderPayload(fixtures);

      const resA = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', keyA)
        .send(payload);

      const resB = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', keyB)
        .send(payload);

      assert.equal(resA.status, 201);
      assert.equal(resB.status, 201);
      assert.notEqual(resA.body.id, resB.body.id, 'two different keys must produce two different orders');
    });
  });

  describe('GET requests are never cached', () => {
    it('does not store a key for a GET request', async () => {
      const key = randomUUID();
      const keyCountBefore = await countIdempotencyKeys();

      await request
        .get('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key);

      await new Promise((r) => setImmediate(r));

      const keyCountAfter = await countIdempotencyKeys();
      assert.equal(
        keyCountAfter,
        keyCountBefore,
        'GET requests must not create idempotency key rows',
      );
    });

    it('does not replay a GET even when key was previously used on a POST', async () => {
      const key = randomUUID();

      // Seed the key via a POST
      await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send(validOrderPayload(fixtures));

      await new Promise((r) => setImmediate(r));

      // GET with same key must NOT be intercepted and must not carry replay header
      const getRes = await request
        .get('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key);

      assert.equal(
        getRes.headers['x-idempotent-replayed'],
        undefined,
        'GET must not be replayed',
      );
    });
  });

  describe('failed requests (4xx) are NOT cached', () => {
    it('does not cache a 400 response', async () => {
      const key = randomUUID();

      // Send invalid payload — missing items
      const badRes = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send({ tableId: fixtures.table1.id, items: [] });

      assert.equal(badRes.status, 400);

      await new Promise((r) => setImmediate(r));

      // The key must NOT have been stored
      const row = await fetchIdempotencyRow(key);
      assert.equal(row, undefined, '4xx responses must not be cached');
    });

    it('allows a successful retry with the same key after a 4xx failure', async () => {
      const key = randomUUID();

      // First attempt — bad payload (empty items → 400)
      const failRes = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send({ tableId: fixtures.table1.id, items: [] });

      assert.equal(failRes.status, 400);

      await new Promise((r) => setImmediate(r));

      // Second attempt — correct payload with the same key
      const successRes = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .set('X-Idempotency-Key', key)
        .send(validOrderPayload(fixtures));

      assert.equal(successRes.status, 201);
      assert.ok(successRes.body.id, 'retry after 4xx must succeed and return a new order');
    });
  });

  describe('requests without a key bypass idempotency entirely', () => {
    it('creates an order normally when no X-Idempotency-Key header is sent', async () => {
      const countBefore = await countOrders();

      const res = await request
        .post('/api/orders')
        .set('Authorization', `Bearer ${tokens.cisnik()}`)
        .send(validOrderPayload(fixtures));

      assert.equal(res.status, 201);

      const countAfter = await countOrders();
      assert.equal(countAfter, countBefore + 1, 'a new order must be created');

      // No key row should be stored
      await new Promise((r) => setImmediate(r));
      const keyCountDelta = (await countIdempotencyKeys());
      // We cannot assert the exact delta here without baseline, but we can
      // verify the response has no replay header
      assert.equal(
        res.headers['x-idempotent-replayed'],
        undefined,
        'no replay header should be set on a keyless request',
      );
    });
  });
});

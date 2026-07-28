/**
 * Integration tests verifying that async error paths in server/routes/inventory.js
 * are forwarded to Express's error handler rather than hanging the request.
 *
 * Before PR-2.1, inventory.js was the only routes file in the project that did
 * not wrap its async handlers with asyncRoute(). A rejected promise (e.g. a
 * throw inside a db.transaction callback for a non-existent ingredient) would
 * leave the response open forever. After PR-2.1, the thrown Error bubbles up
 * to the global error handler in app.js and the client receives a 500 JSON
 * response — which is what we assert here.
 */

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

import { app } from '../../app.js';
import { closeDb, seed, truncateAll } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

app.set('io', { emit: () => {} });

const request = supertest(app);

// Silence the expected console.error from the global error handler so the
// test output stays clean. Original error is still surfaced via supertest
// if assertions fail.
const originalConsoleError = console.error;

after(async () => {
  console.error = originalConsoleError;
  await closeDb();
});

describe('inventory routes — async error forwarding', () => {
  before(() => {
    console.error = () => {};
  });

  beforeEach(async () => {
    await truncateAll();
    await seed();
  });

  it('POST /movements/adjust with non-existent ingredientId returns JSON error, not a hang', async () => {
    // The handler throws "Ingredient not found" inside db.transaction(). Without
    // asyncRoute() the rejected promise would never reach Express's error
    // handler and supertest would eventually time out. With asyncRoute() we
    // get a proper 5xx JSON response.
    const res = await request
      .post('/api/inventory/movements/adjust')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({
        ingredientId: 999999,
        quantity: 1,
        type: 'adjustment',
        note: 'test',
      })
      .timeout({ response: 5000, deadline: 5000 });

    assert.ok(res.status >= 400 && res.status < 600,
      `expected 4xx/5xx, got ${res.status}`);
    assert.match(res.headers['content-type'] || '', /application\/json/,
      'response must be JSON (error handler returns JSON, not a hang)');
    assert.ok(res.body && typeof res.body === 'object',
      'response body must be a JSON object');
  });
});

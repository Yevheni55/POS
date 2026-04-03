import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { app } from '../../app.js';
import { truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

// ---------------------------------------------------------------------------
// Role-based access control integration tests
//
// Verifies that the requireRole middleware enforces correct access levels:
//   cisnik  — read-only POS operations
//   manazer — management write operations (menu, tables, inventory)
//   admin   — staff management plus all manazer permissions
// ---------------------------------------------------------------------------

const request = supertest(app);

let fixtures;

before(async () => {
  app.set('io', { emit: () => {} });
  await truncateAll();
  fixtures = await seed();
});

after(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Staff management — POST /api/staff (admin only)
// ---------------------------------------------------------------------------

describe('POST /api/staff — admin-only endpoint', () => {
  it('returns 403 when cisnik tries to create a staff member', async () => {
    const res = await request
      .post('/api/staff')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ name: 'New Worker', pin: '4321', role: 'cisnik' });

    assert.equal(res.status, 403);
    assert.ok(res.body.error, 'error field must be present');
  });

  it('returns 403 when manazer tries to create a staff member', async () => {
    const res = await request
      .post('/api/staff')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ name: 'New Worker', pin: '4321', role: 'cisnik' });

    assert.equal(res.status, 403);
  });

  it('returns 201 when admin creates a staff member with valid body', async () => {
    const res = await request
      .post('/api/staff')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ name: 'X', pin: '1234', role: 'cisnik' });

    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'X');
    assert.equal(res.body.role, 'cisnik');
    // PIN hash must never be returned
    assert.equal(res.body.pin, undefined);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request
      .post('/api/staff')
      .send({ name: 'X', pin: '1234', role: 'cisnik' });

    assert.equal(res.status, 401);
  });

  it('returns 400 when admin sends an invalid body (missing name)', async () => {
    const res = await request
      .post('/api/staff')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ pin: '1234', role: 'cisnik' });

    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Menu items — POST /api/menu/items (manazer/admin only)
// ---------------------------------------------------------------------------

describe('POST /api/menu/items — manazer/admin endpoint', () => {
  it('returns 403 when cisnik tries to create a menu item', async () => {
    const res = await request
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ categoryId: fixtures.catFood.id, name: 'Test', emoji: '🧪', price: 1 });

    assert.equal(res.status, 403);
    assert.ok(res.body.error);
  });

  it('returns 201 when manazer creates a menu item with valid body', async () => {
    const res = await request
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ categoryId: fixtures.catFood.id, name: 'Test', emoji: '🧪', price: 1 });

    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Test');
    assert.ok(res.body.id, 'created item must have an id');
  });

  it('returns 201 when admin creates a menu item', async () => {
    const res = await request
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ categoryId: fixtures.catFood.id, name: 'Admin Item', emoji: '🧪', price: 2 });

    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Admin Item');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request
      .post('/api/menu/items')
      .send({ categoryId: fixtures.catFood.id, name: 'Test', emoji: '🧪', price: 1 });

    assert.equal(res.status, 401);
  });

  it('returns 400 when manazer sends an invalid body (missing categoryId)', async () => {
    const res = await request
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ name: 'Test', emoji: '🧪', price: 1 });

    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Tables — DELETE /api/tables/:id (manazer/admin only)
// ---------------------------------------------------------------------------

describe('DELETE /api/tables/:id — manazer/admin endpoint', () => {
  it('returns 403 when cisnik tries to delete a table', async () => {
    const res = await request
      .delete(`/api/tables/${fixtures.table1.id}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 403);
    assert.ok(res.body.error);
  });

  it('returns 200 when manazer deletes an existing table', async () => {
    // Use table2 so table1 remains available for other tests
    const res = await request
      .delete(`/api/tables/${fixtures.table2.id}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request
      .delete(`/api/tables/${fixtures.table1.id}`);

    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Inventory ingredients — POST /api/inventory/ingredients (manazer/admin only)
// ---------------------------------------------------------------------------

describe('POST /api/inventory/ingredients — manazer/admin endpoint', () => {
  it('returns 403 when cisnik tries to create an ingredient', async () => {
    const res = await request
      .post('/api/inventory/ingredients')
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ name: 'Test Ing', unit: 'kg', type: 'ingredient' });

    assert.equal(res.status, 403);
    assert.ok(res.body.error);
  });

  it('returns 201 when manazer creates an ingredient with valid body', async () => {
    const res = await request
      .post('/api/inventory/ingredients')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ name: 'Test Ing', unit: 'kg', type: 'ingredient' });

    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Test Ing');
    assert.equal(res.body.unit, 'kg');
    assert.ok(res.body.id, 'created ingredient must have an id');
  });

  it('returns 201 when admin creates an ingredient', async () => {
    const res = await request
      .post('/api/inventory/ingredients')
      .set('Authorization', `Bearer ${tokens.admin()}`)
      .send({ name: 'Admin Ing', unit: 'l', type: 'ingredient' });

    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Admin Ing');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request
      .post('/api/inventory/ingredients')
      .send({ name: 'Test Ing', unit: 'kg', type: 'ingredient' });

    assert.equal(res.status, 401);
  });

  it('returns 400 when manazer sends an invalid unit value', async () => {
    const res = await request
      .post('/api/inventory/ingredients')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ name: 'Bad Ing', unit: 'ton', type: 'ingredient' });

    assert.equal(res.status, 400);
  });

  it('returns 400 when manazer sends an empty body', async () => {
    const res = await request
      .post('/api/inventory/ingredients')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});

    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: GET routes accessible to any authenticated user
// ---------------------------------------------------------------------------

describe('GET routes accessible to any authenticated role', () => {
  it('cisnik can GET /api/menu', async () => {
    const res = await request
      .get('/api/menu')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('cisnik can GET /api/tables', async () => {
    const res = await request
      .get('/api/tables')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('cisnik can GET /api/staff', async () => {
    const res = await request
      .get('/api/staff')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('unauthenticated request to a protected GET is rejected with 401', async () => {
    const res = await request
      .get('/api/menu');

    assert.equal(res.status, 401);
  });

  it('tampered/invalid token is rejected with 401', async () => {
    const res = await request
      .get('/api/tables')
      .set('Authorization', 'Bearer not.a.real.token');

    assert.equal(res.status, 401);
  });
});

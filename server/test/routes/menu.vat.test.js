if (!process.env.DATABASE_URL?.endsWith('/pos_test')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';

import { app } from '../../app.js';
import * as schema from '../../db/schema.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

app.set('io', { emit: () => {} });

const request = supertest(app);

after(async () => {
  await closeDb();
});

describe('menu VAT support', () => {
  beforeEach(async () => {
    await truncateAll();
    await seed();
  });

  it('returns vatRate for menu items', async () => {
    const res = await request
      .get('/api/menu')
      .set('Authorization', `Bearer ${tokens.cisnik()}`);

    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    const firstItem = res.body.flatMap((category) => category.items)[0];
    assert.equal(typeof firstItem.vatRate, 'number');
  });

  it('creates and updates menu item vatRate', async () => {
    const [category] = await testDb.select().from(schema.menuCategories).where(eq(schema.menuCategories.slug, 'jedlo'));

    const createRes = await request
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({
        categoryId: category.id,
        name: 'Soup',
        emoji: 'soup',
        price: 4.9,
        vatRate: 5,
        desc: 'Daily soup',
      });

    assert.equal(createRes.status, 201);
    assert.equal(Number(createRes.body.vatRate), 5);

    const updateRes = await request
      .put(`/api/menu/items/${createRes.body.id}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ vatRate: 23 });

    assert.equal(updateRes.status, 200);
    assert.equal(Number(updateRes.body.vatRate), 23);

    const [dbItem] = await testDb.select().from(schema.menuItems).where(eq(schema.menuItems.id, createRes.body.id));
    assert.equal(Number(dbItem.vatRate), 23);
  });

  it('infers vatRate from category when create payload omits it', async () => {
    const [category] = await testDb.select().from(schema.menuCategories).where(eq(schema.menuCategories.slug, 'jedlo'));

    const res = await request
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({
        categoryId: category.id,
        name: 'Soup',
        emoji: 'soup',
        price: 4.9,
        desc: 'Daily soup',
      });

    assert.equal(res.status, 201);
    assert.equal(Number(res.body.vatRate), 5);
  });

  it('rejects unsupported vatRate values', async () => {
    const [category] = await testDb.select().from(schema.menuCategories).where(eq(schema.menuCategories.slug, 'jedlo'));

    const res = await request
      .post('/api/menu/items')
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({
        categoryId: category.id,
        name: 'Unsupported VAT',
        emoji: 'food',
        price: 4.9,
        vatRate: 20,
        desc: 'Should fail',
      });

    assert.equal(res.status, 400);
  });
});

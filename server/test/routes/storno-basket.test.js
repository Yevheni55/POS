// Storno kôš — cesta, po ktorej sa rozhoduje, či sa stornovaná položka VRÁTI
// NA SKLAD alebo sa ODPÍŠE ako strata. Presne táto vetva rozhoduje o tom, či
// sedí sklad a či je strata vidieť v P&L, a nemala ani jeden test.
//
// Kryjeme:
//   - wasPrepared:false → suroviny sa vracajú na sklad (žiadny write-off),
//   - wasPrepared:true  → vzniká write-off, sklad sa nevracia,
//   - override manažéra prebije to, čo zadal čašník,
//   - druhý resolve toho istého riadku je 409 (žiadny dvojitý pohyb skladu),
//   - role gate: čašník nesmie riešiť kôš.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';

import { app } from '../../app.js';
import { truncateAll, seed, closeDb, testDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';

const request = supertest(app);

after(closeDb);

/** Suroviny + receptúra pre stock-tracked položku, nech je čo vracať/odpisovať. */
async function seedRecipeFor(menuItemId) {
  const [ing] = await testDb.insert(schema.ingredients).values({
    name: 'Testovacia surovina',
    unit: 'kg',
    currentQty: '10.000',
    minQty: '1.000',
    costPerUnit: '2.50',
  }).returning();

  await testDb.insert(schema.recipes).values({
    menuItemId,
    ingredientId: ing.id,
    qtyPerUnit: '0.200',
  });

  // Bez trackMode='recipe' by applyStornoStockResolution neurobil so skladom
  // NIČ (default je 'none') a test by potvrdzoval prázdnu operáciu.
  await testDb.update(schema.menuItems)
    .set({ trackMode: 'recipe' })
    .where(eq(schema.menuItems.id, menuItemId));

  return ing;
}

async function ingredientQty(id) {
  const [row] = await testDb.select().from(schema.ingredients).where(eq(schema.ingredients.id, id));
  return parseFloat(row.currentQty);
}

async function addBasketRow(fixtures, overrides = {}) {
  const res = await request
    .post('/api/storno-basket')
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .send({
      menuItemId: fixtures.itemBurger.id,
      qty: 2,
      name: 'Burger',
      unitPrice: 8.5,
      reason: 'order_error',
      note: '',
      wasPrepared: false,
      orderId: null,
      ...overrides,
    });
  assert.equal(res.status, 201, "zalozenie riadku v koši malo prejsť: " + JSON.stringify(res.body));
  return res.body;
}

describe('POST /api/storno-basket/:id/resolve — sklad vs odpis', () => {
  let fx;
  let ing;

  before(async () => { await truncateAll(); fx = await seed(); });
  beforeEach(async () => {
    await truncateAll();
    fx = await seed();
    ing = await seedRecipeFor(fx.itemBurger.id);
  });

  it('wasPrepared:false → suroviny sa VRÁTIA na sklad a nevzniká write-off', async () => {
    const before = await ingredientQty(ing.id);
    await addBasketRow(fx, { wasPrepared: false });

    const list = await request.get('/api/storno-basket')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(list.status, 200);
    const row = list.body.items[0];
    assert.ok(row, 'riadok musí byť v koši');

    const res = await request
      .post(`/api/storno-basket/${row.id}/resolve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.action, 'returned');

    // 2 ks × 0,200 kg = 0,400 kg späť na sklad
    const after = await ingredientQty(ing.id);
    assert.equal(Math.round((after - before) * 1000) / 1000, 0.4);

    const writeOffs = await testDb.select().from(schema.writeOffs);
    assert.equal(writeOffs.length, 0, 'pri vrátení na sklad nesmie vzniknúť odpis');
  });

  it('wasPrepared:true → vzniká write-off a sklad sa NEvracia', async () => {
    const before = await ingredientQty(ing.id);
    await addBasketRow(fx, { wasPrepared: true, reason: 'complaint' });

    const list = await request.get('/api/storno-basket')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    const row = list.body.items[0];

    const res = await request
      .post(`/api/storno-basket/${row.id}/resolve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(res.body.result.action, 'returned');

    const after = await ingredientQty(ing.id);
    assert.equal(after, before, 'pripravená položka sa na sklad nevracia');

    const writeOffs = await testDb.select().from(schema.writeOffs);
    assert.equal(writeOffs.length, 1, 'musí vzniknúť práve jeden odpis');
  });

  it('override manažéra prebije to, čo zadal čašník', async () => {
    const before = await ingredientQty(ing.id);
    // Čašník tvrdí "pripravené" (odpis), manažér to opraví na "nestihli sme".
    await addBasketRow(fx, { wasPrepared: true });

    const list = await request.get('/api/storno-basket')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    const row = list.body.items[0];

    const res = await request
      .post(`/api/storno-basket/${row.id}/resolve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ override: { wasPrepared: false } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.action, 'returned');

    const after = await ingredientQty(ing.id);
    assert.equal(Math.round((after - before) * 1000) / 1000, 0.4);
  });

  it('druhý resolve toho istého riadku vráti 409 a sklad nepohne druhýkrát', async () => {
    await addBasketRow(fx, { wasPrepared: false });
    const list = await request.get('/api/storno-basket')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    const row = list.body.items[0];

    const first = await request
      .post(`/api/storno-basket/${row.id}/resolve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});
    assert.equal(first.status, 200);
    const afterFirst = await ingredientQty(ing.id);

    const second = await request
      .post(`/api/storno-basket/${row.id}/resolve`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({});
    assert.equal(second.status, 409, 'druhé spracovanie musí byť odmietnuté');

    const afterSecond = await ingredientQty(ing.id);
    assert.equal(afterSecond, afterFirst, 'sklad sa nesmie pohnúť druhýkrát');
  });

  it('čašník nesmie riešiť storno kôš (403)', async () => {
    await addBasketRow(fx, { wasPrepared: false });
    const list = await request.get('/api/storno-basket')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    const row = list.body.items[0];
    const before = await ingredientQty(ing.id);

    const res = await request
      .post(`/api/storno-basket/${row.id}/resolve`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({});
    assert.equal(res.status, 403);

    const after = await ingredientQty(ing.id);
    assert.equal(after, before, 'odmietnutá požiadavka nesmie pohnúť skladom');
  });
});

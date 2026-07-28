// Manažérska elevácia pri storne UŽ ODOSLANEJ položky.
//
// Server od 2026-07 vyžaduje na storno odoslaného riadku buď rolu
// manazer/admin, alebo krátkodobý elevačný token z /auth/verify-manager
// (hlavička `X-Manager-Token`). Dovtedy PIN kontroloval iba klient, takže
// čašník vedel odoslanú položku zmazať priamym API volaním úplne bez PINu.
//
// Testy tu kryjú OBE strany brány — a hlavne tú ÚSPEŠNÚ:
//   403 bez elevácie  (aby diera nezostala otvorená)
//   200 s eláciou     (aby po zadaní správneho PINu čašník neostal zaseknutý)
// Druhý prípad je dôležitejší: server-only nasadenie brány bez klientskej
// časti znamenalo, že čašník po SPRÁVNOM PINe dostal 403, položka mu zmizla
// lokálne (klient je optimistic-local-first) a na serveri zostala — teda
// rozchod POS vs. server priamo počas obsluhy.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';

import { app } from '../../app.js';
import { truncateAll, seed, testDb, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';
import * as schema from '../../db/schema.js';

const request = supertest(app);
app.set('io', { emit: () => {} });
after(closeDb);

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

/** Token, aký razí /auth/verify-manager do už prihlásenej čašníckej session. */
function elevationToken(fx) {
  return jwt.sign(
    { id: fx.manazer.id, name: fx.manazer.name, role: 'manazer' },
    JWT_SECRET,
    { expiresIn: '120s', algorithm: 'HS256' }
  );
}

async function orderWithSentItem(fx) {
  const created = await request
    .post('/api/orders')
    .set('Authorization', `Bearer ${tokens.cisnik()}`)
    .send({ tableId: fx.table1.id, items: [{ menuItemId: fx.itemPivo.id, qty: 3, note: '' }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const orderId = created.body.id;
  // Označ položku ako odoslanú priamo v DB — /send by navyše ťahal sklad
  // a tlač, čo pre túto bránu nie je podstatné.
  await testDb.update(schema.orderItems)
    .set({ sent: true })
    .where(eq(schema.orderItems.orderId, orderId));

  const [item] = await testDb.select().from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, orderId));

  const [order] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  return { orderId, itemId: item.id, version: order.version };
}

async function itemStillThere(orderId, itemId) {
  const rows = await testDb.select().from(schema.orderItems)
    .where(and(eq(schema.orderItems.id, itemId), eq(schema.orderItems.orderId, orderId)));
  return rows.length === 1 ? rows[0] : null;
}

describe('Storno odoslanej položky — manažérska elevácia', () => {
  let fx;
  before(async () => { await truncateAll(); fx = await seed(); });
  beforeEach(async () => { await truncateAll(); fx = await seed(); });

  it('DELETE bez elevácie → 403 a položka zostáva na účte', async () => {
    const { orderId, itemId, version } = await orderWithSentItem(fx);

    const res = await request
      .delete(`/api/orders/${orderId}/items/${itemId}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ version });

    assert.equal(res.status, 403);
    assert.ok(await itemStillThere(orderId, itemId), 'odmietnutý storno nesmie položku zmazať');
  });

  it('DELETE s platným X-Manager-Token → 200 a položka je preč', async () => {
    const { orderId, itemId, version } = await orderWithSentItem(fx);

    const res = await request
      .delete(`/api/orders/${orderId}/items/${itemId}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .set('X-Manager-Token', elevationToken(fx))
      .send({ version });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await itemStillThere(orderId, itemId), null, 'po elevácii sa položka má zmazať');
  });

  it('PUT (zníženie množstva odoslanej položky) bez elevácie → 403, s eláciou → 200', async () => {
    const a = await orderWithSentItem(fx);
    const denied = await request
      .put(`/api/orders/${a.orderId}/items/${a.itemId}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .send({ qty: 1, version: a.version });
    assert.equal(denied.status, 403);
    const untouched = await itemStillThere(a.orderId, a.itemId);
    assert.equal(untouched.qty, 3, 'odmietnutá zmena nesmie zmeniť množstvo');

    const b = await orderWithSentItem(fx);
    const allowed = await request
      .put(`/api/orders/${b.orderId}/items/${b.itemId}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .set('X-Manager-Token', elevationToken(fx))
      .send({ qty: 1, version: b.version });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    const reduced = await itemStillThere(b.orderId, b.itemId);
    assert.equal(reduced.qty, 1);
  });

  it('manažér nepotrebuje žiadnu hlavičku navyše', async () => {
    const { orderId, itemId, version } = await orderWithSentItem(fx);

    const res = await request
      .delete(`/api/orders/${orderId}/items/${itemId}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`)
      .send({ version });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await itemStillThere(orderId, itemId), null);
  });

  it('expirovaný elevačný token neprejde', async () => {
    const { orderId, itemId, version } = await orderWithSentItem(fx);
    const expired = jwt.sign(
      { id: fx.manazer.id, name: fx.manazer.name, role: 'manazer' },
      JWT_SECRET,
      { expiresIn: '-10s', algorithm: 'HS256' }
    );

    const res = await request
      .delete(`/api/orders/${orderId}/items/${itemId}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .set('X-Manager-Token', expired)
      .send({ version });

    assert.equal(res.status, 403);
    assert.ok(await itemStillThere(orderId, itemId));
  });

  it('token s rolou cisnik sa za eleváciu nepovažuje', async () => {
    const { orderId, itemId, version } = await orderWithSentItem(fx);
    const notManager = jwt.sign(
      { id: fx.cisnik.id, name: fx.cisnik.name, role: 'cisnik' },
      JWT_SECRET,
      { expiresIn: '120s', algorithm: 'HS256' }
    );

    const res = await request
      .delete(`/api/orders/${orderId}/items/${itemId}`)
      .set('Authorization', `Bearer ${tokens.cisnik()}`)
      .set('X-Manager-Token', notManager)
      .send({ version });

    assert.equal(res.status, 403);
    assert.ok(await itemStillThere(orderId, itemId));
  });
});

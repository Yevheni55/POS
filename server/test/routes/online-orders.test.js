// Online objednávky: verejné vytvorenie (ceny z DB), potvrdenie obsluhou
// (POS účet na stole Rozvoz + kuriér v mock režime), odmietnutie, webhook.
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Tests must run with DATABASE_URL pointing to pos_test. Current: ' + process.env.DATABASE_URL);
}

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';

import { app } from '../../app.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import * as schema from '../../db/schema.js';
import { tokens } from '../helpers/auth.js';

const { onlineOrders, onlineOrderEvents, orders, orderItems, tables, zones, menuItems } = schema;
const request = supertest(app);

let ctx;
before(async () => {
  app.set('io', { emit: () => {} });
  process.env.WOLT_DRIVE_MODE = 'mock';
  process.env.WOLT_CASH_ON_DELIVERY = '1';
  process.env.WOLT_WEBHOOK_SECRET = 'test-secret';
  process.env.WOLT_ORDER_MODE = 'mock';
});
after(async () => { await closeDb(); });

async function seedDelivery() {
  await truncateAll();
  ctx = await seed();
  await testDb.insert(zones).values({ slug: 'rozvoz', label: 'Rozvoz', sortOrder: 90 }).onConflictDoNothing();
  await testDb.insert(tables).values([{ name: 'Rozvoz 1', seats: 0, zone: 'rozvoz' }, { name: 'Rozvoz 2', seats: 0, zone: 'rozvoz' }]);
  const items = await testDb.select().from(menuItems);
  return items;
}

function validBody(items) {
  return {
    customer: { name: 'Jana Nová', phone: '+421 900 111 222', email: '' },
    dropoff: { street: 'Tematínska 5', city: 'Bratislava', postCode: '851 05', comment: '' },
    items: [{ menuItemId: items[0].id, qty: 2 }, { menuItemId: items[1].id, qty: 1 }],
    note: 'bez cibule', paymentMethod: 'cash', consent: true,
  };
}

describe('online objednávky', () => {
  let items;
  beforeEach(async () => { items = await seedDelivery(); });

  it('GET /api/public/online-orders/config hlási režim a platby', async () => {
    const res = await request.get('/api/public/online-orders/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.deliveryEnabled, true);
    assert.deepEqual(res.body.paymentMethods, ['cash', 'transfer']);
  });

  it('POST /quote vráti cenu a čas doručenia', async () => {
    const res = await request.post('/api/public/online-orders/quote').send({ street: 'Tematínska 5', city: 'Bratislava', postCode: '851 05' });
    assert.equal(res.status, 200);
    assert.equal(res.body.feeEur, 2.9);
    assert.ok(res.body.promiseId);
  });

  it('POST / vytvorí objednávku s cenami z DB, nie z klienta', async () => {
    const body = validBody(items);
    body.items[0].unitPrice = 0.01; // pokus o podvrh — ignoruje sa (schéma neznáme polia zahodí)
    const res = await request.post('/api/public/online-orders').send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.code, /^SS-[A-Z2-9]{5}$/);
    const expected = Math.round((Number(items[0].price) * 2 + Number(items[1].price)) * 100) / 100;
    assert.equal(res.body.subtotal, expected);
    assert.equal(res.body.deliveryFee, 2.9);
    assert.equal(res.body.total, Math.round((expected + 2.9) * 100) / 100);

    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, res.body.code));
    assert.equal(row.status, 'new');
    assert.equal(row.items[0].name, items[0].name);
    assert.equal(row.items[0].unitPrice, Number(items[0].price));

    // verejný stav podľa kódu
    const st = await request.get('/api/public/online-orders/' + res.body.code);
    assert.equal(st.status, 200);
    assert.equal(st.body.status, 'new');
    assert.equal(st.body.items.length, 2);
  });

  it('POST / odmietne neaktívnu položku, prázdny košík a chýbajúci súhlas', async () => {
    await testDb.update(menuItems).set({ active: false }).where(eq(menuItems.id, items[0].id));
    const r1 = await request.post('/api/public/online-orders').send(validBody(items));
    assert.equal(r1.status, 400);
    assert.deepEqual(r1.body.missingIds, [items[0].id]);
    const r2 = await request.post('/api/public/online-orders').send({ ...validBody(items), items: [] });
    assert.equal(r2.status, 400);
    const r3 = await request.post('/api/public/online-orders').send({ ...validBody(items), consent: false });
    assert.equal(r3.status, 400);
  });

  it('confirm: POS účet na stole Rozvoz, položky odoslané, kuriér (mock) objednaný', async () => {
    const created = await request.post('/api/public/online-orders').send(validBody(items));
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, created.body.code));

    const noAuth = await request.post('/api/online-orders/' + row.id + '/confirm');
    assert.equal(noAuth.status, 401);

    const res = await request.post('/api/online-orders/' + row.id + '/confirm').set('Authorization', 'Bearer ' + tokens.manazer());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.order.status, 'dispatched');
    assert.equal(res.body.order.woltOrderReferenceId, 'mock-' + created.body.code);

    const [pos] = await testDb.select().from(orders).where(eq(orders.id, res.body.order.posOrderId));
    assert.equal(pos.status, 'open');
    assert.equal(pos.label, 'Rozvoz ' + created.body.code);
    const posItems = await testDb.select().from(orderItems).where(eq(orderItems.orderId, pos.id));
    assert.equal(posItems.length, 2);
    assert.ok(posItems.every((i) => i.sent === true));
    const [tbl] = await testDb.select().from(tables).where(eq(tables.id, pos.tableId));
    assert.equal(tbl.zone, 'rozvoz');
    assert.equal(tbl.status, 'occupied');

    // druhýkrát sa potvrdiť nedá
    const again = await request.post('/api/online-orders/' + row.id + '/confirm').set('Authorization', 'Bearer ' + tokens.manazer());
    assert.equal(again.status, 409);

    // zoznam pre admin
    const list = await request.get('/api/online-orders?status=active').set('Authorization', 'Bearer ' + tokens.manazer());
    assert.equal(list.status, 200);
    assert.equal(list.body.rows.length, 1);
    assert.equal(list.body.counts.running, 1);
  });

  it('dve obrazovky naraz: prijatie prejde len jednému (jeden účet, jeden kuriér), minúty sa uložia', async () => {
    const created = await request.post('/api/public/online-orders').send(validBody(items));
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, created.body.code));
    const [a, b] = await Promise.all([
      request.post('/api/online-orders/' + row.id + '/confirm').set('Authorization', 'Bearer ' + tokens.cisnik()).send({ prepMinutes: 25 }),
      request.post('/api/online-orders/' + row.id + '/confirm').set('Authorization', 'Bearer ' + tokens.manazer()).send({ prepMinutes: 10 }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([a.body, b.body]));
    const loser = a.status === 409 ? a : b;
    assert.ok(loser.body.processing || /spracovaná/.test(loser.body.error), JSON.stringify(loser.body));
    const posOrders = await testDb.select().from(orders);
    assert.equal(posOrders.length, 1, 'presne jeden POS účet');
    const [after1] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, row.id));
    assert.equal(after1.status, 'dispatched');
    assert.ok([25, 10].includes(after1.prepMinutes));
    assert.ok(after1.promisedReadyAt);
    assert.equal(after1.processingAt, null, 'zámok sa po dokončení uvoľní');
    const evs = await testDb.select().from(onlineOrderEvents).where(eq(onlineOrderEvents.onlineOrderId, row.id));
    assert.equal(evs.filter((e) => e.type === 'confirmed').length, 1);
    assert.equal(evs.filter((e) => e.type === 'dispatched').length, 1);

    // ready dvakrát naraz → jedno OK, druhé alreadyReady / 409, nikdy chyba 500
    const [r1, r2] = await Promise.all([
      request.post('/api/online-orders/' + row.id + '/ready').set('Authorization', 'Bearer ' + tokens.cisnik()),
      request.post('/api/online-orders/' + row.id + '/ready').set('Authorization', 'Bearer ' + tokens.cisnik()),
    ]);
    assert.ok([r1.status, r2.status].every((s) => s === 200 || s === 409), JSON.stringify([r1.body, r2.body]));
    assert.ok([r1, r2].some((r) => r.status === 200 && !r.body.alreadyReady));
  });

  it('predobjednávka: potvrdenie na čas o 3 h = bez účtu (fire_at), /fire založí účet hneď; /reprint a /claim', async () => {
    const when = new Date(Date.now() + 3 * 3600_000).toISOString();
    const created = await request.post('/api/public/online-orders').send({ ...validBody(items), scheduledFor: when });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, created.body.code));
    const conf = await request.post('/api/online-orders/' + row.id + '/confirm').set('Authorization', 'Bearer ' + tokens.cisnik()).send({ prepMinutes: 20 });
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    assert.equal(conf.body.scheduled, true);
    let [after1] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, row.id));
    assert.equal(after1.status, 'confirmed');
    assert.equal(after1.posOrderId, null, 'účet až v čase fire_at');
    assert.equal(after1.firedAt, null);
    assert.equal(Math.round((new Date(when).getTime() - new Date(after1.fireAt).getTime()) / 60000), 35, 'fire_at = doručenie − 20 min príprava − 15 min');
    assert.equal((await testDb.select().from(orders)).length, 0);

    const fire = await request.post('/api/online-orders/' + row.id + '/fire').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(fire.status, 200, JSON.stringify(fire.body));
    [after1] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, row.id));
    assert.ok(after1.posOrderId);
    assert.ok(after1.firedAt);
    assert.equal(after1.status, 'dispatched');
    const again = await request.post('/api/online-orders/' + row.id + '/fire').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(again.status, 409, 'druhýkrát účet nevznikne');

    const rp = await request.post('/api/online-orders/' + row.id + '/reprint').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(rp.status, 200);
    assert.ok(['ok', 'queued'].includes(rp.body.bon));
    const cl = await request.patch('/api/online-orders/' + row.id + '/claim').set('Authorization', 'Bearer ' + tokens.manazer());
    assert.equal(cl.status, 200);
    [after1] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, row.id));
    assert.ok(after1.claimedBy);
    assert.ok(after1.claimedAt);
  });

  it('ready: kuchár (čašník) označí hotové; zákazník to vidí; len pri potvrdenej', async () => {
    const created = await request.post('/api/public/online-orders').send(validBody(items));
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, created.body.code));
    const early = await request.post('/api/online-orders/' + row.id + '/ready').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(early.status, 409);
    // kuchár smie potvrdiť aj označiť hotové
    const conf = await request.post('/api/online-orders/' + row.id + '/confirm').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    const ready = await request.post('/api/online-orders/' + row.id + '/ready').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(ready.status, 200);
    const pub = await request.get('/api/public/online-orders/' + created.body.code);
    assert.ok(pub.body.readyAt, 'readyAt musí byť vo verejnom stave');
    // zásah do kuriéra ostáva manažérovi
    const cancel = await request.post('/api/online-orders/' + row.id + '/cancel-delivery').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(cancel.status, 403);
  });

  it('čas doručenia: príliš skoro 400, platný sa uloží; Wolt dostane scheduled len nad hodinu', async () => {
    const soon = await request.post('/api/public/online-orders').send({ ...validBody(items), scheduledFor: new Date(Date.now() + 10 * 60000).toISOString() });
    assert.equal(soon.status, 400);
    const when = new Date(Date.now() + 3 * 3600000).toISOString();
    const ok = await request.post('/api/public/online-orders').send({ ...validBody(items), scheduledFor: when });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, ok.body.code));
    assert.equal(new Date(row.scheduledFor).toISOString(), when);
    const pub = await request.get('/api/public/online-orders/' + ok.body.code);
    assert.equal(new Date(pub.body.scheduledFor).toISOString(), when);
  });

  it('skúšobná objednávka z Woltu (mock): manažér ju vytvorí, kuchár prijme a označí hotové, simulované doručenie ju uzavrie', async () => {
    const forbidden = await request.post('/api/online-orders/wolt/mock-order').set('Authorization', 'Bearer ' + tokens.cisnik()).send({});
    assert.equal(forbidden.status, 403);
    const created = await request.post('/api/online-orders/wolt/mock-order').set('Authorization', 'Bearer ' + tokens.manazer()).send({ deliveryType: 'homedelivery' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const o = created.body.order;
    assert.equal(o.source, 'wolt');
    assert.match(o.publicCode, /^W-\d{4}$/);
    assert.equal(o.paymentMethod, 'wolt');
    assert.equal(o.deliveryType, 'homedelivery');
    assert.ok(o.items.some((i) => i.menuItemId) && o.items.some((i) => i.unmapped), 'namapované aj nenamapované položky');

    const conf = await request.post('/api/online-orders/' + o.id + '/confirm').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    assert.equal(conf.body.order.status, 'confirmed');
    assert.ok(conf.body.order.posOrderId, 'účet z namapovaných položiek');
    const [pos] = await testDb.select().from(orders).where(eq(orders.id, conf.body.order.posOrderId));
    assert.equal(pos.label, 'Wolt ' + o.publicCode);

    assert.equal((await request.post('/api/online-orders/' + o.id + '/ready').set('Authorization', 'Bearer ' + tokens.cisnik())).status, 200);
    const done = await request.post('/api/online-orders/' + o.id + '/wolt-mock-status').set('Authorization', 'Bearer ' + tokens.manazer()).send({ status: 'DELIVERED' });
    assert.equal(done.status, 200);
    assert.equal(done.body.order.status, 'delivered');
    assert.equal(done.body.order.woltStatus, 'delivered');
  });

  it('reject: len nová objednávka, bez POS účtu', async () => {
    const created = await request.post('/api/public/online-orders').send(validBody(items));
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, created.body.code));
    const res = await request.post('/api/online-orders/' + row.id + '/reject').set('Authorization', 'Bearer ' + tokens.admin()).send({ reason: 'Dnes už nevaríme' });
    assert.equal(res.status, 200);
    const [after1] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, row.id));
    assert.equal(after1.status, 'rejected');
    assert.equal(after1.rejectedReason, 'Dnes už nevaríme');
    assert.equal((await testDb.select().from(orders)).length, 0);
    const pub = await request.get('/api/public/online-orders/' + created.body.code);
    assert.equal(pub.body.rejectedReason, 'Dnes už nevaríme');
  });

  it('webhook: podpísaná udalosť order.delivered uzavrie objednávku, cudzí podpis 401', async () => {
    const created = await request.post('/api/public/online-orders').send(validBody(items));
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, created.body.code));
    await request.post('/api/online-orders/' + row.id + '/confirm').set('Authorization', 'Bearer ' + tokens.manazer());

    const bad = jwt.sign({ type: 'order.delivered', details: { merchant_order_reference_id: created.body.code } }, 'wrong', { algorithm: 'HS256' });
    assert.equal((await request.post('/api/public/online-orders/wolt/webhook').send({ token: bad })).status, 401);

    const good = jwt.sign({ type: 'order.delivered', details: { wolt_order_reference_id: 'mock-' + created.body.code, merchant_order_reference_id: created.body.code } }, 'test-secret', { algorithm: 'HS256' });
    const ok = await request.post('/api/public/online-orders/wolt/webhook').send({ token: good });
    assert.equal(ok.status, 200);
    const [after1] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, row.id));
    assert.equal(after1.status, 'delivered');
    assert.equal(after1.woltStatus, 'delivered');
    const evs = await testDb.select().from(onlineOrderEvents).where(eq(onlineOrderEvents.onlineOrderId, row.id));
    assert.ok(evs.some((e) => e.type === 'wolt:order.delivered'));
  });
});

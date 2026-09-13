// Iterácia 3: pauza príjmu (web + kasa + Wolt), Auto-prijímať cez strážcu,
// „dnes vypredané" po položke s návratom o 5:00.
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Tests must run with DATABASE_URL pointing to pos_test. Current: ' + process.env.DATABASE_URL);
}

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';

import { app } from '../../app.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import * as schema from '../../db/schema.js';
import { tokens } from '../helpers/auth.js';
import { watchdogTick, watchdogConfig } from '../../lib/online-orders-watchdog.js';
import { nextMorning } from '../../lib/app-settings.js';

const { onlineOrders, onlineOrderEvents, tables, zones, menuItems } = schema;
const request = supertest(app);
const TZ = 'Europe/Bratislava';
const local = (d) => new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(d));

let emitted = [];
const io = { emit: (ev, data) => emitted.push({ ev, data }) };

before(() => {
  app.set('io', io);
  process.env.WOLT_DRIVE_MODE = 'mock';
  process.env.WOLT_CASH_ON_DELIVERY = '1';
  process.env.WOLT_ORDER_MODE = 'mock';
});
after(async () => { await closeDb(); });

let items;
beforeEach(async () => {
  await truncateAll();
  await seed();
  await testDb.insert(zones).values({ slug: 'rozvoz', label: 'Rozvoz', sortOrder: 90 }).onConflictDoNothing();
  await testDb.insert(tables).values([{ name: 'Rozvoz 1', seats: 0, zone: 'rozvoz' }, { name: 'Rozvoz 2', seats: 0, zone: 'rozvoz' }]);
  items = await testDb.select().from(menuItems);
  emitted = [];
});

function validBody() {
  return {
    customer: { name: 'Jana Nová', phone: '+421 900 111 222', email: '' },
    dropoff: { street: 'Tematínska 5', city: 'Bratislava', postCode: '851 05', comment: '' },
    items: [{ menuItemId: items[0].id, qty: 2 }, { menuItemId: items[1].id, qty: 1 }],
    note: '', paymentMethod: 'cash', consent: true,
  };
}
const mgr = () => 'Bearer ' + tokens.manazer();

describe('pauza príjmu', () => {
  it('čašník nesmie, manažér pozastaví na 30 min: web aj kasa odmietnu, po obnovení berú', async () => {
    assert.equal((await request.post('/api/online-orders/pause').set('Authorization', 'Bearer ' + tokens.cisnik()).send({ minutes: 30 })).status, 403);
    assert.equal((await request.post('/api/online-orders/pause').set('Authorization', mgr()).send({ minutes: 3 })).status, 400, 'pod 5 minút nie');

    const r = await request.post('/api/online-orders/pause').set('Authorization', mgr()).send({ minutes: 30, reason: 'Preťažená kuchyňa' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Math.abs(new Date(r.body.pause.until).getTime() - (Date.now() + 30 * 60_000)) < 5000);
    assert.equal(r.body.pause.reason, 'Preťažená kuchyňa');
    assert.equal(r.body.wolt, 'mock', 'prevádzka vo Wolte OFFLINE (mock)');
    assert.ok(emitted.some((e) => e.ev === 'online-orders:pause' && e.data.until));

    const cfg = await request.get('/api/online-orders/config').set('Authorization', mgr());
    assert.equal(cfg.body.pause.reason, 'Preťažená kuchyňa');
    assert.deepEqual(cfg.body.autoAccept, { enabled: false, prepMinutes: 15 });

    const pub = await request.get('/api/public/online-orders/config');
    assert.equal(pub.body.deliveryEnabled, true);
    assert.equal(pub.body.acceptingOrders, false);
    assert.ok(pub.body.pausedUntil);
    assert.equal(pub.body.pauseReason, 'Preťažená kuchyňa');

    const blocked = await request.post('/api/public/online-orders').send(validBody());
    assert.equal(blocked.status, 503);
    assert.match(blocked.body.error, /neprijímame objednávky — skúste po \d\d:\d\d \(Preťažená kuchyňa\)/);

    const off = await request.delete('/api/online-orders/pause').set('Authorization', mgr());
    assert.equal(off.status, 200);
    assert.equal(off.body.pause, null);
    assert.equal(off.body.wolt, 'mock', 'prevádzka vo Wolte späť ONLINE');
    const ok = await request.post('/api/public/online-orders').send(validBody());
    assert.ok(ok.status < 300, JSON.stringify(ok.body));
    assert.equal((await request.get('/api/public/online-orders/config')).body.acceptingOrders, true);
  });

  it('do konca dňa = 23:59 v Bratislave', async () => {
    const r = await request.post('/api/online-orders/pause').set('Authorization', mgr()).send({ untilEndOfDay: true });
    assert.equal(r.status, 200);
    assert.equal(local(r.body.pause.until), '23:59');
  });
});

describe('Auto-prijímať', () => {
  it('manažér zapne s 20 min: strážca novú objednávku prijme sám (účet, bon, kuriér), bez eskalácie', async () => {
    const on = await request.post('/api/online-orders/auto-accept').set('Authorization', mgr()).send({ enabled: true, prepMinutes: 20 });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.autoAccept, { enabled: true, prepMinutes: 20 });
    assert.equal((await request.get('/api/online-orders/config').set('Authorization', mgr())).body.autoAccept.enabled, true);

    const created = await request.post('/api/public/online-orders').send(validBody());
    assert.ok(created.status < 300, JSON.stringify(created.body));
    const [made] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, created.body.code));
    const id = made.id;

    const cfg = { ...watchdogConfig(), level1S: 60, level2S: 120 };
    const r = await watchdogTick(io, cfg, new Date(Date.now() + 70_000));
    assert.equal(r.autoAccepted, 1, JSON.stringify(r.errors));
    assert.equal(r.escalated, 0, 'auto-prijaté sa neeskaluje');
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, id));
    assert.equal(row.status, 'dispatched', 'web: kuriér objednaný (mock)');
    assert.equal(row.prepMinutes, 20);
    assert.equal(row.confirmedBy, null, 'nikto z obsluhy — automat');
    assert.ok(row.posOrderId, 'účet vznikol');
    assert.equal(row.processingAt, null, 'zámok uvoľnený');
    const evs = await testDb.select().from(onlineOrderEvents).where(eq(onlineOrderEvents.onlineOrderId, id));
    assert.ok(evs.some((e) => e.type === 'confirmed' && e.payload.auto === true));

    // druhý prechod nič nespraví; po vypnutí sa nové objednávky nechajú obsluhe
    assert.equal((await watchdogTick(io, cfg, new Date())).autoAccepted, 0);
    await request.post('/api/online-orders/auto-accept').set('Authorization', mgr()).send({ enabled: false });
    const created2 = await request.post('/api/public/online-orders').send(validBody());
    const r2 = await watchdogTick(io, cfg, new Date());
    assert.equal(r2.autoAccepted, 0);
    const [row2] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, created2.body.code));
    assert.equal(row2.status, 'new');
  });
});

describe('dnes vypredané', () => {
  it('PUT /menu/items/:id {soldOut:true} platí do 5:00, verejné menu to ukáže, strážca po čase vráti', async () => {
    const id = items[0].id;
    const before = await request.get('/api/public/menu');
    assert.equal(before.status, 200);
    const find = (body) => body.menu.flatMap((c) => c.items).find((i) => i.id === id);
    assert.equal(find(before.body).soldOut, false);

    const r = await request.put('/api/menu/items/' + id).set('Authorization', mgr()).send({ soldOut: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.soldOutUntil, 'soldOutUntil v odpovedi');
    assert.equal(new Date(r.body.soldOutUntil).getTime(), nextMorning().getTime(), 'do najbližšieho rána 5:00');
    assert.equal(r.body.wolt, 'mock', 'položka vo Wolte vypnutá (mock)');
    assert.equal(r.body.active, true, 'nie je to skrytie položky');

    const during = await request.get('/api/public/menu');
    assert.equal(find(during.body).soldOut, true, 'cache verejného menu sa zneplatnila');

    // ráno: strážca vráti položku do ponuky
    await testDb.update(menuItems).set({ soldOutUntil: new Date(Date.now() - 1000) }).where(eq(menuItems.id, id));
    const t = await watchdogTick(io, { ...watchdogConfig() }, new Date());
    assert.equal(t.restocked, 1, JSON.stringify(t.errors));
    const [row] = await testDb.select().from(menuItems).where(eq(menuItems.id, id));
    assert.equal(row.soldOutUntil, null);
    assert.equal(find((await request.get('/api/public/menu')).body).soldOut, false);

    // ručne späť: soldOut:false
    await request.put('/api/menu/items/' + id).set('Authorization', mgr()).send({ soldOut: true });
    const back = await request.put('/api/menu/items/' + id).set('Authorization', mgr()).send({ soldOut: false });
    assert.equal(back.body.soldOutUntil, null);
  });
});

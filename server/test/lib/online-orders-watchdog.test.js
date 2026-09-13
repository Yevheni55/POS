// Strážca online objednávok: eskalácia (1 min KDS/kasa, 2 min Telegram),
// automatické odmietnutie pred termínom Woltu, odpálenie predobjednávok.
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Tests must run with DATABASE_URL pointing to pos_test. Current: ' + process.env.DATABASE_URL);
}

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { app } from '../../app.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import * as schema from '../../db/schema.js';
import { watchdogTick, watchdogConfig } from '../../lib/online-orders-watchdog.js';
import { _internals as alertsInternals } from '../../lib/alerts.js';

const { onlineOrders, onlineOrderEvents, orders, orderItems, tables, zones, menuItems } = schema;

let emitted = [], sent = [];
const io = { emit: (ev, data) => emitted.push({ ev, data }) };

before(() => {
  app.set('io', io);
  process.env.WOLT_DRIVE_MODE = 'mock';
  process.env.WOLT_ORDER_MODE = 'mock';
  process.env.ALERT_TELEGRAM_BOT_TOKEN = 'test-bot';
  process.env.ALERT_TELEGRAM_CHAT_ID = '42';
  alertsInternals.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; };
});
after(async () => {
  delete process.env.ALERT_TELEGRAM_BOT_TOKEN; delete process.env.ALERT_TELEGRAM_CHAT_ID;
  alertsInternals.fetch = (...a) => globalThis.fetch(...a);
  await closeDb();
});
beforeEach(async () => {
  await truncateAll();
  await seed();
  await testDb.insert(zones).values({ slug: 'rozvoz', label: 'Rozvoz', sortOrder: 90 }).onConflictDoNothing();
  await testDb.insert(tables).values([{ name: 'Rozvoz 1', seats: 0, zone: 'rozvoz' }]);
  emitted = []; sent = [];
});

async function insertOrder(over = {}) {
  const items = await testDb.select().from(menuItems);
  const unit = Number(items[0].price);
  const [row] = await testDb.insert(onlineOrders).values({
    publicCode: over.publicCode || 'SS-WD001', status: 'new', source: 'web',
    customerName: 'Jana Nová', customerPhone: '+421 900 111 222', dropoffStreet: 'Tematínska 5', dropoffCity: 'Bratislava', dropoffPostCode: '851 05',
    dropoffLat: '48.1122', dropoffLon: '17.1444',
    items: [{ menuItemId: items[0].id, name: items[0].name, qty: 2, unitPrice: unit, vatRate: 20, note: '' }],
    subtotal: String(unit * 2), deliveryFee: '2.90', total: String(unit * 2 + 2.9), paymentMethod: 'cash',
    woltPromiseId: 'mock-promise-old', woltPromiseValidUntil: new Date(Date.now() - 3600_000),
    updatedAt: new Date(), ...over,
  }).returning();
  return row;
}
const cfg = { ...watchdogConfig(), level1S: 60, level2S: 120 };

describe('strážca online objednávok', () => {
  it('eskalácia: po minúte úroveň 1 pre KDS/kasu, po dvoch úroveň 2 + správa manažérovi, nič sa neopakuje', async () => {
    const t0 = Date.now();
    const o = await insertOrder({ createdAt: new Date(t0 - 70_000) });
    let r = await watchdogTick(io, cfg, new Date(t0));
    assert.equal(r.escalated, 1);
    assert.equal(r.alerted, 0);
    assert.ok(emitted.some((e) => e.ev === 'online-order:alert' && e.data.id === o.id && e.data.level === 1));
    let [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, o.id));
    assert.equal(row.escalationLevel, 1);

    emitted = [];
    r = await watchdogTick(io, cfg, new Date(t0 + 10_000));
    assert.equal(r.escalated, 0, 'rovnaká úroveň sa neposiela znova');

    r = await watchdogTick(io, cfg, new Date(t0 + 60_000));
    assert.equal(r.escalated, 1);
    assert.equal(r.alerted, 1);
    assert.ok(emitted.some((e) => e.ev === 'online-order:alert' && e.data.level === 2));
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(sent.length, 1, 'jedna správa na Telegram');
    assert.match(sent[0].text, /SS-WD001/);
    assert.equal(sent[0].chat_id, '42');
    [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, o.id));
    assert.equal(row.escalationLevel, 2);
    const evs = await testDb.select().from(onlineOrderEvents).where(eq(onlineOrderEvents.onlineOrderId, o.id));
    assert.equal(evs.filter((e) => e.type === 'escalated').length, 2);
  });

  it('Wolt: 30 s pred termínom na prijatie strážca objednávku odmietne s dôvodom a dá vedieť', async () => {
    const now = Date.now();
    const o = await insertOrder({ publicCode: 'W-9001', source: 'wolt', woltOrderId: 'w-9001', paymentMethod: 'wolt', acceptDeadlineAt: new Date(now + 20_000) });
    const early = await watchdogTick(io, cfg, new Date(now - 60_000));
    assert.equal(early.autoRejected, 0, 'minútu pred termínom ešte nie');
    const r = await watchdogTick(io, cfg, new Date(now));
    assert.equal(r.autoRejected, 1);
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, o.id));
    assert.equal(row.status, 'rejected');
    assert.match(row.rejectedReason, /preťažená/);
    assert.equal(row.processingAt, null);
    assert.ok(emitted.some((e) => e.ev === 'online-order:updated' && e.data.status === 'rejected' && e.data.auto));
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(sent.some((m) => /W-9001/.test(m.text) && /odmietnutá/.test(m.text)));
  });

  it('predobjednávka: v čase fire_at vznikne účet, bon a kuriér (nový prísľub, starý expiroval)', async () => {
    const o = await insertOrder({ publicCode: 'SS-WD002', status: 'confirmed', confirmedAt: new Date(), prepMinutes: 15, scheduledFor: new Date(Date.now() + 30 * 60_000), fireAt: new Date(Date.now() - 1000) });
    const r = await watchdogTick(io, cfg, new Date());
    assert.equal(r.fired, 1, JSON.stringify(r.errors));
    const [row] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, o.id));
    assert.equal(row.status, 'dispatched', 'kuriér objednaný');
    assert.ok(row.posOrderId, 'účet vznikol');
    assert.ok(row.firedAt);
    assert.ok(['ok', 'queued'].includes(row.bonStatus), 'bon išiel (alebo je vo fronte): ' + row.bonStatus);
    assert.notEqual(row.woltPromiseId, 'mock-promise-old', 'expirovaný prísľub sa vymenil za nový');
    const [pos] = await testDb.select().from(orders).where(eq(orders.id, row.posOrderId));
    assert.equal(pos.label, 'Rozvoz SS-WD002');
    assert.equal((await testDb.select().from(orderItems).where(eq(orderItems.orderId, pos.id))).length, 1);
    // druhý prechod ju nevezme znova
    assert.equal((await watchdogTick(io, cfg, new Date())).fired, 0);
  });
});

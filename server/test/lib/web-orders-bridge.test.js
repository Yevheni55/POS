// Most web ↔ kasa cez Neon: „Neon" je tu ten istý testovací Postgres — tabuľky
// web_* sa vytvoria z server/db/neon/2026-09-12-web-orders.sql, PHP na
// Websupporte nahrádzajú priame INSERTy (rovnaké riadky, aké zapisuje
// web/objednavky-api.php).
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Tests must run with DATABASE_URL pointing to pos_test. Current: ' + process.env.DATABASE_URL);
}

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';

import { app } from '../../app.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import * as schema from '../../db/schema.js';
import { tokens } from '../helpers/auth.js';
import { createBridge, toLocalOrder } from '../../lib/web-orders-bridge.js';

const { onlineOrders, onlineOrderEvents, tables, zones, menuItems } = schema;
const request = supertest(app);
const NEON_URL = process.env.DATABASE_URL;

let pool, bridge, emitted = [];

before(async () => {
  process.env.WOLT_DRIVE_MODE = 'mock';
  process.env.WOLT_CASH_ON_DELIVERY = '1';
  app.set('io', { emit: () => {} });
  pool = new pg.Pool({ connectionString: NEON_URL });
  // guest_menu na Neon existuje dávno (číta ju api.php) — v teste ju vyrobíme.
  await pool.query(`CREATE TABLE IF NOT EXISTS guest_menu (
    id serial PRIMARY KEY, category_slug varchar, category_label varchar, category_icon varchar, category_sort varchar,
    item_name varchar, item_emoji varchar, item_price numeric, item_desc varchar, active boolean, updated_at timestamp DEFAULT now())`);
  await pool.query(fs.readFileSync(new URL('../../db/neon/2026-09-12-web-orders.sql', import.meta.url), 'utf8'));
  await pool.query(fs.readFileSync(new URL('../../db/neon/2026-09-13-wolt-order-events.sql', import.meta.url), 'utf8'));
  await pool.query(fs.readFileSync(new URL('../../db/neon/2026-09-14-wolt-events-attempts.sql', import.meta.url), 'utf8'));
  process.env.WOLT_ORDER_MODE = 'mock';
  bridge = createBridge({ url: NEON_URL, io: { emit: (ev, data) => emitted.push({ ev, data }) }, cacheBustUrl: '', log: () => {} });
});
after(async () => { await bridge.close(); await pool.end(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  await seed();
  await pool.query('TRUNCATE web_order_events, web_orders, web_promises, web_delivery_config, guest_menu, wolt_order_events RESTART IDENTITY CASCADE');
  await testDb.insert(zones).values({ slug: 'rozvoz', label: 'Rozvoz', sortOrder: 90 }).onConflictDoNothing();
  await testDb.insert(tables).values([{ name: 'Rozvoz 1', seats: 0, zone: 'rozvoz' }]);
  emitted.length = 0;
});

/** Riadok, aký zapisuje web/objednavky-api.php. */
async function insertWebOrder({ code = 'SS-WEB01', scheduledFor = null } = {}) {
  const items = await testDb.select().from(menuItems);
  const unit = Number(items[0].price);
  const lines = [{ menuItemId: items[0].id, name: items[0].name, qty: 2, unitPrice: unit, vatRate: 20, note: 'bez cibule' }];
  const subtotal = Math.round(unit * 2 * 100) / 100;
  const { rows } = await pool.query(`
    INSERT INTO web_orders (public_code, customer_name, customer_phone, dropoff_street, dropoff_city, dropoff_post_code,
      dropoff_lat, dropoff_lon, items, subtotal, delivery_fee, total, payment_method, note, scheduled_for, wolt_promise_id, client_ip)
    VALUES ($1, 'Jana Nová', '+421 900 111 222', 'Tematínska 5', 'Bratislava', '851 05', 48.1122, 17.1444, $2, $3, 2.90, $4, 'cash',
      'zvonček Nová', $5, 'mock-promise-1', '1.2.3.4')
    RETURNING *`, [code, JSON.stringify(lines), subtotal, Math.round((subtotal + 2.9) * 100) / 100, scheduledFor]);
  return { web: rows[0], item: items[0] };
}

describe('most web ↔ kasa', () => {
  it('nová objednávka z webu sa prevezme: online_orders + POS id späť + udalosť pre KDS + heartbeat konfigurácie', async () => {
    const when = new Date(Date.now() + 3 * 3600_000);
    const { web, item } = await insertWebOrder({ scheduledFor: when.toISOString() });

    const r = await bridge.tick();
    assert.equal(r.imported, 1);

    const [local] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, 'SS-WEB01'));
    assert.ok(local, 'lokálna objednávka musí vzniknúť');
    assert.equal(local.status, 'new');
    assert.equal(local.webOrderId, Number(web.id));
    assert.equal(local.items[0].menuItemId, item.id);
    assert.equal(local.items[0].note, 'bez cibule');
    assert.equal(Number(local.total), Number(web.total));
    assert.equal(local.paymentMethod, 'cash');
    assert.equal(Math.abs(new Date(local.scheduledFor).getTime() - when.getTime()) < 1000, true);
    assert.equal(local.dropoffCity, 'Bratislava');

    const { rows: [after] } = await pool.query('SELECT imported_at, pos_online_order_id FROM web_orders WHERE id = $1', [web.id]);
    assert.ok(after.imported_at);
    assert.equal(after.pos_online_order_id, local.id);

    assert.ok(emitted.some((e) => e.ev === 'online-order:new' && e.data.code === 'SS-WEB01'), 'KDS dostane online-order:new');
    const evs = await testDb.select().from(onlineOrderEvents).where(eq(onlineOrderEvents.onlineOrderId, local.id));
    assert.ok(evs.some((e) => e.type === 'created' && e.payload.source === 'web'));

    // druhý cyklus už nič neprevezme
    assert.equal((await bridge.tick()).imported, 0);

    // konfigurácia + heartbeat, podľa ktorých web vie, že doručenie beží
    const { rows: [cfg] } = await pool.query("SELECT value, updated_at FROM web_delivery_config WHERE key = 'config'");
    assert.equal(cfg.value.deliveryEnabled, true);
    assert.equal(cfg.value.mode, 'mock');
    assert.deepEqual(cfg.value.paymentMethods, ['cash', 'transfer']);
    assert.ok(Date.now() - new Date(cfg.updated_at).getTime() < 10_000);

    // v zozname pre KDS/admin je ako každá iná
    const list = await request.get('/api/online-orders?status=new').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(list.body.rows.length, 1);
    assert.equal(list.body.rows[0].publicCode, 'SS-WEB01');
  });

  it('potvrdenie a hotové na kase sa zapíšu späť na web; udalosť Woltu z webu uzavrie lokálnu kópiu', async () => {
    const { web } = await insertWebOrder();
    await bridge.tick();
    const [local] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, 'SS-WEB01'));

    const conf = await request.post('/api/online-orders/' + local.id + '/confirm').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    let r = await bridge.tick();
    assert.equal(r.pushed, 1);
    let { rows: [w] } = await pool.query('SELECT * FROM web_orders WHERE id = $1', [web.id]);
    assert.equal(w.status, 'dispatched');
    assert.equal(w.wolt_order_reference_id, 'mock-SS-WEB01');
    assert.ok(w.confirmed_at);
    assert.equal(w.ready_at, null);

    // bez zmeny sa nič neposiela znova
    assert.equal((await bridge.tick()).pushed, 0);

    const ready = await request.post('/api/online-orders/' + local.id + '/ready').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(ready.status, 200);
    await bridge.tick();
    ({ rows: [w] } = await pool.query('SELECT * FROM web_orders WHERE id = $1', [web.id]));
    assert.ok(w.ready_at, 'zákazník na webe uvidí Hotové');

    // Webhook Woltu prišiel na Websupport (PHP) → udalosť v Neon → kasa ju spracuje
    await pool.query("INSERT INTO web_order_events (web_order_id, type, payload) VALUES ($1, 'wolt:order.delivered', $2)",
      [web.id, JSON.stringify({ wolt_order_reference_id: 'mock-SS-WEB01', tracking: { url: 'https://track.wolt.com/x' } })]);
    r = await bridge.tick();
    assert.equal(r.events, 1);
    const [l2] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, local.id));
    assert.equal(l2.status, 'delivered');
    assert.equal(l2.woltStatus, 'delivered');
    assert.equal(l2.woltTrackingUrl, 'https://track.wolt.com/x');
    const evs = await testDb.select().from(onlineOrderEvents).where(eq(onlineOrderEvents.onlineOrderId, local.id));
    assert.ok(evs.some((e) => e.type === 'wolt:order.delivered'));
    assert.ok(emitted.some((e) => e.ev === 'online-order:updated' && e.data.status === 'delivered'));
    const { rows: [ev] } = await pool.query("SELECT processed_at FROM web_order_events WHERE type = 'wolt:order.delivered'");
    assert.ok(ev.processed_at, 'udalosť sa označí ako spracovaná');
    ({ rows: [w] } = await pool.query('SELECT status FROM web_orders WHERE id = $1', [web.id]));
    assert.equal(w.status, 'delivered');
  });

  it('odmietnutie na kase sa zapíše späť aj s dôvodom', async () => {
    const { web } = await insertWebOrder();
    await bridge.tick();
    const [local] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.publicCode, 'SS-WEB01'));
    await request.post('/api/online-orders/' + local.id + '/reject').set('Authorization', 'Bearer ' + tokens.cisnik()).send({ reason: 'Dnes už nevaríme' });
    await bridge.tick();
    const { rows: [w] } = await pool.query('SELECT status, rejected_reason FROM web_orders WHERE id = $1', [web.id]);
    assert.equal(w.status, 'rejected');
    assert.equal(w.rejected_reason, 'Dnes už nevaríme');
  });

  it('menu sa na web zapíše s id položiek z kasy; nezmenené menu sa znova neposiela', async () => {
    const r1 = await bridge.syncMenu();
    assert.equal(r1.changed, true);
    assert.ok(r1.count > 0);
    const { rows } = await pool.query('SELECT pos_item_id, item_name, item_price, active, category_slug FROM guest_menu ORDER BY id');
    const items = await testDb.select().from(menuItems);
    assert.equal(rows.length, r1.count);
    assert.ok(rows.every((r) => r.pos_item_id && r.active && items.some((i) => i.id === r.pos_item_id && i.name === r.item_name)));

    assert.equal((await bridge.syncMenu()).changed, false);

    await testDb.update(menuItems).set({ active: false }).where(eq(menuItems.id, rows[0].pos_item_id));
    const r3 = await bridge.syncMenu();
    assert.equal(r3.changed, true);
    assert.equal(r3.count, r1.count - 1);
  });

  it('objednávka z aplikácie Wolt: notifikácia → detail → online_orders (source wolt) → prijatie, hotové, doručené z Woltu', async () => {
    const items = await testDb.select().from(menuItems);
    const raw = {
      id: 'w-abc-1', order_number: '4471', order_status: 'received', type: 'instant',
      consumer_name: 'Marek K.', consumer_phone_number: '+421 900 555 666', consumer_comment: 'bez cibule',
      price: { amount: 1290 }, basket_price: { total: { amount: 990 } }, fees: { delivery: { amount: 300 } },
      delivery: { type: 'homedelivery', location: { street_address: 'Tematínska 5', city: 'Bratislava', post_code: '851 05', coordinates: { lat: 48.1, lon: 17.1 } } },
      pickup_eta: new Date(Date.now() + 25 * 60000).toISOString(), created_at: new Date().toISOString(),
      items: [
        { id: 'i1', name: items[0].name, count: 2, pos_id: String(items[0].id), item_price: { unit_price: { amount: Math.round(Number(items[0].price) * 100) } } },
        { id: 'i2', name: 'Položka mimo kasy', count: 1, pos_id: null, item_price: { unit_price: { amount: 130 } } },
      ],
    };
    const notify = (status, extra = {}) => pool.query(
      'INSERT INTO wolt_order_events (notification_id, type, wolt_order_id, status, resource_url, payload) VALUES ($1, $2, $3, $4, $5, $6)',
      ['n-' + status + '-' + Date.now(), 'order.notification', raw.id, status, 'https://pos-integration-service.development.dev.woltapi.com/orders/' + raw.id, JSON.stringify({ order: { id: raw.id, status }, ...extra })],
    );

    await notify('CREATED', { mock_order: raw });
    const r1 = await bridge.tick();
    assert.equal(r1.wolt, 1);
    const [local] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.woltOrderId, raw.id));
    assert.ok(local, 'lokálna objednávka z Woltu');
    assert.equal(local.source, 'wolt');
    assert.equal(local.publicCode, 'W-4471');
    assert.equal(local.status, 'new');
    assert.equal(local.paymentMethod, 'wolt');
    assert.equal(local.items[0].menuItemId, items[0].id);
    assert.equal(local.items[1].menuItemId, null);
    assert.match(local.note, /nenamapované/);
    assert.equal(Number(local.total), 12.9);
    assert.ok(local.woltPickupEta);
    assert.ok(emitted.some((e) => e.ev === 'online-order:new' && e.data.source === 'wolt' && e.data.code === 'W-4471'));
    const { rows: [ev1] } = await pool.query('SELECT processed_at FROM wolt_order_events ORDER BY id LIMIT 1');
    assert.ok(ev1.processed_at);
    // duplicitná notifikácia (Wolt opakuje) nič nezdvojí
    await notify('CREATED', { mock_order: raw });
    await bridge.tick();
    assert.equal((await testDb.select().from(onlineOrders).where(eq(onlineOrders.woltOrderId, raw.id))).length, 1);

    // prijatie na kase: mock accept vo Wolte + účet „Wolt W-4471" len z namapovaných položiek
    const conf = await request.post('/api/online-orders/' + local.id + '/confirm').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    assert.equal(conf.body.order.status, 'confirmed');
    assert.ok(conf.body.order.posOrderId);
    const [pos] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, conf.body.order.posOrderId));
    assert.equal(pos.label, 'Wolt W-4471');
    const posItems = await testDb.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, pos.id));
    assert.equal(posItems.length, 1);
    // kuriér sa neobjednáva
    const disp = await request.post('/api/online-orders/' + local.id + '/dispatch').set('Authorization', 'Bearer ' + tokens.manazer());
    assert.equal(disp.status, 409);

    const ready = await request.post('/api/online-orders/' + local.id + '/ready').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(ready.status, 200);
    // odovzdanie hlásime len pri vyzdvihnutí; pri kuriérovi Woltu 409
    const ho = await request.post('/api/online-orders/' + local.id + '/handed-over').set('Authorization', 'Bearer ' + tokens.cisnik());
    assert.equal(ho.status, 409);

    await notify('DELIVERED');
    const r2 = await bridge.tick();
    assert.equal(r2.wolt, 1);
    const [l2] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, local.id));
    assert.equal(l2.status, 'delivered');
    assert.equal(l2.woltStatus, 'delivered');
    assert.ok(emitted.some((e) => e.ev === 'online-order:updated' && e.data.status === 'delivered'));

    // druhá objednávka: vyzdvihnutie v podniku, Wolt ju zruší kým je nová → odmietnutá
    const raw2 = { ...raw, id: 'w-abc-2', order_number: '4472', delivery: { type: 'takeaway' } };
    await pool.query('INSERT INTO wolt_order_events (notification_id, type, wolt_order_id, status, payload) VALUES ($1, $2, $3, $4, $5)',
      ['n-c2', 'order.notification', raw2.id, 'CREATED', JSON.stringify({ order: { id: raw2.id, status: 'CREATED' }, mock_order: raw2 })]);
    await bridge.tick();
    const [t] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.woltOrderId, raw2.id));
    assert.equal(t.deliveryType, 'takeaway');
    assert.equal(t.dropoffStreet, 'Vyzdvihnutie v podniku');
    await pool.query('INSERT INTO wolt_order_events (notification_id, type, wolt_order_id, status, payload) VALUES ($1, $2, $3, $4, $5)',
      ['n-x2', 'order.notification', raw2.id, 'CANCELED', JSON.stringify({ order: { id: raw2.id, status: 'CANCELED' } })]);
    await bridge.tick();
    const [t2] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, t.id));
    assert.equal(t2.status, 'rejected');
    assert.match(t2.rejectedReason, /Wolt/);
  });

  it('Wolt zrušil objednávku po prijatí: účet dostane ZRUŠENÉ, KDS a kasa STOP', async () => {
    const items = await testDb.select().from(menuItems);
    const raw = {
      id: 'w-cancel-1', order_number: '5100', order_status: 'received', type: 'instant', consumer_name: 'Ivan', consumer_phone_number: '',
      price: { amount: 990 }, delivery: { type: 'homedelivery', location: { street_address: 'Jasovská 1', city: 'Bratislava', post_code: '851 07' } },
      created_at: new Date().toISOString(),
      items: [{ id: 'i1', name: items[0].name, count: 1, pos_id: String(items[0].id), item_price: { unit_price: { amount: Math.round(Number(items[0].price) * 100) } } }],
    };
    await pool.query('INSERT INTO wolt_order_events (notification_id, type, wolt_order_id, status, payload) VALUES ($1, $2, $3, $4, $5)',
      ['n-c1', 'order.notification', raw.id, 'CREATED', JSON.stringify({ order: { id: raw.id, status: 'CREATED' }, mock_order: raw })]);
    await bridge.tick();
    const [local] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.woltOrderId, raw.id));
    const conf = await request.post('/api/online-orders/' + local.id + '/confirm').set('Authorization', 'Bearer ' + tokens.cisnik()).send({ prepMinutes: 15 });
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    assert.ok(conf.body.order.posOrderId);
    await pool.query('INSERT INTO wolt_order_events (notification_id, type, wolt_order_id, status, payload) VALUES ($1, $2, $3, $4, $5)',
      ['n-c1-x', 'order.notification', raw.id, 'CANCELED', JSON.stringify({ order: { id: raw.id, status: 'CANCELED' } })]);
    emitted.length = 0;
    const rc = await bridge.tick();
    assert.deepEqual(rc.errors, [], 'cyklus bez chýb');
    const [l2] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.id, local.id));
    assert.equal(l2.status, 'cancelled');
    const [pos] = await testDb.select().from(schema.orders).where(eq(schema.orders.id, l2.posOrderId));
    assert.match(pos.label, /^ZRUŠENÉ · Wolt W-5100/);
    assert.equal(pos.status, 'open', 'účet ostáva na odpis');
    assert.ok(emitted.some((e) => e.ev === 'online-order:stop' && e.data.posOrderId === pos.id));
    assert.ok(emitted.some((e) => e.ev === 'order:updated' && e.data.cancelledByWolt));
  });

  it('zaseknutá Wolt notifikácia nezastaví heartbeat ani stav späť; po piatich pokusoch sa vzdá', async () => {
    // Notifikácia bez mock_order → getOrder v mock režime hodí 404 (trvalá) → označí sa hneď.
    await pool.query('INSERT INTO wolt_order_events (notification_id, type, wolt_order_id, status, payload) VALUES ($1, $2, $3, $4, $5)',
      ['n-bad-1', 'order.notification', 'w-bad-1', 'CREATED', JSON.stringify({ order: { id: 'w-bad-1', status: 'CREATED' } })]);
    // A dočasná chyba: režim off → 503 → ostáva na ďalší cyklus, max 5×.
    const { web } = await insertWebOrder();
    const r = await bridge.tick();
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    const { rows: [bad] } = await pool.query("SELECT processed_at, attempts FROM wolt_order_events WHERE wolt_order_id = 'w-bad-1'");
    assert.ok(bad.processed_at, '404 z Woltu = trvalá chyba, označené hneď');
    assert.equal(bad.attempts, 1);
    // web objednávka sa napriek tomu prevzala a heartbeat sa zapísal
    const [local] = await testDb.select().from(onlineOrders).where(eq(onlineOrders.webOrderId, Number(web.id)));
    assert.ok(local);
    const { rows: [cfg] } = await pool.query("SELECT updated_at FROM web_delivery_config WHERE key = 'config'");
    assert.ok(Date.now() - new Date(cfg.updated_at).getTime() < 10_000);

    process.env.WOLT_ORDER_MODE = 'off';
    try {
      // off = udalosť sa len zaloguje a označí (nie chyba); simulujeme dočasnú chybu cez development bez tokenu
      process.env.WOLT_ORDER_MODE = 'development';
      await pool.query('INSERT INTO wolt_order_events (notification_id, type, wolt_order_id, status, payload) VALUES ($1, $2, $3, $4, $5)',
        ['n-tmp-1', 'order.notification', 'w-tmp-1', 'CREATED', JSON.stringify({ order: { id: 'w-tmp-1', status: 'CREATED' } })]);
      for (let i = 1; i <= 5; i++) {
        const t = await bridge.tick();
        assert.equal(t.errors.length, i < 5 ? 1 : 0, 'pokus ' + i + ': ' + JSON.stringify(t.errors));
        const { rows: [ev] } = await pool.query("SELECT processed_at, attempts FROM wolt_order_events WHERE wolt_order_id = 'w-tmp-1'");
        assert.equal(ev.attempts, i);
        if (i < 5) assert.equal(ev.processed_at, null, 'dočasná chyba ostáva vo fronte');
        else assert.ok(ev.processed_at, 'po piatom pokuse sa vzdá');
      }
    } finally { process.env.WOLT_ORDER_MODE = 'mock'; }
  });

  it('toLocalOrder: čísla ako reťazce pre numeric, časy ako Date, prázdne polia doplnené', () => {
    const l = toLocalOrder({ id: '7', public_code: 'SS-ABCDE', customer_name: 'A', customer_phone: '+421', dropoff_street: 'S', dropoff_city: 'C',
      dropoff_post_code: '851 05', dropoff_lat: 48.1, dropoff_lon: null, items: [{ menuItemId: 1, qty: 1 }], subtotal: '10.00', delivery_fee: '2.90', total: '12.90',
      payment_method: 'transfer', scheduled_for: '2026-09-12T18:00:00.000Z', wolt_promise_id: 'p', wolt_promise_valid_until: null, client_ip: null });
    assert.equal(l.webOrderId, 7);
    assert.equal(l.dropoffLat, '48.1');
    assert.equal(l.dropoffLon, null);
    assert.equal(l.subtotal, '10.00');
    assert.ok(l.scheduledFor instanceof Date);
    assert.equal(l.customerEmail, '');
    assert.equal(l.clientIp, '');
    assert.equal(l.status, 'new');
  });
});

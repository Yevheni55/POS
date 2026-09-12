// Wolt Order API (objednávky z aplikácie Wolt): normalizácia objednávky,
// párovanie na menu, podpis webhooku, volania so stubnutým fetchom, OAuth tokeny.
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Tests must run with DATABASE_URL pointing to pos_test. Current: ' + process.env.DATABASE_URL);
}

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { testDb, closeDb } from '../helpers/setup.js';
import { integrationTokens } from '../../db/schema.js';
import {
  _internals, woltOrderConfig, normalizeOrder, buildOnlineOrderFromWolt, makeMenuResolver, moneyToEur,
  verifyOrderWebhookSignature, statusForNotification, buildAcceptBody, buildRejectBody,
  getOrder, acceptOrder, rejectOrder, readyOrder, exchangeAuthCode, getAccessToken, WoltOrderError, PROVIDER,
} from '../../lib/wolt-order-api.js';

const ENV_KEYS = ['WOLT_ORDER_MODE', 'WOLT_ORDER_API_KEY', 'WOLT_ORDER_CLIENT_ID', 'WOLT_ORDER_CLIENT_SECRET', 'WOLT_ORDER_BASE_URL', 'WOLT_ORDER_TOKEN_URL', 'WOLT_ORDER_PREP_MINUTES', 'WOLT_ORDER_REDIRECT_URI'];
const saved = {};
before(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  _internals.fetch = () => { throw new Error('nesmie volať sieť'); };
  _internals.now = () => new Date();
  await testDb.delete(integrationTokens);
});
after(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  _internals.fetch = (...a) => globalThis.fetch(...a);
  await closeDb();
});

/** Detail objednávky v tvare Woltu (v2), sumy v centoch. */
export function sampleWoltOrder(over = {}) {
  return {
    id: '64f1c0ffee1234567890abcd', order_number: '8842', order_status: 'received', type: 'instant',
    venue: { id: 'venue-1', name: 'Surf Spirit Draždiak' },
    consumer_name: 'Marek K.', consumer_phone_number: '+421 900 555 666', consumer_comment: 'bez cibule prosím',
    price: { amount: 2130, currency: 'EUR' },
    basket_price: { total: { amount: 1830, currency: 'EUR' } },
    fees: { delivery: { amount: 300, currency: 'EUR' } },
    delivery: {
      type: 'homedelivery', status: 'pending', time: '2026-09-13T12:40:00Z',
      location: { street_address: 'Tematínska 5', city: 'Bratislava', post_code: '851 05', formatted_address: 'Tematínska 5, 851 05 Bratislava', coordinates: { lat: 48.11, lon: 17.14 } },
    },
    pickup_eta: '2026-09-13T12:20:00Z', created_at: '2026-09-13T12:00:00Z',
    items: [
      { id: 'i1', name: 'Burger', count: 2, pos_id: '501', sku: null, options: [{ name: 'Omáčka', value: 'BBQ', price: { amount: 50 }, count: 1 }], item_price: { unit_price: { amount: 850 }, total: { amount: 1700 } } },
      { id: 'i2', name: 'Neznáma limonáda', count: 1, pos_id: null, options: [], item_price: { unit_price: { amount: 130 }, total: { amount: 130 } } },
    ],
    ...over,
  };
}
const MENU = [{ id: 501, name: 'Burger', price: '8.50', vatRate: '5.00' }, { id: 502, name: 'Kofola 0,5 l', price: '2.50', vatRate: '23.00' }];

test('normalizeOrder + buildOnlineOrderFromWolt: centy → eurá, pos_id → naša položka, nenamapované do poznámky', () => {
  const raw = sampleWoltOrder();
  const n = normalizeOrder(raw);
  assert.equal(n.total, 21.3);
  assert.equal(n.deliveryFee, 3);
  assert.equal(n.items[0].unitPrice, 8.5);
  assert.equal(n.items[0].note, 'Omáčka: BBQ');
  assert.equal(n.address.street, 'Tematínska 5');
  assert.equal(moneyToEur({ amount: 4927 }), 49.27);

  const v = buildOnlineOrderFromWolt(n, makeMenuResolver(MENU), raw);
  assert.equal(v.publicCode, 'W-8842');
  assert.equal(v.source, 'wolt');
  assert.equal(v.status, 'new');
  assert.equal(v.deliveryType, 'homedelivery');
  assert.equal(v.woltOrderId, raw.id);
  assert.equal(v.paymentMethod, 'wolt');
  assert.equal(v.items[0].menuItemId, 501);
  assert.equal(v.items[0].qty, 2);
  assert.equal(v.items[1].menuItemId, null);
  assert.equal(v.items[1].unmapped, true);
  assert.match(v.note, /bez cibule prosím/);
  assert.match(v.note, /nenamapované.*1× Neznáma limonáda/);
  assert.equal(v.total, '21.3');
  assert.equal(v.dropoffStreet, 'Tematínska 5');
  assert.equal(v.dropoffPostCode, '851 05');
  assert.equal(v.scheduledFor, null);
  assert.ok(v.woltPickupEta instanceof Date);
  assert.equal(v.woltPayload, raw);
});

test('párovanie podľa názvu, vyzdvihnutie v podniku, predobjednávka → scheduledFor', () => {
  const raw = sampleWoltOrder({
    type: 'preorder', pre_order: { preorder_time: '2026-09-14T17:30:00Z', pre_order_status: 'waiting' },
    delivery: { type: 'takeaway', status: 'pending' },
    items: [{ id: 'i3', name: 'kofola 0,5 L', count: 3, pos_id: null, item_price: { unit_price: { amount: 250 }, total: { amount: 750 } } }],
  });
  const v = buildOnlineOrderFromWolt(normalizeOrder(raw), makeMenuResolver(MENU), raw);
  assert.equal(v.items[0].menuItemId, 502, 'názov bez ohľadu na veľkosť písmen');
  assert.equal(v.dropoffStreet, 'Vyzdvihnutie v podniku');
  assert.equal(v.dropoffCity, '');
  assert.equal(new Date(v.scheduledFor).toISOString(), '2026-09-14T17:30:00.000Z');
  assert.equal(v.note, 'bez cibule prosím', 'všetko namapované → v poznámke len komentár zákazníka');
});

test('podpis webhooku WOLT-SIGNATURE (HMAC-SHA256 hex) a mapovanie notifikácií', () => {
  const body = JSON.stringify({ id: 'n1', type: 'order.notification', order: { id: 'o1', status: 'CREATED' } });
  const sig = crypto.createHmac('sha256', 'tajne').update(body).digest('hex');
  assert.equal(verifyOrderWebhookSignature(body, sig, 'tajne'), true);
  assert.equal(verifyOrderWebhookSignature(body, sig.toUpperCase(), 'tajne'), true);
  assert.equal(verifyOrderWebhookSignature(body, sig, 'ine'), false);
  assert.equal(verifyOrderWebhookSignature(body, '', 'tajne'), false);
  assert.equal(statusForNotification('DELIVERED', 'confirmed'), 'delivered');
  assert.equal(statusForNotification('CANCELED', 'new'), 'rejected');
  assert.equal(statusForNotification('CANCELED', 'confirmed'), 'cancelled');
  assert.equal(statusForNotification('PRODUCTION', 'new'), 'confirmed');
  assert.equal(statusForNotification('PRODUCTION', 'confirmed'), null);
  assert.equal(statusForNotification('READY', 'confirmed'), null);
});

test('development + API kľúč: GET /v2/orders, accept/reject/ready s telami z jedného miesta, chyba Woltu → 422', async () => {
  Object.assign(process.env, { WOLT_ORDER_MODE: 'development', WOLT_ORDER_API_KEY: 'key-1', WOLT_ORDER_PREP_MINUTES: '25' });
  _internals.now = () => new Date('2026-09-13T12:00:00Z');
  const calls = [];
  _internals.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (url.endsWith('/v2/orders/abc')) return { ok: true, status: 200, text: async () => JSON.stringify(sampleWoltOrder({ id: 'abc' })) };
    if (url.endsWith('/accept') || url.endsWith('/ready')) return { ok: true, status: 200, text: async () => '' };
    if (url.endsWith('/reject')) return { ok: false, status: 409, statusText: 'Conflict', text: async () => JSON.stringify({ detail: 'Order already accepted' }) };
    throw new Error('neočakávaná URL ' + url);
  };
  const o = await getOrder('abc', { resourceUrl: 'https://pos-integration-service.development.dev.woltapi.com/orders/abc' });
  assert.equal(o.id, 'abc');
  assert.equal(calls[0].url, 'https://pos-integration-service.development.dev.woltapi.com/v2/orders/abc');
  assert.equal(calls[0].headers['WOLT-API-KEY'], 'key-1');

  await acceptOrder('abc', { pickupTime: new Date('2026-09-13T12:25:00Z') });
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'https://pos-integration-service.development.dev.woltapi.com/orders/abc/accept');
  assert.deepEqual(calls[1].body, { adjusted_pickup_time: '2026-09-13T12:25:00.000Z' });
  assert.deepEqual(buildAcceptBody({}), {});
  assert.deepEqual(buildRejectBody('Vypredané'), { reason: 'Vypredané' });

  await readyOrder('abc');
  assert.equal(calls[2].url, 'https://pos-integration-service.development.dev.woltapi.com/orders/abc/ready');
  assert.equal(calls[2].body, undefined);

  await assert.rejects(() => rejectOrder('abc', 'Nevaríme'), (e) => e instanceof WoltOrderError && e.status === 422 && /already accepted/.test(e.message));
  assert.deepEqual(calls[3].body, { reason: 'Nevaríme' });
});

test('off / mock: off hlási 503, mock vráti detail z notifikácie a akcie bez siete', async () => {
  process.env.WOLT_ORDER_MODE = 'off';
  assert.equal(woltOrderConfig().enabled, false);
  await assert.rejects(() => acceptOrder('x'), (e) => e instanceof WoltOrderError && e.status === 503);
  process.env.WOLT_ORDER_MODE = 'mock';
  const mock = sampleWoltOrder({ id: 'm1' });
  assert.equal((await getOrder('m1', { mock })).id, 'm1');
  await assert.rejects(() => getOrder('m2'), (e) => e.status === 404);
  assert.deepEqual(await acceptOrder('m1'), { ok: true, mock: true });
  assert.deepEqual(await rejectOrder('m1', 'x'), { ok: true, mock: true });
});

test('OAuth: výmena kódu uloží tokeny, platný access token sa vracia z DB, po expirácii sa obnoví jednorazovým refresh tokenom', async () => {
  Object.assign(process.env, { WOLT_ORDER_MODE: 'development', WOLT_ORDER_CLIENT_ID: 'cid', WOLT_ORDER_CLIENT_SECRET: 'csec', WOLT_ORDER_REDIRECT_URI: 'https://surfspirit.sk/cb' });
  let now = new Date('2026-09-13T10:00:00Z');
  _internals.now = () => now;
  const calls = [];
  let n = 0;
  _internals.fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: Object.fromEntries(new URLSearchParams(opts.body)) });
    n++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'at-' + n, refresh_token: 'rt-' + n, expires_in: 3600, token_type: 'bearer' }) };
  };
  const cfg = woltOrderConfig();
  assert.equal(await exchangeAuthCode('kod-123', cfg), 'at-1');
  assert.equal(calls[0].url, 'https://integrations-authentication-service.development.dev.woltapi.com/oauth2/token');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('cid:csec').toString('base64'));
  assert.deepEqual(calls[0].body, { grant_type: 'authorization_code', code: 'kod-123', redirect_uri: 'https://surfspirit.sk/cb' });
  const [row] = await testDb.select().from(integrationTokens).where(eq(integrationTokens.provider, PROVIDER));
  assert.equal(row.accessToken, 'at-1');
  assert.equal(row.refreshToken, 'rt-1');

  // ešte platný → bez siete
  assert.equal(await getAccessToken(cfg), 'at-1');
  assert.equal(calls.length, 1);

  // po hodine → refresh, uloží sa nový (rotovaný) refresh token
  now = new Date('2026-09-13T11:05:00Z');
  assert.equal(await getAccessToken(cfg), 'at-2');
  assert.deepEqual(calls[1].body, { grant_type: 'refresh_token', refresh_token: 'rt-1' });
  const [row2] = await testDb.select().from(integrationTokens).where(eq(integrationTokens.provider, PROVIDER));
  assert.equal(row2.refreshToken, 'rt-2');

  // bez tokenov v DB → zrozumiteľná 503
  await testDb.delete(integrationTokens);
  await assert.rejects(() => getAccessToken(cfg), (e) => e instanceof WoltOrderError && e.status === 503);
});

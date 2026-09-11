import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  _internals, woltConfig, buildPromiseBody, buildDeliveryBody,
  requestShipmentPromise, createDelivery, cancelDelivery, verifyWebhookToken, statusForWebhookType, WoltError,
} from '../../lib/wolt-drive.js';

const ENV_KEYS = ['WOLT_DRIVE_MODE', 'WOLT_DRIVE_TOKEN', 'WOLT_MERCHANT_ID', 'WOLT_VENUE_ID', 'WOLT_WEBHOOK_SECRET', 'WOLT_CASH_ON_DELIVERY', 'WOLT_PICKUP_PHONE'];
const saved = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } _internals.fetch = (...a) => globalThis.fetch(...a); });

const ORDER = {
  id: 1, publicCode: 'SS-ABCDE', customerName: 'Jana Nová', customerPhone: '+421900111222', customerEmail: '',
  dropoffStreet: 'Tematínska 5', dropoffCity: 'Bratislava', dropoffPostCode: '851 05', dropoffComment: '2. poschodie',
  items: [{ menuItemId: 7, name: 'Burger', qty: 2, unitPrice: 8.5, vatRate: 5 }],
  subtotal: '17.00', deliveryFee: '2.90', total: '19.90', paymentMethod: 'cash', scheduledFor: null, woltPromiseId: 'p-1',
};

test('off mode: klient hlási 503, nič nevolá', async () => {
  process.env.WOLT_DRIVE_MODE = 'off';
  assert.equal(woltConfig().enabled, false);
  await assert.rejects(() => requestShipmentPromise({ street: 'x', city: 'y', postCode: '851 05' }), (e) => e instanceof WoltError && e.status === 503);
});

test('mock mode: prísľub aj doručenie bez siete, ceny v eurách', async () => {
  process.env.WOLT_DRIVE_MODE = 'mock';
  _internals.fetch = () => { throw new Error('nesmie volať sieť'); };
  const p = await requestShipmentPromise({ street: 'Tematínska 5', city: 'Bratislava', postCode: '851 05' });
  assert.match(p.id, /^mock-promise-/);
  assert.equal(p.feeEur, 2.9);
  assert.ok(new Date(p.validUntil) > new Date());
  const d = await createDelivery({ promiseId: p.id, order: ORDER });
  assert.equal(d.woltOrderReferenceId, 'mock-SS-ABCDE');
  assert.match(d.trackingUrl, /SS-ABCDE/);
  assert.deepEqual(await cancelDelivery(d.woltOrderReferenceId), { ok: true });
});

test('development mode: správna URL, Bearer token, centy → eurá, chyby Woltu', async () => {
  Object.assign(process.env, { WOLT_DRIVE_MODE: 'development', WOLT_DRIVE_TOKEN: 'tok', WOLT_MERCHANT_ID: 'm1', WOLT_VENUE_ID: 'v1', WOLT_PICKUP_PHONE: '+421900000000' });
  const calls = [];
  _internals.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/shipment-promises')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'prom-9', valid_until: '2030-01-01T00:00:00Z', price: { amount: 349, currency: 'EUR' }, is_binding: true, dropoff: { eta_minutes: 28, location: { coordinates: { lat: 48.1, lon: 17.1 }, formatted_address: 'Tematínska 5, Bratislava' } } }) };
    }
    if (url.endsWith('/deliveries')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'del-1', wolt_order_reference_id: 'WOR-1', status: 'INFO_RECEIVED', tracking: { url: 'https://track.wolt.com/x' }, price: { amount: 349, currency: 'EUR' } }) };
    }
    if (url.includes('/status/cancel')) return { ok: false, status: 409, statusText: 'Conflict', text: async () => JSON.stringify({ detail: 'Courier already assigned' }) };
    throw new Error('neočakávaná URL ' + url);
  };
  const p = await requestShipmentPromise({ street: 'Tematínska 5', city: 'Bratislava', postCode: '851 05' });
  assert.equal(calls[0].url, 'https://daas-public-api.development.dev.woltapi.com/v1/venues/v1/shipment-promises');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
  assert.equal(p.feeEur, 3.49);
  assert.equal(p.etaMinutes, 28);
  assert.equal(p.dropoff.lat, 48.1);

  const d = await createDelivery({ promiseId: p.id, order: { ...ORDER, paymentMethod: 'transfer' } });
  assert.equal(d.woltOrderReferenceId, 'WOR-1');
  assert.equal(d.feeEur, 3.49);
  const sent = JSON.parse(calls[1].opts.body);
  assert.equal(sent.shipment_promise_id, 'prom-9');
  assert.equal(sent.merchant_order_reference_id, 'SS-ABCDE');
  assert.equal(sent.recipient.phone_number, '+421900111222');
  assert.equal(sent.contents[0].count, 2);
  assert.equal(sent.cash, undefined, 'bez COD sa cash neposiela');

  await assert.rejects(() => cancelDelivery('WOR-1'), (e) => e instanceof WoltError && e.status === 422 && /Courier already assigned/.test(e.message));
});

test('buildDeliveryBody: cash sa posiela len s WOLT_CASH_ON_DELIVERY a v centoch', () => {
  process.env.WOLT_DRIVE_MODE = 'development';
  process.env.WOLT_CASH_ON_DELIVERY = '1';
  const body = buildDeliveryBody({ promiseId: 'p', order: ORDER }, woltConfig());
  assert.deepEqual(body.cash, { amount_to_collect: 1990, amount_to_expect: 1990 });
  assert.equal(body.dropoff.comment, '2. poschodie');
  const promise = buildPromiseBody({ street: 'A 1', city: 'B', postCode: '851 05', lat: 48.1, lon: 17.1 }, woltConfig());
  assert.equal(promise.post_code, '851 05');
  assert.equal(promise.lat, 48.1);
});

test('webhook: platný HS256 token prejde, cudzí podpis nie; mapovanie stavov', () => {
  process.env.WOLT_WEBHOOK_SECRET = 'tajne';
  const token = jwt.sign({ type: 'order.delivered', details: { merchant_order_reference_id: 'SS-ABCDE' } }, 'tajne', { algorithm: 'HS256' });
  assert.equal(verifyWebhookToken(token).type, 'order.delivered');
  const bad = jwt.sign({ type: 'order.delivered' }, 'ine-tajne', { algorithm: 'HS256' });
  assert.throws(() => verifyWebhookToken(bad), (e) => e instanceof WoltError && e.status === 401);
  assert.equal(statusForWebhookType('order.delivered'), 'delivered');
  assert.equal(statusForWebhookType('order.rejected'), 'confirmed');
  assert.equal(statusForWebhookType('order.pickup_started'), null);
});

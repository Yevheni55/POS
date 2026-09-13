/**
 * Wolt Order API (objednávky z aplikácie Wolt — marketplace, nie Wolt Drive).
 *
 * Tok: Wolt pošle webhook „order.notification" (na surfspirit.sk, PHP ho odloží
 * do Neon), kasa si stiahne detail objednávky (GET /v2/orders/{id}), ukáže ju
 * na KDS/kase/admine ako bežnú online objednávku a spätne volá
 * accept / reject / ready / delivered. Kuriéra rieši Wolt sám.
 *
 * Režimy (WOLT_ORDER_MODE): off | mock | development | production.
 * Autentifikácia: buď WOLT_ORDER_API_KEY (hlavička WOLT-API-KEY, staršie
 * integrácie), alebo OAuth 2.0 (Authentication 2.0): client_id/secret +
 * authorization_code → access token (1 h) + refresh token (jednorazový, 30 dní)
 * uložené v tabuľke integration_tokens.
 *
 * POZOR: presné telá accept/reject Wolt zverejňuje len v OpenAPI referencii —
 * skladajú sa VÝHRADNE v buildAcceptBody()/buildRejectBody(), nech sa prípadná
 * odchýlka opraví na jednom mieste po overení voči testovaciemu prostrediu.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { integrationTokens } from '../db/schema.js';

const BASE_URLS = {
  development: 'https://pos-integration-service.development.dev.woltapi.com',
  production: 'https://pos-integration-service.wolt.com',
};
const TOKEN_URLS = {
  development: 'https://integrations-authentication-service.development.dev.woltapi.com/oauth2/token',
  production: 'https://integrations-authentication-service.wolt.com/oauth2/token',
};
const TIMEOUT_MS = 10_000;
export const PROVIDER = 'wolt-order';

export class WoltOrderError extends Error {
  constructor(message, { status = 502, detail = null } = {}) {
    super(message);
    this.name = 'WoltOrderError';
    this.status = status;
    this.detail = detail;
  }
}

// Testy si sem podstrčia vlastný fetch/čas — bez sieťových volaní.
export const _internals = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date(),
};

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}

export function woltOrderConfig() {
  const mode = env('WOLT_ORDER_MODE', 'off').toLowerCase();
  return {
    mode,
    enabled: mode === 'mock' || mode === 'development' || mode === 'production',
    baseUrl: env('WOLT_ORDER_BASE_URL', BASE_URLS[mode] || ''),
    tokenUrl: env('WOLT_ORDER_TOKEN_URL', TOKEN_URLS[mode] || ''),
    apiKey: env('WOLT_ORDER_API_KEY'),
    clientId: env('WOLT_ORDER_CLIENT_ID'),
    clientSecret: env('WOLT_ORDER_CLIENT_SECRET'),
    // Kam Wolt presmeruje s authorization code — PHP na webe ho odloží do Neon, kasa ho vymení za tokeny.
    redirectUri: env('WOLT_ORDER_REDIRECT_URI', 'https://surfspirit.sk/objednavky-api.php/wolt/oauth/callback'),
    venueId: env('WOLT_ORDER_VENUE_ID'),
    webhookSecret: env('WOLT_ORDER_WEBHOOK_SECRET'),
    // Koľko minút si pýtame na prípravu pri prijatí (adjusted_pickup_time). 0 = nechať odhad Woltu.
    prepMinutes: Number(env('WOLT_ORDER_PREP_MINUTES', '0')) || 0,
    // Za koľko sekúnd Wolt neprijatú objednávku sám zruší (dohodnuté s Woltom); 0 = nevieme,
    // strážca potom automaticky neodmieta.
    acceptWindowS: Number(env('WOLT_ORDER_ACCEPT_WINDOW_S', '0')) || 0,
  };
}

function assertConfigured(cfg) {
  if (!cfg.enabled) throw new WoltOrderError('Objednávky z aplikácie Wolt nie sú zapnuté', { status: 503 });
  if (cfg.mode === 'mock') return;
  if (!cfg.baseUrl) throw new WoltOrderError('Wolt Order API: chýba WOLT_ORDER_BASE_URL', { status: 503 });
  if (!cfg.apiKey && !(cfg.clientId && cfg.clientSecret)) {
    throw new WoltOrderError('Wolt Order API nie je nakonfigurované: chýba WOLT_ORDER_API_KEY alebo OAuth client', { status: 503 });
  }
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
/** Sumy z Woltu sú v minimálnych jednotkách meny (4927 → 49,27 €). Objekt {amount} alebo číslo. */
export function moneyToEur(v) {
  if (v == null) return null;
  if (typeof v === 'object') return moneyToEur(v.amount);
  const n = Number(v);
  return Number.isFinite(n) ? round2(n / 100) : null;
}

// ── OAuth 2.0 (Authentication 2.0) ─────────────────────────────────────────
async function tokenRequest(cfg, params) {
  if (!cfg.clientId || !cfg.clientSecret || !cfg.tokenUrl) throw new WoltOrderError('Wolt OAuth: chýba WOLT_ORDER_CLIENT_ID / CLIENT_SECRET', { status: 503 });
  let res;
  try {
    res = await _internals.fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64'),
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new WoltOrderError('Wolt OAuth neodpovedá (' + e.message + ')', { status: 504 });
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || !data.access_token) {
    throw new WoltOrderError('Wolt OAuth odmietol (' + res.status + '): ' + String(data.error_description || data.error || text).slice(0, 200), { status: 502, detail: data });
  }
  const expiresAt = new Date(_internals.now().getTime() + (Number(data.expires_in) || 3600) * 1000);
  const set = { accessToken: data.access_token, refreshToken: data.refresh_token || params.refresh_token || null, expiresAt, updatedAt: new Date() };
  await db.insert(integrationTokens).values({ provider: PROVIDER, ...set })
    .onConflictDoUpdate({ target: integrationTokens.provider, set });
  return data.access_token;
}

/** Vymení authorization code (z presmerovania Woltu) za tokeny a uloží ich. */
export function exchangeAuthCode(code, cfg = woltOrderConfig()) {
  return tokenRequest(cfg, { grant_type: 'authorization_code', code: String(code), redirect_uri: cfg.redirectUri });
}

export async function getAccessToken(cfg = woltOrderConfig()) {
  const [row] = await db.select().from(integrationTokens).where(eq(integrationTokens.provider, PROVIDER)).limit(1);
  if (!row || !row.refreshToken) {
    throw new WoltOrderError('Wolt Order API nie je pripojené — chýba OAuth token (pripojenie cez developer.wolt.com/integrate)', { status: 503 });
  }
  const msLeft = row.expiresAt ? new Date(row.expiresAt).getTime() - _internals.now().getTime() : 0;
  if (row.accessToken && msLeft > 60_000) return row.accessToken;
  // Refresh token je jednorazový — odpoveď prinesie nový, tokenRequest ho uloží.
  return tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: row.refreshToken });
}

export async function connectionStatus(cfg = woltOrderConfig()) {
  if (cfg.apiKey) return { connected: true, via: 'api-key' };
  const [row] = await db.select().from(integrationTokens).where(eq(integrationTokens.provider, PROVIDER)).limit(1);
  return { connected: !!(row && row.refreshToken), via: 'oauth', updatedAt: row?.updatedAt || null };
}

async function authHeaders(cfg) {
  if (cfg.apiKey) return { 'WOLT-API-KEY': cfg.apiKey };
  return { Authorization: 'Bearer ' + await getAccessToken(cfg) };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function call(cfg, method, url, body) {
  const headers = { ...await authHeaders(cfg), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await _internals.fetch(url, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new WoltOrderError('Wolt Order API neodpovedá (' + (e.name === 'TimeoutError' ? 'timeout' : e.message) + ')', { status: 504 });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = (data && (data.detail || data.title || data.message || data.error)) || text || res.statusText;
    throw new WoltOrderError('Wolt odmietol požiadavku (' + res.status + '): ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300), {
      status: res.status >= 500 ? 502 : 422, detail: data,
    });
  }
  return data;
}

/** URL detailu objednávky: preferujeme /v2/orders/{id}; resource_url z webhooku len určí origin. */
export function orderDetailUrl(cfg, orderId, resourceUrl) {
  let origin = cfg.baseUrl;
  if (!origin && resourceUrl) { try { origin = new URL(resourceUrl).origin; } catch { /* ignoruj */ } }
  return origin.replace(/\/$/, '') + '/v2/orders/' + encodeURIComponent(orderId);
}
function actionUrl(cfg, orderId, action) {
  return cfg.baseUrl.replace(/\/$/, '') + '/orders/' + encodeURIComponent(orderId) + '/' + action;
}

// ── Telá požiadaviek — JEDINÉ miesto, kde sa skladajú ────────────────────────
export function buildAcceptBody({ pickupTime } = {}) {
  return pickupTime ? { adjusted_pickup_time: new Date(pickupTime).toISOString() } : {};
}
export function buildRejectBody(reason) {
  return { reason: String(reason || 'Objednávku momentálne nevieme prijať').slice(0, 300) };
}

// ── Volania ──────────────────────────────────────────────────────────────────
/**
 * Detail objednávky. V mock režime vráti `mock` (surový JSON v tvare Woltu),
 * ktorý si most vezme z notifikácie — bez siete.
 */
export async function getOrder(orderId, { resourceUrl = null, mock = null } = {}) {
  const cfg = woltOrderConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') {
    if (!mock) throw new WoltOrderError('Mock režim: chýba mock objednávka v notifikácii', { status: 404 });
    return mock;
  }
  return call(cfg, 'GET', orderDetailUrl(cfg, orderId, resourceUrl));
}

export async function acceptOrder(orderId, { pickupTime = null } = {}) {
  const cfg = woltOrderConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') return { ok: true, mock: true };
  await call(cfg, 'PUT', actionUrl(cfg, orderId, 'accept'), buildAcceptBody({ pickupTime }));
  return { ok: true };
}
export async function rejectOrder(orderId, reason) {
  const cfg = woltOrderConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') return { ok: true, mock: true };
  await call(cfg, 'PUT', actionUrl(cfg, orderId, 'reject'), buildRejectBody(reason));
  return { ok: true };
}
export async function readyOrder(orderId) {
  const cfg = woltOrderConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') return { ok: true, mock: true };
  await call(cfg, 'PUT', actionUrl(cfg, orderId, 'ready'));
  return { ok: true };
}
export async function deliveredOrder(orderId) {
  const cfg = woltOrderConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') return { ok: true, mock: true };
  await call(cfg, 'PUT', actionUrl(cfg, orderId, 'delivered'));
  return { ok: true };
}
export async function confirmPreorder(orderId) {
  const cfg = woltOrderConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') return { ok: true, mock: true };
  await call(cfg, 'PUT', actionUrl(cfg, orderId, 'confirm-preorder'));
  return { ok: true };
}

// ── Webhook ──────────────────────────────────────────────────────────────────
/** WOLT-SIGNATURE = HMAC-SHA256(telo požiadavky, client secret) v hex. */
export function verifyOrderWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody)).digest('hex');
  const given = String(signatureHeader || '').trim().toLowerCase();
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/** Aký lokálny stav zodpovedá notifikácii Woltu. null = len woltStatus. */
export function statusForNotification(woltStatus, localStatus) {
  const s = String(woltStatus || '').toUpperCase();
  if (s === 'DELIVERED') return 'delivered';
  if (s === 'CANCELED' || s === 'CANCELLED' || s === 'REJECTED') return localStatus === 'new' ? 'rejected' : 'cancelled';
  if (s === 'PRODUCTION' && localStatus === 'new') return 'confirmed'; // prijaté inde (iPad, Wolt podpora)
  return null;
}

// ── Normalizácia detailu objednávky ─────────────────────────────────────────
/** Surový JSON Woltu → náš tvar (eurá, jedna adresa, položky s pos_id/sku). */
export function normalizeOrder(raw) {
  const loc = raw.delivery?.location || {};
  const items = (raw.items || []).map((it) => {
    const qty = Number(it.count) || 1;
    const unit = moneyToEur(it.item_price?.unit_price ?? it.unit_price ?? null);
    const total = moneyToEur(it.item_price?.total ?? it.total_price ?? null) ?? (unit != null ? round2(unit * qty) : null);
    const options = (it.options || []).map((o) => ({
      name: o.name || '', value: o.value || '', count: Number(o.count) || 1, price: moneyToEur(o.price ?? null), posId: o.pos_id || null,
    }));
    const note = options.map((o) => (o.name ? o.name + ': ' : '') + o.value).filter(Boolean).join(', ');
    return { woltItemId: it.id || null, name: it.name || '', qty, posId: it.pos_id || null, sku: it.sku || null, unitPrice: unit, total, options, note };
  });
  return {
    woltOrderId: raw.id,
    orderNumber: raw.order_number || '',
    status: raw.order_status || raw.status || '',
    type: raw.type || (raw.pre_order ? 'preorder' : 'instant'),
    preorderTime: raw.pre_order?.preorder_time || null,
    preorderStatus: raw.pre_order?.pre_order_status || null,
    deliveryType: raw.delivery?.type || 'homedelivery',
    deliveryTime: raw.delivery?.time || null,
    address: {
      street: loc.street_address || loc.formatted_address || '',
      city: loc.city || '',
      postCode: loc.post_code || loc.postal_code || loc.zip || '',
      formatted: loc.formatted_address || '',
      lat: loc.coordinates?.lat ?? null,
      lon: loc.coordinates?.lon ?? null,
    },
    customerName: raw.consumer_name || 'Zákazník Wolt',
    customerPhone: raw.consumer_phone_number || '',
    comment: raw.consumer_comment || '',
    total: moneyToEur(raw.price ?? null),
    basketTotal: moneyToEur(raw.basket_price?.total ?? raw.basket_price ?? null),
    deliveryFee: moneyToEur(raw.fees?.delivery ?? raw.delivery?.fee ?? null) ?? 0,
    pickupEta: raw.pickup_eta || null,
    createdAt: raw.created_at || null,
    venueId: raw.venue?.id || null,
    items,
  };
}

/**
 * Riadok online_orders z normalizovanej objednávky. `resolveMenuItem(item)`
 * vráti našu položku menu (id, price, vatRate) alebo null — nenamapované sa
 * vypíšu do poznámky, nech kuchyňa nič nestratí.
 */
export function buildOnlineOrderFromWolt(n, resolveMenuItem, raw = null) {
  const items = n.items.map((it) => {
    const m = resolveMenuItem(it);
    const unitPrice = it.unitPrice != null ? it.unitPrice : (m ? round2(m.price) : 0);
    return {
      menuItemId: m ? m.id : null, name: it.name, qty: it.qty, unitPrice, vatRate: m ? round2(m.vatRate || 0) : 0,
      note: it.note || '', woltItemId: it.woltItemId, posId: it.posId, sku: it.sku, unmapped: !m,
    };
  });
  const unmapped = items.filter((i) => i.unmapped).map((i) => i.qty + '× ' + i.name);
  const subtotal = round2(items.reduce((s, i) => s + (i.unitPrice || 0) * i.qty, 0));
  const total = n.total != null ? n.total : round2(subtotal + (n.deliveryFee || 0));
  const inHouse = n.deliveryType === 'takeaway' || n.deliveryType === 'eatin';
  const noteParts = [n.comment, unmapped.length ? 'Položky mimo kasy (nenamapované): ' + unmapped.join(', ') : ''].filter(Boolean);
  const numberPart = n.orderNumber ? String(n.orderNumber) : String(n.woltOrderId || '').slice(-5).toUpperCase();
  return {
    publicCode: ('W-' + numberPart).slice(0, 12),
    status: 'new',
    source: 'wolt',
    deliveryType: n.deliveryType,
    woltOrderId: String(n.woltOrderId),
    woltOrderNumber: n.orderNumber ? String(n.orderNumber).slice(0, 32) : null,
    woltPickupEta: n.pickupEta ? new Date(n.pickupEta) : null,
    woltStatus: n.status ? String(n.status).toLowerCase() : null,
    woltPayload: raw,
    customerName: String(n.customerName).slice(0, 100),
    customerPhone: String(n.customerPhone || '').slice(0, 30),
    customerEmail: '',
    dropoffStreet: inHouse ? (n.deliveryType === 'eatin' ? 'Konzumácia v podniku' : 'Vyzdvihnutie v podniku') : (n.address.street || n.address.formatted || '—').slice(0, 150),
    dropoffCity: inHouse ? '' : String(n.address.city || '').slice(0, 80),
    dropoffPostCode: inHouse ? '' : String(n.address.postCode || '').slice(0, 12),
    dropoffComment: '',
    dropoffLat: n.address.lat == null ? null : String(n.address.lat),
    dropoffLon: n.address.lon == null ? null : String(n.address.lon),
    items,
    subtotal: String(subtotal),
    deliveryFee: String(n.deliveryFee || 0),
    total: String(total),
    paymentMethod: 'wolt',
    note: noteParts.join(' · ').slice(0, 500),
    scheduledFor: n.type === 'preorder' && n.preorderTime ? new Date(n.preorderTime) : null,
    updatedAt: new Date(),
  };
}

/** Párovanie položky Woltu na naše menu: pos_id (= id v kase) → sku → názov. */
export function makeMenuResolver(menuRows) {
  const byId = new Map(), byName = new Map();
  for (const m of menuRows) {
    byId.set(String(m.id), m);
    byName.set(String(m.name || '').trim().toLowerCase(), m);
  }
  return function resolve(it) {
    if (it.posId && byId.has(String(it.posId))) return byId.get(String(it.posId));
    if (it.sku && byId.has(String(it.sku))) return byId.get(String(it.sku));
    return byName.get(String(it.name || '').trim().toLowerCase()) || null;
  };
}

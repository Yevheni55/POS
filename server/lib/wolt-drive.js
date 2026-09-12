/**
 * Wolt Drive (delivery-as-a-service) klient.
 *
 * Wolt tu NIE JE marketplace: zákazník objednáva na našom webe, my objednávku
 * potvrdíme a Wolt len pošle kuriéra. Tok podľa developer.wolt.com/docs/wolt-drive:
 *   1. POST /v1/venues/{venue_id}/shipment-promises → cena + ETA (prísľub, platí
 *      pár minút; `is_binding` = cena je záväzná)
 *   2. POST /v1/venues/{venue_id}/deliveries        → kuriér, s `shipment_promise_id`
 *   3. PATCH /order/{wolt_order_reference_id}/status/cancel → zrušenie pred prevzatím
 *   4. webhooky (JWT HS256 podpísaný naším client_secret) → stav doručenia
 *
 * Režimy (WOLT_DRIVE_MODE): off | mock | development | production.
 *   off         — doručenie nie je dostupné (web to povie zákazníkovi)
 *   mock        — žiadne volania von, deterministické odpovede; na lokálny vývoj
 *   development — https://daas-public-api.development.dev.woltapi.com (staging token)
 *   production  — https://daas-public-api.wolt.com
 *
 * POZOR: Wolt zverejňuje presné telá požiadaviek len v OpenAPI referencii, ktorá
 * sa nedá stiahnuť ako text. `buildPromiseBody()` a `buildDeliveryBody()` sú
 * preto JEDINÉ miesto, kde sa payload skladá — pri onboardingu sa overia proti
 * staging prostrediu a prípadná odchýlka sa opraví tu, nič iné sa meniť nemusí.
 */
import jwt from 'jsonwebtoken';

const BASE_URLS = {
  development: 'https://daas-public-api.development.dev.woltapi.com',
  production: 'https://daas-public-api.wolt.com',
};
const TIMEOUT_MS = 10_000;

export class WoltError extends Error {
  constructor(message, { status = 502, detail = null } = {}) {
    super(message);
    this.name = 'WoltError';
    this.status = status;
    this.detail = detail;
  }
}

// Testy si sem podstrčia vlastný fetch — bez sieťových volaní.
export const _internals = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date(),
};

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}

export function woltConfig() {
  const mode = env('WOLT_DRIVE_MODE', 'off').toLowerCase();
  const enabled = mode === 'mock' || mode === 'development' || mode === 'production';
  return {
    mode,
    enabled,
    baseUrl: env('WOLT_DRIVE_BASE_URL', BASE_URLS[mode] || ''),
    token: env('WOLT_DRIVE_TOKEN'),
    merchantId: env('WOLT_MERCHANT_ID'),
    venueId: env('WOLT_VENUE_ID'),
    webhookSecret: env('WOLT_WEBHOOK_SECRET'),
    minPrepMinutes: Number(env('WOLT_MIN_PREP_MINUTES', '20')) || 20,
    // Hotovosť kuriérovi je u Woltu „podľa regiónu" — zapína sa až po potvrdení
    // od Wolt Drive tímu. Kým je vypnutá, web ponúkne len platbu vopred.
    cashOnDelivery: /^(1|true|yes|on)$/i.test(env('WOLT_CASH_ON_DELIVERY', '0')),
    pickup: {
      name: env('WOLT_PICKUP_NAME', 'Surf Spirit Draždiak'),
      phone: env('WOLT_PICKUP_PHONE'),
      street: env('WOLT_PICKUP_STREET', 'Tematínska 3270/3'),
      city: env('WOLT_PICKUP_CITY', 'Bratislava'),
      postCode: env('WOLT_PICKUP_POST_CODE', '851 05'),
      comment: env('WOLT_PICKUP_COMMENT', ''),
    },
    support: {
      email: env('WOLT_SUPPORT_EMAIL'),
      phone: env('WOLT_SUPPORT_PHONE'),
      url: env('WOLT_SUPPORT_URL', 'https://surfspirit.sk'),
    },
    mockFeeEur: Number(env('WOLT_MOCK_FEE_EUR', '2.90')) || 2.9,
  };
}

function assertConfigured(cfg) {
  if (!cfg.enabled) throw new WoltError('Doručenie cez Wolt nie je zapnuté', { status: 503 });
  if (cfg.mode === 'mock') return;
  const missing = ['token', 'venueId', 'merchantId'].filter((k) => !cfg[k]);
  if (!cfg.baseUrl || missing.length) {
    throw new WoltError('Wolt Drive nie je nakonfigurovaný: chýba ' + missing.join(', '), { status: 503 });
  }
}

async function call(cfg, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await _internals.fetch(cfg.baseUrl + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new WoltError('Wolt Drive neodpovedá (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ')', { status: 504 });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = (data && (data.detail || data.title || data.message || data.error)) || text || res.statusText;
    throw new WoltError('Wolt Drive odmietol požiadavku (' + res.status + '): ' + String(detail).slice(0, 300), {
      status: res.status >= 500 ? 502 : 422,
      detail: data,
    });
  }
  return data;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Wolt: „Keď má byť doručenie do hodiny, scheduled_dropoff_time sa NEPOSIELA."
// Vraciame ISO čas len pre skutočne naplánované doručenia, inak null.
export function scheduledTimeForWolt(scheduledFor) {
  if (!scheduledFor) return null;
  const t = new Date(scheduledFor);
  if (Number.isNaN(t.getTime())) return null;
  return t.getTime() - _internals.now().getTime() > 60 * 60_000 ? t.toISOString() : null;
}

// Wolt vracia sumy v minimálnych jednotkách meny (centy).
function amountToEur(price) {
  if (!price || price.amount == null) return null;
  return round2(Number(price.amount) / 100);
}
function eurToAmount(eur) { return Math.round(Number(eur) * 100); }

/** Telo prísľubu (shipment promise). Adresa + súradnice, ak ich máme. */
export function buildPromiseBody({ street, city, postCode, lat, lon, scheduledFor }, cfg) {
  const body = {
    street: String(street),
    city: String(city),
    post_code: String(postCode),
    min_preparation_time_minutes: cfg.minPrepMinutes,
  };
  if (Number.isFinite(lat) && Number.isFinite(lon)) { body.lat = lat; body.lon = lon; }
  const sched = scheduledTimeForWolt(scheduledFor);
  if (sched) body.scheduled_dropoff_time = sched;
  return body;
}

/** Telo doručenia. `order` je riadok online_orders (camelCase). */
export function buildDeliveryBody({ promiseId, order }, cfg) {
  const items = Array.isArray(order.items) ? order.items : [];
  const body = {
    shipment_promise_id: promiseId,
    merchant_order_reference_id: order.publicCode,
    order_number: order.publicCode,
    recipient: {
      name: order.customerName,
      phone_number: order.customerPhone,
      ...(order.customerEmail ? { email: order.customerEmail } : {}),
    },
    pickup: {
      comment: cfg.pickup.comment || undefined,
      display_name: cfg.pickup.name,
      contact_details: { name: cfg.pickup.name, phone_number: cfg.pickup.phone },
      options: { min_preparation_time_minutes: cfg.minPrepMinutes },
    },
    dropoff: {
      comment: order.dropoffComment || undefined,
      contact_details: { name: order.customerName, phone_number: order.customerPhone },
      options: {
        is_no_contact: false,
        ...(scheduledTimeForWolt(order.scheduledFor) ? { scheduled_time: scheduledTimeForWolt(order.scheduledFor) } : {}),
      },
    },
    contents: items.map((it) => ({
      count: Number(it.qty) || 1,
      description: String(it.name).slice(0, 100),
      identifier: String(it.menuItemId),
      tags: [],
    })),
    parcels: [{ count: 1, description: 'Jedlo a nápoje', tags: [] }],
    customer_support: {
      email: cfg.support.email || undefined,
      phone_number: cfg.support.phone || undefined,
      url: cfg.support.url || undefined,
    },
    tips: [],
  };
  if (order.paymentMethod === 'cash' && cfg.cashOnDelivery) {
    body.cash = {
      amount_to_collect: eurToAmount(order.total),
      amount_to_expect: eurToAmount(order.total),
    };
  }
  return body;
}

function mockPromise({ street, city, postCode }, cfg) {
  const now = _internals.now();
  return {
    id: 'mock-promise-' + now.getTime().toString(36),
    validUntil: new Date(now.getTime() + 10 * 60_000).toISOString(),
    feeEur: cfg.mockFeeEur,
    etaMinutes: 35,
    isBinding: true,
    dropoff: { lat: 48.1122, lon: 17.1444, formattedAddress: `${street}, ${postCode} ${city}` },
  };
}

/** Cena a čas doručenia na adresu. Vracia normalizovaný objekt (bez surového JSON-u). */
export async function requestShipmentPromise(dropoff) {
  const cfg = woltConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') return mockPromise(dropoff, cfg);

  const data = await call(cfg, 'POST', `/v1/venues/${encodeURIComponent(cfg.venueId)}/shipment-promises`, buildPromiseBody(dropoff, cfg));
  const eta = data?.dropoff?.eta_minutes ?? data?.time_estimate_minutes ?? null;
  return {
    id: data.id,
    validUntil: data.valid_until || null,
    feeEur: amountToEur(data.price),
    etaMinutes: eta == null ? null : Number(eta),
    isBinding: !!data.is_binding,
    dropoff: {
      lat: data?.dropoff?.location?.coordinates?.lat ?? null,
      lon: data?.dropoff?.location?.coordinates?.lon ?? null,
      formattedAddress: data?.dropoff?.location?.formatted_address || '',
    },
  };
}

/** Objedná kuriéra na potvrdenú objednávku. */
export async function createDelivery({ promiseId, order }) {
  const cfg = woltConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') {
    const ref = 'mock-' + order.publicCode;
    return {
      woltOrderReferenceId: ref,
      deliveryId: ref,
      trackingUrl: 'https://track.wolt.com/mock/' + order.publicCode,
      status: 'INFO_RECEIVED',
      feeEur: order.deliveryFee != null ? round2(order.deliveryFee) : cfg.mockFeeEur,
      pickupEta: new Date(_internals.now().getTime() + cfg.minPrepMinutes * 60_000).toISOString(),
      dropoffEta: new Date(_internals.now().getTime() + 35 * 60_000).toISOString(),
    };
  }
  const data = await call(cfg, 'POST', `/v1/venues/${encodeURIComponent(cfg.venueId)}/deliveries`, buildDeliveryBody({ promiseId, order }, cfg));
  return {
    woltOrderReferenceId: data.wolt_order_reference_id || data.id,
    deliveryId: data.id,
    trackingUrl: data?.tracking?.url || '',
    status: data.status || 'INFO_RECEIVED',
    feeEur: amountToEur(data.price),
    pickupEta: data?.pickup?.eta || null,
    dropoffEta: data?.dropoff?.eta || null,
  };
}

export async function cancelDelivery(woltOrderReferenceId) {
  const cfg = woltConfig();
  assertConfigured(cfg);
  if (cfg.mode === 'mock') return { ok: true };
  await call(cfg, 'PATCH', `/order/${encodeURIComponent(woltOrderReferenceId)}/status/cancel`);
  return { ok: true };
}

/**
 * Webhook prichádza ako { token: "<JWT HS256>" }, podpísaný client_secret-om,
 * ktorý sme zadali pri registrácii webhooku. Neplatný podpis = výnimka.
 */
export function verifyWebhookToken(token) {
  const cfg = woltConfig();
  if (!cfg.webhookSecret) throw new WoltError('WOLT_WEBHOOK_SECRET nie je nastavený', { status: 503 });
  try {
    return jwt.verify(String(token), cfg.webhookSecret, { algorithms: ['HS256'] });
  } catch (e) {
    throw new WoltError('Neplatný podpis webhooku: ' + e.message, { status: 401 });
  }
}

/** Ktorý stav objednávky u nás zodpovedá udalosti Woltu. null = stav sa nemení. */
export function statusForWebhookType(type) {
  switch (type) {
    case 'order.delivered':
    case 'order.dropoff_completed':
      return 'delivered';
    case 'order.rejected':
      // Wolt kuriéra nedal — objednávka sa vracia obsluhe, nech to vyrieši.
      return 'confirmed';
    default:
      return null;
  }
}

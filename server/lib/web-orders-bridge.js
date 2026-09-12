// Most kasa ↔ Neon pre online objednávky z webu.
//
// surfspirit.sk beží na Websupporte (PHP), kasa je za NAT-om bez verejnej
// adresy. Web preto objednávky zapisuje do Neon (tabuľka web_orders, plní ju
// web/objednavky-api.php) a kasa si ich odtiaľto sama každých pár sekúnd
// vyzdvihne — vzniknú z nich bežné online_orders (KDS pohľad ROZVOZ, admin,
// kuriér cez Wolt — nič z toho sa nemení). Stav zapisuje späť, aby ho videl
// zákazník. Popri tom drží na Neon menu s id položiek (guest_menu) a
// „heartbeat" konfigurácie: keď kasa dlhšie nepíše, web hlási, že doručenie
// nie je dostupné.
//
// Všetko sú ODCHÁDZAJÚCE spojenia z kasy — nič sa neotvára na routri.
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { onlineOrders, onlineOrderEvents } from '../db/schema.js';
import { woltConfig } from './wolt-drive.js';
import { applyWoltEvent } from './online-order-status.js';
import { emitEventIo } from './emit.js';

const TAG = '[web-orders]';

export function bridgeConfig() {
  const url = process.env.NEON_DATABASE_URL || '';
  const off = (v) => /^(0|false|off|no)$/i.test(String(v || ''));
  return {
    enabled: !!url && !off(process.env.WEB_ORDERS_BRIDGE || '1'),
    url,
    pollMs: Math.max(3000, Number(process.env.WEB_ORDERS_POLL_MS) || 8000),
    menuSync: !off(process.env.WEB_MENU_SYNC || '1'),
    menuSyncMs: Math.max(60_000, Number(process.env.WEB_MENU_SYNC_MS) || 10 * 60_000),
    // Po zmene menu zhodí 60 s cache api.php na webe, nech sa zmena ukáže hneď.
    cacheBustUrl: process.env.WEB_MENU_CACHE_BUST_URL ?? 'https://surfspirit.sk/api.php?action=all&fresh=1',
  };
}

/** Neon má v URL sslmode=require; pg by ho bral ako verify-full s varovaním — nastavíme TLS explicitne. */
function poolFor(url) {
  let conn = url;
  try { const u = new URL(url); u.searchParams.delete('sslmode'); conn = u.toString(); } catch { /* nechaj pôvodnú */ }
  const local = /localhost|127\.0\.0\.1/.test(conn);
  return new pg.Pool({
    connectionString: conn,
    ssl: local ? false : { rejectUnauthorized: true },
    max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
  });
}

/** Riadok web_orders (snake_case z Neon) → hodnoty pre lokálne online_orders. */
export function toLocalOrder(w) {
  return {
    publicCode: w.public_code,
    status: 'new',
    customerName: w.customer_name,
    customerPhone: w.customer_phone,
    customerEmail: w.customer_email || '',
    dropoffStreet: w.dropoff_street,
    dropoffCity: w.dropoff_city,
    dropoffPostCode: w.dropoff_post_code,
    dropoffComment: w.dropoff_comment || '',
    dropoffLat: w.dropoff_lat == null ? null : String(w.dropoff_lat),
    dropoffLon: w.dropoff_lon == null ? null : String(w.dropoff_lon),
    items: Array.isArray(w.items) ? w.items : [],
    subtotal: String(w.subtotal),
    deliveryFee: String(w.delivery_fee ?? 0),
    total: String(w.total),
    paymentMethod: w.payment_method,
    note: w.note || '',
    scheduledFor: w.scheduled_for ? new Date(w.scheduled_for) : null,
    woltPromiseId: w.wolt_promise_id || null,
    woltPromiseValidUntil: w.wolt_promise_valid_until ? new Date(w.wolt_promise_valid_until) : null,
    clientIp: w.client_ip || '',
    webOrderId: Number(w.id),
    // Obe pečiatky z hodín Node-u (nie DB default now()): stav sa posiela späť,
    // keď updated_at > web_synced_at, a routy nastavujú updatedAt tiež z Node-u.
    updatedAt: new Date(),
    webSyncedAt: new Date(),
  };
}

/** Konfigurácia, ktorú web číta z Neon (rovnaký tvar ako GET /api/public/online-orders/config). */
export function webConfigPayload() {
  const cfg = woltConfig();
  return {
    deliveryEnabled: cfg.enabled,
    mode: cfg.mode,
    paymentMethods: cfg.cashOnDelivery ? ['cash', 'transfer'] : ['transfer'],
    minOrderEur: Number(process.env.ONLINE_ORDER_MIN_EUR || 10),
    pickup: { name: cfg.pickup.name, street: cfg.pickup.street, city: cfg.pickup.city },
    minPrepMinutes: cfg.minPrepMinutes,
    mockFeeEur: cfg.mockFeeEur,
    kasaAt: new Date().toISOString(),
  };
}

const MENU_SQL = sql`
  SELECT CASE WHEN c.slug = 'cat_1776806631615' THEN 'capovane' ELSE c.slug END AS category_slug,
         c.label AS category_label, c.icon AS category_icon, c.sort_key::text AS category_sort,
         mi.id AS pos_item_id, mi.name AS item_name, mi.emoji AS item_emoji, mi.price AS item_price,
         COALESCE(mi.desc, '') AS item_desc, mi.vat_rate
  FROM menu_items mi
  JOIN menu_categories c ON c.id = mi.category_id
  WHERE mi.active = true
    AND mi.name NOT IN ('Záloha fľaša', 'Omáčka (combo)')
    AND c.slug <> 'cisla'
  ORDER BY c.sort_key, mi.name`;

/**
 * Vytvorí most. Oddelené od štartu kvôli testom — tie si podstrčia vlastnú
 * URL (lokálny Postgres s rovnakými tabuľkami) a falošné io.
 */
export function createBridge({ url, io = null, cacheBustUrl = '', fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const pool = poolFor(url);
  let running = false;
  let lastMenuHash = null;

  async function pullNewOrders() {
    const { rows } = await pool.query('SELECT * FROM web_orders WHERE imported_at IS NULL ORDER BY id LIMIT 20');
    let imported = 0;
    for (const w of rows) {
      let local = null;
      try {
        [local] = await db.insert(onlineOrders).values(toLocalOrder(w)).returning();
      } catch (e) {
        // Kolízia kódu s lokálnou objednávkou je prakticky nemožná (32^5) —
        // ale nesmie nás zacykliť: označíme prevzaté bez POS id a zalogujeme.
        log(TAG, 'import objednávky', w.public_code, 'zlyhal:', e.message);
      }
      await pool.query('UPDATE web_orders SET imported_at = now(), pos_online_order_id = $2 WHERE id = $1', [w.id, local ? local.id : null]);
      if (!local) continue;
      await db.insert(onlineOrderEvents).values({ onlineOrderId: local.id, type: 'created', payload: { source: 'web', webOrderId: Number(w.id), ip: w.client_ip || '' } });
      emitEventIo(io, 'online-order:new', {
        id: local.id, code: local.publicCode, total: Number(local.total), customerName: local.customerName, itemCount: local.items.length,
      }).catch(() => {});
      imported++;
    }
    return imported;
  }

  async function pullEvents() {
    const { rows } = await pool.query(`
      SELECT e.id, e.type, e.payload, o.pos_online_order_id, o.imported_at
      FROM web_order_events e JOIN web_orders o ON o.id = e.web_order_id
      WHERE e.processed_at IS NULL AND e.type LIKE 'wolt:%'
      ORDER BY e.id LIMIT 50`);
    let applied = 0;
    for (const ev of rows) {
      if (!ev.imported_at) continue; // objednávka ešte nie je prevzatá — udalosť počká
      if (ev.pos_online_order_id) {
        const [o] = await db.select().from(onlineOrders).where(eq(onlineOrders.id, ev.pos_online_order_id)).limit(1);
        if (o) { await applyWoltEvent(io, o, String(ev.type).replace(/^wolt:/, ''), ev.payload || {}); applied++; }
      }
      await pool.query('UPDATE web_order_events SET processed_at = now() WHERE id = $1', [ev.id]);
    }
    return applied;
  }

  async function pushLocalChanges() {
    const rows = await db.select().from(onlineOrders).where(sql`
      ${onlineOrders.webOrderId} IS NOT NULL
      AND (${onlineOrders.webSyncedAt} IS NULL OR ${onlineOrders.updatedAt} > ${onlineOrders.webSyncedAt})`);
    for (const o of rows) {
      await pool.query(`
        UPDATE web_orders SET status = $2, wolt_status = $3, wolt_order_reference_id = $4, wolt_tracking_url = $5,
          confirmed_at = $6, ready_at = $7, rejected_reason = $8, updated_at = now()
        WHERE id = $1`,
      [o.webOrderId, o.status, o.woltStatus, o.woltOrderReferenceId, o.woltTrackingUrl, o.confirmedAt, o.readyAt, o.rejectedReason]);
      // Synced = presne tá verzia, ktorú sme poslali; neskoršia zmena má updated_at väčší.
      await db.update(onlineOrders).set({ webSyncedAt: o.updatedAt }).where(eq(onlineOrders.id, o.id));
    }
    return rows.length;
  }

  async function pushConfig() {
    await pool.query(`
      INSERT INTO web_delivery_config (key, value, updated_at) VALUES ('config', $1, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(webConfigPayload())]);
  }

  async function syncMenu({ force = false } = {}) {
    const res = await db.execute(MENU_SQL);
    const rows = res.rows || [];
    const hash = JSON.stringify(rows);
    if (!force && hash === lastMenuHash) return { changed: false, count: rows.length };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM guest_menu');
      if (rows.length) {
        const cols = ['category_slug', 'category_label', 'category_icon', 'category_sort', 'item_name', 'item_emoji', 'item_price', 'item_desc', 'active', 'pos_item_id', 'vat_rate'];
        const values = [];
        const placeholders = rows.map((r, i) => {
          values.push(r.category_slug, r.category_label, r.category_icon, r.category_sort, r.item_name, r.item_emoji, r.item_price, r.item_desc, true, r.pos_item_id, r.vat_rate);
          const base = i * cols.length;
          return '(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')';
        });
        await client.query(`INSERT INTO guest_menu (${cols.join(',')}) VALUES ${placeholders.join(',')}`, values);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    lastMenuHash = hash;
    if (cacheBustUrl && fetchImpl) {
      try { await fetchImpl(cacheBustUrl, { signal: AbortSignal.timeout(6000) }); } catch (e) { log(TAG, 'cache bust webu zlyhal:', e.message); }
    }
    return { changed: true, count: rows.length };
  }

  /** Jeden cyklus: udalosti → nové objednávky → stav späť → heartbeat. */
  async function tick() {
    if (running) return null;
    running = true;
    try {
      const events = await pullEvents();
      const imported = await pullNewOrders();
      const pushed = await pushLocalChanges();
      await pushConfig();
      return { events, imported, pushed };
    } finally {
      running = false;
    }
  }

  return { tick, syncMenu, pullNewOrders, pullEvents, pushLocalChanges, pushConfig, close: () => pool.end() };
}

let _bridge = null;
let _timer = null;
let _menuTimer = null;

export function startWebOrdersBridge(app) {
  const cfg = bridgeConfig();
  if (!cfg.enabled) {
    console.log(TAG, 'vypnutý (chýba NEON_DATABASE_URL alebo WEB_ORDERS_BRIDGE=0)');
    return null;
  }
  _bridge = createBridge({ url: cfg.url, io: app.get('io'), cacheBustUrl: cfg.cacheBustUrl });
  console.log(TAG, `zapnutý — objednávky každých ${cfg.pollMs / 1000} s, menu ${cfg.menuSync ? 'každých ' + Math.round(cfg.menuSyncMs / 60000) + ' min' : 'ručne'}`);

  let failures = 0;
  const run = async () => {
    try {
      const r = await _bridge.tick();
      if (r && (r.imported || r.events)) console.log(TAG, `prevzaté ${r.imported}, udalosti ${r.events}, stav späť ${r.pushed}`);
      failures = 0;
    } catch (e) {
      // Prvé zlyhanie zalogujeme hneď, ďalšie len raz za minútu — Neon môže
      // chvíľu spať alebo vypadnúť internet, netreba tým zaplaviť log.
      failures++;
      if (failures === 1 || failures % Math.max(1, Math.round(60_000 / cfg.pollMs)) === 0) console.error(TAG, 'chyba:', e.message);
    }
  };
  const runMenu = async () => {
    try {
      const r = await _bridge.syncMenu();
      if (r.changed) console.log(TAG, `menu na webe obnovené (${r.count} položiek)`);
    } catch (e) { console.error(TAG, 'sync menu zlyhal:', e.message); }
  };

  setTimeout(run, 2000);
  _timer = setInterval(run, cfg.pollMs);
  if (cfg.menuSync) {
    setTimeout(runMenu, 5000);
    _menuTimer = setInterval(runMenu, cfg.menuSyncMs);
  }
  return _bridge;
}

export function stopWebOrdersBridge() {
  clearInterval(_timer); clearInterval(_menuTimer);
  _timer = _menuTimer = null;
  const b = _bridge; _bridge = null;
  return b ? b.close() : Promise.resolve();
}

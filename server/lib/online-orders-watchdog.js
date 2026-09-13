// Strážca online objednávok — beží každých 15 s na serveri, nie na obrazovke,
// takže nezáleží na tom, ktorý tablet je práve zapnutý:
//  • nová objednávka bez reakcie: po minúte úroveň 1 (KDS sa prepne na ROZVOZ,
//    kasa zčervenie), po dvoch úroveň 2 (Telegram manažérovi);
//  • objednávka z aplikácie Wolt s termínom na prijatie: 30 s pred termínom ju
//    odmietne s dôvodom — tichá automatická odmena Woltu bolí viac;
//  • predobjednávky: v čase fire_at založí účet, vytlačí bon a zavolá kuriéra.
import { and, eq, isNull, isNotNull, lte, lt, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { onlineOrders } from '../db/schema.js';
import { emitEventIo } from './emit.js';
import { sendAlert } from './alerts.js';
import { addEvent, fireOrder } from './online-order-fire.js';
import { rejectOrder as woltRejectOrder } from './wolt-order-api.js';

const TAG = '[watchdog]';
const LOCK_TTL_MS = 30_000;

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}
export function watchdogConfig() {
  return {
    intervalMs: Math.max(5000, Number(env('ONLINE_ORDER_WATCHDOG_MS', '15000')) || 15000),
    level1S: Number(env('ONLINE_ORDER_ESCALATE_S', '60')) || 60,
    level2S: Number(env('ONLINE_ORDER_ALERT_S', '120')) || 120,
    autoReject: !/^(0|false|off|no)$/i.test(env('WOLT_ORDER_AUTO_REJECT', '1')),
    autoRejectReason: env('WOLT_ORDER_AUTO_REJECT_REASON', 'Kuchyňa je preťažená, skúste neskôr'),
  };
}

function srcLabel(o) { return o.source === 'wolt' ? 'Wolt' : 'web'; }

async function autoReject(io, o, reason) {
  // Ten istý zámok ako routy — ak to práve niekto prijíma, strážca ustúpi.
  const [locked] = await db.update(onlineOrders)
    .set({ processingAt: new Date(), processingBy: null })
    .where(and(eq(onlineOrders.id, o.id), eq(onlineOrders.status, 'new'),
      or(isNull(onlineOrders.processingAt), lt(onlineOrders.processingAt, new Date(Date.now() - LOCK_TTL_MS)))))
    .returning();
  if (!locked) return false;
  try {
    await woltRejectOrder(o.woltOrderId, reason);
  } catch (e) {
    await db.update(onlineOrders).set({ processingAt: null }).where(eq(onlineOrders.id, o.id));
    throw e;
  }
  await db.update(onlineOrders).set({ status: 'rejected', rejectedReason: reason, processingAt: null, updatedAt: new Date() }).where(eq(onlineOrders.id, o.id));
  await addEvent(o.id, 'rejected', { auto: true, reason });
  await emitEventIo(io, 'online-order:updated', { id: o.id, code: o.publicCode, status: 'rejected', auto: true }).catch(() => {});
  sendAlert('⛔ Objednávku ' + o.publicCode + ' z Woltu (' + o.customerName + ', ' + Number(o.total).toFixed(2) + ' €) nikto neprijal — pred termínom Woltu bola automaticky odmietnutá („' + reason + '").').catch(() => {});
  return true;
}

/** Jeden prechod. `now` sa dá podstrčiť v testoch. */
export async function watchdogTick(io, cfg = watchdogConfig(), now = new Date()) {
  const out = { escalated: 0, alerted: 0, autoRejected: 0, fired: 0, errors: [] };

  // 1) Nové objednávky bez reakcie
  const fresh = await db.select().from(onlineOrders).where(eq(onlineOrders.status, 'new'));
  for (const o of fresh) {
    try {
      if (o.source === 'wolt' && o.acceptDeadlineAt && cfg.autoReject && now.getTime() >= new Date(o.acceptDeadlineAt).getTime() - 30_000) {
        if (await autoReject(io, o, cfg.autoRejectReason)) out.autoRejected++;
        continue;
      }
      const ageS = (now.getTime() - new Date(o.createdAt).getTime()) / 1000;
      let level = o.escalationLevel || 0;
      if (ageS >= cfg.level2S && level < 2) level = 2;
      else if (ageS >= cfg.level1S && level < 1) level = 1;
      if (level === (o.escalationLevel || 0)) continue;
      // escalation_level bez updated_at — zákazníka sa to netýka, most netreba budiť.
      await db.update(onlineOrders).set({ escalationLevel: level }).where(eq(onlineOrders.id, o.id));
      await addEvent(o.id, 'escalated', { level, ageS: Math.round(ageS) });
      await emitEventIo(io, 'online-order:alert', { id: o.id, code: o.publicCode, level, source: o.source, ageS: Math.round(ageS) }).catch(() => {});
      out.escalated++;
      if (level === 2) {
        out.alerted++;
        sendAlert('⚠️ Objednávka ' + o.publicCode + ' (' + srcLabel(o) + ', ' + o.customerName + ', ' + Number(o.total).toFixed(2) + ' €) čaká už ' + Math.round(ageS / 60) + ' min — nikto ju neprijal na KDS ani na kase.').catch(() => {});
      }
    } catch (e) {
      out.errors.push(o.publicCode + ': ' + e.message);
    }
  }

  // 2) Predobjednávky: čas odpálenia
  const due = await db.select().from(onlineOrders).where(and(
    eq(onlineOrders.status, 'confirmed'), isNotNull(onlineOrders.fireAt), isNull(onlineOrders.firedAt), lte(onlineOrders.fireAt, now),
  ));
  for (const o of due) {
    try {
      // fired_at sa nastaví hneď v fireOrder — druhý prechod ju nevezme znova.
      await fireOrder(io, o, { staffId: o.confirmedBy, staffName: 'Plán' });
      emitEventIo(io, 'online-order:updated', { id: o.id, code: o.publicCode, status: o.status, fired: true }).catch(() => {});
      out.fired++;
    } catch (e) {
      out.errors.push(o.publicCode + ' (fire): ' + e.message);
    }
  }
  return out;
}

let _timer = null;
export function startOnlineOrdersWatchdog(app) {
  const cfg = watchdogConfig();
  clearInterval(_timer);
  _timer = setInterval(async () => {
    try {
      const r = await watchdogTick(app.get('io'), cfg);
      if (r.escalated || r.autoRejected || r.fired) console.log(TAG, `eskalované ${r.escalated}, auto-odmietnuté ${r.autoRejected}, odpálené predobjednávky ${r.fired}`);
      if (r.errors.length) console.error(TAG, r.errors.join(' | '));
    } catch (e) { console.error(TAG, 'chyba:', e.message); }
  }, cfg.intervalMs);
  console.log(TAG, `zapnutý — eskalácia po ${cfg.level1S} s, správa manažérovi po ${cfg.level2S} s, auto-odmietnutie Wolt ${cfg.autoReject ? 'áno' : 'nie'}`);
}
export function stopOnlineOrdersWatchdog() { clearInterval(_timer); _timer = null; }

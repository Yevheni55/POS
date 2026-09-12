// Spracovanie udalosti Woltu nad online objednávkou — spoločné pre priamy
// webhook (routes/online-orders-public.js) aj pre most cez Neon
// (lib/web-orders-bridge.js), aby mapovanie stavov žilo na jednom mieste.
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { onlineOrders, onlineOrderEvents } from '../db/schema.js';
import { statusForWebhookType } from './wolt-drive.js';
import { emitEventIo } from './emit.js';

/**
 * Zapíše udalosť kuriéra do lokálnej objednávky a upozorní KDS/admin.
 * @param {object|null} io      socket.io server (môže chýbať — napr. v testoch)
 * @param {object} o            riadok online_orders (camelCase)
 * @param {string} type         napr. 'order.delivered'
 * @param {object} details      `details` z webhooku
 */
export async function applyWoltEvent(io, o, type, details) {
  const d = details || {};
  const patch = { woltStatus: String(type || '').replace(/^order\./, '') || o.woltStatus, updatedAt: new Date() };
  const next = statusForWebhookType(type);
  if (next && !['rejected', 'cancelled'].includes(o.status)) patch.status = next;
  if (d.tracking?.url) patch.woltTrackingUrl = d.tracking.url;

  await db.update(onlineOrders).set(patch).where(eq(onlineOrders.id, o.id));
  await db.insert(onlineOrderEvents).values({ onlineOrderId: o.id, type: 'wolt:' + (type || 'unknown'), payload: d });
  emitEventIo(io, 'online-order:updated', {
    id: o.id, code: o.publicCode, status: patch.status || o.status, woltStatus: patch.woltStatus,
  }).catch(() => {});
  return patch;
}

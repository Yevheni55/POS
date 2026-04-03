import { orderEvents } from '../db/schema.js';

/**
 * Log a single audit event for an order.
 * @param {object} txOrDb - Drizzle transaction handle or db instance
 * @param {object} params
 * @param {number} params.orderId
 * @param {string} params.type - event type (e.g. 'item_added', 'order_created')
 * @param {object} params.payload - arbitrary data to record
 * @param {number} params.staffId
 */
export async function logEvent(txOrDb, { orderId, type, payload, staffId }) {
  await txOrDb.insert(orderEvents).values({
    orderId,
    type,
    payload: JSON.stringify(payload),
    staffId,
  });
}

/**
 * Log multiple audit events in a single insert.
 * @param {object} txOrDb - Drizzle transaction handle or db instance
 * @param {Array} events - array of { orderId, type, payload, staffId }
 */
export async function logEvents(txOrDb, events) {
  if (!events.length) return;
  await txOrDb.insert(orderEvents).values(
    events.map(e => ({
      orderId: e.orderId,
      type: e.type,
      payload: JSON.stringify(e.payload),
      staffId: e.staffId,
    }))
  );
}

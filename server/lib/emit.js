import { db } from '../db/index.js';
import { events } from '../db/schema.js';

/**
 * Emit a WebSocket event and persist it to the events table.
 * Returns the persisted event with its ID.
 */
export async function emitEvent(req, event, data) {
  return emitEventIo(req.app.get('io'), event, data);
}

/** To isté bez `req` — pre workery na pozadí (napr. most web ↔ kasa), ktoré majú len `io`. */
export async function emitEventIo(io, event, data) {
  let eventId = null;
  try {
    const [row] = await db.insert(events).values({
      type: event,
      payload: JSON.stringify(data),
    }).returning();
    eventId = row.id;
  } catch (e) {
    console.error('Event persist error:', e);
  }

  if (io) io.emit(event, { ...data, _eventId: eventId });
  return eventId;
}

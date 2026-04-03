import { db } from '../db/index.js';
import { events } from '../db/schema.js';

/**
 * Emit a WebSocket event and persist it to the events table.
 * Returns the persisted event with its ID.
 */
export async function emitEvent(req, event, data) {
  const io = req.app.get('io');

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

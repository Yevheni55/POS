import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { printQueue } from '../../db/schema.js';
import { processQueue } from './queue.js';

// GET /api/print/queue — view pending print jobs
export async function queueListHandler(req, res) {
  try {
    const pending = await db.select().from(printQueue)
      .where(eq(printQueue.status, 'pending'))
      .orderBy(printQueue.createdAt);
    res.json({ count: pending.length, jobs: pending });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// POST /api/print/queue/retry — force retry all pending jobs now
export async function queueRetryHandler(req, res) {
  try {
    await db.update(printQueue)
      .set({ nextRetryAt: new Date() })
      .where(eq(printQueue.status, 'pending'));
    processQueue();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// DELETE /api/print/queue/:id — remove a queued job
export async function queueDeleteHandler(req, res) {
  try {
    await db.delete(printQueue).where(eq(printQueue.id, parseInt(req.params.id)));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

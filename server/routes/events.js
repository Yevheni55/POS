import { Router } from 'express';
import { db } from '../db/index.js';
import { events } from '../db/schema.js';
import { gt } from 'drizzle-orm';

const router = Router();

// GET /api/events?since=ID&limit=100 — replay events since a given ID
router.get('/', async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  const rows = await db.select().from(events)
    .where(gt(events.id, since))
    .orderBy(events.id)
    .limit(limit);

  res.json({
    events: rows.map(r => ({ ...r, payload: JSON.parse(r.payload) })),
    lastId: rows.length ? rows[rows.length - 1].id : since,
  });
});

export default router;

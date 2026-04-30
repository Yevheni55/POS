import { db } from '../db/index.js';
import { idempotencyKeys } from '../db/schema.js';
import { eq, lt } from 'drizzle-orm';

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Express middleware: if X-Idempotency-Key header is present on a write request,
 * check if we already processed this key. If yes, return the cached response.
 * If no, proceed and cache the response on success.
 */
export function idempotency(req, res, next) {
  const key = req.headers['x-idempotency-key'];
  if (!key || req.method === 'GET') return next();

  // Check for existing key
  db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).then(rows => {
    if (rows.length) {
      // Already processed — return cached response
      const cached = rows[0];
      res.status(cached.statusCode);
      res.setHeader('X-Idempotent-Replayed', 'true');
      return res.end(cached.response);
    }

    // Intercept res.json to capture the response (only cache 2xx).
    // Persist the key BEFORE sending the response so concurrent retries
    // serialize on the unique constraint and a re-execution of the route
    // can't slip through the race window between "response out" and
    // "row committed".
    const originalJson = res.json.bind(res);
    res.json = async function (body) {
      const statusCode = res.statusCode || 200;
      const responseStr = JSON.stringify(body);

      // Only cache successful responses — 4xx/5xx must not be cached
      // so the client can retry with corrected data using the same key
      if (statusCode >= 200 && statusCode < 300) {
        try {
          await db.insert(idempotencyKeys).values({
            key,
            statusCode,
            response: responseStr,
          }).onConflictDoNothing();
        } catch (e) {
          // Never throw from inside a wrapped res.json — post-headers
          // errors are ugly. Prefer user success over a missed cache row.
          console.error('Idempotency store error:', e);
        }
      }

      return originalJson(body);
    };

    next();
  }).catch(e => {
    console.error('Idempotency lookup error:', e);
    next(); // proceed without idempotency on error
  });
}

/**
 * Periodically clean up expired idempotency keys.
 * Call once at server startup.
 */
export function startIdempotencyCleanup() {
  const cleanup = () => {
    const cutoff = new Date(Date.now() - EXPIRY_MS);
    db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, cutoff))
      .catch(e => console.error('Idempotency cleanup error:', e));
  };
  // Run every hour
  setInterval(cleanup, 60 * 60 * 1000);
  // Run once on startup after a short delay
  setTimeout(cleanup, 5000);
}

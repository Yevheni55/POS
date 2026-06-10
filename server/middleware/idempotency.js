import { db } from '../db/index.js';
import { idempotencyKeys } from '../db/schema.js';
import { and, eq, lt } from 'drizzle-orm';

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const PENDING_MS = 90 * 1000; // pending claim older than this is considered stuck
const PENDING = 0; // statusCode sentinel: key claimed, handler still running

// Keys whose handler is running in THIS process right now. The PENDING_MS
// takeover is a safety valve for a *dead* process — a live handler (slow
// Portos fiscalization can legally exceed 90 s) must never be taken over,
// or the payment executes twice concurrently.
const activeClaims = new Set();

/**
 * Express middleware: if X-Idempotency-Key header is present on a write request,
 * RESERVE the key at request start (pending row) so a concurrent retry with the
 * same key cannot re-execute the handler while the first request is still
 * running (e.g. a slow Portos fiscalization). Behaviour:
 *
 *   - new key            → claim it (statusCode = PENDING), run the handler
 *   - key pending        → 409 { error: 'processing' } (client polls/retries)
 *   - key completed      → replay stored status + body (application/json)
 *   - key completed but a different method+path → 409 { error: 'idempotency key reuse' }
 *   - pending older than PENDING_MS → take it over (server died mid-request)
 *
 * On handler completion the claim is updated with the response (2xx only);
 * 4xx/5xx release the claim so the client can retry with corrected data.
 * If the handler finishes the response without res.json the claim is released
 * on 'finish'. A client abort does NOT release the claim — the handler keeps
 * running and settles when done; truly stuck keys fall to the PENDING_MS
 * takeover (guarded by activeClaims against live in-process handlers).
 */
export function idempotency(req, res, next) {
  const key = req.headers['x-idempotency-key'];
  if (!key || req.method === 'GET') return next();

  // method+path scope — the same key reused on a different endpoint is a bug,
  // not a retry, and must not replay a foreign response.
  const scope = `${req.method} ${(req.originalUrl || req.url || '').split('?')[0]}`;

  claimOrReplay(req, res, key, scope)
    .then((claimed) => { if (claimed) next(); })
    .catch((e) => {
      console.error('Idempotency lookup error:', e);
      next(); // proceed without idempotency on error
    });
}

/**
 * Envelope stored in the `response` column (v2):
 *   pending:   { "__v": 2, "scope": "POST /api/payments" }
 *   completed: { "__v": 2, "scope": "POST /api/payments", "body": "<json string>" }
 * Rows written by the previous middleware hold the raw response body string —
 * parseEnvelope() returns null for those (legacy replay without scope check).
 */
function parseEnvelope(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.__v === 2 && typeof parsed.scope === 'string') return parsed;
  } catch (e) { /* legacy raw body */ }
  return null;
}

/** Replay a stored response with the original status and JSON content type. */
function replay(res, statusCode, bodyStr) {
  res.status(statusCode);
  res.setHeader('X-Idempotent-Replayed', 'true');
  res.type('application/json');
  return res.send(bodyStr);
}

/**
 * Try to claim the key (or replay/reject). Returns true when WE hold the
 * claim and the handler should run; false when a response was already sent.
 * Two attempts cover the race where a concurrent request releases the row
 * between our failed insert and the follow-up select.
 */
async function claimOrReplay(req, res, key, scope) {
  for (let attempt = 0; attempt < 2; attempt++) {
    // createdAt is set explicitly (not DB defaultNow) so the completion /
    // cleanup queries below can target exactly OUR claim row and never a
    // newer takeover of the same key.
    const claimTs = new Date();
    const claimed = await db.insert(idempotencyKeys).values({
      key,
      statusCode: PENDING,
      response: JSON.stringify({ __v: 2, scope }),
      createdAt: claimTs,
    }).onConflictDoNothing().returning({ key: idempotencyKeys.key });

    if (claimed.length) {
      armCapture(res, key, scope, claimTs);
      return true;
    }

    const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    if (!rows.length) continue; // row released between insert and select — re-claim

    const row = rows[0];

    if (row.statusCode === PENDING) {
      // Safety valve: a pending row older than PENDING_MS means the original
      // server/process died mid-request — take the claim over atomically.
      // Never take over a claim whose handler still runs in this process.
      const cutoff = new Date(Date.now() - PENDING_MS);
      if (row.createdAt && row.createdAt < cutoff && !activeClaims.has(key)) {
        const takeTs = new Date();
        const taken = await db.update(idempotencyKeys)
          .set({ statusCode: PENDING, response: JSON.stringify({ __v: 2, scope }), createdAt: takeTs })
          .where(and(
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.statusCode, PENDING),
            lt(idempotencyKeys.createdAt, cutoff),
          ))
          .returning({ key: idempotencyKeys.key });
        if (taken.length) {
          armCapture(res, key, scope, takeTs);
          return true;
        }
      }
      // Original request is still in flight — client polls/retries same key.
      res.status(409).json({ error: 'processing' });
      return false;
    }

    // Completed record.
    const envelope = parseEnvelope(row.response);
    if (envelope && envelope.scope !== scope) {
      res.status(409).json({ error: 'idempotency key reuse' });
      return false;
    }
    const bodyStr = envelope ? (envelope.body != null ? envelope.body : '{}') : row.response;
    replay(res, row.statusCode, bodyStr);
    return false;
  }

  // Could not claim nor inspect the key twice in a row — tell the client to retry.
  res.status(409).json({ error: 'processing' });
  return false;
}

/**
 * Wrap res.json to settle OUR claim row: store the response on 2xx, release
 * the claim on 4xx/5xx, and release on 'finish'/'close' when the handler
 * never produced a JSON response (exception / connection abort).
 */
function armCapture(res, key, scope, claimTs) {
  let settled = false;
  activeClaims.add(key);

  // Targets exactly the row we claimed — a takeover (newer createdAt) or an
  // already-released row is left untouched.
  const ourClaim = and(
    eq(idempotencyKeys.key, key),
    eq(idempotencyKeys.statusCode, PENDING),
    eq(idempotencyKeys.createdAt, claimTs),
  );

  const originalJson = res.json.bind(res);
  res.json = async function (body) {
    if (settled) return originalJson(body);
    settled = true;
    activeClaims.delete(key);
    const statusCode = res.statusCode || 200;
    try {
      if (statusCode >= 200 && statusCode < 300) {
        // Persist BEFORE sending the response so concurrent retries
        // serialize on the row and a re-execution of the route can't slip
        // through the race window between "response out" and "row committed".
        await db.update(idempotencyKeys)
          .set({ statusCode, response: JSON.stringify({ __v: 2, scope, body: JSON.stringify(body) }) })
          .where(ourClaim);
      } else {
        // 4xx/5xx must not be cached — release the claim so the client can
        // retry with corrected data using the same key.
        await db.delete(idempotencyKeys).where(ourClaim);
      }
    } catch (e) {
      // Never throw from inside a wrapped res.json — post-headers
      // errors are ugly. Prefer user success over a missed cache row.
      console.error('Idempotency store error:', e);
    }
    return originalJson(body);
  };

  // Handler finished the response without ever calling res.json (res.send,
  // streamed reply, error middleware using res.end) — release the claim so a
  // retry can execute. Deliberately NOT wired to 'close': 'close' fires on a
  // client abort while the handler is still running (slow Portos), and
  // releasing there would let a same-key retry re-execute the payment
  // concurrently. After an abort the handler still settles through res.json
  // when it completes; if it never does, the PENDING_MS takeover applies.
  const releaseIfUnsettled = () => {
    if (settled) return;
    settled = true;
    activeClaims.delete(key);
    db.delete(idempotencyKeys).where(ourClaim)
      .catch((e) => console.error('Idempotency release error:', e));
  };
  res.on('finish', releaseIfUnsettled);
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

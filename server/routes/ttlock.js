import { Router } from 'express';
import { createHash } from 'crypto';
import { db } from '../db/index.js';
import { wcCodes } from '../db/schema.js';
import { and, eq, gt, sql } from 'drizzle-orm';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

const CLIENT_ID = process.env.TTLOCK_CLIENT_ID;
const CLIENT_SECRET = process.env.TTLOCK_CLIENT_SECRET;
const TTLOCK_USERNAME = process.env.TTLOCK_USERNAME;
const LOCK_ID = process.env.TTLOCK_LOCK_ID;
const TTLOCK_API = 'https://euapi.ttlock.com';

// Pool kódov k WC zámku: namiesto živého TTLock volania pri každom kliknutí
// (pomalé + závisí od gateway) držíme predgenerovaný rotujúci pool kódov
// platných ~3 mesiace; pri tlači len náhodne vyberieme jeden z DB.
const POOL_SIZE = 20;
const VALIDITY_MS = 90 * 24 * 60 * 60 * 1000; // ~3 mesiace

let accessToken = null;
let tokenExpiry = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Get OAuth access token from TTLock API
 */
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  if (!CLIENT_ID || !CLIENT_SECRET || !TTLOCK_USERNAME) {
    throw new Error('TTLock credentials not configured');
  }

  // TTLock uses password grant — need user's TTLock password
  // First try with stored password, or use the client credentials approach
  const params = new URLSearchParams({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    username: TTLOCK_USERNAME,
    password: createHash('md5').update(process.env.TTLOCK_PASSWORD || '').digest('hex'),
  });

  const res = await fetch(TTLOCK_API + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();
  if (data.errcode) throw new Error('TTLock auth error: ' + (data.errmsg || data.errcode));

  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000 - 60000;
  return accessToken;
}

/**
 * Mapuje TTLock errcode na user-friendly Slovak správu. Bez tohto cashier
 * vidí "TTLock error: -3003" čo mu nič nehovorí.
 *
 * NineDigit TTLock errcodes (z verejnej API doc — incomplete, dopĺňame
 * podľa praxe):
 *   -3003 — slabá batéria zámku
 *   -3004 — gateway / zámok offline (nedosažiteľný)
 *   -3007 — duplicitný PIN (rare — generujeme random 4-digit)
 *   -3009 — gateway nereaguje
 *   -1005 — too many failed auth attempts
 *   -2012 — account nemá oprávnenie na tento lockId
 */
function explainTTLockError(errcode, errmsg) {
  const code = Number(errcode);
  const map = {
    [-3003]: 'Zámok má slabú batériu — vymeňte ju.',
    [-3004]: 'Zámok nie je dosažiteľný (offline alebo mimo WiFi gateway).',
    [-3007]: 'Tento PIN sa už používa — skús znova (vygeneruje sa nový).',
    [-3009]: 'Gateway zámku nereaguje. Reštartuj WiFi gateway.',
    [-1005]: 'Príliš veľa neúspešných pokusov. Skús o pár minút.',
    [-2012]: 'TTLock účet nemá oprávnenie na tento zámok.',
  };
  if (map[code]) return map[code] + ' (TTLock ' + code + ')';
  return 'TTLock chyba ' + (errcode || '?') + ': ' + (errmsg || 'neznáma');
}

/**
 * Vytvorí jeden custom passcode v zámku cez TTLock API.
 * Vracia { code, keyboardPwdId }. Pri duplicitnom kóde (-3007) skúša znova.
 */
async function createTtlockPasscode({ lockId, startDate, endDate, name, avoid }) {
  const token = await getAccessToken();
  const seen = avoid || new Set();

  for (let attempt = 0; attempt < 5; attempt++) {
    let code;
    do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (seen.has(code));

    const params = new URLSearchParams({
      clientId: CLIENT_ID,
      accessToken: token,
      lockId: String(lockId),
      keyboardPwd: code,
      keyboardPwdName: name || 'POS WC',
      startDate: String(startDate),
      endDate: String(endDate),
      addType: '2', // 2 = via gateway
      date: String(Date.now()),
    });

    const apiRes = await fetch(TTLOCK_API + '/v3/keyboardPwd/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await apiRes.json();

    if (!data.errcode) {
      seen.add(code);
      return { code, keyboardPwdId: data.keyboardPwdId ? String(data.keyboardPwdId) : null };
    }
    if (Number(data.errcode) === -3007) { seen.add(code); continue; } // duplicate → retry
    const err = new Error(explainTTLockError(data.errcode, data.errmsg));
    err.ttlockCode = data.errcode;
    err.ttlockMsg = data.errmsg || '';
    throw err;
  }
  throw new Error('Nepodarilo sa vygenerovať unikátny kód (5× duplicitný).');
}

/**
 * Best-effort zmazanie passcode-u v zámku (pri refille starých kódov).
 */
async function deleteTtlockPasscode(lockId, keyboardPwdId) {
  if (!keyboardPwdId) return;
  try {
    const token = await getAccessToken();
    const params = new URLSearchParams({
      clientId: CLIENT_ID,
      accessToken: token,
      lockId: String(lockId),
      keyboardPwdId: String(keyboardPwdId),
      deleteType: '2', // via gateway
      date: String(Date.now()),
    });
    await fetch(TTLOCK_API + '/v3/keyboardPwd/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (_) { /* best-effort — DB deaktiváciu spravíme aj tak */ }
}

/**
 * Vygeneruje nový pool kódov (POOL_SIZE) platných VALIDITY_MS a uloží do DB.
 * Staré aktívne kódy deaktivuje (a best-effort zmaže zo zámku).
 * Vracia počet vytvorených kódov.
 */
async function generateWcPool(lockId) {
  const now = Date.now();
  const endDate = now + VALIDITY_MS;

  // Staré aktívne kódy — zmazať zo zámku + deaktivovať v DB, nech zámok
  // nepretečie a koluje len aktuálnych 20.
  const old = await db.select().from(wcCodes).where(eq(wcCodes.active, true));
  for (const o of old) {
    await deleteTtlockPasscode(lockId, o.keyboardPwdId);
  }
  if (old.length) {
    await db.update(wcCodes).set({ active: false }).where(eq(wcCodes.active, true));
  }

  const avoid = new Set();
  let created = 0;
  const errors = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    try {
      const { code, keyboardPwdId } = await createTtlockPasscode({
        lockId, startDate: now, endDate, name: 'POS WC pool', avoid,
      });
      await db.insert(wcCodes).values({
        code,
        keyboardPwdId,
        startDate: new Date(now),
        endDate: new Date(endDate),
        active: true,
      });
      created++;
      await sleep(200); // jemný odstup proti rate-limitu zámku/gateway
    } catch (err) {
      errors.push(err.message);
      // -3004/-3009 (offline/gateway) → ďalšie pokusy nemajú zmysel, prerušíme
      if ([-3004, -3009].includes(Number(err.ttlockCode))) break;
    }
  }
  console.log('[TTLock] WC pool generated — created=%d/%d errors=%d', created, POOL_SIZE, errors.length);
  return { created, endDate, errors };
}

/**
 * Náhodne vyberie jeden platný kód z poolu. Ak je pool prázdny (prvýkrát /
 * po expirácii), lazy-vygeneruje nový pool a vyberie z neho.
 */
async function pickWcCode(lockId) {
  const now = new Date();
  const pickOne = async () => {
    const rows = await db.select().from(wcCodes)
      .where(and(eq(wcCodes.active, true), gt(wcCodes.endDate, now)))
      .orderBy(sql`random()`)
      .limit(1);
    return rows[0] || null;
  };

  let row = await pickOne();
  if (!row) {
    console.log('[TTLock] WC pool prázdny — lazy generujem nový pool');
    await generateWcPool(lockId);
    row = await pickOne();
  }
  return row;
}

/**
 * POST /api/ttlock/passcode
 * Vráti náhodný kód z predgenerovaného poolu (rýchle, bez TTLock volania).
 * Zachováva pôvodný kontrakt { passcode, startDate, endDate } — POS web aj
 * Android čítajú tieto polia bez zmeny klienta.
 */
router.post('/passcode', async (req, res) => {
  const startTs = Date.now();
  try {
    const lockId = req.body.lockId || LOCK_ID;
    if (!lockId) {
      return res.status(400).json({ error: 'Lock ID nie je nastavené (TTLOCK_LOCK_ID v .env)' });
    }
    const row = await pickWcCode(lockId);
    if (!row) {
      return res.status(502).json({ error: 'Pool kódov je prázdny a nepodarilo sa vygenerovať nový (zámok offline?).' });
    }
    console.log('[TTLock] WC code served from pool — code=%s elapsed=%dms', row.code, Date.now() - startTs);
    res.json({
      passcode: row.code,
      startDate: new Date(row.startDate).getTime(),
      endDate: new Date(row.endDate).getTime(),
      fromPool: true,
    });
  } catch (err) {
    console.error('[TTLock] passcode EXCEPTION — %s elapsed=%dms', err.message, Date.now() - startTs);
    res.status(500).json({ error: err.message || 'TTLock passcode failed' });
  }
});

/**
 * POST /api/ttlock/pool/refill — manažér: vygeneruj nový pool 20 kódov (3 mes).
 */
router.post('/pool/refill', mgr, async (req, res) => {
  try {
    const lockId = req.body.lockId || LOCK_ID;
    if (!lockId) return res.status(400).json({ error: 'Lock ID nie je nastavené (TTLOCK_LOCK_ID v .env)' });
    const result = await generateWcPool(lockId);
    if (!result.created) {
      return res.status(502).json({
        error: 'Nepodarilo sa vygenerovať žiadny kód. ' + (result.errors[0] || 'Zámok offline?'),
        errors: result.errors,
      });
    }
    res.json({
      ok: true,
      created: result.created,
      poolSize: POOL_SIZE,
      validUntil: result.endDate,
      errors: result.errors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ttlock/pool/status — koľko platných kódov je v poole + dokedy platia.
 */
router.get('/pool/status', async (req, res) => {
  try {
    const now = new Date();
    const rows = await db.select().from(wcCodes)
      .where(and(eq(wcCodes.active, true), gt(wcCodes.endDate, now)));
    const validUntil = rows.reduce((max, r) => Math.max(max, new Date(r.endDate).getTime()), 0);
    res.json({ valid: rows.length, poolSize: POOL_SIZE, validUntil: validUntil || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * List all locks for the account
 * GET /api/ttlock/locks
 */
router.get('/locks', async (req, res) => {
  try {
    const token = await getAccessToken();
    const params = new URLSearchParams({
      clientId: CLIENT_ID,
      accessToken: token,
      pageNo: '1',
      pageSize: '100',
      date: String(Date.now()),
    });

    const apiRes = await fetch(TTLOCK_API + '/v3/lock/list?' + params.toString());
    const data = await apiRes.json();
    if (data.errcode) throw new Error('TTLock error: ' + (data.errmsg || data.errcode));

    res.json(data.list || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pre-warm — zavolat pri server starte aby prvy passcode request po reštarte
// nemusel cakat 1-2s na OAuth token. Token sa cache-uje v module scope
// (tokenExpiry default 2h), takže prvi cashier ráno už dostane PIN okamžite.
// Volat fire-and-forget cez setImmediate aby sa nestopujem boot pri network err.
export function prewarmTtlock() {
  if (!CLIENT_ID || !CLIENT_SECRET) return; // ttlock vypnutý — skip
  setImmediate(() => {
    const t0 = Date.now();
    getAccessToken()
      .then(() => console.log('[TTLock] token pre-warmed (' + (Date.now() - t0) + 'ms)'))
      .catch((err) => console.warn('[TTLock] pre-warm zlyhal: ' + err.message));
  });
}

export default router;

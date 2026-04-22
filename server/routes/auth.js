import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { staff, authAttempts } from '../db/schema.js';
import { eq, and, sql, gte, count } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { auth } from '../middleware/auth.js';
import { loginSchema } from '../schemas/auth.js';

const router = Router();

// PR-2.3: DB-backed per-account PIN lockout.
// Previous implementation used an in-memory Map keyed on req.ip. Inside Docker
// all LAN clients can collapse to the same apparent IP, which (a) locked out
// legitimate users and (b) let an attacker rotate IPs to defeat the limit.
// Now we track failures in auth_attempts and key the lookup on staff_id when
// a candidate row is matched, else on the submitter's IP.
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const PIN_MAX_ATTEMPTS = 5;

/**
 * Count failed auth attempts for the given (staffId|ip) in the last window.
 * staffId is preferred; ip is the fallback when no staff row matched before.
 * Returns 0 on any DB error so a hiccup never blocks login entirely.
 */
async function countRecentFailures({ staffId, ip }) {
  const since = new Date(Date.now() - PIN_WINDOW_MS);
  try {
    if (staffId != null) {
      const rows = await db.select({ n: count() })
        .from(authAttempts)
        .where(and(
          eq(authAttempts.staffId, staffId),
          eq(authAttempts.success, false),
          gte(authAttempts.createdAt, since),
        ));
      return Number(rows[0]?.n || 0);
    }
    const rows = await db.select({ n: count() })
      .from(authAttempts)
      .where(and(
        eq(authAttempts.ip, ip || ''),
        eq(authAttempts.success, false),
        sql`${authAttempts.staffId} IS NULL`,
        gte(authAttempts.createdAt, since),
      ));
    return Number(rows[0]?.n || 0);
  } catch (err) {
    console.error('[auth] countRecentFailures failed:', err?.message || err);
    return 0;
  }
}

/**
 * Best-effort write of an auth_attempts row. Never throws — a DB hiccup must
 * not block the login response.
 */
async function recordAttempt({ staffId, ip, success }) {
  try {
    await db.insert(authAttempts).values({
      staffId: staffId ?? null,
      ip: ip || '',
      success: !!success,
    });
  } catch (err) {
    console.error('[auth] recordAttempt failed:', err?.message || err);
  }
}

// POST /api/auth/login — PIN-based login
router.post('/login', validate(loginSchema), async (req, res) => {
  const { pin } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || '';

  const allStaff = await db.select().from(staff).where(eq(staff.active, true));
  const found = allStaff.find(s => bcrypt.compareSync(pin, s.pin));

  // Check lockout for this identity (matched staff row, else IP-based fallback
  // for the bucket of attempts that never matched any staff row).
  const lockKey = found ? { staffId: found.id, ip } : { staffId: null, ip };
  const fails = await countRecentFailures(lockKey);
  if (fails >= PIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
  }

  if (!found) {
    await recordAttempt({ staffId: null, ip, success: false });
    return res.status(401).json({ error: 'Nespravny PIN' });
  }

  const token = jwt.sign(
    { id: found.id, name: found.name, role: found.role },
    process.env.JWT_SECRET,
    { expiresIn: '12h', algorithm: 'HS256' }
  );

  await recordAttempt({ staffId: found.id, ip, success: true });
  res.json({ token, user: { id: found.id, name: found.name, role: found.role } });
});

// POST /api/auth/verify-manager — verify manager PIN for storno
// NOTE: scoped to the original in-memory behaviour is intentionally left in
// place here — the DB-backed limiter is only wired on /login in this PR.
router.post('/verify-manager', validate(loginSchema), async (req, res) => {
  const { pin } = req.body;
  const allManagers = await db.select().from(staff)
    .where(and(eq(staff.active, true), sql`${staff.role} IN ('manazer', 'admin')`));
  const found = allManagers.find(s => bcrypt.compareSync(pin, s.pin));
  if (!found) return res.status(401).json({ error: 'Neopravneny pristup' });
  res.json({ ok: true, name: found.name });
});

// GET /api/auth/me — verify token (protected: requires valid JWT)
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/auth/staff-list — verejný zoznam aktívnych zamestnancov pre login obrazovku (bez PIN hashu).
router.get('/staff-list', async (req, res) => {
  const rows = await db
    .select({ id: staff.id, name: staff.name, role: staff.role })
    .from(staff)
    .where(eq(staff.active, true));
  res.json(rows);
});

export default router;

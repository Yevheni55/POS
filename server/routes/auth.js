import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { staff } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { loginSchema } from '../schemas/auth.js';

const router = Router();

// Simple in-memory rate limiter for PIN endpoints
const _pinAttempts = new Map();
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const PIN_MAX_ATTEMPTS = 10;

function pinRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = _pinAttempts.get(ip);
  if (entry && now - entry.start < PIN_WINDOW_MS) {
    if (entry.count >= PIN_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Prilis vela pokusov. Skuste neskor.' });
    }
    entry.count++;
  } else {
    _pinAttempts.set(ip, { start: now, count: 1 });
  }
  next();
}
// Cleanup expired entries every 15 minutes (unref to not block process exit in tests)
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _pinAttempts) {
    if (now - entry.start >= PIN_WINDOW_MS) _pinAttempts.delete(ip);
  }
}, PIN_WINDOW_MS);
_cleanupTimer.unref();

// POST /api/auth/login — PIN-based login
router.post('/login', pinRateLimit, validate(loginSchema), async (req, res) => {
  const { pin } = req.body;

  const allStaff = await db.select().from(staff).where(eq(staff.active, true));
  const found = allStaff.find(s => bcrypt.compareSync(pin, s.pin));
  if (!found) return res.status(401).json({ error: 'Nespravny PIN' });

  const token = jwt.sign(
    { id: found.id, name: found.name, role: found.role },
    process.env.JWT_SECRET,
    { expiresIn: '12h', algorithm: 'HS256' }
  );

  res.json({ token, user: { id: found.id, name: found.name, role: found.role } });
});

// POST /api/auth/verify-manager — verify manager PIN for storno
router.post('/verify-manager', pinRateLimit, validate(loginSchema), async (req, res) => {
  const { pin } = req.body;
  const allManagers = await db.select().from(staff)
    .where(and(eq(staff.active, true), sql`${staff.role} IN ('manazer', 'admin')`));
  const found = allManagers.find(s => bcrypt.compareSync(pin, s.pin));
  if (!found) return res.status(401).json({ error: 'Neopravneny pristup' });
  res.json({ ok: true, name: found.name });
});

// GET /api/auth/me — verify token
router.get('/me', (req, res) => {
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

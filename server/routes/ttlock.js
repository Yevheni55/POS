import { Router } from 'express';
import { createHash } from 'crypto';

const router = Router();

const CLIENT_ID = process.env.TTLOCK_CLIENT_ID;
const CLIENT_SECRET = process.env.TTLOCK_CLIENT_SECRET;
const TTLOCK_USERNAME = process.env.TTLOCK_USERNAME;
const LOCK_ID = process.env.TTLOCK_LOCK_ID;
const TTLOCK_API = 'https://euapi.ttlock.com';

let accessToken = null;
let tokenExpiry = 0;

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
 * Generate a temporary passcode for the lock
 * POST /api/ttlock/passcode
 * Body: { lockId?, name?, startDate?, endDate? }
 */
router.post('/passcode', async (req, res) => {
  try {
    const lockId = req.body.lockId || LOCK_ID;
    if (!lockId) return res.status(400).json({ error: 'Lock ID not configured. Set TTLOCK_LOCK_ID in .env' });

    const token = await getAccessToken();
    const now = Date.now();
    const endDate = req.body.endDate || now + 3 * 60 * 60 * 1000; // 3h default

    // Generate random 4-digit code
    const code = String(Math.floor(1000 + Math.random() * 9000));

    // Add custom passcode via TTLock API
    const params = new URLSearchParams({
      clientId: CLIENT_ID,
      accessToken: token,
      lockId: String(lockId),
      keyboardPwd: code,
      keyboardPwdName: req.body.name || 'POS ' + new Date().toLocaleString('sk-SK'),
      startDate: String(req.body.startDate || now),
      endDate: String(endDate),
      addType: '2', // 2 = via gateway
      date: String(now),
    });

    const apiRes = await fetch(TTLOCK_API + '/v3/keyboardPwd/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await apiRes.json();
    if (data.errcode) throw new Error('TTLock error: ' + (data.errmsg || data.errcode));

    res.json({
      passcode: code,
      keyboardPwdId: data.keyboardPwdId,
      startDate: req.body.startDate || now,
      endDate: endDate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'TTLock passcode generation failed' });
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

export default router;

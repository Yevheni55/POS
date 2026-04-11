/**
 * CORS pre Express a Socket.io. Pri otvoreni POS z telefonu v LAN je Origin napr. http://192.168.0.10:3080
 * — nie je v predvolenom zozname localhost. Zapnite CORS_ALLOW_LAN=true v server/.env.
 */

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function parseAllowList() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return ['http://localhost:3000', 'http://localhost:3080', 'https://localhost:3443'];
}

function isPrivateLanHostname(hostname) {
  if (!hostname || hostname === 'localhost') return false;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const m = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 16 && n <= 31;
  }
  return false;
}

const allowList = parseAllowList();
const allowLan = isTruthy(process.env.CORS_ALLOW_LAN);

/** Zoznam pre spatnu kompatibilitu (Socket.io podporuje aj funkciu). */
export const ALLOWED_ORIGINS = allowList;

/**
 * @param {string | undefined} origin
 * @param {(err: Error | null, allow?: boolean) => void} callback
 */
export function corsOriginCallback(origin, callback) {
  if (!origin) {
    callback(null, true);
    return;
  }
  if (allowList.includes(origin)) {
    callback(null, true);
    return;
  }
  if (allowLan) {
    try {
      const { hostname } = new URL(origin);
      if (isPrivateLanHostname(hostname)) {
        callback(null, true);
        return;
      }
    } catch {
      /* ignore */
    }
  }
  callback(null, false);
}

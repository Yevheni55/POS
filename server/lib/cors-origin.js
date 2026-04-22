/**
 * CORS pre Express a Socket.io. Pri otvoreni POS z telefonu v LAN je Origin napr. http://192.168.0.10:3080
 * — nie je v predvolenom zozname localhost. Zapnite CORS_ALLOW_LAN=true v server/.env.
 *
 * LAN allowlist je zúžený: povolené sú iba http/https na portoch z `LAN_ALLOWED_PORTS`
 * (čiarkou oddelený zoznam, default `3080,3443`) a hostname musí spadať do RFC-1918
 * privátneho rozsahu (10.*, 172.16-31.*, 192.168.*).
 */

const DEFAULT_LAN_PORTS = [3080, 3443];

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function parseAllowList() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return ['http://localhost:3000', 'http://localhost:3080', 'https://localhost:3443'];
}

function parseLanAllowedPorts() {
  const raw = process.env.LAN_ALLOWED_PORTS;
  if (!raw) return new Set(DEFAULT_LAN_PORTS);
  const ports = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 65535);
  return ports.length > 0 ? new Set(ports) : new Set(DEFAULT_LAN_PORTS);
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
const lanAllowedPorts = parseLanAllowedPorts();

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
      const url = new URL(origin);
      const protocolOk = url.protocol === 'http:' || url.protocol === 'https:';
      const effectivePort = url.port
        ? Number.parseInt(url.port, 10)
        : (url.protocol === 'https:' ? 443 : 80);
      const portOk = Number.isInteger(effectivePort) && lanAllowedPorts.has(effectivePort);
      if (protocolOk && portOk && isPrivateLanHostname(url.hostname)) {
        callback(null, true);
        return;
      }
    } catch {
      /* ignore */
    }
  }
  callback(null, false);
}

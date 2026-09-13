// Serverové nastavenia, ktoré obsluha mení počas dňa — bez .env a bez reštartu:
//  • online_orders.pause      { until, reason, by, byName, at }  — pauza príjmu online objednávok
//  • online_orders.auto_accept { enabled, prepMinutes }         — strážca prijíma sám
// Jedna tabuľka kľúč → JSON. Čítanie je lacné (PK), cache netreba.
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { appSettings } from '../db/schema.js';

export const KEY_PAUSE = 'online_orders.pause';
export const KEY_AUTO_ACCEPT = 'online_orders.auto_accept';

export async function getSetting(key, fallback = null) {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row ? row.value : fallback;
}

export async function setSetting(key, value, staffId = null) {
  const set = { value, updatedAt: new Date(), updatedBy: staffId };
  await db.insert(appSettings).values({ key, ...set }).onConflictDoUpdate({ target: appSettings.key, set });
  return value;
}

/** Aktívna pauza alebo null (expirovaná sa tvári ako žiadna — auto-návrat bez cronu). */
export async function getPause(now = new Date()) {
  const v = await getSetting(KEY_PAUSE, null);
  if (!v || !v.until) return null;
  const until = new Date(v.until);
  if (!(until.getTime() > now.getTime())) return null;
  return { until, reason: String(v.reason || ''), by: v.by ?? null, byName: String(v.byName || ''), at: v.at ? new Date(v.at) : null };
}

export async function setPause({ until, reason = '', staffId = null, staffName = '' }) {
  return setSetting(KEY_PAUSE, { until: new Date(until).toISOString(), reason: String(reason || '').slice(0, 120), by: staffId, byName: String(staffName || '').slice(0, 60), at: new Date().toISOString() }, staffId);
}

export async function clearPause(staffId = null) {
  return setSetting(KEY_PAUSE, {}, staffId);
}

export async function getAutoAccept() {
  const v = await getSetting(KEY_AUTO_ACCEPT, null) || {};
  return { enabled: !!v.enabled, prepMinutes: Math.min(90, Math.max(5, Number(v.prepMinutes) || 15)) };
}

export async function setAutoAccept({ enabled, prepMinutes = 15, staffId = null }) {
  const v = { enabled: !!enabled, prepMinutes: Math.min(90, Math.max(5, Number(prepMinutes) || 15)) };
  await setSetting(KEY_AUTO_ACCEPT, v, staffId);
  return v;
}

const TZ = 'Europe/Bratislava';
function localParts(d = new Date()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)) {
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  }
  return p;
}
/** Okamih, keď v Bratislave nastane daný lokálny čas (UTC ± DST vyriešené cez Intl). */
function localTimeToDate(y, m, d, hh, mm) {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess));
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const diff = Date.UTC(y, m - 1, d, hh, mm, 0) - got;
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess);
}
/** Koniec dnešného dňa (23:59 lokálne) — „pozastaviť do konca dňa". */
export function endOfLocalDay(now = new Date()) {
  const p = localParts(now);
  return localTimeToDate(p.year, p.month, p.day, 23, 59);
}
/** Najbližšie ráno 5:00 lokálne — dokedy platí „dnes vypredané". */
export function nextMorning(now = new Date(), hour = 5) {
  const p = localParts(now);
  let t = localTimeToDate(p.year, p.month, p.day, hour, 0);
  if (t.getTime() <= now.getTime()) t = new Date(t.getTime() + 24 * 3600_000);
  return t;
}

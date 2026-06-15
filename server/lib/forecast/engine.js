// Forecast engine v2 — viacfaktorový denný odhad tržieb (ridge regresia) nad
// premennými z kasy (kalendár, sezóna, hodinový profil, lagy) + počasia
// (teploty, zrážky, kategória oblohy). Pretrénuje sa každú hodinu, projektuje
// dnešnú tržbu (predané doteraz + očakávaný zvyšok dňa) a predpovedá +7 dní.
// Výsledky zapisuje do revenue_forecasts (method 'v2-ridge') → zobrazí sa
// v admin paneli Reporty → Predpoveď.
//
// Pozn. k "1000+ premenným": na ~50 dňoch dát by 1000 voľných koeficientov
// brutálne overfitlo. Engine preto používa ~30 regularizovaných feature (ridge
// λ vyberané hold-outom) + hodinový profil; feature-builder je rozšíriteľný,
// takže s pribúdajúcimi dátami sa dá počet feature zvyšovať bez prepisu modelu.

import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { fitRidge, predictOne, buildStandardizer, pickLambda } from './ridge.js';
import { runForecastHourly } from './engine-hourly.js';

const TZ = 'Europe/Bratislava';
const LAT = 48.1014;
const LON = 17.1136;
const SEASON_START = Date.UTC(2026, 3, 25) / 86400000; // 2026-04-25 v dňoch
const METHOD = 'v2-ridge';

let _timer = null;

// ---------- načítanie dát ----------
async function loadDailyHistory() {
  const r = await db.execute(sql`
    WITH rev AS (
      SELECT (created_at AT TIME ZONE ${TZ})::date AS d, sum(amount::numeric)::float AS rev
      FROM payments GROUP BY 1
    ), wx AS (
      SELECT (observed_at AT TIME ZONE ${TZ})::date AS d,
             max(temperature_c)::float AS tmax,
             min(temperature_c)::float AS tmin,
             max(apparent_temp_c)::float AS appmax,
             COALESCE(sum(precipitation_mm), 0)::float AS precip,
             (avg(cloud_cover_pct) FILTER (
                WHERE extract(hour FROM (observed_at AT TIME ZONE ${TZ})) BETWEEN 10 AND 23))::float AS cloud_open,
             count(*) FILTER (
                WHERE weather_code >= 51
                  AND extract(hour FROM (observed_at AT TIME ZONE ${TZ})) BETWEEN 10 AND 23)::int AS rain_hours
      FROM weather_observations GROUP BY 1
    )
    SELECT to_char(rev.d, 'YYYY-MM-DD') AS day, rev.rev,
           wx.tmax, wx.tmin, wx.appmax, wx.precip, wx.cloud_open, wx.rain_hours
    FROM rev JOIN wx ON wx.d = rev.d
    WHERE rev.rev > 0 AND wx.tmax IS NOT NULL
    ORDER BY rev.d
  `);
  return r.rows.map((x) => ({
    day: x.day,
    rev: Number(x.rev) || 0,
    tmax: x.tmax == null ? null : Number(x.tmax),
    tmin: x.tmin == null ? null : Number(x.tmin),
    appmax: x.appmax == null ? null : Number(x.appmax),
    precip: Number(x.precip) || 0,
    cloudOpen: x.cloud_open == null ? null : Number(x.cloud_open),
    rainHours: Number(x.rain_hours) || 0,
  }));
}

async function loadHourlyCumShare() {
  const r = await db.execute(sql`
    SELECT extract(hour FROM (created_at AT TIME ZONE ${TZ}))::int AS h,
           sum(amount::numeric)::float AS rev
    FROM payments GROUP BY 1
  `);
  const byHour = new Array(24).fill(0);
  for (const x of r.rows) byHour[Number(x.h)] = Number(x.rev) || 0;
  const total = byHour.reduce((s, v) => s + v, 0) || 1;
  // cumShare[h] = podiel dennej tržby zarobený DO KONCA hodiny h
  const cum = new Array(24).fill(0);
  let acc = 0;
  for (let h = 0; h < 24; h++) { acc += byHour[h]; cum[h] = acc / total; }
  return cum;
}

async function loadTodayActual() {
  const r = await db.execute(sql`
    SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS today,
           extract(hour FROM (now() AT TIME ZONE ${TZ}))::int AS cur_hour,
           COALESCE((SELECT sum(amount::numeric) FROM payments
                     WHERE (created_at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date), 0)::float AS today_rev
  `);
  const row = r.rows[0] || {};
  return { today: row.today, curHour: Number(row.cur_hour) || 0, todayRev: Number(row.today_rev) || 0 };
}

async function fetchDailyForecast() {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(LAT));
  url.searchParams.set('longitude', String(LON));
  url.searchParams.set('daily', [
    'weather_code', 'temperature_2m_max', 'temperature_2m_min',
    'apparent_temperature_max', 'precipitation_sum', 'precipitation_probability_max',
  ].join(','));
  url.searchParams.set('timezone', TZ);
  url.searchParams.set('forecast_days', '8');
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error('Open-Meteo HTTP ' + resp.status);
  const j = await resp.json();
  const d = j.daily || {};
  const t = d.time || [];
  return t.map((day, i) => ({
    day,
    code: num(d.weather_code, i),
    tmax: num(d.temperature_2m_max, i),
    tmin: num(d.temperature_2m_min, i),
    appmax: num(d.apparent_temperature_max, i),
    precip: num(d.precipitation_sum, i) || 0,
    precipProb: num(d.precipitation_probability_max, i),
  }));
}
function num(arr, i) { const v = arr && arr[i]; return v == null || Number.isNaN(v) ? null : Number(v); }

// ---------- feature engineering ----------
// 4-cestná kategória oblohy z rôznych vstupov (parita train vs predikcia).
function categoryFromHistory(rec) {
  if (rec.rainHours > 0 || rec.precip > 0.5) return 'rain';
  if (rec.cloudOpen != null && rec.cloudOpen >= 65) return 'cloudy';
  if (rec.cloudOpen != null && rec.cloudOpen >= 30) return 'partly';
  return 'clear';
}
function categoryFromForecast(rec) {
  if ((rec.code != null && rec.code >= 51) || rec.precip > 0.5) return 'rain';
  if (rec.code === 3) return 'cloudy';
  if (rec.code === 2) return 'partly';
  return 'clear';
}
function isoWeekday(dayStr) {
  // dayStr 'YYYY-MM-DD' → ISO 1=Po..7=Ne (bez TZ posunu, dátum je už lokálny)
  const [y, m, dd] = dayStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); // 0=Ne..6=So
  return wd === 0 ? 7 : wd;
}
function dayNumber(dayStr) {
  const [y, m, dd] = dayStr.split('-').map(Number);
  return Date.UTC(y, m - 1, dd) / 86400000;
}
function doyFrac(dayStr) {
  const [y, m, dd] = dayStr.split('-').map(Number);
  const start = Date.UTC(y, 0, 1);
  const doy = (Date.UTC(y, m - 1, dd) - start) / 86400000;
  return doy / 365;
}

// Vráti { vec, names, binMask }. cat: 'clear|partly|cloudy|rain'. lags: {sameWd, roll7}.
function buildFeatureVector({ dayStr, tmax, tmin, appmax, precip, cat, lags }) {
  const wd = isoWeekday(dayStr);
  const isWeekend = (wd >= 6) ? 1 : 0;
  const isFriday = (wd === 5) ? 1 : 0;
  const trend = dayNumber(dayStr) - SEASON_START;
  const doy = doyFrac(dayStr);
  const T = tmax == null ? 22 : tmax;       // fallback mierne leto
  const Tmin = tmin == null ? T - 8 : tmin;
  const App = appmax == null ? T : appmax;
  const P = precip || 0;
  const rainFlag = P > 0.3 ? 1 : 0;
  const clear = cat === 'clear' ? 1 : 0;
  const partly = cat === 'partly' ? 1 : 0;
  const cloudy = cat === 'cloudy' ? 1 : 0;
  const rain = cat === 'rain' ? 1 : 0;
  const tb = [T <= 16, T > 16 && T <= 20, T > 20 && T <= 24, T > 24 && T <= 28, T > 28 && T <= 32, T > 32].map((b) => b ? 1 : 0);
  const sameWd = lags.sameWd, roll7 = lags.roll7;

  const feats = [
    ['intercept', 1, true],
    ['wd1', wd === 1 ? 1 : 0, true], ['wd2', wd === 2 ? 1 : 0, true], ['wd3', wd === 3 ? 1 : 0, true],
    ['wd4', wd === 4 ? 1 : 0, true], ['wd5', wd === 5 ? 1 : 0, true], ['wd6', wd === 6 ? 1 : 0, true],
    ['wd7', wd === 7 ? 1 : 0, true],
    ['isWeekend', isWeekend, true], ['isFriday', isFriday, true],
    ['trend', trend, false],
    ['sinDoy', Math.sin(2 * Math.PI * doy), false], ['cosDoy', Math.cos(2 * Math.PI * doy), false],
    ['tmax', T, false], ['tmax2', T * T, false], ['tmin', Tmin, false], ['appmax', App, false],
    ['precip', P, false], ['rainFlag', rainFlag, true],
    ['catPartly', partly, true], ['catCloudy', cloudy, true], ['catRain', rain, true],
    ['tb16', tb[0], true], ['tb20', tb[1], true], ['tb24', tb[2], true], ['tb28', tb[3], true], ['tb32', tb[4], true], ['tb33', tb[5], true],
    ['weekendXtmax', isWeekend * T, false], ['clearXtmax', clear * T, false],
    ['lagSameWd', sameWd, false], ['roll7', roll7, false],
  ];
  return {
    vec: feats.map((f) => f[1]),
    names: feats.map((f) => f[0]),
    binMask: feats.map((f) => f[2]),
  };
}

// ---------- hlavný beh ----------
export async function runForecast() {
  const hist = await loadDailyHistory();
  if (hist.length < 14) {
    return { ok: false, reason: `málo dát (${hist.length} dní, treba ≥14)` };
  }
  const revByDay = new Map(hist.map((h) => [h.day, h.rev]));
  const cumShare = await loadHourlyCumShare();
  const { today, curHour, todayRev } = await loadTodayActual();

  // lag helpery
  const meanRev = hist.reduce((s, h) => s + h.rev, 0) / hist.length;
  function sameWeekdayLastWeek(dayStr) {
    const dn = dayNumber(dayStr) - 7;
    const prev = new Date(dn * 86400000).toISOString().split('T')[0];
    return revByDay.has(prev) ? revByDay.get(prev) : meanRev;
  }
  function roll7Before(dayStr) {
    const dn = dayNumber(dayStr);
    const vals = [];
    for (let k = 1; k <= 7; k++) {
      const p = new Date((dn - k) * 86400000).toISOString().split('T')[0];
      if (revByDay.has(p)) vals.push(revByDay.get(p));
    }
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : meanRev;
  }

  // tréningová matica
  const rawX = [], Y = [];
  let names = null, binMask = null;
  for (const h of hist) {
    const fv = buildFeatureVector({
      dayStr: h.day, tmax: h.tmax, tmin: h.tmin, appmax: h.appmax, precip: h.precip,
      cat: categoryFromHistory(h),
      lags: { sameWd: sameWeekdayLastWeek(h.day), roll7: roll7Before(h.day) },
    });
    rawX.push(fv.vec); Y.push(h.rev);
    names = fv.names; binMask = fv.binMask;
  }

  // štandardizácia + fit
  const std = buildStandardizer(rawX, binMask);
  const X = rawX.map((r) => std.apply(r));
  const lambda = pickLambda(X, Y, [0.3, 1, 3, 10, 30, 100, 300], Math.min(10, Math.floor(hist.length / 4)));
  const w = fitRidge(X, Y, lambda);
  if (!w) return { ok: false, reason: 'fit zlyhal (singulárne)' };

  // in-sample reziduály → pásma
  let sse = 0, sst = 0;
  for (let i = 0; i < X.length; i++) {
    const e = predictOne(w, X[i]) - Y[i]; sse += e * e;
    const d = Y[i] - meanRev; sst += d * d;
  }
  const resid = Math.sqrt(sse / Math.max(1, X.length - 1));
  const r2 = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;

  function predictDay(rec) {
    const cat = categoryFromForecast(rec);
    const fv = buildFeatureVector({
      dayStr: rec.day, tmax: rec.tmax, tmin: rec.tmin, appmax: rec.appmax, precip: rec.precip,
      cat,
      lags: { sameWd: sameWeekdayLastWeek(rec.day), roll7: roll7Before(rec.day) },
    });
    return Math.max(0, predictOne(w, std.apply(fv.vec)));
  }

  const fc = await fetchDailyForecast(); // index 0 = dnes
  const out = [];
  for (let i = 0; i < fc.length; i++) {
    const rec = fc[i];
    const horizon = Math.round(dayNumber(rec.day) - dayNumber(today));
    if (horizon < 0 || horizon > 7) continue;
    let est = predictDay(rec);

    // intraday projekcia dneška: predané doteraz + očakávaný zvyšok dňa
    if (rec.day === today) {
      const shareDone = Math.min(0.999, Math.max(0, cumShare[curHour] || 0));
      const modelRemaining = todayRev + est * (1 - shareDone);
      const pace = shareDone > 0.05 ? todayRev / shareDone : est;
      const wPace = shareDone; // čím neskôr, tým viac veríme reálnemu tempu
      est = wPace * pace + (1 - wPace) * modelRemaining;
      est = Math.max(est, todayRev); // nikdy menej než už zarobené
    }

    const band = resid * (1 + 0.12 * horizon); // širšie pásmo do budúcna
    const low = Math.max(0, est - 0.9 * band);
    const high = est + 0.9 * band;
    out.push({
      day: rec.day, horizon, weekday: isoWeekday(rec.day),
      estimate: Math.round(est), low: Math.round(low), high: Math.round(high),
      tmax: rec.tmax, precip: rec.precip, code: rec.code,
      note: noteFor(rec, categoryFromForecast(rec), rec.day === today, todayRev),
    });
  }

  await upsertForecasts(out);
  return {
    ok: true, days: out.length, lambda, r2: Math.round(r2 * 100) / 100,
    residEur: Math.round(resid), features: names.length, trainDays: hist.length,
    today: out.find((o) => o.day === today) || null,
  };
}

function noteFor(rec, cat, isToday, todayRev) {
  const catSk = { clear: 'jasno', partly: 'polooblačno', cloudy: 'zamračené', rain: 'dážď' }[cat] || cat;
  let s = (rec.tmax != null ? Math.round(rec.tmax) + '°C ' : '') + catSk;
  if (rec.precip > 0.5) s += ` (${rec.precip} mm)`;
  if (isToday) s += ` · intraday (zatiaľ ${Math.round(todayRev)} €)`;
  return 'v2-ridge: ' + s;
}

async function upsertForecasts(rows) {
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO revenue_forecasts
        (target_date, made_at, horizon_days, estimate_eur, low_eur, high_eur,
         fc_temp_max_c, fc_precip_mm, fc_weather_code, weekday, method, note)
      VALUES (${r.day}, now(), ${r.horizon}, ${r.estimate}, ${r.low}, ${r.high},
              ${r.tmax}, ${r.precip}, ${r.code}, ${r.weekday}, ${METHOD}, ${r.note})
      ON CONFLICT (target_date, method) DO UPDATE SET
        made_at = now(), horizon_days = EXCLUDED.horizon_days,
        estimate_eur = EXCLUDED.estimate_eur, low_eur = EXCLUDED.low_eur, high_eur = EXCLUDED.high_eur,
        fc_temp_max_c = EXCLUDED.fc_temp_max_c, fc_precip_mm = EXCLUDED.fc_precip_mm,
        fc_weather_code = EXCLUDED.fc_weather_code, weekday = EXCLUDED.weekday, note = EXCLUDED.note
    `);
  }
}

export function startForecastCron() {
  if (_timer) return;
  const tick = async () => {
    try {
      const r = await runForecast();
      console.log('[forecast v2] ' + (r.ok
        ? `OK ${r.days}d R²=${r.r2} λ=${r.lambda} ±${r.residEur}€ ${r.features}f ${r.trainDays}d` : 'skip: ' + r.reason));
    } catch (e) { console.warn('[forecast v2] zlyhal:', e.message); }
    try {
      const r3 = await runForecastHourly();
      console.log('[forecast v3] ' + (r3.ok
        ? `OK ${r3.days}d R²=${r3.r2} ±${r3.residHourEur}€/h ${r3.trainRows}r ${r3.trainDays}d` : 'skip: ' + r3.reason));
    } catch (e) { console.warn('[forecast v3] zlyhal:', e.message); }
  };
  setTimeout(tick, 12000);                  // krátko po boote (po weather fetchi)
  _timer = setInterval(tick, 60 * 60 * 1000); // každú hodinu
}

export function stopForecastCron() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

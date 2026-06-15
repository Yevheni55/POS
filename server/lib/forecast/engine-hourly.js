// Forecast engine v3 — HODINOVÝ model tržieb (gradient boosting).
// Trénuje na mriežke (deň × otvorená hodina 9–23) s tržbou a počasím TEJ
// hodiny → ~640 vzoriek (oproti 43 denným vo v2), takže GBT zachytí
// nelineárne interakcie (hodina × teplota × deň). Denná tržba = súčet
// hodinových predikcií; DNES = banked hodiny + počasím-citlivá predikcia
// zvyšku dňa. Zapisuje method 'v3-gbt-hourly' do revenue_forecasts.

import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { fitGBT, predictGBT, gbtStats } from './gbt.js';

const TZ = 'Europe/Bratislava';
const LAT = 48.1014;
const LON = 17.1136;
const SEASON_START = Date.UTC(2026, 3, 25) / 86400000;
const METHOD = 'v3-gbt-hourly';
const OPEN_START = 9;
const OPEN_END = 23;

function num(arr, i) { const v = arr && arr[i]; return v == null || Number.isNaN(v) ? null : Number(v); }
function isoWeekday(dayStr) {
  const [y, m, dd] = dayStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return wd === 0 ? 7 : wd;
}
function dayNumber(dayStr) { const [y, m, dd] = dayStr.split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; }
function doyFrac(dayStr) {
  const [y, m, dd] = dayStr.split('-').map(Number);
  return ((Date.UTC(y, m - 1, dd) - Date.UTC(y, 0, 1)) / 86400000) / 365;
}
function codeCat(code) { const c = Number(code); if (c >= 51) return 3; if (c === 3) return 2; if (c === 2) return 1; return 0; }

// feature vektor pre (deň, hodina, počasie)
function featVec(dayStr, hour, wx) {
  const wd = isoWeekday(dayStr);
  const T = wx.temp == null ? 22 : wx.temp;
  return [
    hour,
    wd,
    wd >= 6 ? 1 : 0,
    dayNumber(dayStr) - SEASON_START,
    doyFrac(dayStr),
    T,
    wx.app == null ? T : wx.app,
    wx.precip || 0,
    wx.cloud == null ? 50 : wx.cloud,
    codeCat(wx.code),
  ];
}

async function loadHourlyGrid() {
  const r = await db.execute(sql`
    WITH days AS (SELECT DISTINCT (created_at AT TIME ZONE ${TZ})::date AS d FROM payments),
    hrs AS (SELECT generate_series(${OPEN_START}::int, ${OPEN_END}::int) AS h),
    grid AS (SELECT d, h FROM days CROSS JOIN hrs),
    rev AS (
      SELECT (created_at AT TIME ZONE ${TZ})::date AS d,
             extract(hour FROM (created_at AT TIME ZONE ${TZ}))::int AS h,
             sum(amount::numeric)::float AS rev
      FROM payments GROUP BY 1, 2
    )
    SELECT to_char(grid.d, 'YYYY-MM-DD') AS day, grid.h,
           COALESCE(rev.rev, 0)::float AS rev,
           w.temperature_c::float AS temp, w.apparent_temp_c::float AS app,
           COALESCE(w.precipitation_mm, 0)::float AS precip,
           w.cloud_cover_pct::int AS cloud, w.weather_code AS code
    FROM grid
    LEFT JOIN rev ON rev.d = grid.d AND rev.h = grid.h
    LEFT JOIN weather_observations w
      ON w.observed_at = ((grid.d::timestamp + make_interval(hours => grid.h)) AT TIME ZONE ${TZ})
    WHERE grid.d < (now() AT TIME ZONE ${TZ})::date
      AND w.temperature_c IS NOT NULL
    ORDER BY grid.d, grid.h
  `);
  return r.rows.map((x) => ({
    day: x.day, h: Number(x.h), rev: Number(x.rev) || 0,
    temp: x.temp == null ? null : Number(x.temp),
    app: x.app == null ? null : Number(x.app),
    precip: Number(x.precip) || 0,
    cloud: x.cloud == null ? null : Number(x.cloud),
    code: x.code == null ? null : Number(x.code),
  }));
}

async function loadTodayHourly() {
  const r = await db.execute(sql`
    SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS today,
           extract(hour FROM (now() AT TIME ZONE ${TZ}))::int AS cur_hour
  `);
  const meta = r.rows[0] || {};
  const rr = await db.execute(sql`
    SELECT extract(hour FROM (created_at AT TIME ZONE ${TZ}))::int AS h, sum(amount::numeric)::float AS rev
    FROM payments WHERE (created_at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date
    GROUP BY 1
  `);
  const byHour = {};
  for (const x of rr.rows) byHour[Number(x.h)] = Number(x.rev) || 0;
  return { today: meta.today, curHour: Number(meta.cur_hour) || 0, byHour };
}

async function fetchHourlyForecast() {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(LAT));
  url.searchParams.set('longitude', String(LON));
  url.searchParams.set('hourly', ['temperature_2m', 'apparent_temperature', 'precipitation', 'cloud_cover', 'weather_code'].join(','));
  url.searchParams.set('timezone', TZ);
  url.searchParams.set('forecast_days', '8');
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error('Open-Meteo HTTP ' + resp.status);
  const j = await resp.json();
  const h = j.hourly || {};
  const t = h.time || [];
  const map = {}; // day -> hour -> wx
  for (let i = 0; i < t.length; i++) {
    const day = String(t[i]).slice(0, 10);
    const hour = parseInt(String(t[i]).slice(11, 13), 10);
    if (!map[day]) map[day] = {};
    map[day][hour] = {
      temp: num(h.temperature_2m, i), app: num(h.apparent_temperature, i),
      precip: num(h.precipitation, i) || 0, cloud: num(h.cloud_cover, i), code: num(h.weather_code, i),
    };
  }
  return map;
}

export async function runForecastHourly() {
  const grid = await loadHourlyGrid();
  const days = new Set(grid.map((g) => g.day));
  if (days.size < 14) return { ok: false, reason: `málo dát (${days.size} dní)` };

  const X = grid.map((g) => featVec(g.day, g.h, g));
  const Y = grid.map((g) => g.rev);
  const model = fitGBT(X, Y, { trees: 140, maxDepth: 3, minLeaf: 14, shrinkage: 0.05 });
  const stat = gbtStats(model, X, Y);

  const fcMap = await fetchHourlyForecast();
  const { today, curHour, byHour } = await loadTodayHourly();

  const out = [];
  const fcDays = Object.keys(fcMap).sort();
  for (const day of fcDays) {
    const horizon = Math.round(dayNumber(day) - dayNumber(today));
    if (horizon < 0 || horizon > 7) continue;
    const hours = fcMap[day];
    let total = 0, tmax = null, precipSum = 0, worstCode = 0;
    for (let h = OPEN_START; h <= OPEN_END; h++) {
      const wx = hours[h] || {};
      if (wx.temp != null) tmax = tmax == null ? wx.temp : Math.max(tmax, wx.temp);
      precipSum += wx.precip || 0;
      if (wx.code != null && wx.code > worstCode) worstCode = wx.code;
      const pred = Math.max(0, predictGBT(model, featVec(day, h, wx)));
      if (day === today) {
        if (h < curHour) total += byHour[h] || 0;                 // banked
        else if (h === curHour) total += Math.max(byHour[h] || 0, pred); // bežiaca hodina
        else total += pred;                                       // zvyšok dňa
      } else {
        total += pred;
      }
    }
    if (day === today) {
      // banked hodiny pred OPEN_START (skoré ráno) tiež pripočítaj
      for (let h = 0; h < OPEN_START; h++) total += byHour[h] || 0;
      total = Math.max(total, Object.values(byHour).reduce((s, v) => s + v, 0));
    }
    const hoursCount = OPEN_END - OPEN_START + 1;
    const band = stat.resid * Math.sqrt(hoursCount) * (1 + 0.1 * horizon);
    out.push({
      day, horizon, weekday: isoWeekday(day),
      estimate: Math.round(total),
      low: Math.round(Math.max(0, total - 0.9 * band)),
      high: Math.round(total + 0.9 * band),
      tmax, precip: Math.round(precipSum * 10) / 10, code: worstCode,
      note: noteFor(day, today, tmax, worstCode, precipSum, byHour),
    });
  }

  await upsert(out);
  return {
    ok: true, days: out.length, r2: Math.round(stat.r2 * 100) / 100,
    residHourEur: Math.round(stat.resid), trainRows: grid.length, trainDays: days.size,
    today: out.find((o) => o.day === today) || null,
  };
}

function noteFor(day, today, tmax, code, precip, byHour) {
  const catSk = ['jasno', 'polooblačno', 'zamračené', 'dážď'][codeCat(code)] || '';
  let s = (tmax != null ? Math.round(tmax) + '°C ' : '') + catSk;
  if (precip > 0.5) s += ` (${Math.round(precip * 10) / 10} mm)`;
  if (day === today) s += ` · intraday (zatiaľ ${Math.round(Object.values(byHour).reduce((a, b) => a + b, 0))} €)`;
  return 'v3-gbt: ' + s;
}

async function upsert(rows) {
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

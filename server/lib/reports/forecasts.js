import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { TZ } from './shared.js';

// GET /api/reports/forecasts
// Vráti uložené odhady tržieb (revenue_forecasts) spárované so ŽIVOU skutočnou
// dennou tržbou (z payments, lokálny Bratislava deň) — nezávisí od manuálneho
// eval skriptu, actual sa ráta on-the-fly. Pre už uzavreté dni počíta odchýlku
// a či realita padla do rozpätia (kalibrácia). Pre dnešok/budúcnosť je actual
// neúplný → označené ako pending.
export async function forecastsHandler(req, res) {
  const rows = await db.execute(sql`
    SELECT f.target_date,
           f.weekday,
           f.horizon_days,
           f.estimate_eur::float AS estimate,
           f.low_eur::float       AS low,
           f.high_eur::float      AS high,
           f.fc_temp_max_c::float AS temp,
           f.fc_precip_mm::float  AS precip,
           f.fc_weather_code      AS code,
           f.method,
           f.note,
           a.actual::float        AS actual,
           (f.target_date < (now() AT TIME ZONE ${TZ})::date) AS is_past
    FROM revenue_forecasts f
    LEFT JOIN LATERAL (
      SELECT sum(p.amount::numeric) AS actual
      FROM payments p
      WHERE (p.created_at AT TIME ZONE ${TZ})::date = f.target_date
    ) a ON true
    ORDER BY f.target_date
  `);

  const list = rows.rows.map((r) => {
    const est = Number(r.estimate) || 0;
    const low = Number(r.low) || 0;
    const high = Number(r.high) || 0;
    const actual = r.actual == null ? null : Number(r.actual);
    const isPast = r.is_past === true || r.is_past === 't';
    const evaluable = isPast && actual != null && actual > 0;
    const errorPct = evaluable ? Math.round((100 * (actual - est) / actual) * 10) / 10 : null;
    const inRange = evaluable ? (actual >= low && actual <= high) : null;
    const date = typeof r.target_date === 'string'
      ? r.target_date
      : new Date(r.target_date).toISOString().split('T')[0];
    return {
      date,
      weekday: Number(r.weekday) || null,
      horizon: r.horizon_days == null ? null : Number(r.horizon_days),
      estimate: est, low, high,
      temp: r.temp == null ? null : Number(r.temp),
      precip: r.precip == null ? null : Number(r.precip),
      code: r.code == null ? null : Number(r.code),
      method: r.method, note: r.note,
      actual, isPast, evaluable, errorPct, inRange,
    };
  });

  const summarize = (arr) => {
    const ev = arr.filter((x) => x.evaluable);
    return {
      total: arr.length,
      evaluated: ev.length,
      avgAbsErrorPct: ev.length ? Math.round((ev.reduce((s, x) => s + Math.abs(x.errorPct), 0) / ev.length) * 10) / 10 : null,
      biasPct: ev.length ? Math.round((ev.reduce((s, x) => s + x.errorPct, 0) / ev.length) * 10) / 10 : null,
      inRange: ev.filter((x) => x.inRange).length,
    };
  };
  const summary = summarize(list);
  const methods = [...new Set(list.map((x) => x.method))];
  const summaryByMethod = methods.map((m) => Object.assign({ method: m }, summarize(list.filter((x) => x.method === m))));

  res.json({ forecasts: list, summary, summaryByMethod });
}

// GET /api/reports/forecasts/hourly-today
// Predpoveď DNEŠNEJ tržby po hodinách z PODOBNÝCH DNÍ v histórii:
// podobný = rovnaký typ dňa (Po–Št / Pi / So–Ne — pracovný vs víkend),
// podobná max teplota (±4 °C, rozširuje sa ±6/±8 kým nie je ≥4 vzoriek)
// a rovnaký mokrý/suchý charakter dňa. Budúca hodina h = recency-vážený
// priemer tržby v hodine h cez tieto dni. Prešlé hodiny = skutočnosť.
// (Predtým sa len rozpočítaval zvyšok denného odhadu → pri nízkom odhade
// ukazoval nuly aj o 16:00 — teraz hodiny hovoria samy za seba.)
export async function forecastHourlyTodayHandler(req, res) {
  const OPEN_LO = 9, OPEN_HI = 23;
  const r = await db.execute(sql`
    WITH hourly AS (
      SELECT (created_at AT TIME ZONE ${TZ})::date AS d,
             extract(hour FROM (created_at AT TIME ZONE ${TZ}))::int AS h,
             sum(amount::numeric)::float AS rev
      FROM payments GROUP BY 1, 2
    ), wx AS (
      SELECT (observed_at AT TIME ZONE ${TZ})::date AS d,
             max(temperature_c)::float AS tmax,
             COALESCE(sum(precipitation_mm), 0)::float AS precip
      FROM weather_observations GROUP BY 1
    )
    SELECT to_char(hourly.d,'YYYY-MM-DD') AS day,
           extract(isodow FROM hourly.d)::int AS weekday,
           hourly.h, hourly.rev, wx.tmax, wx.precip,
           (hourly.d = (now() AT TIME ZONE ${TZ})::date) AS is_today
    FROM hourly JOIN wx ON wx.d = hourly.d
    WHERE hourly.d <= (now() AT TIME ZONE ${TZ})::date
    ORDER BY hourly.d, hourly.h
  `);
  const meta = await db.execute(sql`
    SELECT extract(hour FROM (now() AT TIME ZONE ${TZ}))::int AS cur_hour,
           extract(isodow FROM (now() AT TIME ZONE ${TZ})::date)::int AS today_wd,
           to_char((now() AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS today,
           (SELECT estimate_eur::float FROM revenue_forecasts
             WHERE method = 'v4-loglin' AND target_date = (now() AT TIME ZONE ${TZ})::date
             LIMIT 1) AS estimate,
           (SELECT fc_precip_mm::float FROM revenue_forecasts
             WHERE method = 'v4-loglin' AND target_date = (now() AT TIME ZONE ${TZ})::date
             LIMIT 1) AS fc_precip
  `);
  const m = meta.rows[0] || {};
  const curHour = Number(m.cur_hour) || 0;
  const todayIso = m.today;
  const todayWd = Number(m.today_wd) || 1;
  const estimate = m.estimate == null ? null : Number(m.estimate);

  // Rozdeľ na dnešok vs históriu; história → mapa deň → {weekday,tmax,precip,hod[]}
  const days = new Map();
  const todayByHour = new Array(24).fill(0);
  let todayTmax = null, todayPrecip = 0;
  for (const x of r.rows) {
    const rev = Number(x.rev) || 0;
    if (x.is_today === true || x.is_today === 't') {
      todayByHour[Number(x.h)] = rev;
      todayTmax = x.tmax == null ? todayTmax : Number(x.tmax);
      todayPrecip = Number(x.precip) || 0;
      continue;
    }
    let d = days.get(x.day);
    if (!d) { d = { day: x.day, weekday: Number(x.weekday), tmax: Number(x.tmax), precip: Number(x.precip) || 0, hours: new Array(24).fill(0), total: 0 }; days.set(x.day, d); }
    d.hours[Number(x.h)] = rev; d.total += rev;
  }
  const hist = [...days.values()].filter((d) => d.total >= 20); // refund/test dni von

  // Referencie dneška: typ dňa, teplota (pozorovaná max — popoludní už je
  // smerodajná; fallback snapshot z forecastu), mokrý deň (real. alebo forecast).
  const dayType = (wd) => (wd >= 6 ? 'wknd' : wd === 5 ? 'fri' : 'work');
  const todayType = dayType(todayWd);
  const refTmax = todayTmax;
  const wetToday = todayPrecip > 1 || (Number(m.fc_precip) || 0) > 1;

  // Progresívne uvoľňovanie podobnosti, kým nie je aspoň 4 vzorky.
  const lastDay = hist.length ? hist[hist.length - 1].day : todayIso;
  const dnum = (s) => Date.parse(s) / 86400000;
  const filters = [
    (d) => dayType(d.weekday) === todayType && refTmax != null && Math.abs(d.tmax - refTmax) <= 4 && ((d.precip > 1) === wetToday),
    (d) => dayType(d.weekday) === todayType && refTmax != null && Math.abs(d.tmax - refTmax) <= 6,
    (d) => dayType(d.weekday) === todayType && refTmax != null && Math.abs(d.tmax - refTmax) <= 8,
    (d) => dayType(d.weekday) === todayType,
    () => true,
  ];
  let similar = [];
  for (const f of filters) { similar = hist.filter(f); if (similar.length >= 4) break; }

  // Recency-vážený priemer per hodina (half-life 28 dní).
  const kk = Math.log(2) / 28;
  const predByHour = new Array(24).fill(0);
  if (similar.length) {
    for (let h = 0; h < 24; h++) {
      let sw = 0, swx = 0;
      for (const d of similar) { const w = Math.exp(-kk * (dnum(lastDay) - dnum(d.day))); sw += w; swx += w * d.hours[h]; }
      predByHour[h] = sw > 0 ? swx / sw : 0;
    }
  }

  const banked = todayByHour.reduce((s, v, h) => s + (h <= curHour ? v : 0), 0);
  const hours = [];
  let predRemaining = 0;
  for (let h = OPEN_LO; h <= OPEN_HI; h++) {
    if (h < curHour) hours.push({ hour: h, actual: Math.round(todayByHour[h]), predicted: null });
    else if (h === curHour) hours.push({ hour: h, actual: Math.round(todayByHour[h]), predicted: Math.round(Math.max(0, predByHour[h] - todayByHour[h])), current: true });
    else { const p = Math.round(predByHour[h]); predRemaining += p; hours.push({ hour: h, actual: null, predicted: p }); }
  }
  res.json({
    estimate, banked: Math.round(banked), curHour, hours,
    similarDays: similar.length,
    similarNote: `${todayType === 'wknd' ? 'víkend' : todayType === 'fri' ? 'piatok' : 'pracovný deň'}${refTmax != null ? `, ~${Math.round(refTmax)} °C` : ''}${wetToday ? ', mokrý' : ', suchý'}`,
    hourlyTotal: Math.round(banked + predRemaining + Math.max(0, predByHour[curHour] - todayByHour[curHour])),
  });
}

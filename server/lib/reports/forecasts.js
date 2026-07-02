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
// Predpoveď DNEŠNEJ tržby rozloženej po hodinách: prešlé hodiny = skutočnosť
// (payments), budúce hodiny = zvyšok denného odhadu (v4-loglin) rozdelený
// podľa historického hodinového profilu (podiel tržby v danej hodine,
// história BEZ dneška). Aktuálna hodina = skutočnosť doteraz + dopočet.
export async function forecastHourlyTodayHandler(req, res) {
  const r = await db.execute(sql`
    WITH prof AS (
      SELECT extract(hour FROM (created_at AT TIME ZONE ${TZ}))::int AS h,
             sum(amount::numeric)::float AS rev
      FROM payments
      WHERE (created_at AT TIME ZONE ${TZ})::date < (now() AT TIME ZONE ${TZ})::date
      GROUP BY 1
    ), today AS (
      SELECT extract(hour FROM (created_at AT TIME ZONE ${TZ}))::int AS h,
             sum(amount::numeric)::float AS rev
      FROM payments
      WHERE (created_at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date
      GROUP BY 1
    )
    SELECT gs.h,
           COALESCE(prof.rev, 0)  AS prof_rev,
           COALESCE(today.rev, 0) AS today_rev,
           extract(hour FROM (now() AT TIME ZONE ${TZ}))::int AS cur_hour,
           (SELECT estimate_eur::float FROM revenue_forecasts
             WHERE method = 'v4-loglin'
               AND target_date = (now() AT TIME ZONE ${TZ})::date
             LIMIT 1) AS estimate
    FROM generate_series(0, 23) gs(h)
    LEFT JOIN prof  ON prof.h  = gs.h
    LEFT JOIN today ON today.h = gs.h
    ORDER BY gs.h
  `);
  const rows = r.rows.map((x) => ({
    h: Number(x.h), prof: Number(x.prof_rev) || 0, act: Number(x.today_rev) || 0,
  }));
  const curHour = Number(r.rows[0]?.cur_hour) || 0;
  const estimate = r.rows[0]?.estimate == null ? null : Number(r.rows[0].estimate);
  const banked = rows.reduce((s, x) => s + (x.h <= curHour ? x.act : 0), 0);

  // Budúce hodiny: zvyšok odhadu rozdeľ podľa profilu budúcich hodín.
  const futureProf = rows.reduce((s, x) => s + (x.h > curHour ? x.prof : 0), 0);
  const remaining = Math.max(0, (estimate ?? banked) - banked);
  const OPEN_LO = 9, OPEN_HI = 23;
  const hours = [];
  for (const x of rows) {
    if (x.h < OPEN_LO || x.h > OPEN_HI) continue;
    if (x.h < curHour) hours.push({ hour: x.h, actual: Math.round(x.act), predicted: null });
    else if (x.h === curHour) hours.push({ hour: x.h, actual: Math.round(x.act), predicted: null, current: true });
    else hours.push({
      hour: x.h, actual: null,
      predicted: futureProf > 0 ? Math.round(remaining * x.prof / futureProf) : 0,
    });
  }
  res.json({ estimate, banked: Math.round(banked), curHour, hours });
}

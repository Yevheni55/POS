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

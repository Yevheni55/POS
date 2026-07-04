// Forecast engine v4 — log-lineárny denný model tržieb (vybraný honest backtestom).
// ----------------------------------------------------------------------------
// Návrh potvrdený walk-forward backtestom (scripts/forecast-backtest.mjs):
//   • cieľ log1p(rev) + Duan smearing (vážený, clamp [0.85,1.40]) — opravuje retransform bias
//   • recency-vážený ridge (half-life 21 dní) — sleduje sezónny ramp (nestacionarita)
//   • soft washout: feature rain_severity = rain_hours·max(0,21−appmax) (žiadny hard gate)
//   • PEVNÉ λ=30 (vnorené CV pri N≈43 zhoršuje — overfit na ~8 vnútorných dní)
//   • pásma z OUT-OF-FOLD log-rezíduí (NIE in-sample sd) — model sa hodinovo sám
//     prebacktestuje a kalibruje interval
// Honest walk-forward WAPE ≈ 27–30 % (vs ~38–45 % naivné, ~39 % GBT na rovnakých
// featuroch, ~30–35 % raw € ridge). Číslo je big-day-vážené (WAPE) — na washout
// dňoch model nadhodnocuje; pozri diagnostiku v scripts/forecast-backtest.mjs.
// Zapisuje method 'v4-loglin' do revenue_forecasts → vedľa v2/v3 v admin paneli.
// ----------------------------------------------------------------------------
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { buildStandardizer, fitRidgeWeighted, predictOne } from './ridge.js';

const TZ = 'Europe/Bratislava';
const LAT = 48.1014;
const LON = 17.1136;
const SEASON_START = Date.UTC(2026, 3, 25) / 86400000;
const METHOD = 'v4-loglin';
const LAMBDA = 30;
const HALF_LIFE = 21;        // dní
const WARMUP = 14;           // min. dní pred prvým OOF rezíduom
const OPEN_LO = 10, OPEN_HI = 23; // okno pre cloud/rain agregáty (parita s tréningom)
const MORNING_LO = 5, MORNING_HI = 8;

const log1p = (x) => Math.log(1 + Math.max(0, x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const isoWeekday = (s) => { const [y, m, d] = s.split('-').map(Number); const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return wd === 0 ? 7 : wd; };
const rainSeverity = (r) => r.rainHours * Math.max(0, 21 - r.appmax);
function num(arr, i) { const v = arr && arr[i]; return v == null || Number.isNaN(v) ? null : Number(v); }

// ---------- dáta z kasy + počasia ----------
async function loadDailyHistory() {
  const r = await db.execute(sql`
    WITH rev AS (
      SELECT (created_at AT TIME ZONE ${TZ})::date AS d, sum(amount::numeric)::float AS rev, count(*) AS n_pay
      FROM payments WHERE NOT EXISTS (SELECT 1 FROM fiscal_documents fd WHERE fd.payment_id = payments.id AND fd.source_type = 'storno' AND fd.result_mode IN ('online_success','offline_accepted','reconciled_online_success','reconciled_offline_accepted')) GROUP BY 1
    ), wx AS (
      SELECT (observed_at AT TIME ZONE ${TZ})::date AS d,
             max(temperature_c)::float AS tmax, min(temperature_c)::float AS tmin,
             max(apparent_temp_c)::float AS appmax,
             COALESCE(sum(precipitation_mm),0)::float AS precip,
             (avg(cloud_cover_pct) FILTER (WHERE extract(hour FROM (observed_at AT TIME ZONE ${TZ})) BETWEEN ${OPEN_LO} AND ${OPEN_HI}))::float AS cloud_open,
             count(*) FILTER (WHERE weather_code >= 51 AND extract(hour FROM (observed_at AT TIME ZONE ${TZ})) BETWEEN ${OPEN_LO} AND ${OPEN_HI})::int AS rain_hours
      FROM weather_observations GROUP BY 1
    )
    SELECT to_char(rev.d,'YYYY-MM-DD') AS day, rev.rev,
           wx.tmax, wx.tmin, wx.appmax, wx.precip, wx.cloud_open, wx.rain_hours
    FROM rev JOIN wx ON wx.d = rev.d
    -- Otvorený obchodný deň: vyhoď refund/test riadky (deň <20€ A <3 platby).
    -- Chladné nízko-sezónne dni (31-74€, 9-11 platieb) ostávajú; len 0.1/0.6€ artefakty padnú.
    -- DNEŠOK je NEKOMPLETNÝ (čiastočná tržba) a s najvyššou recency váhou by
    -- otravoval každý hodinový retrain → do tréningu NIKDY (backtest: fix
    -- zlepšil WAPE 35.8→34.6 % už len čistotou dát).
    WHERE (rev.rev >= 20 OR rev.n_pay >= 3) AND wx.tmax IS NOT NULL
      AND rev.d < (now() AT TIME ZONE ${TZ})::date
    ORDER BY rev.d
  `);
  return r.rows.map((x) => normRec(x.day, {
    rev: Number(x.rev) || 0, tmax: num([x.tmax], 0), tmin: num([x.tmin], 0), appmax: num([x.appmax], 0),
    precip: Number(x.precip) || 0, cloudOpen: x.cloud_open == null ? 50 : Number(x.cloud_open), rainHours: Number(x.rain_hours) || 0,
  }));
}
function normRec(day, w) {
  return {
    day, weekday: isoWeekday(day), rev: w.rev,
    tmax: w.tmax == null ? 22 : w.tmax, tmin: w.tmin == null ? 12 : w.tmin, appmax: w.appmax == null ? (w.tmax == null ? 22 : w.tmax) : w.appmax,
    precip: w.precip || 0, cloudOpen: w.cloudOpen == null ? 50 : w.cloudOpen, rainHours: w.rainHours || 0,
  };
}

async function loadHourlyCumShare() {
  const r = await db.execute(sql`
    SELECT extract(hour FROM (created_at AT TIME ZONE ${TZ}))::int AS h, sum(amount::numeric)::float AS rev
    FROM payments WHERE NOT EXISTS (SELECT 1 FROM fiscal_documents fd WHERE fd.payment_id = payments.id AND fd.source_type = 'storno' AND fd.result_mode IN ('online_success','offline_accepted','reconciled_online_success','reconciled_offline_accepted')) GROUP BY 1`);
  const byHour = new Array(24).fill(0);
  for (const x of r.rows) byHour[Number(x.h)] = Number(x.rev) || 0;
  const total = byHour.reduce((s, v) => s + v, 0) || 1;
  const cum = new Array(24).fill(0); let acc = 0;
  for (let h = 0; h < 24; h++) { acc += byHour[h]; cum[h] = acc / total; }
  return cum;
}
async function loadTodayActual() {
  const r = await db.execute(sql`
    SELECT to_char((now() AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS today,
           extract(hour FROM (now() AT TIME ZONE ${TZ}))::int AS cur_hour,
           COALESCE((SELECT sum(amount::numeric) FROM payments WHERE (created_at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date
             AND NOT EXISTS (SELECT 1 FROM fiscal_documents fd WHERE fd.payment_id = payments.id AND fd.source_type = 'storno' AND fd.result_mode IN ('online_success','offline_accepted','reconciled_online_success','reconciled_offline_accepted'))),0)::float AS today_rev`);
  const row = r.rows[0] || {};
  return { today: row.today, curHour: Number(row.cur_hour) || 0, todayRev: Number(row.today_rev) || 0 };
}

// ---------- forecast počasia → denné agregáty (parita s tréningom) ----------
async function fetchForecastRecs(today) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(LAT));
  url.searchParams.set('longitude', String(LON));
  url.searchParams.set('hourly', ['temperature_2m', 'apparent_temperature', 'precipitation', 'precipitation_probability', 'cloud_cover', 'weather_code'].join(','));
  url.searchParams.set('timezone', TZ);
  url.searchParams.set('forecast_days', '8');
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error('Open-Meteo HTTP ' + resp.status);
  const j = await resp.json();
  const h = j.hourly || {};
  const t = h.time || [];
  const byDay = {};
  for (let i = 0; i < t.length; i++) {
    const day = String(t[i]).slice(0, 10);
    const hour = parseInt(String(t[i]).slice(11, 13), 10);
    (byDay[day] ||= []).push({ hour, temp: num(h.temperature_2m, i), app: num(h.apparent_temperature, i), precip: num(h.precipitation, i) || 0, prob: num(h.precipitation_probability, i), cloud: num(h.cloud_cover, i), code: num(h.weather_code, i) });
  }
  const recs = [];
  for (const day of Object.keys(byDay).sort()) {
    const hrs = byDay[day];
    let tmax = null, tmin = null, appmax = null, precip = 0, cloudSum = 0, cloudN = 0, rainHours = 0, probMax = 0;
    for (const x of hrs) {
      if (x.temp != null) { tmax = tmax == null ? x.temp : Math.max(tmax, x.temp); tmin = tmin == null ? x.temp : Math.min(tmin, x.temp); }
      if (x.app != null) appmax = appmax == null ? x.app : Math.max(appmax, x.app);
      precip += x.precip || 0;
      if (x.hour >= OPEN_LO && x.hour <= OPEN_HI) {
        if (x.cloud != null) { cloudSum += x.cloud; cloudN++; }
        if (x.code != null && x.code >= 51) rainHours++;
        if (x.prob != null) probMax = Math.max(probMax, x.prob);
      }
    }
    recs.push({ rec: normRec(day, { rev: 0, tmax, tmin, appmax, precip, cloudOpen: cloudN ? cloudSum / cloudN : 50, rainHours }), horizon: Math.round(dayNum(day) - dayNum(today)), stormProb: probMax / 100 });
  }
  return recs;
}

// ---------- feature builder (čistá funkcia rec → vektor) ----------
// AR členy (lag/ewma) sme po honest backteste vypustili: pri N≈43 nepridali skill
// (C1 s AR 30.9 % vs C1d bez AR 30.3 % WAPE — remíza) a nosili hardcoded fallback.
// Žiadna feature nezávisí od minulosti → bez look-ahead, O(n) fit. export = bez DB.
export function buildFeatures(rec) {
  const wd = rec.weekday, App = rec.appmax;
  const isWeekend = wd >= 6 ? 1 : 0, isFriday = wd === 5 ? 1 : 0;
  const feats = [
    ['intercept', 1, true], ['isWeekend', isWeekend, true], ['isFriday', isFriday, true],
    ['trend', dayNum(rec.day) - SEASON_START, false], ['appmax', App, false], ['appSat', Math.min(App, 28), false],
    ['tmin', rec.tmin, false], ['precip', Math.min(rec.precip, 10), false],
    ['rainHours', rec.rainHours, false], ['rainSeverity', rainSeverity(rec), false],
    ['cloud', rec.cloudOpen / 100, false], ['weekendXapp', isWeekend * App, false],
  ];
  return { vec: feats.map((f) => f[1]), binMask: feats.map((f) => f[2]) };
}

// ---------- fit log1p ridge (recency váhy + downweight dažďa + Duan smear) ----------
export function fitModel(history) {
  const rawX = history.map((r) => buildFeatures(r).vec);
  const std = buildStandardizer(rawX, buildFeatures(history[0]).binMask);
  const X = rawX.map((x) => std.apply(x));
  const Y = history.map((r) => log1p(r.rev));
  const last = dayNum(history[history.length - 1].day), kk = Math.log(2) / HALF_LIFE;
  const w = history.map((r) => { let ww = Math.exp(-kk * (last - dayNum(r.day))); if (rainSeverity(r) > 3) ww *= 0.5; return ww; });
  const beta = fitRidgeWeighted(X, Y, LAMBDA, w);
  if (!beta || beta.some((b) => !Number.isFinite(b))) return { std, beta: null, smear: 1 }; // singulárny/NaN → preskočí sa
  // Duan smearing konzistentný s WLS: vážený priemer exp(reziduum)
  let ssm = 0, sw = 0;
  for (let i = 0; i < X.length; i++) { ssm += w[i] * Math.exp(Y[i] - predictOne(beta, X[i])); sw += w[i]; }
  return { std, beta, smear: clamp(ssm / sw, 0.85, 1.40) };
}
// log-priestor mu pre daný rec
export function muOf(model, rec) {
  if (!model.beta) return null;
  return predictOne(model.beta, model.std.apply(buildFeatures(rec).vec));
}
export function eurFromMu(model, mu) { return Math.max(0, Math.exp(mu) * model.smear - 1); }

// ---------- vnútorný walk-forward: OOF log-rezíduá (pásma) + cvWAPE (self-eval) ----------
// Jeden prechod (predtým dva): pre každý deň t natrénuj na [0..t-1] a predpovedz t.
function oofPass(history) {
  const res = []; let sae = 0, sact = 0;
  for (let t = WARMUP; t < history.length; t++) {
    const m = fitModel(history.slice(0, t));
    const mu = muOf(m, history[t]);
    if (mu == null) continue;
    res.push(log1p(history[t].rev) - mu);
    sae += Math.abs(eurFromMu(m, mu) - history[t].rev); sact += history[t].rev;
  }
  return { res, cvWape: sact > 0 ? 100 * sae / sact : null };
}
function bandFromResiduals(res, mu, smear, horizon) {
  let qlo, qhi;
  // q05/95 (predtým q10/90): backtest kalibrácia 2026-07-02 — pokrytie
  // 74 % → 83 % (cieľ 80 %) za cenu širšieho pásma (~1160→1550 €).
  if (res.length >= 10) { const q = [...res].sort((a, b) => a - b); qlo = q[Math.floor(0.05 * q.length)]; qhi = q[Math.min(q.length - 1, Math.floor(0.95 * q.length))]; }
  else { const sd = res.length ? Math.sqrt(res.reduce((s, e) => s + e * e, 0) / res.length) : 0.6; qlo = -1.64 * sd; qhi = 1.64 * sd; }
  const widen = 1 + 0.10 * Math.max(0, horizon); // forecast neistota rastie s horizontom
  const low = Math.max(0, Math.exp(mu + qlo * widen) * smear - 1);
  const high = Math.exp(mu + qhi * widen) * smear - 1;
  return { low, high };
}

// ---------- hlavný beh ----------
export async function runForecastLogLin() {
  const history = await loadDailyHistory();
  if (history.length < WARMUP) return { ok: false, reason: `málo dát (${history.length}<${WARMUP})` };
  const { today, curHour, todayRev } = await loadTodayActual();
  const cumShare = await loadHourlyCumShare();
  const model = fitModel(history);
  if (!model.beta) return { ok: false, reason: 'fit zlyhal (singulárny)' };
  const { res, cvWape } = oofPass(history); // pásma + expanding-window self-eval

  const fcRecs = await fetchForecastRecs(today);
  const out = [];
  for (const { rec, horizon, stormProb } of fcRecs) {
    if (horizon < 0 || horizon > 7) continue;
    const mu = muOf(model, rec);
    if (mu == null) continue;
    let est = eurFromMu(model, mu);
    if (!Number.isFinite(est)) continue; // NaN/Inf → preskoč, nezapisuj
    const band = bandFromResiduals(res, mu, model.smear, horizon);
    let low = band.low, high = band.high;
    // Búrkové hedgovanie NA INFERENCII (nie feature — bez extrapolačného
    // rizika, backtest 07-02 zamietol hotStorm featurу). Prípad 01.07:
    // deterministika 0,5 mm, realita 54,5 mm → 431 € vs odhad 1245 €.
    // Konvektívne búrky nesie precipitation_probability aj keď mm nevidno:
    // pri p≥25 % a suchom deterministickom vstupe zmiešaj s wet-scenárom.
    const p = Math.min(Number(stormProb) || 0, 0.9);
    if (p >= 0.25 && rec.rainHours < 2) {
      const wet = { ...rec, rainHours: Math.max(3, rec.rainHours), precip: Math.max(6, rec.precip) };
      const muWet = muOf(model, wet);
      if (muWet != null && muWet < mu) {
        const estWet = eurFromMu(model, muWet);
        if (Number.isFinite(estWet)) {
          est = (1 - p) * est + p * estWet;
          low = Math.min(low, bandFromResiduals(res, muWet, model.smear, horizon).low);
        }
      }
    }
    // intraday nowcast dneška: banked + očakávaný zvyšok podľa hodinovej krivky
    if (rec.day === today) {
      const shareDone = clamp(cumShare[curHour] || 0, 0, 0.999);
      const modelRemaining = todayRev + est * (1 - shareDone);
      const pace = shareDone > 0.05 ? todayRev / shareDone : est;
      est = shareDone * pace + (1 - shareDone) * modelRemaining;
      est = Math.max(est, todayRev);
      low = Math.max(low * (1 - shareDone) + todayRev * shareDone, todayRev); // pásmo sa zužuje
      high = Math.max(high, est);
    }
    out.push({
      day: rec.day, horizon, weekday: rec.weekday,
      estimate: Math.round(est), low: Math.round(low), high: Math.round(high),
      tmax: rec.tmax, precip: Math.round(rec.precip * 10) / 10, rainHours: rec.rainHours,
      note: noteFor(rec, rec.day === today, todayRev),
    });
  }
  const todayRow = out.find((o) => o.day === today);
  if (!todayRow) console.warn('[forecast v4] dnešok chýba v Open-Meteo odpovedi — bez intraday/snapshotu');
  await upsertForecasts(out);
  await freezeMorning(todayRow, curHour);
  // cvWape = expanding-window self-eval na HISTÓRII (nie forward); skutočný forward
  // je až v4-loglin-am vs realita, ktorý sa kumuluje v admin paneli.
  return { ok: true, days: out.length, trainDays: history.length, smear: Math.round(model.smear * 100) / 100, oofResid: res.length, cvWape: cvWape == null ? null : Math.round(cvWape * 10) / 10, today: todayRow || null };
}

function noteFor(rec, isToday, todayRev) {
  const cat = rec.rainHours >= 2 ? 'dážď' : rec.cloudOpen >= 65 ? 'zamračené' : rec.cloudOpen >= 30 ? 'polooblačno' : 'jasno';
  let s = `${Math.round(rec.appmax)}°C ${cat}`;
  if (rec.precip > 0.5) s += ` (${Math.round(rec.precip * 10) / 10} mm)`;
  if (isToday) s += ` · intraday (zatiaľ ${Math.round(todayRev)} €)`;
  return 'v4-loglin: ' + s;
}

async function upsertForecasts(rows) {
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO revenue_forecasts
        (target_date, made_at, horizon_days, estimate_eur, low_eur, high_eur,
         fc_temp_max_c, fc_precip_mm, fc_weather_code, weekday, method, note)
      VALUES (${r.day}, now(), ${r.horizon}, ${r.estimate}, ${r.low}, ${r.high},
              ${r.tmax}, ${r.precip}, ${r.rainHours}, ${r.weekday}, ${METHOD}, ${r.note})
      ON CONFLICT (target_date, method) DO UPDATE SET
        made_at = now(), horizon_days = EXCLUDED.horizon_days,
        estimate_eur = EXCLUDED.estimate_eur, low_eur = EXCLUDED.low_eur, high_eur = EXCLUDED.high_eur,
        fc_temp_max_c = EXCLUDED.fc_temp_max_c, fc_precip_mm = EXCLUDED.fc_precip_mm,
        fc_weather_code = EXCLUDED.fc_weather_code, weekday = EXCLUDED.weekday, note = EXCLUDED.note`);
  }
}
// poctivý eval: zamrazni ranný (pred-open) odhad dneška do 'v4-loglin-am'.
// Self-heal: tiky 5–7 h OBNOVUJÚ snapshot (prepíšu prípadný degradovaný skorý odhad),
// tik o 8 h ho ZAMKNE (DO NOTHING) → finálny pred-open odhad. Volá sa len keď je
// todayRow (úspešný forecast s konečným est) — degradovaný tik snapshot nezapíše.
async function freezeMorning(todayRow, curHour) {
  if (!todayRow || curHour < MORNING_LO || curHour > MORNING_HI) return;
  const r = todayRow;
  const lock = curHour >= MORNING_HI; // o 8 h zamknúť, do 7 h ešte obnovovať
  const conflict = lock
    ? sql`ON CONFLICT (target_date, method) DO NOTHING`
    : sql`ON CONFLICT (target_date, method) DO UPDATE SET made_at = now(),
        estimate_eur = EXCLUDED.estimate_eur, low_eur = EXCLUDED.low_eur, high_eur = EXCLUDED.high_eur,
        fc_temp_max_c = EXCLUDED.fc_temp_max_c, fc_precip_mm = EXCLUDED.fc_precip_mm, note = EXCLUDED.note`;
  await db.execute(sql`
    INSERT INTO revenue_forecasts
      (target_date, made_at, horizon_days, estimate_eur, low_eur, high_eur,
       fc_temp_max_c, fc_precip_mm, fc_weather_code, weekday, method, note)
    VALUES (${r.day}, now(), 0, ${r.estimate}, ${r.low}, ${r.high},
            ${r.tmax}, ${r.precip}, ${r.rainHours}, ${r.weekday}, ${METHOD + '-am'},
            ${'pred-open snapshot · ' + r.note}) ${conflict}`);
}

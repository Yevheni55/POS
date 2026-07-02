// Overí, že PRODUKČNÝ engine-loglin.js (čisté funkcie) reprodukuje výsledok
// validovaného modelu C1 z backtestu. Spustenie: node scripts/verify-loglin-engine.mjs
// Importuje len čisté exporty (DB sa pri importe NEpripája — pool je lazy).
import fs from 'fs';
import { buildFeatures, fitModel, muOf, eurFromMu } from '../server/lib/forecast/engine-loglin.js';

const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const log1p = (x) => Math.log(1 + Math.max(0, x));

const lines = fs.readFileSync('tmp/fc-daily.csv', 'utf8').trim().split('\n');
const hdr = lines[0].split(',');
let rows = lines.slice(1).map((l) => { const c = l.split(','); const o = {}; hdr.forEach((h, i) => { o[h] = c[i]; }); return o; })
  .filter((o) => o.day !== '2026-06-18' && (+o.rev >= 20 || +o.n_pay >= 3)) // rovnaký open-day filter ako prod
  .map((o) => ({ day: o.day, weekday: +o.weekday, rev: +o.rev, tmax: +o.tmax, tmin: +o.tmin, appmax: +o.appmax, precip: +o.precip, cloudOpen: +o.cloud_open, rainHours: +o.rain_hours }))
  .sort((a, b) => dayNum(a.day) - dayNum(b.day));

const WARMUP = 14;
let sae = 0, sact = 0, sse = 0, ssle = 0, n = 0;
const preds = [];
for (let t = WARMUP; t < rows.length; t++) {
  const hist = rows.slice(0, t);
  const m = fitModel(hist);
  const mu = muOf(m, rows[t]);
  const est = eurFromMu(m, mu);
  const a = rows[t].rev;
  sae += Math.abs(est - a); sact += a; sse += (est - a) ** 2; ssle += (log1p(est) - log1p(a)) ** 2; n++;
  preds.push({ day: rows[t].day, a, est });
}
const wape = 100 * sae / sact, mae = sae / n, rmse = Math.sqrt(sse / n), rmsle = Math.sqrt(ssle / n);
console.log(`Produkčný engine (C1) walk-forward | N=${rows.length} warmup=${WARMUP} test=${n}`);
console.log(`  WAPE=${wape.toFixed(1)}%  MAE=${mae.toFixed(0)}€  RMSE=${rmse.toFixed(0)}€  RMSLE=${rmsle.toFixed(3)}`);
const expect = 34.6; // C1d na N=56 (2026-07-02, po vyluceni dnesneho dna z dat)
const ok = Math.abs(wape - expect) < 1.0;
console.log(`  očakávané ~${expect}% (backtest C1d, bez AR) → ${ok ? '✅ PARITA OK' : '❌ NEZHODA'}`);
// posledné 3 dni — sanity
for (const p of preds.slice(-3)) console.log(`    ${p.day}: actual=${p.a.toFixed(0)}€  predikcia=${p.est.toFixed(0)}€`);
process.exit(ok ? 0 : 1);

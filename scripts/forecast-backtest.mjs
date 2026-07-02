// ============================================================================
// Walk-forward backtest pre denný forecast tržieb (v4 návrh).
// Spustenie:  node scripts/forecast-backtest.mjs [tmp/fc-daily.csv]
//
// Implementuje spec z design-panelu:
//  - cieľ log1p(rev) + Duan smearing (clamp [0.85,1.40])
//  - soft washout cez rain_severity = rain_hours*max(0,21-appmax) (žiadny hard hurdle)
//  - AR členy: lag_same_weekday, ewma_roll (forma/úroveň, nestacionarita)
//  - recency váhy (half-life) + λ vyberané VNORENÝM expanding walk-forwardom (bez leaku)
//  - pásma z OUT-OF-FOLD log-rezíduí (NIE in-sample sd)
//  - metriky odolné voči near-zero: MAE, MdAE, WAPE, RMSLE, bias, pokrytie pásma
//  - NIKDY n_pay ako feature (leak: realizované až na konci dňa)
//
// Trik proti leaku + pre rýchlosť: feature riadku j závisí len od riadkov < j,
// takže ho možno predpočítať globálne raz; akýkoľvek train-slice je prefix.
// ============================================================================
import fs from 'fs';
import { fitGBT, predictGBT } from '../server/lib/forecast/gbt.js';
import { buildStandardizer } from '../server/lib/forecast/ridge.js';

// ---------- načítanie ----------
function loadDaily(path) {
  const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
  const hdr = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const c = l.split(','); const o = {};
    hdr.forEach((h, i) => { o[h] = c[i]; });
    return {
      day: o.day, weekday: +o.weekday, rev: +o.rev, nPay: +o.n_pay,
      tmax: +o.tmax, tmin: +o.tmin, appmax: +o.appmax,
      precip: +o.precip, cloudOpen: +o.cloud_open, rainHours: +o.rain_hours, worstCode: +o.worst_code,
    };
  });
}

// ---------- helpery ----------
const SEASON_START = Date.UTC(2026, 3, 25) / 86400000;
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const log1p = (x) => Math.log(1 + Math.max(0, x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const median = (a) => { const x = [...a].sort((p, q) => p - q); const i = x.length >> 1; return x.length ? (x.length % 2 ? x[i] : (x[i - 1] + x[i]) / 2) : 0; };
const rainSeverity = (r) => r.rainHours * Math.max(0, 21 - r.appmax);

// ---------- feature builder (AR-aware) ----------
// prior = riadky STRIKTNE pred rec (chronologicky). opts.ar zapína AR členy.
function buildFeatures(rec, prior, opts = {}) {
  const ar = opts.ar !== false;
  const wd = rec.weekday;
  const App = rec.appmax;
  const isWeekend = wd >= 6 ? 1 : 0;
  const isFriday = wd === 5 ? 1 : 0;
  const trend = dayNum(rec.day) - SEASON_START;
  const appSat = Math.min(App, 28);
  const precipCap = Math.min(rec.precip, 10);

  // AR: posledný rovnaký deň v týždni + EWMA log1p (half-life 7 dní)
  let lag = null, ewma = null;
  if (prior.length) {
    for (let i = prior.length - 1; i >= 0; i--) if (prior[i].weekday === wd) { lag = log1p(prior[i].rev); break; }
    const last = dayNum(prior[prior.length - 1].day);
    const kk = Math.log(2) / 7;
    let sw = 0, swx = 0;
    for (const p of prior) { const w = Math.exp(-kk * (last - dayNum(p.day))); sw += w; swx += w * log1p(p.rev); }
    ewma = sw ? swx / sw : null;
  }
  const meanPrior = prior.length ? prior.reduce((s, p) => s + log1p(p.rev), 0) / prior.length : Math.log(301);
  if (lag == null) lag = meanPrior;
  if (ewma == null) ewma = meanPrior;

  const feats = [
    ['intercept', 1, true],
    ['isWeekend', isWeekend, true],
    ['isFriday', isFriday, true],
    ['trend', trend, false],
    ['appmax', App, false],
    ['appSat', appSat, false],
    ['tmin', rec.tmin, false],
    ['precip', precipCap, false],
    ['rainHours', rec.rainHours, false],
    ['rainSeverity', rainSeverity(rec), false],
    ['cloud', rec.cloudOpen / 100, false],
    ['weekendXapp', isWeekend * App, false],
  ];
  // Letné rozšírenia (jún-júl dáta): hinge nad 30 °C (peak-under −402 €),
  // hot-storm interakcia (rainSeverity je pri 35 °C nulová → slepota na búrky),
  // víkend×peklo (06-20/21 podstrel).
  if (opts.hinge30) feats.push(['hinge30', Math.max(0, App - 30), false]);
  if (opts.hotStorm) feats.push(['hotStorm', rec.rainHours * Math.max(0, App - 26), false]);
  if (opts.wkndHinge) feats.push(['wkndHinge', isWeekend * Math.max(0, App - 30), false]);
  if (ar) {
    feats.push(['lagSameWd', lag, false]);
    feats.push(['ewmaRoll', ewma, false]);
  }
  return { vec: feats.map((f) => f[1]), names: feats.map((f) => f[0]), binMask: feats.map((f) => f[2]) };
}

// ---------- vážený ridge (diagonálne váhy + neregularizovaný intercept) ----------
function solveLinear(A, b) {
  const d = b.length;
  const M = A.map((row, i) => row.slice().concat(b[i]));
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const pv = M[col][col];
    for (let j = col; j <= d; j++) M[col][j] /= pv;
    for (let r = 0; r < d; r++) { if (r === col) continue; const f = M[r][col]; if (!f) continue; for (let j = col; j <= d; j++) M[r][j] -= f * M[col][j]; }
  }
  return M.map((row) => row[d]);
}
function fitRidgeW(X, y, lambda, w) {
  const n = X.length, d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i], yi = y[i], wi = w[i];
    for (let j = 0; j < d; j++) { b[j] += wi * xi[j] * yi; const aj = A[j]; for (let k = 0; k < d; k++) aj[k] += wi * xi[j] * xi[k]; }
  }
  for (let j = 1; j < d; j++) A[j][j] += lambda;
  return solveLinear(A, b);
}
const dot = (w, x) => { let s = 0; for (let j = 0; j < x.length; j++) s += w[j] * x[j]; return s; };

// ============================================================================
// JADRO: log1p ridge so smearingom, recency váhami a downweightom dažďa.
// Pracuje s GLOBÁLNE predpočítanými feature (FG). Indexy do `rows`.
// ============================================================================
function makeLogRidge(FG, { halfLife = 21, downweightRain = true } = {}) {
  return {
    fit(trainIdx, lambda, H) {
      const hl = H ?? halfLife;
      const rawX = trainIdx.map((j) => FG[j].vec);
      const binMask = FG[trainIdx[0]].binMask;
      const std = buildStandardizer(rawX, binMask);
      const X = rawX.map((x) => std.apply(x));
      const Y = trainIdx.map((j) => log1p(rows[j].rev));
      const last = dayNum(rows[trainIdx[trainIdx.length - 1]].day);
      const kk = hl >= 1e8 ? 0 : Math.log(2) / hl;
      const w = trainIdx.map((j) => {
        let ww = Math.exp(-kk * (last - dayNum(rows[j].day)));
        if (downweightRain && rainSeverity(rows[j]) > 3) ww *= 0.5; // tlmí pravý dážď
        return ww;
      });
      const beta = fitRidgeW(X, Y, lambda, w);
      let smear = 1;
      // Duan smearing KONZISTENTNÝ s WLS: vážený priemer exp(reziduum) (rovnaké w ako fit)
      if (beta) { let ssm = 0, sw = 0; for (let i = 0; i < X.length; i++) { ssm += w[i] * Math.exp(Y[i] - dot(beta, X[i])); sw += w[i]; } smear = clamp(ssm / sw, 0.85, 1.40); }
      return { std, beta, smear };
    },
    predict(state, testIdx) {
      if (!state.beta) return null;
      const mu = dot(state.beta, state.std.apply(FG[testIdx].vec));
      return Math.max(0, Math.exp(mu) * state.smear - 1);
    },
    // log-rezíduum pre pásma/CV
    muOf(state, testIdx) { return state.beta ? dot(state.beta, state.std.apply(FG[testIdx].vec)) : null; },
  };
}

// vnorený expanding walk-forward na výber (λ,H) IBA z train prefixu (bez leaku)
const LAMBDAS = [1, 3, 10, 30, 100];
const HALFLIVES = [14, 21, 1e9];
function pickHyper(engine, trainIdx) {
  const K = Math.min(8, Math.floor(trainIdx.length / 3));
  if (K < 3) return { lambda: 30, H: 21 };
  let best = null;
  for (const lambda of LAMBDAS) for (const H of HALFLIVES) {
    let sse = 0, ok = 0;
    for (let s = trainIdx.length - K; s < trainIdx.length; s++) {
      const sub = trainIdx.slice(0, s);
      const st = engine.fit(sub, lambda, H);
      const mu = engine.muOf(st, trainIdx[s]);
      if (mu == null) continue;
      const e = log1p(rows[trainIdx[s]].rev) - mu; sse += e * e; ok++;
    }
    if (ok && (!best || sse / ok < best.score)) best = { lambda, H, score: sse / ok };
  }
  return best || { lambda: 30, H: 21 };
}

// ---------- GBT log (FÉR komparátor: ROVNAKÉ feature ako ridge, bez interceptu) ----------
const gbtVec = (idx) => FG[idx].vec.slice(1); // identický feature set ako log-ridge
function fitGbtLog(trainIdx) {
  const X = trainIdx.map(gbtVec);
  const Y = trainIdx.map((j) => log1p(rows[j].rev));
  const model = fitGBT(X, Y, { trees: 60, maxDepth: 2, minLeaf: 12, shrinkage: 0.05 });
  let s = 0; for (let i = 0; i < X.length; i++) s += Math.exp(Y[i] - predictGBT(model, X[i]));
  return { model, smear: clamp(s / X.length, 0.85, 1.40) };
}
const gbtPredict = (s, idx) => Math.max(0, Math.exp(predictGBT(s.model, gbtVec(idx))) * s.smear - 1);

// ============================================================================
// MODELY: predict(trainIdx, testIdx) -> est €
// ============================================================================
let rows; // nastaví main
let ENG, ENG0; // log-ridge engine s/bez AR

const recencyMean = (trainIdx, hl = 14) => {
  const last = dayNum(rows[trainIdx[trainIdx.length - 1]].day); const kk = Math.log(2) / hl;
  let sw = 0, swx = 0; for (const j of trainIdx) { const w = Math.exp(-kk * (last - dayNum(rows[j].day))); sw += w; swx += w * rows[j].rev; } return swx / sw;
};

const MODELS = {
  // --- baseliny ---
  B0_seasonalNaive: (tr, te) => { for (let i = tr.length - 1; i >= 0; i--) if (rows[tr[i]].weekday === rows[te].weekday) return rows[tr[i]].rev; return recencyMean(tr); },
  B1_ewmaLevel: (tr) => recencyMean(tr, 14),
  B2_weekdayMean3: (tr, te) => { const same = tr.filter((j) => rows[j].weekday === rows[te].weekday).slice(-3); return same.length ? same.reduce((s, j) => s + rows[j].rev, 0) / same.length : recencyMean(tr); },
  B3_weekendTrend: (tr, te) => { // weather-free kontrola
    const we = tr.filter((j) => rows[j].weekday >= 6), wk = tr.filter((j) => rows[j].weekday < 6);
    const base = (rows[te].weekday >= 6 ? we : wk);
    if (!base.length) return recencyMean(tr);
    const lvl = base.reduce((s, j) => s + rows[j].rev, 0) / base.length;
    const scale = recencyMean(tr, 10) / (tr.reduce((s, j) => s + rows[j].rev, 0) / tr.length);
    return lvl * scale;
  },
  B4_weekdayTempband: (tr, te) => {
    const band = (t) => t <= 18 ? 'lo' : t <= 24 ? 'mid' : 'hi';
    const byWd = {}, byBand = {}; const all = [];
    tr.forEach((j) => { const r = rows[j]; (byWd[r.weekday] ||= []).push(r.rev); (byBand[band(r.tmax)] ||= []).push(r.rev); all.push(r.rev); });
    const m = all.reduce((a, b) => a + b, 0) / all.length;
    const wdMed = byWd[rows[te].weekday] ? median(byWd[rows[te].weekday]) : m;
    const bm = byBand[band(rows[te].tmax)]; const mul = bm ? (bm.reduce((a, b) => a + b, 0) / bm.length) / m : 1;
    return wdMed * mul;
  },
  // --- kandidáti ---
  C1_logRidgeFixed: (tr, te) => ENG.predict(ENG.fit(tr, 30, 21), te),          // pevné λ/H (AR, decay)
  C1b_lam10: (tr, te) => ENG.predict(ENG.fit(tr, 10, 21), te),                 // λ citlivosť
  C1c_lam100: (tr, te) => ENG.predict(ENG.fit(tr, 100, 21), te),
  C1d_noARfix: (tr, te) => ENG0.predict(ENG0.fit(tr, 30, 21), te),             // bez AR (čistá ablácia AR)
  C1e_noDecay: (tr, te) => ENG.predict(ENG.fit(tr, 30, 1e9), te),             // bez recency (flat váhy)
  C2_logRidgeCV: (tr, te) => { const h = pickHyper(ENG, tr); return ENG.predict(ENG.fit(tr, h.lambda, h.H), te); }, // vnorené CV
  C3_rawNoDecay: (tr, te) => {                                                  // ablácia: raw € bez decay
    const rawX = tr.map((j) => FG[j].vec); const std = buildStandardizer(rawX, FG[tr[0]].binMask);
    const X = rawX.map((x) => std.apply(x)); const Y = tr.map((j) => rows[j].rev);
    const beta = fitRidgeW(X, Y, 30, tr.map(() => 1)); return beta ? Math.max(0, dot(beta, std.apply(FG[te].vec))) : recencyMean(tr);
  },
  C4_noAR: (tr, te) => { const h = pickHyper(ENG0, tr); return ENG0.predict(ENG0.fit(tr, h.lambda, h.H), te); }, // ablácia: bez AR
  C6_gbtLog: (tr, te) => gbtPredict(fitGbtLog(tr), te),
  // --- ensemble ---
  E1_blend: (tr, te) => { const h = pickHyper(ENG, tr); const c2 = ENG.predict(ENG.fit(tr, h.lambda, h.H), te); return 0.6 * c2 + 0.25 * recencyMean(tr, 14) + 0.15 * MODELS.B0_seasonalNaive(tr, te); },
  E2_geomTreeLin: (tr, te) => { const c1 = ENG.predict(ENG.fit(tr, 30, 21), te); const g = gbtPredict(fitGbtLog(tr), te); return Math.sqrt(Math.max(1, c1) * Math.max(1, g)); },
};

// ============================================================================
// WALK-FORWARD + METRIKY
// ============================================================================
function walkForward(name, warmup) {
  const fn = MODELS[name]; const preds = [];
  for (let t = warmup; t < rows.length; t++) {
    const tr = Array.from({ length: t }, (_, i) => i);
    let est; try { est = fn(tr, t); } catch { est = null; }
    if (est == null || !isFinite(est)) est = recencyMean(tr);
    preds.push({ day: rows[t].day, weekday: rows[t].weekday, actual: rows[t].rev, est, worstCode: rows[t].worstCode });
  }
  return preds;
}
function metrics(preds) {
  const n = preds.length; let sae = 0, sse = 0, sAct = 0, sBias = 0, ssle = 0; const aes = [];
  let nW = 0, nA = 0;
  for (const p of preds) {
    const e = p.est - p.actual; sae += Math.abs(e); sse += e * e; sAct += p.actual; sBias += e; aes.push(Math.abs(e));
    const le = log1p(p.est) - log1p(p.actual); ssle += le * le;
    if (p.actual >= 200) { nW += Math.abs(e); nA += p.actual; }
  }
  return { n, mae: sae / n, mdae: median(aes), rmse: Math.sqrt(sse / n), wape: 100 * sae / sAct, rmsle: Math.sqrt(ssle / n), bias: sBias / n, wapeNorm: nA ? 100 * nW / nA : null };
}

// ============================================================================
// MAIN
// ============================================================================
const path = process.argv[2] || 'tmp/fc-daily.csv';
const TODAY = '2026-06-18';
// Otvorený deň = reálne obchodovanie. Vyhoď refund/test riadky (0.1€/0.6€, 1-2 platby):
// deň <20€ A <3 platby NIE je obchodný deň. Chladné apr. dni (31-74€, 9-11 platieb) ostávajú.
const isOpenDay = (r) => r.rev >= 20 || r.nPay >= 3;
rows = loadDaily(path).filter((r) => r.day !== TODAY && isOpenDay(r)).sort((a, b) => dayNum(a.day) - dayNum(b.day));

// globálne predpočítané feature (riadok j len z riadkov < j → bez leaku)
const FG = rows.map((r, j) => buildFeatures(r, rows.slice(0, j), { ar: true }));
const FG0 = rows.map((r, j) => buildFeatures(r, rows.slice(0, j), { ar: false }));
ENG = makeLogRidge(FG, { halfLife: 21, downweightRain: true });
ENG0 = makeLogRidge(FG0, { halfLife: 21, downweightRain: true });

// Letné varianty (júl 2026): hinge30 / hotStorm / wkndHinge nad C1d základom
const FG_H = rows.map((r, j) => buildFeatures(r, rows.slice(0, j), { ar: false, hinge30: true }));
const FG_S = rows.map((r, j) => buildFeatures(r, rows.slice(0, j), { ar: false, hotStorm: true }));
const FG_HS = rows.map((r, j) => buildFeatures(r, rows.slice(0, j), { ar: false, hinge30: true, hotStorm: true }));
const FG_HSW = rows.map((r, j) => buildFeatures(r, rows.slice(0, j), { ar: false, hinge30: true, hotStorm: true, wkndHinge: true }));
const ENG_H = makeLogRidge(FG_H, { halfLife: 21, downweightRain: true });
const ENG_S = makeLogRidge(FG_S, { halfLife: 21, downweightRain: true });
const ENG_HS = makeLogRidge(FG_HS, { halfLife: 21, downweightRain: true });
const ENG_HSW = makeLogRidge(FG_HSW, { halfLife: 21, downweightRain: true });
const ENG_HS28 = makeLogRidge(FG_HS, { halfLife: 28, downweightRain: true });
MODELS.V1_hinge30 = (tr, te) => ENG_H.predict(ENG_H.fit(tr, 30, 21), te);
MODELS.V2_hotStorm = (tr, te) => ENG_S.predict(ENG_S.fit(tr, 30, 21), te);
MODELS.V3_both = (tr, te) => ENG_HS.predict(ENG_HS.fit(tr, 30, 21), te);
MODELS.V4_bothWknd = (tr, te) => ENG_HSW.predict(ENG_HSW.fit(tr, 30, 21), te);
MODELS.V5_both_hl28 = (tr, te) => ENG_HS28.predict(ENG_HS28.fit(tr, 30, 28), te);

const order = ['B0_seasonalNaive', 'B1_ewmaLevel', 'B2_weekdayMean3', 'B3_weekendTrend', 'B4_weekdayTempband',
  'C3_rawNoDecay', 'C4_noAR', 'C6_gbtLog', 'C1d_noARfix', 'C1e_noDecay', 'C1b_lam10', 'C1c_lam100',
  'C1_logRidgeFixed', 'C2_logRidgeCV', 'E1_blend', 'E2_geomTreeLin',
  'V1_hinge30', 'V2_hotStorm', 'V3_both', 'V4_bothWknd', 'V5_both_hl28'];

function runTable(warmup) {
  console.log(`\n══ Walk-forward | N=${rows.length} | warmup=${warmup} | test=${rows.length - warmup} dní ══`);
  console.log(['model', 'MAE€', 'MdAE€', 'RMSE€', 'WAPE%', 'wapeN%', 'RMSLE', 'bias€'].map((h, i) => i ? h.padStart(8) : h.padEnd(18)).join(''));
  const res = [];
  for (const name of order) {
    const m = metrics(walkForward(name, warmup)); res.push({ name, ...m });
    console.log([name.padEnd(18), m.mae.toFixed(0).padStart(8), m.mdae.toFixed(0).padStart(8), m.rmse.toFixed(0).padStart(8),
      m.wape.toFixed(1).padStart(8), (m.wapeNorm == null ? '-' : m.wapeNorm.toFixed(1)).padStart(8), m.rmsle.toFixed(3).padStart(8), m.bias.toFixed(0).padStart(8)].join(''));
  }
  res.sort((a, b) => a.wape - b.wape);
  console.log(`🏆 ${res[0].name} (WAPE ${res[0].wape.toFixed(1)}%, RMSLE ${res[0].rmsle.toFixed(3)})`);
  console.log(`   poradie WAPE: ${res.map((r) => `${r.name.replace(/_.*/, '')}(${r.wape.toFixed(1)})`).join(' < ')}`);
  return res;
}

console.log('(WAPE=Σ|e|/Σtržba; wapeN=len ≥200€; RMSLE=chyba v log; bias>0=nadhodnocuje; MAPE zámerne NEpoužité — exploduje na 0.1€ dňoch)');
const r14 = runTable(14);
runTable(21);

// ---- diagnostika víťaza ----
const champ = r14[0].name;
console.log(`\n── Diagnostika: ${champ} (warmup 14) ──`);
const preds = walkForward(champ, 14);
const groups = { 'washout (<60€)': (p) => p.actual < 60, 'normál 60–800€': (p) => p.actual >= 60 && p.actual < 800, 'veľký deň ≥800€': (p) => p.actual >= 800 };
for (const [label, fn] of Object.entries(groups)) {
  const g = preds.filter(fn); if (!g.length) continue;
  const mae = g.reduce((s, p) => s + Math.abs(p.est - p.actual), 0) / g.length;
  const bias = g.reduce((s, p) => s + (p.est - p.actual), 0) / g.length;
  console.log(`  ${label.padEnd(18)} n=${String(g.length).padStart(2)}  MAE=${mae.toFixed(0).padStart(4)}€  bias=${bias.toFixed(0).padStart(5)}€`);
}
const worst = [...preds].sort((a, b) => Math.abs(b.est - b.actual) - Math.abs(a.est - a.actual)).slice(0, 5);
console.log('  najhoršie odhady:');
for (const p of worst) console.log(`    ${p.day} wd${p.weekday} code${p.worstCode}  actual=${p.actual.toFixed(0)}€  est=${p.est.toFixed(0)}€  (Δ${(p.est - p.actual).toFixed(0)}€)`);

// ---- pásma z OUT-OF-FOLD log-rezíduí (split-conformal), pokrytie & šírka ----
console.log(`\n── Kalibrácia pásma (OOF log-rezíduá, cieľ 80%): ${champ} ──`);
// C1d = ENG0 (bez AR) — pásma merať na TOM ISTOM engine ako nasadený model.
for (const [ql0, qh0, label] of [[0.10, 0.90, 'q10/90 (deployed)'], [0.05, 0.95, 'q05/95'], [0.05, 0.97, 'q05/97']]) {
  const resid = []; let covered = 0, width = 0, m = 0;
  for (let t = 14; t < rows.length; t++) {
    const tr = Array.from({ length: t }, (_, i) => i);
    const st = ENG0.fit(tr, 30, 21);
    const mu = ENG0.muOf(st, t); if (mu == null) continue;
    let lo, hi;
    if (resid.length >= 10) { const q = [...resid].sort((a, b) => a - b); const ql = q[Math.floor(ql0 * q.length)]; const qh = q[Math.min(q.length - 1, Math.floor(qh0 * q.length))]; lo = Math.max(0, Math.exp(mu + ql) * st.smear - 1); hi = Math.exp(mu + qh) * st.smear - 1; }
    else { const sd = resid.length ? Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / resid.length) : 0.6; lo = Math.max(0, Math.exp(mu - 1.64 * sd) * st.smear - 1); hi = Math.exp(mu + 1.64 * sd) * st.smear - 1; }
    const a = rows[t].rev; if (a >= lo && a <= hi) covered++; width += (hi - lo); m++;
    resid.push(log1p(a) - mu); // OOF: pridaj až PO predikcii
  }
  console.log(`  ${label}: pokrytie=${(100 * covered / m).toFixed(0)}%  priem. šírka=${(width / m).toFixed(0)}€  (n=${m})`);
}

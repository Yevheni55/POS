// Ridge (L2-regularizovaná) lineárna regresia v čistom JS.
// w = (XᵀX + λI)⁻¹ Xᵀy, intercept (stĺpec 0) sa NEregularizuje.
// Použité na denný forecast tržieb — málo vzoriek, veľa feature → λ je nutná
// proti overfittingu. Riešené Gaussovou elimináciou s parciálnym pivotom
// (rozmery sú malé: desiatky až nižšie stovky feature).

// Vyrieš A·x = b (A je d×d, b je d). Vracia x, alebo null pri singularite.
function solveLinear(A, b) {
  const d = b.length;
  // augmentovaná matica
  const M = A.map((row, i) => row.slice().concat(b[i]));
  for (let col = 0; col < d; col++) {
    // parciálny pivot
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null; // singulárne
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const pivVal = M[col][col];
    for (let j = col; j <= d; j++) M[col][j] /= pivVal;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= d; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[d]);
}

/**
 * Fit ridge. X: n×d (vrátane intercept stĺpca = 1 na indexe 0), y: n, lambda skalár.
 * Vracia w (d) alebo null.
 */
export function fitRidge(X, y, lambda) {
  const n = X.length;
  if (!n) return null;
  const d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i], yi = y[i];
    for (let j = 0; j < d; j++) {
      b[j] += xi[j] * yi;
      const aj = A[j];
      for (let k = 0; k < d; k++) aj[k] += xi[j] * xi[k];
    }
  }
  for (let j = 1; j < d; j++) A[j][j] += lambda; // skip intercept
  return solveLinear(A, b);
}

export function predictOne(w, x) {
  let s = 0;
  for (let j = 0; j < x.length; j++) s += w[j] * x[j];
  return s;
}

// Štandardizér: z-score per stĺpec (okrem intercept + binárnych one-hotov,
// ktoré necháme tak — ridge na 0/1 funguje fajn). Vracia {mean,std,apply}.
export function buildStandardizer(rows, skipMask) {
  const d = rows[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(1);
  const n = rows.length;
  for (let j = 0; j < d; j++) {
    if (skipMask[j]) continue;
    let m = 0;
    for (let i = 0; i < n; i++) m += rows[i][j];
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) { const dd = rows[i][j] - m; v += dd * dd; }
    v = Math.sqrt(v / Math.max(1, n - 1)) || 1;
    mean[j] = m; std[j] = v;
  }
  return {
    mean, std,
    apply(x) {
      const out = x.slice();
      for (let j = 0; j < d; j++) if (!skipMask[j]) out[j] = (x[j] - mean[j]) / std[j];
      return out;
    },
  };
}

// Jednoduchý leave-out-last K hold-out na výber lambda z mriežky.
export function pickLambda(X, y, lambdas, holdout) {
  const n = X.length;
  const k = Math.min(holdout, Math.floor(n / 4));
  if (k < 2) return lambdas[Math.floor(lambdas.length / 2)];
  const trainX = X.slice(0, n - k), trainY = y.slice(0, n - k);
  const valX = X.slice(n - k), valY = y.slice(n - k);
  let best = lambdas[0], bestErr = Infinity;
  for (const lam of lambdas) {
    const w = fitRidge(trainX, trainY, lam);
    if (!w) continue;
    let err = 0;
    for (let i = 0; i < valX.length; i++) { const e = predictOne(w, valX[i]) - valY[i]; err += e * e; }
    err /= valX.length;
    if (err < bestErr) { bestErr = err; best = lam; }
  }
  return best;
}

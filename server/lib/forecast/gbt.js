// Gradient Boosted Regression Trees (squared error) v čistom JS.
// Plytké CART stromy + boosting na reziduály so shrinkage. Silne
// regularizované (malá hĺbka, min vzoriek na list, nízky shrinkage), lebo
// dát je málo — bez toho by overfitlo. Použité na HODINOVÝ model tržieb
// (~640 vzoriek: dni × otvorené hodiny), kde GBT zachytí nelineárne
// interakcie (hodina × teplota × deň) lepšie než lineárny ridge.

function meanOf(idx, y) { let s = 0; for (const i of idx) s += y[i]; return idx.length ? s / idx.length : 0; }

// Najlepší split (feature, threshold) minimalizujúci SSE. Vracia null ak list.
function bestSplit(idx, X, y, minLeaf) {
  const d = X[0].length;
  let best = null;
  const parentMean = meanOf(idx, y);
  let parentSSE = 0;
  for (const i of idx) { const e = y[i] - parentMean; parentSSE += e * e; }
  for (let f = 0; f < d; f++) {
    // kandidátne prahy = unikátne hodnoty (zoradené)
    const vals = idx.map((i) => X[i][f]).sort((a, b) => a - b);
    let prev = null;
    for (let t = 0; t < vals.length; t++) {
      const v = vals[t];
      if (v === prev) continue; prev = v;
      const thr = v;
      let ln = 0, ls = 0, rn = 0, rs = 0;
      for (const i of idx) {
        if (X[i][f] <= thr) { ln++; ls += y[i]; } else { rn++; rs += y[i]; }
      }
      if (ln < minLeaf || rn < minLeaf) continue;
      const lm = ls / ln, rm = rs / rn;
      let sse = 0;
      for (const i of idx) { const m = X[i][f] <= thr ? lm : rm; const e = y[i] - m; sse += e * e; }
      const gain = parentSSE - sse;
      if (gain > 1e-9 && (!best || sse < best.sse)) best = { f, thr, sse, lm, rm };
    }
  }
  return best;
}

function buildTree(idx, X, y, depth, maxDepth, minLeaf) {
  if (depth >= maxDepth || idx.length < 2 * minLeaf) return { leaf: meanOf(idx, y) };
  const s = bestSplit(idx, X, y, minLeaf);
  if (!s) return { leaf: meanOf(idx, y) };
  const li = [], ri = [];
  for (const i of idx) (X[i][s.f] <= s.thr ? li : ri).push(i);
  return {
    f: s.f, thr: s.thr,
    left: buildTree(li, X, y, depth + 1, maxDepth, minLeaf),
    right: buildTree(ri, X, y, depth + 1, maxDepth, minLeaf),
  };
}

function predictTree(node, x) {
  while (node.leaf === undefined) node = x[node.f] <= node.thr ? node.left : node.right;
  return node.leaf;
}

/**
 * Fit GBT. X: n×d, y: n. opts: {trees, maxDepth, minLeaf, shrinkage}.
 * Vracia { base, trees, shrinkage }.
 */
export function fitGBT(X, y, opts) {
  const o = Object.assign({ trees: 120, maxDepth: 3, minLeaf: 12, shrinkage: 0.06 }, opts || {});
  const n = X.length;
  const base = y.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const F = new Array(n).fill(base);
  const trees = [];
  const allIdx = Array.from({ length: n }, (_, i) => i);
  for (let m = 0; m < o.trees; m++) {
    const resid = new Array(n);
    for (let i = 0; i < n; i++) resid[i] = y[i] - F[i];
    const tree = buildTree(allIdx, X, resid, 0, o.maxDepth, o.minLeaf);
    for (let i = 0; i < n; i++) F[i] += o.shrinkage * predictTree(tree, X[i]);
    trees.push(tree);
  }
  return { base, trees, shrinkage: o.shrinkage };
}

export function predictGBT(model, x) {
  let s = model.base;
  for (const t of model.trees) s += model.shrinkage * predictTree(t, x);
  return s;
}

// In-sample R² + reziduálne σ (na pásma).
export function gbtStats(model, X, y) {
  const n = X.length;
  const mean = y.reduce((s, v) => s + v, 0) / Math.max(1, n);
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const e = predictGBT(model, X[i]) - y[i]; sse += e * e;
    const d = y[i] - mean; sst += d * d;
  }
  return { r2: sst > 0 ? Math.max(0, 1 - sse / sst) : 0, resid: Math.sqrt(sse / Math.max(1, n - 1)) };
}

// Shared money formatters — per DESIGN-CODE.md §11.1 sub-cent guidance.
//
// Loaded two ways:
//   1. ES module import (admin/pages/*.js):  `import { fmtCost } from '...'`
//   2. <script src> tag (POS frontend): falls through to window.fmtCost
//
// fmtCost — adaptive precision per magnitude. .toFixed(2) on a sub-cent
// price like flour at 0.00075 €/g rounds to "0,00 €", which made the
// operator think the item was free. Scaling fraction digits keeps small
// values readable while still giving 2 decimals at the normal range.
//   ≥ 1.00 €      → 2 decimals       (12,34)
//   ≥ 0.01 €      → 2..4 decimals    (0,0245)
//   < 0.01 €      → 4..5 decimals    (0,00075)
//
// fmtNum — plain 2-decimal sk-SK locale (uses comma separator).

export function fmtCost(n) {
  const x = Number(n);
  if (!isFinite(x) || x === 0) return '0,00';
  const abs = Math.abs(x);
  if (abs >= 1)    return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 0.01) return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return x.toLocaleString('sk-SK', { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}

export function fmtNum(n) {
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

if (typeof window !== 'undefined') {
  window.fmtCost = fmtCost;
  window.fmtNum = fmtNum;
}

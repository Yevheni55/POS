// Shared constants and pure utilities for the payments handlers in
// server/lib/payments/. Extracted from the original monolithic
// server/routes/payments.js. The route file re-exports STORNO_ELIGIBLE_MODES
// to preserve the existing import from server/routes/fiscal-documents.js.

export const STORNO_ELIGIBLE_MODES = new Set([
  'online_success',
  'offline_accepted',
  'reconciled_online_success',
  'reconciled_offline_accepted',
]);

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Realized euro discount for a SINGLE order line, derived live from the
 * current menu price (order_items has no price snapshot — see schema). The
 * line stores only the rule (type + value); the amount is computed here so it
 * auto-scales when qty changes and never goes stale.
 *
 * @param {number} unitPrice - current menu unit price
 * @param {number} qty       - line quantity
 * @param {string} type      - 'percent' | 'fixed'
 * @param {number} value     - percent (0..100) or fixed euros off the line
 * @returns {number} euro amount off this line, rounded, clamped to [0, lineGross]
 */
export function lineDiscountAmount(unitPrice, qty, type, value) {
  const price = Number(unitPrice);
  const quantity = Number(qty);
  const val = Number(value);
  if (!Number.isFinite(price) || !Number.isFinite(quantity) || !Number.isFinite(val) || val <= 0) {
    return 0;
  }
  const lineGross = roundMoney(price * quantity);
  if (lineGross <= 0) return 0;
  const raw = type === 'fixed' ? val : (lineGross * val) / 100;
  // Clamp: never exceed the line total, never negative.
  return roundMoney(Math.min(Math.max(raw, 0), lineGross));
}

export function toDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseJsonField(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP status pre fiškálne ZLYHANIE (`{ error, fiscal }`, bez platby).
 *
 * Portos httpStatus preberáme len ak je sám chybový (4xx/5xx). Pri
 * `mismatch_rejected` totiž Portos vrátil 200/202 (doklad "prešiel"), ale MY
 * ho odmietame — vrátiť 200 s `error` telom znamená, že klient odpoveď
 * klasifikuje ako úspech a čašníkovi ukáže „Platba uspesna", hoci žiadny
 * payment riadok nevznikol a účet ostal otvorený.
 */
export function fiscalFailureHttpStatus(outcome, fallback = 400) {
  const raw = Number(outcome?.httpStatus);
  if (Number.isInteger(raw) && raw >= 400 && raw <= 599) return raw;
  return fallback;
}

/**
 * HTTP status pre fiškálny ÚSPECH (`{ ok: true, fiscal }`).
 *
 * Zrkadlový prípad k `fiscalFailureHttpStatus`: pri `reconciled_*` outcome
 * ostáva v `httpStatus` PÔVODNÝ chybový kód z prvého pokusu (napr. 500 pri
 * `-502 print failed`), hoci doklad sa medzitým dohľadal cez externalId a
 * reconciliácia PREŠLA. Vrátiť 500 s úspešným telom znamená, že čašník vidí
 * „storno zlyhalo", opakuje ho a narazí na dedup 409 — presne incident
 * popísaný v komentári vo fiscal-storno.js. Preberáme teda len 2xx.
 */
export function fiscalSuccessHttpStatus(outcome, fallback = 200) {
  const raw = Number(outcome?.httpStatus);
  if (Number.isInteger(raw) && raw >= 200 && raw <= 299) return raw;
  return fallback;
}

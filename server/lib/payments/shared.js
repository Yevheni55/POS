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

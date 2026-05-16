// Shared constants and helpers used across the report handlers in
// server/lib/reports/. Extracted from the original monolithic reports.js
// route so each handler can sit in its own file.

export const TZ = 'Europe/Bratislava';

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * One-shot test fiscal receipt via Portos (POST cash_register).
 * For test / pilot cash registers only — creates a real eKāsa-bound request.
 *
 * Usage: cd server && node scripts/portos-fiscal-test-receipt.mjs
 * Env: DATABASE_URL not required; uses server/.env for PORTOS_* (Docker: host.docker.internal via compose).
 */
import 'dotenv/config';

import { buildCashRegisterRequestContext } from '../lib/fiscal-payment.js';
import { registerCashReceipt } from '../lib/portos.js';

const orderId = Date.now();
const items = [
  {
    name: 'Portos VAT 19 Test',
    qty: 1,
    price: 1,
    vatRate: 19,
  },
];

const requestPayload = buildCashRegisterRequestContext({
  orderId,
  items,
  discountAmount: 0,
  method: 'hotovost',
  expectedTotal: 1,
});

console.log(
  JSON.stringify(
    {
      step: 'request',
      externalId: requestPayload.request.externalId,
      cashRegisterCode: requestPayload.request.data.cashRegisterCode,
      itemCount: requestPayload.request.data.items.length,
      print: requestPayload.print,
    },
    null,
    2,
  ),
);

const outcome = await registerCashReceipt(requestPayload);

console.log(JSON.stringify({ step: 'result', ...outcome }, null, 2));

if (outcome.resultMode !== 'online_success' && outcome.resultMode !== 'offline_accepted') {
  process.exit(1);
}

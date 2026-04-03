import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateDiscountAcrossVatGroups,
  buildCashRegisterRequestContext,
  buildFiscalReceiptItems,
  buildPaymentExternalId,
} from '../../lib/fiscal-payment.js';

describe('fiscal-payment helpers', () => {
  it('allocates discount across mixed VAT groups without losing cents', () => {
    const items = [
      { name: 'Burger', qty: 1, price: 8.5, vatRate: 10 },
      { name: 'Pivo', qty: 2, price: 2.5, vatRate: 20 },
    ];

    const discountLines = allocateDiscountAcrossVatGroups(items, 1.35);
    assert.equal(discountLines.length, 2);

    const totalDiscount = discountLines.reduce((sum, line) => sum + Math.abs(line.price), 0);
    assert.equal(Number(totalDiscount.toFixed(2)), 1.35);

    const discount10 = discountLines.find((line) => line.vatRate === 10);
    const discount20 = discountLines.find((line) => line.vatRate === 20);
    assert.equal(Number(Math.abs(discount10.price).toFixed(2)), 0.85);
    assert.equal(Number(Math.abs(discount20.price).toFixed(2)), 0.50);
  });

  it('builds fiscal receipt items with positive and discount lines', () => {
    const items = buildFiscalReceiptItems([
      { name: 'Burger', qty: 1, price: 8.5, vatRate: 10 },
      { name: 'Pivo', qty: 2, price: 2.5, vatRate: 20 },
    ], 1.35);

    assert.equal(items.length, 4);
    assert.equal(items[0].type, 'Positive');
    assert.equal(items[1].type, 'Positive');
    assert.equal(items[2].type, 'Discount');
    assert.equal(items[3].type, 'Discount');
  });

  it('builds a deterministic Portos cash receipt request context', () => {
    process.env.PORTOS_CASH_REGISTER_CODE = '88812345678900001';
    process.env.PORTOS_PRINTER_NAME = 'pos';

    const context = buildCashRegisterRequestContext({
      orderId: 42,
      items: [
        { name: 'Burger', qty: 1, price: 8.5, vatRate: 10 },
      ],
      discountAmount: 0,
      method: 'hotovost',
      expectedTotal: 8.5,
    });

    assert.equal(buildPaymentExternalId(42), 'order-42-payment');
    assert.equal(context.request.externalId, 'order-42-payment');
    assert.equal(context.request.data.cashRegisterCode, '88812345678900001');
    assert.equal(context.print.printerName, 'pos');
    assert.equal(context.request.data.payments[0].name, 'Hotovosť');
    assert.equal(context.request.data.payments[0].amount, 8.5);
  });
});

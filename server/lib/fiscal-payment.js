import { getPortosConfig } from './portos.js';

export const PAYMENT_METHOD_LABELS = {
  hotovost: 'Hotovos\u0165',
  karta: 'Karta',
};

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeVatRate(value) {
  return roundMoney(Number(value || 0));
}

export function buildPaymentExternalId(orderId) {
  return `order-${orderId}-payment`;
}

export function allocateDiscountAcrossVatGroups(items, discountAmount) {
  const normalizedDiscount = roundMoney(discountAmount || 0);
  if (normalizedDiscount <= 0) return [];

  const groups = new Map();
  for (const item of items) {
    const vatRate = normalizeVatRate(item.vatRate);
    const current = groups.get(vatRate) || { vatRate, subtotal: 0 };
    current.subtotal = roundMoney(current.subtotal + roundMoney(item.price * item.qty));
    groups.set(vatRate, current);
  }

  const entries = Array.from(groups.values()).filter((entry) => entry.subtotal > 0);
  if (!entries.length) return [];

  const total = roundMoney(entries.reduce((sum, entry) => sum + entry.subtotal, 0));
  const allocations = entries.map((entry) => ({
    vatRate: entry.vatRate,
    subtotal: entry.subtotal,
    amount: roundMoney((normalizedDiscount * entry.subtotal) / total),
  }));

  const allocated = roundMoney(allocations.reduce((sum, entry) => sum + entry.amount, 0));
  const remainder = roundMoney(normalizedDiscount - allocated);

  if (remainder !== 0) {
    allocations.sort((left, right) => right.subtotal - left.subtotal);
    allocations[0].amount = roundMoney(allocations[0].amount + remainder);
  }

  return allocations
    .filter((allocation) => allocation.amount > 0)
    .map((allocation) => ({
      type: 'Discount',
      name: 'Z\u013Eava',
      price: -allocation.amount,
      unitPrice: -allocation.amount,
      quantity: {
        amount: 1,
        unit: 'ks',
      },
      referenceReceiptId: null,
      vatRate: allocation.vatRate,
      description: null,
    }));
}

export function buildFiscalReceiptItems(items, discountAmount = 0) {
  const receiptItems = items.map((item) => ({
    type: 'Positive',
    name: item.name,
    price: roundMoney(item.price * item.qty),
    unitPrice: roundMoney(item.price),
    quantity: {
      amount: item.qty,
      unit: 'ks',
    },
    referenceReceiptId: null,
    vatRate: normalizeVatRate(item.vatRate),
    description: null,
  }));

  return receiptItems.concat(allocateDiscountAcrossVatGroups(items, discountAmount));
}

export function buildCashRegisterRequestContext({ orderId, items, discountAmount, method, expectedTotal }) {
  const config = getPortosConfig();

  return {
    request: {
      data: {
        items: buildFiscalReceiptItems(items, discountAmount),
        payments: [{
          name: PAYMENT_METHOD_LABELS[method] || method,
          amount: roundMoney(expectedTotal),
        }],
        roundingAmount: 0,
        receiptType: 'CashRegister',
        headerText: null,
        footerText: null,
        cashRegisterCode: config.cashRegisterCode,
      },
      externalId: buildPaymentExternalId(orderId),
    },
    print: {
      printerName: config.printerName,
    },
  };
}

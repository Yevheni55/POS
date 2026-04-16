import { getPortosConfig } from './portos.js';

export const PAYMENT_METHOD_LABELS = {
  hotovost: 'Hotovos\u0165',
  karta: 'Karta',
};

/** CHDU / staršie fiškálne tlačiarne často nezvládnu UTF-8 ani emoji — výsledok sú náhodné symboly. */
const FOLD_EXTRA = {
  ľ: 'l',
  Ľ: 'L',
  ł: 'l',
  Ł: 'L',
  ŕ: 'r',
  Ŕ: 'R',
  ô: 'o',
  Ô: 'O',
  ď: 'd',
  Ď: 'D',
  ť: 't',
  Ť: 'T',
  ň: 'n',
  Ň: 'N',
};

export function sanitizeForFiscalPrinter(text) {
  if (text == null || text === '') return 'Polozka';
  let s = String(text).normalize('NFKC');
  s = s.replace(/\p{Extended_Pictographic}/gu, '');
  s = s.replace(/[\uFE0F\u200D]/g, '');
  s = s.normalize('NFD').replace(/\p{M}/gu, '');
  for (const [from, to] of Object.entries(FOLD_EXTRA)) {
    s = s.split(from).join(to);
  }
  s = s.replace(/[^\x20-\x7E]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  const out = s.slice(0, 120);
  return out.length ? out : 'Polozka';
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeVatRate(value) {
  return roundMoney(Number(value || 0));
}

export function buildPaymentExternalId(orderId) {
  return `order-${orderId}-payment`;
}

/** Jednoznačné externalId pre storno doklad k danej objednávke (eKasa / Portos). */
export function buildPaymentStornoExternalId(orderId) {
  return `order-${orderId}-payment-storno`;
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
      name: sanitizeForFiscalPrinter('Z\u013Eava'),
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
    name: sanitizeForFiscalPrinter(item.name),
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

export function buildCashRegisterRequestContext({
  orderId,
  items,
  discountAmount,
  method,
  expectedTotal,
  cashRegisterCode,
}) {
  const config = getPortosConfig();
  const effectiveCashRegisterCode = String(cashRegisterCode || config.cashRegisterCode || '').trim();

  return {
    request: {
      data: {
        items: buildFiscalReceiptItems(items, discountAmount),
        payments: [{
          name: sanitizeForFiscalPrinter(PAYMENT_METHOD_LABELS[method] || method),
          amount: roundMoney(expectedTotal),
        }],
        roundingAmount: 0,
        receiptType: 'CashRegister',
        headerText: null,
        footerText: null,
        cashRegisterCode: effectiveCashRegisterCode,
      },
      externalId: buildPaymentExternalId(orderId),
    },
    print: {
      printerName: config.printerName,
    },
  };
}

/**
 * Storno už vytlačeného / zaevidovaného pokladničného dokladu (omyl obsluhy).
 * Podľa NineDigit: nový doklad s položkami typu correction, záporné ceny, referenceReceiptId = id alebo OKP pôvodu.
 * @param {object} params
 * @param {object} params.originalRequestPayload — uložený kontext z pôvodnej platby (request + print)
 * @param {string} params.referenceReceiptId — response.data.id z eKasy alebo OKP pri offline
 * @param {number} params.orderId
 */
export function buildStornoCashRegisterRequestContext({
  originalRequestPayload,
  referenceReceiptId,
  orderId,
  cashRegisterCode,
}) {
  const config = getPortosConfig();
  const payload = typeof originalRequestPayload === 'string'
    ? JSON.parse(originalRequestPayload)
    : originalRequestPayload;

  const data = payload?.request?.data;
  if (!data || !Array.isArray(data.items) || !data.items.length) {
    throw new Error('Chýbajú položky pôvodného fiškálneho requestu');
  }

  const ref = String(referenceReceiptId || '').trim();
  if (!ref) {
    throw new Error('Chýba referencia na pôvodný doklad (číslo dokladu eKasa alebo OKP)');
  }

  const correctionItems = data.items.map((item) => {
    const t = String(item.type || '').toLowerCase();
    if (t !== 'positive' && t !== 'discount') {
      throw new Error(`Nepodporovaný typ položky pre STORNO: ${item.type}`);
    }
    const qty = item.quantity || {};
    return {
      type: 'correction',
      referenceReceiptId: ref,
      name: item.name,
      quantity: {
        amount: Number(qty.amount),
        unit: qty.unit || 'ks',
      },
      unitPrice: roundMoney(-Number(item.unitPrice)),
      price: roundMoney(-Number(item.price)),
      vatRate: item.vatRate,
      description: item.description ?? null,
    };
  });

  const payments = (data.payments || []).map((p) => ({
    name: p.name,
    amount: roundMoney(-Number(p.amount)),
  }));

  if (!payments.length) {
    throw new Error('Chýbajú platby v pôvodnom doklade');
  }

  return {
    request: {
      data: {
        items: correctionItems,
        payments,
        roundingAmount: data.roundingAmount ?? 0,
        receiptType: data.receiptType || 'CashRegister',
        headerText: data.headerText ?? null,
        footerText: data.footerText ?? null,
        cashRegisterCode: String(
          data.cashRegisterCode || cashRegisterCode || config.cashRegisterCode || '',
        ).trim(),
      },
      externalId: buildPaymentStornoExternalId(orderId),
    },
    print: {
      printerName: payload.print?.printerName || config.printerName,
    },
  };
}

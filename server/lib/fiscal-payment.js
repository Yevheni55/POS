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

/**
 * Jednoznačné externalId pre platbu objednávky (eKasa / Portos).
 *
 * Bez `salt` vracia legacy formát `order-N-payment` — používaný pri lookup-och
 * starých fiscal_documents (pred zavedením salt-u). Pre NOVÉ fiškálne requesty
 * sa volá s `{ salt }` aby externalId bolo globálne unikátne aj po DB reset-e
 * (orderId sequence resetne, ale salt sa derivuje z payment.createdAt → ms
 * čas → unique cez celú históriu Portos účtu).
 *
 * Bug, ktorý to fixuje: po vývojovom DB-truncate sa orderId 53 znova vyrobil,
 * Portos si pamätal starý doklad pre `order-53-payment` → reconcile vrátil
 * cudzí (Espresso) blok namiesto reálneho (2× Kofola).
 */
export function buildPaymentExternalId(orderId, opts) {
  const salt = opts && opts.salt;
  return salt ? `order-${orderId}-pay-${salt}` : `order-${orderId}-payment`;
}

/** Jednoznačné externalId pre storno doklad k danej objednávke (eKasa / Portos). */
export function buildPaymentStornoExternalId(orderId, opts) {
  const salt = opts && opts.salt;
  return salt ? `order-${orderId}-pay-${salt}-storno` : `order-${orderId}-payment-storno`;
}

/**
 * Vytiahne salt z externalId vyrobeného `buildPaymentExternalId(..., {salt})`.
 * Vracia null pre legacy formát `order-N-payment` alebo nerozpoznateľný vstup.
 * Používa sa pri lookup-e súvisiacich storno externalId-ov tak, aby zostal
 * konzistentný so soltom použitým pri pôvodnej platbe.
 */
export function parsePaymentExternalIdSalt(externalId) {
  if (!externalId) return null;
  const m = String(externalId).match(/^order-\d+-pay-([A-Za-z0-9-]+?)(?:-storno)?$/);
  return m ? m[1] : null;
}

/** Vyrobí čerstvý salt pre nové fiškálne externalId (čas v base36 + 4 hex znaky). */
export function generatePaymentExternalIdSalt() {
  return Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
}

/**
 * Defense-in-depth: validuje, či doklad vrátený z Portos (cez findReceiptByExternalId)
 * skutočne zodpovedá tomu, čo POS poslal v requestPayload. Bráni tomu, aby Portos
 * cache (alebo iný cudzí dôvod) reconciliovalo cudzí blok namiesto reálnej platby.
 *
 * Slovenská finančná správa udeľuje vysoké pokuty za nevydaný/nekorektný blok,
 * preto pri akejkoľvek nezhode RADŠEJ neuložíme cudzie údaje a označíme
 * outcome ako `mismatch_rejected` — cashier musí ručne overiť/opakovať.
 *
 * Kritériá (všetky musia sedieť):
 *   1. cashRegisterCode (ak sú prítomné na oboch stranách) — rovnaké
 *   2. celková suma (totalAmount alebo súčet payments[].amount) — do €0.01
 *   3. počet a názvy položiek — case-insensitive porovnanie každej položky
 *
 * Vracia { ok: true } alebo { ok: false, reason, remote, local }.
 */
export function validateReceiptMatchesRequest(receipt, requestPayload) {
  if (!receipt || !receipt.raw) return { ok: true, reason: 'no-remote-data' };
  const remote = receipt.raw.request && receipt.raw.request.data;
  const local = requestPayload && requestPayload.request && requestPayload.request.data;
  if (!remote || !local) return { ok: true, reason: 'missing-data-side' };

  // 1. cashRegisterCode
  const remoteCRC = String(remote.cashRegisterCode || '').trim();
  const localCRC = String(local.cashRegisterCode || '').trim();
  if (remoteCRC && localCRC && remoteCRC !== localCRC) {
    return { ok: false, reason: 'cashRegisterCode mismatch', remote: remoteCRC, local: localCRC };
  }

  // 2. amount
  function readTotal(d) {
    if (d.vatRatesTaxSummary && d.vatRatesTaxSummary.totalAmount != null) return Number(d.vatRatesTaxSummary.totalAmount);
    if (Array.isArray(d.payments) && d.payments.length) return d.payments.reduce((s, p) => s + Math.abs(Number(p.amount || 0)), 0);
    if (d.amount != null) return Math.abs(Number(d.amount));
    return null;
  }
  const remoteTotal = readTotal(remote);
  const localTotal = readTotal(local);
  if (remoteTotal != null && localTotal != null && Math.abs(remoteTotal - localTotal) > 0.011) {
    return { ok: false, reason: 'amount mismatch', remote: remoteTotal, local: localTotal };
  }

  // 3. items — count + name match (best-effort, ignore correction/discount-only diffs)
  const remoteItems = Array.isArray(remote.items) ? remote.items : [];
  const localItems = Array.isArray(local.items) ? local.items : [];
  const remotePositive = remoteItems.filter((i) => String(i.type || '').toLowerCase() !== 'discount');
  const localPositive = localItems.filter((i) => String(i.type || '').toLowerCase() !== 'discount');
  if (remotePositive.length !== localPositive.length) {
    return {
      ok: false,
      reason: 'item-count mismatch',
      remote: remotePositive.length,
      local: localPositive.length,
      remoteItems: remotePositive.map((i) => i.name),
      localItems: localPositive.map((i) => i.name),
    };
  }
  for (let i = 0; i < remotePositive.length; i++) {
    const rn = String(remotePositive[i].name || '').trim().toLowerCase();
    const ln = String(localPositive[i].name || '').trim().toLowerCase();
    if (rn !== ln) {
      return { ok: false, reason: 'item-name mismatch', index: i, remote: rn, local: ln };
    }
  }

  return { ok: true };
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

export function buildFiscalReceiptItems(items, discountAmount = 0, { forceZeroVat = false } = {}) {
  const normalizedItems = forceZeroVat
    ? items.map((item) => ({ ...item, vatRate: 0 }))
    : items;

  const receiptItems = normalizedItems.map((item) => ({
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

  return receiptItems.concat(allocateDiscountAcrossVatGroups(normalizedItems, discountAmount));
}

export function buildCashRegisterRequestContext({
  orderId,
  items,
  discountAmount,
  method,
  expectedTotal,
  cashRegisterCode,
  forceZeroVat = false,
  externalIdSalt,
}) {
  const config = getPortosConfig();
  const effectiveCashRegisterCode = String(cashRegisterCode || config.cashRegisterCode || '').trim();

  return {
    request: {
      data: {
        items: buildFiscalReceiptItems(items, discountAmount, { forceZeroVat }),
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
      externalId: buildPaymentExternalId(orderId, { salt: externalIdSalt }),
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
  externalIdSalt,
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
      externalId: buildPaymentStornoExternalId(orderId, { salt: externalIdSalt }),
    },
    print: {
      printerName: payload.print?.printerName || config.printerName,
    },
  };
}

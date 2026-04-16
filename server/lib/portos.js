const DEFAULT_BASE_URL = 'http://localhost:3010';
const DEFAULT_CASH_REGISTER_CODE = '88812345678900001';
/** Nie názov tlačiarne vo Windows — NineDigit API: `pos` = papier/CHDU, `pdf`, `email`. */
const DEFAULT_PRINTER_NAME = 'pos';
const DEFAULT_TIMEOUT_MS = 10_000;

const RECEIPT_OUTPUT_CHANNELS = new Set(['pos', 'pdf', 'email']);
const REGISTER_SUCCESS_STATUSES = new Set([200, 201]);
const LOOKUP_SUCCESS_STATUSES = new Set([200, 201]);
const PRINT_COPY_SUCCESS_STATUSES = new Set([200, 201]);

function normalizeReceiptOutputChannel(raw) {
  const v = String(raw ?? DEFAULT_PRINTER_NAME).trim().toLowerCase();
  if (RECEIPT_OUTPUT_CHANNELS.has(v)) return v;
  const original = String(raw ?? '').trim();
  if (original) {
    console.warn(
      `[Portos] PORTOS_PRINTER_NAME="${original}" must be "pos" (paper/CHDU), "pdf", or "email" — not a Windows printer name. Using "pos".`,
    );
  }
  return 'pos';
}

function isTruthy(value) {
  const s = String(value ?? '')
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/^["']|["']$/g, '');
  return /^(1|true|yes|on)$/i.test(s);
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getPortosConfig() {
  return {
    enabled: isTruthy(process.env.PORTOS_ENABLED),
    baseUrl: process.env.PORTOS_BASE_URL || DEFAULT_BASE_URL,
    cashRegisterCode: process.env.PORTOS_CASH_REGISTER_CODE || DEFAULT_CASH_REGISTER_CODE,
    printerName: normalizeReceiptOutputChannel(process.env.PORTOS_PRINTER_NAME || DEFAULT_PRINTER_NAME),
    timeoutMs: toInt(process.env.PORTOS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export function isPortosEnabled() {
  return getPortosConfig().enabled;
}

export class PortosTransportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PortosTransportError';
    this.cause = cause;
  }
}

/** Undici/fetch often wraps the real errno in `cause` (ECONNREFUSED, ENOTFOUND, …). */
function explainFetchError(error) {
  if (!error || typeof error !== 'object') return '';
  const c = error.cause;
  if (c && typeof c === 'object') {
    if (c.code && c.message) return `${c.code}: ${c.message}`;
    if (c.message) return c.message;
    if (Array.isArray(c.errors)) {
      const first = c.errors.find((e) => e && (e.message || e.code));
      if (first?.message) return first.message;
      if (first?.code) return String(first.code);
    }
  }
  if (error.code && error.message) return `${error.code}: ${error.message}`;
  if (error.message && error.message !== 'fetch failed') return error.message;
  return '';
}

function portosUnreachableMessage(error, { timedOut }) {
  const { baseUrl } = getPortosConfig();
  const detail = explainFetchError(error);
  if (timedOut) {
    return detail
      ? `Portos neodpovedal v čas (${detail}). Nastavené URL: ${baseUrl}`
      : `Portos neodpovedal v čas. Nastavené URL: ${baseUrl}`;
  }
  if (detail) {
    return `Portos request failed: ${detail}. Nastavené URL: ${baseUrl}`;
  }
  return (
    `Portos request failed — server nevie kontaktovať Portos na ${baseUrl}. ` +
    'Ak POS beží v Dockeri a Portos na tom istom PC, v compose musí byť napr. ' +
    'PORTOS_BASE_URL=http://host.docker.internal:3010 (nie localhost).'
  );
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function portosRequest(method, path, { query, body, timeoutMs } = {}) {
  const { baseUrl, timeoutMs: defaultTimeoutMs } = getPortosConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeoutMs);

  try {
    const response = await fetch(buildUrl(baseUrl, path, query), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    return {
      status: response.status,
      ok: response.ok,
      data: await parseJsonSafe(response),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new PortosTransportError(portosUnreachableMessage(error, { timedOut: true }), error);
    }
    throw new PortosTransportError(portosUnreachableMessage(error, { timedOut: false }), error);
  } finally {
    clearTimeout(timer);
  }
}

function stringifyErrorDetail(payload) {
  if (!payload) return '';
  if (typeof payload.detail === 'string' && payload.detail) return payload.detail;
  if (typeof payload.title === 'string' && payload.title) return payload.title;
  if (payload.errors) return JSON.stringify(payload.errors);
  return '';
}

function hasBlockedHardwareHint(errorDetail) {
  const detail = String(errorDetail || '').toLowerCase();
  if (!detail) return false;

  return (
    /com\d+/i.test(detail) ||
    detail.includes('chdu') ||
    detail.includes('printer') ||
    detail.includes('storage') ||
    detail.includes('tlaciar') ||
    detail.includes('tla\u010diar') ||
    detail.includes('ulozisk') ||
    detail.includes('\u00falo\u017eisk')
  );
}

function isClearlyBlockedPortosFailure({ status, errorCode, errorDetail }) {
  const numericErrorCode = Number(errorCode);
  if (numericErrorCode === -503) return true;
  if (numericErrorCode === -100 && hasBlockedHardwareHint(errorDetail)) return true;
  return (status === 500 || status === 503) && hasBlockedHardwareHint(errorDetail);
}

function normalizeRegisterResult(status, data, requestPayload) {
  const requestData = data?.request?.data || {};
  const errorCode = data?.code ?? data?.error?.code ?? data?.error?.eKasaErrorCode ?? null;
  const errorDetail = stringifyErrorDetail(data);
  const blocked = isClearlyBlockedPortosFailure({ status, errorCode, errorDetail });
  // Niektoré inštancie Portos/NineDigit vracajú 201 Created namiesto 200 — inak by sme mali resultMode "error" a platbu zablokovali.
  const httpOk = REGISTER_SUCCESS_STATUSES.has(status);

  return {
    httpStatus: status,
    resultMode: httpOk
      ? 'online_success'
      : status === 202
        ? 'offline_accepted'
        : status === 400
          ? 'validation_error'
          : blocked
            ? 'blocked'
            : status === 403
              ? 'rejected'
              : 'error',
    isSuccessful: data?.isSuccessful ?? null,
    receiptId: data?.response?.data?.id || null,
    receiptNumber: requestData.receiptNumber ?? null,
    okp: requestData.okp || null,
    portosRequestId: data?.request?.id || null,
    processDate: data?.response?.processDate || requestData.createDate || data?.request?.date || null,
    errorCode,
    errorDetail,
    requestJson: JSON.stringify(requestPayload || {}),
    responseJson: JSON.stringify(data || {}),
    raw: data,
  };
}

function normalizeReceiptResult(data) {
  const requestData = data?.request?.data || {};

  return {
    externalId: data?.request?.externalId || null,
    portosRequestId: data?.request?.id || null,
    receiptId: data?.response?.data?.id || null,
    receiptNumber: requestData.receiptNumber ?? null,
    okp: requestData.okp || null,
    processDate: data?.response?.processDate || requestData.createDate || data?.request?.date || null,
    isSuccessful: data?.isSuccessful ?? null,
    requestJson: JSON.stringify(data?.request || {}),
    responseJson: JSON.stringify(data || {}),
    raw: data,
  };
}

async function safePortosRequest(method, path, options) {
  try {
    return await portosRequest(method, path, options);
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeIdentitiesList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && typeof data === 'object' && data.ico) return [data];
  return [];
}

/** Po zmene firmy/eKasa môže Portos vrátiť viac identít. Vyberieme tú, ktorej kód pokladne sa zhoduje s configom. */
function pickIdentityForCashRegister(list, configuredCashRegisterCode) {
  if (!list.length) return null;
  const normalized = String(configuredCashRegisterCode || '').trim();
  if (normalized) {
    const match = list.find((item) => {
      const a = String(item?.organizationUnit?.cashRegisterCode || '').trim();
      const b = String(item?.cashRegisterCode || '').trim();
      return a === normalized || b === normalized;
    });
    if (match) return match;
  }
  return list[0];
}

export async function getStatus() {
  const config = getPortosConfig();
  const identityResult = await safePortosRequest('GET', '/api/v1/identities');
  const identities = normalizeIdentitiesList(identityResult.data);
  const identity = pickIdentityForCashRegister(identities, config.cashRegisterCode);
  const resolvedCashRegisterCode = config.cashRegisterCode || identity?.organizationUnit?.cashRegisterCode || null;

  const [product, connectivity, storage, printer, certificate, settings] = await Promise.all([
    safePortosRequest('GET', '/api/v1/product/info'),
    safePortosRequest('GET', '/api/v1/connectivity/status'),
    safePortosRequest('GET', '/api/v1/storage/info'),
    safePortosRequest('GET', '/api/v1/printers/status'),
    safePortosRequest('GET', '/api/v1/certificates/valid/latest', {
      query: { CashRegisterCode: resolvedCashRegisterCode },
    }),
    safePortosRequest('GET', '/api/v1/settings'),
  ]);

  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    configuredCashRegisterCode: config.cashRegisterCode,
    cashRegisterCode: resolvedCashRegisterCode,
    printerName: config.printerName,
    serviceReachable: Boolean(product.ok || connectivity.ok || storage.ok || printer.ok),
    connectivity: connectivity.data,
    product: product.data,
    storage: storage.data,
    printer: printer.data,
    certificate: certificate.data,
    identity,
    identityCount: identities.length,
    identities,
    settings: settings.data,
    errors: {
      identity: identityResult.ok ? null : identityResult.error,
      product: product.ok ? null : product.error,
      connectivity: connectivity.ok ? null : connectivity.error,
      storage: storage.ok ? null : storage.error,
      printer: printer.ok ? null : printer.error,
      certificate: certificate.ok ? null : certificate.error,
      settings: settings.ok ? null : settings.error,
    },
  };
}

export async function registerCashReceipt(input) {
  const response = await portosRequest('POST', '/api/v1/requests/receipts/cash_register', {
    body: input,
  });

  return normalizeRegisterResult(response.status, response.data, input);
}

/** Kód pokladne z uloženého dokladu alebo .env — po zmene firmy v Portos musí sedieť s dokladom. */
function resolveCashRegisterCodeForReceipt(override) {
  const trimmed = String(override ?? '')
    .trim()
    .replace(/^\uFEFF/, '');
  if (trimmed) return trimmed;
  return getPortosConfig().cashRegisterCode;
}

/**
 * Portos: „certifikát s takým aliasom nebol nájdený“ — zvyčajne nesedí CashRegisterCode s kódom kasy / certifikátom v Portos po zmene firmy.
 */
export function explainPortosCertificateError(raw) {
  const blob = [raw?.detail, raw?.title, raw?.message, raw?.errorDetail, raw?.error?.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!blob) return null;
  if (blob.includes('certifik') && blob.includes('alias')) {
    return (
      'Portos nenašiel certifikát pre zvolený kód pokladne. Po zmene firmy musí PORTOS_CASH_REGISTER_CODE ' +
      '(alebo údaj uložený v profile firmy) presne zodpovedať kódu kasy v Portos a v Portos musí byť nahraný platný podpisový certifikát pre túto firmu.'
    );
  }
  return null;
}

/** Backwards-compat alias. */
export const explainPortosPrintCopyFailure = explainPortosCertificateError;

export function isPrintCopyResponseSuccess(result) {
  if (!result || typeof result !== 'object') return false;
  return PRINT_COPY_SUCCESS_STATUSES.has(result.httpStatus) && Boolean(result.printed);
}

export async function findReceiptByExternalId(externalId, { cashRegisterCode: codeOverride } = {}) {
  const cashRegisterCode = resolveCashRegisterCodeForReceipt(codeOverride);
  const response = await portosRequest('GET', '/api/v1/requests/receipts/receipt', {
    query: {
      CashRegisterCode: cashRegisterCode,
      ExternalId: externalId,
    },
  });

  if (response.status === 404) return null;
  if (!LOOKUP_SUCCESS_STATUSES.has(response.status)) return null;

  const parsed = normalizeReceiptResult(response.data);
  if (!parsed.receiptId && !parsed.okp) return null;
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Portos niekedy ešte nevráti doklad hneď po POST; krátke opakovania znížia falošné "ambiguous".
 */
export async function findReceiptByExternalIdWithRetry(
  externalId,
  { tries = 5, delayMs = 450, cashRegisterCode: codeOverride } = {},
) {
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const receipt = await findReceiptByExternalId(externalId, { cashRegisterCode: codeOverride });
      if (receipt) return receipt;
    } catch {
      /* ďalší pokus */
    }
  }
  return null;
}

export async function printCopyByExternalId(externalId, { cashRegisterCode: codeOverride } = {}) {
  const cashRegisterCode = resolveCashRegisterCodeForReceipt(codeOverride);
  const response = await portosRequest('POST', '/api/v1/requests/receipts/print_copy', {
    query: {
      CashRegisterCode: cashRegisterCode,
      ExternalId: externalId,
    },
  });

  return {
    httpStatus: response.status,
    printed: response.data?.printed ?? PRINT_COPY_SUCCESS_STATUSES.has(response.status),
    raw: response.data,
    ok: response.ok,
  };
}

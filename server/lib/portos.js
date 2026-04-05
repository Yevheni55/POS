const DEFAULT_BASE_URL = 'http://localhost:3010';
const DEFAULT_CASH_REGISTER_CODE = '88812345678900001';
/** Nie názov tlačiarne vo Windows — NineDigit API: `pos` = papier/CHDU, `pdf`, `email`. */
const DEFAULT_PRINTER_NAME = 'pos';
const DEFAULT_TIMEOUT_MS = 10_000;

const RECEIPT_OUTPUT_CHANNELS = new Set(['pos', 'pdf', 'email']);

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
  return /^(1|true|yes|on)$/i.test(String(value || ''));
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

function normalizeRegisterResult(status, data, requestPayload) {
  const requestData = data?.request?.data || {};

  return {
    httpStatus: status,
    resultMode: status === 200
      ? 'online_success'
      : status === 202
        ? 'offline_accepted'
        : status === 400
          ? 'validation_error'
          : status === 403
            ? 'rejected'
            : 'error',
    isSuccessful: data?.isSuccessful ?? null,
    receiptId: data?.response?.data?.id || null,
    receiptNumber: requestData.receiptNumber ?? null,
    okp: requestData.okp || null,
    portosRequestId: data?.request?.id || null,
    processDate: data?.response?.processDate || requestData.createDate || data?.request?.date || null,
    errorCode: data?.code ?? data?.error?.code ?? data?.error?.eKasaErrorCode ?? null,
    errorDetail: stringifyErrorDetail(data),
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

export async function getStatus() {
  const config = getPortosConfig();
  const identityResult = await safePortosRequest('GET', '/api/v1/identities');
  const identity = Array.isArray(identityResult.data) ? identityResult.data[0] : null;
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

export async function findReceiptByExternalId(externalId) {
  const { cashRegisterCode } = getPortosConfig();
  const response = await portosRequest('GET', '/api/v1/requests/receipts/receipt', {
    query: {
      CashRegisterCode: cashRegisterCode,
      ExternalId: externalId,
    },
  });

  if (response.status === 404) return null;
  return normalizeReceiptResult(response.data);
}

export async function printCopyByExternalId(externalId) {
  const { cashRegisterCode } = getPortosConfig();
  const response = await portosRequest('POST', '/api/v1/requests/receipts/print_copy', {
    query: {
      CashRegisterCode: cashRegisterCode,
      ExternalId: externalId,
    },
  });

  return {
    httpStatus: response.status,
    printed: response.data?.printed ?? response.status === 200,
    raw: response.data,
  };
}

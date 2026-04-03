const DEFAULT_BASE_URL = 'http://localhost:3010';
const DEFAULT_CASH_REGISTER_CODE = '88812345678900001';
const DEFAULT_PRINTER_NAME = 'pos';
const DEFAULT_TIMEOUT_MS = 10_000;

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
    printerName: process.env.PORTOS_PRINTER_NAME || DEFAULT_PRINTER_NAME,
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
      throw new PortosTransportError('Portos request timed out', error);
    }
    throw new PortosTransportError('Portos request failed', error);
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

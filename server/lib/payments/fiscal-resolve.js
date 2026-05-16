import { validateReceiptMatchesRequest } from '../fiscal-payment.js';
import {
  findReceiptByExternalIdWithRetry,
  PortosTransportError,
  printCopyByExternalId,
  registerCashReceipt,
} from '../portos.js';
import { sleep } from './shared.js';

export function needsReceiptEnrichment(outcome) {
  return !outcome.receiptId || !outcome.okp || outcome.receiptNumber === null;
}

export function mergeReceiptOutcome(baseOutcome, receipt) {
  if (!receipt) return baseOutcome;

  return {
    ...baseOutcome,
    isSuccessful: receipt.isSuccessful ?? baseOutcome.isSuccessful,
    receiptId: receipt.receiptId || baseOutcome.receiptId,
    receiptNumber: receipt.receiptNumber ?? baseOutcome.receiptNumber,
    okp: receipt.okp || baseOutcome.okp,
    portosRequestId: receipt.portosRequestId || baseOutcome.portosRequestId,
    processDate: receipt.processDate || baseOutcome.processDate,
    responseJson: receipt.responseJson || baseOutcome.responseJson,
  };
}

export function cashRegisterFromFiscalPayload(requestPayload) {
  return requestPayload?.request?.data?.cashRegisterCode;
}

export async function enrichSuccessfulFiscalOutcome({ requestPayload, outcome }) {
  if (!needsReceiptEnrichment(outcome)) return outcome;
  const receipt = await findReceiptByExternalIdWithRetry(requestPayload.request.externalId, {
    cashRegisterCode: cashRegisterFromFiscalPayload(requestPayload),
  });
  if (!receipt) return outcome;
  // Defense-in-depth: do NOT merge a remote receipt that doesn't match what
  // we sent. Otherwise a stale Portos cache (e.g. after dev DB reset) could
  // pin our payment to a stranger's receipt — finančná správa vidí mismatch
  // amount/items voči tomu čo sme reálne predali → pokuta.
  const v = validateReceiptMatchesRequest(receipt, requestPayload);
  if (!v.ok) {
    console.error('[Portos] Receipt mismatch on enrich — refusing to merge cudzí blok',
      { externalId: requestPayload.request.externalId, ...v });
    return { ...outcome, resultMode: 'mismatch_rejected', mismatchReason: v.reason };
  }
  return mergeReceiptOutcome(outcome, receipt);
}

export async function resolveFiscalAttempt({ requestPayload, initialOutcome }) {
  const externalId = requestPayload.request.externalId;

  if (initialOutcome.resultMode === 'blocked') {
    return initialOutcome;
  }

  // Musí súhlasiť s normalizeRegisterResult (200 aj 201 = úspech). Predtým 201 spadlo do lookupu → náhodný 503/ambiguous.
  if (
    initialOutcome.httpStatus === 200 ||
    initialOutcome.httpStatus === 201 ||
    initialOutcome.httpStatus === 202
  ) {
    try {
      return await enrichSuccessfulFiscalOutcome({ requestPayload, outcome: initialOutcome });
    } catch {
      return initialOutcome;
    }
  }

  if (initialOutcome.httpStatus === 400 || initialOutcome.httpStatus === 403) {
    return initialOutcome;
  }

  try {
    const existingReceipt = await findReceiptByExternalIdWithRetry(externalId, {
      cashRegisterCode: cashRegisterFromFiscalPayload(requestPayload),
    });
    if (!existingReceipt) {
      return {
        ...initialOutcome,
        resultMode: 'ambiguous',
      };
    }
    // Defense-in-depth: refuse to reconcile a remote doc whose items/amount
    // don't match the request — that's how the "Espresso instead of 2× Kofola"
    // bug happened (stale Portos cache for a recycled orderId).
    const v = validateReceiptMatchesRequest(existingReceipt, requestPayload);
    if (!v.ok) {
      console.error('[Portos] Receipt mismatch on reconcile — keeping outcome as ambiguous',
        { externalId, ...v });
      return { ...initialOutcome, resultMode: 'mismatch_rejected', mismatchReason: v.reason };
    }

    let copyPrinted = false;
    if (initialOutcome.errorCode === -502) {
      try {
        const copyResult = await printCopyByExternalId(externalId, {
          cashRegisterCode: cashRegisterFromFiscalPayload(requestPayload),
        });
        copyPrinted = Boolean(copyResult.printed);
      } catch {
        copyPrinted = false;
      }
    }

    const reconciledOutcome = mergeReceiptOutcome(initialOutcome, existingReceipt);

    return {
      ...reconciledOutcome,
      resultMode: existingReceipt.isSuccessful === null
        ? 'reconciled_offline_accepted'
        : 'reconciled_online_success',
      copyPrinted,
    };
  } catch (lookupError) {
    return {
      ...initialOutcome,
      resultMode: 'ambiguous',
      errorDetail: initialOutcome.errorDetail || lookupError.message,
    };
  }
}

export function buildTransportFailure(requestPayload, error) {
  return {
    httpStatus: null,
    resultMode: 'ambiguous',
    isSuccessful: null,
    receiptId: null,
    receiptNumber: null,
    okp: null,
    portosRequestId: null,
    processDate: null,
    errorCode: null,
    errorDetail: error.message,
    requestJson: JSON.stringify(requestPayload),
    responseJson: JSON.stringify({ error: error.message }),
  };
}

/** Krátke opakovania pri výpadku host.docker.internal / siete. externalId je idempotentné voči Portos. */
export async function registerCashReceiptWithRetry(requestPayload, { maxAttempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await registerCashReceipt(requestPayload);
    } catch (e) {
      lastError = e;
      if (!(e instanceof PortosTransportError) || attempt === maxAttempts) throw e;
      await sleep(400 * attempt);
    }
  }
  throw lastError;
}

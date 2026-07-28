// QR platba (Portos PLATBY → QR platba, PayMe/SBA okamžitý prevod).
//
// Tok:
//   1. POST /api/payments/qr { orderId }  → vytvorí QR platbu v Portos na
//      sumu objednávky (expectedTotal — odvodené na serveri, nie z klienta),
//      vráti transactionId + Payme link + QR obrázok (data URL) + expiresAt.
//   2. Frontend zobrazí QR a pooluje GET /api/payments/qr/:transactionId.
//   3. Keď status='paid' (alebo 'overpaid'), frontend zavolá ŠTANDARDNÝ
//      POST /api/payments { method:'prevod' } → fiškálny doklad cez Portos.
//      (QR platba sama o sebe fiškálny doklad NEvystavuje.)
//
// Merchant IBAN je nakonfigurovaný priamo v Portos pre daný cashRegisterCode,
// takže ho tu neukladáme — Portos ho doplní do QR sám.

import QRCode from 'qrcode';

import {
  isPortosEnabled,
  PortosTransportError,
  createQrPayment,
  getQrPaymentStatus,
  renderQrPaymentOnPrinter,
  printQrFailureNotice,
  normalizeQrStatus,
  QR_PAID_STATUSES,
  QR_FINAL_STATUSES,
} from '../portos.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { loadOrderPaymentContext } from './context.js';

/** Z links[] vyber preferovane Payme v2 odkaz (zhoda so screenom Portosu), inak prvý. */
function pickPayLink(links) {
  const list = Array.isArray(links) ? links.filter((l) => l && l.url) : [];
  if (!list.length) return null;
  const payme2 = list.find(
    (l) => String(l.provider || '').toLowerCase().includes('payme') && String(l.version || '').startsWith('2'),
  );
  const payme = list.find((l) => String(l.provider || '').toLowerCase().includes('payme'));
  return (payme2 || payme || list[0]).url;
}

function portosUnavailable(res, error) {
  const detail = error instanceof Error ? error.message : 'Portos je nedostupný';
  return res.status(502).json({ error: detail });
}

export async function createQrPaymentHandler(req, res) {
  if (!isPortosEnabled()) {
    return res.status(400).json({ error: 'QR platba vyžaduje zapnutú Portos eKasu' });
  }

  const orderId = Number.parseInt(req.body && req.body.orderId, 10);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'Neplatné orderId' });
  }

  const orderContext = await loadOrderPaymentContext(orderId);
  if (!orderContext) {
    return res.status(404).json({ error: 'Objednávka nenájdená' });
  }
  if (orderContext.order.status !== 'open') {
    return res.status(400).json({ error: 'Objednávka už nie je otvorená' });
  }
  const amount = Math.round(Number(orderContext.expectedTotal) * 100) / 100;
  if (!(amount > 0)) {
    return res.status(400).json({ error: 'Nie je čo platiť (suma je 0)' });
  }

  // Kód pokladne MUSÍ byť ten istý aktuálny ako pri fiškalizácii (cash_register)
  // — getActiveCashRegisterCode() ho berie zo synchronizovaného company profilu
  // (zdroj pravdy = Portos /identities), nie z .env defaultu. Inak Portos pošle
  // "certifikát s aliasom <starý kód> nebol nájdený" po zmene firmy/pokladne.
  const cashRegisterCode = await getActiveCashRegisterCode();

  let result;
  try {
    let attempts = 0;
    do {
      result = await createQrPayment({
        amount,
        cashRegisterCode,
        comment: `Objednávka #${orderId}`,
        recipientMessage: `Obj. ${orderId}`,
      });
      attempts += 1;
      // HTTP 500 + code -701 = QrPaymentInitializationError (prechodná chyba
      // spojenia na službu okamžitých platieb) — NineDigit dokumentácia
      // explicitne odporúča request zopakovať.
    } while (result.status === 500 && result.data && result.data.code === -701 && attempts < 3);
  } catch (error) {
    if (!(error instanceof PortosTransportError)) {
      console.error('QR payment create error:', error);
    }
    return portosUnavailable(res, error);
  }

  const data = result.data || {};
  if (!result.ok || !data.transactionId) {
    const detail = data?.detail || data?.title
      || (data?.code === -701 ? 'Portos: chyba inicializácie QR platby — skús znova' : null)
      || 'QR platbu sa nepodarilo vytvoriť';
    return res.status(result.status === 400 ? 400 : 502).json({ error: detail, portosStatus: result.status });
  }

  console.log(`[QR] created tx=${data.transactionId} order=${orderId} amount=${amount} cashRegisterCode=${cashRegisterCode} expiresAt=${data.expiresAt} status="${data.status}"`);

  const payUrl = pickPayLink(data.links);
  if (!payUrl) {
    return res.status(502).json({ error: 'Portos nevrátil platobný odkaz pre QR' });
  }

  // PRIMÁRNE: QR vytlačí Portos na bonček (rendererName: posPrinter) — zákazník
  // skenuje z papiera, nie z obrazovky tabletu. (NineDigit krok 2b.)
  let printed = false;
  try {
    const rr = await renderQrPaymentOnPrinter(data.transactionId);
    printed = !!rr.ok;
    if (!rr.ok) console.warn(`[QR] render(posPrinter) zlyhal tx=${data.transactionId} status=${rr.status}`);
  } catch (error) {
    if (!(error instanceof PortosTransportError)) console.error('QR render error:', error);
    console.warn(`[QR] render(posPrinter) chyba tx=${data.transactionId}: ${error && error.message}`);
  }

  // QR obrázok generujeme VŽDY (aj keď sa vytlačil) — frontend ho použije ako
  // fallback len keď tlač zlyhala. Vracaním ho vždy ostáva odpoveď kompatibilná
  // aj so staršou (zakešovanou) verziou frontendu, ktorá `qrDataUrl` vyžaduje.
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(payUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  } catch (error) {
    console.error('QR image render error:', error);
  }

  return res.status(201).json({
    transactionId: data.transactionId,
    orderId,
    amount: Number(data.amount ?? amount),
    currencyCode: data.currencyCode || 'EUR',
    status: normalizeQrStatus(data.status) || 'pending',
    expiresAt: data.expiresAt || null,
    createdAt: data.createdAt || null,
    payUrl,
    printed,
    qrDataUrl,
  });
}

// POST /payments/qr/:transactionId/render — znovu vytlačí QR bonček (napr. keď
// sa zasekol papier). NineDigit: POST .../render { rendererName: 'posPrinter' }.
export async function qrRenderHandler(req, res) {
  const transactionId = String(req.params.transactionId || '').trim();
  if (!transactionId) {
    return res.status(400).json({ error: 'Chýba transactionId' });
  }
  try {
    const r = await renderQrPaymentOnPrinter(transactionId);
    if (!r.ok) {
      return res.status(502).json({ error: 'Tlač QR kódu zlyhala', portosStatus: r.status });
    }
    return res.status(204).end();
  } catch (error) {
    if (!(error instanceof PortosTransportError)) {
      console.error('QR render (reprint) error:', error);
    }
    return portosUnavailable(res, error);
  }
}

export async function qrPaymentStatusHandler(req, res) {
  const transactionId = String(req.params.transactionId || '').trim();
  if (!transactionId) {
    return res.status(400).json({ error: 'Chýba transactionId' });
  }

  let result;
  try {
    result = await getQrPaymentStatus(transactionId, { awaitFinal: false });
  } catch (error) {
    if (!(error instanceof PortosTransportError)) {
      console.error('QR payment status error:', error);
    }
    return portosUnavailable(res, error);
  }

  if (result.status === 404) {
    return res.status(404).json({ error: 'QR platba nenájdená' });
  }
  const data = result.data || {};
  // NEpožadujeme data.transactionId — niektoré Portos verzie ho v stave
  // nemusia vrátiť (alebo pod iným kľúčom). Stačí úspešná odpoveď.
  if (!result.ok) {
    return res.status(502).json({ error: 'Stav QR platby sa nepodarilo načítať', portosStatus: result.status });
  }

  const status = normalizeQrStatus(data.status);
  // Úspech sa určuje LEN podľa statusu (paid|overpaid) — presne ako NineDigit
  // (status je rozhodovacie kritérium; paidAmount/remainingAmount/overpaidAmount
  // sú iba informatívne). 'expired' = finálne zlyhanie; 'pending'/'partiallyPaid'
  // = neukončené → klient pokračuje v poolingu.
  const paid = QR_PAID_STATUSES.has(status);
  const final = QR_FINAL_STATUSES.has(status);

  console.log(`[QR] status tx=${transactionId} rawStatus="${data.status}" status=${status} → paid=${paid} final=${final}`);

  return res.status(200).json({
    transactionId: data.transactionId || transactionId,
    status,
    paid,
    final,
    paidAmount: Number(data.paidAmount ?? 0),
    remainingAmount: Number(data.remainingAmount ?? 0),
    overpaidAmount: Number(data.overpaidAmount ?? 0),
    expiresAt: data.expiresAt || null,
  });
}

// POST /payments/qr/:transactionId/non-delivery-notice
// Vytlačí "doklad o nepotvrdení zrealizovanej platby" — zákonná povinnosť
// (§15 ods. 3 zákona o evidencii tržieb), keď notifikácia o úhrade nedorazí
// v limite. NineDigit DLL ho volá práve na vetve 'expired'. Idempotentne
// — Portos vráti 204 pri úspechu.
export async function qrNonDeliveryNoticeHandler(req, res) {
  const transactionId = String(req.params.transactionId || '').trim();
  if (!transactionId) {
    return res.status(400).json({ error: 'Chýba transactionId' });
  }
  try {
    const r = await printQrFailureNotice(transactionId);
    if (!r.ok) {
      return res.status(502).json({ error: 'Tlač oznámenia o nepotvrdení platby zlyhala', portosStatus: r.status });
    }
    return res.status(204).end();
  } catch (error) {
    if (!(error instanceof PortosTransportError)) {
      console.error('QR non-delivery notice error:', error);
    }
    return portosUnavailable(res, error);
  }
}

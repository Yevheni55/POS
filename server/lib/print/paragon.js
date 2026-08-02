import { desc, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { companyProfiles, offlineParagons } from '../../db/schema.js';
import { roundMoney } from '../reports/shared.js';
import { getVatMode } from '../vat-registration.js';

import { localDateTime, localTimeHHMM } from './format.js';
import { getPrinterForDest } from './network.js';
import { sendOrQueue } from './queue.js';
import { buildParagonTicket } from './tickets.js';

/**
 * Identita predávajúceho pre hlavičku paragónu. Zdroj je posledný riadok
 * `company_profiles` (rovnaký pattern ako server/lib/active-cash-register.js) —
 * NIE telo requestu. Traja klienti (web POS, Android, Windows) posielajú dnes
 * `companyName: null`, takže na papieri nebola ani firma, ani IČO/DIČ/IČ DPH.
 */
async function loadSellerIdentity() {
  const [row] = await db
    .select()
    .from(companyProfiles)
    .orderBy(desc(companyProfiles.id))
    .limit(1);
  return row || null;
}

/**
 * Rekapitulácia DPH zo ZMRAZENÉHO Portos payloadu paragónu.
 *
 * `offline_paragons.request_payload_json` je presne to, čo sa po obnove Portosu
 * zaregistruje v eKase — papier a doklad tak musia súhlasiť. Berieme z neho
 * `request.data.items[]`, kde každý riadok nesie `price` (súčet za riadok,
 * záporný pri `type: 'Discount'`) a `vatRate`.
 *
 * DPH v cene = price − price / (1 + rate/100).
 *
 * @returns {{ vatSummary: Array<{rate:number, base:number, vat:number}>, discount: number|null }}
 */
export function buildVatSummaryFromParagonPayload(payloadJson) {
  const payload = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
  const items = payload && payload.request && payload.request.data
    ? payload.request.data.items
    : null;
  if (!Array.isArray(items) || !items.length) return { vatSummary: [], discount: null };

  const groups = new Map();
  let discount = 0;
  for (const line of items) {
    const rate = Number(line && line.vatRate) || 0;
    const price = Number(line && line.price) || 0;
    if (String((line && line.type) || '').toLowerCase() === 'discount') {
      // Discount riadky majú zápornú cenu (fiscal-payment.js) — zľava je ich súčet.
      discount = roundMoney(discount - price);
    }
    const group = groups.get(rate) || { rate, gross: 0 };
    group.gross = roundMoney(group.gross + price);
    groups.set(rate, group);
  }

  const vatSummary = Array.from(groups.values())
    .filter((g) => Math.abs(g.gross) > 0.005)
    .map((g) => {
      const base = roundMoney(g.gross / (1 + g.rate / 100));
      return { rate: g.rate, base, vat: roundMoney(g.gross - base) };
    })
    .sort((a, b) => a.rate - b.rate);

  return { vatSummary, discount };
}

// POST /api/print/paragon — print manual paragón po jeho vystavení.
//
// Fiškálne údaje (režim DPH, identita predávajúceho, rekapitulácia DPH) sa
// odvádzajú SERVER-SIDE. Klientske `vatRate` / `companyName` z tela requestu sa
// ZÁMERNE ignorujú — traja klienti by inak driftovali a všetci dnes posielajú
// natvrdo zadrátovaný predpoklad neplatiteľa DPH (audit [21][28]).
export async function paragonHandler(req, res) {
  try {
    const { paragonNumber, tableName, staffName, items, total, method } = req.body || {};
    if (!paragonNumber || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Chyba paragonNumber alebo items' });
    }

    // Režim DPH + identita. POZOR: tu sa ZÁMERNE nevolá `assertVatModeTrusted()` —
    // paragón sa vystavuje práve vtedy, keď je Portos dole, takže fail-closed 503
    // by zablokoval tlač náhradného dokladu, ktorý zákazník musí dostať.
    // Čítame len DB profil; keď zlyhá aj ten, tlačíme aspoň to, čo dnes.
    let seller = null;
    let vatRegistered = false;
    try {
      const [mode, profile] = await Promise.all([getVatMode(), loadSellerIdentity()]);
      vatRegistered = mode.vatRegistered;
      if (profile) {
        seller = {
          businessName: profile.businessName || '',
          ico: profile.ico || '',
          dic: profile.dic || '',
          // IČ DPH patrí na doklad len platiteľovi.
          icDph: vatRegistered ? (profile.icDph || '') : '',
          registeredAddress: profile.registeredAddress || '',
        };
      }
    } catch (profileErr) {
      console.warn('Paragon print: profil firmy sa nepodarilo nacitat:', profileErr.message);
    }

    // Zľava + rekapitulácia DPH zo zmrazeného payloadu (single source of truth
    // pre to, čo sa neskôr zaregistruje v eKase).
    let vatSummary = [];
    let discount = null;
    try {
      const [paragonRow] = await db
        .select({ payload: offlineParagons.requestPayloadJson, totalAmount: offlineParagons.totalAmount })
        .from(offlineParagons)
        .where(eq(offlineParagons.paragonNumber, String(paragonNumber)))
        .limit(1);
      if (paragonRow && paragonRow.payload) {
        // Papier musí ukazovať tú istú sumu, aká sa neskôr zaregistruje v eKase.
        // Sumu z tela NEprepisujeme (u neplatiteľa by sa zmenil výstup), ale
        // rozdiel zalogujeme — je to signál, že klient a server vyskladali
        // položky paragónu inak.
        const registered = Number(paragonRow.totalAmount);
        if (Number.isFinite(registered) && Math.abs(registered - (Number(total) || 0)) > 0.005) {
          console.warn(`Paragon print: paragón ${paragonNumber} — tlačená suma ${Number(total) || 0} sa líši od zaregistrovanej ${registered}`);
        }
        const derived = buildVatSummaryFromParagonPayload(paragonRow.payload);
        // 0 → `null`, nech si tiket zľavu dopočíta z rozdielu (starý web POS
        // `discountAmount` do /api/paragons vôbec neposiela, viď audit [29]).
        discount = derived.discount > 0.005 ? derived.discount : null;
        // Neplatiteľ: payload má všade vatRate 0 (forceZeroVat) → rekapituláciu
        // netlačíme vôbec, výstup ostáva bajt za bajtom ako doteraz.
        if (vatRegistered) vatSummary = derived.vatSummary;
      } else if (vatRegistered) {
        console.warn(`Paragon print: paragón ${paragonNumber} nemá zmrazený payload — DPH rekapitulácia sa nevytlačí`);
      }
    } catch (paragonErr) {
      console.warn('Paragon print: payload paragónu sa nepodarilo nacitat:', paragonErr.message);
    }

    const time = localTimeHHMM();
    const dateStr = localDateTime();
    const printer = await getPrinterForDest('uctenka');
    const ticket = buildParagonTicket({
      paragonNumber,
      tableName,
      staffName,
      items,
      total: Number(total) || 0,
      discount,
      vatSummary,
      seller,
      method: method || 'hotovost',
      time,
      dateStr,
    });
    const result = await sendOrQueue('paragon', ticket, printer.ip, printer.port);
    res.json({ ok: true, queued: !!result.queued });
  } catch (e) {
    console.error('Paragon print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

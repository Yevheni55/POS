import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, menuItems, staff } from '../../db/schema.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { allocateDiscountAcrossVatGroups } from '../fiscal-payment.js';
import { lineDiscountAmount } from '../payments/shared.js';
import { localDateSK, localTimeHHMM, localYmd } from '../print/format.js';

import { TZ, roundMoney, notStornoedSql, notForeignCashRegisterSql } from './shared.js';

// Doklad je právoplatne zaevidovaný v rovnakých `result_mode` ako pri
// `notStornoedSql` (server/lib/reports/shared.js) — offline akceptovaný doklad
// je rovnako platný ako online. Zoznam je zámerne duplikovaný ako string
// literál, lebo ide do RAW SQL fragmentu vo vnorenom SELECT-e.
const ACCEPTED_FISCAL_MODES = "'online_success','offline_accepted','reconciled_online_success','reconciled_offline_accepted'";

/**
 * Rozpad Základ/DPH zo ZMRAZENÉHO fiškálneho dokladu.
 *
 * `fiscal_documents.request_json` je JEDINÝ immutable zdroj toho, s akou
 * sadzbou doklad naozaj vznikol: `buildFiscalReceiptItems`
 * (server/lib/fiscal-payment.js) tam zapisuje per-riadok `price` aj `vatRate`
 * PO aplikovaní `forceZeroVat`. Živé `menu_items.vat_rate` sa medzitým mohlo
 * zmeniť (alebo bola firma v čase predaja neplatiteľ) — potom by export
 * vyrobil DPH, ktorá na doklade nikdy nebola.
 *
 * Zľavy sú v `items[]` už ako samostatné záporné riadky typu 'Discount' s
 * VLASTNOU sadzbou, takže sa na ne NESMIE znova aplikovať
 * `orders.discountAmount` / `lineDiscountAmount`.
 *
 * @returns {{ zaklad:number, dph:number, gross:number }|null} null = doklad sa
 *   nedá použiť (chýba, nedá sa rozparsovať, alebo nemá položky)
 */
function vatSplitFromFiscalRequest(requestJson) {
  if (!requestJson) return null;
  let payload;
  try {
    payload = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson;
  } catch {
    return null;
  }
  const data = payload && payload.request && payload.request.data;
  const items = data && Array.isArray(data.items) ? data.items : null;
  if (!items || !items.length) return null;

  const vatGroups = new Map();
  for (const line of items) {
    const price = Number(line && line.price);
    if (!Number.isFinite(price)) return null;
    const vatRate = Number(line.vatRate) || 0;
    // Sadzba -100 % by delila nulou; v SR neexistuje, ale radšej doklad zahodíme.
    if (1 + (vatRate / 100) === 0) return null;
    vatGroups.set(vatRate, roundMoney((vatGroups.get(vatRate) || 0) + price));
  }

  let zaklad = 0;
  let dph = 0;
  let gross = 0;
  for (const [vatRate, groupGross] of vatGroups.entries()) {
    const base = roundMoney(groupGross / (1 + (vatRate / 100)));
    zaklad = roundMoney(zaklad + base);
    dph = roundMoney(dph + (groupGross - base));
    gross = roundMoney(gross + groupGross);
  }
  return { zaklad, dph, gross };
}

// GET /api/reports/export?from=2026-03-01&to=2026-03-26&format=csv
export async function exportHandler(req, res) {
  // Defaultny rozsah = poslednych 30 LOKALNYCH dni (UTC den sa po polnoci lisi).
  const from = req.query.from || localYmd(new Date(Date.now() - 30 * 86400000));
  const to = req.query.to || localYmd();
  const format = req.query.format || 'csv';

  // Uctovnicky export musi rezat dni v Europe/Bratislava. `new Date(from)`
  // bola UTC polnoc = 02:00 lokalne, takze vecerne doklady posledneho dna
  // v obdobi vypadli z exportu a rannne z predosleho dna sa pridali.
  // Stlpec je `timestamp` bez zony (UTC nastenny cas) → interpretujeme ho
  // explicitne ako UTC, aby vysledok nezavisel od session TimeZone databazy.
  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${to + ' 23:59:59.999'})::timestamp AT TIME ZONE ${TZ}`;
  const inRange = (col) => sql`(${col} AT TIME ZONE 'UTC') >= ${fromBoundary} AND (${col} AT TIME ZONE 'UTC') <= ${toBoundary}`;

  try {
    // Na kase sa môže zmeniť daňový subjekt — účtovný export nesmie miešať
    // tržby dvoch firiem. Prázdny kód = filter sa neaplikuje (rovnaký fallback
    // ako server/lib/payments/history.js).
    const activeCashRegisterCode = await getActiveCashRegisterCode();

    // Get all closed orders with payments, items, and staff
    const rawOrders = await db.select({
      orderId: orders.id,
      orderCreatedAt: orders.createdAt,
      orderStatus: orders.status,
      orderDiscountAmount: sql`COALESCE(${orders.discountAmount}::numeric, 0)`,
      staffName: staff.name,
      paymentMethod: payments.method,
      paymentAmount: sql`${payments.amount}::numeric`,
      orderItemId: orderItems.id,
      itemName: menuItems.name,
      itemQty: orderItems.qty,
      itemPrice: sql`${menuItems.price}::numeric`,
      itemVatRate: sql`COALESCE(${menuItems.vatRate}::numeric, 0)`,
      itemDiscountType: orderItems.discountType,
      itemDiscountValue: sql`${orderItems.discountValue}::numeric`,
      // Zmrazený payload PREDAJNÉHO dokladu k tejto platbe — jediný immutable
      // zdroj sadzieb DPH. Korelovaný sub-SELECT (nie JOIN), aby prípadné dva
      // doklady na jednu platbu nezdvojili riadky join fan-outom.
      fiscalRequestJson: sql`(
        SELECT fd.request_json
        FROM fiscal_documents fd
        WHERE fd.payment_id = ${payments.id}
          AND fd.source_type = 'payment'
          AND fd.result_mode IN (${sql.raw(ACCEPTED_FISCAL_MODES)})
        ORDER BY fd.id DESC
        LIMIT 1
      )`,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .innerJoin(staff, eq(orders.staffId, staff.id))
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    // Stornovaná platba NIE JE tržba — opravný doklad ju v eKase vrátil, ale
    // riadok v `payments` ostáva. Bez tohto filtra sa priznávala DPH zo
    // zrušeného predaja (a CSV si protirečilo s uzávierkou aj so Sezónou).
    .where(sql`${inRange(payments.createdAt)}
      AND ${sql.raw(notStornoedSql('payments'))}
      AND ${sql.raw(notForeignCashRegisterSql('payments', activeCashRegisterCode))}`)
    .orderBy(desc(payments.createdAt));

    // Group by payment (orderId + paymentMethod as key)
    const grouped = {};
    for (const row of rawOrders) {
      const key = row.orderId + '-' + row.paymentMethod;
      if (!grouped[key]) {
        grouped[key] = {
          orderId: row.orderId,
          date: row.orderCreatedAt,
          staffName: row.staffName,
          paymentMethod: row.paymentMethod,
          paymentAmount: parseFloat(row.paymentAmount),
          discountAmount: parseFloat(row.orderDiscountAmount),
          itemDiscountTotal: 0,
          fiscalRequestJson: row.fiscalRequestJson || null,
          _seenItemIds: new Set(),
          items: [],
        };
      }
      // Deduplikacia join fan-outu je na order_item ID, NIE na nazve polozky.
      // Podla nazvu sa dva legitimne riadky s rovnakym produktom (Kofola
      // s poznamkou a bez) zlucili do jedneho → z uctu zmizla polozka
      // a "Zaklad" prestal sediet s "Celkom". Zlava aj samotna polozka sa
      // preto zapocitaju presne raz per order_item.
      const oiId = row.orderItemId;
      const seenItemIds = grouped[key]._seenItemIds;
      if (oiId == null || !seenItemIds.has(oiId)) {
        if (oiId != null) seenItemIds.add(oiId);
        // Per-item discount pooled into the order discount before VAT
        // allocation so zaklad/DPH reconcile with celkom = payments.amount.
        const discValue = row.itemDiscountValue == null ? null : parseFloat(row.itemDiscountValue);
        if (row.itemDiscountType && discValue) {
          grouped[key].itemDiscountTotal += lineDiscountAmount(
            parseFloat(row.itemPrice), row.itemQty, row.itemDiscountType, discValue,
          );
        }
        grouped[key].items.push({
          name: row.itemName,
          qty: row.itemQty,
          price: parseFloat(row.itemPrice),
          vatRate: parseFloat(row.itemVatRate),
        });
      }
    }
    const rows = Object.values(grouped).map(g => {
      // Datum aj cas v Bratislava zone — `toLocaleDateString` bez `timeZone`
      // beri TZ procesu (Docker = UTC), takze doklad z 00:30 lokalneho casu
      // mal v exporte predosly den a cas o 1–2 h posunuty.
      const dt = new Date(g.date);
      const dateStr = localDateSK(dt);
      const timeStr = localTimeHHMM(dt);
      const itemsList = g.items.map(i => i.qty + 'x ' + i.name).join(', ');
      const celkom = g.paymentAmount;

      // 1) PRIMÁRNY zdroj = zmrazený fiškálny doklad. Berieme ho len vtedy, keď
      //    jeho súčet riadkov sedí s reálne zaplatenou sumou — inak by CSV
      //    ukázalo iný Celkom než Základ+DPH.
      const fiscal = vatSplitFromFiscalRequest(g.fiscalRequestJson);
      if (fiscal && Math.abs(fiscal.gross - celkom) <= 0.011) {
        const zaklad = fiscal.zaklad;
        return {
          cislo: g.orderId,
          datum: dateStr,
          cas: timeStr,
          polozky: itemsList,
          zaklad,
          // Invariant Zaklad + DPH === Celkom (doklad sa smie od platby líšiť
          // nanajvýš o zaokrúhlenie centu).
          dph: roundMoney(celkom - zaklad),
          celkom,
          platba: g.paymentMethod,
          cisnik: g.staffName,
          zdroj: 'doklad',
        };
      }

      // 2) FALLBACK — platba bez použiteľného fiškálneho dokladu (Portos
      //    vypnutý, staré riadky, paragón). Dopočítame zo ŽIVÉHO menu; čísla sú
      //    len ODHAD a v CSV sú tak aj označené, nech ich účtovníčka nezmieša
      //    do priznania DPH.
      const vatGroups = new Map();
      for (const item of g.items) {
        const key = String(item.vatRate);
        vatGroups.set(key, roundMoney((vatGroups.get(key) || 0) + (item.price * item.qty)));
      }
      // Pool order-level + per-item discounts into the VAT allocation so the
      // VAT base nets out to the actual charged amount (celkom).
      const pooledDiscount = roundMoney(g.discountAmount + g.itemDiscountTotal);
      for (const discount of allocateDiscountAcrossVatGroups(g.items, pooledDiscount)) {
        const key = String(discount.vatRate || 0);
        vatGroups.set(key, roundMoney((vatGroups.get(key) || 0) + discount.price));
      }

      // Rozpad sa NESMIE počítať z cenníkových súm priamo: `celkom` je reálne
      // zaplatená suma z `payments.amount`, kým `vatGroups` sú živé menu ceny.
      // Keď sa cena/sadzba po predaji zmenila (nález [15]), tie dve čísla sa
      // rozídu a v CSV pre účtovníčku vznikol riadok, kde Zaklad + DPH ≠ Celkom.
      // Z cenníka preto berieme LEN pomer sadzieb (netto podiel) a aplikujeme
      // ho na skutočne zaplatenú sumu — rovnaká matematika ako `netFactorFor()`
      // v server/lib/reports/summary.js. Invariant potom drží rovnako ako vo
      // vetve 'doklad': dph = celkom − zaklad.
      const grossSum = roundMoney(
        Array.from(vatGroups.values()).reduce((sum, value) => sum + value, 0),
      );
      let netFactor = 1;
      if (grossSum > 0) {
        netFactor = 0;
        for (const [vatRateKey, grossTotal] of vatGroups.entries()) {
          const vatRate = parseFloat(vatRateKey) || 0;
          const factor = 1 + (vatRate / 100);
          // Sadzba −100 % (delenie nulou) v SR neexistuje; ošetrené ako 0 %.
          netFactor += factor === 0 ? (grossTotal / grossSum) : (grossTotal / grossSum) / factor;
        }
      }
      const zaklad = roundMoney(celkom * netFactor);
      return {
        cislo: g.orderId,
        datum: dateStr,
        cas: timeStr,
        polozky: itemsList,
        zaklad,
        dph: roundMoney(celkom - zaklad),
        celkom,
        platba: g.paymentMethod,
        cisnik: g.staffName,
        zdroj: 'odhad',
      };
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pos-export-${from}-${to}.csv"`);
      // BOM for Excel UTF-8
      let csv = '﻿';
      // Stĺpec "Zdroj DPH": `doklad` = Základ/DPH sú z fiškálneho dokladu
      // (immutable, presne to čo je v eKase), `odhad` = platba fiškálny doklad
      // nemá a čísla sú dopočítané zo živého menu.
      csv += 'Cislo;Datum;Cas;Polozky;Zaklad;DPH;Celkom;Platba;Cisnik;Zdroj DPH\n';
      for (const r of rows) {
        csv += [r.cislo, r.datum, r.cas, '"' + r.polozky.replace(/"/g, '""') + '"', r.zaklad.toFixed(2), r.dph.toFixed(2), r.celkom.toFixed(2), r.platba, r.cisnik, r.zdroj].join(';') + '\n';
      }
      res.send(csv);
    } else {
      res.json(rows);
    }
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Chyba pri exporte' });
  }
}

import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, menuItems, staff } from '../../db/schema.js';
import { allocateDiscountAcrossVatGroups } from '../fiscal-payment.js';
import { lineDiscountAmount } from '../payments/shared.js';
import { localDateSK, localTimeHHMM, localYmd } from '../print/format.js';

import { TZ, roundMoney } from './shared.js';

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
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .innerJoin(staff, eq(orders.staffId, staff.id))
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(inRange(payments.createdAt))
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

      let zaklad = 0;
      let dph = 0;
      for (const [vatRateKey, grossTotal] of vatGroups.entries()) {
        const vatRate = parseFloat(vatRateKey) || 0;
        const factor = 1 + (vatRate / 100);
        const base = factor === 0 ? grossTotal : roundMoney(grossTotal / factor);
        zaklad = roundMoney(zaklad + base);
        dph = roundMoney(dph + (grossTotal - base));
      }
      return {
        cislo: g.orderId,
        datum: dateStr,
        cas: timeStr,
        polozky: itemsList,
        zaklad,
        dph,
        celkom,
        platba: g.paymentMethod,
        cisnik: g.staffName,
      };
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pos-export-${from}-${to}.csv"`);
      // BOM for Excel UTF-8
      let csv = '﻿';
      csv += 'Cislo;Datum;Cas;Polozky;Zaklad;DPH;Celkom;Platba;Cisnik\n';
      for (const r of rows) {
        csv += [r.cislo, r.datum, r.cas, '"' + r.polozky.replace(/"/g, '""') + '"', r.zaklad.toFixed(2), r.dph.toFixed(2), r.celkom.toFixed(2), r.platba, r.cisnik].join(';') + '\n';
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

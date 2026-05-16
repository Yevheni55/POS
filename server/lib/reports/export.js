import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, menuItems, staff } from '../../db/schema.js';
import { allocateDiscountAcrossVatGroups } from '../fiscal-payment.js';
import { roundMoney } from './shared.js';

// GET /api/reports/export?from=2026-03-01&to=2026-03-26&format=csv
export async function exportHandler(req, res) {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const format = req.query.format || 'csv';

  const fromDate = new Date(from);
  const toDate = new Date(to + 'T23:59:59');

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
      itemName: menuItems.name,
      itemQty: orderItems.qty,
      itemPrice: sql`${menuItems.price}::numeric`,
      itemVatRate: sql`COALESCE(${menuItems.vatRate}::numeric, 0)`,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .innerJoin(staff, eq(orders.staffId, staff.id))
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
    .where(
      and(
        gte(payments.createdAt, fromDate),
        sql`${payments.createdAt} <= ${toDate}`
      )
    )
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
          items: [],
        };
      }
      const existing = grouped[key].items.find(i => i.name === row.itemName);
      if (existing) {
        // skip duplicate from join
      } else {
        grouped[key].items.push({
          name: row.itemName,
          qty: row.itemQty,
          price: parseFloat(row.itemPrice),
          vatRate: parseFloat(row.itemVatRate),
        });
      }
    }
    const rows = Object.values(grouped).map(g => {
      const dt = new Date(g.date);
      const dateStr = dt.toLocaleDateString('sk-SK');
      const timeStr = dt.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
      const itemsList = g.items.map(i => i.qty + 'x ' + i.name).join(', ');
      const celkom = g.paymentAmount;
      const vatGroups = new Map();
      for (const item of g.items) {
        const key = String(item.vatRate);
        vatGroups.set(key, roundMoney((vatGroups.get(key) || 0) + (item.price * item.qty)));
      }
      for (const discount of allocateDiscountAcrossVatGroups(g.items, g.discountAmount)) {
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

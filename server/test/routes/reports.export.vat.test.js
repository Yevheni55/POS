// Pripusta aj paralelne worker DB (pos_test_w1..w6) — inak sa tento subor
// neda spustit vedla ostatnych bez kolizie na jednej zdielanej pos_test.
// Nazov MUSI zacinat 'pos_test', nech sa testy nikdy netrafia do zivej 'pos'
// (truncateAll() maze 32 tabuliek).
if (!/\/pos_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(
    'Tests must run with DATABASE_URL pointing to pos_test.\n' +
    'Use: npm test\n' +
    `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  );
}

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';
import { eq, sql } from 'drizzle-orm';

import { app } from '../../app.js';
import * as schema from '../../db/schema.js';
import { testDb, truncateAll, seed, closeDb } from '../helpers/setup.js';
import { tokens } from '../helpers/auth.js';

const request = supertest(app);

describe('reports export VAT breakdown', () => {
  let fixtures = {};

  before(async () => {
    await truncateAll();
    fixtures = await seed();
  });

  beforeEach(async () => {
    await testDb.execute(
      sql.raw('TRUNCATE fiscal_documents, order_events, payments, order_items, orders RESTART IDENTITY CASCADE')
    );
    await testDb.update(schema.tables).set({ status: 'free' });
  });

  after(async () => {
    await closeDb();
  });

  it('calculates zaklad and DPH from mixed VAT groups instead of a hardcoded rate', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const createdAt = new Date(`${today}T12:00:00.000Z`);
    const { cisnik, table1, itemBurger, itemPivo } = fixtures;

    const [order] = await testDb.insert(schema.orders).values({
      tableId: table1.id,
      staffId: cisnik.id,
      status: 'closed',
      label: 'VAT test',
      discountAmount: '1.00',
      createdAt,
      closedAt: createdAt,
    }).returning();

    await testDb.insert(schema.orderItems).values([
      { orderId: order.id, menuItemId: itemBurger.id, qty: 1, sent: true },
      { orderId: order.id, menuItemId: itemPivo.id, qty: 1, sent: true },
    ]);

    await testDb.insert(schema.payments).values({
      orderId: order.id,
      method: 'hotovost',
      amount: '10.00',
      createdAt,
    });

    const res = await request
      .get(`/api/reports/export?from=${today}&to=${today}&format=json`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].cislo, order.id);
    assert.equal(res.body[0].celkom, 10);
    assert.equal(res.body[0].zaklad, 9.21);
    assert.equal(res.body[0].dph, 0.79);

    const [row] = await testDb.select({
      burgerVat: schema.menuItems.vatRate,
    }).from(schema.menuItems).where(eq(schema.menuItems.id, itemBurger.id));
    assert.equal(Number(row.burgerVat), 5);
  });

  // ── Lokálny deň (Europe/Bratislava) ────────────────────────────────────
  // created_at je `timestamp` BEZ zóny a drží UTC nástenný čas (server beží
  // v Dockeri v UTC). Časy vkladáme ako SQL literály, aby test NEZÁVISEL od
  // timezone vývojárskeho stroja (node-postgres serializuje JS Date v lokálnej
  // zóne procesu a Postgres pri `timestamp` offset zahodí).
  const at = (utcWallClock) => sql`${utcWallClock}::timestamp`;

  async function makeSale({ createdAt, amount, method = 'hotovost', items, staffId, tableId }) {
    const [order] = await testDb.insert(schema.orders).values({
      tableId, staffId, status: 'closed', createdAt, closedAt: createdAt,
    }).returning();
    await testDb.insert(schema.orderItems).values(
      items.map((it) => ({ orderId: order.id, menuItemId: it.menuItemId, qty: it.qty, sent: true }))
    );
    const [payment] = await testDb.insert(schema.payments).values({
      orderId: order.id, method, amount, createdAt,
    }).returning();
    return { order, payment };
  }

  it('export reže deň v Europe/Bratislava — platba o 00:30 lokálne patrí do toho dňa', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    // 2026-07-14 22:30 UTC = 2026-07-15 00:30 Bratislava (CEST, UTC+2).
    // Pri starom UTC okne táto platba do 15. 7. nespadla vôbec.
    await makeSale({
      createdAt: at('2026-07-14 22:30:00'), amount: '5.00',
      items: [{ menuItemId: itemPivo.id, qty: 2 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    // 2026-07-15 22:30 UTC = 2026-07-16 00:30 lokálne → NEsmie byť v 15. 7.
    await makeSale({
      createdAt: at('2026-07-15 22:30:00'), amount: '99.00',
      items: [{ menuItemId: itemPivo.id, qty: 1 }],
      staffId: cisnik.id, tableId: table1.id,
    });

    const res = await request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].celkom, 5);
    assert.equal(res.body[0].cas, '00:30');
    assert.match(res.body[0].datum, /15\D+07\D+2026/);

    // Predošlý lokálny deň je prázdny (platba už patrí 15. 7.).
    const prev = await request
      .get('/api/reports/export?from=2026-07-14&to=2026-07-14&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(prev.status, 200);
    assert.equal(prev.body.length, 0);
  });

  it('export nezlučuje dva riadky s rovnakým názvom položky (Zaklad + DPH = Celkom)', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    // Dve samostatné order_items toho istého produktu (napr. Kofola s poznámkou
    // a bez) — deduplikácia podľa názvu jednu z nich zahodila a Zaklad prestal
    // sedieť s Celkom.
    await makeSale({
      createdAt: at('2026-07-15 10:00:00'), amount: '5.00',
      items: [{ menuItemId: itemPivo.id, qty: 1 }, { menuItemId: itemPivo.id, qty: 1 }],
      staffId: cisnik.id, tableId: table1.id,
    });

    const res = await request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    const row = res.body[0];
    assert.equal(row.celkom, 5);
    assert.equal(Math.round((row.zaklad + row.dph) * 100) / 100, 5);
    assert.equal(row.polozky, '1x Pivo, 1x Pivo');
  });

  it('z-report reže deň v Europe/Bratislava, nie v UTC', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    // 2026-03-14 23:30 UTC = 2026-03-15 00:30 Bratislava (CET, UTC+1)
    await makeSale({
      createdAt: at('2026-03-14 23:30:00'), amount: '12.50',
      items: [{ menuItemId: itemPivo.id, qty: 5 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    // 2026-03-15 23:30 UTC = 2026-03-16 00:30 lokálne → patrí do 16. 3.
    await makeSale({
      createdAt: at('2026-03-15 23:30:00'), amount: '99.00',
      items: [{ menuItemId: itemPivo.id, qty: 1 }],
      staffId: cisnik.id, tableId: table1.id,
    });

    const day15 = await request
      .get('/api/reports/z-report?date=2026-03-15')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(day15.status, 200);
    assert.equal(day15.body.fiscalRevenue, 12.5);
    assert.equal(day15.body.totalOrders, 1);
    assert.equal(day15.body.totalItems, 5);

    const day16 = await request
      .get('/api/reports/z-report?date=2026-03-16')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(day16.status, 200);
    assert.equal(day16.body.fiscalRevenue, 99);
    assert.equal(day16.body.totalOrders, 1);
  });

  it('staff report: dva účty s rovnakou sumou sa nezlúčia a storno sa neráta', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    // Dva rôzne účty, obidva na 10,00 € — `SUM(DISTINCT amount)` z nich urobil
    // jeden a čašníkovi zmizla polovica tržby.
    await makeSale({
      createdAt: at('2026-03-14 23:30:00'), amount: '10.00',   // 00:30 lokálne 15. 3.
      items: [{ menuItemId: itemPivo.id, qty: 4 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeSale({
      createdAt: at('2026-03-15 12:00:00'), amount: '10.00',
      items: [{ menuItemId: itemPivo.id, qty: 4 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    // Tretí účet je fiškálne STORNOVANÝ → nesmie byť v headline tržbe.
    const stornoed = await makeSale({
      createdAt: at('2026-03-15 12:05:00'), amount: '7.00',
      items: [{ menuItemId: itemPivo.id, qty: 3 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await testDb.insert(schema.fiscalDocuments).values({
      sourceType: 'storno',
      orderId: stornoed.order.id,
      paymentId: stornoed.payment.id,
      externalId: 'test-storno-staff-1',
      cashRegisterCode: 'TEST',
      requestType: 'receipt',
      resultMode: 'online_success',
      isSuccessful: true,
    });

    const res = await request
      .get('/api/reports/staff?from=2026-03-15&to=2026-03-15')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(res.status, 200);
    const row = res.body.find(r => r.staffId === cisnik.id);
    assert.ok(row, 'čašník musí byť v reporte');
    assert.equal(row.revenue, 20);
    assert.equal(row.ordersCount, 3);
    // POS zapisuje method='hotovost' (nie 'cash') — stĺpec Hotovosť v admine
    // preto ukazoval 0,00 € pri každom čašníkovi. Musí sedieť s headline.
    assert.equal(row.cashPayments, 20);
    assert.equal(row.cardPayments, 0);
  });

  it('staff report: karta sa dostane do cardPayments (method=karta, nie card)', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    await makeSale({
      createdAt: at('2026-03-15 13:00:00'), amount: '8.00', method: 'karta',
      items: [{ menuItemId: itemPivo.id, qty: 3 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeSale({
      createdAt: at('2026-03-15 14:00:00'), amount: '4.00', method: 'hotovost',
      items: [{ menuItemId: itemPivo.id, qty: 2 }],
      staffId: cisnik.id, tableId: table1.id,
    });

    const res = await request
      .get('/api/reports/staff?from=2026-03-15&to=2026-03-15')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(res.status, 200);
    const row = res.body.find(r => r.staffId === cisnik.id);
    assert.equal(row.cardPayments, 8);
    assert.equal(row.cashPayments, 4);
    // Headline musí byť súčtom rozpadu, inak si admin tabuľka protirečí.
    assert.equal(row.revenue, 12);
    assert.equal(row.cashPayments + row.cardPayments, row.revenue);
  });
});

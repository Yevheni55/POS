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

// Kód pokladne, pod ktorým vznikajú testovacie doklady. Pinujeme ho cez env,
// nech test NEZÁVISÍ od toho, čo je práve v `server/.env` — inak by ho zmena
// identity (prechod na SL management) ticho rozbila cez
// `notForeignCashRegisterSql` (server/lib/reports/shared.js).
const OWN_CODE = '88821217418420001';

describe('reports export VAT breakdown', () => {
  let fixtures = {};
  let prevEnvCashRegisterCode;

  before(async () => {
    prevEnvCashRegisterCode = process.env.PORTOS_CASH_REGISTER_CODE;
    process.env.PORTOS_CASH_REGISTER_CODE = OWN_CODE;
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
    if (prevEnvCashRegisterCode === undefined) delete process.env.PORTOS_CASH_REGISTER_CODE;
    else process.env.PORTOS_CASH_REGISTER_CODE = prevEnvCashRegisterCode;
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

  /**
   * Fiškálny doklad k platbe. `lines` = ZMRAZENÉ položky payloadu tak, ako ich
   * zapísal `buildFiscalReceiptItems` (server/lib/fiscal-payment.js) — každý
   * riadok nesie vlastnú `price` a `vatRate` PO aplikovaní `forceZeroVat`.
   * Bez `lines` ostane `request_json` prázdny a export spadne do fallbacku.
   */
  async function makeFiscalDoc({
    order, payment, sourceType = 'payment', lines = null, cashRegisterCode = OWN_CODE, externalId = null,
  }) {
    await testDb.insert(schema.fiscalDocuments).values({
      sourceType,
      orderId: order.id,
      paymentId: payment.id,
      externalId: externalId || `exp-${sourceType}-${payment.id}`,
      cashRegisterCode,
      requestType: 'receipt',
      resultMode: 'online_success',
      isSuccessful: true,
      requestJson: lines ? JSON.stringify({ request: { data: { items: lines } } }) : '{}',
    });
  }

  /** Vráti menu položku do stavu zo `seed()` — testy nižšie menia sadzby za behu. */
  async function restoreMenuItem(id, { price, vatRate }) {
    await testDb.update(schema.menuItems)
      .set({ price, vatRate })
      .where(eq(schema.menuItems.id, id));
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

  // ══ [07] fiškálne storno v účtovnom exporte ═══════════════════════════════
  // Stornovaná platba ostáva v `payments` (unique(order_id) bráni zápornej
  // kompenzácii), takže bez `notStornoedSql` sa dostane do CSV s plným
  // Základom aj DPH → účtovníčka odvedie daň z predaja, ktorý bol opravným
  // dokladom vrátený.
  it('[07] stornovaná platba nie je ani v JSON, ani v CSV exporte', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const ok = await makeSale({
      createdAt: at('2026-07-15 10:00:00'), amount: '10.00',
      items: [{ menuItemId: itemPivo.id, qty: 4 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeFiscalDoc({ ...ok, lines: [{ name: 'Pivo', price: 10, vatRate: 23 }] });

    const stornoed = await makeSale({
      createdAt: at('2026-07-15 11:00:00'), amount: '100.00',
      items: [{ menuItemId: itemPivo.id, qty: 40 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeFiscalDoc({ ...stornoed, lines: [{ name: 'Pivo', price: 100, vatRate: 23 }] });
    await makeFiscalDoc({ ...stornoed, sourceType: 'storno' });

    const json = await request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(json.status, 200);
    assert.deepEqual(json.body.map(r => r.cislo), [ok.order.id]);
    assert.equal(json.body[0].zaklad, 8.13);
    assert.equal(json.body[0].dph, 1.87);
    assert.equal(json.body[0].zdroj, 'doklad');

    const csv = await request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=csv')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(csv.status, 200);
    // Riadok CSV začína číslom účtu — stornovaný účet tam nesmie byť vôbec.
    assert.doesNotMatch(csv.text, new RegExp(`(^|\\n)${stornoed.order.id};`));
    assert.match(csv.text, new RegExp(`(^|\\n)${ok.order.id};`));
    assert.match(csv.text, /;8\.13;1\.87;10\.00;/);
    assert.doesNotMatch(csv.text, /;100\.00;/);
  });

  it('[07] súčet Celkom z exportu sedí s fiškálnou tržbou Z-reportu za ten istý deň', async () => {
    const { cisnik, table1, itemPivo, itemBurger } = fixtures;
    const a = await makeSale({
      createdAt: at('2026-07-15 08:00:00'), amount: '10.00',
      items: [{ menuItemId: itemPivo.id, qty: 4 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeFiscalDoc({ ...a, lines: [{ name: 'Pivo', price: 10, vatRate: 23 }] });
    const b = await makeSale({
      createdAt: at('2026-07-15 09:00:00'), amount: '17.00', method: 'karta',
      items: [{ menuItemId: itemBurger.id, qty: 2 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeFiscalDoc({ ...b, lines: [{ name: 'Burger', price: 17, vatRate: 5 }] });
    // Tretia platba je stornovaná — musí vypadnúť z OBOCH reportov naraz,
    // inak si CSV a uzávierka protirečia.
    const stornoed = await makeSale({
      createdAt: at('2026-07-15 09:30:00'), amount: '55.00',
      items: [{ menuItemId: itemPivo.id, qty: 22 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeFiscalDoc({ ...stornoed, lines: [{ name: 'Pivo', price: 55, vatRate: 23 }] });
    await makeFiscalDoc({ ...stornoed, sourceType: 'storno' });

    const exp = await request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    const z = await request
      .get('/api/reports/z-report?date=2026-07-15')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    assert.equal(exp.status, 200);
    assert.equal(z.status, 200);
    assert.equal(exp.body.length, 2, 'stornovaný účet nesmie mať riadok v exporte');
    const sumCelkom = Math.round(exp.body.reduce((s, r) => s + r.celkom, 0) * 100) / 100;
    assert.equal(sumCelkom, 27);
    assert.equal(sumCelkom, z.body.fiscalRevenue);
    // 10,00 @ 23 % → DPH 1,87 ; 17,00 @ 5 % → DPH 0,81
    const sumDph = Math.round(exp.body.reduce((s, r) => s + r.dph, 0) * 100) / 100;
    assert.equal(sumDph, 2.68);
    // `totalOrders` / `totalItems` filtrujú storno aj kód pokladne rovnako ako
    // `fiscalRevenue` — inak si uzávierka protirečí (tržba účet odráta, ale do
    // počtu účtov a `averageOrder` ho nechá).
    assert.equal(z.body.totalOrders, 2, 'stornovaný účet nesmie byť v počte účtov');
    assert.equal(z.body.totalItems, 6, '4× Pivo + 2× Burger; 22× Pivo je stornovaných');
  });

  // ══ change-method: tri doklady na jednej platbe ═══════════════════════════
  // Po zmene spôsobu platby visia na JEDNEJ platbe tri doklady: starý predajný
  // (`payment_superseded`), jeho `storno` a NOVÝ platný `payment`. Peniaze
  // vrátené neboli — platba MUSÍ ostať v tržbách. Kým sa storno páruje s
  // platbou (a nie s jej aktuálnym dokladom), vypadne zo VŠETKÝCH reportov
  // naraz a u platiteľa DPH chýba základ dane.
  it('[change-method] vystornovaný STARÝ doklad neberie platbu z tržieb, storno NOVÉHO áno', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    const changed = await makeSale({
      createdAt: at('2026-07-15 10:00:00'), amount: '10.00',
      items: [{ menuItemId: itemPivo.id, qty: 4 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    const oid = changed.order.id;
    const lines = [{ name: 'Pivo', price: 10, vatRate: 23 }];
    // Presne tie externalId, ktoré vyrobí server/lib/payments/change-method.js:
    // storno nesie salt STARÉHO dokladu, nový doklad dostane čerstvý salt.
    await makeFiscalDoc({ ...changed, sourceType: 'payment_superseded', externalId: `order-${oid}-pay-aaa-0001`, lines });
    await makeFiscalDoc({ ...changed, sourceType: 'storno', externalId: `order-${oid}-pay-aaa-0001-storno` });
    await makeFiscalDoc({ ...changed, sourceType: 'payment', externalId: `order-${oid}-pay-bbb-0002`, lines });

    const get = () => Promise.all([
      request.get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
        .set('Authorization', `Bearer ${tokens.manazer()}`),
      request.get('/api/reports/z-report?date=2026-07-15')
        .set('Authorization', `Bearer ${tokens.manazer()}`),
      request.get('/api/reports/summary?from=2026-07-15&to=2026-07-15')
        .set('Authorization', `Bearer ${tokens.manazer()}`),
    ]);

    const [exp, z, sum] = await get();
    assert.deepEqual(exp.body.map((r) => r.cislo), [oid], 'preúčtovaná platba patrí do exportu');
    assert.equal(exp.body[0].celkom, 10);
    assert.equal(exp.body[0].zdroj, 'doklad');
    assert.equal(z.body.fiscalRevenue, 10);
    assert.equal(z.body.totalOrders, 1);
    assert.equal(z.body.totalItems, 4);
    assert.equal(z.body.categoryBreakdown.length, 1, 'položky ostávajú aj v kategóriách');
    assert.equal(sum.body.revenue.fiscal, 10);

    // Storno NOVÉHO (aktuálneho) dokladu už peniaze naozaj vracia.
    await makeFiscalDoc({ ...changed, sourceType: 'storno', externalId: `order-${oid}-pay-bbb-0002-storno` });

    const [expAfter, zAfter, sumAfter] = await get();
    assert.equal(expAfter.body.length, 0, 'po storne aktuálneho dokladu platba z exportu vypadne');
    assert.equal(zAfter.body.fiscalRevenue, 0);
    assert.equal(zAfter.body.totalOrders, 0);
    assert.equal(zAfter.body.totalItems, 0);
    assert.deepEqual(zAfter.body.categoryBreakdown, []);
    assert.equal(sumAfter.body.revenue.fiscal, 0);
  });

  // ══ [06]/[15] Základ/DPH zo ZMRAZENÉHO dokladu ════════════════════════════
  it('[06] doklad vystavený s forceZeroVat exportuje DPH 0,00 aj keď menu má 23 %', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    // Predaj z obdobia NEplatiteľa: `forceZeroVat` poslal do Portosu vatRate 0,
    // hoci Pivo má v menu 23 %. Export nesmie dorobiť DPH, ktorá na doklade
    // nikdy nebola a nikdy sa neodviedla.
    const sale = await makeSale({
      createdAt: at('2026-07-15 10:00:00'), amount: '10.00',
      items: [{ menuItemId: itemPivo.id, qty: 4 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeFiscalDoc({ ...sale, lines: [{ name: 'Pivo', price: 10, vatRate: 0 }] });

    const res = await request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].zaklad, 10);
    assert.equal(res.body[0].dph, 0);
    assert.equal(res.body[0].celkom, 10);
    assert.equal(res.body[0].zdroj, 'doklad');

    // Kontrolne: v menu je stále 23 % — export ju vedome ignoruje.
    const [mi] = await testDb.select({ vatRate: schema.menuItems.vatRate })
      .from(schema.menuItems).where(eq(schema.menuItems.id, itemPivo.id));
    assert.equal(Number(mi.vatRate), 23);
  });

  it('[15] zmena vat_rate/ceny v menu PO vystavení dokladu nezmení už exportované čísla', async () => {
    const { cisnik, table1, itemPivo, itemBurger } = fixtures;
    const sale = await makeSale({
      createdAt: at('2026-07-15 10:00:00'), amount: '11.00',
      items: [{ menuItemId: itemBurger.id, qty: 1 }, { menuItemId: itemPivo.id, qty: 1 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeFiscalDoc({
      ...sale,
      lines: [
        { name: 'Burger', price: 8.5, vatRate: 5 },
        { name: 'Pivo', price: 2.5, vatRate: 23 },
      ],
    });

    const get = () => request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    const before = await get();
    assert.equal(before.status, 200);
    // 8,50/1,05 = 8,10 ; 2,50/1,23 = 2,03 → Základ 10,13, DPH 0,87
    assert.equal(before.body[0].zaklad, 10.13);
    assert.equal(before.body[0].dph, 0.87);
    assert.equal(before.body[0].celkom, 11);
    assert.equal(before.body[0].zdroj, 'doklad');
    assert.equal(Math.round((before.body[0].zaklad + before.body[0].dph) * 100) / 100, 11);

    try {
      // Manažér prehodí sadzby aj ceny — už podané obdobie sa NESMIE pohnúť.
      await testDb.update(schema.menuItems)
        .set({ vatRate: '23.00', price: '99.00' })
        .where(eq(schema.menuItems.id, itemBurger.id));
      await testDb.update(schema.menuItems)
        .set({ vatRate: '5.00', price: '1.00' })
        .where(eq(schema.menuItems.id, itemPivo.id));

      const afterEdit = await get();
      assert.equal(afterEdit.status, 200);
      assert.deepEqual(
        { z: afterEdit.body[0].zaklad, d: afterEdit.body[0].dph, c: afterEdit.body[0].celkom, s: afterEdit.body[0].zdroj },
        { z: before.body[0].zaklad, d: before.body[0].dph, c: before.body[0].celkom, s: before.body[0].zdroj },
      );
    } finally {
      await restoreMenuItem(itemBurger.id, { price: '8.50', vatRate: '5.00' });
      await restoreMenuItem(itemPivo.id, { price: '2.50', vatRate: '23.00' });
    }
  });

  it('[15] platba BEZ dokladu je len odhad — a je tak aj označená v JSON aj CSV', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    // Fiškál vypnutý / staré riadky / paragón: doklad nie je, čísla sa dopočítajú
    // zo ŽIVÉHO menu. Práve preto sa taký riadok NESMIE tíško zmiešať do
    // priznania DPH — CSV ho označí ako `odhad`.
    await makeSale({
      createdAt: at('2026-07-15 10:00:00'), amount: '10.00',
      items: [{ menuItemId: itemPivo.id, qty: 4 }],
      staffId: cisnik.id, tableId: table1.id,
    });

    const get = (format) => request
      .get(`/api/reports/export?from=2026-07-15&to=2026-07-15&format=${format}`)
      .set('Authorization', `Bearer ${tokens.manazer()}`);

    const before = await get('json');
    assert.equal(before.body[0].zdroj, 'odhad');
    assert.equal(before.body[0].zaklad, 8.13);
    assert.equal(before.body[0].dph, 1.87);

    const csv = await get('csv');
    assert.match(csv.text, /Cislo;Datum;Cas;Polozky;Zaklad;DPH;Celkom;Platba;Cisnik;Zdroj DPH/);
    // Za „Zdroj DPH" pribudli stĺpce „Kod pokladne;Firma" (prepínač ?scope=),
    // takže `odhad` už nie je posledná hodnota riadku.
    assert.match(csv.text, /;odhad;/);

    try {
      await testDb.update(schema.menuItems)
        .set({ vatRate: '5.00' })
        .where(eq(schema.menuItems.id, itemPivo.id));
      const afterEdit = await get('json');
      // Odhad sa so zmenou menu HÝBE — presne preto je označený ako odhad
      // a nesmie byť podkladom pre priznanie. Nemenný je len zdroj 'doklad'.
      assert.equal(afterEdit.body[0].zdroj, 'odhad');
      assert.equal(afterEdit.body[0].zaklad, 9.52);
      assert.equal(afterEdit.body[0].dph, 0.48);
    } finally {
      await restoreMenuItem(itemPivo.id, { price: '2.50', vatRate: '23.00' });
    }
  });

  it('[06] invariant Zaklad + DPH === Celkom platí pre doklad, odhad aj zľavnený účet', async () => {
    const { cisnik, table1, itemPivo, itemBurger } = fixtures;
    // (a) doklad so zmiešanými sadzbami
    const withDoc = await makeSale({
      createdAt: at('2026-07-15 08:00:00'), amount: '11.00',
      items: [{ menuItemId: itemBurger.id, qty: 1 }, { menuItemId: itemPivo.id, qty: 1 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    await makeFiscalDoc({
      ...withDoc,
      lines: [{ name: 'Burger', price: 8.5, vatRate: 5 }, { name: 'Pivo', price: 2.5, vatRate: 23 }],
    });
    // (b) bez dokladu → odhad
    await makeSale({
      createdAt: at('2026-07-15 09:00:00'), amount: '5.00',
      items: [{ menuItemId: itemPivo.id, qty: 2 }],
      staffId: cisnik.id, tableId: table1.id,
    });
    // (c) zľavnený účet bez dokladu — zľava sa rozpočítava medzi sadzby
    const [discounted] = await testDb.insert(schema.orders).values({
      tableId: table1.id, staffId: cisnik.id, status: 'closed',
      discountAmount: '1.00',
      createdAt: at('2026-07-15 09:30:00'), closedAt: at('2026-07-15 09:30:00'),
    }).returning();
    await testDb.insert(schema.orderItems).values([
      { orderId: discounted.id, menuItemId: itemBurger.id, qty: 1, sent: true },
      { orderId: discounted.id, menuItemId: itemPivo.id, qty: 1, sent: true },
    ]);
    await testDb.insert(schema.payments).values({
      orderId: discounted.id, method: 'hotovost', amount: '10.00',
      createdAt: at('2026-07-15 09:30:00'),
    });

    const res = await request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 3);
    for (const row of res.body) {
      assert.equal(
        Math.round((row.zaklad + row.dph) * 100) / 100, row.celkom,
        `Zaklad+DPH != Celkom pre účet ${row.cislo} (zdroj ${row.zdroj})`,
      );
      assert.ok(row.zaklad > 0 && row.dph >= 0, `nezmyselný rozpad pre účet ${row.cislo}`);
    }
    assert.deepEqual(res.body.filter(r => r.zdroj === 'doklad').map(r => r.cislo), [withDoc.order.id]);
  });

  // Fallback vetva (server/lib/reports/export.js) skladala Zaklad/DPH zo ŽIVÉHO
  // menu (`price * qty`), ale Celkom brala z `payments.amount`. Keď sa tie dve
  // čísla nerovnali — pri riadkoch bez fiškálneho dokladu bežné, presne o tom je
  // nález [15]: cena v menu sa po predaji zmení — CSV pre účtovníčku obsahovalo
  // riadok, kde Zaklad + DPH ≠ Celkom. Odhad teraz berie z cenníka len POMER
  // sadzieb a aplikuje ho na skutočne zaplatenú sumu, takže invariant drží
  // rovnako ako vo vetve 'doklad'.
  it('[15] odhad: Zaklad + DPH === Celkom aj keď sa cena v menu po predaji zmenila', async () => {
    const { cisnik, table1, itemPivo } = fixtures;
    // Zaplatené 3,00 €, v cenníku je 1× Pivo za 2,50 € (cena sa po predaji
    // zmenila / doklad chýba). Rozpad musí sedieť so ZAPLATENOU sumou.
    await makeSale({
      createdAt: at('2026-07-15 10:00:00'), amount: '3.00',
      items: [{ menuItemId: itemPivo.id, qty: 1 }],
      staffId: cisnik.id, tableId: table1.id,
    });

    const res = await request
      .get('/api/reports/export?from=2026-07-15&to=2026-07-15&format=json')
      .set('Authorization', `Bearer ${tokens.manazer()}`);
    assert.equal(res.status, 200);
    const row = res.body[0];
    assert.equal(row.zdroj, 'odhad');
    assert.equal(row.celkom, 3);
    assert.equal(
      Math.round((row.zaklad + row.dph) * 100) / 100, row.celkom,
      `Zaklad ${row.zaklad} + DPH ${row.dph} != Celkom ${row.celkom}`,
    );
  });
});
